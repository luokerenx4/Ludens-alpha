"""Recording growth follows elapsed windows, not sampling rate or helper depth."""

import hashlib
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from rsa_tools import Client
from rsa_tools._context import current, scope
from rsa_tools._recording import RecordingWindow


SOURCE = '''from rsa_tools import capability, record
from rsa_tools._context import current
seen = []
@capability
def helper(fail=False):
    seen.append(dict(current()["trace"]))
    if fail:
        raise ValueError("flapping " + str(len(seen)))
    return "frame"
@record
@capability
def sample(nested=True, fail=False):
    return {"text": helper(fail) if nested else "frame"}
def quality():
    """Measure actual imported capability use."""
    helper()
    return {"metrics": {"calls": {"value": 1, "unit": "calls"}}}
'''


def context(workspace, **overrides):
    return {**current(), "workspace": str(workspace), "run_id": "host-run", "epoch": None,
            "socket_path": "fake.sock", "trace": {"traceId": "test", "recordingId": "host-run"},
            "timeout": None, "diagnostics": "normal", **overrides}


def load(workspace, call_context):
    source = Path(workspace) / "fixture.py"
    source.write_text(SOURCE)
    namespace = {"__name__": "fixture", "__file__": str(source)}
    with scope(call_context):
        exec(compile(SOURCE, str(source), "exec"), namespace)
    return namespace


