"""Fixed-window summaries for the resident sampler; never a call buffer."""

from datetime import datetime, timezone
import time
import uuid


def _now():
    return datetime.now(timezone.utc).isoformat()


def _duration():
    return {"total": 0.0, "min": None, "max": None}


def _add_duration(summary, elapsed):
    summary["total"] += elapsed
    summary["min"] = elapsed if summary["min"] is None else min(summary["min"], elapsed)
    summary["max"] = elapsed if summary["max"] is None else max(summary["max"], elapsed)


class RecordingWindow:
    """Observe execution locally, recording only aggregates and fault intervals.

    A fault closes after an entire window without that error category. Successful
    attempts within an open fault are counted normally, not reported as failures.
    Only the sampler thread uses this object.
    """

    def __init__(self, send, trace, generation, sample_hz, *, clock=time.monotonic, interval=5, role="perception"):
        self.send = send
        self.role = role
        self.trace = trace
        self.generation = generation
        self.sample_hz = sample_hz
        self.clock = clock
        self.interval = interval
        self.faults = {}
        self.window = 0
        self._reset()

    def _reset(self):
        self.started = self.clock()
        self.started_at = _now()
        self.sample = {"attempted": 0, "completed": 0, "failed": 0, "recorded": 0,
                       "durationMs": _duration()}
        self.capabilities = {}

    def event(self, event_type, data, trace=None):
        self.send({"event": "recording", "type": event_type,
                   "data": {"schemaVersion": 1, "generation": self.generation, **data},
                   "trace": self.trace if trace is None else trace})

    def observe(self, context, event_type, data, origin):
        key = (data["id"], data["codeSHA"])
        summary = self.capabilities.setdefault(key, {
            "id": key[0], "codeSHA": key[1], "calls": 0, "completed": 0,
            "errors": 0, "durationMs": _duration(),
        })
        if event_type == "python_call_start":
            summary["calls"] += 1
            return
        if event_type != "python_call_end":
            return
        summary["completed"] += 1
        _add_duration(summary["durationMs"], data["durationMs"])
        if data["outcome"] != "error":
            return
        summary["errors"] += 1
        category = data.get("errorType", "Exception")
        fault_key = (*key, category)
        fault = self.faults.get(fault_key)
        if fault is None:
            fault = {"faultId": uuid.uuid4().hex, "capabilityId": key[0], "codeSHA": key[1],
                     "errorType": category, "firstAt": origin["at"], "lastAt": origin["at"],
                     "count": 0, "sampleError": data["error"], "window": self.window}
            self.faults[fault_key] = fault
        fault["count"] += 1
        fault["lastAt"] = origin["at"]
        fault["window"] = self.window
        if fault["count"] == 1:
            self.event(f"{self.role}_fault", self._fault_data(fault), context["trace"])

    @staticmethod
    def _fault_data(fault):
        return {key: value for key, value in fault.items() if key != "window"}

    def sampled(self, duration_ms, succeeded):
        self.sample["attempted"] += 1
        self.sample["completed" if succeeded else "failed"] += 1
        _add_duration(self.sample["durationMs"], duration_ms)

    def recorded(self):
        self.sample["recorded"] += 1

    def flush(self, *, reason=None, video=None):
        ended = self.clock()
        if reason is None and ended - self.started < self.interval:
            return
        ended_at = _now()
        if self.sample["attempted"] or self.capabilities:
            self.event(f"{self.role}_stats", {
                "window": {"startedAt": self.started_at, "endedAt": ended_at,
                           "durationMs": (ended - self.started) * 1000},
                ("stepHz" if self.role == "action" else "sampleHz"): self.sample_hz,
                ("step" if self.role == "action" else "sample"): self.sample,
                "capabilities": list(self.capabilities.values()),
                "faults": [self._fault_data(fault) for fault in self.faults.values()],
                **({"video": video} if video is not None else {}),
                **({"reason": reason} if reason else {}),
            })
        for key, fault in list(self.faults.items()):
            if reason is not None or fault["window"] < self.window:
                self.event(f"{self.role}_fault_end", {
                    **self._fault_data(fault), "endedAt": ended_at,
                    "reason": reason or "recovered",
                })
                del self.faults[key]
        self.window += 1
        self._reset()
