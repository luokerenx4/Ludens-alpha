# 感知录像可读性与热层重构

状态：施工中。2026-10-29。

## 背景与问题

当前视频感知存储（`rsa/python/rsa_tools/_video.py`）存在三个纠缠的问题：

1. **10 秒分段绑死三种语义**：`RSA_VIDEO_SEGMENT_SECONDS` 同时控制段时长上限、空闲收尾超时、崩溃损失上界。当时（`283277f`）选 10 秒是为了对照时空轴的一小时分段，避免"录完一小时才能看"，没有独立论证。
2. **热层被迫承重**：mp4 的 moov 在容器 close 时才写入（`+faststart`），pending 段不可解码。因此收尾前（最多 10 秒 + 编码积压）内存热层是近期帧**唯一**可读副本。真实屏幕（30 Hz 双屏 PNG ≈ 30–60 MB/s）下 64 MiB 字节预算几秒即逐出，名义 600 秒热窗口实际只剩十几秒——帧被逐出且段未收尾时读取直接失败。
3. **全局 FIFO 淘汰不公平**：`_hot` 按全局序逐出，一路高频流可饿死其他通道的近期帧。

用户判断（已采纳）：内存快取应仅为加速层，磁盘是承重层。写死字节预算压制内存爆是治标——根治是让磁盘副本实时可读。

## 方案

### 1. fMP4 边写边可读（核心）

- 新段使用 fragmented MP4：`av.open(..., options={"movflags": "+frag_keyframe+empty_moov"})`，替换 `+faststart`。关键帧处切块落盘，段未收尾也可解码。
- 关键帧间隔收敛到可接受的读取延迟：x264 `keyint` 按 `max(1, round(sample_hz * 2))` 设定（约 2 秒一个关键帧；30 Hz 下 60 帧）。`decode_frame` 的 seek 精度即最新可读延迟。
- `_finish` 收尾时不再需要重排，直接 close。状态文件 `.mp4.json` 生命周期不变（pending 期间即允许读取——`video_status` 对 fMP4 段在 pending 状态也返回可解信息）。
- `decode_frame` 契约扩展：pending 段可解码已落盘的帧；seek 到的帧若尚未落盘，仍报"exact frame is missing"，不静默替代。
- 历史 `+faststart` 段保持原读取路径，两种格式并存，按状态文件中新增的 `format: "fmp4"` 字段区分。

### 2. 热层改为按通道环形缓存

- `_hot` / `_hot_media` 重组为按 capability channel 的环形结构，每通道独立淘汰，消除全局饿死。
- 淘汰依据改为时间优先：每通道保留最近 `hot_seconds`（默认 600 恢复名义值），字节预算（默认提升至 1 GiB）仅作硬安全阀，触发时按通道公平缩减（每通道等比例砍最旧帧），并在 metrics 中显式报告 `hotBudgetExceeded`。
- 读取路径不变：内存命中直接返回，未命中走 `decode_frame`（现在 pending 段也能解，黑窗消失）。

### 3. 参数拆分

| 参数 | 旧值 | 新值 | 语义 |
|---|---|---|---|
| `RSA_VIDEO_SEGMENT_SECONDS` | 10 | 300 | 纯存储粒度：段时长上限 |
| `RSA_VIDEO_IDLE_SECONDS`（新增） | —（与上共用） | 10 | 停采后空闲收尾超时 |
| `RSA_PERCEPTION_HOT_SECONDS` | 600 | 600 | 每通道加速窗口（一等参数，可配置） |
| `RSA_PERCEPTION_HOT_BYTES` | 64 MiB | 1 GiB | 全局硬安全阀，正常不触发 |

### 4. workspace 配置与前端

- 新增 `workspace/.rsa/settings.json`，字段 `hotSeconds`、`videoSegmentSeconds`、`videoIdleSeconds`。env 退为缺省值：配置文件 > 环境变量 > 内置默认。
- 读取时机：ObservationHistory 初始化及 `rsa perception reload` 热重载。
- Dashboard 设置页（复用 `alice-settings` 的 `setting-group` 样式）加"感知加速窗口"滑条（单位秒/分钟，不暴露字节），PUT 到新 API `app/api/perception-config/`，经 dashboard-worker 写配置文件。字节硬顶不进 UI。
- 每个配置变更记录一条 diagnostic 事件，保留来源与新旧值。

## 不做什么

- 不改 OMP 本体、Baseware driver、benchmark 评分。
- 不迁移历史 `+faststart` 段，不批量重编码。
- 不引入新常驻服务或第二执行进程；配置读写仍在现有单写入者内。
- 崩溃损失上界（fMP4 下为最后一个未落盘 fragment，约等于关键帧间隔）接受，不做 WAL。
- 字节硬顶保留——用户明确认可"安全阀可以留，常闸不行"。

## 实施顺序与验收

1. `_video.py`：fMP4 编码 + keyint + 状态/解码契约扩展。验收：写入中途（未收尾）`decode_frame` 能解出已落盘帧；`uv run --project rsa/python --frozen pytest`。
2. `_observation_history.py`：按通道环形热层 + 参数拆分 + 配置文件读取。验收：合成双流压测中一路高频流不饿死另一路；`hot_seconds` 生效可观测。
3. 配置 API + Dashboard 滑条。验收：改滑条 → reload 后 `policy()` 反映新值；浏览器实际操作一遍。
4. 文档同步 `docs/tutorials/workspace.md`、`docs/reference/logging.md`（若事件新增）。每步独立提交，提交前跑 `scripts/verify-video-storage.py` 离线冒烟。
5. 完工后删除本计划文件并清除 PLANS.md 索引。

## 已知风险

- fMP4 的 `+frag_keyframe` 在 PyAV 版本差异下行为需实测（关键帧间隔是否生效）；若 PyAV 不支持按帧 keyint 选项，退路是手动 `container.flush()` 每 N 帧（`container.flush()` 会强制写出 moof）。
- 浏览器对 fMP4 的 Range 播放需实测（主流均支持，Safari 老版本存疑，Dashboard 是本地工具，接受）。
- 1 GiB 名义预算 vs 真实 30–60 MB/s 流入：600 秒窗口实际需要 18–36 GiB，必然触发安全阀。此时行为是"窗口按预算公平缩短"（每通道仍有几十秒），不再是"读不到"。这是显式权衡：正确性已由 fMP4 兜底，窗口长度由预算决定并显式报告。
