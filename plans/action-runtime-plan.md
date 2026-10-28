# 常驻动作与统一能力施工方案

状态：实现与离线验收完成（2026-10-28）。

## 目标与边界

新增 workspace `action.py:Action`，与 `perception.py:Perception` 各自运行在独立 Python 进程。两者的基本单元统一使用 `@capability`，共享源码版本、调用关系、可选留档和 benchmark。AI 自己编写判断、控制和组合逻辑；不预填游戏策略，不新增 Agent Loop，不修改 OMP/CUA 本体。

保留现有 CLI/API、Baseware 控制权、异步 play、Timeline 单写入者和文件存储。普通 Python、OMP 原生后台程序仍可使用；常驻入口只是约定，不成为全部程序的执行服务。

## 1. 作者契约

- `@capability` 是唯一能力装饰器，支持普通函数和类方法。普通调用保留原始 Python 返回值，模型/Tensor/None 不被强制序列化。
- 删除 `@perception` 导出和分类字段，不保留别名。仓库模板、测试与现行文档同步迁移；不改写已有 AI workspace 文件。
- `@record` 要求与 `@capability` 一起使用，显式记录已有 text/data/media/space/sources 结果信封。它适用于感知结果、动作判断或其他可记录结果；未标记的中间状态不自动留档。两种装饰顺序仍只包装、记录一次。
- 顶层函数通过 `rsa controller` 发现；类方法通过正常 Python 调用组合和追踪，不假装能从 CLI 无实例调用。直接 import 的 benchmark 版本采集继续有效。

感知入口保持 `start(context)`、`sample()`、`close()` 和 `sample_hz`（默认 30）。sample 使用 `@capability @record`。

动作入口使用 `start(context)`、`step()`、`close()` 和 `step_hz`（默认 30）。step 使用 `@capability`，`@record` 可选，普通返回值由调度器忽略。实例与已加载模型跨 Shiori 轮次复用；慢步骤不重叠、不补跑。AI 可以提交异步 play 后继续观察，不要求每次立即 wait。频率和程序结构由作者按需调整。

## 2. 生命周期与 CLI

`rsa action status | reload | stop`，主 `rsa status` 含动作状态、PID、generation、代码 SHA、stepHz、epoch 和错误。

Host 配置 ActionRuntime，模板缺失时仅创建占位文件，不执行预设动作。动作默认可用，但只有成功接管后的 auto epoch 才启动 worker；manual 时不运行动作循环。reload 在 auto 下先收尾旧代，再加载新代；manual 下只启用待加载状态，在下次接管时加载。stop 禁用当前宿主内的自动启动，直到显式 reload。感知进程不随 action stop/reload 停止。

worker 固定绑定本次启动的 epoch 与 inputGeneration，绝不查询当前 epoch 自动续权。预算结束、人接管、断连和 Host 退出都撤销输入并停止 worker；下一次明确接管可启动新 worker，不承诺跨控制周期保存内存状态。

动作步骤异常后停止运行并清理输入，不按下一帧自动重试可能已经部分执行的动作。错误保持可见，修复后显式 reload。模板未实现不阻止 OMP 继续编写程序。

## 3. 输入收尾：明确的重置边界

现有异步 play 由控制租约持有，杀 Python/RPC 不会停止已提交动作；touch.down、CUA key_down 等也可能跨调用保持状态。本期不引入每个键、触点和 CUA session 的子所有权系统。

因此 action stop/reload/故障采用 **当前 epoch 内的输入重置屏障**：废止旧 inputGeneration，停止旧 worker，暂停新控制请求，取消旧输入 signal，调用现有 driver release 清理输入，等待旧执行收尾，再按原 epoch 恢复 driver。控制预算、OMP 会话和整个 auto epoch 不重置。

这个操作会清空当前设备输入，包括同轮并发 CLI 的输入；它不是只撤销某一个 worker 的键。CLI 帮助和状态明确说明。只读感知继续工作。一般人工交还仍走已有完整 release，不能等待 Python 自愿退出才释放设备。

Baseware 只新增通用 inputGeneration 门禁与重置操作；RSA 的有效 worker 同样核对 generation。旧代请求即使携带同一 epoch 也拒绝。失败或无法确认释放时交还控制并报告，不在输入状态不明时启动新代。保持原生 driver 参数和 play 协议不变。

## 4. 实现复用与数据

Python 提取现有源码加载/版本登记及小型定频循环，两个 worker 复用；不搭建插件调度框架。TS 复用必要的子进程通信/终止代码，感知查询和动作控制分别保留。

