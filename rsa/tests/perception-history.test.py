"""Offline checks: timestamped history and a sampler independent of agent reads.

Run: PYTHONPATH=rsa/python python3 rsa/tests/perception-history.test.py
"""

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

from rsa_tools._observation_history import ObservationHistory


class HistoryTests(unittest.TestCase):
    def test_immutable_media_paged_queries_and_generation_reload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "frame.txt"
            history = ObservationHistory(root)
            for index in range(5):
                source.write_text(str(index))
                history.append({"media": [{"path": str(source), "mediaType": "text/plain"}]},
                               "first", {}, f"2026-10-22T00:00:0{index}.000Z")
            source.write_text("overwritten")
            history = ObservationHistory(root)
            history.append({"text": "new generation"}, "second", {}, "2026-10-22T00:00:05.000Z")
            point = history.observe({"at": "2026-10-22T00:00:02.500Z"})["records"][0]
            self.assertEqual(point["sequence"], 3)
            self.assertEqual(Path(point["media"][0]["path"]).read_text(), "2")
            self.assertEqual(history.observe()["records"][0]["generation"], "second")
            query = {"start": "2026-10-22T00:00:01Z", "end": "2026-10-22T00:00:04Z", "limit": 2}
            first = history.observe(query)
            second = history.observe({**query, "after": first["nextAfter"]})
            self.assertEqual([r["sequence"] for r in first["records"] + second["records"]], [2, 3, 4, 5])
            self.assertFalse(second["hasMore"])
            self.assertEqual(history.observe({"at": "2020-01-01T00:00:00Z"})["records"], [])
            for invalid in ({"at": "2026-10-22T00:00:00"}, {"limit": 0}, {"at": "2026-10-22T00:00:00Z", "after": 1}):
                with self.assertRaises(ValueError):
                    history.observe(invalid)

    def test_content_deduplication_and_unfinished_tail_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "frame.txt"
            source.write_text("unchanged")
            history = ObservationHistory(root)
            sample = {"media": [{"path": str(source), "mediaType": "text/plain"}]}
            first = history.append(sample, "one", {})
            second = history.append(sample, "one", {})
            self.assertEqual(first["media"], second["media"])
            with history.path.open("ab") as stream:
                stream.write(b'{"unfinished":')
            recovered = ObservationHistory(root)
            self.assertEqual(recovered.append({"text": "recovered"}, "two", {})["sequence"], 3)
            self.assertEqual(len(list((root / "observations").iterdir())), 1)
            with self.assertRaises(FileNotFoundError):
                recovered.append({"media": [sample["media"][0], {
                    "path": str(root / "missing.txt"), "mediaType": "text/plain",
                }]}, "two", {})
            self.assertEqual(recovered.observe()["records"][0]["sequence"], 3)

    def test_clock_correction_does_not_lose_records_between_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            for second in (3, 1, 2):
                history.append({"text": str(second)}, "one", {}, f"2026-10-22T00:00:0{second}Z")
            first = history.observe({"after": 0, "limit": 1})
            second = history.observe({"after": first["nextAfter"], "limit": 1})
            third = history.observe({"after": second["nextAfter"], "limit": 1})
            self.assertEqual([page["records"][0]["sequence"] for page in (first, second, third)], [1, 2, 3])
            self.assertEqual(history.observe()["records"][0]["sequence"], 3)
            self.assertEqual(history.observe({"at": "2026-10-22T00:00:03Z"})["records"][0]["sequence"], 1)

    def test_slow_sampling_does_not_block_reads_and_close_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = """
import json, time
from pathlib import Path
from rsa_tools._context import current
class Perception:
    sample_hz = 20
    def start(self, context):
        self.context = context
        self.count = 0
    def sample(self):
        Path('sampling').write_text('yes')
        time.sleep(0.3)
        self.count += 1
        print('user stdout stays outside the protocol')
        return {'text': json.dumps({'count': self.count, 'epoch': current()['epoch'], 'trace': current()['trace']})}
    def close(self):
        Path('closed').write_text('yes')
"""
            environment = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "python"),
                           "BASEWARE_EPOCH": "must-not-leak"}
            with (root / "stderr.log").open("w") as stderr:
                process = subprocess.Popen([sys.executable, "-u", "-m", "rsa_tools._perception"], cwd=root,
                                           env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=stderr, text=True)
                incoming = queue.Queue()
                reader = threading.Thread(target=lambda: [incoming.put(json.loads(line)) for line in process.stdout], daemon=True)
                reader.start()

                def send(message):
                    process.stdin.write(json.dumps(message) + "\n")
                    process.stdin.flush()

                def reply(identity):
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        message = incoming.get(timeout=3)
                        if message.get("id") == identity:
                            return message
                    self.fail("worker reply timed out")

                try:
                    send({"id": "start", "action": "start", "workspace": str(root), "runDir": str(root / "run"),
                          "generation": "one", "source": source, "trace": {"traceId": "background", "epoch": "must-not-leak"}})
                    self.assertTrue(reply("start")["ok"])
                    deadline = time.monotonic() + 3
                    while not (root / "sampling").exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    started = time.monotonic()
                    send({"id": "empty", "action": "observe"})
                    self.assertEqual(reply("empty")["result"]["records"], [])
                    self.assertLess(time.monotonic() - started, 0.15)
                    # No observe calls drive the next samples.
                    time.sleep(0.7)
                    send({"id": "later", "action": "observe", "query": {"after": 0}})
                    records = reply("later")["result"]["records"]
                    self.assertGreaterEqual(len(records), 2)
                    self.assertLessEqual(len(records), 3)
                    for record in records:
                        payload = json.loads(record["text"])
                        self.assertIsNone(payload["epoch"])
                        self.assertNotIn("epoch", payload["trace"])
                    send({"id": "bad", "action": "observe", "query": {"limit": -1}})
                    self.assertFalse(reply("bad")["ok"])
                    send({"id": "alive", "action": "observe"})
                    self.assertTrue(reply("alive")["ok"])
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                    process.stdin.close()
                    process.stdout.close()
                    reader.join(timeout=1)
                self.assertEqual(process.returncode, 0)
                self.assertEqual((root / "closed").read_text(), "yes")


if __name__ == "__main__":
    unittest.main()
