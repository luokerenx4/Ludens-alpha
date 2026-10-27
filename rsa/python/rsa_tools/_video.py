"""Timeline image encoding and read-only frame extraction.

Only the timeline writer owns VideoRecorder. Importing rsa_tools does not load
PyAV, and the command-line reader never starts sampling or takes the writer lock.
"""

from __future__ import annotations

import argparse
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from fractions import Fraction
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
from typing import Any
import uuid


TIME_BASE = (1, 1_000_000)


def image_size(raw: bytes) -> tuple[int, int]:
    from PIL import Image

    with Image.open(BytesIO(raw)) as image:
        width, height = image.size
        if not 0 < width <= 32768 or not 0 < height <= 32768:
            raise ValueError("Recorded image dimensions must be positive and at most 32768 pixels")
        return width, height


def _positive(name: str, default: int) -> int:
    value = int(os.environ.get(name, default))
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _iso(at: float) -> str:
    return datetime.fromtimestamp(at, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _state(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, allow_nan=False) + "\n")
    temporary.replace(path)


def media_path(root: Path, asset: str) -> Path:
    """Reject traversal and links, including links in intermediate directories."""
    parts = asset.split("/")
    if not parts or any(not re.fullmatch(r"[A-Za-z0-9._-]+", part) or part in {".", ".."} for part in parts):
        raise ValueError("Invalid timeline media asset")
    root = root.absolute()
    path = root.joinpath(*parts)
    if root.resolve() != root or path.resolve() != path:
        raise ValueError("Timeline media must not follow symlinks")
    return path


def video_status(root: Path, asset: str) -> dict[str, Any]:
    path = media_path(root, asset)
    status = media_path(root, asset + ".json")
    if not status.is_file():
        raise ValueError("Recorded video is unavailable: status is missing")
    value: dict[str, Any] = json.loads(status.read_text())
    if value.get("status") != "ready":
        raise ValueError(f"Recorded video is {value.get('status', 'unavailable')}: {value.get('error', 'encoding has not finished')}")
    if not path.is_file():
        raise ValueError("Recorded video is unavailable: segment is missing")
    return value


def decode_frame(root: Path, asset: str, video: dict[str, Any]) -> bytes:
    if video.get("status") == "gap":
        raise ValueError("Recorded image is unavailable: " + str(video.get("reason", "recording gap")))
    pts = video.get("pts")
    time_base = video.get("timeBase")
    if type(pts) is not int or pts < 0 or not isinstance(time_base, (list, tuple)) or len(time_base) != 2:
        raise ValueError("Invalid video frame position")
    if any(type(value) is not int or value <= 0 for value in time_base):
        raise ValueError("Invalid video time base")
    info = video_status(root, asset)
    path = media_path(root, asset)
    import av

    wanted = Fraction(pts) * Fraction(*time_base)
    with av.open(str(path), mode="r") as container:
        stream = container.streams.video[0]
        width, height = int(info["width"]), int(info["height"])
        if (width <= 0 or height <= 0 or stream.width != width + width % 2 or stream.height != height + height % 2
                or stream.width * stream.height * 3 > _positive("RSA_VIDEO_QUEUE_BYTES", 32 * 1024 * 1024)):
            raise ValueError("Recorded video dimensions exceed the decoding budget or disagree with its metadata")
        stream_base = Fraction(stream.time_base.numerator, stream.time_base.denominator)
        container.seek(int(wanted / stream_base), stream=stream, backward=True)
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            actual = Fraction(frame.pts) * Fraction(frame.time_base.numerator, frame.time_base.denominator)
            if actual < wanted:
                continue
            # Never quietly substitute a neighbouring sample for a missing one.
            if actual != wanted:
                raise ValueError("Recorded image is unavailable: exact frame is missing")
            image = frame.to_image().crop((0, 0, width, height))
            output = BytesIO()
            image.save(output, format="PNG")
            return output.getvalue()
    raise ValueError("Recorded image is unavailable: exact frame is missing")


@dataclass
class _Segment:
    asset: str
    path: Path
    width: int
    height: int
    started: float
    updated: float
    last_at: float
    last_pts: int = -1
    queued: int = 0
    frames: int = 0
    duration: float = 0.0
    sealed: bool = False
    discard: bool = False
    error: str | None = None
    container: Any = None
    stream: Any = None


