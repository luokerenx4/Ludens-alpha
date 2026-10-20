# Workspace

This is a normal coding workspace. Write and run Python programs here; a program
can collect data, train models, and continuously observe and act using the supplied capabilities.

- `rsa.json`: launch configuration for this workspace.
- `baseware.json`: generated device capabilities, parameter schemas, and invocation contracts; read as needed and refresh with `baseware export`.
- `perception.py`: your persistent `Perception` implementation; choose sampling, processing, and any background loop.
- `skills/`: reusable methods and supporting scripts learned in this workspace.
- `memory/`: current goals, state, uncertainties, and next steps; replace outdated notes.
- `logs/`: Harness-generated run records, observations, and diagnostics. Keep these separate from learned methods and working memory.

Other task files may live here as needed. Discover device and workspace capabilities with `rsa controller list` and `rsa controller <id> --help`. Mark entry points with `@capability` from `rsa_tools`, typed parameters, and a docstring to expose them in that catalog. Reuse functions with normal imports or `rsa_tools.Client`; Python capability calls stay in your process, while device calls use Baseware. Separate CLI invocations do not share memory. Harness implementation and dependencies are maintained outside this workspace.

Read the starter contract in `perception.py`. Its process keeps imported modules, models, and state between observations. Use `rsa perception status`, `reload`, `observe`, or `stop`; reload after code or weight changes. Automatic observation reads your result; missing or failed perception yields text, with no default screenshot. Perception uses read-only device calls without a control epoch. Keep sequence and sample times honest; reusing a result is not a new sample.

When measurement helps, use `@benchmark` from `rsa_tools` to evaluate your capabilities, return metrics and optional checks, and compare runs with `rsa bench`; `rsa bench --help` describes the interface.
