"""Resident workspace sampler and the workspace timeline's single writer."""

import json
import os
from pathlib import Path
import queue
import signal
import sys
import threading
import traceback

from rsa_tools._context import current, scope
from rsa_tools._observation_history import ObservationHistory, observation_result
from rsa_tools._sampling import DEFAULT_SAMPLE_HZ, validate_sample_hz
from rsa_tools._resident import load_instance, run_continuously


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
        send({"event": "sample", "snapshot": {
            key: value for key, value in record.items() if key not in ("text", "media", "data", "space", "sources")
        }, "mediaCount": len(record["media"]), "trace": trace or {},
              "mediaReferences": [{"sha256": item["sha256"], "bytes": item["bytes"],
                                   "mediaType": item["mediaType"], **item["timeline"],
                                   "approximate": True} for item in record["media"] if "sha256" in item]})
        return observation_result(record)

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
                        with scope(context):
                            instance = load_instance(message, "perception", "Perception", "sample", recorded=True)
                            sample_hz = validate_sample_hz(getattr(instance, "sample_hz", DEFAULT_SAMPLE_HZ))
                            history.sample_hz = sample_hz
                            instance.start({"workspace": str(workspace), "runDir": message["runDir"],
                                            "generation": message["generation"]})
                        result["sampleHz"] = sample_hz
                        sampler = threading.Thread(target=run_continuously,
                            args=(instance.sample, sample_hz, context, stopped, send),
                            kwargs={"role": "perception", "video_metrics": lambda: history._video.metrics() if history._video else None},
                            daemon=True)
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