class VideoRecorder:
    """A bounded producer queue and one encoding thread inside the writer."""

    def __init__(self, root: Path, directory: Path) -> None:
        self.root, self.directory = root, directory
        self.directory.mkdir(parents=True, exist_ok=True)
        if self.root.resolve() != self.root or self.directory.resolve() != self.directory:
            raise ValueError("Timeline video directory must not follow symlinks")
        self.queue_limit = _positive("RSA_VIDEO_QUEUE_BYTES", 32 * 1024 * 1024)
        self.queue_count = _positive("RSA_VIDEO_QUEUE_FRAMES", 64)
        self.segment_seconds = _positive("RSA_VIDEO_SEGMENT_SECONDS", 10)
        self.max_streams = _positive("RSA_VIDEO_STREAMS", 16)
        self.condition = threading.Condition()
        self.queue: deque[tuple[_Segment, bytes, int, int]] = deque()
        self.channels: dict[str, _Segment] = {}
        self.segments: dict[str, _Segment] = {}
        self.queued_bytes = 0
        self.pending_frames = 0
        self.peak_bytes = 0
        self.peak_frames = 0
        self.dropped = 0
        self.accepted = 0
        self.closed = False
        self.failure: str | None = None
        self.thread = threading.Thread(target=self._run, name="rsa-video", daemon=True)
        self.thread.start()

    def _metadata(self, segment: _Segment, status: str) -> dict[str, Any]:
        return {"status": status, "startedAt": _iso(segment.started), "durationSeconds": segment.duration,
                "width": segment.width, "height": segment.height, "frames": segment.frames,
                **({"error": segment.error} if segment.error else {})}

    def _new_segment(self, width: int, height: int, at: float) -> _Segment:
        path = self.directory / (uuid.uuid4().hex + ".mp4")
        segment = _Segment(path.relative_to(self.root).as_posix(), path, width, height, at, time.monotonic(), at)
        _state(path.with_suffix(".mp4.json"), self._metadata(segment, "pending"))
        self.segments[segment.asset] = segment
        return segment

    def submit(self, raw: bytes, channel: str, at: float, size: tuple[int, int] | None = None) -> dict[str, Any]:
        width, height = image_size(raw) if size is None else size
        # Charge both the submitted compressed input and its decoded RGB frame.
        cost = len(raw) + (width + width % 2) * (height + height % 2) * 3
        with self.condition:
            if self.closed:
                raise RuntimeError("Video recorder is closed")
            segment = self.channels.get(channel)
            reason = self.failure
            if reason is None and (cost > self.queue_limit or self.queued_bytes + cost > self.queue_limit or self.pending_frames >= self.queue_count):
                reason = "Video recording queue is full or frame exceeds its byte budget"
            if reason is not None:
                self.dropped += 1
                # A gap is a virtual reference, not an empty queued segment.
                # Rejected submissions must not grow metadata or file counts.
                asset = (self.directory / (uuid.uuid4().hex + ".mp4")).relative_to(self.root).as_posix()
                return {"asset": asset, "video": {"pts": 0, "timeBase": list(TIME_BASE),
                        "width": width, "height": height, "status": "gap", "reason": reason}}
            if segment is None or segment.sealed or (segment.width, segment.height) != (width, height) or at < segment.last_at or at - segment.started >= self.segment_seconds:
                if segment is not None:
                    segment.sealed = True
                if channel not in self.channels and len(self.channels) >= self.max_streams:
                    oldest = min(self.channels, key=lambda key: self.channels[key].updated)
                    self.channels.pop(oldest).sealed = True
                segment = self._new_segment(width, height, at)
                self.channels[channel] = segment
            pts = max(segment.last_pts + 1, round((at - segment.started) * 1_000_000))
            segment.last_at, segment.last_pts, segment.updated = at, pts, time.monotonic()
            segment.discard = False
            video = {"pts": pts, "timeBase": list(TIME_BASE), "width": width, "height": height}
            result: dict[str, Any] = {"asset": segment.asset, "video": video}
            reason = segment.error
            if reason is not None:
                self.dropped += 1
                video.update(status="gap", reason=reason)
                return result
            segment.queued += 1
            self.queue.append((segment, raw, pts, cost))
            self.queued_bytes += cost
            self.pending_frames += 1
            self.accepted += 1
            self.peak_bytes = max(self.peak_bytes, self.queued_bytes)
            self.peak_frames = max(self.peak_frames, self.pending_frames)
            self.condition.notify()
            return result

    def discard(self, asset: str) -> None:
        with self.condition:
            segment = self.segments.get(asset)
            if segment is not None:
                segment.discard = True
            else:
                path = media_path(self.root, asset)
                path.unlink(missing_ok=True)
                path.with_suffix(".mp4.json").unlink(missing_ok=True)

    def _encode(self, segment: _Segment, raw: bytes, pts: int) -> None:
        import av
        from PIL import Image

        if segment.error:
            return
        if segment.container is None:
            segment.container = av.open(str(segment.path), mode="w", format="mp4", options={"movflags": "+faststart"})
            stream = segment.container.add_stream("libx264", rate=30)
            stream.width = segment.width + segment.width % 2
            stream.height = segment.height + segment.height % 2
            stream.pix_fmt = "yuv420p"
            stream.codec_context.time_base = Fraction(*TIME_BASE)
            stream.time_base = Fraction(*TIME_BASE)
            stream.options = {"crf": "18", "preset": "veryfast", "tune": "zerolatency", "bf": "0"}
            segment.stream = stream
        with Image.open(BytesIO(raw)) as source:
            image = source.convert("RGB")
            if image.size != (segment.stream.width, segment.stream.height):
                padded = Image.new("RGB", (segment.stream.width, segment.stream.height))
                padded.paste(image, (0, 0))
                image = padded
            frame = av.VideoFrame.from_image(image)
        frame.pts = pts
        frame.time_base = Fraction(*TIME_BASE)
        frame.duration = 33_333
        for packet in segment.stream.encode(frame):
            segment.container.mux(packet)
        segment.frames += 1
        segment.duration = max(segment.duration, (pts + 33_333) / 1_000_000)

    def _finish(self, segment: _Segment) -> None:
        try:
            if segment.container is not None:
                if not segment.error:
                    for packet in segment.stream.encode(None):
                        segment.container.mux(packet)
            if not segment.frames and not segment.error:
                segment.error = "No frames were accepted for this segment"
        except Exception as error:
            segment.error = f"{type(error).__name__}: {error}"
        finally:
            if segment.container is not None:
                try:
                    segment.container.close()
                except Exception as error:
                    segment.error = segment.error or f"{type(error).__name__}: {error}"
            segment.container = segment.stream = None
        with self.condition:
            _state(segment.path.with_suffix(".mp4.json"), self._metadata(segment, "error" if segment.error else "ready"))
            if segment.discard:
                segment.path.unlink(missing_ok=True)
                segment.path.with_suffix(".mp4.json").unlink(missing_ok=True)
            self.segments.pop(segment.asset, None)

    def _run(self) -> None:
        try:
            self._work()
        except Exception as error:
            self.failure = f"{type(error).__name__}: {error}"
            for segment in list(self.segments.values()):
                segment.error = self.failure
                try:
                    self._finish(segment)
                except Exception:
                    pass
            with self.condition:
                self.queue.clear()
                self.queued_bytes = 0
                self.pending_frames = 0

    def _work(self) -> None:
        while True:
            with self.condition:
                if not self.queue and not self.closed:
                    self.condition.wait(timeout=0.25)
                now = time.monotonic()
                for segment in self.channels.values():
                    if self.closed or now - segment.updated >= self.segment_seconds:
                        segment.sealed = True
                finished = [segment for segment in self.segments.values() if segment.sealed and not segment.queued]
                task = self.queue.popleft() if self.queue else None
                done = self.closed and task is None and not self.segments
            for segment in finished:
                self._finish(segment)
            if done:
                return
            if task is None:
                continue
            segment, raw, pts, cost = task
            try:
                self._encode(segment, raw, pts)
            except Exception as error:
                segment.error = f"{type(error).__name__}: {error}"
                print(f"Video recording failed: {segment.error}", file=sys.stderr)
                _state(segment.path.with_suffix(".mp4.json"), self._metadata(segment, "error"))
            finally:
                with self.condition:
                    segment.queued -= 1
                    self.queued_bytes -= cost
                    self.pending_frames -= 1
                raw = b""

    def metrics(self) -> dict[str, int]:
        with self.condition:
            return {"queuedBytes": self.queued_bytes, "queuedFrames": self.pending_frames, "peakBytes": self.peak_bytes,
                    "peakFrames": self.peak_frames, "accepted": self.accepted, "dropped": self.dropped}

    def close(self) -> None:
        with self.condition:
            self.closed = True
            for segment in self.segments.values():
                segment.sealed = True
            self.condition.notify()
        self.thread.join()


def main() -> int:
    parser = argparse.ArgumentParser(description="Read one recorded timeline video frame without starting a worker")
    parser.add_argument("--root", required=True)
    parser.add_argument("--asset", required=True)
    parser.add_argument("--pts", type=int, required=True)
    parser.add_argument("--time-base", default="1/1000000")
    arguments = parser.parse_args()
    try:
        numerator, denominator = (int(part) for part in arguments.time_base.split("/"))
        value = decode_frame(Path(arguments.root), arguments.asset,
                             {"pts": arguments.pts, "timeBase": [numerator, denominator]})
        sys.stdout.buffer.write(value)
        return 0
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
