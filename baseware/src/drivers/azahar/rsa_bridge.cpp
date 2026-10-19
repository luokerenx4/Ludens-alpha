// Compiled into the pinned Azahar build. Native device input and renderer capture only.
#include "core/frontend/rsa_bridge.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <arpa/inet.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

namespace Frontend {
static RsaBridge* current_bridge = nullptr;
struct RsaBridge::Impl {
    using Clock = std::chrono::steady_clock;
    struct Pending {
        std::string id;
        std::string epoch;
        std::uint64_t generation;
    };
    struct Span { PadState state; std::uint64_t end_ms; };
    struct Action {
        std::string id;
        std::vector<Span> spans;
        Clock::time_point started{};
        bool active = false, finishing = false;
        std::uint64_t elapsed = 0, polls = 0;
    };
    struct CaptureRequest { std::string id; std::uint64_t sequence; };

    explicit Impl(unsigned port, Update update_) : update(std::move(update_)) {
        listener = socket(AF_INET, SOCK_STREAM, 0);
        int yes = 1;
        setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        address.sin_port = htons(port);
        if (listener < 0 || bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) ||
            listen(listener, 1)) {
            if (listener >= 0) close(listener);
            throw std::runtime_error("Cannot listen on RSA touch bridge port");
        }
        worker = std::thread([this] { Serve(); });
    }

    ~Impl() {
        stopping = true;
        shutdown(listener, SHUT_RDWR);
        const int active = client.load();
        if (active >= 0) shutdown(active, SHUT_RDWR);
        worker.join();
        close(listener);
        Reset();
    }

    void SetState(bool owned) {
        update(owned, pressed, x, y, ++generation);
    }

    void Reset() {
        std::lock_guard lock(mutex);
        capture.reset();
        replies.clear();
        action.reset();
        pad = {};
        if (epoch.empty()) return;
        epoch.clear();
        pressed = false;
        x = y = 0;
        SetState(false);
    }

