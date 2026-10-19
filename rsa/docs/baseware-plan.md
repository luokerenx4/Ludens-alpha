# Baseware 与工作区能力：实施及验收计划

目标：Baseware 独立维护 driver 与设备操作权，RSA 通过统一的工作区能力入口访问原始设备和装饰器函数。CLI 优先、Python API 用于组合；注册能力不等于注入模型工具。MCP 保留 Baseware 独立适配器，当前不注入 OMP，也不新增 RSA MCP 适配器。

## 当前实现边界

1. **设备服务**：mGBA / Ryubing 的契约、桥、采集和输入位于 `baseware/`。CLI、TS/Python API、MCP 都连接同一 core；服务独立处理期限、拥有者断开和人工收回。
2. **统一能力入口**：RSA `WorkspaceController` 将实际 Baseware Sensor / Controller 目录与工作区 Python 函数合并。公共 ID 为 `sensor/<id>`、`controller/<id>`、`python/<相对路径.py>:<函数名>`；不在 Harness 硬编码 driver。
3. **按需发现**：`rsa controller list` 返回短目录；`rsa controller <id> --help` 返回单项说明。Python 函数的签名、类型和 docstring 通过静态 AST 读取，list/help/call 时刷新，不执行发现阶段的代码。
4. **统一调用**：设备 argv 透传；Python 以 `--args '<JSON object>'` 传参。`rsa_tools.Client.list/help/call` 使用同一宿主执行器，允许 Python 组合设备或其他工作区能力。Runtime 统一验证 epoch、传播取消；嵌套调用不增加全局串行队列。
5. **OMP 接线**：仅保留 `read/write/edit/exec/observe`，删除 Python 函数自动注册原生工具的逻辑，不逐轮注入完整能力目录。提示词引导通过 CLI 按需发现、通过脚本复用方法；循环提供观测和经验索引。
6. **应用与日志**：`rsa up/down/services` 装配 Baseware、Agent、Dashboard 和 Pet；日志留在 workspace。RSA 统一入口的传感器结果保存在 run，设备、shell、Python 事件通过 trace 关联。不修改模型生成的技能或脚本。

## 验收入口

| 要求 | 验证方式 |
| --- | --- |
| Baseware 独立包与进程，RSA 不加载设备实现 | main / workspace-host / shutdown 与依赖边界检查 |
| 原始设备与 Python 同一目录、CLI/API 结果一致 | 假 driver 与临时 workspace，真实宿主 socket 调用 |
| Python 增删改按需生效，发现不执行代码 | Python AST / 源码校验与目录调用测试 |
| 嵌套调用、错误传播、旧 epoch 拒绝、长动作取消 | 真实 CLI/Python 客户端调用假设备，不发付费模型请求 |
| OMP 工具列表保持固定，无默认 MCP 注入 | 离线 OMP 模型流检查工具 schema、扩展配置 |
| 日志、观测与 trace 保持连通 | baseware-runtime / model-trace 与统一入口测试 |
| 普通 workspace，无 runtime 复制或跨工作区能力共享 | workspace-state / workspace-host / 扫描路径检查 |
| 原始设备行为不因入口调整改变 | driver 不改动，Baseware gamepad / switch 测试 |

完整组件说明见 [architecture.md](architecture.md)，CLI/API 示例见 [RSA README](../README.md)。实机游戏表现另由授权运行验证，不用离线通过代替游戏效果结论。

首次 Baseware 拆分于 2026-10-19 完成验证：RSA 95 项通过、3 项实机跳过，Baseware 18 项通过、1 项实机跳过，Dashboard 41 项通过，三个组件类型检查通过。这是拆分时的历史记录；后续统一能力入口以对应提交的验证结果为准。

统一入口于 2026-10-19 完成离线验证：RSA 98 项通过、3 项实机跳过，类型检查通过。真实 CLI/Python 客户端连接假设备服务，验证嵌套组合、参数透传、按需刷新、观测落盘、断连/接管取消和旧 epoch 拒绝；离线 OMP 请求确认工具列表保持固定。未发在线模型请求或重启游戏。
