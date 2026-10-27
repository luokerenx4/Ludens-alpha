"""Offline checks: timestamped history and a sampler independent of agent reads.

Run: PYTHONPATH=rsa/python python3 rsa/tests/perception-history.test.py
"""

import base64
import json
import gc
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import tracemalloc
import unittest
from unittest.mock import patch

from rsa_tools._observation_history import ObservationHistory


SAMPLING = {"clock": "test", "startedAtMs": 0, "finishedAtMs": 1}

class HistoryTests(unittest.TestCase):
    def test_immutable_media_paged_queries_and_generation_reload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "frame.txt"
            history = ObservationHistory(root)
            for index in range(5):
                source.write_text(str(index))
                history.append({"media": [{"path": str(source), "mediaType": "text/plain"}]},
                               "first", SAMPLING, f"2026-10-22T00:00:0{index}.000Z")
            source.write_text("overwritten")
            history.close()
            history = ObservationHistory(root)
            history.append({"text": "new generation"}, "second", SAMPLING, "2026-10-22T00:00:05.000Z")
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
            first = history.append(sample, "one", SAMPLING)
            second = history.append(sample, "one", SAMPLING)
            self.assertEqual(first["media"][0]["path"], second["media"][0]["path"])
            self.assertNotEqual(first["timeline"], second["timeline"])
            records_path = Path(history._active["path"]).with_suffix(".jsonl")
            # A crash can leave a committed payload without its index/summary,
            # followed by an incomplete final write. Recover only complete rows.
            third = {**second, "sequence": 3, "text": "unindexed complete row"}
            with records_path.open("ab") as stream:
                stream.write((json.dumps(third) + "\n").encode())
                stream.write(b'{"unfinished":')
            history.close()
            recovered = ObservationHistory(root)
            self.assertEqual(recovered.append({"text": "recovered"}, "two", SAMPLING)["sequence"], 4)
            self.assertEqual(len(list(root.glob(".rsa/timeline/objects/*"))), 1)
            self.assertEqual([row["sequence"] for row in recovered.observe({"after": 0})["records"]], [1, 2, 3, 4])
            with self.assertRaises(FileNotFoundError):
                recovered.append({"media": [sample["media"][0], {
                    "path": str(root / "missing.txt"), "mediaType": "text/plain",
                }]}, "two", SAMPLING)
            self.assertEqual(recovered.observe()["records"][0]["sequence"], 4)

    def test_defaults_and_old_run_history_remains_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / "perception/history/records.jsonl"
            legacy.parent.mkdir(parents=True)
            rows = [{"id": str(i), "sequence": i, "generation": "legacy",
                     "recordedAt": f"2026-10-22T00:00:0{i}Z", "sampling": {},
                     "text": str(i), "media": []} for i in (1, 2)]
            original = b"".join((json.dumps(row) + "\n").encode() for row in rows) + b'{"unfinished":'
            legacy.write_bytes(original)
            history = ObservationHistory(root)
            self.assertEqual(history.policy(), {"persistent": True, "hotSeconds": 600,
                             "hotBytes": 67108864, "segmentSeconds": 3600, "segmentBytes": 268435456})
            self.assertEqual(len(history._hot), 0)
            history.append({"text": "new"}, "new", SAMPLING, "2026-10-22T00:00:03Z")
            history.close()
            recovered = ObservationHistory(root)
            self.assertEqual([row["sequence"] for row in recovered.observe({"after": 0})["records"]], [1])
            self.assertEqual(recovered.observe({"at": "2026-10-22T00:00:01Z"})["records"], [])
            self.assertEqual(legacy.read_bytes(), original)

    def test_hot_expiry_hourly_segments_and_cold_pages_after_reload(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                "RSA_PERCEPTION_HOT_SECONDS": "10", "RSA_PERCEPTION_SEGMENT_SECONDS": "3600"}):
            clock = [0.0]
            with patch("rsa_tools._observation_history.time.monotonic", side_effect=lambda: clock[0]):
                history = ObservationHistory(directory)
                for minute in range(0, 180, 15):
                    clock[0] += 1
                    history.append({"text": str(minute)}, "one", SAMPLING,
                                   f"2026-10-22T{minute // 60:02}:{minute % 60:02}:00Z")
                self.assertEqual(len(list(history.segment_dir.glob("*.jsonl"))), 3)
                clock[0] += 11
                history.prune()  # Also evicts when no further samples arrive.
                self.assertEqual(history.hot_bytes, 0)
                self.assertEqual(len(history._hot), 0)
                point = history.observe({"at": "2026-10-22T00:37:00Z"})
                self.assertEqual(point["records"][0]["text"], "30")
                history.close()
                reloaded = ObservationHistory(directory)
                self.assertEqual(len(reloaded._hot), 0)
                result, after = [], 0
                while True:
                    page = reloaded.observe({"start": "2026-10-22T00:45:00Z",
                                             "end": "2026-10-22T02:30:00Z", "after": after, "limit": 3})
                    result.extend(int(row["text"]) for row in page["records"])
                    if not page["hasMore"]:
                        break
                    after = page["nextAfter"]
                self.assertEqual(result, list(range(45, 151, 15)))
                self.assertEqual(reloaded.observe()["records"][0]["text"], "165")
                self.assertFalse(page["availability"]["expired"])

    def test_window_only_expiry_inline_delivery_and_source_media_ownership(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                "RSA_PERCEPTION_PERSIST": "0", "RSA_PERCEPTION_HOT_SECONDS": "10"}):
            root, clock = Path(directory), [0.0]
            source = root / "source.png"
            source.write_bytes(b"compressed frame")
            with patch("rsa_tools._observation_history.time.monotonic", side_effect=lambda: clock[0]):
                history = ObservationHistory(root)
                saved = history.append({"media": [{"path": str(source), "mediaType": "image/png"}]},
                                       "one", SAMPLING, "2026-10-22T00:00:00Z")
                copied = Path(saved["media"][0]["path"])
                self.assertNotEqual(copied, source)
                page = history.observe()  # Delivery owns inline bytes before expiry.
                clock[0] = 11
                history.prune()
                self.assertEqual(history.hot_bytes, 0)
                self.assertFalse(copied.exists())
                self.assertEqual(base64.b64decode(page["records"][0]["media"][0]["data"]), b"compressed frame")
                expired = history.observe({"at": "2026-10-22T00:00:00Z"})
                self.assertEqual(expired["records"], [])
                self.assertTrue(expired["availability"]["expired"])
                self.assertIsNone(expired["availability"]["earliest"])
                self.assertFalse(copied.exists())
                self.assertTrue(source.exists())
                self.assertEqual(list(history.segment_dir.glob("*")), [])
                saved = history.append({"media": [{"path": str(source), "mediaType": "image/png"}]},
                                       "one", SAMPLING, "2026-10-22T00:00:11Z")
                copied = Path(saved["media"][0]["path"])
                page = history.observe()
                clock[0] = 22
                history.prune()
                self.assertFalse(copied.exists())
                self.assertEqual(base64.b64decode(page["records"][0]["media"][0]["data"]), b"compressed frame")
                history.close()
                self.assertFalse(list((root / ".rsa/timeline").glob("window-*")))
                reloaded = ObservationHistory(root)
                self.assertEqual(reloaded.append({"text": "new generation"}, "two", SAMPLING)["sequence"], 3)
                self.assertEqual(len(reloaded.observe({"after": 0})["records"]), 1)
                reloaded.close()

    def test_window_cleanup_never_removes_a_live_instances_files(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RSA_PERCEPTION_PERSIST": "0"}):
            history = ObservationHistory(directory)
            live = history._temporary
            marker = live / "marker"
            marker.write_text("live")
            dead = live.parent / "window-999999-abandoned"
            dead.mkdir()
            (dead / "marker").write_text("dead")
            real_kill = os.kill

            def owner_status(pid, signal):
                if pid == 999999:
                    raise ProcessLookupError()
                return real_kill(pid, signal)

            with self.assertRaisesRegex(RuntimeError, "already has a writer"):
                ObservationHistory(directory)
            self.assertTrue(marker.exists())
            self.assertTrue(dead.exists())
            history.close()
            with patch("rsa_tools._observation_history.os.kill", new=owner_status):
                other = ObservationHistory(directory)
            self.assertFalse(dead.exists())
            other.close()

    def test_hot_byte_budget_and_process_allocations_do_not_follow_total_history(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                "RSA_PERCEPTION_HOT_BYTES": "65536", "RSA_PERCEPTION_SEGMENT_BYTES": "262144"}):
            history = ObservationHistory(directory)
            tracemalloc.start()
            try:
                for index in range(300):
                    history.append({"text": "x" * 2048}, "one", SAMPLING)
                gc.collect()
                warm = tracemalloc.get_traced_memory()[0]
                for index in range(1200):
                    history.append({"text": "x" * 2048}, "one", SAMPLING)
                gc.collect()
                final, peak = tracemalloc.get_traced_memory()
                self.assertLessEqual(history.hot_bytes, 65536)
                self.assertLess(final - warm, 512 * 1024)
                self.assertLess(peak, 2 * 1024 * 1024)
                self.assertGreater(len(history._segments), 10)
                history.close()
                reloaded = ObservationHistory(directory)
                self.assertEqual(len(reloaded._hot), 0)
                page = reloaded.observe({"after": 10, "limit": 2})
                self.assertEqual([row["sequence"] for row in page["records"]], [11, 12])
                self.assertEqual(reloaded.observe()["records"][0]["sequence"], 1500)
            finally:
                tracemalloc.stop()

    def test_optional_tool_fields_and_real_query_conflicts(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            for second in range(3):
                history.append({"text": str(second)}, "one", SAMPLING, f"2026-10-22T06:45:5{second}Z")
            # Replay the populated-but-unused fields observed in real tool calls.
            ranged = history.observe({"at": "", "start": "2026-10-22T06:45:50Z",
                                      "end": "2026-10-22T06:45:52Z", "limit": 2, "after": 0})
            self.assertEqual([r["sequence"] for r in ranged["records"]], [1, 2])
            self.assertNotIn("at", ranged["query"])
            self.assertEqual(ranged["nextAfter"], 2)
            point = history.observe({"at": "2026-10-22T06:45:50Z", "start": "",
                                     "end": " ", "limit": 1, "after": 0})
            self.assertEqual(point["records"][0]["sequence"], 1)
            self.assertEqual(point["query"], {"at": "2026-10-22T06:45:50Z", "limit": 1})
            latest = history.observe(dict.fromkeys(("at", "start", "end", "limit", "after")))
            self.assertEqual(latest["records"][0]["sequence"], 3)
            self.assertEqual(latest["query"], {})
            # Zero alone is still a range cursor, never an alias for latest.
            self.assertEqual(history.observe({"after": 0, "limit": 1})["records"][0]["sequence"], 1)
            for invalid in (
                {"at": "2026-10-22T06:45:50Z", "start": "2026-10-22T06:45:50Z"},
                {"at": "2026-10-22T06:45:50Z", "after": 1},
                {"at": "2026-10-22T06:45:50Z", "after": False},
                {"at": "not-a-time"}, {"start": "2026-10-22T06:45:50"},
                {"start": "2026-10-22T06:45:52Z", "end": "2026-10-22T06:45:50Z"},
                {"limit": ""}, {"unknown": None},
            ):
                with self.subTest(query=invalid), self.assertRaises(ValueError):
                    history.observe(invalid)

    def test_clock_correction_does_not_lose_records_between_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            for second in (3, 1, 2):
                history.append({"text": str(second)}, "one", SAMPLING, f"2026-10-22T00:00:0{second}Z")
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
from rsa_tools import perception, record
class Perception:
    sample_hz = 20
    def start(self, context):
        self.context = context
        self.count = 0
    @record
    @perception
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
