"""Real PyAV encoding at the timeline boundary, without a device or model."""

import base64
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from PIL import Image, UnidentifiedImageError

from rsa_tools._observation_history import ObservationHistory
from rsa_tools._video import VideoRecorder, _Segment, decode_frame


SAMPLING = {"clock": "fixture", "startedAtMs": 0, "finishedAtMs": 1}


def png(color=(200, 40, 60), size=(31, 25)):
    output = BytesIO()
    Image.new("RGB", size, color).save(output, format="PNG")
    return output.getvalue()


def sample(*images):
    return {"media": [{"mediaType": "image/png", "data": base64.b64encode(raw).decode()} for raw in images]}


class VideoHistoryTests(unittest.TestCase):
    def assert_picture(self, raw, color, size=(31, 25)):
        image = Image.open(BytesIO(raw)).convert("RGB")
        self.assertEqual(image.size, size)
        actual = image.getpixel((size[0] // 2, size[1] // 2))
        self.assertLess(max(abs(left - right) for left, right in zip(actual, color)), 8)

    def test_two_channels_actual_timestamps_cold_queries_and_no_image_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            history = ObservationHistory(root)
            colors = [(200, 40, 60), (40, 160, 90), (70, 80, 190)]
            records = []
            for at, color in zip(("00.000", "00.120", "00.350"), colors):
                raw = png(color)
                result = history.append(sample(raw, png((50, 60, 70), (32, 24))), "one", SAMPLING,
                                        "2026-10-27T00:00:" + at + "Z")
                self.assertEqual(base64.b64decode(result["media"][0]["data"]), raw)
                records.append(result)
            source = records[0]["media"][0]["timeline"]
            self.assertEqual([row["media"][0]["timeline"]["video"]["pts"] for row in records], [0, 120000, 350000])
            self.assertEqual(len({item["timeline"]["asset"] for row in records for item in row["media"]}), 2)
            derived = history.derive({key: source[key] for key in ("asset", "recordId", "sequence")},
                                     base64.b64encode(png((100, 100, 100))).decode(), "image/jpeg", "omp.resizeImage")
            self.assertEqual(derived["asset"], source["asset"])
            self.assertTrue(derived["approximate"])
            self.assertFalse(history.objects.exists())
            history.close()
            self.assertFalse(history._video.thread.is_alive())
            self.assertEqual(len(list(root.rglob("*.mp4"))), 2)
            self.assertEqual(list(root.rglob("*.png")), [])
            self.assertEqual(list(root.rglob("*.bin")), [])
            cold = ObservationHistory(root)
            try:
                for row, color in zip(records, colors):
                    actual = cold.observe({"id": row["id"]})["records"][0]["media"][0]
                    self.assertTrue(actual["approximate"])
                    self.assert_picture(base64.b64decode(actual["data"]), color)
                self.assertIsNone(cold._video)  # Reading doesn't launch an encoder.
            finally:
                cold.close()

    def test_rotation_dimensions_generation_backward_time_and_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            rows = []
            for at, generation, size in (("00:00:00", "one", (31, 25)), ("00:00:11", "one", (31, 25)),
                                         ("00:00:12", "one", (33, 25)), ("00:00:13", "two", (33, 25)),
                                         ("00:00:12", "two", (33, 25))):
                rows.append(history.append(sample(png(size=size)), generation, SAMPLING, "2026-10-27T" + at + "Z"))
            assets = [row["media"][0]["timeline"]["asset"] for row in rows]
            self.assertEqual(len(set(assets)), 5)
            latest = rows[-1]["media"][0]["timeline"]
            with self.assertRaisesRegex(ValueError, "pending"):
                decode_frame(history.directory, latest["asset"], latest["video"])
            history.close()
            self.assert_picture(decode_frame(history.directory, latest["asset"], latest["video"]), (200, 40, 60), (33, 25))

    def test_queue_budget_gap_and_hot_input_survives(self):
        entered, release = threading.Event(), threading.Event()
        original_encode = VideoRecorder._encode
        def slow_encode(recorder, *args):
            entered.set()
            release.wait(timeout=5)
            return original_encode(recorder, *args)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                "RSA_VIDEO_QUEUE_FRAMES": "1", "RSA_VIDEO_QUEUE_BYTES": "4096"}), patch.object(VideoRecorder, "_encode", slow_encode):
            history = ObservationHistory(directory)
            raw = png()
            first = history.append(sample(raw), "one", SAMPLING)
            self.assertTrue(entered.wait(timeout=3))
            dropped = history.append(sample(raw), "one", SAMPLING)
            self.assertEqual(dropped["media"][0]["timeline"]["video"]["status"], "gap")
            self.assertEqual(base64.b64decode(dropped["media"][0]["data"]), raw)
            self.assertLessEqual(history._video.metrics()["peakBytes"], 4096)
            self.assertEqual(history._video.metrics()["dropped"], 1)
            release.set()
            history.close()
            cold = ObservationHistory(directory)
            try:
                with self.assertRaisesRegex(ValueError, "queue"):
                    cold.observe({"id": dropped["id"]})
                self.assertTrue(cold.observe({"id": first["id"]})["records"])
            finally:
                cold.close()

    def test_rejected_streams_do_not_allocate_files_or_encoder_metadata(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RSA_VIDEO_QUEUE_BYTES": "1"}):
            root = Path(directory).resolve()
            recorder = VideoRecorder(root, root / "video")
            try:
                raw = png()
                for index in range(1000):
                    value = recorder.submit(raw, str(index), index * 20)
                    self.assertEqual(value["video"]["status"], "gap")
                self.assertEqual(recorder.channels, {})
                self.assertEqual(recorder.segments, {})
                self.assertEqual(list((root / "video").iterdir()), [])
                self.assertEqual(recorder.metrics()["queuedBytes"], 0)
            finally:
                recorder.close()

    def test_invalid_second_image_cannot_enqueue_an_unindexed_first_image(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            try:
                with self.assertRaises(UnidentifiedImageError):
                    history.append(sample(png(), b"not an image"), "one", SAMPLING)
                self.assertIsNone(history._video)
                self.assertEqual(history.sequence, 0)
                self.assertEqual(list(history.directory.rglob("*.mp4*")), [])
            finally:
                history.close()

    def test_image_dimensions_match_the_cross_language_reference_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            try:
                with self.assertRaisesRegex(ValueError, "at most 32768"):
                    history.append(sample(png(size=(32769, 1))), "one", SAMPLING)
                self.assertEqual(history.sequence, 0)
                self.assertIsNone(history._video)
            finally:
                history.close()

    def test_cold_decode_does_not_block_sampler_append_and_queries_have_byte_budget(self):
        entered, release = threading.Event(), threading.Event()
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            record = history.append(sample(png()), "one", SAMPLING)
            history.close()
            history = ObservationHistory(directory)
            def slow_decode(*args):
                entered.set()
                release.wait(timeout=3)
                return decode_frame(*args)
            try:
                with ThreadPoolExecutor(max_workers=1) as pool, patch("rsa_tools._video.decode_frame", slow_decode):
                    future = pool.submit(history.observe, {"id": record["id"]})
                    self.assertTrue(entered.wait(timeout=2))
                    started = time.monotonic()
                    history.append({"text": "sampler remains live"}, "one", SAMPLING)
                    self.assertLess(time.monotonic() - started, 0.2)
                    release.set()
                    self.assertTrue(future.result()["records"])
                with patch.dict(os.environ, {"RSA_VIDEO_QUERY_BYTES": "1"}):
                    with self.assertRaisesRegex(ValueError, "query byte budget"):
                        history.observe({"id": record["id"]})
            finally:
                release.set()
                history.close()

    def test_encoder_failure_is_explicit_and_does_not_deadlock_shutdown(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(VideoRecorder, "_encode", side_effect=RuntimeError("encoder failed")):
            history = ObservationHistory(directory)
            row = history.append(sample(png()), "one", SAMPLING)
            history.close()
            self.assertFalse(history._video.thread.is_alive())
            source = row["media"][0]["timeline"]
            status = json.loads((history.directory / (source["asset"] + ".json")).read_text())
            self.assertEqual(status["status"], "error")
            self.assertIn("encoder failed", status["error"])
            with self.assertRaisesRegex(ValueError, "encoder failed"):
                decode_frame(history.directory, source["asset"], source["video"])

    def test_container_is_closed_even_when_final_flush_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            recorder = VideoRecorder(root, root / "video")
            container, stream = Mock(), Mock()
            stream.encode.side_effect = RuntimeError("flush failed")
            segment = _Segment("video/test.mp4", root / "video/test.mp4", 32, 24, 0, 0, 0,
                               frames=1, container=container, stream=stream)
            try:
                recorder._finish(segment)
                container.close.assert_called_once()
                self.assertIsNone(segment.container)
                status = json.loads((root / "video/test.mp4.json").read_text())
                self.assertEqual(status["status"], "error")
                self.assertIn("flush failed", status["error"])
            finally:
                recorder.close()

    def test_window_expiry_keeps_no_images_or_persistent_video(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RSA_PERCEPTION_PERSIST": "0"}):
            history = ObservationHistory(directory)
            row = history.append(sample(png()), "one", SAMPLING)
            self.assertTrue(row["media"][0]["timeline"]["asset"].startswith("window-"))
            history.hot_seconds = 0.001
            time.sleep(0.01)
            history.prune()
            self.assertEqual(history._hot_media, {})
            self.assertEqual(history.hot_bytes, 0)
            self.assertTrue(history.observe()["availability"]["expired"])
            history.close()
            self.assertEqual(list(history.directory.glob("window-*")), [])
            self.assertEqual(list(history.directory.rglob("*.mp4")), [])
            self.assertEqual(list(history.segment_dir.iterdir()), [])

    def test_offline_cli_and_exact_frame_and_path_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            row = history.append(sample(png()), "one", SAMPLING)
            history.close()
            source = row["media"][0]["timeline"]
            command = [sys.executable, "-m", "rsa_tools._video", "--root", str(history.directory),
                       "--asset", source["asset"], "--pts", "0", "--time-base", "1/1000000"]
            result = subprocess.run(command, capture_output=True, check=True)
            self.assert_picture(result.stdout, (200, 40, 60))
            for asset in ("../escape.mp4", "/escape.mp4", "video/../escape.mp4"):
                with self.assertRaisesRegex(ValueError, "Invalid"):
                    decode_frame(history.directory, asset, source["video"])
            linked = history.directory / "video" / "linked.mp4"
            linked.symlink_to(history.directory / source["asset"])
            with self.assertRaisesRegex(ValueError, "symlinks"):
                decode_frame(history.directory, "video/linked.mp4", source["video"])
            with self.assertRaisesRegex(ValueError, "exact frame"):
                decode_frame(history.directory, source["asset"], {**source["video"], "pts": 1})

    def test_interrupted_segment_marked_error_on_writer_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            folder = history.directory / "video"
            folder.mkdir()
            path = folder / "abandoned.mp4.json"
            path.write_text(json.dumps({"status": "pending"}))
            history.close()
            restarted = ObservationHistory(directory)
            try:
                state = json.loads(path.read_text())
                self.assertEqual(state["status"], "error")
                self.assertIn("interrupted", state["error"])
            finally:
                restarted.close()

    def test_public_import_does_not_load_video_dependencies(self):
        result = subprocess.run([sys.executable, "-c", "import rsa_tools,sys; print('av' in sys.modules, 'PIL' in sys.modules)"],
                                capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.strip(), "False False")


if __name__ == "__main__":
    unittest.main()
