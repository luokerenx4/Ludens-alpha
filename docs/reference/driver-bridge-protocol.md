# Driver Bridge 协议（初稿）

状态：从现有 `mgba / azahar / ryubing` 三个 bridge 实现反推。新 driver 实现对应 socket bridge 后，还需提供适配该协议的 provider，并通过 `DriverRegistration.load` 接入；包和启动描述见 [Baseware](baseware.md#driver-包与启动描述)。`cua` 走 stdio，不用此协议。

## 传输

- TCP，`127.0.0.1:<port>`，单客户端。provider 是客户端，bridge（模拟器侧）是服务端。
- 行协议：每行 `{id}\t{op}\t{args...}\n`；回复 `{id}\tOK\t{fields...}\n` 或 `{id}\tERROR\t{message}\n`。
- `id` 由 provider 生成（`crypto.randomUUID()`）， bridge 原样回传，用于匹配异步回复（`APPLY`、`CAPTURE`、`TOUCH_*` 都是延迟回复）。
- 字段内禁止 `\t\r\n`（见 `drivers/bridge.ts` 校验）。
- provider 侧 `Bridge.request(op, args, id)`，bridge 侧按 op 分发。断开连接 = 设备断开，`onDisconnect` 触发。

## 会话与所有权

| op | 参数 | 回复 | 语义 |
| --- | --- | --- | --- |
| `HELLO` | — | `OK\t<version>` | 握手。`mgba` 回 `frequency\tcycles`（两字段，用于算 fps）；`azahar` 要求 `azahar-rsa-3`；`ryubing` 要求 `ryubing-rsa-3`。版本不对 provider 直接关连接。 |
| `OWN` | `epoch` | `OK` / `ERROR OWNED` | 取得设备所有权。已有 epoch 时报错（mgba：`ALREADY_OWNED`，azahar/ryubing：`OWNED`）。成功后清 pad 状态。 |
| `DISOWN` | `epoch` | `OK` / `ERROR STALE_EPOCH` | 释放所有权；在途 pad action 按 `interrupted` 结算（mgba/ryubing）；azahar 额外清 touch。 |
| `STATE` | `epoch` | 见下 | 读当前应用中的控制状态，不读游戏内存。 |

`STATE` 回复形状按设备不同：

- mgba：`OK\t<mask>\t<actionId|->`（`mask` 为 10 位 GBA 键；另附 `emu:getKeys()` 原生值，仅诊断用）。
- azahar/ryubing：`OK\t<mask>\t<lx>\t<ly>\t<rx>\t<ry>\t<actionId|->`（mask 按各 provider 的 `BUTTONS` 位序；轴为 `[-32767, 32767]` 整数，provider 除以 32767 归一）。

epoch 不匹配一律 `ERROR STALE_EPOCH`。这是 Baseware 控制权在 bridge 层的唯一体现。

## Pad 时间线

| op | 参数 | 回复 |
| --- | --- | --- |
| `APPLY` | `epoch\t<sequence>` | 延迟回复：`OK\tcompleted\t<elapsedMs>\t<polls>` 或 `OK\tinterrupted\t…`。已有 action 时 `ERROR BUSY`。 |
| `STOP` | `epoch\t[actionId]` | `OK`。无 actionId（或匹配当前）则中断当前 action（`interrupted` 结算）；azahar/ryubing 同时按同一规则释放 touch。 |

`sequence` 是逗号分隔的 span，每个 span 为冒号分隔的整数字段：

- mgba：`mask:frames`（2 字段；`mask ≤ 1023`，`frames ≥ 1`，累计帧数不得超过 max safe integer）。时间语义：按模拟帧推进，`frames = ceil(elapsedMs × fps / 1000)` 累计取整（见 `mgba/provider.ts:encodeSpans`）。
- azahar/ryubing：`mask:lx:ly:rx:ry:durationMs`（6 字段；`mask < 1<<14`（azahar）/ `≤ 65535`（ryubing），轴 `|v| ≤ 32767`，`durationMs ≥ 16`）。时间语义：输入轮询点的墙钟毫秒，span 间隔不得小于 16ms（含首尾）。

provider 侧 `drivers/timeline.ts:compileTimeline` 把 `pad.play` 的多通道输入编译成完整状态 span，再由各 provider `encodeSpans` 序列化。重叠同通道输入在 provider 层拒绝，不到 bridge。

## Touch（azahar / ryubing；mgba 无）

| op | 参数 | 回复 |
| --- | --- | --- |
| `TOUCH_INFO` | — | `OK\t<minX>\t<minY>\t<maxX>\t<maxY>`。azahar：`0 0 319 239`；ryubing：`0 0 1279 719`。provider 用此生成坐标 schema，越界在 provider 层拒绝。 |
| `TOUCH_DOWN` / `TOUCH_MOVE` | `epoch\tx\ty` | 延迟回复 `OK\tcompleted`（被采样）或 `OK\tinterrupted`。`DOWN` 时已按下 → `ALREADY_DOWN`/`TOUCH_ALREADY_DOWN`；`MOVE` 时未按下 → `NOT_DOWN`/`TOUCH_NOT_DOWN`；同时只能有一个在途 touch（azahar：`BUSY`，ryubing：`TOUCH_BUSY`）。 |
| `TOUCH_UP` | `epoch` | azahar/ruybing 未按下时直接回 `completed`（幂等）。 |

语义：down 返回后接触保持，completion 只表示“设备已采样新状态”。取消在途 touch（provider `AbortSignal` → `STOP epoch touchId`）或 `pad.release`/`DISOWN` 会抬起接触。

## Capture

| op | 参数 | 回复 |
| --- | --- | --- |
| `CAPTURE` | 见下 | 延迟回复：`OK\t<sequence>`，失败为各设备的错误串（`NO_GAME/PAUSED/CAPTURE_BUSY/CAPTURE_SAVE_FAILED/NO_RENDERER/…`）。 |

- mgba：`CAPTURE path` → `OK frame`（模拟帧号）。同步截图。
- azahar：`CAPTURE top|bottom path` → `OK captureSequence`（截图计数，非呈现帧）。双屏共享一个原生捕获槽，串行采样；path 必须绝对路径；无渲染器/忙时直接报错。
- ryubing：`CAPTURE path` → `OK frame surface`（`surface` 为呈现来源；系统键盘对话框时省略帧号）。下一呈现帧回调时截图，15s 超时。

截图文件由 bridge 写到 provider 指定的临时 path，provider 读字节后删除（见 `drivers/capture.ts:withCaptureFile`）。图片本身不走 socket。

## Keyboard（仅 ryubing）

`KEYBOARD epoch type|press <base64>` → `OK`。只作用于可见的 Switch 系统文本框；`NO_TEXT_INPUT` 时失败。`type` 插文本，`press` 限 `ENTER/ESCAPE/BACKSPACE/CTRL+A` 四键。

## 错误码一览

`STALE_EPOCH`（epoch 不匹配）、`OWNED`/`ALREADY_OWNED`（重复接管）、`BUSY`（已有 pad action）、`CAPTURE_BUSY`（已有截图在途）、`TOUCH_BUSY`/`ALREADY_DOWN`/`NOT_DOWN`（touch 状态机）、`UNKNOWN_COMMAND`（未知 op）。provider 把非 `OK` 一律转为异常，`interrupted` 为正常终态之一（`toolExecution` exitCode 130）。

## 与 provider 的分工

- provider（TS）拥有：timeline 编译、span 编码、参数校验、epoch 持有者记录、临时文件生命周期。
- bridge（模拟器侧）拥有：输入注入时机（轮询点/帧边界/原生 read 回调）、截图执行、状态机（epoch/action/touch）。
- 两边都不解释游戏语义：`STATE` 返回的是应用中的控制状态，不是游戏内存。
