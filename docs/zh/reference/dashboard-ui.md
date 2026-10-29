# Dashboard UI

Dashboard 使用 Next.js App Router、React、Tailwind CSS 4 与 shadcn/ui（Radix / New York）。网页和可选 Electron 桌面端使用同一份组件，不需要启动 Electron 才能开发 UI。

## 组件归属

- `rsa-dashboard/components/ui/` 保存通过官方 shadcn CLI 引入的组件源码。按钮、表单、开关、复选框、单选组、滑块、卡片、表格、对话框、反馈与页内标签应复用这里的原语。
- shadcn/ui 源码采用 MIT License，许可文本保留在 [`licenses/shadcn-ui.txt`](../../../licenses/shadcn-ui.txt)。
- 业务组件仍放在 `components/`；运行时间轴、活动证据、图表和桌宠动画由业务组件实现，不往 UI 原语里加入工作区或 RSA 调用。
- 类名合并使用 `import { cn } from "cn"`，变体用 `class-variance-authority`；它们与当前 shadcn 注册表生成的源码保持一致。

`components.json` 记录注册表风格与路径。需要新组件时在 Dashboard 目录运行，例如：

```bash
cd rsa-dashboard
npx shadcn@4.23.0 add dialog
```

只添加当前使用的组件。生成后审阅源码与锁文件，不用 `--overwrite` 覆盖本地修改。当前本地调整包括 `NativeSelect.wrapperClassName`（控制包装层宽度）以及 Slider 将可访问性名称与描述传给真正可聚焦的 Thumb。Card 使用适合控制台的紧凑默认值：20px 内边距、16px 区块间距与 13px 说明文字。

## 主题与样式

`app/globals.css` 引入 Tailwind 和 `tw-animate-css`，通过 `@theme inline` 将现有 Ludens 深色配色映射到语义 token。根布局固定使用 `dark`，当前没有新增主题切换功能。

| 用途 | 推荐类名 |
| --- | --- |
| 页面与主文字 | `bg-background text-foreground` |
| 卡片和浮层 | `bg-card` / `bg-popover` |
| 主操作 | Button 默认变体，使用 `primary` 金色 |
| 次操作与弱背景 | Button `secondary` / `outline` / `ghost`；`bg-muted` |
| 说明与状态 | `text-muted-foreground` / `text-success` / `text-destructive` |
| 边框、键盘焦点 | `border-border` / `ring-ring` |

注意 `--muted` 表示弱背景，文字使用 `--muted-foreground`。已有领域 CSS 放在 `@layer components`，允许 Tailwind 的 `utilities` 层覆盖；不要新增未分层的全局 `button` / `input` / `select` 样式，否则会压过共享控件的状态、尺寸和焦点样式。

工作区管理、设置、Benchmark、Capabilities、Docs、活动流、请求详情、回放控件与 Loop Lab 使用共享原语。时间轴刻度、图表、证据行和媒体等领域布局保留在业务 CSS 中，周边表面与状态色使用主题 token。

视觉基线是暖炭灰底色、克制的金色操作、轻边框与统一卡片间距。全局设置从 1180px 起采用双栏，较窄屏幕回落单栏。相关控件放在一起，允许翻译后的标签换行；参考生成图调整界面时，必须用真实中英文页面检查桌面和窄屏排版。

工作区入口采用可搜索的列表，新建、添加已有目录和修改默认位置分别在对话框内完成。高级字段折叠展示，社区驱动字段由已验证的 manifest 决定，并预览最终位置。写入完成后，即使后续目录刷新失败，也应保留成功状态；使用返回的身份显示确认信息并导航。

工作区选择放在共用的顶部上下文栏。设置固定在侧栏底部、可选桌宠面板下方；窄屏通过菜单展开导航，避免把工作区上下文推到首屏之外。

Benchmark 目录使用同一个工作区上下文。切换工作区会清除此前的任务、结果和分页选择；历史筛选的选中状态与正在查看的结果所属任务分开处理。

运行页区分选中的证据、页面自动刷新和最近观察到的宿主状态。全局**回到最新**会清除历史定位及日志筛选，再同时读取观测和日志；**最新日志**只更新当前范围与筛选下的日志。暂停自动刷新会保留当前工作区和运行；主动导航和显式刷新仍可读取一次快照，不会恢复轮询。

## 交互约定

- 表单控件关联 `Label`，帮助信息通过 `aria-describedby` 关联。图标按钮必须有可访问名称。
- 对话框必须有标题和说明，打开时聚焦第一个有用的输入；取消后返回触发按钮，创建成功后聚焦结果。正在创建时保持进度可见，避免意外关闭。
- 明确按钮的 `type`；原生表单的提交按钮用 `submit`，其他操作用 `button`。
- `NativeSelect` 保留原生选项、空值和键盘行为；离散开关用 `Switch`，数值范围用 `Slider`。
- 请求详情使用共享 `Tabs`，支持方向键、Home 与 End；未激活面板不挂载。
- 整行证据与时间轴点击区域可保留显式类型、可见键盘焦点的原生按钮。回放进度条保留原生 range，维持连续毫秒定位及指针／按键释放时提交 URL 的行为；隐藏的声音文件输入也保留原生实现。
- 有后端写入的滑块用 `onValueChange` 更新本地值，`onValueCommit` 保存，避免拖动过程中连续请求。
- 业务请求、等待态、错误反馈与桌面能力检测由页面维护，UI 原语只负责展示和交互。

验收使用 `npm run typecheck`、`npm test`、`npm run build`，并在隔离的 `LUDENS_HOME` 下检查页面与表单操作。详见[控制台调试与验证](../tutorials/debugging-and-verification.md)。
