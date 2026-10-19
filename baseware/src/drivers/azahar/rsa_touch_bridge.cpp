// Compiled into the pinned Azahar build. The wire carries native touchscreen coordinates.
#include "core/frontend/rsa_touch_bridge.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdlib>
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
struct RsaTouchBridge::Impl {
    struct Pending {
        std::string id;
        std::string epoch;
        std::uint64_t generation;
    };

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
        if (epoch.empty()) return;
        epoch.clear();
        pressed = false;
        x = y = 0;
        SetState(false);
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
        std::lock_guard lock(mutex);
        const auto& op = fields[1];
        if (op == "HELLO") return "azahar-rsa-1";
        if (op == "TOUCH_INFO") return "0\t0\t319\t239";
        if (op == "STATE") {
            return std::to_string(!epoch.empty()) + "\t" + std::to_string(pressed) + "\t" +
                   std::to_string(x) + "\t" + std::to_string(y) + "\t" +
                   std::to_string(generation) + "\t" + std::to_string(sampled);
        }
        if (fields.size() < 3 || fields[2].empty()) throw std::runtime_error("EPOCH_REQUIRED");
        if (op == "OWN") {
            if (!epoch.empty()) throw std::runtime_error("OWNED");
            epoch = fields[2];
            pressed = false;
            x = y = 0;
            SetState(true);
            return "";
        }
        if (epoch != fields[2] || epoch.empty()) throw std::runtime_error("STALE_EPOCH");
        if (op == "DISOWN") {
            epoch.clear();
            pressed = false;
            x = y = 0;
            SetState(false);
            return "";
        }
        if (op == "STOP") {
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

RsaTouchBridge::RsaTouchBridge(unsigned port, Update update)
    : impl(std::make_unique<Impl>(port, std::move(update))) {}
RsaTouchBridge::~RsaTouchBridge() = default;
void RsaTouchBridge::Sampled(std::uint64_t generation) {
    std::lock_guard lock(impl->mutex);
    impl->sampled = std::max(impl->sampled, generation);
}
} // namespace Frontend
