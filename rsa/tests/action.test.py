"""Resident action uses ordinary capabilities and the existing timeline writer."""

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

from rsa_tools import Client, capability
from rsa_tools._capabilities import discover
from rsa_tools._context import current, scope
from rsa_tools._recording import RecordingWindow


class Worker:
    def __init__(self, root, role, source, *, generation="generation-one", socket_path=None):
        self.root, self.role = root, role
        self.messages, self.pending, self.lock = [], {}, threading.Lock()
        self.stderr = (root / f"{role}-{generation}.stderr").open("w")
        env = {**os.environ, "RSA_WORKSPACE": str(root), "BASEWARE_TRACE": "{}"}
        if socket_path:
            env["RSA_SOCKET"] = socket_path
        self.process = subprocess.Popen([sys.executable, "-u", "-m", f"rsa_tools._{role}"],
            cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, text=True)

        def read():
            for line in self.process.stdout:
                message = json.loads(line)
                self.messages.append(message)
                if message.get("id") in self.pending:
                    self.pending[message["id"]].put(message)

        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        self.started = self.request(action="start", workspace=str(root), runDir=str(root / "logs" / "run"),
            generation=generation, source=source, diagnostics="normal", epoch="fixed-epoch",
            trace={"recordingId": "run", "inputGeneration": generation})

    def request(self, **fields):
        identity = str(time.monotonic_ns())
        response = queue.Queue()
        self.pending[identity] = response
        with self.lock:
            self.process.stdin.write(json.dumps({"id": identity, **fields}) + "\n")
            self.process.stdin.flush()
        reply = response.get(timeout=5)
        del self.pending[identity]
        return reply

    def wait(self, predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.01)
        raise AssertionError("Worker did not reach the expected state")

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=4)
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
            self.process.stdin.close()
            self.reader.join(timeout=1)
            self.process.stdout.close()
            self.stderr.close()


PERCEPTION = '''from rsa_tools import capability, record
class Perception:
    sample_hz = 30
    def start(self, context): self.count = 0
    @record
    @capability
    def sample(self):
        self.count += 1
        return {"data": {"frame": self.count}}
    def close(self): pass
'''

ACTION = '''from pathlib import Path
import json
from rsa_tools import Client, capability, record
from rsa_tools._context import current
from helper import identify
@record
@capability
def decision(count: int, source: dict) -> dict:
    """Record the decision and the perception it used."""
    return {"data": {"count": count, "version": identify()}, "sources": [source]}
class Action:
    step_hz = 30
    def start(self, context):
        self.count = 0
        self.model = object()
        self.client = Client(trace={"traceId": "custom"})
    @capability
    def step(self):
        self.count += 1
        view = self.client.observe()
        decision(self.count, view["records"][0]["timeline"])
        Path("steps").write_text(str(self.count))
        if self.count == 3:
            raise RuntimeError("failed after a recorded decision")
        return self.model
    def close(self):
        Path("closed").write_text(json.dumps({"count": self.count, "trace": current()["trace"]}))
'''


