"""Resident workspace action program, bound to one host-authorized generation."""

import json
import os
from pathlib import Path
import queue
import signal
import sys
import threading
import traceback

from ._context import current, scope
from ._resident import load_instance, run_continuously
from ._sampling import DEFAULT_SAMPLE_HZ, validate_sample_hz


def main():
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    messages = queue.Queue()
    protocol_lock = threading.Lock()
    stopped = threading.Event()
    instance = runner = context = None
    started = False

    def send(value):
        encoded = json.dumps(value, allow_nan=False)
        with protocol_lock:
            protocol.write(encoded + "\n")

    def read_requests():
        for line in sys.stdin:
            try:
                messages.put(json.loads(line))
            except json.JSONDecodeError as error:
                print(f"Invalid action request: {error}", file=sys.stderr)
        os.kill(os.getpid(), signal.SIGTERM)

    def terminate(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    threading.Thread(target=read_requests, daemon=True).start()
    try:
        while True:
            message = messages.get()
            reply = {"id": message["id"]}
            try:
                if message["action"] != "start":
                    raise ValueError(f"Unknown action request: {message['action']}")
                if started:
                    raise ValueError("Action generation has already started; reload through the host")
                started = True
                workspace = Path(message["workspace"]).resolve()
                epoch = message.get("epoch")
                trace = dict(message.get("trace", {}))
                if not isinstance(epoch, str) or not epoch or not trace.get("inputGeneration"):
                    raise ValueError("Action requires its host-authorized epoch and inputGeneration")
                trace.update(epoch=epoch, recordingPurpose="continuous-action")
                context = {**current(), "workspace": str(workspace), "run_id": Path(message["runDir"]).name,
                           "epoch": epoch, "generation": message["generation"], "trace": trace,
                           "recording_purpose": "continuous-action",
                           "diagnostics": message.get("diagnostics", os.environ.get("RSA_LOG_DIAGNOSTICS", "normal"))}
                if context["diagnostics"] not in ("normal", "full"):
                    raise ValueError("diagnostics must be normal or full")
                result = {"pid": os.getpid(), "state": "loading", "diagnostics": context["diagnostics"]}
                try:
                    with scope(context):
                        instance = load_instance(message, "action", "Action", "step")
                        step_hz = validate_sample_hz(getattr(instance, "step_hz", DEFAULT_SAMPLE_HZ), "step_hz")
                        instance.start({"workspace": str(workspace), "runDir": message["runDir"],
                                        "generation": message["generation"], "epoch": epoch})
                    result["stepHz"] = step_hz
                    runner = threading.Thread(target=run_continuously,
                        args=(instance.step, step_hz, context, stopped, send),
                        kwargs={"role": "action", "halt_on_error": True}, daemon=True)
                except Exception as error:
                    result.update(state="unimplemented" if isinstance(error, NotImplementedError) else "error",
                                  error=f"{type(error).__name__}: {error}")
                    traceback.print_exc(file=sys.stderr)
                send({**reply, "ok": True, "result": result})
                if runner is not None:
                    runner.start()
            except Exception as error:
                send({**reply, "ok": False, "error": {
                    "type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}})
    finally:
        stopped.set()
        if runner is not None and runner.is_alive():
            runner.join()
        if instance is not None:
            try:
                with scope(context):
                    instance.close()
            except Exception:
                traceback.print_exc(file=sys.stderr)
        protocol.close()


if __name__ == "__main__":
    main()
