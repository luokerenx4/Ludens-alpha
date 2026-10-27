#!/usr/bin/env python3
"""Summarize saved RSA events only; never contacts a model or device."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from functools import lru_cache
import json
import math
from pathlib import Path
import re
import statistics
import subprocess
import tempfile


def stats(values):
    values = sorted(value for value in values if value is not None)
    if not values:
        return {"count": 0, "min": None, "median": None, "p95": None, "max": None, "sum": 0}
    return {"count": len(values), "min": round(values[0], 3),
            "median": round(statistics.median(values), 3), "p95": round(values[math.ceil(len(values) * .95) - 1], 3),
            "max": round(values[-1], 3),
            "sum": round(sum(values), 3)}


def ratio(numerator, denominator):
    return round(numerator / denominator, 6) if denominator else None


def weighted_cache(calls):
    known = [call for call in calls if call["inputTokens"] is not None]
    return ratio(sum(call["cachedTokens"] for call in known), sum(call["inputTokens"] for call in known))


def read_events(run, epoch):
    """Stream canonical facts; retain only the selected epoch needed by this report."""
    manifest_path = run / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    multiple_sources = bool(manifest.get("eventSources"))
    source = {"path": "canonical" if multiple_sources else "events.jsonl", "eventCount": 0,
              "lastSeq": None, "lastEventAt": None, "ignoredPartialLastLine": False}
    controls, events = [], []
    selected = epoch

    def consume(lines):
        nonlocal selected, events
        for line in lines:
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                if not line.endswith("\n"):
                    source["ignoredPartialLastLine"] = True
                    continue
                raise
            source.update(eventCount=source["eventCount"] + 1,
                          lastSeq=event.get("seq"), lastEventAt=event.get("at"))
            if multiple_sources:
                source["lastEventId"] = event_identity(event)
            if event["type"] == "control" and event["data"].get("mode") in ("auto", "manual"):
                controls.append(event)
                if selected is None and event["data"].get("mode") == "auto":
                    selected = event["data"]["epoch"]
                    events = [previous for previous in events if previous.get("trace", {}).get("epoch") == selected]
            if selected is None or event.get("trace", {}).get("epoch") == selected:
                events.append(event)

    if multiple_sources:
        command = [str(Path(__file__).resolve().parents[1] / "bin" / "rsa"), "logs", "events", "--run", str(run)]
        # stderr is bounded on disk; pipe backpressure keeps the producer bounded.
        with tempfile.TemporaryFile(mode="w+") as errors:
            with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, text=True) as process:
                try:
                    consume(process.stdout)
                except BaseException:
                    process.terminate()
                    raise
                if process.wait() != 0:
                    errors.seek(0)
                    raise ValueError("Canonical event reader failed: " + errors.read(4000))
    else:
        with (run / "events.jsonl").open() as incoming:
            consume(incoming)
    source["retainedEpochEvents"] = len(events)
    return events, controls, source


def skill_paths(args):
    if not isinstance(args, dict):
        raise ValueError("Tool arguments are not a JSON object")
    return sorted(set(re.findall(r"(?:^|[\s\[/])(skills/[^\s#\]\"']+?SKILL\.md)",
                                str(args.get("path", "")) + "\n" + str(args.get("input", "")))))


def archived_skill_paths(run):
    # Reuse the shared archive reader; retain only small extracted evidence, never
    # decoded tool bodies. This CLI dispatch does not initialize a host/workspace.
    @lru_cache(maxsize=64)
    def read(reference):
        try:
            result = subprocess.run([str(Path(__file__).resolve().parents[1] / "bin" / "rsa"),
                "logs", "read", "--run", str(run), "--ref", reference],
                capture_output=True, text=True, check=True, timeout=30)
            return skill_paths(json.loads(result.stdout)), None
        except subprocess.CalledProcessError as error:
            return None, (error.stderr.strip() or f"Archive reader exited {error.returncode}")[:1000]
        except (OSError, subprocess.TimeoutExpired, ValueError) as error:
            return None, str(error)[:1000]
    return read


def wire_bytes(body):
    # Indexed ref.bytes measures decoded JSON structure, not the prepared body.
    return body.get("wire", {}).get("bytes") if body.get("encoding") == "rsa-json-v1" else body.get("bytes")


def trace_key(event, *fields):
    trace = event.get("trace", {})
    return tuple(trace.get(field) for field in ("epoch", *fields))


def source_key(event):
    return event.get("serviceId") or event.get("origin", {}).get("clockId") or "legacy-host"


def event_identity(event):
    return event.get("origin", {}).get("eventId") or f"{source_key(event)}:{event['seq']}"


def operation_key(event, *fields):
    return (source_key(event), *trace_key(event, *fields))


def compaction_trace(event):
    return {key: value for key, value in event.get("trace", {}).items()
            if key in ("epoch", "traceId", "spanId", "parentSpanId", "operationId")
            and isinstance(value, str)}


def operation_spans(inside, events, start_type, end_type):
    """Use explicit span identities, including late cleanup; never pair by function name or order."""
    finishes = {operation_key(event, "traceId", "spanId"): event for event in events
                if event["type"] == end_type and event.get("trace", {}).get("spanId")}
    spans = []
    for start in inside:
        if start["type"] != start_type or not start.get("trace", {}).get("spanId"):
            continue
        finish = finishes.get(operation_key(start, "traceId", "spanId"))
        result = finish["data"] if finish else {}
        spans.append({"trace": start["trace"], "source": start.get("source"),
                      "startSeq": start["seq"], "endSeq": finish["seq"] if finish else None,
                      "startEventId": event_identity(start), "endEventId": event_identity(finish) if finish else None,
                      "operation": start["data"].get("operation", start["data"].get("action")),
                      "name": start["data"].get("name", start["data"].get("id", start["data"].get("capabilityId"))),
                      "codeSHA": start["data"].get("codeSHA"),
                      "outcome": result.get("outcome", "unknown") if finish else "pending",
                      "durationMs": result.get("durationMs"), "error": result.get("error")})
        if start_type == "python_call_start":
            spans[-1].update({"functionOrigin": start["data"].get("origin"),
                              "pid": start["data"].get("pid"),
                              "origin": start.get("origin"),
                              "endOrigin": finish.get("origin") if finish else None})
    return spans


def span_summary(spans):
    return {"started": len(spans), "outcomes": dict(Counter(span["outcome"] for span in spans)),
            "durationMs": stats(span["durationMs"] for span in spans)}


def local_python_exceptions(calls, events):
    """A decorated function raising is not an execution failure or a known expected exception."""
    def key(trace, parent=False):
        span = trace.get("parentSpanId" if parent else "spanId")
        return (trace.get("epoch"), trace["traceId"], span) if trace.get("traceId") and span else None

    parents, nodes = {}, {}
    for event in events:
        trace = event.get("trace", {})
        if key(trace):
            parents.setdefault(key(trace), key(trace, parent=True))
    for kind, start, end in (("python-local", "python_call_start", "python_call_end"),
                             ("python-execution", "python_capability", "python_capability_result")):
        for span in operation_spans(events, events, start, end):
            if key(span["trace"]):
                nodes[key(span["trace"])] = {"kind": kind, **{field: span[field] for field in
                    ("trace", "name", "startSeq", "endSeq", "outcome")}}

    # A successful asynchronous bash response only submitted the work. Its child
    # background span supplies the eventual execution outcome, including late results.
    backgrounds = defaultdict(list)
    for kind, start_type, end_type in (("tool", "tool_start", "tool_end"),
                                      ("background", "background_start", "background_result")):
        ends = {key(event.get("trace", {})): event for event in events if event["type"] == end_type
                and key(event.get("trace", {}))}
        for event in events:
            trace = event.get("trace", {})
            identity = key(trace)
            if event["type"] != start_type or not identity:
                continue
            end = ends.get(identity)
            data = end["data"] if end else {}
            if not end:
                outcome = "pending"
            elif kind == "tool":
                outcome = {True: "error", False: "success"}.get(data.get("isError"), "unknown")
            else:
                outcome = {"completed": "success", "failed": "error", "cancelled": "cancelled"}.get(
                    data.get("status", data.get("state")), "unknown")
            node = {"kind": kind, "trace": trace, "name": event["data"].get("toolName", event["data"].get("name")),
                    "startSeq": event["seq"], "endSeq": end["seq"] if end else None, "outcome": outcome}
            nodes[identity] = node
            if kind == "background" and key(trace, parent=True):
                backgrounds[key(trace, parent=True)].append(node)

    def effective(node):
        children = backgrounds.get(key(node["trace"]), []) if node["kind"] == "tool" else []
        if len(children) == 1:
            return children[0]
        return {**node, "outcome": "unknown"} if children else node

    def ancestor(trace, execution=False):
        identity, seen = key(trace, parent=True), {key(trace)}
        while identity and identity not in seen:
            seen.add(identity)
            node = nodes.get(identity)
            if node and (not execution or node["kind"] != "python-local"):
                return effective(node)
            identity = parents.get(identity)
        return None

    raised = [call for call in calls if call["outcome"] == "error"]
    grouped = {}
    for call in raised:
        root, seen = call, {key(call["trace"])}
        while True:
            identity = key(root["trace"], parent=True)
            parent = nodes.get(identity)
            if identity in seen or not parent or parent["kind"] != "python-local" or parent["outcome"] != "error":
                break
            seen.add(identity)
            root = parent
        # Untraced raises remain separate; shared PID, text or successful ancestor
        # cannot establish that two branches propagated the same exception.
        identity = key(root["trace"]) or ("untraced", root.get("startEventId", root["startSeq"]))
        if identity not in grouped:
            grouped[identity] = {"root": {field: root[field] for field in ("trace", "name", "startSeq", "endSeq")},
                                 "raisedCalls": [], "ancestor": ancestor(root["trace"]),
                                 "execution": ancestor(root["trace"], execution=True)}
        grouped[identity]["raisedCalls"].append({field: call[field] for field in ("trace", "name", "startSeq", "endSeq")})
    # Insertion follows the reader's display order; seq is local to its source.
    groups = list(grouped.values())

    def outcomes(field):
        counts = Counter(group[field]["outcome"] if group[field] else "unassociated" for group in groups)
        return {outcome: counts[outcome] for outcome in ("success", "error", "cancelled", "pending", "unknown", "unassociated")}

    return {"raised": len(raised), "rootRaised": len(groups), "nestedRaised": len(raised) - len(groups),
            "ancestorOutcomes": outcomes("ancestor"), "executionOutcomes": outcomes("execution"),
            "expected": None}, groups


def input_actions(inside, events):
    """Async input execution has its own lifetime after the play RPC returns."""
    def key(event):
        return (*operation_key(event, "traceId", "spanId"), event["data"].get("actionId"))
    finishes = {key(event): event for event in events if event["type"] == "action_end"}
    actions = []
    for start in inside:
        if start["type"] != "action_start":
            continue
        finish = finishes.get(key(start))
        result = finish["data"] if finish else {}
        timing = result.get("timing", {})
        started = start["data"].get("timing", {})
        elapsed = None
        if (started.get("clock") is not None and started.get("clock") == timing.get("clock")
                and isinstance(started.get("submittedAtMs"), (int, float))
                and isinstance(timing.get("receivedAtMs"), (int, float))):
            measured = timing["receivedAtMs"] - started["submittedAtMs"]
            if math.isfinite(measured) and measured >= 0:
                elapsed = measured
        actions.append({"actionId": start["data"].get("actionId"), "trace": start.get("trace", {}),
                        "controller": start["data"].get("controllerId"),
                        "startSeq": start["seq"], "endSeq": finish["seq"] if finish else None,
                        "startEventId": event_identity(start), "endEventId": event_identity(finish) if finish else None,
                        "status": result.get("status", "pending"), "exitCode": result.get("exitCode"),
                        "durationMs": elapsed, "stdout": result.get("stdout"), "error": result.get("error")})
    return actions


def sample_age_ms(sampled_at, received_at):
    """Age at read completion only when both timestamps include a timezone."""
    try:
        sample, received = (datetime.fromisoformat(value.replace("Z", "+00:00"))
                            for value in (sampled_at, received_at))
        if sample.utcoffset() is None or received.utcoffset() is None:
            return None
        age = (received - sample).total_seconds() * 1000
        return round(age, 3) if age >= 0 else None
    except (AttributeError, TypeError, ValueError):
        return None


def perception_report(inside, events):
    reads = operation_spans(inside, events, "perception_observe_start", "perception_observe_end")
    finishes = {event_identity(event): event for event in events if event["type"] == "perception_observe_end"}
    for read in reads:
        end = finishes.get(read["endEventId"])
        data = end["data"] if end else {}
        snapshot = data.get("snapshot")
        read.update({"status": data.get("status"), "snapshot": snapshot, "reused": data.get("reused"),
                     "executionId": data.get("result", {}).get("id"),
                     "observationIds": [item["id"] for item in data.get("result", {}).get("observations", [])],
                     "sampleAgeMs": sample_age_ms(snapshot.get("sampledAt"), end["at"])
                     if snapshot and end else None})
    statuses = [{"seq": event["seq"], "at": event["at"], "trace": event.get("trace", {}), "status": event["data"]}
                for event in inside if event["type"] == "perception_status"]
    by_result = {(read["trace"].get("epoch"), read["executionId"]): read
                 for read in reads if read["executionId"]}
    input_errors = []
    for event in inside:
        if event["type"] != "perception_input_error":
            continue
        data = event["data"]
        result_id = data.get("result", {}).get("id")
        read = by_result.get((event.get("trace", {}).get("epoch"), result_id))
        input_errors.append({"seq": event["seq"], "at": event["at"], "trace": event.get("trace", {}),
                             "executionId": result_id, "error": data.get("error"), "status": data.get("status"),
                             "readStartSeq": read["startSeq"] if read else None,
                             "readEndSeq": read["endSeq"] if read else None})
    snapshots = [read for read in reads if read["snapshot"]]
    summary = {
        **span_summary(reads),
        "ended": sum(read["endSeq"] is not None for read in reads),
        "readStates": dict(Counter((read["status"] or {}).get("state", "unknown")
                                  for read in reads if read["endSeq"] is not None)),
        "statusEvents": dict(Counter(item["status"].get("state", "unknown") for item in statuses)),
        "newResults": sum(read["reused"] is False for read in snapshots),
        "reusedResults": sum(read["reused"] is True for read in snapshots),
        "unknownReuseResults": sum(type(read["reused"]) is not bool for read in snapshots),
        "uniqueSnapshots": len({read["snapshot"]["id"] for read in snapshots if read["snapshot"].get("id")}),
        "sampleAgeMs": stats(read["sampleAgeMs"] for read in snapshots),
        "unknownSampleAge": sum(read["sampleAgeMs"] is None for read in snapshots),
        "errorReasons": dict(Counter(read["error"] for read in reads if read["error"])),
        "inputErrors": len(input_errors),
    }
    return summary, {"reads": reads, "statuses": statuses, "inputErrors": input_errors}


def action_runtime_report(inside):
    lifecycle = [{"seq": event["seq"], "at": event["at"], "type": event["type"],
                  "trace": event.get("trace", {}), "origin": event.get("origin"), "data": event["data"]}
                 for event in inside if event["type"] in
                 ("action_status", "action_fault", "action_fault_end", "action_stats")]
    summary = {
        "statusEvents": dict(Counter(event["data"].get("state", "unknown") for event in lifecycle
                                     if event["type"] == "action_status")),
        "faultsStarted": sum(event["type"] == "action_fault" for event in lifecycle),
        "faultsEnded": sum(event["type"] == "action_fault_end" for event in lifecycle),
        "statsWindows": sum(event["type"] == "action_stats" for event in lifecycle),
    }
    return summary, lifecycle


def model_attempts(related):
    order = {id(event): index for index, event in enumerate(related)}
    requests = {event["trace"]["requestId"]: event for event in related if event["type"] == "model_request"}
    streams = {(event["trace"].get("requestId"), event["trace"].get("httpId")): event
               for event in related if event["type"] == "model_stream_start"}
    http_groups = defaultdict(list)
    ws_dispatches = defaultdict(list)
    for event in related:
        if event["type"].startswith("model_http_"):
            http_groups[event["trace"]["httpId"]].append(event)
        elif event["type"] == "model_ws_dispatch":
            ws_dispatches[event["trace"]["requestId"]].append(event)
    attempts = []
    for http_id, group in http_groups.items():
        kinds = {event["type"]: event for event in group}
        first = kinds.get("model_http_start")
        dispatch = kinds.get("model_http_dispatch")
        finish = kinds.get("model_http_end") or kinds.get("model_http_error")
        detail = finish["data"] if finish else {}
        request_id = group[0]["trace"].get("requestId")
        request = requests.get(request_id)
        inbound = streams.get((request_id, http_id))
        attempts.append({"transport": "http", "requestId": request_id, "httpId": http_id,
            "_order": order[id(first or group[0])],
            "requestSeq": request["seq"] if request else None,
            "startSeq": first["seq"] if first else group[0]["seq"],
            "endSeq": finish["seq"] if finish else None,
            "builtBodyBytes": request["data"].get("bodyBytes") if request else None,
            "wireBytes": wire_bytes(first["data"].get("body", {})) if first else None,
            "incremental": None, "dispatchSeq": dispatch["seq"] if dispatch else None,
            "dispatchAtMs": detail.get("dispatchAtMs", dispatch["atMs"] if dispatch else None),
            "status": detail.get("status"),
            "fetchWaitMs": detail.get("fetchToHeadersMs", detail.get("fetchDurationMs")),
            "headersAtMs": detail.get("headersAtMs"), "error": detail.get("error"),
            "aborted": detail.get("aborted", False),
            "firstInboundSeq": inbound["seq"] if inbound else None,
            "dispatchToFirstInboundMs": inbound["data"].get("afterDispatchMs") if inbound else None})
    for request_id, request in requests.items():
        data = request["data"]
        if data.get("transport") != "websocket":
            continue  # Old WS logs have no dispatch distinction; do not infer it from payloads.
        inbound = streams.get((request_id, None))
        for dispatch in ws_dispatches.get(request_id) or [None]:
            attempts.append({"transport": "websocket", "requestId": request_id, "httpId": None,
                "_order": order[id(dispatch or request)],
                "requestSeq": request["seq"], "startSeq": dispatch["seq"] if dispatch else request["seq"],
                "endSeq": None, "builtBodyBytes": data.get("bodyBytes"),
                "wireBytes": dispatch["data"].get("bodyBytes") if dispatch else None,
                "incremental": data.get("incremental"),
                "dispatchSeq": dispatch["seq"] if dispatch else None,
                "dispatchAtMs": dispatch["atMs"] if dispatch else None,
                "status": None, "fetchWaitMs": None, "headersAtMs": None, "error": None, "aborted": None,
                "firstInboundSeq": inbound["seq"] if inbound else None,
                "dispatchToFirstInboundMs": inbound["data"].get("afterDispatchMs") if inbound else None})
    return [{key: value for key, value in attempt.items() if key != "_order"}
            for attempt in sorted(attempts, key=lambda attempt: attempt["_order"])]


def observation_events(events, commands):
    """Read new inline device observations, retaining old independent facts once."""
    separate = {(operation_key(event, "operationId"), event["data"].get("id"))
                for event in events if event["type"] == "observation"}
    for event in events:
        if event["type"] == "observation":
            yield event
        elif event["type"] == "execution":
            command = commands.get(operation_key(event, "operationId"), {}).get("data", {})
            for observation in event["data"].get("observations", []):
                if (operation_key(event, "operationId"), observation.get("id")) in separate:
                    continue
                yield {**event, "type": "observation", "data": {
                    **observation, "arguments": command.get("arguments", event["data"].get("arguments")),
                    "argv": command.get("argv"),
                }}


def compaction_http_attempts(inside, events):
    starts = [event for event in inside if event["type"] == "compaction_http_start"]
    http_ids = {trace_key(event, "httpId") for event in starts}
    finishes = {trace_key(event, "httpId"): event for event in events
                if event["type"] in ("compaction_http_end", "compaction_http_error")
                and trace_key(event, "httpId") in http_ids}
    header_names = ("content-type", "content-encoding", "x-request-id", "request-id", "retry-after", "server-timing", "cf-ray")
    attempts = []
    for start in starts:
        http_id = start["trace"]["httpId"]
        finish = finishes.get(trace_key(start, "httpId"))
        data = start["data"]
        result = finish["data"] if finish else {}
        is_error = finish and finish["type"] == "compaction_http_error"
        aborted = result.get("aborted", False)
        status = result.get("status")
        state = ("pending" if not finish else "aborted" if aborted else "error" if is_error
                 else "http_error" if status is not None and status >= 400 else "headers_received")
        cause = result.get("cause")
        attempts.append({"httpId": http_id, "epoch": start.get("trace", {}).get("epoch"),
            "trace": compaction_trace(start),
            "startSeq": start["seq"], "endSeq": finish["seq"] if finish else None,
            "at": start["at"], "startAtMs": start["atMs"],
            "endAt": finish["at"] if finish else None, "endAtMs": finish["atMs"] if finish else None,
            "state": state, "terminalEvent": finish["type"] if finish else None,
            "method": data.get("method"), "endpoint": data.get("endpoint"),
            "bodyBytes": data.get("bodyBytes"), "contentType": data.get("contentType"),
            "contentEncoding": data.get("contentEncoding"), "status": status,
            "headers": {name: value for name, value in (result.get("headers") or {}).items() if name in header_names},
            "durationMs": result.get("durationMs"), "dispatchAtMs": result.get("dispatchAtMs"),
            "headersAtMs": result.get("headersAtMs"), "fetchToHeadersMs": result.get("fetchToHeadersMs"),
            "fetchDurationMs": result.get("fetchDurationMs"), "error": result.get("error"),
            "code": result.get("code"),
            "cause": {key: cause[key] for key in ("name", "code", "message") if key in cause} if isinstance(cause, dict) else None,
            "aborted": aborted})
    return attempts


def compaction_maintenance_spans(compactions):
    spans = []
    pending = {}
    for event in compactions:
        epoch = event["epoch"]
        trace = event["trace"]
        identity = "operationId" if trace.get("operationId") else "spanId" if trace.get("spanId") else None
        key = (epoch, identity, trace.get(identity) if identity else None)
        if event["type"] == "auto_compaction_start":
            span = {"epoch": epoch, "trace": trace, "startSeq": event["seq"], "endSeq": None,
                    "startAtMs": event["atMs"], "endAtMs": None, "state": "pending", "durationMs": None}
            spans.append(span)
            pending[key] = span
        elif key in pending:
            span = pending.pop(key)
            span.update({"endSeq": event["seq"], "endAtMs": event["atMs"],
                         "state": "aborted" if event["aborted"] else "error" if event["error"] else "completed",
                         "durationMs": event["durationMs"] if event["durationMs"] is not None
                                       else event["atMs"] - span["startAtMs"]})
    return spans


def analyze(run, epoch=None):
    events, controls, source = read_events(run, epoch)
    takeovers = [event for event in controls if event["data"]["mode"] == "auto"]
    if epoch is None and len(takeovers) > 1:
        choices = ", ".join(event["data"]["epoch"] for event in takeovers)
        raise ValueError(f"Run contains {len(takeovers)} takeover epochs; select one with --epoch: {choices}")
    enabled = next((event for event in takeovers if epoch is None or event["data"]["epoch"] == epoch), None)
    if epoch is not None and enabled is None:
        raise ValueError(f"No auto control event found for epoch {epoch}")
    selected_epoch = enabled["data"]["epoch"] if enabled else None
    stopped = next((event for event in controls if enabled and source_key(event) == source_key(enabled)
                    and event["seq"] > enabled["seq"]
                    and event["data"]["mode"] == "manual"
                    and event.get("trace", {}).get("epoch") == selected_epoch), None)
    # Match the dashboard: explicit epoch ownership survives handback and a later
    # takeover. Control boundaries measure active time, not event membership.
    # Unattributed events remain unknown; proximity is not evidence of ownership.
    inside = [event for event in events
              if not enabled or event.get("trace", {}).get("epoch") == selected_epoch]
    starts = [event for event in inside if event["type"] == "model_start"]
    call_ids = {trace_key(event, "modelCallId") for event in starts}
    by_call = defaultdict(list)
    for event in events:
        call_id = trace_key(event, "modelCallId")
        if call_id in call_ids:
            by_call[call_id].append(event)
    tool_ends = {trace_key(event, "modelCallId", "toolCallId"): event for event in events
                 if event["type"] == "tool_end"}
    calls = []
    for index, start in enumerate(starts, 1):
        call_id = start["trace"]["modelCallId"]
        related = by_call[trace_key(start, "modelCallId")]
        ends = [event for event in related if event["type"] == "model_end"]
        end = ends[-1] if ends else None
        final = end["data"] if end else {}
        attempts = model_attempts(related)
        dispatched = [attempt for attempt in attempts
                      if attempt["transport"] == "http" or attempt["dispatchSeq"] is not None]
        first_inbound = next((event for event in related if event["type"] == "model_stream_start"), None)
        usage = final.get("usage")
        input_tokens = sum(usage.get(key, 0) for key in ("input", "cacheRead", "cacheWrite")) if usage else None
        cached = usage.get("cacheRead", 0) if usage else None
        state = ("pending" if not end else "aborted" if final.get("stopReason") == "aborted"
                 else "error" if final.get("error") or final.get("stopReason") == "error" else "completed")
        dispatch_ms = next((attempt["dispatchAtMs"] for attempt in attempts if attempt["dispatchAtMs"] is not None), None)
        headers_ms = next((attempt["headersAtMs"] for attempt in reversed(attempts) if attempt["headersAtMs"] is not None), None)
        tools = [event["data"]["toolName"] for event in related if event["type"] == "tool_start"]
        calls.append({"index": index, "modelCallId": call_id, "startSeq": start["seq"],
            "endSeq": end["seq"] if end else None, "at": start["at"], "state": state,
            "stopReason": final.get("stopReason"), "totalMs": final.get("durationMs"),
            "localPreparationMs": dispatch_ms - start["atMs"] if dispatch_ms is not None else None,
            "fetchWaitMs": sum(attempt["fetchWaitMs"] for attempt in attempts if attempt["fetchWaitMs"] is not None) if any(attempt["fetchWaitMs"] is not None for attempt in attempts) else None,
            "afterHeadersMs": end["atMs"] - headers_ms if end and headers_ms is not None else None,
            "wireBytes": dispatched[0]["wireBytes"] if dispatched else None,
            "attemptedWireBytes": sum(attempt["wireBytes"] or 0 for attempt in attempts),
            "firstInboundMs": first_inbound["data"].get("modelElapsedMs") if first_inbound else None,
            "dispatchToFirstInboundMs": first_inbound["data"].get("afterDispatchMs") if first_inbound else None,
            "transports": list(dict.fromkeys(attempt["transport"] for attempt in attempts)),
            "inputTokens": input_tokens, "cachedTokens": cached,
            "outputTokens": usage.get("output") if usage else None,
            "cacheHit": ratio(cached, input_tokens) if usage else None,
            "retryCount": max(0, len(dispatched) - 1), "tools": tools,
            "observationIds": start["data"].get("observations", []),
            "error": final.get("error"), "attempts": attempts})

    commands = {operation_key(event, "operationId"): event for event in inside if event["type"] == "command"}
    executions = []
    execution_errors = []
    for event in inside:
        if event["type"] not in ("execution", "execution_error"):
            continue
        command_event = commands.get(operation_key(event, "operationId"))
        command = command_event["data"] if command_event else {}
        data = event["data"]
        if event["type"] == "execution_error":
            execution_errors.append({"seq": event["seq"], "at": event["at"], "atMs": event["atMs"],
                **{key: event.get("trace", {}).get(key) for key in
                   ("epoch", "modelCallId", "requestId", "toolCallId", "operationId")},
                "commandSeq": command_event["seq"] if command_event else None,
                "controller": data.get("controllerId", command.get("controllerId", command.get("id"))), "arguments": command.get("arguments", data.get("arguments")), "argv": command.get("argv"),
                "error": data.get("error"), "aborted": data.get("aborted", False)})
            continue
        timing = data["timing"]
        executions.append({"seq": event["seq"], "id": data["id"],
            "actionId": data.get("actionId"),
            "readOnly": data.get("readOnly", False),
            "controller": data.get("controllerId", command.get("controllerId", command.get("id"))),
            "requiresControl": data.get("requiresControl", command.get("requiresControl", True)),
            "arguments": command.get("arguments", data.get("arguments")), "argv": command.get("argv"), "status": data["status"],
            "durationMs": timing["receivedAtMs"] - timing["requestedAtMs"]})
    observation_starts = {operation_key(event, "operationId"): event for event in events
                          if event["type"] == "observation_start"
                          and event.get("trace", {}).get("operationId") is not None}
    observations = []
    capture_by_origin = defaultdict(list)
    for event in observation_events(inside, commands):
        data = event["data"]
        request = observation_starts.get(operation_key(event, "operationId"), {}).get("data", {})
        timing = data["timing"]
        after = data.get("afterExecution", {})
        capture_ms = timing["receivedAtMs"] - timing["requestedAtMs"]
        capture_by_origin[data.get("origin") or "unknown"].append(capture_ms)
        observations.append({"seq": event["seq"], "id": data["id"], "controllerId": data.get("controllerId", data.get("sensorId")),
            "origin": data.get("origin"), "path": data.get("path"), "timeline": data.get("timeline"),
            "arguments": request.get("arguments", data.get("arguments")), "argv": request.get("argv", data.get("argv")),
            "captureMs": capture_ms,
            "sourceSequence": data.get("sourceSequence"), "sourceSequenceDelta": data.get("sourceSequenceDelta"),
            "afterExecutionId": after.get("id"), "captureRequestedAfterMs": after.get("captureRequestedAfterMs"),
            "captureReceivedAfterMs": after.get("captureReceivedAfterMs")})
    first_after_action = {}
    for observation in observations:
        if observation["origin"] == "tool_batch" and observation["afterExecutionId"]:
            first_after_action.setdefault(observation["afterExecutionId"], observation)
    tool_starts = [event for event in inside if event["type"] == "tool_start"]
    tool_counts = Counter(event["data"]["toolName"] for event in tool_starts)
    exec_starts = {trace_key(event, "modelCallId", "toolCallId"): event for event in events
                   if event["type"] == "exec"}
    exec_ends = {trace_key(event, "modelCallId", "toolCallId"): event for event in events
                 if event["type"] == "exec_result"}
    tool_details = []
    for start in tool_starts:
        key = trace_key(start, "modelCallId", "toolCallId")
        finish = tool_ends.get(key)
        is_error = finish["data"].get("isError", False) if finish else None
        command_start = exec_starts.get(key)
        command_end = exec_ends.get(key) if command_start else None
        command = None
        if command_start:
            exit_code = command_end["data"].get("exitCode") if command_end else None
            command = {"command": command_start["data"].get("command"),
                "startSeq": command_start["seq"], "endSeq": command_end["seq"] if command_end else None,
                "at": command_start["at"], "startAtMs": command_start["atMs"],
                "endAt": command_end["at"] if command_end else None,
                "endAtMs": command_end["atMs"] if command_end else None,
                "durationMs": command_end["atMs"] - command_start["atMs"] if command_end else None,
                "state": "pending" if not command_end else "completed" if exit_code == 0 else "error",
                "exitCode": exit_code}
        tool_details.append({"toolName": start["data"]["toolName"],
            "epoch": key[0], "modelCallId": key[1], "toolCallId": key[2],
            "startSeq": start["seq"], "endSeq": finish["seq"] if finish else None,
            "at": start["at"], "startAtMs": start["atMs"],
            "endAt": finish["at"] if finish else None, "endAtMs": finish["atMs"] if finish else None,
            "durationMs": finish["atMs"] - start["atMs"] if finish else None,
            "state": "pending" if not finish else "error" if is_error else "completed",
            "isError": is_error,
            **({"argsRef": start["data"]["argsRef"]} if "argsRef" in start["data"]
               else {"args": start["data"].get("args", {})}),
            "result": finish["data"].get("result") if finish else None, "exec": command})
    skills = []
    skill_argument_errors = []
    read_skill_paths = archived_skill_paths(run)
    for event in tool_starts:
        data = event["data"]
        if data["toolName"] not in ("read", "write", "edit"):
            continue
        if "argsRef" in data:
            paths, error = read_skill_paths(json.dumps(data["argsRef"], sort_keys=True))
            if error:
                skill_argument_errors.append({"seq": event["seq"], "tool": data["toolName"],
                                              "argsRef": data["argsRef"], "error": error})
                continue
        else:
            paths = skill_paths(data.get("args", {}))
        if not paths:
            continue
        finish = tool_ends.get(trace_key(event, "modelCallId", "toolCallId"))
        skills.append({"seq": event["seq"], "tool": data["toolName"], "paths": paths,
                       "endSeq": finish["seq"] if finish else None,
                       "success": not finish["data"].get("isError", False) if finish else None})
    skill_counts = {tool: sum(item["tool"] == tool and item["success"] is True for item in skills)
                    for tool in ("read", "edit", "write")}
    unknown_skill_tools = {item["tool"] for item in skill_argument_errors}
    compactions = []
    for event in inside:
        if event["type"] not in ("auto_compaction_start", "auto_compaction_end"):
            continue
        data = event["data"]
        result = data.get("result") or {}
        remote = result.get("preserveData", {}).get("openaiRemoteCompaction", {})
        compactions.append({"seq": event["seq"], "at": event["at"], "atMs": event["atMs"], "type": event["type"],
            "trace": compaction_trace(event),
            "epoch": event.get("trace", {}).get("epoch"),
            "action": data.get("action"), "reason": data.get("reason"),
            "aborted": data.get("aborted"), "error": data.get("errorMessage", data.get("error")),
            "durationMs": data.get("durationMs"),
            "tokensBefore": result.get("tokensBefore"), "usage": remote.get("usage"),
            "retainedImageCount": remote.get("retainedImageCount")})
    compaction_maintenance = compaction_maintenance_spans(compactions)
    compact_usage = [event["usage"] for event in compactions if event["type"] == "auto_compaction_end"
                     and event["usage"] and not event["aborted"] and not event["error"]]
    speculation_fields = ("stage", "method", "snapshotLeafId", "contextTokensAtStart", "contextTokens",
                          "thresholdTokens", "durationMs", "tokensBefore", "reason", "error")
    speculation = [{"seq": event["seq"], "at": event["at"], "atMs": event["atMs"],
                    "trace": compaction_trace(event),
                    "data": {key: value for key, value in event["data"].items()
                             if key in speculation_fields and type(value) in (str, int, float)}}
                   for event in inside if event["type"] == "compaction_speculation"]
    speculation_counts = Counter(event["data"].get("stage") for event in speculation)
    compaction_retries = [{"seq": event["seq"], "at": event["at"], "atMs": event["atMs"],
                          "trace": compaction_trace(event),
                          "data": {key: value for key, value in event["data"].items()
                                   if ((key in ("attempt", "retryDelayMs") and type(value) is int)
                                       or (key in ("model", "error") and isinstance(value, str)))}}
                         for event in inside if event["type"] == "compaction_retry"]
    compaction_http = compaction_http_attempts(inside, events)
    completed = [call for call in calls if call["state"] == "completed"]
    all_attempts = [attempt for call in calls for attempt in call["attempts"]]
    http_attempts = [attempt for attempt in all_attempts if attempt["transport"] == "http"]
    ws_attempts = [attempt for attempt in all_attempts if attempt["transport"] == "websocket"]
    ws_sent = [attempt for attempt in ws_attempts if attempt["dispatchSeq"] is not None]
    ws_builds = {(call["modelCallId"], attempt["requestId"]): attempt for call in calls
                 for attempt in call["attempts"] if attempt["transport"] == "websocket"}.values()
    http_errors = [attempt for attempt in http_attempts
                   if (attempt["error"] and not attempt["aborted"]) or (attempt["status"] or 0) >= 400]
    same_host = [event for event in inside if enabled and source_key(event) == source_key(enabled)]
    active_end_ms = stopped["atMs"] if stopped else same_host[-1]["atMs"] if same_host else None
    elapsed_ms = active_end_ms - enabled["atMs"] if enabled and active_end_ms is not None else None
    actions = input_actions(inside, events)
    successful_actions = sum(execution["status"] == "completed" and execution["requiresControl"]
                             and not execution["actionId"] and not execution["readOnly"] for execution in executions)
    successful_actions += sum(action["status"] == "completed" and action["exitCode"] == 0 for action in actions)
    capabilities = operation_spans(inside, events, "capability_start", "capability_end")
    python_calls = operation_spans(inside, events, "python_capability", "python_capability_result")
    local_python_calls = operation_spans(inside, events, "python_call_start", "python_call_end")
    python_exceptions, python_exception_groups = local_python_exceptions(local_python_calls, events)
    discovery = operation_spans(inside, events, "python_capabilities_start", "python_capabilities")
    shiori_spans = operation_spans(inside, events, "shiori_span_start", "shiori_span_end")
    perception_summary, perception = perception_report(inside, events)
    action_runtime_summary, action_runtime = action_runtime_report(inside)
    # A native loop can end after control was handed back; attach its summary to the loop we actually started.
    loop_keys = {trace_key(event, "traceId", "spanId") for event in inside
                 if event["type"] == "shiori_span_start" and event["data"].get("operation") == "invoke_agent"}
    native_runs = [{"trace": event["trace"], "source": event.get("source"), **event["data"]}
                   for event in events if event["type"] == "shiori_run_end"
                   and trace_key(event, "traceId", "spanId") in loop_keys]
    summary = {"startedRequests": len(calls), "completedRequests": len(completed),
        "pendingRequests": sum(call["state"] == "pending" for call in calls),
        "abortedRequests": sum(call["state"] == "aborted" for call in calls),
        "failedRequests": sum(call["state"] == "error" for call in calls),
        "retryCount": sum(call["retryCount"] for call in calls), "httpErrors": len(http_errors),
        "http429": sum(attempt["status"] == 429 for attempt in http_errors),
        "httpErrorKinds": dict(Counter(attempt["error"] or str(attempt["status"]) for attempt in http_errors)),
        "attemptedWireBytes": sum(call["attemptedWireBytes"] for call in calls),
        "transports": {"httpAttempts": len(http_attempts), "websocketBuilds": len(ws_builds),
            "websocketDispatches": len(ws_sent),
            "websocketUndispatchedBuilds": sum(attempt["dispatchSeq"] is None for attempt in ws_builds),
            "websocketFullBuilds": sum(attempt["incremental"] is False for attempt in ws_builds),
            "websocketIncrementalBuilds": sum(attempt["incremental"] is True for attempt in ws_builds),
            "websocketFullDispatches": sum(attempt["incremental"] is False for attempt in ws_sent),
            "websocketIncrementalDispatches": sum(attempt["incremental"] is True for attempt in ws_sent),
            "httpWireBytes": stats(attempt["wireBytes"] for attempt in http_attempts),
            "websocketWireBytes": stats(attempt["wireBytes"] for attempt in ws_sent),
            "websocketDispatchToFirstInboundMs": stats(attempt["dispatchToFirstInboundMs"] for attempt in ws_sent)},
        "weightedCacheHit": weighted_cache(completed),
        "warmWeightedCacheHit": weighted_cache([call for call in completed if call["index"] > 1]),
        "metrics": {key: stats(call[key] for call in completed) for key in
                    ("totalMs", "localPreparationMs", "fetchWaitMs", "afterHeadersMs", "wireBytes", "inputTokens",
                     "firstInboundMs", "dispatchToFirstInboundMs")},
        "toolCounts": dict(tool_counts),
        "toolErrors": sum(tool["isError"] is True for tool in tool_details),
        "toolErrorsByName": dict(Counter(tool["toolName"] for tool in tool_details if tool["isError"] is True)),
        "toolExecution": {name: stats(tool["durationMs"] for tool in tool_details if tool["toolName"] == name)
                          for name in tool_counts},
        "execCommandMs": stats(tool["exec"]["durationMs"] for tool in tool_details if tool["exec"]),
        "controllerActions": successful_actions,
        "asyncActionStatuses": dict(Counter(action["status"] for action in actions)),
        "asyncActionMs": stats(action["durationMs"] for action in actions),
        "controllerExecutionErrors": len(execution_errors),
        "controllerExecutionStatuses": dict(Counter(execution["status"] for execution in executions)),
        "controllerActionsPerMinute": ratio(successful_actions * 60000, elapsed_ms),
        "independentObserveRequests": sum(call["state"] == "completed" and call["tools"] == ["observe"] for call in calls),
        "observeToolCalls": tool_counts["observe"],
        "skillReads": None if "read" in unknown_skill_tools else skill_counts["read"],
        "skillEdits": None if "edit" in unknown_skill_tools else skill_counts["edit"],
        "skillWrites": None if "write" in unknown_skill_tools else skill_counts["write"],
        "skillEvidence": {"state": "incomplete" if skill_argument_errors else "complete",
                          "unknownArguments": len(skill_argument_errors), "knownSuccessful": skill_counts},
        "compactionStarts": sum(item["type"] == "auto_compaction_start" for item in compactions),
        "compactionEnds": sum(item["type"] == "auto_compaction_end" for item in compactions),
        "compactionMaintenance": {
            **{state: sum(span["state"] == state for span in compaction_maintenance)
               for state in ("completed", "aborted", "error", "pending")},
            "durationMs": stats(span["durationMs"] for span in compaction_maintenance)},
        "successfulCompactionUsage": {"count": len(compact_usage), "totals": {
            key: sum(usage.get(key, 0) for usage in compact_usage) for key in
            ("inputTokens", "outputTokens", "cachedInputTokens", "totalTokens", "reasoningOutputTokens")}},
        "compactionSpeculation": {
            **{stage: speculation_counts[stage] for stage in
               ("started", "armed", "invalidated", "waiting", "applied", "failed", "cancelled")},
            "armedDurationMs": stats(event["data"].get("durationMs") for event in speculation
                                     if event["data"].get("stage") == "armed")},
        "compactionRetries": {
            "announcedRetries": len(compaction_retries) if compaction_retries else None,
            "errorReasons": dict(Counter(event["data"]["error"] for event in compaction_retries
                                         if "error" in event["data"]))},
        "compactionHttp": {
            "attempts": len(compaction_http),
            "pendingAttempts": sum(attempt["state"] == "pending" for attempt in compaction_http),
            "responsesReceived": sum(attempt["terminalEvent"] == "compaction_http_end" for attempt in compaction_http),
            "failedAttempts": sum(attempt["state"] in ("error", "http_error") for attempt in compaction_http),
            "abortedAttempts": sum(attempt["state"] == "aborted" for attempt in compaction_http),
            "http429": sum(attempt["status"] == 429 for attempt in compaction_http),
            "retryCount": None,  # Independent HTTP IDs do not identify logical compaction requests.
            "preparedBodyBytes": sum(attempt["bodyBytes"] or 0 for attempt in compaction_http),
            "knownBodySizeAttempts": sum(attempt["bodyBytes"] is not None for attempt in compaction_http),
            "headersWaitMs": stats(attempt["fetchToHeadersMs"] for attempt in compaction_http),
            "failedFetchWaitMs": stats(attempt["fetchDurationMs"] for attempt in compaction_http
                                       if attempt["state"] == "error")},
        "observationOrigins": dict(Counter(observation["origin"] or "unknown" for observation in observations)),
        "captureMs": stats(observation["captureMs"] for observation in observations),
        "captureMsByOrigin": {origin: stats(values) for origin, values in capture_by_origin.items()},
        "firstAutomaticCaptureAfterActionMs": stats(observation["captureRequestedAfterMs"] for observation in first_after_action.values()),
        "firstAutomaticCaptureReturnedAfterActionMs": stats(observation["captureReceivedAfterMs"] for observation in first_after_action.values()),
        "mediaEncodingMs": stats(event["data"].get("durationMs") for event in inside if event["type"] == "observation_media"),
        "sources": dict(Counter(event.get("source", {}).get("component", "unlabelled") for event in inside)),
        "capabilities": span_summary(capabilities), "pythonCapabilities": span_summary(python_calls),
        "localPythonCalls": span_summary(local_python_calls),
        "localPythonExceptions": python_exceptions,
        "capabilityDiscovery": span_summary(discovery),
        "perception": perception_summary, "actionRuntime": action_runtime_summary,
        "shiori": {"spans": span_summary(shiori_spans), "nativeLoops": len(native_runs)}}
    return {"analysisVersion": 7, "runDir": str(run), "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "window": {"epoch": selected_epoch,
                   "startedAt": enabled["at"] if enabled else None, "stoppedAt": stopped["at"] if stopped else None,
                   "stopReason": stopped["data"].get("reason") if stopped else None,
                   "controlModeAtLastEvent": (stopped or enabled or controls[-1])["data"]["mode"] if controls else None,
                   "observedElapsedMs": elapsed_ms},
        "summary": summary, "firstRequest": calls[0] if calls else None,
        "calls": calls, "tools": tool_details, "executions": executions, "actions": actions, "observations": observations,
        "controllerExecutionErrors": execution_errors,
        "skills": skills, "skillArgumentErrors": skill_argument_errors,
        "compactions": compactions, "compactionMaintenance": compaction_maintenance,
        "compactionSpeculation": speculation,
        "compactionRetries": compaction_retries,
        "compactionHttpAttempts": compaction_http,
        "capabilities": capabilities, "pythonCapabilities": python_calls, "capabilityDiscovery": discovery,
        "localPythonCalls": local_python_calls,
        "localPythonExceptionGroups": python_exception_groups,
        "perception": perception, "actionRuntime": action_runtime,
        "shiori": {"spans": shiori_spans, "runs": native_runs},
        "notes": [
            "Offline snapshot of the selected takeover epoch; multiple takeovers require explicit selection. Control mode refers to that epoch and does not prove the host process is live. Pending requests and a partial final line may complete later.",
            "Event membership uses explicit trace.epoch, including late events after handback or a new takeover; unattributed events are not assigned by time. Control boundaries only define observedElapsedMs and action-rate denominators, not event membership. This matches dashboard epoch filtering.",
            "Main-loop metrics exclude independent OMP compaction HTTP requests. Successful compaction usage is listed separately; failed/cancelled compaction usage may be unavailable. Compaction lifecycle events do not measure full HTTP latency.",
            "Compaction event and HTTP trace fields preserve explicit epoch/traceId/spanId/parentSpanId/operationId. These identify a candidate operation and its child requests when instrumented; absent identities in old logs remain unknown.",
            "compactionHttp is independent of main-loop metrics. compaction_http_end only means response headers arrived, not stream completion; HTTP status >=400 counts as a failed attempt. retryCount is unknown without logical compaction request IDs, so consecutive attempts are not assumed to be retries.",
            "compactionRetries records explicit OMP V2 retry warnings belonging to the selected epoch, including late events. announcedRetries counts warnings before backoff, not confirmed redispatches; without warnings it remains unknown (null), including older logs. Error reasons are reported strings. Explicit trace IDs can link retries, HTTP attempts and candidates; no pairing is inferred from time or order.",
            "compactionSpeculation preserves lifecycle events belonging to the selected epoch, including late events. armedDurationMs is the reported time to prepare a candidate; waiting counts waits, not their duration. snapshotLeafId identifies the summarized branch boundary, not an HTTP request. Explicit trace IDs can link HTTP attempts and candidates; no pairing is inferred from time or order.",
            "compactionMaintenance pairs auto_compaction_start/end by explicit epoch and operationId (or spanId), including late ends; only older events without identities use serial pairing within an epoch. durationMs uses the reported duration when available, otherwise the recording-host interval. It measures foreground maintenance, not full background summary generation. A start with no end remains pending and contributes no duration.",
            "fetchWaitMs sums completed HTTP attempt waits, including failed attempts. Upload, connection/TLS, network and server queue/processing cannot be separated by these logs.",
            "localPreparationMs is the first HTTP or WS dispatch minus model_start. Retry backoff and later attempt preparation are not separately measured; timing buckets need not sum to totalMs.",
            "WS attempts are matched by modelCallId/requestId; HTTP attempts additionally use httpId. A WS build without dispatch is retained but contributes no wire bytes or retry. retryCount counts additional transport attempts, including WS-to-HTTP fallback, not just repeated requests on one transport.",
            "WS wireBytes come from model_ws_dispatch after the size check, immediately before send; HTTP wireBytes are prepared request bodies. Neither proves bytes fully uploaded. builtBodyBytes describes construction only. Payload and stream artifacts are never opened; old WS logs are not inferred.",
            "firstInboundMs and dispatchToFirstInboundMs describe the first inbound stream event, not the first token. Only the event's matching attempt gets that timing; later fallback attempts may have no first-event record. WS has no HTTP fetch/header timing, so those fields remain null.",
            "Cache denominator is usage.input + cacheRead + cacheWrite. Warm excludes request index 1, not later post-compaction cache resets.",
            "controllerActions counts completed asynchronous action lifetimes and control-requiring executions without actionId or readOnly=true. Submission/status/wait/cancel RPCs with actionId do not count as additional input; actions retains their actual execution lifetime, including late endings and pending actions. asyncActionMs measures submission to terminal on the same Baseware clock, not game frames or successful task progress. Sampling calls with requiresControl=false are excluded. Older executions retain their original action meaning; inspect argv for state queries/releases. independentObserveRequests counts completed requests whose sole executed tool is observe.",
            "controllerExecutionErrors counts explicit execution_error events belonging to the selected epoch, including late events and those marked aborted. Details retain the original error and match command by epoch/operationId. This is independent of toolErrors: a shell batch can finish successfully after an inner controller command fails. Stderr is not parsed to infer errors.",
            "toolExecution measures tool_start to tool_end, including result preparation. Native bash/background tool completion is not the lifetime or exit status of a background process. Tool arguments remain inline for old logs or as argsRef for indexed logs; only read/write/edit arguments are opened in reference mode for skill-path evidence. Tool results remain references; execCommandMs only measures historical exec to exec_result events. These durations overlap and must not be added. Pending spans have no duration, and command text is not parsed to infer waiting or action time.",
            "Skill read/write/edit counts use successful tool completion and named SKILL.md paths. Unreadable argument references make the affected count unknown (null); skillEvidence keeps known successes and skillArgumentErrors records missing evidence. Counts do not prove the quality of learned content or that an edit changed its hash.",
            "Capture intervals include waiting, GPU readback and file encoding. sourceSequence advance does not prove that the frame reflects the preceding action.",
            "perception measures explicitly traced snapshot reads, including late ends, not background sampling or controller actions. New/reused counts use the recorded reused flag; unique snapshot IDs are separate from read count. sampleAgeMs is read-end wall time minus the declared sampledAt only when both have timezones and the age is nonnegative; missing/invalid/future timestamps remain unknown. It does not measure model-dispatch age, sample freshness guarantees, or sensor capture duration. Status events without the selected epoch are not assigned by time.",
            "actionRuntime preserves explicitly attributed worker lifecycle, fault and statistics events, including late cleanup. Fault counts count opened/closed windows, not failed device actions; an error status is not counted again as a fault. Statistics are reported windows, not controller executions, and no cadence, task success or physical input outcome is inferred from them.",
            "perception.inputErrors separately records post-read model-input/media-encoding failures, linked by epoch and result.id. A successful perception read does not imply successful delivery to the model; read outcomes are retained rather than overwritten by encoding failures.",
            "P95 uses the nearest-rank percentile. Capability and Shiori spans pair only by explicit epoch/traceId/spanId; older untraced calls are not inferred.",
            "Native Shiori run summaries cover one agent loop, not a whole takeover. They overlap existing model/tool metrics and must not be added to token/cost totals. Python detail spans overlap their enclosing capability calls; durations are inclusive, not additive.",
            "localPythonCalls measures decorated functions executing in the workspace Python process, separate from pythonCapabilities (external runner). Nested calls retain their own spans and overlap enclosing durations; neither counts as additional controller actions. Function origin/codeSHA identify loaded code, while origin/endOrigin retain the Python event clock.",
            "localPythonCalls.outcomes.error counts function-boundary raises, not task failures. localPythonExceptions groups consecutive raised local parent spans using explicit epoch/traceId/spanId/parentSpanId only; rootRaised counts these chains, not proven unique exception objects. A successful ancestor separates branches and can have caught a raise, but does not prove it was expected. expected stays null without explicit test evidence. Missing execution ancestry stays unassociated; neither PID, error text, command text nor proximity is used to guess an association. Execution outcomes use a traced Python runner, tool, or background terminal; async submission success is replaced by the associated background outcome (pending until delivered), and does not prove application success.",
            "Canonical multi-source facts retain origin.eventId and source-local seq. Start/end event IDs are unambiguous evidence; seq alone is not a cross-source ordering key. Monotonic timestamps from different sources are never used for control duration. Macro execution success does not prove task success or learning."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path, help="RSA run directory containing events.jsonl")
    parser.add_argument("--epoch", help="Takeover epoch UUID; required when the run contains multiple takeovers")
    parser.add_argument("--output", type=Path, help="Output JSON path (default: RUN_DIR/analysis.json)")
    args = parser.parse_args()
    run = args.run_dir.resolve()
    try:
        report = analyze(run, epoch=args.epoch)
    except ValueError as error:
        parser.error(str(error))
    output = args.output or run / "analysis.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"output": str(output), "summary": report["summary"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
