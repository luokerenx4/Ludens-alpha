"""Workspace benchmarks: static discovery, native calls, and offline results."""

import ast
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from functools import wraps
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import uuid

from ._capabilities import function_schema, load_function, marked_functions, validate, workspace_sources
from ._context import current, scope as call_scope


_active = ContextVar("rsa_benchmark", default=None)
_prepared = ContextVar("rsa_prepared_benchmark", default=None)


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json(value):
    return json.dumps(value, allow_nan=False, ensure_ascii=False)


def _write(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(_json(value) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _workspace_id(workspace):
    name = re.sub(r"[^a-z0-9_-]+", "-", workspace.name.lower()).strip("-")[:32] or "workspace"
    return "ws-%s-%s" % (name, hashlib.sha256(str(workspace).encode()).hexdigest()[:16])


def _index(workspace):
    root = Path(os.environ.get("RSA_ARTIFACT_ROOT") or Path(__file__).resolve().parents[4] / "artifacts" / "rsa")
    directory = root / _workspace_id(workspace)
    directory.mkdir(parents=True, exist_ok=True)
    _write(directory / "workspace.json", {"workspace": str(workspace)})


def _options(marker):
    options = {}
    if isinstance(marker, ast.Call):
        if marker.args:
            raise ValueError("Benchmark decorator options must be named literals")
        for keyword in marker.keywords:
            if keyword.arg not in {"targets", "mode", "title", "scope"} or keyword.arg in options:
                raise ValueError("Supported benchmark options are targets, mode, title, and scope")
            try:
                options[keyword.arg] = ast.literal_eval(keyword.value)
            except (ValueError, TypeError):
                raise ValueError("Benchmark decorator options must be static literals") from None
    targets = options.get("targets", [])
    if not isinstance(targets, list) or any(not isinstance(item, str) or not item for item in targets):
        raise ValueError("Benchmark targets must be a list of nonempty capability IDs")
    if len(set(targets)) != len(targets):
        raise ValueError("Benchmark targets must be unique")
    if not isinstance(options.get("mode", "offline"), str) or options.get("mode", "offline") not in {"offline", "live"}:
        raise ValueError('Benchmark mode must be "offline" or "live"')
    if options.get("title") is not None and (not isinstance(options["title"], str) or not options["title"].strip()):
        raise ValueError("Benchmark title must be a nonempty string")
    if not isinstance(options.get("scope", ""), str):
        raise ValueError("Benchmark scope must be a string")
    return options


def _definition(relative, raw, tree, node, markers):
    if node not in tree.body:
        raise ValueError("Benchmarks must be top-level functions, not methods or nested functions")
    if len(markers) != 1 or len(node.decorator_list) != 1:
        raise ValueError("A benchmark function must use only one @benchmark decorator")
    if sum(isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and item.name == node.name for item in tree.body) != 1:
        raise ValueError("A benchmark function name must be unique within its source file")
    options = _options(markers[0])
    description, parameters = function_schema(node, "benchmark")
    code_sha = hashlib.sha256(raw).hexdigest()
    return {
        "id": "python/%s:%s" % (relative, node.name),
        "title": options.get("title") or description.splitlines()[0],
        "description": description, "scope": options.get("scope", ""),
        "revision": code_sha, "source": "workspace", "mode": options.get("mode", "offline"),
        "parameters": parameters, "targets": options.get("targets", []),
        "entry": {"kind": "python", "path": relative, "function": node.name, "codeSHA": code_sha},
    }


def discover(workspace):
    """Discover definitions without importing user code; refresh the UI catalog."""
    workspace = Path(workspace).resolve()
    benchmarks, diagnostics = [], []
    for relative, raw, tree in workspace_sources(workspace, diagnostics):
        for node, markers in marked_functions(tree, "benchmark"):
            try:
                benchmarks.append(_definition(relative, raw, tree, node, markers))
            except (ValueError, SyntaxError) as error:
                diagnostics.append({"path": relative, "function": node.name, "line": node.lineno, "message": str(error)})
    result = {"benchmarks": benchmarks, "diagnostics": diagnostics}
    (workspace / "logs").mkdir(parents=True, exist_ok=True)
    _write(workspace / "logs" / "benchmarks-catalog.json", result)
    _index(workspace)
    return result


def _child_trace(parent):
    trace = {**parent.get("trace", {}), "traceId": parent.get("trace", {}).get("traceId") or uuid.uuid4().hex,
             "spanId": uuid.uuid4().hex[:16]}
    if parent.get("trace", {}).get("spanId"):
        trace["parentSpanId"] = parent["trace"]["spanId"]
    if parent.get("epoch") is not None:
        trace["epoch"] = parent["epoch"]
    return trace


def _new_run(workspace, definition, parameters, parent):
    started = _now()
    run_id = started.replace(":", "-") + "-" + uuid.uuid4().hex[:12]
    directory = workspace / "logs" / run_id
    directory.mkdir(parents=True)
    (directory / "artifacts").mkdir()
    result = {
        "schemaVersion": 2, "definition": definition, "status": "running", "verdict": None,
        "startedAt": started, "endedAt": None, "durationMs": None,
        "runId": run_id, "project": _workspace_id(workspace), "workspace": str(workspace),
        "trace": _child_trace(parent), "parameters": parameters,
        "provenance": {"python": sys.version.split()[0]}, "checks": [], "metrics": [],
        "conditions": {}, "subjects": [], "artifacts": [], "limitations": [definition["scope"]] if definition["scope"] else [],
    }
    if parent.get("run_id"):
        result["parentRunId"] = parent["run_id"]
    _write(directory / "manifest.json", {
        "kind": "benchmark", "runId": run_id, "workspace": str(workspace),
        "workspaceId": result["project"], "eventSchemaVersion": 2,
        "drivers": [], "model": None, "seconds": 0, "maxRequests": 0,
        "trace": result["trace"], **({"parentRunId": result["parentRunId"]} if "parentRunId" in result else {}),
        "benchmark": {"id": definition["id"], "revision": definition["revision"], "mode": definition["mode"]},
    })
    _write(directory / "benchmark.json", result)
    return directory, result


def _validate_outcome(outcome):
    _json(outcome)
    for key in ("checks", "metrics"):
        items = outcome[key]
        if not isinstance(items, list):
            raise ValueError("Benchmark %s must be an array" % key)
        ids = []
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]:
                raise ValueError("Benchmark %s require nonempty IDs" % key)
            ids.append(item["id"])
        if len(set(ids)) != len(ids):
            raise ValueError("Benchmark metric/check IDs must be unique")
    for metric in outcome["metrics"]:
        value = metric.get("value")
        if "value" not in metric or (value is not None and (type(value) not in (int, float) or not math.isfinite(value))):
            raise ValueError("Benchmark metric value must be a finite number or null")
        if not isinstance(metric.get("unit"), str) or metric.get("direction", "none") not in {"lower", "higher", "none"}:
            raise ValueError("Benchmark metric requires a unit and valid direction")
        if "label" in metric and not isinstance(metric["label"], str):
            raise ValueError("Benchmark metric label must be a string")
    for check in outcome["checks"]:
        if "passed" not in check or (check["passed"] is not None and type(check["passed"]) is not bool):
            raise ValueError("Benchmark check passed must be true, false, or null")
        if any(not isinstance(check.get(key), str) for key in ("label", "expected", "actual")):
            raise ValueError("Benchmark checks require label, expected, and actual strings")
        if not isinstance(check.get("evidenceSeq"), list) or any(type(seq) is not int or seq < 1 or seq > 9007199254740991 for seq in check["evidenceSeq"]):
            raise ValueError("Benchmark check evidenceSeq must contain positive safe integers")
    if "conditions" in outcome and not isinstance(outcome["conditions"], dict):
        raise ValueError("Benchmark conditions must be an object")
    for key in ("subjects", "artifacts"):
        if key in outcome and not isinstance(outcome[key], list):
            raise ValueError("Benchmark %s must be an array" % key)
    for subject in outcome.get("subjects", []):
        if not isinstance(subject, dict) or not isinstance(subject.get("id"), str) or not subject["id"]:
            raise ValueError("Benchmark subject requires an ID")
        if any(key in subject and not isinstance(subject[key], str) for key in ("path", "sha256", "revision")):
            raise ValueError("Benchmark subject references must be strings")
    for artifact in outcome.get("artifacts", []):
        if not isinstance(artifact, dict) or not isinstance(artifact.get("path"), str) or not artifact["path"]:
            raise ValueError("Benchmark artifact requires a path")
        path = artifact["path"]
        if path.startswith("/") or "\\" in path or ".." in path.split("/"):
            raise ValueError("Artifacts must be relative to the benchmark run")
        if "label" in artifact and not isinstance(artifact["label"], str):
            raise ValueError("Benchmark artifact label must be a string")
    if "limitations" in outcome and (not isinstance(outcome["limitations"], list) or any(not isinstance(item, str) for item in outcome["limitations"])):
        raise ValueError("Benchmark limitations must be strings")


class BenchmarkContext:
    """Metadata and artifacts for the currently executing benchmark."""

    def __init__(self, directory, result):
        self.run_dir = Path(directory).resolve()
        self.result = result
        self._sequence = 0

    def _save(self):
        _write(self.run_dir / "benchmark.json", self.result)

    def conditions(self, **values):
        self.result.setdefault("conditions", {}).update(json.loads(_json(values)))
        self._save()

    def subject(self, id, *, path=None, sha256=None, revision=None):
        item = {"id": id, **{key: str(value) for key, value in {"path": path, "sha256": sha256, "revision": revision}.items() if value is not None}}
        _validate_outcome({"checks": [], "metrics": [], "subjects": [item]})
        self.result.setdefault("subjects", []).append(item)
        self._save()
        return item

    def artifact(self, path, *, label=None):
        path = Path(path)
        absolute = (self.run_dir / path).resolve() if not path.is_absolute() else path.resolve()
        relative = absolute.relative_to(self.run_dir).as_posix()
        item = {"path": relative, **({"label": label} if label is not None else {})}
        _validate_outcome({"checks": [], "metrics": [], "artifacts": [item]})
        self.result.setdefault("artifacts", []).append(item)
        self._save()
        return item

    def record(self, event_type, data, trace=None, *, origin=None, source=None):
        self._sequence += 1
        at, at_ms = _now(), time.monotonic() * 1000
        event = {
            "schemaVersion": 2, "runId": self.result["runId"], "seq": self._sequence,
            "at": at, "atMs": at_ms, "type": event_type, "data": data,
            "trace": self.result["trace"] if trace is None else trace,
            "source": source or {"component": "benchmark", "implementation": "python"},
            "origin": origin or {"eventId": "%s:%d" % (self.result["runId"], self._sequence),
                                 "clockId": self.result["runId"], "seq": self._sequence, "at": at, "atMs": at_ms},
        }
        with (self.run_dir / "events.jsonl").open("a", encoding="utf-8") as output:
            output.write(_json(event) + "\n")

    def _workspace_event(self, context, event_type, data, origin):
        self.record(event_type, data, context["trace"], origin=origin,
                    source={"component": "workspace", "implementation": "python"})
        if event_type == "python_call_start" and data.get("id") in self.result["definition"]["targets"] and data.get("codeSHA"):
            subject = {"id": data["id"], "revision": data["codeSHA"]}
            subjects = self.result.setdefault("subjects", [])
            if subject not in subjects:
                subjects.append(subject)
                self._save()

    def _complete(self, report):
        if report is None:
            report = {}
        if not isinstance(report, dict):
            raise ValueError("A benchmark must return a report dict or None")
        allowed = {"checks", "metrics", "conditions", "subjects", "artifacts", "limitations"}
        if set(report) - allowed:
            raise ValueError("Unknown benchmark report fields: " + ", ".join(sorted(set(report) - allowed)))
        outcome = {"checks": [], "metrics": [], **report}
        for key in ("subjects", "artifacts", "limitations"):
            if key in self.result:
                if not isinstance(outcome.get(key, []), list):
                    raise ValueError("Benchmark %s must be an array" % key)
                outcome[key] = self.result[key] + outcome.get(key, [])
        if "conditions" in self.result:
            if not isinstance(outcome.get("conditions", {}), dict):
                raise ValueError("Benchmark conditions must be an object")
            outcome["conditions"] = {**self.result["conditions"], **outcome.get("conditions", {})}
        _validate_outcome(outcome)
        for artifact in outcome.get("artifacts", []):
            path = Path(artifact["path"])
            (self.run_dir / path).resolve().relative_to(self.run_dir)
        self.result.update(json.loads(_json(outcome)))
        checks = self.result["checks"]
        self.result["verdict"] = "failed" if any(check["passed"] is False for check in checks) else (
            "inconclusive" if any(check["passed"] is None for check in checks) else "passed" if checks else None)
        self.result["status"] = "completed"


def current_benchmark():
    """Return this call's report context, or fail outside a benchmark."""
    context = _active.get()
    if context is None:
        raise RuntimeError("No benchmark is currently running")
    return context


@contextmanager
def prepared_run(directory, result):
    """Adopt the run reserved by the CLI; only the selected entry consumes it."""
    token = _prepared.set((Path(directory).resolve(), result))
    try:
        yield
    finally:
        _prepared.reset(token)


def benchmark(function=None, *, targets=None, mode="offline", title=None, scope=""):
    """Mark a synchronous, typed benchmark without exposing a Controller capability."""
    def mark(target):
        workspace = Path(current()["workspace"]).resolve()
        source = Path(target.__code__.co_filename).resolve()
        relative = source.relative_to(workspace).as_posix()
        raw = target.__globals__.get("__rsa_source_bytes__")
        if raw is None:
            raw = source.read_bytes()
        tree = ast.parse(raw, filename=relative)
        selected = [(node, markers) for node, markers in marked_functions(tree, "benchmark") if node.name == target.__name__]
        if len(selected) != 1:
            raise ValueError("Benchmark must be a uniquely named top-level @benchmark function")
        definition = _definition(relative, raw, tree, *selected[0])
        # The loader's hash names the bytes actually compiled, not an edited file.
        code_sha = target.__globals__.get("__rsa_source_sha__", definition["revision"])
        definition["revision"] = definition["entry"]["codeSHA"] = code_sha
        signature = inspect.signature(target)

        @wraps(target)
        def wrapped(*args, **kwargs):
            bound = signature.bind(*args, **kwargs)
            bound.apply_defaults()
            parameters = dict(bound.arguments)
            validate(parameters, definition["parameters"])
            parameters = json.loads(_json(parameters))
            parent = current()
            discover(workspace)
            prepared = _prepared.get()
            if prepared is None:
                directory, result = _new_run(workspace, definition, parameters, parent)
            else:
                directory, result = prepared
                if result["definition"]["id"] != definition["id"] or result["definition"]["revision"] != definition["revision"]:
                    raise ValueError("Prepared benchmark identity does not match the loaded function")
                result["parameters"] = parameters
                result["definition"] = definition
                result["trace"] = result.get("trace") or _child_trace(parent)
                if parent.get("run_id"):
                    result["parentRunId"] = parent["run_id"]
            pending_token = _prepared.set(None)
            context = BenchmarkContext(directory, result)
            active_token = _active.set(context)
            started = time.monotonic()
            try:
                context._save()
                context.record("benchmark_start", {"benchmarkId": definition["id"], "parameters": parameters})
                # Keep the host run ID: device and nested capability events belong
                # to that host, while this sink also records them in this run.
                with call_scope({**parent, "trace": result["trace"], "event_sink": context._workspace_event}):
                    report = target(*args, **kwargs)
                    context._complete(report)
            except BaseException as error:
                result.update(status="cancelled" if isinstance(error, KeyboardInterrupt) else "error",
                              verdict=None, error="%s: %s" % (type(error).__name__, error))
                try:
                    context.record("benchmark_error", {"error": result["error"]})
                    _finish(context, started)
                except Exception as write_error:
                    print("RSA benchmark result write failed: %s" % write_error, file=sys.stderr)
                raise
            else:
                _finish(context, started)
                return report
            finally:
                _active.reset(active_token)
                _prepared.reset(pending_token)

        wrapped.__rsa_benchmark__ = True
        wrapped.__rsa_benchmark_definition__ = definition
        return wrapped

    return mark if function is None else mark(function)


def _finish(context, started):
    result = context.result
    result["endedAt"] = _now()
    result["durationMs"] = (time.monotonic() - started) * 1000
    context.record("benchmark_end", {"benchmarkId": result["definition"]["id"], "status": result["status"], "verdict": result["verdict"]})
    context._save()


def run(benchmark_id, arguments=None):
    """Run a workspace benchmark in this process, reusing ordinary imports."""
    relative, separator, function_name = benchmark_id.removeprefix("python/").rpartition(":")
    if not benchmark_id.startswith("python/") or not separator or not relative.endswith(".py") or not function_name.isidentifier():
        raise ValueError("Python benchmark IDs use python/path.py:function")
    workspace = Path(current()["workspace"]).resolve()
    return load_function(workspace, relative, function_name, marker="benchmark")(**(arguments if arguments is not None else {}))
