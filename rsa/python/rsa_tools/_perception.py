"""Persistent workspace perception runner. The workspace owns all sensing."""

import importlib.abc
import importlib.machinery
import hashlib
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import queue
import signal
import sys
import threading
import time
import traceback
import types
import uuid

from rsa_tools._context import current, scope
from rsa_tools._observation_history import ObservationHistory


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
    protocol_lock = threading.Lock()
    stopped = threading.Event()

    def send(value):
        encoded = json.dumps(value, allow_nan=False)
        with protocol_lock:
            protocol.write(encoded + "\n")

    def sample_continuously(instance, history, generation, sample_hz, context):
        previous_status = None
        interval = 1 / sample_hz
        while not stopped.is_set():
            started = time.monotonic()
            trace = {**context["trace"], "spanId": uuid.uuid4().hex[:16]}
            if context["trace"].get("spanId"):
                trace["parentSpanId"] = context["trace"]["spanId"]
            try:
                with scope({**context, "trace": trace}):
                    sample = instance.sample()
                    finished = time.monotonic()
                    recorded_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                    record = history.append(sample, generation, {
                        "clock": "perception:" + generation,
                        "startedAtMs": started * 1000, "finishedAtMs": finished * 1000,
                    }, recorded_at)
                status = ("ready", None)
                if previous_status != status:
                    send({"event": "status", "state": "ready"})
                send({"event": "sample", "snapshot": {
                    key: value for key, value in record.items() if key not in ("text", "media")
                }, "mediaCount": len(record["media"]), "trace": trace})
            except Exception as error:
                state = "unimplemented" if isinstance(error, NotImplementedError) else "error"
                status = (state, f"{type(error).__name__}: {error}")
                if previous_status != status:
                    send({"event": "status", "state": state, "error": status[1]})
                    traceback.print_exc(file=sys.stderr)
            previous_status = status
            # Long samples slow the cadence; never overlap or replay missed ticks.
            stopped.wait(max(0, interval - (time.monotonic() - started)))

    def read_requests():
        for line in sys.stdin:
            try:
                messages.put(json.loads(line))
            except json.JSONDecodeError as error:
                print(f"Invalid perception request: {error}", file=sys.stderr)
        # EOF also ends a process whose sample is currently running.
        os.kill(os.getpid(), signal.SIGTERM)

    def terminate(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    threading.Thread(target=read_requests, daemon=True).start()
    instance = None
    sampler = None
    history = None
    try:
        while True:
            message = messages.get()
            reply = {"id": message["id"]}
            try:
                action = message["action"]
                context = {**current(), "epoch": None, "trace": dict(message.get("trace", {}))}
                context["trace"].pop("epoch", None)
                with scope(context):
                    if action == "start":
                        if sampler is not None:
                            raise ValueError("Perception has already started")
                        workspace = Path(message["workspace"]).resolve()
                        manifest = {}
                        manifest_lock = threading.Lock()
                        manifest_path = Path(message["runDir"]) / "perception" / message["generation"] / "sources.json"
                        manifest_path.parent.mkdir(parents=True, exist_ok=True)

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
                        for method in ("start", "sample", "close"):
                            if not callable(getattr(instance, method, None)):
                                raise TypeError(f"Perception must implement {method}()")
                        sample_hz = getattr(instance, "sample_hz", 2.0)
                        if (isinstance(sample_hz, bool) or not isinstance(sample_hz, (int, float))
                                or not math.isfinite(sample_hz) or sample_hz <= 0):
                            raise ValueError("Perception.sample_hz must be a positive finite number")
                        instance.start({
                            "workspace": str(workspace),
                            "runDir": message["runDir"],
                            "generation": message["generation"],
                        })
                        history = ObservationHistory(message["runDir"])
                        sampler = threading.Thread(target=sample_continuously, args=(
                            instance, history, message["generation"], sample_hz, context,
                        ), daemon=True)
                        send({**reply, "ok": True, "result": {"pid": os.getpid(), "sampleHz": sample_hz}})
                        sampler.start()
                        continue
                    elif action == "observe":
                        if history is None:
                            raise ValueError("Perception has not started")
                        result = history.observe(message.get("query"))
                    else:
                        raise ValueError(f"Unknown perception action: {action}")
                response = {**reply, "ok": True, "result": result}
            except Exception as error:
                response = {**reply, "ok": False, "error": {
                    "type": type(error).__name__, "message": str(error),
                    "traceback": traceback.format_exc(),
                }}
            send(response)
    finally:
        stopped.set()
        if sampler is not None and sampler.is_alive():
            # close() cannot race sample(). The host can kill a stuck worker.
            sampler.join()
        if instance is not None:
            try:
                instance.close()
            except Exception:
                traceback.print_exc(file=sys.stderr)
        protocol.close()


if __name__ == "__main__":
    main()
