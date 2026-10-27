"""Capability declarations and optional recording at the actual Python call."""

from functools import wraps
import hashlib
import inspect
import os
from pathlib import Path
import time
import uuid

from ._context import current, invocation, request
from ._observation_history import validate_sample


_clock = "python-capability-" + uuid.uuid4().hex


def _mark(target, kind):
    flags = getattr(target, "__rsa_declaration__", None)
    if flags is None:
        source = Path(target.__code__.co_filename).resolve()
        workspace = Path(current()["workspace"]).resolve()
        path = os.path.relpath(source, workspace)
        # This is the loaded version, not whatever may be edited later on disk.
        code_sha = target.__globals__.get("__rsa_source_sha__")
        if code_sha is None and source.is_file():
            code_sha = hashlib.sha256(source.read_bytes()).hexdigest()
        identity = {"id": f"python/{path}:{target.__qualname__}", "codeSHA": code_sha,
                    "origin": {"path": path, "function": target.__qualname__, "line": target.__code__.co_firstlineno}}
        flags = {"capability": False, "recorded": False}
        original = target

        def finish(result, started):
            finished = time.monotonic()
            context = current()
            if not flags["recorded"]:
                return result
            validate_sample(result, context["workspace"])
            message = {"sample": result, "identity": identity,
                       "sampling": {"clock": _clock, "startedAtMs": started * 1000,
                                    "finishedAtMs": finished * 1000},
                       "generation": context.get("generation"), "runId": context.get("run_id"),
                       "trace": context["trace"]}
            local = context.get("timeline_append")
            result = local(**message) if local is not None else request(
                context["socket_path"], {"kind": "timeline", "argv": [], "action": "append", **message}, context["timeout"])
            recording = context.get("recording_window")
            if recording is not None:
                recording.recorded()
            return result

        def check():
            if flags["recorded"] and not flags["capability"]:
                raise ValueError("@record requires @capability on the same function")

        if inspect.iscoroutinefunction(target):
            @wraps(target)
            async def wrapped(*args, **kwargs):
                check()
                with invocation(identity):
                    started = time.monotonic()
                    return finish(await original(*args, **kwargs), started)
        else:
            @wraps(target)
            def wrapped(*args, **kwargs):
                check()
                with invocation(identity):
                    started = time.monotonic()
                    return finish(original(*args, **kwargs), started)
        wrapped.__rsa_declaration__ = flags
        wrapped.__rsa_identity__ = identity
        target = wrapped
    flags[kind] = True
    target.__rsa_capability__ = flags["capability"]
    target.__rsa_recorded__ = flags["recorded"]
    return target


def capability(function=None):
    """Expose an ordinary function through the workspace capability catalog."""
    return (lambda target: _mark(target, "capability")) if function is None else _mark(function, "capability")


def record(function=None):
    """Record each successful @capability result envelope on the workspace timeline."""
    return (lambda target: _mark(target, "recorded")) if function is None else _mark(function, "recorded")
