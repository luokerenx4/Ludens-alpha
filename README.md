# Playness · Recursive Self-Adaptation

给 AI 传感器、控制器 CLI 和一个普通工作区，让它自行探索环境，并把经验沉淀为技能。Harness 只依赖能力接口；具体设备由 provider 实现并注入。

这个仓库包含三个独立安装、构建的组件：

| 目录 | 职责 | 开发入口 |
| --- | --- | --- |
| [rsa/](rsa/README.md) | Harness、OMP 循环、CLI、日志，以及 mGBA / Ryubing 提供者 | Bun 1.4 |
| [rsa-dashboard/](rsa-dashboard/README.md) | 读取运行日志、显示看板，并为 Pet 提供本地 HTTP API | Node.js 22+、npm |
| [rsa-companion/](rsa-companion/README.md) | 从 OpenAlice 移植的 Alice Pet，消费日志并呈现气泡、画面与声音 | Node.js 22+、pnpm 11 |

RSA 写入工作区日志，Dashboard 读取日志，Pet 消费 Dashboard API。各组件保留自己的锁文件；OMP 的固定版本修改保存在 `rsa/patches/`。旧研究网站不属于这个仓库。

## 安装与启动

在仓库根目录分别安装依赖：

```sh
(cd rsa && bun install --frozen-lockfile)
(cd rsa-dashboard && npm ci)
(cd rsa-companion && pnpm install --frozen-lockfile && pnpm build)
export PATH="$PWD/rsa/bin:$PWD/rsa-companion/bin:$PATH"
```

在单独终端启动 Dashboard：

```sh
cd rsa-dashboard
npm run dev
```

看板监听 `http://127.0.0.1:3015`。首次运行没有日志时显示空列表。

按对应 provider 的文档准备模拟器并加载桥，然后从任务工作区启动 RSA：

```sh
mkdir -p ../workspaces/my-task
cd ../workspaces/my-task
rsa run --provider ryubing --seconds 7200
```

另一个终端进入同一工作区，再执行：

```sh
rsa auto on
rsa-companion --show-window
```

`rsa auto off` 交还控制权；到达本次接管的时间预算也会自动交还。后台启动方法见 [RSA 文档](rsa/README.md)。模型访问需要本机 OMP 登录；默认模型为 `openai-codex/gpt-6.1-sol`。Switch 提供者当前面向 Apple Silicon macOS，构建和设备前提见 [Ryubing 文档](rsa/src/providers/ryubing/README.md)。

## 代码与运行数据

任务工作区是任意普通目录，包含 `AGENTS.md`、`skills/`、`memory/`、`logs/` 和模型自行创建的文件。它不包含 Harness 源码，也不随这个仓库提交。

当前开发约定保留一处仓库外的集中数据目录：**仓库根的同级 `artifacts/`**，即 `<repo>/../artifacts/`。它不是 clone 的内容，首次使用时按需创建：

```text
<parent>/
├── <repo>/                     # 本仓库，顶层是三个组件
├── artifacts/
│   ├── rsa/                    # workspace 索引、OMP 会话、技能版本快照
│   └── switch/                 # Ryubing 源码、SDK 和构建产物
└── workspaces/                 # 示例工作区位置，可换成其他路径
    └── my-task/
        ├── skills/
        ├── memory/
        └── logs/<run-id>/
```

Host 与 Dashboard 使用同一处 `artifacts/rsa/` 查找工作区。更换代码 checkout 的父目录会更换这处索引；工作区自身的文件不会移动。ROM、固件、密钥和存档由用户在本地管理，不包含在源码里。

## 验证

```sh
(cd rsa && bun run check && bun test)
(cd rsa-dashboard && npm test && npm run typecheck)
(cd rsa-companion && pnpm typecheck && pnpm test)
```

默认检查不调用在线模型或操作真实模拟器；真实设备测试需显式开启，命令见各组件文档。Pet 的窗口与音频烟测可单独执行 `pnpm smoke`。

架构记录见 [rsa/docs/architecture.md](rsa/docs/architecture.md)。Alice Pet 保留 [OpenAlice 来源记录](rsa-companion/upstream.json)、[许可证](rsa-companion/LICENSE)和[资源声明](rsa-companion/ui/public/companion/NOTICE.md)。
