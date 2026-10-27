"""Shared source loading and fixed-rate execution for workspace residents."""

import hashlib
import importlib.abc
import importlib.machinery
import inspect
import json
from pathlib import Path
import sys
import threading
import time
import types
import uuid

from ._context import scope
from ._recording import RecordingWindow


class WorkspaceSourceLoader(importlib.machinery.SourceFileLoader):
    def __init__(self, fullname, path, remember):
        super().__init__(fullname, path)
        self.remember = remember

    def get_code(self, fullname):
        raw = self.get_data(self.path)
        self.remember(Path(self.path), raw)
        module = sys.modules[fullname]
        module.__rsa_source_sha__ = hashlib.sha256(raw).hexdigest()
        module.__rsa_source_bytes__ = raw
        return self.source_to_code(raw, self.path)


class WorkspaceImports(importlib.abc.MetaPathFinder):
    def __init__(self, workspace, remember):
        self.workspace = workspace
        self.remember = remember

    def find_spec(self, fullname, path=None, target=None):
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if (spec and spec.origin and spec.origin.endswith(".py")
                and Path(spec.origin).resolve().is_relative_to(self.workspace)):
            spec.loader = WorkspaceSourceLoader(fullname, spec.origin, self.remember)
        return spec


def load_instance(message, role, class_name, method_name, *, recorded=False):
    """Load exactly the supplied source and track imported workspace revisions."""
    workspace = Path(message["workspace"]).resolve()
    source = message.get("source")
    if message.get("sourceError"):
        raise RuntimeError(message["sourceError"])
    if source is None:
        raise NotImplementedError(f"Implement workspace/{role}.py:{class_name}, then reload it.")
    manifest = {}
    manifest_lock = threading.Lock()
    manifest_path = Path(message["runDir"]) / role / message["generation"] / "sources.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    def remember(path, raw):
        with manifest_lock:
            manifest[str(path.relative_to(workspace))] = hashlib.sha256(raw).hexdigest()
            temporary = manifest_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(manifest, indent=2) + "\n")
            temporary.replace(manifest_path)

    sys.path.insert(0, str(workspace))
    sys.meta_path.insert(0, WorkspaceImports(workspace, remember))
    module = types.ModuleType(role)
    module.__file__ = str(workspace / f"{role}.py")
    module.__rsa_source_sha__ = hashlib.sha256(source.encode("utf-8")).hexdigest()
    module.__rsa_source_bytes__ = source.encode("utf-8")
    sys.modules[role] = module
    remember(Path(module.__file__), module.__rsa_source_bytes__)
    exec(compile(source, module.__file__, "exec"), module.__dict__)
    instance = getattr(module, class_name)()
    for name in ("start", method_name, "close"):
        if not callable(getattr(instance, name, None)):
            raise TypeError(f"{class_name} must implement {name}()")
    method = getattr(instance, method_name)
    if not getattr(method, "__rsa_capability__", False):
        raise TypeError(f"{class_name}.{method_name} must use @capability")
    if recorded and not getattr(method, "__rsa_recorded__", False):
        raise TypeError(f"{class_name}.{method_name} must use @capability and @record")
    if method.__rsa_identity__["id"] != f"python/{role}.py:{class_name}.{method_name}":
        raise TypeError(f"The entry method must be defined as {role}.py:{class_name}.{method_name}")
    if inspect.iscoroutinefunction(method):
        raise TypeError(f"{class_name}.{method_name} must be synchronous; use def, not async def")
    return instance


def run_continuously(method, hz, context, stopped, send, *, role, halt_on_error=False, video_metrics=None):
    """Run serial steps without overlap or catch-up, retaining bounded diagnostics."""
    previous_status = None
    purpose = f"continuous-{role}"
    trace = {**context["trace"], "recordingPurpose": purpose}
    recording = RecordingWindow(send, trace, context["generation"], hz, role=role)

    def record_event(event_type, data, trace, origin, channel):
        send({"event": "recording", "type": event_type, "data": data,
              "trace": trace, "origin": origin, "channel": channel})

    context = {**context, "trace": trace, "recording_purpose": purpose,
               "recording_window": recording, "recording_observer": recording.observe,
               "recording_sink": record_event}
    reason = "stopped"
    try:
        while not stopped.is_set():
            started = time.monotonic()
            trace = {**context["trace"], "spanId": uuid.uuid4().hex[:16]}
            if context["trace"].get("spanId"):
                trace["parentSpanId"] = context["trace"]["spanId"]
            try:
                with scope({**context, "trace": trace}):
                    method()  # @record owns persistence; ordinary returns stay local.
                status = ("ready", None)
            except Exception as error:
                state = "unimplemented" if isinstance(error, NotImplementedError) else "error"
                status = (state, f"{type(error).__name__}: {error}")
            if previous_status != status:
                send({"event": "status", "state": status[0], "error": status[1],
                      "transient": not halt_on_error})
            previous_status = status
            recording.sampled((time.monotonic() - started) * 1000, status[0] == "ready")
            recording.flush(video=video_metrics() if video_metrics else None)
            if halt_on_error and status[0] != "ready":
                reason = "failed"
                break
            stopped.wait(max(0, 1 / hz - (time.monotonic() - started)))
    finally:
        recording.flush(reason=reason, video=video_metrics() if video_metrics else None)