    void FinishAction(const std::string& outcome) {
        if (!action) return;
        if (action->active)
            action->elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                Clock::now() - action->started).count();
        replies.emplace_back(action->id, "OK\t" + outcome + "\t" +
            std::to_string(action->elapsed) + "\t" + std::to_string(action->polls));
        action.reset();
        pad = {};
    }

    static std::vector<Span> ParseSpans(const std::string& sequence) {
        std::vector<Span> result;
        std::istringstream input(sequence);
        std::string span;
        std::uint64_t end = 0;
        while (std::getline(input, span, ',')) {
            std::istringstream parts(span);
            std::vector<long long> values;
            std::string part;
            while (std::getline(parts, part, ':')) {
                std::size_t consumed;
                const auto value = std::stoll(part, &consumed);
                if (consumed != part.size()) throw std::runtime_error("INVALID_SEQUENCE");
                values.push_back(value);
            }
            if (values.size() != 6 || values[0] < 0 || values[0] >= (1 << 14) ||
                values[5] < 16 || static_cast<std::uint64_t>(values[5]) > 9007199254740991ULL - end)
                throw std::runtime_error("INVALID_SEQUENCE");
            for (unsigned i = 1; i <= 4; ++i)
                if (values[i] < -32767 || values[i] > 32767)
                    throw std::runtime_error("AXIS_RANGE");
            end += values[5];
            result.push_back({{static_cast<std::uint32_t>(values[0]), static_cast<int>(values[1]),
                               static_cast<int>(values[2]), static_cast<int>(values[3]),
                               static_cast<int>(values[4])}, end});
        }
        if (result.empty()) throw std::runtime_error("EMPTY_SEQUENCE");
        return result;
    }

    static unsigned Coordinate(const std::string& raw, unsigned maximum) {
        std::size_t end = 0;
        const auto value = std::stoul(raw, &end);
        if (end != raw.size() || value > maximum) throw std::runtime_error("COORDINATE_RANGE");
        return static_cast<unsigned>(value);
    }

    std::optional<std::string> Execute(const std::vector<std::string>& fields,
                                       std::vector<Pending>& pending) {
        if (fields.size() < 2) throw std::runtime_error("INVALID_COMMAND");
        std::unique_lock lock(mutex);
        const auto& op = fields[1];
        if (op == "HELLO") return "azahar-rsa-2";
        if (op == "TOUCH_INFO") return "0\t0\t319\t239";
        if (op == "TOUCH_STATE") {
            return std::to_string(!epoch.empty()) + "\t" + std::to_string(pressed) + "\t" +
                   std::to_string(x) + "\t" + std::to_string(y) + "\t" +
                   std::to_string(generation) + "\t" + std::to_string(sampled);
        }
        if (op == "CAPTURE") {
            if (fields.size() != 3 || fields[2].empty() || fields[2][0] != '/')
                throw std::runtime_error("ABSOLUTE_PATH_REQUIRED");
            if (!capture_handler) throw std::runtime_error("NO_RENDERER");
            if (capture) throw std::runtime_error("CAPTURE_BUSY");
            capture = CaptureRequest{fields[0], ++capture_sequence};
            auto handler = capture_handler;
            const auto id = fields[0];
            lock.unlock();
            handler(fields[2], [this, id](std::string error) {
                std::lock_guard guard(mutex);
                if (!capture || capture->id != id) return;
                replies.emplace_back(id, error.empty() ? "OK\t" + std::to_string(capture->sequence)
                                                      : "ERROR\t" + error);
                capture.reset();
            });
            return std::nullopt;
        }
        if (fields.size() < 3 || fields[2].empty()) throw std::runtime_error("EPOCH_REQUIRED");
        if (op == "OWN") {
            if (!epoch.empty()) throw std::runtime_error("OWNED");
            epoch = fields[2];
            pad = {};
            pressed = false;
            x = y = 0;
            SetState(true);
            return "";
        }
        if (epoch != fields[2] || epoch.empty()) throw std::runtime_error("STALE_EPOCH");
        if (op == "STATE") {
            return std::to_string(pad.buttons) + "\t" + std::to_string(pad.lx) + "\t" +
                   std::to_string(pad.ly) + "\t" + std::to_string(pad.rx) + "\t" +
                   std::to_string(pad.ry) + "\t" + (action ? action->id : "-");
        }
        if (op == "APPLY") {
            if (action) throw std::runtime_error("BUSY");
            if (fields.size() != 4) throw std::runtime_error("SEQUENCE_REQUIRED");
            action = Action{fields[0], ParseSpans(fields[3])};
            return std::nullopt;
        }
        if (op == "DISOWN") {
            FinishAction("interrupted");
            epoch.clear();
            pressed = false;
            x = y = 0;
            SetState(false);
            return "";
        }
        if (op == "STOP") {
            if (fields.size() < 4 || (action && fields[3] == action->id))
                FinishAction("interrupted");
            if (fields.size() < 4 || fields[3] == last_touch_id) {
                interrupted_through = generation;
                pressed = false;
                x = y = 0;
                SetState(true);
            }
            return "";
        }
        if (std::any_of(pending.begin(), pending.end(), [&](const Pending& item) {
                return item.epoch == epoch && item.generation > sampled &&
                       item.generation > interrupted_through;
            })) throw std::runtime_error("BUSY");
        if (op == "TOUCH_DOWN" || op == "TOUCH_MOVE") {
            if (fields.size() != 5) throw std::runtime_error("COORDINATES_REQUIRED");
            if (op == "TOUCH_DOWN" && pressed) throw std::runtime_error("ALREADY_DOWN");
            if (op == "TOUCH_MOVE" && !pressed) throw std::runtime_error("NOT_DOWN");
            const unsigned next_x = Coordinate(fields[3], 319);
            const unsigned next_y = Coordinate(fields[4], 239);
            x = next_x;
            y = next_y;
            pressed = true;
        } else if (op == "TOUCH_UP") {
            if (!pressed) return "completed";
            pressed = false;
            x = y = 0;
        } else {
            throw std::runtime_error("UNKNOWN_COMMAND");
        }
        SetState(true);
        last_touch_id = fields[0];
        pending.push_back({fields[0], epoch, generation});
        return std::nullopt;
    }

    static bool Send(int fd, const std::string& message) {
        std::size_t sent = 0;
        while (sent < message.size()) {
            const auto amount = send(fd, message.data() + sent, message.size() - sent, 0);
            if (amount <= 0) return false;
            sent += static_cast<std::size_t>(amount);
        }
        return true;
    }

    void Serve() {
        while (!stopping) {
            pollfd incoming{listener, POLLIN, 0};
            if (poll(&incoming, 1, 50) <= 0) continue;
            if (stopping) break;
            const int fd = accept(listener, nullptr, nullptr);
            if (fd < 0) break;
            client = fd;
#ifdef SO_NOSIGPIPE
            int yes = 1;
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
#endif
            std::string input;
            std::vector<Pending> pending;
            bool connected = true;
            while (connected && !stopping) {
                pollfd ready{fd, POLLIN, 0};
                const int status = poll(&ready, 1, 5);
                if (status < 0 && errno != EINTR) break;
                if (status > 0 && ready.revents) {
                    char buffer[4096];
                    const auto count = recv(fd, buffer, sizeof(buffer), 0);
                    if (count <= 0) break;
                    input.append(buffer, static_cast<std::size_t>(count));
                    std::size_t newline;
                    while ((newline = input.find('\n')) != std::string::npos) {
                        std::istringstream stream(input.substr(0, newline));
                        input.erase(0, newline + 1);
                        std::vector<std::string> fields;
                        std::string field;
                        while (std::getline(stream, field, '\t')) fields.push_back(field);
                        const std::string id = fields.empty() ? "?" : fields[0];
                        try {
                            if (auto result = Execute(fields, pending))
                                connected = Send(fd, id + "\tOK\t" + *result + "\n");
                        } catch (const std::exception& error) {
                            connected = Send(fd, id + "\tERROR\t" + error.what() + "\n");
                        }
                        if (!connected) break;
                    }
                }
                std::lock_guard lock(mutex);
                for (const auto& reply : replies)
                    connected = Send(fd, reply.first + "\t" + reply.second + "\n");
                replies.clear();
                for (auto it = pending.begin(); it != pending.end();) {
                    const bool interrupted = it->epoch != epoch || it->generation <= interrupted_through;
                    if (interrupted || it->generation <= sampled) {
                        const auto result = interrupted ? "\tOK\tinterrupted\n" : "\tOK\tcompleted\n";
                        connected = Send(fd, it->id + result);
                        it = pending.erase(it);
                        if (!connected) break;
                    } else {
                        ++it;
                    }
                }
            }
            Reset();
            close(fd);
            client = -1;
        }
    }

    Update update;
    Capture capture_handler;
    std::optional<CaptureRequest> capture;
    std::uint64_t capture_sequence = 0;
    std::optional<Action> action;
    PadState pad;
    std::vector<std::pair<std::string, std::string>> replies;
    std::mutex mutex;
    std::string epoch;
    std::string last_touch_id;
    bool pressed = false;
    unsigned x = 0, y = 0;
    std::uint64_t generation = 0, sampled = 0;
    std::uint64_t interrupted_through = 0;
    int listener = -1;
    std::atomic<int> client{-1};
    std::atomic<bool> stopping{false};
    std::thread worker;
};

