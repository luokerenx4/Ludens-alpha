"""Workspace capabilities: mark ordinary typed Python functions for RSA."""

from functools import wraps
import hashlib
import inspect
import os
from pathlib import Path

from .client import Client, RSAError
from ._context import invocation


def capability(function=None, *, hook=None):
    """Register a capability; hook="observe" also supplies the loop's observation."""
    if hook not in (None, "observe"):
        raise ValueError('The only supported capability hook is "observe"')

    def mark(target):
        source = Path(target.__code__.co_filename).resolve()
        workspace = Path(os.environ.get("RSA_WORKSPACE", os.getcwd())).resolve()
        path = os.path.relpath(source, workspace)
        # Capture the registered version once: editing a file doesn't reload a
        # live Python module. The CLI loader supplies the hash it compiled.
        code_sha = target.__globals__.get("__rsa_source_sha__")
        if code_sha is None and source.is_file():
            code_sha = hashlib.sha256(source.read_bytes()).hexdigest()
        identity = {"id": f"python/{path}:{target.__name__}", "codeSHA": code_sha,
                    "origin": {"path": path, "function": target.__name__, "line": target.__code__.co_firstlineno}}

        if inspect.iscoroutinefunction(target):
            @wraps(target)
            async def wrapped(*args, **kwargs):
                with invocation(identity):
                    return await target(*args, **kwargs)
        else:
            @wraps(target)
            def wrapped(*args, **kwargs):
                with invocation(identity):
                    return target(*args, **kwargs)

        wrapped.__rsa_capability__ = True
        wrapped.__rsa_hook__ = hook
        return wrapped

    return mark if function is None else mark(function)


__all__ = ["Client", "RSAError", "capability"]
