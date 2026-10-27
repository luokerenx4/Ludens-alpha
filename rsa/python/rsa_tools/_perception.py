"""Resident workspace sampler and the workspace timeline's single writer."""

import importlib.abc
import importlib.machinery
import hashlib
import inspect
import json
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
from rsa_tools._observation_history import ObservationHistory, MAIN_CAPABILITY, observation_result
from rsa_tools._sampling import DEFAULT_SAMPLE_HZ, validate_sample_hz
from rsa_tools._recording import RecordingWindow


class WorkspaceSourceLoader(importlib.machinery.SourceFileLoader):
    """Reload local edits reliably without disabling third-party bytecode caches."""

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
        return None


def main():
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    messages = queue.Queue()
    protocol_lock = threading.Lock()
    stopped = threading.Event()
    instance = sampler = history = None

    def send(value):
        encoded = json.dumps(value, allow_nan=False)
        with protocol_lock:
            protocol.write(encoded + "\n")

    def append(*, sample, identity, sampling, generation=None, runId=None, trace=None):
        if history is None:
            raise ValueError("Workspace timeline has not started")
        record = history.append(sample, generation, sampling, identity=identity, run_id=runId, trace=trace)
        recording = current().get("recording_window")
        if recording is not None:
            recording.recorded()
        send({"event": "sample", "snapshot": {
            key: value for key, value in record.items() if key not in ("text", "media", "data", "space", "sources")
        }, "mediaCount": len(record["media"]), "trace": trace or {},
              "mediaReferences": [{"sha256": item["sha256"], "bytes": item["bytes"],
                                   "mediaType": item["mediaType"], **item["timeline"],
                                   "approximate": True} for item in record["media"] if "sha256" in item]})
        return observation_result(record)

    def sample_continuously(instance, sample_hz, context):
        previous_status = None
        interval = 1 / sample_hz
        trace = {**context["trace"], "recordingPurpose": "continuous-perception"}
        recording = RecordingWindow(send, trace, context["generation"], sample_hz)

        def record_event(event_type, data, trace, origin, channel):
            send({"event": "recording", "type": event_type, "data": data,
                  "trace": trace, "origin": origin, "channel": channel})

        context = {**context, "trace": trace, "recording_purpose": "continuous-perception",
                   "recording_window": recording, "recording_observer": recording.observe,
                   "recording_sink": record_event}

        def video_metrics():
            return history._video.metrics() if history._video is not None else None

        try:
            while not stopped.is_set():
                started = time.monotonic()
                trace = {**context["trace"], "spanId": uuid.uuid4().hex[:16]}
                if context["trace"].get("spanId"):
                    trace["parentSpanId"] = context["trace"]["spanId"]
                try:
                    with scope({**context, "trace": trace, "timeline_append": append}):
                        instance.sample()  # @record owns persistence; never append twice.
                    status = ("ready", None)
                except Exception as error:
                    state = "unimplemented" if isinstance(error, NotImplementedError) else "error"
                    status = (state, f"{type(error).__name__}: {error}")
                # Health changes immediately; durable faults use whole windows.
                if previous_status != status:
                    send({"event": "status", "state": status[0], "error": status[1], "transient": True})
                previous_status = status
                recording.sampled((time.monotonic() - started) * 1000, status[0] == "ready")
                recording.flush(video=video_metrics())
                stopped.wait(max(0, interval - (time.monotonic() - started)))
        finally:
            recording.flush(reason="stopped", video=video_metrics())

    def read_requests():
        for line in sys.stdin:
            try:
                messages.put(json.loads(line))
            except json.JSONDecodeError as error:
                print(f"Invalid perception request: {error}", file=sys.stderr)
        os.kill(os.getpid(), signal.SIGTERM)

    def terminate(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    threading.Thread(target=read_requests, daemon=True).start()
    try:
        while True:
            try:
                message = messages.get(timeout=1)
            except queue.Empty:
                if history is not None:
                    history.prune()
                continue
            reply = {"id": message["id"]}
            try:
                action = message["action"]
                if action == "start":
                    if history is not None:
                        raise ValueError("Workspace timeline has already started")
                    workspace = Path(message["workspace"]).resolve()
                    # The writer survives missing or broken user sensing code.
                    history = ObservationHistory(workspace)
                    context = {**current(), "workspace": str(workspace), "run_id": Path(message["runDir"]).name,
                               "epoch": None, "generation": message["generation"], "trace": dict(message.get("trace", {})),
                               "diagnostics": message.get("diagnostics", os.environ.get("RSA_LOG_DIAGNOSTICS", "normal")),
                               "timeline_append": append}
                    if context["diagnostics"] not in ("normal", "full"):
                        raise ValueError("diagnostics must be normal or full")
                    context["trace"].pop("epoch", None)
                    result = {"pid": os.getpid(), "history": history.policy(), "state": "loading",
                              "diagnostics": context["diagnostics"]}
                    try:
                        source = message.get("source")
                        if message.get("sourceError"):
                            raise RuntimeError(message["sourceError"])
                        if source is None:
                            raise NotImplementedError("Implement workspace/perception.py:Perception, then reload it.")
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
                        module.__rsa_source_sha__ = hashlib.sha256(source.encode("utf-8")).hexdigest()
                        module.__rsa_source_bytes__ = source.encode("utf-8")
                        sys.modules["perception"] = module
                        remember(Path(module.__file__), module.__rsa_source_bytes__)
                        with scope(context):
                            exec(compile(source, module.__file__, "exec"), module.__dict__)
                            instance = module.Perception()
                            for method in ("start", "sample", "close"):
                                if not callable(getattr(instance, method, None)):
                                    raise TypeError(f"Perception must implement {method}()")
                            if not getattr(instance.sample, "__rsa_perception__", False) or not getattr(instance.sample, "__rsa_recorded__", False):
                                raise TypeError("Perception.sample must use @perception and @record; unmarked functions are not archived")
                            if instance.sample.__rsa_identity__["id"] != MAIN_CAPABILITY:
                                raise TypeError("The main sample must be defined as perception.py:Perception.sample")
                            if inspect.iscoroutinefunction(instance.sample):
                                raise TypeError("Perception.sample must be synchronous; use def sample(), not async def")
                            sample_hz = validate_sample_hz(getattr(instance, "sample_hz", DEFAULT_SAMPLE_HZ))
                            history.sample_hz = sample_hz
                            instance.start({"workspace": str(workspace), "runDir": message["runDir"],
                                            "generation": message["generation"]})
                        result["sampleHz"] = sample_hz
                        sampler = threading.Thread(target=sample_continuously, args=(instance, sample_hz, context), daemon=True)
                    except Exception as error:
                        result.update(state="unimplemented" if isinstance(error, NotImplementedError) else "error",
                                      error=f"{type(error).__name__}: {error}")
                        traceback.print_exc(file=sys.stderr)
                    send({**reply, "ok": True, "result": result})
                    if sampler is not None:
                        sampler.start()
                    continue
                if history is None:
                    raise ValueError("Workspace timeline has not started")
                if action == "observe":
                    result = history.observe(message.get("query"))
                elif action == "append":
                    result = append(**{key: message.get(key) for key in ("sample", "identity", "sampling", "generation", "runId", "trace")})
                elif action == "derive":
                    result = history.derive(message.get("source"), message.get("data"),
                                            message.get("mediaType"), message.get("transform"))
                else:
                    raise ValueError(f"Unknown perception action: {action}")
                response = {**reply, "ok": True, "result": result}
            except Exception as error:
                response = {**reply, "ok": False, "error": {
                    "type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}}
            send(response)
    finally:
        stopped.set()
        if sampler is not None and sampler.is_alive():
            sampler.join()
        if instance is not None:
            try:
                instance.close()
            except Exception:
                traceback.print_exc(file=sys.stderr)
        if history is not None:
            history.close()
        protocol.close()


if __name__ == "__main__":
    main()
