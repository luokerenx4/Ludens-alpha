# Workspace

Use this as a normal coding workspace. Write programs, collect data, build training
environments, train models, and install dependencies as needed.

- `baseware.json`: device schemas. Discover and invoke capabilities with `rsa controller list` and `rsa controller <id> --help`, or Python's `rsa_tools.Client`. Pass the declared parameter object with `--args` or the API.
- Python functions compose through normal imports. `@capability` exposes typed functions; `@perception` marks sensing and `@record` saves its result to the workspace timeline. `@benchmark` exposes evaluations through `rsa bench`. See `rsa bench --help` and `rsa bench schema`.
- `perception.py:Perception`: persistent `sample()` samples at `sample_hz` (default 30; tune as needed); mark it with `@perception` and `@record` to retain observations. Load changes with `rsa perception reload`. The loop reads the latest; `observe` / `rsa observe --help` can inspect earlier records or another capability.
- `skills/<name>/SKILL.md`: reusable methods, with `name` and `description` frontmatter. `memory/current.md`: current state and next steps.
- `.rsa/timeline/`: shared recorded observations; other components reference them. `logs/`: run and benchmark records. `rsa.json`: launch settings. Organize other files as needed.

Keep the supplied control epoch unchanged; human takeover ends device access.
