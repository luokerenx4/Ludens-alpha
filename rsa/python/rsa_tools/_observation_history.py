"""Bounded recent observations with lazily read, time-segmented history."""

from collections import Counter, OrderedDict
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import struct
import tempfile
import threading
import time
import uuid


def timestamp(value, name):
    if not isinstance(value, str):
        raise ValueError(f"{name} must be an ISO timestamp with a timezone")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.timestamp()
    except (ValueError, OverflowError):
        raise ValueError(f"{name} must be an ISO timestamp with a timezone") from None


def _number(name, default, integer=False):
    try:
        value = int(os.environ.get(name, default)) if integer else float(os.environ.get(name, default))
        if not math.isfinite(value) or value <= 0:
            raise ValueError()
        return value
    except ValueError:
        raise ValueError(f"{name} must be a positive {'integer' if integer else 'number'}") from None


def _iso(at):
    return datetime.fromtimestamp(at, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# Fixed-size entries can be scanned without retaining an index per observation.
# Each entry is (wall timestamp, sequence, payload offset, payload length).
_ENTRY = struct.Struct(">dQQQ")


class ObservationHistory:
    def __init__(self, run_dir):
        self.root = Path(run_dir).resolve()
        self.directory = self.root / "perception" / "history"
        self.path = self.directory / "records.jsonl"  # Existing history is read-only.
        self.segment_dir = self.directory / "segments"
        self.segment_dir.mkdir(parents=True, exist_ok=True)
        self.hot_seconds = _number("RSA_PERCEPTION_HOT_SECONDS", 600)
        self.hot_limit = _number("RSA_PERCEPTION_HOT_BYTES", 64 * 1024 * 1024, True)
        self.segment_seconds = _number("RSA_PERCEPTION_SEGMENT_SECONDS", 3600)
        self.segment_limit = _number("RSA_PERCEPTION_SEGMENT_BYTES", 256 * 1024 * 1024, True)
        persist = os.environ.get("RSA_PERCEPTION_PERSIST", "1").strip().lower()
        if persist not in {"1", "0", "true", "false"}:
            raise ValueError("RSA_PERCEPTION_PERSIST must be 1, 0, true, or false")
        self.persistent = persist in {"1", "true"}
        self.lock = threading.Lock()
        self._hot = OrderedDict()
        self.hot_bytes = 0
        self._references = Counter()
        self._pins = set()
        self._expired = None  # min/max wall time and last evicted sequence, not old records.
        self._temporary = None
        self._active = None
        self._segments = []
        self._legacy = None
        self._legacy_bounds = None
        self.sequence = 0
        # SIGKILL cannot run close(). Reclaim only window directories whose
        # recorded owner PID no longer exists; never touch a live instance.
        for directory in self.directory.glob("window-*-*"):
            try:
                owner = int(directory.name.split("-")[1])
            except ValueError:
                continue
            try:
                os.kill(owner, 0)
            except ProcessLookupError:
                if directory.is_dir() and not directory.is_symlink():
                    shutil.rmtree(directory)
            except PermissionError:
                pass
        # Only segment summaries survive between queries, never their entry lists.
        for path in self.segment_dir.glob("*.meta.json"):
            segment = json.loads(path.read_text())
            segment["path"] = str(path).removesuffix(".meta.json")
            self.sequence = max(self.sequence, segment["lastSequence"])
            if self.persistent:
                self._segments.append(segment)
        self._segments.sort(key=lambda item: item["firstSequence"])
        if self._segments:
            self._recover(self._segments[-1])
            self.sequence = max(item["lastSequence"] for item in self._segments)
        if self.path.exists() and self.path.stat().st_size:
            # Legacy files are not rewritten. Reading their two ends establishes
            # sequence continuity; old queries scan complete lines on demand.
            first = None
            with self.path.open("rb") as stream:
                line = stream.readline()
                if line.endswith(b"\n"):
                    first = json.loads(line)
                last = self._last_complete(stream)
            if first and last:
                self._legacy = {key: {"recordedAt": row["recordedAt"], "sequence": row["sequence"]}
                                for key, row in (("first", first), ("last", last))}
                self.sequence = max(self.sequence, last["sequence"])
        sequence_path = self.directory / "sequence.json"
        if sequence_path.exists():
            self.sequence = max(self.sequence, json.loads(sequence_path.read_text()))
        if not self.persistent:
            # No old persistent history is exposed in window-only mode.
            self._segments = []
            self._legacy = None
            self._temporary = Path(tempfile.mkdtemp(prefix=f"window-{os.getpid()}-", dir=self.directory))

    def policy(self):
        return {"persistent": self.persistent, "hotSeconds": self.hot_seconds,
                "hotBytes": self.hot_limit, "segmentSeconds": self.segment_seconds,
                "segmentBytes": self.segment_limit}

    @staticmethod
    def _last_complete(stream):
        stream.seek(0, 2)
        position, tail = stream.tell(), b""
        while position:
            size = min(position, 65536)
            position -= size
            stream.seek(position)
            tail = stream.read(size) + tail
            lines = tail.split(b"\n")
            if len(lines) >= 3 or position == 0:
                for line in reversed(lines[1:-1] if position else lines[:-1]):
                    if line:
                        return json.loads(line)
        return None

    def _save_meta(self, segment):
        path = Path(segment["path"] + ".meta.json")
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps({key: value for key, value in segment.items() if key != "path"}))
        temporary.replace(path)

    def _recover(self, segment):
        path = Path(segment["path"])
        # Metadata is the committed prefix. Recover complete payloads after it,
        # rebuilding only the tail index after a killed append.
        with path.with_suffix(".idx").open("r+b") as index, path.with_suffix(".jsonl").open("r+b") as records:
            index.truncate(segment["count"] * _ENTRY.size)
            index.seek(0, 2)
            records.seek(segment["recordBytes"])
            while True:
                offset = records.tell()
                line = records.readline()
                if not line:
                    break
                if not line.endswith(b"\n"):
                    records.truncate(offset)
                    break
                record = json.loads(line)
                at = timestamp(record["recordedAt"], "recordedAt")
                index.write(_ENTRY.pack(at, record["sequence"], offset, len(line)))
                self._update_segment(segment, record, offset + len(line))
        self._save_meta(segment)

    def _new_segment(self, at):
        stem = datetime.fromtimestamp(at, timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        path = self.segment_dir / f"{stem}-{self.sequence + 1}-{uuid.uuid4().hex[:8]}"
        path.with_suffix(".jsonl").touch()
        path.with_suffix(".idx").touch()
        segment = {"path": str(path), "firstSequence": self.sequence + 1,
                   "lastSequence": self.sequence, "count": 0, "recordBytes": 0,
                   "mediaBytes": 0, "bucket": math.floor(at / self.segment_seconds),
                   "minimum": None, "maximum": None, "latest": None}
        self._save_meta(segment)
        self._segments.append(segment)
        self._active = segment
        return segment

    @staticmethod
    def _update_segment(segment, record, record_bytes):
        point = {"recordedAt": record["recordedAt"], "sequence": record["sequence"]}
        at = timestamp(record["recordedAt"], "recordedAt")
        if segment["minimum"] is None or at < timestamp(segment["minimum"]["recordedAt"], "recordedAt"):
            segment["minimum"] = point
        if segment["maximum"] is None or at >= timestamp(segment["maximum"]["recordedAt"], "recordedAt"):
            segment["maximum"] = point
        segment["latest"] = point
        segment["lastSequence"] = record["sequence"]
        segment["count"] += 1
        segment["recordBytes"] = record_bytes

    def append(self, sample, generation, sampling, recorded_at=None):
        if not isinstance(sample, dict):
            raise TypeError("sample() must return an object")
        text, media = sample.get("text", ""), sample.get("media", [])
        if not isinstance(text, str):
            raise TypeError("sample.text must be a string")
        if not isinstance(media, list):
            raise TypeError("sample.media must be an array")
        if "sampledAt" in sample:
            timestamp(sample["sampledAt"], "sampledAt")
        if "sources" in sample and not isinstance(sample["sources"], list):
            raise TypeError("sample.sources must be an array")
        json.dumps(sample, allow_nan=False)
        json.dumps(sampling, allow_nan=False)
        for item in media:
            if (not isinstance(item, dict) or not isinstance(item.get("path"), str)
                    or not isinstance(item.get("mediaType"), str) or not item["mediaType"]):
                raise TypeError("sample.media entries must contain path and mediaType strings")
            if not Path(item["path"]).is_file():
                raise FileNotFoundError(item["path"])
        recorded_at = recorded_at or _iso(time.time())
        at = timestamp(recorded_at, "recordedAt")
        with self.lock:
            self._prune()
            segment = self._active
            if self.persistent and (segment is None
                    or segment["bucket"] != math.floor(at / self.segment_seconds)
                    or segment["recordBytes"] + segment["mediaBytes"] >= self.segment_limit):
                segment = self._new_segment(at)
            media_dir = Path(segment["path"] + ".media") if self.persistent else self._temporary
            archived, media_bytes = [], 0
            for item in media:
                path, added = self._archive(Path(item["path"]), media_dir)
                archived.append({"path": str(path), "mediaType": item["mediaType"]})
                media_bytes += path.stat().st_size
                if segment is not None:
                    segment["mediaBytes"] += added
            record = {"id": str(uuid.uuid4()), "sequence": self.sequence + 1,
                      "generation": generation, "recordedAt": recorded_at,
                      "sampling": sampling, "text": text, "media": archived}
            for key in ("sampledAt", "sources"):
                if key in sample:
                    record[key] = sample[key]
            encoded = (json.dumps(record, allow_nan=False) + "\n").encode("utf-8")
            if self.persistent:
                path = Path(segment["path"])
                with path.with_suffix(".jsonl").open("ab") as records:
                    offset = records.tell()
                    records.write(encoded)
                with path.with_suffix(".idx").open("ab") as index:
                    index.write(_ENTRY.pack(at, record["sequence"], offset, len(encoded)))
                self._update_segment(segment, record, offset + len(encoded))
                self._save_meta(segment)
            self.sequence = record["sequence"]
            # A scalar cursor is not archived observation content. Preserve it
            # even in window-only mode so a reload cannot reuse sequence IDs.
            temporary = self.directory / "sequence.tmp"
            temporary.write_text(str(self.sequence))
            temporary.replace(self.directory / "sequence.json")
            paths = tuple(item["path"] for item in archived)
            cost = len(encoded) + media_bytes
            self._hot[self.sequence] = (time.monotonic(), at, encoded, paths, cost)
            self.hot_bytes += cost
            self._references.update(paths)
            self._prune()
            return record

    @staticmethod
    def _archive(source, directory):
        directory.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        descriptor, name = tempfile.mkstemp(prefix=".copy-", dir=directory)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as output, source.open("rb") as incoming:
                while block := incoming.read(1024 * 1024):
                    digest.update(block)
                    output.write(block)
            destination = directory / f"{digest.hexdigest()}{source.suffix.lower()}"
            added = 0
            if not destination.exists():
                added = temporary.stat().st_size
                temporary.replace(destination)
            return destination, added
        finally:
            temporary.unlink(missing_ok=True)

    def _delete_unused(self, path):
        if not self.persistent and not self._references.get(path) and path not in self._pins:
            Path(path).unlink(missing_ok=True)

    def _prune(self):
        cutoff = time.monotonic() - self.hot_seconds
        while self._hot:
            sequence, entry = next(iter(self._hot.items()))
            created, at, _encoded, paths, cost = entry
            if created > cutoff and self.hot_bytes <= self.hot_limit:
                break
            self._hot.pop(sequence)
            self.hot_bytes -= cost
            if not self.persistent:
                previous = self._expired or (at, at, 0)
                self._expired = (min(at, previous[0]), max(at, previous[1]), sequence)
            for path in paths:
                self._references[path] -= 1
                if not self._references[path]:
                    del self._references[path]
                self._delete_unused(path)

    def prune(self):
        with self.lock:
            self._prune()

    def _release(self):
        paths, self._pins = self._pins, set()
        for path in paths:
            self._delete_unused(path)
        self._prune()

    def release(self):
        """Release the last query page after its media has been consumed."""
        with self.lock:
            self._release()

    def close(self):
        with self.lock:
            self._pins.clear()
            self._hot.clear()
            self._references.clear()
            self.hot_bytes = 0
            if self._temporary is not None:
                shutil.rmtree(self._temporary)
                self._temporary = None

    def _entries(self, segment):
        if segment is None:
            with self.path.open("rb") as stream:
                while True:
                    offset = stream.tell()
                    line = stream.readline()
                    if not line or not line.endswith(b"\n"):
                        return
                    record = json.loads(line)
                    yield timestamp(record["recordedAt"], "recordedAt"), record["sequence"], offset, len(line), self.path
        else:
            path = Path(segment["path"])
            with path.with_suffix(".idx").open("rb") as stream:
                while raw := stream.read(_ENTRY.size):
                    if len(raw) != _ENTRY.size:
                        return
                    yield (*_ENTRY.unpack(raw), path.with_suffix(".jsonl"))

    def _read(self, entry):
        _at, sequence, offset, length, path = entry
        if sequence in self._hot:
            return json.loads(self._hot[sequence][2])
        with path.open("rb") as stream:
            stream.seek(offset)
            return json.loads(stream.read(length))

    def _availability(self, query, records):
        points = []
        for segment in self._segments:
            points.extend(point for point in (segment["minimum"], segment["maximum"]) if point)
        if self._legacy:
            if self._legacy_bounds is None:
                # Legacy rows can also contain a wall-clock correction. Scan
                # once on demand, retaining only the two range endpoints.
                minimum = maximum = None
                for entry in self._entries(None):
                    pair = entry[:2]
                    minimum = pair if minimum is None else min(minimum, pair)
                    maximum = pair if maximum is None else max(maximum, pair)
                self._legacy_bounds = [point for point in (minimum, maximum) if point]
            points.extend({"sequence": sequence, "recordedAt": _iso(at)} for at, sequence in self._legacy_bounds)
        points.extend({"sequence": sequence, "recordedAt": _iso(entry[1])} for sequence, entry in self._hot.items())
        by_time = lambda point: (timestamp(point["recordedAt"], "recordedAt"), point["sequence"])
        expired = False
        if self._expired:
            earliest, latest, sequence = self._expired
            if "at" in query:
                expired = not records and timestamp(query["at"], "at") >= earliest
            elif any(key in query for key in ("start", "end", "after")):
                start = timestamp(query["start"], "start") if "start" in query else -math.inf
                end = timestamp(query["end"], "end") if "end" in query else math.inf
                expired = query.get("after", 0) < sequence and start <= latest and end >= earliest
            else:
                expired = not records
        return {"persistent": self.persistent, "hotSeconds": self.hot_seconds,
                "earliest": min(points, key=by_time) if points else None,
                "latest": max(points, key=by_time) if points else None, "expired": expired}

    def observe(self, query=None):
        query = {} if query is None else query
        if not isinstance(query, dict):
            raise ValueError("Observation query must be an object")
        if set(query) - {"at", "start", "end", "limit", "after"}:
            raise ValueError("Unknown observation query parameter")
        query = {key: value for key, value in query.items()
                 if value is not None and not (key in {"at", "start", "end"}
                                               and isinstance(value, str) and not value.strip())}
        limit, after = query.get("limit", 8), query.get("after", 0)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 64:
            raise ValueError("limit must be an integer from 1 to 64")
        if isinstance(after, bool) or not isinstance(after, int) or after < 0:
            raise ValueError("after must be a non-negative sequence integer")
        if "at" in query and query.get("after") == 0:
            query.pop("after")
        if "at" in query and any(key in query for key in ("start", "end", "after")):
            raise ValueError("at cannot be combined with start, end, or after")
        at = timestamp(query["at"], "at") if "at" in query else None
        start = timestamp(query["start"], "start") if "start" in query else -math.inf
        end = timestamp(query["end"], "end") if "end" in query else math.inf
        if start > end:
            raise ValueError("start must not be later than end")
        latest = at is None and not any(key in query for key in ("start", "end", "after"))
        with self.lock:
            self._release()
            selected = []
            if not self.persistent:
                entries = ((entry[1], sequence, 0, 0, None) for sequence, entry in self._hot.items())
                selected = self._select(entries, at, start, end, after, limit, latest)
            elif latest and self._hot:
                sequence = next(reversed(self._hot))
                selected = [(self._hot[sequence][1], sequence, 0, 0, None)]
            else:
                segments = ([None] if self._legacy else []) + self._segments
                # Newer recording sequences win latest; point queries use wall
                # time and retain correctness when that clock moves backwards.
                if latest:
                    segments = list(reversed(segments))
                elif at is not None:
                    # Try the closest possible segment first. Older summaries
                    # then skip entire indexes, including after clock rollback.
                    segments.sort(key=lambda item: (
                        timestamp(item["maximum"]["recordedAt"], "recordedAt")
                        if item and item["maximum"] else math.inf), reverse=True)
                for segment in segments:
                    if segment is not None:
                        if not segment["count"] or (at is None and not latest and segment["lastSequence"] <= after):
                            continue
                        low = timestamp(segment["minimum"]["recordedAt"], "recordedAt")
                        high = timestamp(segment["maximum"]["recordedAt"], "recordedAt")
                        if at is not None and (low > at or (selected and high < selected[0][0])):
                            continue
                        if at is None and not latest and (high < start or low > end):
                            continue
                    elif at is not None and self._legacy_bounds:
                        low, high = self._legacy_bounds[0][0], self._legacy_bounds[-1][0]
                        if low > at or (selected and high < selected[0][0]):
                            continue
                    found = self._select(self._entries(segment), at, start, end, after, limit, latest)
                    if at is not None or latest:
                        if found and (not selected or (found[0][1] if latest else found[0][:2]) >
                                      (selected[0][1] if latest else selected[0][:2])):
                            selected = found
                        if latest and selected:
                            break
                    else:
                        selected.extend(found)
                        if len(selected) > limit:
                            break
            has_more = len(selected) > limit
            records = [self._read(entry) for entry in selected[:limit]]
            self._pins = {item["path"] for record in records for item in record["media"]}
            result = {"records": records, "query": query, "hasMore": has_more,
                      "availability": self._availability(query, records)}
            if has_more:
                result["nextAfter"] = records[-1]["sequence"]
            return result

    @staticmethod
    def _select(entries, at, start, end, after, limit, latest):
        selected = []
        for entry in entries:
            if latest or at is not None:
                key = entry[1] if latest else entry[:2]
                previous = (selected[0][1] if latest else selected[0][:2]) if selected else None
                if (latest or entry[0] <= at) and (previous is None or key > previous):
                    selected = [entry]
            elif entry[1] > after and start <= entry[0] <= end:
                selected.append(entry)
                if len(selected) > limit:
                    break
        return selected