class ActionTests(unittest.TestCase):
    def test_manual_history_query_omits_absent_epoch(self):
        with scope({**current(), "epoch": None}), patch("rsa_tools.client.request", return_value={"records": []}) as rpc:
            self.assertEqual(Client().observe({"after": 1}), {"records": []})
        self.assertNotIn("epoch", rpc.call_args.args[1])
        self.assertEqual(rpc.call_args.args[1]["query"], {"after": 1})

    def test_two_residents_share_history_and_action_failure_never_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            helper = 'from rsa_tools import capability\n@capability\ndef identify(): return "loaded-v1"\n'
            (root / "helper.py").write_text(helper)
            perception = Worker(root, "perception", PERCEPTION)
            perception.wait(lambda: any(x.get("event") == "sample" for x in perception.messages))
            socket_path = str(root / "host.sock")
            received = []

            class Handler(socketserver.StreamRequestHandler):
                def handle(self):
                    message = json.loads(self.rfile.readline())
                    received.append(message)
                    if message["kind"] == "perception":
                        response = perception.request(action="observe", query=message["query"])
                    elif message["kind"] == "timeline":
                        response = perception.request(**{k: v for k, v in message.items() if k not in ("kind", "argv")})
                    else:
                        raise AssertionError("Unexpected per-call logging RPC")
                    self.wfile.write((json.dumps({"ok": response["ok"], "value": response.get("result"),
                        "error": response.get("error")}) + "\n").encode())

            server = socketserver.ThreadingUnixStreamServer(socket_path, Handler)
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            action = None
            try:
                action = Worker(root, "action", ACTION, socket_path=socket_path)
                self.assertTrue(action.started["ok"])
                self.assertEqual(action.started["result"]["stepHz"], 30)
                action.wait(lambda: any(x.get("state") == "error" for x in action.messages))
                time.sleep(.1)
                self.assertEqual((root / "steps").read_text(), "3")
                rows = perception.request(action="observe", query={"capability": "python/action.py:decision", "after": 0})["result"]["records"]
                self.assertEqual([x["data"]["count"] for x in rows], [1, 2, 3])
                self.assertTrue(all(x["data"]["version"] == "loaded-v1" for x in rows))
                self.assertTrue(all(x["trace"]["epoch"] == "fixed-epoch" for x in rows))
                self.assertTrue(all(x["trace"]["inputGeneration"] == "generation-one" for x in rows))
                for message in received:
                    self.assertEqual(message["trace"]["recordingPurpose"], "continuous-action")
                    self.assertEqual(message["trace"]["inputGeneration"], "generation-one")
                self.assertEqual(len(received), 6)
                self.assertEqual(perception.request(action="observe")["result"]["records"][0]["capability"], "python/perception.py:Perception.sample")
                stats = [x for x in action.messages if x.get("type") == "action_stats"]
                self.assertEqual(len(stats), 1)
                self.assertEqual(stats[0]["data"]["step"]["recorded"], 3)
                self.assertEqual(stats[0]["data"]["step"]["failed"], 1)
                self.assertFalse(any(x.get("type", "").startswith("python_call") for x in action.messages))
                manifest = json.loads((root / "logs/run/action/generation-one/sources.json").read_text())
                self.assertEqual(manifest["helper.py"], hashlib.sha256(helper.encode()).hexdigest())
                self.assertEqual(manifest["action.py"], hashlib.sha256(ACTION.encode()).hexdigest())
                before = len(perception.messages)
                action.close()
                self.assertEqual(json.loads((root / "closed").read_text())["count"], 3)
                self.assertIsNone(perception.process.poll())
                perception.wait(lambda: len(perception.messages) > before)
            finally:
                if action and action.process.poll() is None:
                    action.close()
                server.shutdown()
                server.server_close()
                serving.join(timeout=1)
                perception.close()

    def test_capability_methods_preserve_objects_without_becoming_cli_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = '''from rsa_tools import capability, record, benchmark
MODEL = object()
@capability
def model():
    """Reuse an in-memory object."""
    return MODEL
class Action:
    @capability
    def step(self): return MODEL
    @record
    @capability
    def saved(self): return {"data": True}
@benchmark(targets=["python/program.py:Action.step"])
def quality():
    """Measure the actual local action capability."""
    value = Action().step()
    return {"metrics": {"same_model": {"value": int(value is MODEL), "unit": "flag"}}}
'''
            (root / "program.py").write_text(source)
            catalog = discover(root)
            self.assertEqual(catalog["diagnostics"], [])
            self.assertEqual([x["origin"]["function"] for x in catalog["capabilities"]], ["model"])
            namespace = {"__name__": "program", "__file__": str(root / "program.py")}
            with scope({**current(), "workspace": str(root), "run_id": None, "socket_path": None,
                        "recording_purpose": "continuous-action"}), patch.dict(os.environ, {"RSA_ARTIFACT_ROOT": str(root / "index")}):
                exec(compile(source, str(root / "program.py"), "exec"), namespace)
                self.assertIs(namespace["model"](), namespace["MODEL"])
                self.assertIs(namespace["Action"]().step(), namespace["MODEL"])
                namespace["quality"]()
            result = json.loads(next((root / "logs").glob("*/benchmark.json")).read_text())
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["subjects"], [{"id": "python/program.py:Action.step",
                "revision": hashlib.sha256(source.encode()).hexdigest()}])

    def test_action_tick_statistics_do_not_scale_with_frequency(self):
        for hz in (1, 10, 30):
            with self.subTest(hz=hz):
                clock, events = [0.0], []
                parent = {**current(), "workspace": str(Path.cwd()), "socket_path": "not-used.sock", "run_id": "run",
                    "epoch": "one", "trace": {"recordingPurpose": "continuous-action", "inputGeneration": "old"},
                    "recording_purpose": "continuous-action", "diagnostics": "normal"}
                window = RecordingWindow(events.append, parent["trace"], "old", hz,
                    clock=lambda: clock[0], role="action")
                parent.update(recording_observer=window.observe)
                @capability
                def step(): return object()
                with scope(parent), patch("rsa_tools._context.request") as rpc:
                    for index in range(hz * 10):
                        step()
                        window.sampled(1, True)
                        clock[0] = (index + 1) / hz
                        window.flush()
                    window.flush(reason="stopped")
                rpc.assert_not_called()
                self.assertEqual([x["type"] for x in events], ["action_stats"] * 2)
                self.assertEqual(sum(x["data"]["step"]["completed"] for x in events), hz * 10)


if __name__ == "__main__":
    unittest.main()
