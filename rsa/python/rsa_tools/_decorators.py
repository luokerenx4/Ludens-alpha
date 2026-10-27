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


_clock = "python-perception-" + uuid.uuid4().hex


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
        flags = {"capability": False, "perception": False, "recorded": False}
        original = target

        def finish(result, started):
            finished = time.monotonic()
            context = current()
            if flags["perception"]:
                validate_sample(result, context["workspace"])
            if not flags["recorded"]:
                return result
            message = {"sample": result, "identity": identity,
                       "sampling": {"clock": _clock, "startedAtMs": started * 1000,
                                    "finishedAtMs": finished * 1000},
                       "generation": context.get("generation"), "runId": context.get("run_id"),
                       "trace": context["trace"]}
            local = context.get("timeline_append")
            if local is not None:
                return local(**message)
            return request(context["socket_path"], {"kind": "timeline", "argv": [], "action": "append", **message}, context["timeout"])

        def check():
            if flags["recorded"] and not flags["perception"]:
                raise ValueError("@record requires @perception on the same function")

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
    if kind == "perception":
        flags["capability"] = True
    target.__rsa_capability__ = flags["capability"]
    target.__rsa_perception__ = flags["perception"]
    target.__rsa_recorded__ = flags["recorded"]
    return target


def capability(function=None):
    """Expose an ordinary function through the workspace capability catalog."""
    return (lambda target: _mark(target, "capability")) if function is None else _mark(function, "capability")


def perception(function=None):
    """Declare a sensing capability returning text, JSON data and/or media."""
    return (lambda target: _mark(target, "perception")) if function is None else _mark(function, "perception")


def record(function=None):
    """Record each successful @perception result on the workspace timeline."""
    return (lambda target: _mark(target, "recorded")) if function is None else _mark(function, "recorded")
