# Workspace 感知时空轴施工方案

状态：已实施并通过离线验收。范围是 OMP 以外的观测持久化；不修改 OMP 本体、原生 session、模型请求 payload 或 WS/SSE stream。

## 目标与边界

workspace 拥有一条跨 run 的感知时空轴。原子能力通过两个显式装饰器声明感知与记录；只有被记录的感知结果进入轴。感知进程是唯一写入者，其他组件引用轴上的记录和媒体，不再自动建立永久截图副本。

保持普通 Coding workspace：用户函数仍在调用它的 Python 进程中执行，可持有模型、组合函数及运行后台程序。只把需要记录的结果送入已有感知进程，不新增执行服务、数据库或调度框架。动作、控制 epoch、OMP 外层循环保持原有职责。

现有 workspace、自建代码和旧日志不手工迁移或删除。新版模板和错误提示说明新契约，由使用者或 Agent 自行适配。旧 run 的 Dashboard 附件继续可读，新运行只写新结构。此次不会自动回收已有数百 GB 历史，也不会宣称模型网络日志的重复保存已经解决。

## 原子能力契约

```python
from rsa_tools import perception, record

@record
@perception
def temperature() -> dict:
    """Read temperature in the device's coordinate frame."""
    return {"data": {"value": 22.5, "unit": "C"},
            "space": {"frame": "room-a"}}
```

- `@perception` 声明感知能力，隐含现有 `@capability` 的发现和调用追踪；方法可标注，只有顶层函数进入 Controller 目录。
- `@record` 与 `@perception` 组合，成功调用后记录一次，返回观测信封并附 `timeline` 引用。两种装饰顺序均可使用；不叠加两套追踪或重复记录。普通 `@capability` 保留。
- 没有 `@record` 的感知不隐式保存。单独使用 `@record` 明确报契约错误。发现使用 AST，不执行用户代码。
- 观测信封：`text`、`data`（任意 JSON）、`media`、`sampledAt`、`sources`、`space` 均可选；未知字段报错，不能静默丢数据。媒体支持 `path` 或原生 base64 `data` 与 `mediaType`，记录后返回持久对象引用。路径相对 workspace；不推测屏幕布局或传感器含义。
- 已记录结果的 `timeline` 为 `{recordId, sequence}`；每个媒体同时带 `timeline: {recordId, sequence, asset}`，`asset` 是轴根内相对路径。返回文件路径只是当前本机读取便利，稳定身份来自引用。
- 来源包含能力 ID、实际加载源码 hash、runId、generation（如有）和 trace。采样单调时间区间、来源时间 `sampledAt`、记录墙钟 `recordedAt` 分别保存；未知来源时间不伪造。
- 嵌套能力仅按各自标记记录。外层可通过 `sources` 引用内层，内容相同的媒体共享对象，时间记录仍分别保留。记录失败抛错，不重试感知或动作，不假装留档成功。

## 进程与调度

复用现有常驻感知 worker 作为轴的单一写入者，workspace 文件锁拒绝第二写入者。worker 启动先初始化轴，再加载 workspace 的 `Perception`；缺文件、加载失败或 sample 失败不破坏已存在历史，也不阻止其他感知函数记录。

- sampler 仍按 `Perception.sample_hz` 串行调用 `sample()`，不补跑、不重叠。新版模板在 `sample()` 上标记 `@perception` 和 `@record`；sampler 不再无条件 append。
- sampler 内的装饰器通过进程内上下文直接写入。普通 import、CLI 和后台程序通过已有 RSA socket 的 `timeline append` 转发到同一 worker；函数本身不挪到 worker 执行。
- 外部查询同样走已有入口。writer 不可用时返回清楚错误，不自动取得设备控制权，不因一次查询重启采样。显式 `perception reload/stop` 保持生命周期职责。
- 源码来源使用实际加载版本；修改磁盘文件不冒充已加载模块更新。

## 存储与查询

```text
workspace/.rsa/timeline/
  objects/<sha256>.bin         持久媒体原件，跨记录和分段按内容去重；MIME 存在记录里
  segments/<UTC时间>-….*      JSONL、定长索引及段摘要
  …                          短期窗口和恢复状态
workspace/logs/<run>/
  events.jsonl               时间线事件和观测引用
  perception/<generation>/   实际加载源码清单及 stderr（不是媒体副本）
```

沿用十分钟/64 MiB 热窗口、一小时/256 MiB 分段与现有环境变量。持久模式的冷查询按段读取，不加载全量记录或图片；每条记录独立序号，媒体原件先完成再提交记录。已存在的分段尾恢复能力继续保留。

关闭持久化时只保留有限临时窗口，不向持久 objects 偷存一份。被选中的媒体在交付读取过程中受到保护，完成编码后释放；必要时在响应内携带选中媒体字节，避免“返回路径后先被淘汰”。不通过额外永久副本解决生命周期。窗口淘汰或停止后 Dashboard 明确显示已过期。

