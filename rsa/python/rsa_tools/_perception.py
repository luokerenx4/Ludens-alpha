"""Persistent workspace perception runner. The workspace owns all sensing."""

import importlib.abc
import importlib.machinery
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import sys
import threading
import traceback
import types

from rsa_tools._context import current, scope


class WorkspaceSourceLoader(importlib.machinery.SourceFileLoader):
    """Reload local edits reliably without disabling third-party bytecode caches."""

    def __init__(self, fullname, path, remember):
        super().__init__(fullname, path)
        self.remember = remember

    def get_code(self, fullname):
        raw = self.get_data(self.path)
        self.remember(Path(self.path), raw)
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
        return None


def main():
    # Keep the protocol on its own descriptor; user/native prints go to stderr.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    messages = queue.Queue()

    def read_requests():
        for line in sys.stdin:
            try:
                messages.put(json.loads(line))
            except json.JSONDecodeError as error:
                print(f"Invalid perception request: {error}", file=sys.stderr)
        # EOF also ends a process whose observe is currently running.
        os.kill(os.getpid(), signal.SIGTERM)

    def terminate(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    threading.Thread(target=read_requests, daemon=True).start()
    instance = None
    try:
        while True:
            message = messages.get()
            reply = {"id": message["id"]}
            try:
                action = message["action"]
                context = {**current(), "epoch": None, "trace": message.get("trace", {})}
                context["trace"].pop("epoch", None)
                with scope(context):
                    if action == "start":
                        workspace = Path(message["workspace"]).resolve()
                        manifest = {}
                        manifest_lock = threading.Lock()
                        manifest_path = Path(message["runDir"]) / "perception" / message["generation"] / "sources.json"

                        def remember(path, raw):
                            with manifest_lock:
                                manifest[str(path.relative_to(workspace))] = hashlib.sha256(raw).hexdigest()
                                temporary = manifest_path.with_suffix(".tmp")
                                temporary.write_text(json.dumps(manifest, indent=2) + "\n")
                                temporary.replace(manifest_path)

                        sys.path.insert(0, str(workspace))
                        sys.meta_path.insert(0, WorkspaceImports(workspace, remember))
                        module = types.ModuleType("perception")
                        module.__file__ = str(workspace / "perception.py")
                        sys.modules["perception"] = module
                        remember(Path(module.__file__), message["source"].encode("utf-8"))
                        exec(compile(message["source"], module.__file__, "exec"), module.__dict__)
                        instance = module.Perception()
                        for method in ("start", "observe", "close"):
                            if not callable(getattr(instance, method, None)):
                                raise TypeError(f"Perception must implement {method}()")
                        instance.start({
                            "workspace": str(workspace),
                            "runDir": message["runDir"],
                            "generation": message["generation"],
                        })
                        result = {"pid": os.getpid()}
                    elif action == "observe":
                        result = instance.observe()
                    else:
                        raise ValueError(f"Unknown perception action: {action}")
                encoded = json.dumps({**reply, "ok": True, "result": result}, allow_nan=False)
            except Exception as error:
                encoded = json.dumps({**reply, "ok": False, "error": {
                    "type": type(error).__name__, "message": str(error),
                    "traceback": traceback.format_exc(),
                }})
            protocol.write(encoded + "\n")
    finally:
        if instance is not None:
            try:
                instance.close()
            except Exception:
                traceback.print_exc(file=sys.stderr)
        protocol.close()


if __name__ == "__main__":
    main()
