# Driver Bridge 协议

本规范定义 Baseware `bridge` 传输层（TCP Socket）的模拟器通信协议，由独立可选包 `ludens-gba-driver`（`mgba`）、`ludens-3ds-driver`（`azahar`）、`ludens-switch-driver`（`ryubing`）共同实现。开发新模拟器驱动时，需在模拟器侧实现本协议服务端（Bridge），并在 TypeScript 侧通过 `DriverRegistration.load` 提供适配的 Provider（包注册契约见 [Baseware 设计理念与能力契约](baseware.md#driver-包与启动描述)）。注：`cua` 桌面驱动采用 `stdio` MCP 传输，不使用本协议。

## 传输

- **连接模型**：TCP `127.0.0.1:<port>`，单客户端独占。Baseware Provider 作为客户端发起连接，模拟器侧 Bridge 作为服务端监听。
- **帧格式**：基于 UTF-8 换行符（`\n`）分隔的制表符（`\t`）行协议：
  - 请求行：`{id}\t{op}\t{args...}\n`
  - 成功响应：`{id}\tOK\t{fields...}\n`
  - 失败响应：`{id}\tERROR\t{message}\n`
- **异步请求配对**：`id` 由 Provider 生成（`crypto.randomUUID()`），Bridge 必须在响应行首原样回传。请求依靠 `id` 精确配对；`APPLY` 以及需要等待设备采样或渲染的操作延迟响应，具体时机见各指令说明。
- **字符转义约束**：所有字段内部严禁包含 `\t`、`\r` 或 `\n`（由 [baseware/src/drivers/bridge.ts](../../baseware/src/drivers/bridge.ts) 强制校验）。TCP 连接断开即视为设备断连，立即触发 Provider 的 `onDisconnect` 回调。

## 会话与所有权

| 指令 (`op`) | 请求参数 | 响应格式 | 语义说明 |
| --- | --- | --- | --- |
| `HELLO` | 无 | `OK\t<version...>` | 连接握手与版本核验。`mgba` 返回 `<frequency>\t<cycles>`（用于计算精确帧率）；`azahar` 要求返回 `azahar-rsa-3`；`ryubing` 要求返回 `ryubing-rsa-3`。版本不匹配时 Provider 立即关闭连接。 |
| `OWN` | `<epoch>` | `OK` 或 `ERROR OWNED` | 申请设备控制权。若当前已有持有者则拒绝，包括重复传入相同 epoch（`mgba` 返回 `ALREADY_OWNED`，`azahar` / `ryubing` 返回 `OWNED`）；Provider 在上层处理同 epoch 的幂等。接管成功后立即清零手柄输入状态。 |
| `DISOWN` | `<epoch>` | `OK` 或 `ERROR STALE_EPOCH` | 释放设备控制权。在途手柄动作按 `interrupted` 结算并归零按键；`azahar` 与 `ryubing` 同时释放触屏接触点。 |
| `STATE` | `<epoch>` | 见下方说明 | 读取当前 Bridge 注入层持有的控制状态（仅反映控制器状态，绝不读取游戏内存）。 |

各模拟器 `STATE` 响应字段格式：

- **mGBA**：`OK\t<mask>\t<actionId|->\t<nativeKeys>`（`mask` 为 10 位 GBA 按键位图；`nativeKeys` 是 `emu:getKeys()` 原生诊断值）。
- **Azahar / Ryubing**：`OK\t<mask>\t<lx>\t<ly>\t<rx>\t<ry>\t<actionId|->`（`mask` 按各 Provider 的 `BUTTONS` 位序编码；左右摇杆轴 `lx/ly/rx/ry` 为 `[-32767, 32767]` 整数，Provider 侧除以 `32767` 归一化为 `[-1, 1]`）。

除申请控制权的 `OWN` 外，携带 `<epoch>` 的指令若与 Bridge 当前持有的所有权不一致，返回 `ERROR STALE_EPOCH`。

## Pad 时间线

| 指令 (`op`) | 请求参数 | 响应格式 | 语义说明 |
| --- | --- | --- | --- |
| `APPLY` | `<epoch>\t<sequence>` | 延迟响应：`OK\t<outcome>\t<timing...>`（字段见下方） | 执行编译后的手柄状态序列；`outcome` 为 `completed` 或 `interrupted`。若已有动作在途则返回 `ERROR BUSY`。 |
| `STOP` | `<epoch>\t[actionId]` | `OK` | 若省略 `actionId` 或与当前在途动作匹配，则立即中断该动作（使 `APPLY` 以 `interrupted` 结算）并归零输入；`azahar` / `ryubing` 同时按相同规则释放触屏。 |

`APPLY` 的终态计时字段按设备区分：mGBA 返回 `<startFrame>\t<endFrame>`；Azahar / Ryubing 返回 `<elapsedMs>\t<polls>`。Provider 据此保留模拟帧数或墙钟耗时与采样数，不把帧号当作毫秒。

Provider 侧先通过 [timeline.ts](../../baseware/src/drivers/timeline.ts) 的 `compileTimeline` 将多通道 `pad.play` 输入校验并切分为不重叠的全状态切片（Span），再编码为逗号分隔的 `<sequence>` 字符串：

- **mGBA（帧驱动）**：每个切片格式为 `mask:frames`（`mask <= 1023`，`frames >= 1`）。Provider 按 `ceil(elapsedMs * fps / 1000)` 累计取整将毫秒转换为模拟帧数。
- **Azahar / Ryubing（轮询墙钟驱动）**：每个切片格式为 `mask:lx:ly:rx:ry:durationMs`（`azahar` 的 `mask < (1 << 14)`，`ryubing` 的 `mask <= 65535`，摇杆轴 `|v| <= 32767`，`durationMs >= 16`）。在模拟器输入轮询点按单调墙钟推进，每个切片持续时间不少于 16ms。

## Touch

仅 `azahar` 与 `ryubing` 支持触屏指令（`mgba` 无触屏硬件）：

| 指令 (`op`) | 请求参数 | 响应格式 | 语义说明 |
| --- | --- | --- | --- |
| `TOUCH_INFO` | 无 | `OK\t<minX>\t<minY>\t<maxX>\t<maxY>` | 查询触屏原生坐标边界。`azahar` 返回 `0 0 319 239`，`ryubing` 返回 `0 0 1279 719`。Provider 据此生成 JSON Schema 并拦截越界坐标。 |
| `TOUCH_DOWN` | `<epoch>\t<x>\t<y>` | 延迟响应：`OK\tcompleted` 或 `OK\tinterrupted` | 按下指定坐标，待模拟器完成一次输入采样后返回 `completed`，接触状态在返回后继续保持。若已处于按下状态则返回 `ALREADY_DOWN` / `TOUCH_ALREADY_DOWN`。 |
| `TOUCH_MOVE` | `<epoch>\t<x>\t<y>` | 延迟响应：`OK\tcompleted` 或 `OK\tinterrupted` | 移动当前触点，待采样后返回 `completed`。若未处于按下状态则返回 `NOT_DOWN` / `TOUCH_NOT_DOWN`。 |
| `TOUCH_UP` | `<epoch>` | 延迟响应：`OK\tcompleted` 或 `OK\tinterrupted` | 抬起触点并等待一次输入采样；等待期间被取消或交还控制权时返回 `interrupted`。未按下且无在途 Touch 请求时直接幂等返回 `completed`。 |

同一时刻最多允许一个在途 Touch 请求，并发请求返回 `BUSY` / `TOUCH_BUSY`。当调用方取消请求（`AbortSignal` 触发 `STOP <epoch> <touchId>`）、调用 `pad.release` 或执行 `DISOWN` 时，Bridge 会立即抬起触点。

## Capture

| 模拟器 | 请求格式 | 延迟响应格式 | 采集时机与约束 |
| --- | --- | --- | --- |
| `mgba` | `CAPTURE\t<path>` | `OK\t<frame>` | 同步截取当前画面并写入 `<path>`，返回当前模拟帧号。 |
| `azahar` | `CAPTURE\t<top\|bottom>\t<path>` | `OK\t<captureSequence>` | 截取上屏（400×240 左眼）或下屏（320×240）写入绝对路径 `<path>`，返回递增截图序号。双屏共用一个原生捕获槽，串行采样。 |
| `ryubing` | `CAPTURE\t<path>` | `OK\t[frame]\t<surface>` | 在下一次渲染帧呈现回调时截图（15s 超时），`<surface>` 标明游戏画面或系统键盘弹窗（系统键盘弹窗时省略 `frame`）。 |

图像字节不经过 TCP Socket 传输：Provider 通过 [capture.ts](../../baseware/src/drivers/capture.ts) 的 `withCaptureFile` 分配本地临时文件路径传给 Bridge，待 `CAPTURE` 返回 `OK` 后读取文件字节并在 `finally` 中立即删除临时文件。

## Keyboard

仅 `ryubing` 支持原生系统键盘指令：

- 请求格式：`KEYBOARD\t<epoch>\t<type|press>\t<base64Payload>`
- 响应格式：`OK` 或 `ERROR NO_TEXT_INPUT`
- 语义说明：仅当 Switch 系统文本输入框处于前台激活状态时生效；`type` 插入 Base64 解码后的 UTF-8 文本，`press` 支持 `ENTER`、`ESCAPE`、`BACKSPACE`、`CTRL+A` 四个控制键。

## 错误码一览

| 错误码 | 含义与触发条件 |
| --- | --- |
| `STALE_EPOCH` | 请求携带的 `epoch` 与当前 Bridge 拥有者不匹配，或尚未 `OWN`。 |
| `OWNED` / `ALREADY_OWNED` | 设备已有控制周期持有，拒绝重复 `OWN`（包括相同 epoch）。 |
| `BUSY` | 已有未完成的 `APPLY` 手柄时间表在途。 |
| `CAPTURE_BUSY` | 已有未完成的截图请求在途。 |
| `TOUCH_BUSY` / `ALREADY_DOWN` / `NOT_DOWN` | 触屏状态机冲突（并发触控、重复按下或未按下时移动）。 |
| `NO_GAME` / `PAUSED` / `NO_RENDERER` / `CAPTURE_SAVE_FAILED` | 模拟器未加载游戏、处于暂停态、渲染器未就绪或临时截图写入失败。 |
| `NO_TEXT_INPUT` | Ryubing 当前无可见的系统键盘输入框。 |
| `UNKNOWN_COMMAND` | 未知的操作指令。 |

Provider 将所有 `ERROR` 响应转化为结构化异常；而由 `STOP` 或 `DISOWN` 引起的 `OK\tinterrupted` 则作为正常中断终态处理（对应 `ExecutionResult.status = "interrupted"`，`exitCode = 130`）。

## 与 provider 的分工

- **Provider（TypeScript 侧）负责**：JSON Schema 生成与参数边界校验、`pad.play` 多通道时间表编译与切片编码、控制租约持有者记录、临时截图文件分配与清理。
- **Bridge（模拟器原生侧）负责**：在正确的硬件时机（输入轮询点 / 模拟帧边界 / 渲染呈现回调）注入按键与触控、执行帧缓冲截图、维护底层的 `epoch / action / touch` 状态机并在断线或 `DISOWN` 时无条件归零输入。
