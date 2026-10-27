"""Offline workspace timeline contracts, including independent Python callers.

PYTHONPATH=rsa/python python3 rsa/tests/timeline.test.py
"""

import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import queue
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

from rsa_tools._capabilities import discover, load_function, call_local
from rsa_tools._context import scope
from rsa_tools._observation_history import ObservationHistory, observation_result, MAIN_CAPABILITY


SAMPLING = {"clock": "test", "startedAtMs": 0, "finishedAtMs": 1}

PYTHON_PATH = str(Path(__file__).resolve().parents[1] / "python")


class Worker:
    def __init__(self, root, source=None, generation="one", run="run-one", source_error=None):
        self.root = Path(root)
        self.pending, self.events = {}, queue.Queue()
        self.lock = threading.Lock()
        self.stderr = (self.root / (run + "-stderr.txt")).open("w")
        self.process = subprocess.Popen([sys.executable, "-u", "-m", "rsa_tools._perception"],
            cwd=root, env={**os.environ, "PYTHONPATH": PYTHON_PATH, "RSA_SOCKET": "", "BASEWARE_EPOCH": ""},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, text=True)
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        self.started = self.request(action="start", workspace=str(root), runDir=str(self.root / run),
                                    generation=generation, source=source, sourceError=source_error, trace={"traceId": "sampler"})

    def read(self):
        for line in self.process.stdout:
            value = json.loads(line)
            if "event" in value:
                self.events.put(value)
            else:
                self.pending[value["id"]].put(value)

    def request(self, **message):
        identity, response = str(uuid.uuid4()), queue.Queue()
        with self.lock:
            self.pending[identity] = response
            self.process.stdin.write(json.dumps({**message, "id": identity}) + "\n")
            self.process.stdin.flush()
        reply = response.get(timeout=5)
        del self.pending[identity]
        return reply

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.process.stdin.close()
            self.process.stdout.close()
            self.reader.join(timeout=1)
            self.stderr.close()


SOURCE = '''from rsa_tools import perception, record
class Perception:
    sample_hz = 50
    def start(self, context): self.count = 0
    @record
    @perception
    def sample(self):
        self.count += 1
        return {"data": {"tick": self.count}}
    def close(self): pass
'''


