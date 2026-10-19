# Workspace

This directory is the working directory for this task.

- `rsa.json`: launch configuration for this workspace.
- `skills/`: reusable methods and supporting scripts learned in this workspace.
- `memory/`: current goals, state, uncertainties, and next steps; replace outdated notes.
- `logs/`: Harness-generated run records, observations, and diagnostics. Keep these separate from learned methods and working memory.

Other task files may live here as needed. Discover device and workspace capabilities with `rsa controller list` and `rsa controller <id> --help`. Python functions marked with `@capability` from `rsa_tools` appear in that catalog; use type annotations for parameters and a docstring for help. Use `rsa_tools.Client` to compose capabilities in Python. Harness implementation and dependencies are maintained outside this workspace.
