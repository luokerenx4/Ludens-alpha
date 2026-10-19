// Compiled into the pinned Azahar build. No game-memory access.
#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>

namespace Frontend {
class RsaBridge {
public:
    struct PadState {
        std::uint32_t buttons = 0;
        int lx = 0, ly = 0, rx = 0, ry = 0;
    };
    using Update = std::function<void(bool owned, bool pressed, unsigned x, unsigned y,
                                      std::uint64_t generation)>;
    using Capture = std::function<void(const std::string& source, const std::string& path,
                                       std::function<void(std::string error)> done)>;
    RsaBridge(unsigned port, Update update);
    ~RsaBridge();
    static RsaBridge* Current();
    void Sampled(std::uint64_t generation);
    std::optional<PadState> PollPad();
    std::optional<PadState> ReadPad();
    void PadSampled();
    void SetCapture(Capture capture);
    void FailCapture(const std::string& error);

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};
} // namespace Frontend
