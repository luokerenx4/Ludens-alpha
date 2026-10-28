# Driver 发现机制（Dashboard 卫星包引导）

状态：进行中。范围：**被动发现**——用户粘贴 spec，系统验证是否符合约定并展示。不做主动搜索/推荐，不维护任何清单。

## 背景

- GBA 卫星包 `ludens-gba-driver` 已验证可用：`file:` / `github:` 两条链路在 2026-10-28 实测打通（resolve → manifest 完整 → `rsa init`/`up --dry-run` 命令正确 → `serve` 等待模拟器握手）。
- Dashboard 能力页（PR #8，已在 `origin/main`）现有三块：设备能力（所选 workspace 的 `baseware.json` 快照）、自创能力（Python `@capability` 发现）、评测任务。安装引导落点即此页。
- 硬编码清单已否决：主仓背书卫星包来源等于把版权链路拉回来，且社区发布不能等主仓合并才可见。

## 约定（已存在，直接复用）

- `baseware/src/drivers/spec.ts` `parseDriverSpec`：接受 `npm:` / `github:org/repo#rev` / `file:` 三种 spec。
- `asRegistration`：包导出含 `id`/`load` 的 registration 即合法 driver，否则拒绝并报错。这就是"符合约定的核心文件"判定。
- 缓存：`~/.local/state/playness/baseware/drivers/<id>/<sha>/`，pin rev 可复现。

## 改动

1. `baseware driver discover --package <spec>`（`baseware/src/cli.ts` 接命令，逻辑单列）：`parseDriverSpec` 快失败 →
   `resolveDriver` → 打印 manifest 子集 JSON `{id, version, transport, defaultPort, needsGame, launchHint}`。
   失败非零退出 + 人话错误（区分：spec 非法 / 网络-clone-install 失败 / 包不符合约定）。
   约束：只 import registration，**不调用 `load()`**（不连设备，不执行 driver 逻辑）。
2. Dashboard worker 方法 `discoverDriver(spec)`（新建 `rsa-dashboard/lib/drivers.ts`）：用 execFile 调仓库内
   `baseware/bin/baseware driver discover`，仿 `capabilities.ts` 的 Python 发现模式。本地-only（走 `localRequest`），
   超时 120s（github clone + install 开销），复用 worker 现有 64 并发限流。
   不直接 import `loader.ts`：worker 是 Node runtime，`loader.ts` 依赖 Bun（`Bun.spawn`/`Bun.resolveSync`），直接引会崩。
3. 新路由 `/api/drivers/discover?spec=…`，仿 `/api/capabilities` 经 `dashboardWorker().call`。
4. 能力页新增"外部驱动"区（`capabilities-view.tsx`，文件在 main）：spec 输入框 + 验证按钮 → 结果卡
   （manifest + `launchHint` 后端指引 + 一键复制 `rsa init --driver <id> --driver-package <spec>`）→ 失败展示原因。
   **代码里不存任何包地址，不调任何外部搜索。**
5. 测试：CLI discover 单测（`file:` 合法包 fixture 通过、非法 spec 拒绝、导出缺 `id` 的包拒绝）；
   dashboard lib 单测跟随 `python-capabilities.test.ts` 的既有写法；相关套件全绿。
6. 文档：`docs/tutorials/development.md` 驱动章节加"外部驱动发现"一节，只讲 spec 格式并以 GBA 为 worked example，不列清单。

## 非目标

- 主仓内置 mgba/ryubing/azahar 删除（另起 cutover plan）。
- azahar/ryubing 卫星包搭建（用户建好 repo 后照 GBA 手法推包验证）。
- 主动搜索/推荐、由 Dashboard 写 `rsa.json`（发现只读，pin 靠用户复制命令执行）。
- 私有仓 auth（github 私有包需 credential helper，文档一句话带过）。

## 验证

- `baseware driver discover --package github:luokerenx4/ludens-gba-driver#912b7990…` 输出 mgba/47653/launchHint。
- 非法 spec / 不合规包 → 非零退出 + 人话错误。
- Dashboard 能力页粘贴同一 spec 走通；`grep ludens-gba-driver rsa-dashboard baseware/src` 零命中（无硬编码）。
- 新增单测 + 相关现有套件全绿。

## 分支

- 从 `origin/main` 新切 `luokerenx4/driver-discovery`，走 PR 流。beluga 当前分支落后，不在旧分支上施工。
