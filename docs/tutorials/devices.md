# 设备与驱动准备

各 Driver 仅暴露设备的原生输入与采集能力，不包含游戏策略、跨屏坐标融合或自动存读档逻辑。本页承接 [基础组件安装](quickstart.md#安装)；完成设备与驱动准备后，继续按 [工作区启动与停止](quickstart.md#工作区启动与停止) 创建并启动工作区。

模拟器驱动均按需安装，主仓不再包含模拟器 Provider、原生桥或构建补丁。驱动包安装与模拟器本体构建是两个步骤：`--driver-package` 安装 TypeScript 包；各卫星仓的构建说明负责准备带桥的模拟器。

## mGBA

使用 [ludens-gba-driver](https://github.com/luokerenx4/ludens-gba-driver)（驱动 ID `mgba`）。按该仓 README 安装 mGBA、加载游戏及包内 `bridge.lua`，默认桥端口为 `47653`。mGBA 需要手动准备游戏与桥，`rsa.json` 不接受 `game` 字段。开发版兼容记录、端口配置和 SRAM 存档说明也维护在该仓。

## Ryubing

使用 [ludens-switch-driver](https://github.com/luokerenx4/ludens-switch-driver)（驱动 ID `ryubing`）。该仓统一维护固定上游版本、原生桥、补丁、构建/启动脚本与专属测试；默认桥端口为 `47663`。按该仓 README 准备带桥的模拟器后，RSA 可通过驱动 manifest 启动游戏。

原生能力包括 `pad.*`、`screen.capture`、`touch.down / move / up`，以及 Switch 系统输入框的 `keyboard.type / press`。触屏范围为 `1280×720`。固件、密钥和存档留在本机，避免并发启动共用同一数据目录的模拟器实例。

## Azahar

使用 [ludens-3ds-driver](https://github.com/luokerenx4/ludens-3ds-driver)（驱动 ID `azahar`）。该仓维护固定上游版本、原生桥、补丁、构建/启动脚本与专属测试；默认桥端口为 `47673`。按该仓 README 准备带桥的模拟器后，RSA 可通过 manifest 启动游戏。

原生能力包括 `pad.*`、`screen.top.capture`（上屏 `400×240`）、`screen.bottom.capture`（下屏 `320×240`）和 `touch.down / move / up`（下屏范围 `x = 0..319`、`y = 0..239`）。坐标换算与游戏策略由工作区实现。

## Cua

桌面环境使用上游原装 [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver)：

1. 安装 Cua Driver，并在 macOS **系统设置 → 隐私与安全性**中为 `CuaDriver.app` 授予**辅助功能（Accessibility）**与**屏幕录制（Screen Recording）**权限。
2. Baseware 通过持久 `cua-driver mcp` 子进程（stdio 传输）接入驱动，无需设置 `game` 或桥端口；若 `cua-driver` 不在 `PATH` 中，可在 `rsa init --cua-command` 或 `rsa.json` 的 `cuaCommand` 指定绝对路径。
3. 所有工具保持上游原生命名与 JSON 参数结构（如 `rsa controller controller/get_desktop_state --args '{}'`），契约边界见 [Baseware 设计理念与能力契约](../reference/baseware.md)。

**桌面环境边界**：多个 Cua 工作区共享同一宿主机真实桌面（包括运行在桌面上的 melonDS 等尚未提供独立原生桥的模拟器），如需隔离桌面请使用独立 OS 会话或虚拟机。人工交还控制权会立即拒绝新输入并请求取消，但已进入操作系统底层的单次原生调用可能先执行完毕；`rsa down` 不会关闭共享的 `CuaDriver.app` 或用户的桌面应用。

## 外部驱动包发现与接入

mGBA、Azahar、Ryubing 必须通过 `--driver-package` 显式选择外部包；当前仅 `cua` 桌面接入内置。包地址支持 npm 包名、`github:org/repo#rev`、GitHub HTTPS URL、`git@github.com:org/repo.git#rev` 或 `file:path`。SSH 地址保留 SSH 传输，缓存按传输方式、仓库与 revision 区分。初始化工作区前，可用 `baseware driver discover` 或 Dashboard 能力页（`?view=caps`）校验包的 `DriverRegistration` 声明：

```sh
baseware driver discover --package 'github:org/repo#rev'
rsa init --driver <id> --driver-package 'github:org/repo#rev'
```

- **路径解析**：`rsa init` 与 `rsa up` 中的相对 `file:` 路径均以目标工作区目录为基准解析并归一化；`baseware driver discover` 的相对 `file:` 按当前 shell 目录解析；Dashboard 网页端的外部驱动校验要求 `file:` 使用绝对路径。
- **实际来源**：catalog 的 `drivers[].source`、Baseware `service_start.driverSource` 与 RSA `manifest.drivers[].source` 记录加载器实际解析的来源：GitHub `resolvedCommit`、npm `resolvedVersion` 或本地入口 `entrySha256`。入口哈希不覆盖依赖，`provider.version` 仍表示设备或协议版本；字段详见 [包地址与缓存机制](../reference/baseware.md#1-包地址与缓存机制)。
- **信任边界**：发现阶段虽不调用驱动的 `load()`，但会下载安装依赖并导入包入口代码；仅对可信来源执行发现与初始化。驱动包规范详见 [Driver 包与启动描述](../reference/baseware.md#driver-包与启动描述) 与 [Driver Bridge 协议](../reference/driver-bridge-protocol.md)。

**已有模拟器工作区迁移**：先执行 `rsa auto off`，再执行 `rsa down --keep-emulator`；在原 `rsa.json` 增加匹配驱动的 `driverPackage`，固定下面对应仓库的 commit SHA，然后 `rsa up --dry-run` / `rsa up`。不重新执行 `rsa init`，原工作区文件与存档继续保留。已经运行的服务不会因源码更新自动换包。

新包默认从各自构建缓存启动模拟器。若沿用已安装的应用，在启动命令前设置 `RSA_AZAHAR_APP=/Applications/Azahar.app` 或 `RSA_RYUBING_APP=/Applications/Ryubing.app`，例如 `RSA_RYUBING_APP=/Applications/Ryubing.app rsa up`。这些变量选择启动路径，不会复制或覆盖已有应用；自定义路径在每次 `up`（包括 `--dry-run`）时都需传入。仅连接已手动准备的模拟器时，省略 `game`。

| 驱动 ID | 可选包 |
| --- | --- |
| `mgba` | `github:luokerenx4/ludens-gba-driver#9c1a014be3d87fe6846fef8ad7eba1c13439e8a5` |
| `azahar` | `github:luokerenx4/ludens-3ds-driver#5b9b1f4032a5973a8882aa23957c3c34da50af9e` |
| `ryubing` | `github:luokerenx4/ludens-switch-driver#070edf662ba724e1a31c5b477f414d4da61bbd6f` |