`observe` 默认查询主 `Perception.sample` 能力，不能让另一个温度或嵌套截图记录替代主观测。增加 `capability` 和 `id` 查询；原 `at/start/end/after/limit` 语义保持（时间按 recordedAt），历史跨 run。显式 `capability: "*"` 查询全轴。当前主能力最新读取仍校验本 generation 与采样健康，历史读取不冒充最新。

## 去除重复留档

1. Baseware：模拟器 CAPTURE 使用调用临时文件，读成原生结果字节后 finally 清理；CUA 内联媒体直接交付。调用方显式指定的 CUA 输出文件原样保留，属于调用方文件。设备事件保留 ID、时间和媒体类型等元数据，未留档不伪造永久路径。
2. API/MCP/Python：原生媒体内容完整返回，`Observation.path` 可缺省，通过 `contentIndex` 对应原生内容。
3. CLI：输出完整原生 JSON 结果，不能删掉 bytes 后只交付失效的临时路径；调用方按需保存。同步能力导出说明。
4. RSA：移除 Baseware 订阅时的 run 图片复制、历史 observe 的二次复制。实际模型输入仍记录观测 ID/引用和交付事件。
5. 我们自己的 OMP 插件：停止为普通 read/bash 返回图片自动建立 run 媒体档案；已记录感知媒体可以关联轴上的原件，其余只留交付元数据，不声称有永久图片。OMP 原生会话与模型请求/响应保存不改。
6. Dashboard：用项目注册的 workspace 解析明确的 timeline 引用，真实路径校验防止越界和 symlink 逃逸。结构化感知详情按记录引用惰性读取，不能把 JSON 感知再抄回事件日志。旧 run/observations 走原有路径；没有档案或已过期的媒体不渲染坏图。Pet 继续使用 Dashboard 增量协议。
7. Benchmark：已记录的 timeline 媒体原件只登记引用；普通显式提交的测试附件保持原有归档行为。

## 实施顺序

1. 设计落档并创建 goal；冻结上述边界，分工独立文件。
2. Python 装饰器、通用观测、单写入者、workspace 轴及查询；复用已有文件存储和采样器。
3. Baseware 原生媒体临时生命周期、CLI 契约；RSA 转发与查询消费改为引用。
4. Dashboard 引用读取/过期展示、实际模型输入元数据；同步模板、help、现行文档和 benchmark。
5. 运行针对性离线回归和跨进程端到端验证，检查新增目录、图片数量和内存边界；审查后提交。真实游戏重启、在线模型和旧数据清理由后续任务决定。

## 验收

- 标记与未标记能力、两种装饰顺序、直接 import / Client / CLI、嵌套调用都符合记录次数与来源约定；静态发现不执行代码。
- 图像、音频、二进制和 JSON 传感器数据完整；来源时刻/空间元数据不丢失。同图多次记录只有一个持久媒体对象。
- sampler 与外部 Python 并发写入序号无冲突；失败没有成功记录，写入不自动重试。
- 换 run / reload 后旧历史可查；默认主通道和其他感知通道互不抢占；加载失败仍能查历史和接受显式记录。
- 热缓存有界、分段冷查、残缺尾恢复、非持久窗口过期与响应读取竞争可验证；不依靠完整索引常驻内存。
- 各 driver 捕获成功/失败/取消后不积累临时图片；CUA 明确输出文件和原生未知字段完整保留；CLI/API/MCP 返回可用媒体。
- RSA 新 run 不创建观测副本；Dashboard 读同 workspace 轴原件、旧 run 附件仍可读，跨 workspace/符号链接逃逸拒绝。
- 不改 AI 生成文件、OMP 本体/补丁/session/payload/streams；不删除旧数据、不启动游戏或在线模型。

## 验证记录

2026-10-27，离线验证使用临时 workspace 与合成媒体，没有接管真实设备或请求在线模型：

- Baseware：三种模拟器桥接 fixture 的成功、失败、缺失文件、取消与重复采集均清理临时目录；原生 CLI/API/MCP 字节保持完整。
- Python：两种装饰顺序、本地组合、三进程与 sampler 并发、单 writer 拒绝与异常恢复、严格时间校验、跨段去重、跨 run 查询、非持久窗口淘汰均通过。1,500 条合成记录验证 64 KiB 热预算，后续分配增量低于 512 KiB，峰值低于 2 MiB；这是受测 Python 分配，不是生产 RSS 的上界。
- Host：真实 RSA socket、Controller、CLI、独立 Python 进程贯通；仅感知无法取得输入控制权；源码缺失或加载失败仍能记录和查历史；新 run 不生成媒体副本。
- Shiori：原生 OMP 的历史图片交付、后台 bash 和会话持久化继续通过离线模拟；转换后的未记录图片仅保留交付元数据，OMP 自己的图片内容不修改。
- 内置 `perception-lifecycle` benchmark 六项检查通过，涵盖常驻实例、reload、故障修复、历史和原件稳定性。
- Dashboard：时空轴原件、旧 run 附件、过期窗口和路径边界分别验证；结构化数据按记录引用读取，不回填事件日志。

此轮不证明真实长时游戏内存曲线，也没有释放旧档案。真实游戏启用新版前，需要使用者或 Agent 适配主 sample 的装饰器与原生内联媒体；未手工改写已有 workspace。
