// Real Azahar RSA bridge with a simulated HID consumer, not a full emulator.
#include "core/frontend/rsa_bridge.h"
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <thread>

static volatile std::sig_atomic_t running = 1;
int main(int argc, char** argv) {
    if (argc != 2) return 2;
    std::signal(SIGTERM, [](int) { running = 0; });
    std::signal(SIGPIPE, SIG_IGN);
    std::atomic<bool> touching{false};
    std::atomic<std::uint64_t> generation{0};
    Frontend::RsaBridge bridge(std::strtoul(argv[1], nullptr, 10),
        [&](bool owned, bool pressed, unsigned, unsigned, std::uint64_t gen) {
            touching = owned && pressed;
            generation = gen;
        });
    const auto start = std::chrono::steady_clock::now();
    int previous_owned = -1, previous_buttons = -1, previous_touch = -1;
    std::cout << "{\"ready\":true}" << std::endl;
    while (running) {
        const auto pad = bridge.PollPad();
        const int owned = pad.has_value(), buttons = pad ? pad->buttons : 0, touch = touching.load();
        if (owned != previous_owned || buttons != previous_buttons || touch != previous_touch) {
            const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
            std::cout << "{\"atMs\":" << ms << ",\"owned\":" << owned
                      << ",\"buttons\":" << buttons << ",\"touch\":" << touch << "}" << std::endl;
            previous_owned = owned; previous_buttons = buttons; previous_touch = touch;
        }
        bridge.PadSampled();
        bridge.Sampled(generation.load());
        std::this_thread::sleep_for(std::chrono::milliseconds(4));
    }
}
