# Baseware 原生能力契约施工方案

日期：2026-10-24。用户已授权按此方向实施；先记录方案，再改代码。研究依据见 [CUA 对照研究](cua-reference-study.md)。

## 目标与边界

在 Baseware 外置 CUA 原生工具契约，让原装 CUA 和模拟器从同一入口提供能力。保持原生工具名称、参数 schema、结果、内容块和元信息，不修改 CUA 源码，不把模拟器装进其内部 registry。不改 OMP Loop，不手工迁移模型的 workspace，不启停游戏。

CUA 的可移植 manifest 只覆盖部分工具/字段，不能作为白名单。Baseware 保存带版本及来源的参考契约；运行时以实际 `tools/list` 为准，保留平台扩展及未来新增工具。标准工具目录兼容不意味着实现 CUA 专用 SDK 的 envelope 协议。

## 统一后的边界

- `ToolDefinition` / `ToolResult` 采用 CUA 使用的原生 MCP 工具定义和结果形状，开放保留上游 metadata。
- Driver Controller 包含原生工具定义、独立的 `requiresControl`、可选媒体声明和执行/获取/释放钩子。执行函数只接收 JSON 参数对象。
- 一个命令是一项能力：例如 `pad.play`、`pad.wait`、`screen.top.capture`、`touch.down`。CUA 使用原生工具名称；RSA 的 `controller/` 只是目录命名空间。
- 公共服务请求使用 `{kind:"controller", id, arguments:{...}}`，删除 driver argv 协议、bindings 和旧命令兼容。
- CLI 采用 `<name> --args '<JSON object>'` 或 `--file <完整参数对象文件>`，无参数等于 `{}`；Python/TS 直接传同一对象；MCP 直接暴露原生参数 schema，不再套 argv/epoch 参数层。控制 epoch 和 trace 属于调用上下文，不混入设备参数。
- 保留现有执行记录外壳（时间、状态、控制关联、媒体引用），增加完整原生 `result`。这是运行日志与设备返回的分工；stdout/stderr 只作为可读摘要，不再是设备参数/结果的唯一契约。
- 二进制内容在调用结果中保持原生，在持久日志中改用带内容位置的文件引用，避免 base64 重复写盘；MCP 返回原始工具结果，不返回日志外壳。

## 分工与实施顺序

1. 根任务建立公共类型、参数校验、服务/目录、CLI/Python/MCP 接入和结果归档辅助函数。
2. CUA 子任务引入固定版本原生参考契约及许可证/来源、可重现同步方法；迁移 adapter，验证完整目录和结果透传，禁止白名单裁剪。
3. 模拟器子任务迁移 mGBA/Azahar/Ryubing 的 provider、pad/touch/schema 与现有测试；原生 C++/C#/Lua 桥接不变，时序和释放语义不变。
4. RSA 子任务迁移设备会话、统一能力入口、CLI/Python、相关 fixture/测试，保留自建 Python 能力和感知进程的职责。
5. 根任务整合，补 [Baseware 设计理念](baseware.md)，更新现行文档、示例和简短 prompt，检查所有旧调用契约引用。

## 必须保留的行为

- 参数 schema 和只读提示都来自能力声明；`pad.state` 可以只读且仍要求控制权。
- `play` 仍返回独立 actionId，支持组合、不同起止、异步提交/等待/取消；CLI 退出不取消已提交动作。
- GBA 的模拟帧与 3DS/Switch 的输入轮询墙钟保持区别；截图序号不伪装成统一帧号。
- 双屏保持两个来源；触屏接触跨调用保持，不擅自实现点按/拖拽；系统文本框不冒充电脑键盘。
- 人接管、owner 断连和预算结束继续拒绝旧 epoch 并释放输入。CUA 的原生清理由原装 CUA 处理。
- 未知 CUA 字段、工具结果顶层 metadata、内容块顺序、图像/音频/资源、structuredContent 和 isError 不因适配丢失。

## 验证与完成标准

- Baseware/RSA 类型检查与相关现有测试通过；原生 Azahar 输入夹具继续验证不同持续时间、组合键、跨请求动作及人接管释放。
- CUA 完整工具目录/schema 对比；包含新字段及非白名单工具的结果透传测试；MCP 实际协议端到端测试覆盖 schema、结果和取消。
- 同一参数对象经 CLI、Python、MCP 到达同一 driver；不再经 shell 或 argv 重解释；非法参数在输入前失败。
- 媒体调用可取原始内容，日志只记录文件引用；执行/动作/观测 trace 能关联。
- 导出 baseware.json 与实际目录一致，文档明确版本、设备扩展和不支持的语义。
- 不为验证接管真实电脑或重开游戏；如未做真实设备验证，在最终结果中明确说明。完成后检查提交范围，排除运行数据和本机路径。

## 实施记录

已完成上述迁移。CUA 0.36.0 的上游契约及 macOS 60 项工具参考目录保存于 `baseware/contracts/cua-driver/`，附固定提交、许可证和逐文件哈希；运行时仍透传实际目录，不以快照作白名单。参数采用 JSON Schema 2020-12 校验，显式 draft-07 保留该版本语义，不转换类型或补写默认值。

CUA 入站和 Baseware MCP 出站均在验证后保留原值，避免 SDK 默认对象解析裁剪未知嵌套字段。模拟器拆为独立工具，RSA CLI/API、导出目录、分析器和 Dashboard 同步接入对象参数。历史日志仍可读取旧 argv 字段，但调用接口不保留兼容。CUA 本体、模拟器原生桥、OMP 内核与正在使用的 workspace 均未改动。

验证结果：

- Baseware 类型检查通过；全量测试 **53 通过、1 跳过**。覆盖全部 60 项 CUA schema、真实 MCP 往返字段保真、CLI/文件/Python 参数一致性、原生媒体与日志引用。
- RSA 类型检查通过；全量测试 **192 通过、3 跳过**，包括控制权、trace、媒体归档以及 OMP 原生 bash 跨轮与人接管。
- 原生 Azahar bridge 编译夹具通过：不同持续时间组合、提交客户端退出、取消等待、pad/touch 交还和断连释放。夹具模拟 HID 轮询，没有加载游戏或渲染器。
- Dashboard 类型检查及 **19 项数据测试**通过；新增参数对象可进入观测详情，历史日志仍可消费。
- 固定 CUA 契约的 **7 个文件哈希**校验通过；相关本地文档链接与 Git 空白检查通过。

跳过项为需显式启用的真实设备测试；本次未控制桌面或重开游戏，不能据此声称所有平台原生行为已实机验证。后续加载新版时，模型需自行按更新的 `baseware.json` 适配旧 workspace 脚本。
