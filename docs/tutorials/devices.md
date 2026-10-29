# 设备与驱动准备

各 Driver 仅暴露设备的原生输入与采集能力，不包含游戏策略、跨屏坐标融合或自动存读档逻辑。完成本页的设备准备后，即可按 [安装与工作区启停](quickstart.md#工作区启动与停止) 创建并启动工作区。

## mGBA

已适配 mGBA `0.10.5`，并实机验证官方开发版 `0.11-9161-1509d8602`（[macOS 固定构建下载](https://s3.amazonaws.com/mgba/build/mGBA-build-2026-10-25-macos-9161-1509d86028c7df2d844b590723a80b2978f49e7c.dmg)）的采集、按键、断线释放与重连。升级前请先退出模拟器并备份应用、配置与 `.sav` 存档。

1. 打开 mGBA 并加载 ROM（mGBA 始终手动加载游戏与桥，`rsa.json` 不接受 `game` 字段）。
2. 打开菜单 **Tools → Scripting**，执行仓库内的 [bridge.lua](../../baseware/src/drivers/mgba/bridge.lua)（可用 `realpath baseware/src/drivers/mgba/bridge.lua` 获取绝对路径）：

```lua
dofile("/absolute/path/to/repo/baseware/src/drivers/mgba/bridge.lua")
```

看到控制台输出 `RSA bridge listening on 127.0.0.1:47653 (manual)` 即表示就绪。重复执行 `dofile` 会安全关闭旧桥并热加载新脚本；加载后可关闭 Scripting 窗口，但模拟器本体不可暂停，否则帧回调、截图采集与控制权交接都会挂起。多开实例时，在 `dofile` 前先执行 `RSA_BRIDGE_PORT = 47654`，并将对应工作区 `rsa.json` 的 `port` 设为 `47654`；每个桥端口同一时刻只能由一个 Baseware 实例连接。

**GBA 存档类型注意事项**：部分中文绿宝石改版使用 **SRAM 64 KiB**，若被自动识别为 Flash 1Mb 会导致游戏内保存失败。上述 `0.11-9161` 开发版已包含[用户 override 优先级修复](https://github.com/mgba-emu/mgba/commit/5337ae7ae14daaf0aecd4d2c40429fc31440b245)。针对此类 ROM，可在 `~/.config/mgba/config.ini` 的 `[override.<四字节游戏编号>]` 节写入 `savetype=SRAM512`（空编号 ROM 对应 `[override.]`，会作用于所有无编号 ROM，勿全局滥用），配置后务必通过“游戏内保存 → 完全退出 → 冷启动读档”验证。部分改版因双存档槽在 64 KiB 地址空间内重叠，冷启动读档成功时仍可能提示“记录破损”，建议保留独立 `.sav` 备份。

## Ryubing

Nintendo Switch 原生桥基于 [Ryubing 源码归档](https://starforgejo.dev/archive/Ryubing)（固定标签 `Canary-1.3.351`，提交 `475615f0431b4995b03c930c5089d20f6f3570e0`，本地构建标识 `1.3.351-rsa.3`）。在 Apple Silicon macOS 上准备 **.NET 10 SDK**（已验证 `10.0.402`）、**Python 3** 与 **Xcode Command Line Tools**：

```sh
# 默认使用 ../artifacts/switch/dotnet/dotnet；可通过 RSA_DOTNET 指定已有 SDK
RSA_DOTNET=/absolute/path/to/dotnet baseware/src/drivers/ryubing/build.sh
```

[build.sh](../../baseware/src/drivers/ryubing/build.sh) 会校验上游 commit、应用 [ryubing.patch](../../baseware/src/drivers/ryubing/ryubing.patch)（含 `https://nuget.ryulynx.org/v3/index.json` LibHac 源替换）、注入 [RsaBridge.cs](../../baseware/src/drivers/ryubing/RsaBridge.cs)，并附带 JIT entitlements 完成 ad-hoc 签名。源码位于 `../artifacts/switch/ryubing-canary-source`，构建产物位于 `../artifacts/switch/ryubing-build/Ryujinx.app`。

1. **安装**：构建脚本不会自动覆盖系统应用。先退出正在运行的模拟器，再将 `Ryujinx.app` 复制安装为 `/Applications/Ryubing.app`（Finder 显示为 Ryubing，内部可执行文件与进程名仍为 `Ryujinx`）。
2. **启动**：通过 [launch.sh](../../baseware/src/drivers/ryubing/launch.sh) 或 `rsa up` 启动以注入 `RSA_BRIDGE_PORT`（默认 `47663`）；直接从 Finder 双击图标不会开启桥服务：

```sh
baseware/src/drivers/ryubing/launch.sh /absolute/path/to/game.nsp
```

固件、密钥与存档沿用本机 Ryujinx 数据目录，切勿并发启动两个共用同一数据目录的实例。暴露能力包括：

- `pad.play / state / status / wait / cancel / release`：手柄时间表与状态查询；
- `screen.capture`：抓取游戏 framebuffer 或当前前台 Switch 系统键盘弹窗；
- `touch.down / move / up`：触屏操作，坐标范围 `x = 0..1279`、`y = 0..719`（左上角为原点）；
- `keyboard.type / press`：当 Switch 系统文本输入框可见时输入文本或功能键。

## Azahar

Nintendo 3DS 原生桥基于 Azahar `2126.2`（提交 `219d743a1e698101fe1ab8bef43e6563126c3c27`）。在 Apple Silicon macOS 上准备 **Git**、**CMake** 与 **Xcode Command Line Tools**（Qt 与 MoltenVK 由上游 CMake 自动拉取）：

```sh
baseware/src/drivers/azahar/build.sh
```

[build.sh](../../baseware/src/drivers/azahar/build.sh) 拉取源码与子模块、应用 [azahar.patch](../../baseware/src/drivers/azahar/azahar.patch)、注入 [rsa_bridge.cpp](../../baseware/src/drivers/azahar/rsa_bridge.cpp)，输出 `../artifacts/3ds/azahar-build/bundle/azahar.app`（可通过 `RSA_AZAHAR_SOURCE` 指定源码路径、`RSA_BUILD_JOBS` 调整并发编译数）。

1. **安装**：退出旧模拟器后，将产物安装至 `/Applications/Azahar.app`。
2. **启动**：通过 [launch.sh](../../baseware/src/drivers/azahar/launch.sh) 或 `rsa up` 启动（默认端口 `47673`，独立脚本可用 `RSA_AZAHAR_APP` 覆盖应用路径）：

```sh
baseware/src/drivers/azahar/launch.sh /absolute/path/to/game.3ds
```

原生能力由 [azahar/provider.ts](../../baseware/src/drivers/azahar/provider.ts) 定义，无需依赖桌面 Cua：

- `pad.*`：手柄与摇杆时间表控制；
- `screen.top.capture` / `screen.bottom.capture`：独立输出上屏（`400×240` 左眼画面）与下屏（`320×240`）；
- `touch.down / move / up`：下屏触控，坐标范围 `x = 0..319`、`y = 0..239`（左上角原点，含端点）。点按、拖拽与跨屏坐标换算由工作区代码实现。

## Cua

桌面环境使用上游原装 [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver)：

1. 安装 Cua Driver，并在 macOS **系统设置 → 隐私与安全性**中为 `CuaDriver.app` 授予**辅助功能（Accessibility）**与**屏幕录制（Screen Recording）**权限。
2. Baseware 通过持久 `cua-driver mcp` 子进程（stdio 传输）接入驱动，无需设置 `game` 或桥端口；若 `cua-driver` 不在 `PATH` 中，可在 `rsa init --cua-command` 或 `rsa.json` 的 `cuaCommand` 指定绝对路径。
3. 所有工具保持上游原生命名与 JSON 参数结构（如 `rsa controller controller/get_desktop_state --args '{}'`），契约边界见 [Baseware 设计理念与能力契约](../reference/baseware.md)。

**桌面环境边界**：多个 Cua 工作区共享同一宿主机真实桌面（包括运行在桌面上的 melonDS 等尚未提供独立原生桥的模拟器），如需隔离桌面请使用独立 OS 会话或虚拟机。人工交还控制权会立即拒绝新输入并请求取消，但已进入操作系统底层的单次原生调用可能先执行完毕；`rsa down` 不会关闭共享的 `CuaDriver.app` 或用户的桌面应用。

## 外部驱动包发现与接入

除四个内置驱动外，可通过 `--driver-package` 接入第三方或本地驱动包（支持 npm 包名、`github:org/repo#rev` 或 `file:path`）。初始化工作区前，可用 `baseware driver discover` 或 Dashboard 能力页（`?view=caps`）校验包的 `DriverRegistration` 声明：

```sh
baseware driver discover --package github:org/repo#rev
rsa init --driver <id> --driver-package github:org/repo#rev
```

- **路径解析**：`rsa init` 与 `rsa up` 中的相对 `file:` 路径均以目标工作区目录为基准解析并归一化；`baseware driver discover` 的相对 `file:` 按当前 shell 目录解析；Dashboard 网页端的外部驱动校验要求 `file:` 使用绝对路径。
- **信任边界**：发现阶段虽不调用驱动的 `load()`，但会下载安装依赖并导入包入口代码；仅对可信来源执行发现与初始化。驱动包规范详见 [Driver 包与启动描述](../reference/baseware.md#driver-包与启动描述) 与 [Driver Bridge 协议](../reference/driver-bridge-protocol.md)。
