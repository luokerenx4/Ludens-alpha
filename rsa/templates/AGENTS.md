# Workspace

This is a normal coding workspace. Write and run Python programs here; a program
can collect data, train models, and continuously observe and act using the supplied capabilities.

- `rsa.json`: launch configuration for this workspace.
- `baseware.json`: generated device capabilities, parameter schemas, and invocation contracts; read as needed and refresh with `baseware export`.
- `skills/`: reusable methods and supporting scripts learned in this workspace.
- `memory/`: current goals, state, uncertainties, and next steps; replace outdated notes.
- `logs/`: Harness-generated run records, observations, and diagnostics. Keep these separate from learned methods and working memory.

Other task files may live here as needed. Discover device and workspace capabilities with `rsa controller list` and `rsa controller <id> --help`. Mark entry points with `@capability` from `rsa_tools`, typed parameters, and a docstring to expose them in that catalog. Reuse functions with normal imports or `rsa_tools.Client`; Python capability calls stay in your process, while device calls use Baseware. Keep models and state in that process as needed; separate CLI invocations and automatic observations do not share memory. Restart a program to load code edits. Harness implementation and dependencies are maintained outside this workspace.

A zero-argument function marked `@capability(hook="observe")` replaces this workspace's automatic observation. Keep one active observer; removing the marker restores the default. Its ordinary Python helpers and state files belong in this workspace.