RsaBridge::RsaBridge(unsigned port, Update update)
    : impl(std::make_unique<Impl>(port, std::move(update))) { current_bridge = this; }
RsaBridge::~RsaBridge() { current_bridge = nullptr; }
RsaBridge* RsaBridge::Current() { return current_bridge; }
void RsaBridge::Sampled(std::uint64_t generation) {
    std::lock_guard lock(impl->mutex);
    impl->sampled = std::max(impl->sampled, generation);
}
std::optional<RsaBridge::PadState> RsaBridge::PollPad() {
    std::lock_guard lock(impl->mutex);
    if (impl->epoch.empty()) return std::nullopt;
    if (impl->action && !impl->action->finishing) {
        auto& action = *impl->action;
        const auto now = Impl::Clock::now();
        if (!action.active) { action.active = true; action.started = now; }
        action.elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - action.started).count();
        ++action.polls;
        const auto span = std::find_if(action.spans.begin(), action.spans.end(), [&](const auto& item) {
            return action.elapsed < item.end_ms;
        });
        if (span == action.spans.end()) {
            action.finishing = true;
            impl->pad = {};
        } else {
            impl->pad = span->state;
        }
    }
    return impl->pad;
}
std::optional<RsaBridge::PadState> RsaBridge::ReadPad() {
    std::lock_guard lock(impl->mutex);
    return impl->epoch.empty() ? std::nullopt : std::optional(impl->pad);
}
void RsaBridge::PadSampled() {
    std::lock_guard lock(impl->mutex);
    if (impl->action && impl->action->finishing) impl->FinishAction("completed");
}
void RsaBridge::SetCapture(Capture handler) {
    std::lock_guard lock(impl->mutex);
    impl->capture_handler = std::move(handler);
}
void RsaBridge::FailCapture(const std::string& error) {
    std::lock_guard lock(impl->mutex);
    if (!impl->capture) return;
    impl->replies.emplace_back(impl->capture->id, "ERROR\t" + error);
    impl->capture.reset();
}
} // namespace Frontend
