# Workspace

Use this as a normal coding workspace. Write programs, collect data, build training
environments, train models, and install dependencies as needed.

- `baseware.json`: device schemas. Discover and invoke capabilities with `rsa controller list` and `rsa controller <id> --help`, or Python's `rsa_tools.Client`. Pass the declared parameter object with `--args` or the API.
- Python functions compose through normal imports. `@capability` from `rsa_tools` exposes typed, documented functions in the catalog; `@benchmark` exposes evaluations through `rsa bench`. See `rsa bench --help` and `rsa bench schema`.
- `perception.py:Perception`: persistent `sample()` records timestamped history at `sample_hz`. Load changes with `rsa perception reload`. The loop reads the latest; `observe` / `rsa observe --help` can inspect earlier records.
- `skills/<name>/SKILL.md`: reusable methods, with `name` and `description` frontmatter. `memory/current.md`: current state and next steps.
- `logs/`: run and benchmark records. `rsa.json`: launch settings. Organize other files as needed.

Keep the supplied control epoch unchanged; human takeover ends device access.