class RecordingTests(unittest.TestCase):
    def test_worker_health_is_immediate_while_durable_faults_are_coalesced(self):
        source = '''from rsa_tools import capability, record
@capability
def frame(count):
    if count % 2:
        raise ValueError("frame unavailable " + str(count))
    return {"text": str(count)}
class Perception:
    sample_hz = 30
    def start(self, context): self.count = 0
    @record
    @capability
    def sample(self):
        self.count += 1
        return frame(self.count)
    def close(self): pass
'''
        for mode in ("normal", "full"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                incoming, messages = queue.Queue(), []
                environment = {**os.environ, "RSA_SOCKET": "missing.sock", "RSA_RUN_ID": "run",
                               "RSA_LOG_DIAGNOSTICS": "normal", "BASEWARE_TRACE": "{}"}
                with (root / "stderr").open("w") as stderr:
                    process = subprocess.Popen([sys.executable, "-u", "-m", "rsa_tools._perception"],
                                               cwd=root, env=environment, stdin=subprocess.PIPE,
                                               stdout=subprocess.PIPE, stderr=stderr, text=True)

                    def read():
                        for line in process.stdout:
                            value = json.loads(line)
                            messages.append(value)
                            incoming.put(value)

                    reader = threading.Thread(target=read, daemon=True)
                    reader.start()
                    try:
                        process.stdin.write(json.dumps({"id": "start", "action": "start", "workspace": str(root),
                            "runDir": str(root / "run"), "generation": "one", "source": source,
                            "diagnostics": mode, "trace": {"recordingId": "run"}}) + "\n")
                        process.stdin.flush()
                        deadline = time.monotonic() + 4
                        states = []
                        while len(states) < 6 and time.monotonic() < deadline:
                            message = incoming.get(timeout=4)
                            if message.get("id") == "start":
                                self.assertTrue(message["ok"])
                                self.assertEqual(message["result"]["diagnostics"], mode)
                            if message.get("event") == "status":
                                self.assertTrue(message["transient"])
                                states.append(message["state"])
                        self.assertEqual(states, ["error", "ready"] * 3)
                    finally:
                        process.terminate()
                        try:
                            process.wait(timeout=4)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                        process.stdin.close()
                        reader.join(timeout=2)
                        process.stdout.close()
                self.assertEqual(process.returncode, 0)
                self.assertEqual((root / "stderr").read_text(), "")
                recording = [message for message in messages if message.get("event") == "recording"]
                self.assertEqual(len([event for event in recording if event["type"] == "perception_fault"]), 2)
                stats = [event for event in recording if event["type"] == "perception_stats"]
                self.assertEqual(len(stats), 1)
                self.assertGreaterEqual(stats[0]["data"]["sample"]["completed"], 3)
                calls = [event for event in recording if event["type"].startswith("python_call")]
                if mode == "normal":
                    self.assertEqual(calls, [])
                else:
                    self.assertGreaterEqual(len(calls), 24)
                    self.assertTrue(all(event["channel"] == "diagnostic" for event in calls))
                samples = [message for message in messages if message.get("event") == "sample"]
                self.assertEqual(len(samples), stats[0]["data"]["sample"]["completed"])
                self.assertTrue(all(message["trace"]["recordingPurpose"] == "continuous-perception" for message in samples))

    def test_successful_sampling_is_zero_call_events_at_every_rate_and_depth(self):
        for hz in (1, 10, 30):
            for nested in (False, True):
                with self.subTest(hz=hz, nested=nested), tempfile.TemporaryDirectory() as directory:
                    clock, events, records = [0.0], [], []
                    base = context(directory, recording_purpose="continuous-perception")
                    recorder = RecordingWindow(events.append, base["trace"], "generation", hz, clock=lambda: clock[0])

                    def append(**message):
                        records.append(message)
                        return message["sample"]

                    base.update(recording_observer=recorder.observe, recording_window=recorder, timeline_append=append)
                    functions = load(directory, base)
                    with patch("rsa_tools._context.request") as rpc, redirect_stderr(io.StringIO()) as stderr, scope(base):
                        for index in range(hz * 10):
                            self.assertEqual(functions["sample"](nested), {"text": "frame"})
                            recorder.sampled(2, True)
                            clock[0] = (index + 1) / hz
                            recorder.flush()
                        recorder.flush(reason="stopped")
                    rpc.assert_not_called()
                    self.assertEqual(stderr.getvalue(), "")
                    self.assertEqual([item["type"] for item in events], ["perception_stats"] * 2)
                    self.assertEqual(len(records), hz * 10)
                    self.assertEqual(sum(item["data"]["sample"]["recorded"] for item in events), hz * 10)
                    for item in events:
                        capabilities = item["data"]["capabilities"]
                        self.assertEqual(len(capabilities), 2 if nested else 1)
                        self.assertTrue(all(cap["calls"] == hz * 5 for cap in capabilities))
                        self.assertTrue(all(cap["durationMs"]["min"] is not None for cap in capabilities))
                    self.assertTrue(all(record["trace"]["recordingPurpose"] == "continuous-perception" for record in records))

    def test_full_adds_diagnostics_without_changing_results_or_rpc(self):
        with tempfile.TemporaryDirectory() as directory:
            events, records = [], []
            base = context(directory, diagnostics="full", recording_purpose="continuous-perception")
            base["recording_sink"] = lambda kind, data, trace, origin, channel: events.append((kind, data, channel))
            base["timeline_append"] = lambda **message: records.append(message) or message["sample"]
            functions = load(directory, base)
            with patch("rsa_tools._context.request") as rpc, scope(base):
                self.assertEqual(functions["sample"](), {"text": "frame"})
                with self.assertRaises(ValueError):
                    functions["sample"](fail=True)
            rpc.assert_not_called()
            self.assertEqual(len(records), 1)
            self.assertEqual(len(events), 8)
            self.assertEqual({item[2] for item in events}, {"diagnostic"})
            self.assertTrue(all("traceback" in data for _, data, _ in events if data.get("outcome") == "error"))

    def test_flapping_is_one_interval_per_version_and_category(self):
        with tempfile.TemporaryDirectory() as directory:
            clock, events = [0.0], []
            base = context(directory, recording_purpose="continuous-perception")
            recorder = RecordingWindow(events.append, base["trace"], "generation", 10, clock=lambda: clock[0])
            base.update(recording_observer=recorder.observe, timeline_append=lambda **message: message["sample"])
            functions = load(directory, base)
            with patch("rsa_tools._context.request") as rpc, redirect_stderr(io.StringIO()) as stderr, scope(base):
                for index in range(100):
                    fail = index % 2 == 0
                    try:
                        functions["sample"](fail=fail)
                    except ValueError:
                        self.assertTrue(fail)
                    recorder.sampled(1, not fail)
                    clock[0] = (index + 1) / 10
                    recorder.flush()
                self.assertEqual(len([event for event in events if event["type"] == "perception_fault"]), 2)
                self.assertFalse(any(event["type"] == "perception_fault_end" for event in events))
                for index in range(50):
                    functions["sample"]()
                    recorder.sampled(1, True)
                    clock[0] = 10 + (index + 1) / 10
                    recorder.flush()
            rpc.assert_not_called()
            self.assertEqual(stderr.getvalue(), "")
            recovered = [event["data"] for event in events if event["type"] == "perception_fault_end"]
            self.assertEqual(len(recovered), 2)
            self.assertTrue(all(fault["reason"] == "recovered" and fault["count"] == 50 for fault in recovered))
            stats = [event["data"] for event in events if event["type"] == "perception_stats"]
            self.assertEqual(sum(item["sample"]["failed"] for item in stats), 50)
            self.assertEqual(sum(item["sample"]["completed"] for item in stats), 100)

    def test_ordinary_import_retains_metadata_and_object_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            base = context(directory)
            functions = load(directory, base)
            with patch("rsa_tools._context.request") as rpc, scope(base):
                self.assertEqual(functions["helper"](), "frame")
                with self.assertRaises(ValueError):
                    functions["helper"](True)
            messages = [call.args[1] for call in rpc.call_args_list]
            self.assertEqual([item["event"]["type"] for item in messages], ["python_call_start", "python_call_end"] * 2)
            self.assertTrue(all("channel" not in message["event"] for message in messages))
            self.assertTrue(all("arguments" not in message["event"]["data"] for message in messages))
            self.assertEqual(messages[-1]["event"]["data"]["errorType"], "ValueError")

    def test_driver_boundary_keeps_sampling_purpose_and_recording_owner(self):
        with scope(context(".", recording_purpose="continuous-perception")), patch("rsa_tools.client.request", return_value={"ok": True}) as rpc:
            result = Client(trace={"traceId": "explicit"}).call("gamepad.press", {"keys": ["a"]})
        self.assertEqual(result, {"ok": True})
        wire = rpc.call_args.args[1]
        self.assertEqual(wire["arguments"], {"keys": ["a"]})
        self.assertEqual(wire["trace"], {"traceId": "explicit", "recordingPurpose": "continuous-perception", "recordingId": "host-run"})

    def test_trial_subject_does_not_require_a_persisted_call(self):
        from rsa_tools.benchmarks import Trial
        for continuous, host in ((True, True), (True, False), (False, True), (False, False)):
            with self.subTest(continuous=continuous, host=host), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                artifacts = root / "artifacts"
                artifacts.mkdir()
                input_path = root / "input.json"
                input_path.write_text("{}")
                base = context(root, socket_path="fake.sock" if host else "",
                               recording_purpose="continuous-perception" if continuous else None)
                functions = load(root, base)
                with scope(base):
                    trial = Trial("test", root, artifacts, root, input_path)
                    with patch("rsa_tools._context._trial_observer", trial._observe), patch("rsa_tools._context.request") as rpc:
                        functions["quality"]()
                        trial.flush()
                result = json.loads((artifacts / "context.json").read_text())
                self.assertIn({"id": "python/fixture.py:helper", "revision": hashlib.sha256(SOURCE.encode()).hexdigest()}, result["subjects"])
                self.assertEqual(result["capabilityCalls"][0]["succeeded"], 1)
                self.assertFalse((root / "events.jsonl").exists())
                self.assertEqual(rpc.call_count, 2 if host and not continuous else 0)


if __name__ == "__main__":
    unittest.main()
