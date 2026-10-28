"""Injected call context and metadata-only logging for workspace Python."""

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import json
import os
import socket
import sys
import time
import traceback
import uuid


class RSAError(RuntimeError):
    """The RSA host rejected a request."""


def request(socket_path, message, timeout=None):
    if not socket_path:
        raise ValueError("RSA_SOCKET or socket_path is required")
    wire = json.dumps(message, allow_nan=False).encode("utf-8") + b"\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(socket_path)
        connection.sendall(wire)
        with connection.makefile("rb") as incoming:
            line = incoming.readline()
            if not line:
                raise ConnectionError("RSA disconnected before replying; the request was not retried")
            reply = json.loads(line)
            if reply["ok"]:
                return reply.get("value")
            raise RSAError(reply["error"])


_active = ContextVar("rsa_call_context", default=None)
_clock_id = "python-" + uuid.uuid4().hex
_sequence = 0
_warned = False
_trial_observer = None


def current():
    active = _active.get()
    if active is not None:
        return active
    return {
        "socket_path": os.environ.get("RSA_SOCKET"),
        "epoch": os.environ.get("BASEWARE_EPOCH"),
        "trace": json.loads(os.environ.get("BASEWARE_TRACE", "{}")),
        "workspace": os.environ.get("RSA_WORKSPACE", os.getcwd()),
        "run_id": os.environ.get("RSA_RUN_ID"),
        "diagnostics": os.environ.get("RSA_LOG_DIAGNOSTICS", "normal"),
        "timeout": None,
    }


@contextmanager
def scope(context):
    token = _active.set(context)
    try:
        yield
    finally:
        _active.reset(token)


def continuous(context):
    return (context.get("recording_purpose") in ("continuous-perception", "continuous-action")
            or context.get("trace", {}).get("recordingPurpose") in ("continuous-perception", "continuous-action"))


def diagnostic_channel(context):
    """Local observers run even when this call has no persistent event."""
    if continuous(context):
        return "diagnostic" if context.get("diagnostics", "normal") == "full" else None
    return "event"


def emit(context, event_type, data):
    """Diagnostics must not change a function's result or retry device actions."""
    global _sequence, _warned
    host_available = context.get("run_id") and context.get("socket_path")
    sink = context.get("event_sink")
    observer = context.get("recording_observer")
    recorder = context.get("recording_sink")
    channel = diagnostic_channel(context)
    if not host_available and sink is None and observer is None and recorder is None and _trial_observer is None:
        return
    _sequence += 1
    origin = {"eventId": f"{_clock_id}:{_sequence}", "clockId": _clock_id,
              "seq": _sequence, "at": datetime.now(timezone.utc).isoformat(),
              "atMs": time.monotonic() * 1000}
    for observer_sink in (sink, observer, _trial_observer):
        if observer_sink is None:
            continue
        try:
            observer_sink(context, event_type, data, origin)
        except Exception as error:
            if not _warned:
                print(f"RSA Python logging unavailable: {error}", file=sys.stderr)
                _warned = True
    if channel is None or not (host_available or recorder):
        return
    try:
        if recorder is not None:
            recorder(event_type, data, context["trace"], origin, channel)
            return
        request(context["socket_path"], {
            "kind": "workspace_event", "argv": [], "runId": context["run_id"],
            "epoch": context["epoch"], "trace": context["trace"],
            "event": {"type": event_type, "data": data, "origin": origin,
                      **({"channel": channel} if channel == "diagnostic" else {})},
        }, timeout=1)
    except Exception as error:
        if not _warned:
            print(f"RSA Python logging unavailable: {error}", file=sys.stderr)
            _warned = True


@contextmanager
def invocation(identity):
    parent = current()
    trace = {**parent["trace"], "traceId": parent["trace"].get("traceId") or uuid.uuid4().hex,
             "spanId": uuid.uuid4().hex[:16]}
    if parent["trace"].get("spanId"):
        trace["parentSpanId"] = parent["trace"]["spanId"]
    if parent["epoch"] is not None:
        trace["epoch"] = parent["epoch"]
    if continuous(parent):
        trace["recordingPurpose"] = parent.get("recording_purpose") or parent["trace"]["recordingPurpose"]
    context = {**parent, "trace": trace}
    data = {**identity, "pid": os.getpid()}
    with scope(context):
        emit(context, "python_call_start", data)
        started = time.monotonic()
        try:
            yield
        except BaseException as error:
            emit(context, "python_call_end", {**data, "outcome": "error",
                 "durationMs": (time.monotonic() - started) * 1000,
                 "errorType": type(error).__name__, "error": f"{type(error).__name__}: {error}",
                 **({"traceback": traceback.format_exc()} if context.get("diagnostics") == "full" else {})})
            raise
        else:
            emit(context, "python_call_end", {**data, "outcome": "success",
                 "durationMs": (time.monotonic() - started) * 1000})
