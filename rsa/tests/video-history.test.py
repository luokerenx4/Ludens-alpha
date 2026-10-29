"""Real PyAV encoding at the timeline boundary, without a device or model."""

import base64
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from io import BytesIO
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
from unittest.mock import Mock, patch

import av
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
    def drain(self, recorder):
        deadline = time.monotonic() + 5
        while recorder.metrics()["queuedFrames"] and time.monotonic() < deadline:
            time.sleep(0.001)
        self.assertEqual(recorder.metrics()["queuedFrames"], 0)

    def assert_picture(self, raw, color, size=(31, 25)):
        image = Image.open(BytesIO(raw)).convert("RGB")
        self.assertEqual(image.size, size)
        actual = image.getpixel((size[0] // 2, size[1] // 2))
        self.assertLess(max(abs(left - right) for left, right in zip(actual, color)), 8)

    def test_unsealed_segment_is_readable_while_recording(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory, sample_hz=30)
            rows = []

            def append_until(count):
                for index in range(len(rows), count):
                    at = f"2026-10-27T00:00:{index / 30:06.3f}Z"
                    rows.append(history.append(sample(png()), "one", SAMPLING, at))
                    self.drain(history._video)

            try:
                append_until(45)
                first = rows[0]["media"][0]["timeline"]
                path = history.directory / first["asset"]
                metadata = lambda: json.loads(path.with_suffix(".mp4.json").read_text())
                initial = metadata()
                self.assertEqual(initial["readableBytes"], 0)
                self.assertEqual(initial["frames"], 0)
                self.assertEqual(initial["durationSeconds"], 0)
                self.assertIsNone(initial["lastReadablePts"])
                with self.assertRaisesRegex(ValueError, "not yet readable"):
                    decode_frame(history.directory, first["asset"], first["video"])

                # Muxing keyframe 60 flushes only the preceding 60-frame fragment.
                append_until(75)
                progress = metadata()
                self.assertEqual(progress["status"], "pending")
                self.assertEqual(progress["frames"], 60)
                self.assertEqual(progress["durationSeconds"], 2)
                self.assertEqual(progress["lastReadablePts"], rows[59]["media"][0]["timeline"]["video"]["pts"])
                self.assertGreater(progress["readableBytes"], 0)
                prefix = path.read_bytes()[:progress["readableBytes"]]
                with av.open(BytesIO(prefix)) as container:
                    frames = list(container.decode(container.streams.video[0]))
                    self.assertEqual(len(frames), 60)
                    self.assertEqual(frames[-1].pts, progress["lastReadablePts"])
                mid = rows[30]["media"][0]["timeline"]
                self.assert_picture(decode_frame(history.directory, mid["asset"], mid["video"]), (200, 40, 60))
                late = rows[70]["media"][0]["timeline"]
                with self.assertRaisesRegex(ValueError, "not yet readable"):
                    decode_frame(history.directory, late["asset"], late["video"])

                append_until(135)
                next_progress = metadata()
                self.assertEqual(next_progress["frames"], 120)
                self.assertEqual(next_progress["durationSeconds"], 4)
                self.assertGreater(next_progress["readableBytes"], progress["readableBytes"])
                self.assertEqual(path.read_bytes()[:progress["readableBytes"]], prefix)
                self.assert_picture(decode_frame(history.directory, late["asset"], late["video"]), (200, 40, 60))
            finally:
                history.close()
            finished = metadata()
            self.assertEqual(finished["status"], "ready")
            self.assertEqual(finished["readableBytes"], path.stat().st_size)
            self.assertEqual(finished["frames"], 135)
            self.assertEqual(finished["lastReadablePts"], rows[-1]["media"][0]["timeline"]["video"]["pts"])
            self.assertEqual(path.read_bytes()[:progress["readableBytes"]], prefix)
            for index in (0, 30, 70, 134):
                reference = rows[index]["media"][0]["timeline"]
                self.assert_picture(decode_frame(history.directory, reference["asset"], reference["video"]), (200, 40, 60))

    def test_pending_duration_uses_flushed_fragment_pts_with_irregular_sampling(self):
        for times in ((0, 0.137, 0.401), (0, 3, 8)):
            with self.subTest(times=times), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                recorder = VideoRecorder(root, root / "video")
                try:
                    refs = []
                    for at in times:
                        refs.append(recorder.submit(png(), "one", at, sample_hz=1))
                        self.drain(recorder)
                    path = root / refs[0]["asset"]
                    progress = json.loads(path.with_suffix(".mp4.json").read_text())
                    self.assertEqual(progress["frames"], 2)
                    self.assertEqual(progress["lastReadablePts"], round(times[1] * 1_000_000))
                    self.assertAlmostEqual(progress["durationSeconds"], times[2])
                    with av.open(BytesIO(path.read_bytes()[:progress["readableBytes"]])) as container:
                        stream = container.streams.video[0]
                        self.assertAlmostEqual(float(stream.duration * stream.time_base), progress["durationSeconds"])
                        self.assertEqual([frame.pts for frame in container.decode(stream)], [round(at * 1_000_000) for at in times[:2]])
                finally:
                    recorder.close()
                finished = json.loads(path.with_suffix(".mp4.json").read_text())
                self.assertEqual(finished["frames"], 3)
                self.assertEqual(finished["readableBytes"], path.stat().st_size)
                self.assertAlmostEqual(finished["durationSeconds"], times[2] + 1)

    def test_sample_hz_preserves_actual_frame_times_and_cold_queries(self):
        colors = [(200, 40, 60), (40, 160, 90), (70, 80, 190)]
        for hz in (1, 12.5, 30, 60, 30000 / 1001, 1 / 3):
            with self.subTest(sample_hz=hz), tempfile.TemporaryDirectory() as directory:
                history = ObservationHistory(directory, sample_hz=hz)
                rows = [history.append(sample(png(color)), "one", SAMPLING, "2026-10-27T00:00:" + at + "Z")
                        for at, color in zip(("00.000", "00.137", "00.401"), colors)]
                history.close()
                refs = [row["media"][0]["timeline"] for row in rows]
                self.assertEqual(len({ref["asset"] for ref in refs}), 1)
                video = history.directory / refs[0]["asset"]
                tail = round(1_000_000 / hz)
                with av.open(str(video)) as container:
                    stream = container.streams.video[0]
                    self.assertEqual(stream.codec_context.framerate, Fraction(str(hz)).limit_denominator(1_000_000))
                    frames = list(container.decode(stream))
                    # The configured frequency does not duplicate, drop, or retime samples.
                    self.assertEqual([frame.pts for frame in frames], [0, 137000, 401000])
                    self.assertTrue(all(frame.time_base == Fraction(1, 1_000_000) for frame in frames))
                    self.assertEqual(frames[-1].duration, tail)
                    self.assertAlmostEqual(float(stream.duration * stream.time_base), 0.401 + tail / 1_000_000)
                metadata = json.loads(video.with_suffix(".mp4.json").read_text())
                self.assertEqual(metadata["sample_hz"], hz)
                self.assertEqual(metadata["frames"], 3)
                self.assertAlmostEqual(metadata["durationSeconds"], 0.401 + tail / 1_000_000)
                cold = ObservationHistory(directory)
                try:
                    queries = ({"id": rows[1]["id"]}, {"at": "2026-10-27T00:00:00.200Z"},
                               {"start": "2026-10-27T00:00:00.100Z", "end": "2026-10-27T00:00:00.500Z"})
                    for query, expected in zip(queries, ([1], [1], [1, 2])):
                        selected = cold.observe(query)["records"]
                        self.assertEqual([row["id"] for row in selected], [rows[i]["id"] for i in expected])
                        for row, index in zip(selected, expected):
                            self.assert_picture(base64.b64decode(row["media"][0]["data"]), colors[index])
                finally:
                    cold.close()

    def test_changing_sample_hz_rotates_video_without_losing_history(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            first = history.append(sample(png()), "one", SAMPLING, "2026-10-27T00:00:00Z")
            history.sample_hz = 12.5
            second = history.append(sample(png()), "one", SAMPLING, "2026-10-27T00:00:00.2Z")
            history.close()
            refs = [row["media"][0]["timeline"] for row in (first, second)]
            self.assertNotEqual(refs[0]["asset"], refs[1]["asset"])
            for ref, hz in zip(refs, (30, 12.5)):
                video = history.directory / ref["asset"]
                with av.open(str(video)) as container:
                    self.assertEqual(container.streams.video[0].codec_context.framerate, Fraction(str(hz)))
                self.assert_picture(decode_frame(history.directory, ref["asset"], ref["video"]), (200, 40, 60))

    def test_worker_default_and_reloaded_rate_reach_the_encoder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for generation, configured, expected in (("one", "", 30), ("two", "    sample_hz = 12.5\n", 12.5)):
                source = ("from rsa_tools import capability, record\nclass Perception:\n" + configured +
                          "    def start(self, context):\n        self.sample()\n"
                          "    @record\n    @capability\n    def sample(self):\n"
                          "        return " + repr(sample(png())) + "\n"
                          "    def close(self):\n        pass\n")
                with (root / "stderr.log").open("w") as stderr:
                    process = subprocess.Popen([sys.executable, "-u", "-m", "rsa_tools._perception"], cwd=root,
                                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True)
                    incoming = queue.Queue()
                    reader = threading.Thread(target=lambda: [incoming.put(json.loads(line)) for line in process.stdout], daemon=True)
                    reader.start()
                    try:
                        process.stdin.write(json.dumps({"id": "start", "action": "start", "workspace": str(root),
                            "runDir": str(root / "run"), "generation": generation, "source": source}) + "\n")
                        process.stdin.flush()
                        start = None
                        sampled = None
                        while start is None or sampled is None:
                            message = incoming.get(timeout=5)
                            if message.get("id") == "start":
                                start = message
                            elif message.get("event") == "sample":
                                sampled = message
                        self.assertTrue(start["ok"])
                        self.assertEqual(start["result"]["sampleHz"], expected)
                        reference = sampled["mediaReferences"][0]
                    finally:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                        process.stdin.close()
                        process.stdout.close()
                        reader.join(timeout=1)
                    self.assertEqual(process.returncode, 0, (root / "stderr.log").read_text())
                history = ObservationHistory(root)
                try:
                    video = history.directory / reference["asset"]
                    with av.open(str(video)) as container:
                        self.assertEqual(container.streams.video[0].codec_context.framerate, Fraction(str(expected)))
                    row = history.observe({"id": sampled["snapshot"]["id"]})["records"][0]
                    self.assertEqual(row["generation"], generation)
                    self.assert_picture(base64.b64decode(row["media"][0]["data"]), (200, 40, 60))
                finally:
                    history.close()

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

    def test_rotation_dimensions_generation_and_backward_time(self):
        with tempfile.TemporaryDirectory() as directory:
            history = ObservationHistory(directory)
            rows = []
            for at, generation, size in (("00:00:00", "one", (31, 25)), ("00:05:01", "one", (31, 25)),
                                         ("00:05:02", "one", (33, 25)), ("00:05:03", "two", (33, 25)),
                                         ("00:05:02", "two", (33, 25))):
                rows.append(history.append(sample(png(size=size)), generation, SAMPLING, "2026-10-27T" + at + "Z"))
            assets = [row["media"][0]["timeline"]["asset"] for row in rows]
            self.assertEqual(len(set(assets)), 5)
            latest = rows[-1]["media"][0]["timeline"]
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