Timeline 仍由感知 worker 唯一写入。动作的 `@record` 经现有 append RPC 交给它，`Client.observe()` 提供同一历史查询的 Python 入口，默认仍取感知主通道。停止感知时记录/查询明确失败，不由动作另开 writer。

连续动作循环沿用 normal/full 记录策略：空转和只读轮询不产生逐 tick 通用日志，固定窗口记录能力版本、计数、耗时与故障。真实设备输入和 action_start/action_end 仍完整保留，携带 epoch/generation/trace；不把统计当动作成功。

Dashboard 沿用 Activity 和现有回放轨道，识别动作状态/故障；Pet 继续消费 Dashboard 增量，不另开数据通道。benchmark 直接组合这些能力，使用原有 subject、条件、指标和结果引用。

## 5. 施工顺序

1. 统一装饰器、发现和模板，迁移仓库测试，保留普通 Python/媒体/benchmark 契约。
2. 提取少量常驻共用代码，加入 action worker、Host/CLI 与初始化装配。
3. 接入 epoch/generation 与 Baseware 重置屏障，验证退出、异常、重载和交还的竞态。
4. 补齐连续记录与消费者展示，更新 architecture/workspace/logging/development 和简短 AGENTS 引导。
5. 离线验收、审阅、提交；本次不加载真实游戏宿主、不接管模拟器、不启动在线模型，也不自动推送。

## 6. 验收

- 两个真实 Python 进程并存：动作读取感知结果、持有状态跨多次 step，记录结果进入同一 Timeline；重载动作不重启感知。
- 普通 capability 返回任意 Python 对象；可记录的动作与感知使用相同信封；嵌套/import/类方法的版本与 benchmark subject 正确。
- 模拟 driver 的异步组合输入及独立持续时间真实执行；动作提交后持续采样/决策，不能只验证 RPC 成功。
- 人接管立即撤销 Baseware 输入；stop/reload、步骤异常、进程崩溃、启动中接管均收尾。旧 generation/epoch 请求不能输入；reset 不延长预算；失败不假装恢复。
- 模拟 held key、touch 与异步 play 的释放，覆盖 reset 与全局 handback 交错及并发 CLI 被中断的已声明语义，不操作真实桌面。
- 1/10/30 Hz 空转及读取的经历日志按固定统计窗口增长，真实动作未被省略；历史查询、视频和媒体引用回归通过。
- Dashboard/Pet 展示动作状态和一次故障，统计不刷气泡；benchmark 离线执行及已有相关检查通过。

结果记录在本方案末尾。长时间真实设备表现需后续授权实跑；离线测试不宣称已改善游戏通关或达到真实 30 Hz。


## 实施结果

- `action.py`、`ActionRuntime`、`rsa action status/reload/stop` 已接入；与感知共用 Python 源码加载/循环和 TS 进程通信，Timeline 仍只有原来的写入者。
- 装饰器已统一。普通 Python 计算可以在 manual 运行，是否需要控制权由实际 Baseware 输入判断；原 workspace 文件未自动迁移。
- 真实双 Python 进程通过 Unix RPC 验证了历史读取、可选留档、组合键异步提交、后续步骤继续运行、单次初始化和动作独立重载。模拟输入 left 600 ms / jump 300 ms 有共同按下、只剩 left、全释放三个状态；这只验证接口和调度，不声称真实游戏效果。
- 人接管、步骤报错、进程直接退出、初始化中停止、授权安装前/后回复延迟都已覆盖。重载不改变 epoch、剩余预算和感知 PID；旧 generation 的读取、写入和管理请求被拒绝。Baseware 另测输入清理超时、异步 play 收尾、并发 CLI 和人工交还竞态。
- 1/10/30 Hz 的空转统计测试在同样 10 秒逻辑时间内都只有 2 个窗口事件。真实 Host 路径分别执行 2/12/31 个动作步骤，normal 模式逐步通用审计均为 0，真实输入的 action_start/end 各保留一条。full 模式详细诊断保留。修正了持续动作读取历史仍逐次落盘的遗漏。
- 生命周期只持久化状态变化，PID/频率更新不重复弹泡；动作故障详情可在诊断中查到，默认 Pet 由动作错误状态提示一次。

验证覆盖 RSA TypeScript 全套及更新契约后的定向重跑、Python 51 项、Baseware 74 项（1 个既有在线测试跳过）、Dashboard 197 项、Pet 87 项和各组件类型检查。RSA 的 3 个既有真实设备测试保持跳过。现有媒体冷查询、视频/历史、benchmark、本地类方法 subject、回放和消费者测试通过。没有启动在线模型或真实设备，没有改动游戏 workspace；真实长期运行与视觉效果留待下一次授权实跑。
