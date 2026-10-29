# Ludens Pet Companion

可选的原生桌宠与 Electron 壳（角色：卢登斯），从 OpenAlice 移植，保留角色、气泡、音频和窗口交互；主窗口加载同一份 RSA Dashboard，气泡消费同一套活动日志。默认网页控制台独立运行，无需安装本组件。

使用 Node.js 22.x（22.13 起）或 24+、pnpm 11，按 [可选桌宠安装](../docs/tutorials/quickstart.md#可选桌宠) 安装并构建。新工作区在 `rsa init --name <name>` 命令中追加 `--pet`；已有 `rsa.json` 中的 `pet: true` 保持启用，可改为 `pet: false`。也可用 `rsa up --pet` / `--no-pet` 仅覆盖一次启动，不改配置；`--no-pet` 不会关闭已运行的共享桌宠。

默认偏好目录为 `$LUDENS_HOME/pet/profile/`，未设置 `LUDENS_HOME` 时使用 `~/.ludens`；跟随目标由同一 home 的 Dashboard 管理。工作区身份读取 `<workspace>/.rsa/workspace.json`，移动后重新登记即可继续跟随。完整目录和导入步骤见 [工作区指南](../docs/tutorials/workspace.md)。

- [安装与工作区启停](../docs/tutorials/quickstart.md)
- [Ludens Pet 桌面伴侣与验证](../docs/tutorials/debugging-and-verification.md)
- [日志消费与跟随工作区](../docs/reference/logging.md)
- [组件边界](../docs/reference/architecture.md)

来源与授权保留在 [LICENSE](LICENSE)、[upstream.json](upstream.json) 和 [素材说明](ui/public/companion/NOTICE.md)。`upstream.json` 记录移植时的上游路径与哈希，不是当前目录清单。