class TimelineTests(unittest.TestCase):
    def test_generic_data_channels_record_lookup_and_cross_segment_objects(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RSA_PERCEPTION_SEGMENT_BYTES": "1"}):
            root = Path(directory)
            (root / "sample.wav").write_bytes(b"one immutable sensor payload")
            history = ObservationHistory(root)
            image = history.append({"media": [{"path": "sample.wav", "mediaType": "audio/wav"}],
                                    "data": {"entities": [], "value": None}, "space": {"frame": "sensor-a"}},
                                   "generation-one", SAMPLING, "2026-10-27T01:00:00Z", run_id="run-one")
            sensor = history.append({"media": [{"data": base64.b64encode((root / "sample.wav").read_bytes()).decode(), "mediaType": "application/octet-stream"}],
                                     "data": 22.5, "sampledAt": "2026-10-27T00:00:00Z"},
                                    "generation-one", SAMPLING, "2026-10-27T02:00:00Z", identity={"id": "python/temperature.py:sample"}, run_id="run-two")
            self.assertEqual(len(list(history.segment_dir.glob("*.jsonl"))), 2)
            self.assertEqual(len(list(history.objects.iterdir())), 1)
            self.assertEqual(image["media"][0]["path"], sensor["media"][0]["path"])
            self.assertEqual(history.observe()["records"][0]["id"], image["id"])
            self.assertEqual(history.observe({"capability": "python/temperature.py:sample"})["records"][0]["data"], 22.5)
            self.assertEqual(history.observe({"id": sensor["id"]})["records"][0]["id"], sensor["id"])
            self.assertEqual(len(history.observe({"capability": "*", "after": 0})["records"]), 2)
            history.close()
            reopened = ObservationHistory(root)
            self.assertEqual(reopened.observe()["records"][0]["space"], {"frame": "sensor-a"})
            self.assertEqual(reopened.observe({"id": sensor["id"]})["records"][0]["runId"], "run-two")
            self.assertEqual(Path(sensor["media"][0]["path"]).read_bytes(), b"one immutable sensor payload")

    def test_decorators_discovery_direct_import_local_client_nested_and_loaded_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = '''from rsa_tools import perception as sense, record, capability
MODEL = object()
@record
@sense
def leaf() -> dict:
    """Read a temperature."""
    return {"data": {"temperature": 23}}
@sense()
@record()
def parent() -> dict:
    """Combine a recorded temperature."""
    reading = leaf()
    return {"data": [reading["data"]], "sources": [reading["timeline"]]}
@sense
def plain() -> dict:
    """Read without retaining a record."""
    return {"data": False}
class Reader:
    @record
    @sense
    def sample(self): return {"data": 1}
@record
@capability
def invalid():
    """An invalid standalone recording declaration."""
    return {}
'''
            path = root / "sensing.py"
            path.write_text(source)
            catalog = discover(root)
            self.assertEqual(len(catalog["capabilities"]), 3)
            self.assertEqual(len(catalog["diagnostics"]), 1)
            self.assertIn("requires @perception", catalog["diagnostics"][0]["message"])
            entries = {entry["origin"]["function"]: entry for entry in catalog["capabilities"]}
            self.assertTrue(entries["leaf"]["perception"])
            self.assertTrue(entries["parent"]["recorded"])
            self.assertFalse(entries["plain"]["recorded"])
            history = ObservationHistory(root)
            def append(**message):
                return observation_result(history.append(message["sample"], message["generation"], message["sampling"],
                    identity=message["identity"], run_id=message["runId"], trace=message["trace"]))
            context = {"workspace": str(root), "run_id": "run-one", "socket_path": None, "epoch": None,
                       "trace": {}, "timeout": None, "generation": "g", "timeline_append": append}
            with scope(context):
                parent = load_function(root, "sensing.py", "parent")
                self.assertEqual(parent()["data"], [{"temperature": 23}])
                call_local(root, "python/sensing.py:leaf", {})
                self.assertEqual(call_local(root, "python/sensing.py:plain", {}), {"data": False})
                module = sys.modules[parent.__module__]
                module.Reader().sample()
                path.write_text(source + "\n# Edited after import; not loaded.\n")
                parent()
                with self.assertRaisesRegex(ValueError, "requires @perception"):
                    module.invalid()
            records = history.observe({"after": 0, "capability": "*"})["records"]
            self.assertEqual(len(records), 6)
            self.assertEqual(records[1]["sources"], [records[0]["timeline"]])
            self.assertEqual(records[0]["trace"]["parentSpanId"], records[1]["trace"]["spanId"])
            self.assertTrue(all(row["identity"]["codeSHA"] == hashlib.sha256(source.encode()).hexdigest() for row in records))
            self.assertEqual(records[3]["capability"], "python/sensing.py:Reader.sample")
            self.assertEqual(records[-1]["runId"], "run-one")

    def test_rejects_invalid_envelopes_without_committing_a_record(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            for sample in (3, {"unknown": True}, {"data": float("nan")}, {"media": [{"mediaType": "image/png", "data": "invalid!"}]}):
                with self.assertRaises((ValueError, TypeError)):
                    history.append(sample, "g", SAMPLING)
            self.assertEqual(history.observe({"capability": "*", "after": 0})["records"], [])
            self.assertEqual(history.sequence, 0)

    def test_sampling_requires_finite_clock_domain_and_ordered_times(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            invalid = [None, {}, {**SAMPLING, "clock": " "}, {**SAMPLING, "clock": 1},
                       {**SAMPLING, "startedAtMs": True}, {**SAMPLING, "startedAtMs": "0"},
                       {**SAMPLING, "finishedAtMs": float("inf")}, {**SAMPLING, "startedAtMs": float("nan")},
                       {**SAMPLING, "finishedAtMs": 10 ** 400}, {**SAMPLING, "finishedAtMs": -1},
                       {**SAMPLING, "extra": 1}]
            for sampling in invalid:
                with self.subTest(sampling=sampling), self.assertRaises(ValueError):
                    history.append({"data": 1}, "g", sampling)
            self.assertEqual(history.sequence, 0)
            self.assertEqual(list(history.segment_dir.glob("*")), [])
            self.assertEqual(history.append({"data": 2}, "g", SAMPLING)["sequence"], 1)
            history.close()
            with self.assertRaisesRegex(RuntimeError, "closed"):
                history.append({"data": 3}, "g", SAMPLING)

    def test_second_process_writer_is_rejected_and_lock_survives_crash_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Worker(directory)
            second = Worker(directory, run="run-two")
            try:
                self.assertTrue(first.started["ok"])
                self.assertFalse(second.started["ok"])
                self.assertIn("already has a writer", second.started["error"]["message"])
                result = first.request(action="append", sample={"data": 1}, identity={"id": "python/sensor.py:read"}, sampling=SAMPLING)
                self.assertEqual(result["result"]["timeline"]["sequence"], 1)
                first.process.kill()
                first.process.wait(timeout=5)
                restarted = second.request(action="start", workspace=directory, runDir=str(Path(directory) / "run-two"), generation="two")
                self.assertTrue(restarted["ok"])
                result = second.request(action="append", sample={"data": 2}, identity={"id": "python/sensor.py:read"}, sampling=SAMPLING)
                self.assertEqual(result["result"]["timeline"]["sequence"], 2)
                rows = second.request(action="observe", query={"capability": "*", "after": 0})["result"]["records"]
                self.assertEqual([row["data"] for row in rows], [1, 2])
            finally:
                first.close()
                second.close()

    def test_source_read_failure_preserves_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = Worker(directory, source_error="PermissionError: perception.py is unreadable")
            try:
                self.assertTrue(worker.started["ok"])
                self.assertEqual(worker.started["result"]["state"], "error")
                self.assertIn("unreadable", worker.started["result"]["error"])
                result = worker.request(action="append", sample={"data": 1}, identity={"id": "python/sensor.py:read"}, sampling=SAMPLING)
                self.assertTrue(result["ok"])
                rows = worker.request(action="observe", query={"capability": "*", "after": 0})["result"]["records"]
                self.assertEqual([row["data"] for row in rows], [1])
            finally:
                worker.close()

    def test_async_main_sample_is_rejected_without_disabling_timeline(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = Worker(directory, SOURCE.replace("def sample(self):", "async def sample(self):"))
            try:
                self.assertTrue(worker.started["ok"])
                self.assertEqual(worker.started["result"]["state"], "error")
                self.assertIn("must be synchronous", worker.started["result"]["error"])
                self.assertEqual(worker.request(action="observe")["result"]["records"], [])
                self.assertTrue(worker.request(action="append", sample={"data": 1}, identity={"id": "python/sensor.py:read"}, sampling=SAMPLING)["ok"])
            finally:
                worker.close()

    def test_window_delivery_survives_immediate_eviction_without_persistent_objects(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RSA_PERCEPTION_PERSIST": "0", "RSA_PERCEPTION_HOT_BYTES": "1"}):
            history = ObservationHistory(directory)
            record = history.append({"media": [{"mediaType": "audio/wav", "data": "YWJj"}]}, "g", SAMPLING)
            self.assertEqual(base64.b64decode(record["media"][0]["data"]), b"abc")
            self.assertFalse(Path(record["media"][0]["path"]).exists())
            self.assertFalse(history.objects.exists())
            self.assertEqual(history.observe()["records"], [])
            history.close()

    def test_source_load_failure_preserves_query_and_external_recording_across_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = Worker(directory, "raise RuntimeError('broken user module')")
            try:
                self.assertTrue(worker.started["ok"])
                self.assertEqual(worker.started["result"]["state"], "error")
                append = worker.request(action="append", sample={"data": {"ready": True}}, identity={"id": "python/sensor.py:read", "codeSHA": "loaded-version"},
                                        sampling={"clock": "caller", "startedAtMs": 1, "finishedAtMs": 2}, runId="external-run", trace={"traceId": "caller"})
                self.assertTrue(append["ok"])
                identity = append["result"]["timeline"]["recordId"]
                row = worker.request(action="observe", query={"id": identity})["result"]["records"][0]
                self.assertEqual(row["data"], {"ready": True})
                self.assertEqual(row["runId"], "external-run")
            finally:
                worker.close()
            second = Worker(directory, None, generation="two", run="run-two")
            try:
                self.assertEqual(second.started["result"]["state"], "unimplemented")
                rows = second.request(action="observe", query={"id": identity})["result"]["records"]
                self.assertEqual(rows[0]["runId"], "external-run")
            finally:
                second.close()

    def test_sampler_and_external_python_callers_share_one_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker = Worker(root, SOURCE)
            socket_path = "/tmp/rsa-timeline-test-" + uuid.uuid4().hex[:12] + ".sock"
            class Handler(socketserver.StreamRequestHandler):
                def handle(self):
                    message = json.loads(self.rfile.readline())
                    if message["kind"] == "timeline":
                        self.server.messages.append(message)
                        response = worker.request(**{key: value for key, value in message.items() if key not in ("kind", "argv")})
                        reply = {"ok": response["ok"], "value": response.get("result"), "error": response.get("error")}
                    else:
                        reply = {"ok": True, "value": None}
                    self.wfile.write((json.dumps(reply) + "\n").encode())
            server = socketserver.ThreadingUnixStreamServer(socket_path, Handler)
            server.messages = []
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            (root / "external.py").write_text('''from rsa_tools import perception, record
@record
@perception
def sensor(value: int) -> dict:
    """Read an independent sensor."""
    return {"data": value}
''')
            command = 'from external import sensor; import json; print(json.dumps([sensor(i) for i in range(8)]))'
            environment = {**os.environ, "PYTHONPATH": PYTHON_PATH, "RSA_SOCKET": socket_path, "RSA_WORKSPACE": str(root), "RSA_RUN_ID": "external-run"}
            try:
                with ThreadPoolExecutor(max_workers=3) as pool:
                    results = list(pool.map(lambda _: subprocess.run([sys.executable, "-c", command], cwd=root, env=environment,
                        capture_output=True, text=True, timeout=10), range(3)))
                self.assertEqual([result.returncode for result in results], [0, 0, 0], [result.stderr for result in results])
                refs = [row["timeline"] for result in results for row in json.loads(result.stdout)]
                self.assertEqual(len({row["sequence"] for row in refs}), 24)
                self.assertEqual(len(server.messages), 24)
                rows = worker.request(action="observe", query={"capability": "*", "after": 0, "limit": 64})["result"]["records"]
                self.assertEqual([row["sequence"] for row in rows], list(range(1, len(rows) + 1)))
                self.assertEqual(sum(row["capability"] == "python/external.py:sensor" for row in rows), 24)
                self.assertTrue(any(row["capability"] == MAIN_CAPABILITY for row in rows))
                self.assertEqual(worker.request(action="observe")["result"]["records"][0]["capability"], MAIN_CAPABILITY)
            finally:
                server.shutdown()
                server.server_close()
                serving.join(timeout=2)
                Path(socket_path).unlink(missing_ok=True)
                worker.close()


if __name__ == "__main__":
    unittest.main()
