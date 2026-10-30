# Ludens Pet Companion

Optional native desktop pet and Electron shell (character: Ludens) providing pose reactions, speech bubbles, audio, and window interaction; the main window loads the same RSA Dashboard while speech bubbles consume the shared activity log. The web console runs standalone by default without installing this component.

Requires Node.js 22.x (22.13+) or 24+ and pnpm 11; install and build per [Optional pet setup](../docs/en/tutorials/quickstart.md#optional-pet). Pass `--pet` to `rsa init --name <name>` for new workspaces; an existing `pet: true` in `rsa.json` stays enabled and can be set to `false`. Use `rsa up --pet` / `--no-pet` to override a single launch without modifying `rsa.json`; `--no-pet` does not close an already-running shared pet.

Preferences live in `$LUDENS_HOME/pet/profile/` (defaulting to `~/.ludens` when `LUDENS_HOME` is unset), and the follow target is managed by the Dashboard sharing the same home. Workspace identity is read from `<workspace>/.rsa/workspace.json`, so moving and re-registering a directory preserves following. See the [Workspace guide](../docs/en/tutorials/workspace.md) for layout and import details.

- [Install and Workspace Lifecycle](../docs/en/tutorials/quickstart.md)
- [Ludens Pet Desktop Companion and Verification](../docs/en/tutorials/debugging-and-verification.md)
- [Log Consumption and Workspace Following](../docs/en/reference/logging.md)
- [Architecture and Component Boundaries](../docs/en/reference/architecture.md)
