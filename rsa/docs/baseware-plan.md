# Baseware 与工作区能力：实施及验收计划

目标：把环境的最小操作与传感能力称为 driver，通过独立 Baseware 进程统一暴露 CLI、API、MCP。RSA 发现并执行工作区自行产生的能力；使用 Python 装饰器按函数注册工具。实现保持简单，直接更新接口，不保留旧设备入口或兼容字段。

## 实施顺序

1. **设备边界**：将 mGBA / Ryubing 的契约、桥、采集和输入代码移入 `baseware/`；设备实现只在 Baseware 装配。定义服务目录与整轮操作权，RSA 使用单一服务连接。
2. **统一访问**：CLI、TS/Python API、MCP 都连接同一 Baseware core；传递参数、结果、trace 和取消。Baseware 独立处理期限、拥有者断开与人工收回，不依赖模型结束。
3. **工作区能力**：静态读取普通 `.py` 中 `@capability` 函数的签名和 docstring，按函数产生工具。调用时执行代码；下一批刷新新增、修改、删除，保留原 OMP 会话。
4. **应用接线**：`rsa up/down/services` 装配 Baseware、Agent、Dashboard 和 Pet；运行日志留在 workspace。设备事件进入 RSA run，图像可被已有展示链读取。
5. **清除旧边界**：删除 RSA 的 sensor/controller 转发、RSA_EPOCH/RSA_TRACE 别名，以及按 controller 重复接管的代理对象。设备配置统一为 `driver`，manifest 使用 `drivers`，消费者同步更新。
6. **验证与交付**：检查调用、取消、目录刷新、日志和进程清理；检查提交范围、更新文档并推送。默认离线验证，不修改模型生成的 skill/memory，不为验证额外发在线模型请求。

## 验收证据

| 要求 | 当前实现与验证入口 |
| --- | --- |
| Baseware 独立包、独立进程，RSA 不加载设备实现 | `baseware/src/main.ts`、`rsa/src/app/main.ts`；workspace-host / shutdown 以真实子进程验证 |
| 同一底层的 CLI / API / MCP | `baseware/tests/service.test.ts`、`mcp.test.ts`、`rsa/tests/python-capabilities.test.ts` |
| 整轮操作权，短调用不夺权，断线/到期/人工接管可打断 | service / baseware-runtime / runtime 测试；包括只有 Sensor 的设备 |
| Python 函数自动成为工具，不在发现阶段执行代码 | python-capabilities 测试：AST、参数、源码刷新、子进程取消 |
| 同一 OMP 会话里新增/修改/删除工具 | `rsa/tests/omp-python.test.ts` 使用真实 OMP 和离线模型流 |
| 日志、观测与 trace 连通 | baseware-runtime 的观测落盘、model-trace 的 shell→Baseware 关联 |
| 普通 workspace、无 runtime 复制、无跨工作区能力共享 | workspace-state / workspace-host / Python workspace 扫描路径 |
| 原始设备行为不因拆包改变 | driver 源码迁移 diff，Baseware 的 gamepad / switch 测试 |
| 无兼容设备转发或旧字段 | RSA transport/CLI、shell 环境、launch config、manifest 与 Dashboard 类型的源码审查 |

本计划记录当前施工边界与验收入口；完整组件说明见 [architecture.md](architecture.md)。实机游戏表现另由后续授权运行验证，不用离线通过代替真实游戏效果结论。

2026-10-19 收尾验证：RSA 95 项通过、3 项实机测试跳过；Baseware 18 项通过、1 项实机测试跳过；Dashboard 41 项通过，三个组件类型检查通过。临时空 workspace 的 `rsa init --driver ryubing` 与 `rsa up --dry-run` 验证了新配置和进程接线，仅生成 `AGENTS.md`、`rsa.json`，未启动设备或发送模型请求。
