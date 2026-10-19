// Compiled into the pinned Azahar build. No game-memory access.
#pragma once

#include <cstdint>
#include <functional>
#include <memory>

namespace Frontend {
class RsaTouchBridge {
public:
    using Update = std::function<void(bool owned, bool pressed, unsigned x, unsigned y,
                                      std::uint64_t generation)>;
    RsaTouchBridge(unsigned port, Update update);
    ~RsaTouchBridge();
    void Sampled(std::uint64_t generation);

private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};
} // namespace Frontend
