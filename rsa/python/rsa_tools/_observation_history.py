"""Bounded recent observations with lazily read, time-segmented history."""

from collections import Counter, OrderedDict
from datetime import datetime, timezone
import base64
import binascii
import fcntl
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
# Each entry holds wall time, sequence, payload offset/length, and compact
# capability/record IDs, so channel queries need not open every JSON record.
_ENTRY = struct.Struct(">dQQQ16s16s")


def _key(value):
    return hashlib.sha256(value.encode("utf-8")).digest()[:16]


MAIN_CAPABILITY = "python/perception.py:Perception.sample"
SAMPLE_FIELDS = {"text", "data", "media", "sampledAt", "sources", "space", "timeline"}


def validate_sample(sample, workspace):
    """Validate the sensing envelope without silently dropping sensor fields."""
    if not isinstance(sample, dict):
        raise TypeError("A perception capability must return an observation object")
    if set(sample) - SAMPLE_FIELDS:
        raise ValueError("Unknown observation fields: " + ", ".join(sorted(set(sample) - SAMPLE_FIELDS)))
    if not isinstance(sample.get("text", ""), str):
        raise TypeError("sample.text must be a string")
    if not isinstance(sample.get("media", []), list):
        raise TypeError("sample.media must be an array")
    if "sampledAt" in sample:
        timestamp(sample["sampledAt"], "sampledAt")
    if "sources" in sample and not isinstance(sample["sources"], list):
        raise TypeError("sample.sources must be an array")
    json.dumps(sample, allow_nan=False)
    for item in sample.get("media", []):
        if (not isinstance(item, dict) or not isinstance(item.get("mediaType"), str)
                or not item["mediaType"] or set(item) - {"path", "data", "mediaType", "timeline"}):
            raise TypeError("sample.media entries require mediaType and path or base64 data")
        if "data" in item:
            if not isinstance(item["data"], str):
                raise TypeError("sample.media.data must be base64 text")
            try:
                base64.b64decode(item["data"], validate=True)
            except (ValueError, binascii.Error):
                raise ValueError("sample.media.data must be valid base64") from None
        elif isinstance(item.get("path"), str):
            source = Path(item["path"])
            source = source if source.is_absolute() else Path(workspace) / source
            if not source.is_file():
                raise FileNotFoundError(str(source))
        else:
            raise TypeError("sample.media entries require path or base64 data")


def observation_result(record):
    """Return a composable sensing envelope, rather than storage internals."""
    return {key: record[key] for key in SAMPLE_FIELDS if key in record}


class ObservationHistory:
    def __init__(self, workspace):
        self.root = Path(workspace).resolve()
        self.directory = self.root / ".rsa" / "timeline"
        self.directory.mkdir(parents=True, exist_ok=True)
        self._writer = (self.directory / "writer.lock").open("a+b")
        try:
            fcntl.flock(self._writer.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._writer.close()
            raise RuntimeError("This workspace timeline already has a writer") from None
        try:
            self._initialize()
        except BaseException:
            self._unlock()
            raise

    def _unlock(self):
        writer = getattr(self, "_writer", None)
        if writer is not None and not writer.closed:
            fcntl.flock(writer.fileno(), fcntl.LOCK_UN)
            writer.close()

    def __del__(self):
        self._unlock()

    def _initialize(self):
        self.objects = self.directory / "objects"
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
        self._expired = None  # min/max wall time and last evicted sequence, not old records.
        self._temporary = None
        self._active = None
        self._segments = []
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
        sequence_path = self.directory / "sequence.json"
        if sequence_path.exists():
            self.sequence = max(self.sequence, json.loads(sequence_path.read_text()))
        if not self.persistent:
            # No old persistent history is exposed in window-only mode.
            self._segments = []
            self._temporary = Path(tempfile.mkdtemp(prefix=f"window-{os.getpid()}-", dir=self.directory))

    def policy(self):
        return {"persistent": self.persistent, "hotSeconds": self.hot_seconds,
                "hotBytes": self.hot_limit, "segmentSeconds": self.segment_seconds,
                "segmentBytes": self.segment_limit}

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
                index.write(_ENTRY.pack(at, record["sequence"], offset, len(line), _key(record["capability"]), _key(record["id"])))
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

    def append(self, sample, generation, sampling, recorded_at=None, *, identity=None, run_id=None, trace=None):
        validate_sample(sample, self.root)
        if not isinstance(sampling, dict) or set(sampling) != {"clock", "startedAtMs", "finishedAtMs"}:
            raise ValueError("sampling requires clock, startedAtMs and finishedAtMs")
        if not isinstance(sampling["clock"], str) or not sampling["clock"].strip():
            raise ValueError("sampling.clock must be a nonempty clock ID")
        try:
            finite = all(type(sampling[key]) in (int, float) and math.isfinite(sampling[key])
                         for key in ("startedAtMs", "finishedAtMs"))
        except OverflowError:
            finite = False
        if not finite:
            raise ValueError("sampling timestamps must be finite numbers")
        if sampling["finishedAtMs"] < sampling["startedAtMs"]:
            raise ValueError("sampling.finishedAtMs must not precede startedAtMs")
        identity = identity or {"id": MAIN_CAPABILITY}
        if not isinstance(identity, dict) or not isinstance(identity.get("id"), str) or not identity["id"]:
            raise ValueError("A recorded observation requires its capability identity")
        json.dumps({"identity": identity, "sampling": sampling, "trace": trace}, allow_nan=False)
        recorded_at = recorded_at or _iso(time.time())
        at = timestamp(recorded_at, "recordedAt")
        with self.lock:
            if self._writer.closed:
                raise RuntimeError("Workspace timeline writer is closed")
            self._prune()
            segment = self._active
            if self.persistent and (segment is None
                    or segment["bucket"] != math.floor(at / self.segment_seconds)
                    or segment["recordBytes"] + segment["mediaBytes"] >= self.segment_limit):
                segment = self._new_segment(at)
            media_dir = self.objects if self.persistent else self._temporary
            reference = {"recordId": str(uuid.uuid4()), "sequence": self.sequence + 1}
            archived, media_bytes = [], 0
            for item in sample.get("media", []):
                path, added = self._archive(item, media_dir)
                archived.append({"path": str(path), "mediaType": item["mediaType"],
                                 "timeline": {**reference, "asset": path.relative_to(self.directory).as_posix()}})
                media_bytes += path.stat().st_size
                if segment is not None:
                    segment["mediaBytes"] += added
            record = {"id": reference["recordId"], "sequence": reference["sequence"],
                      "timeline": reference, "capability": identity["id"], "identity": identity,
                      "generation": generation, "runId": run_id, "trace": trace or {},
                      "recordedAt": recorded_at, "sampling": sampling,
                      "text": sample.get("text", ""), "media": archived}
            for key in ("sampledAt", "sources", "data", "space"):
                if key in sample:
                    record[key] = sample[key]
            encoded = (json.dumps(record, allow_nan=False) + "\n").encode("utf-8")
            if self.persistent:
                path = Path(segment["path"])
                with path.with_suffix(".jsonl").open("ab") as records:
                    offset = records.tell()
                    records.write(encoded)
                with path.with_suffix(".idx").open("ab") as index:
                    index.write(_ENTRY.pack(at, record["sequence"], offset, len(encoded), _key(record["capability"]), _key(record["id"])))
                self._update_segment(segment, record, offset + len(encoded))
                self._save_meta(segment)
            self.sequence = record["sequence"]
            temporary = self.directory / "sequence.tmp"
            temporary.write_text(str(self.sequence))
            temporary.replace(self.directory / "sequence.json")
            paths = tuple(item["path"] for item in archived)
            cost = len(encoded) + media_bytes
            self._hot[self.sequence] = (time.monotonic(), at, encoded, paths, cost, _key(record["capability"]), _key(record["id"]))
            self.hot_bytes += cost
            self._references.update(paths)
            # Window media may expire as soon as this call releases the lock.
            # Deliver its bytes now, without a second permanent archive or lease.
            result = self._delivery(record)
            self._prune()
            return result

    def _archive(self, item, directory):
        directory.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        descriptor, name = tempfile.mkstemp(prefix=".copy-", dir=directory)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as output:
                if "data" in item:
                    block = base64.b64decode(item["data"], validate=True)
                    digest.update(block)
                    output.write(block)
                else:
                    source = Path(item["path"])
                    source = source if source.is_absolute() else self.root / source
                    with source.open("rb") as incoming:
                        while block := incoming.read(1024 * 1024):
                            digest.update(block)
                            output.write(block)
            # MIME belongs to each observation, not to the content address.
            destination = directory / (digest.hexdigest() + ".bin")
            added = 0
            if not destination.exists():
                added = temporary.stat().st_size
                temporary.replace(destination)
            return destination, added
        finally:
            temporary.unlink(missing_ok=True)

    def derive(self, source, data, media_type, transform):
        """Retain an encoding of one proven record; never promote window media."""
        if (not isinstance(source, dict) or set(source) != {"asset", "recordId", "sequence"}
                or not isinstance(source["asset"], str) or not isinstance(source["recordId"], str)
                or type(source["sequence"]) is not int or source["sequence"] < 1):
            raise ValueError("A derived media source requires asset, recordId and sequence")
        if not isinstance(media_type, str) or not media_type or not isinstance(transform, str) or not transform:
            raise ValueError("Derived media requires mediaType and transform")
        if not isinstance(data, str):
            raise ValueError("Derived media requires base64 data")
        try:
            raw = base64.b64decode(data, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("Derived media requires valid base64 data") from None
        with self.lock:
            if self._writer.closed:
                raise RuntimeError("Workspace timeline writer is closed")
            self._prune()
            record = self._record_at(source["sequence"])
            if record is None or record["id"] != source["recordId"]:
                raise ValueError("Derived media source record is missing or expired")
            original = next((item for item in record["media"]
                             if item["timeline"]["asset"] == source["asset"]), None)
            if original is None:
                raise ValueError("Derived media source asset does not belong to the record")
            path = self.directory / source["asset"]
            directory = self.objects if self.persistent else self._temporary
            # Only writer-owned immutable media is a source, never an arbitrary
            # file path supplied by the encoder or a symlink outside this axis.
            if (path.parent != directory or path.resolve() != path or not path.is_file()
                    or Path(original["path"]) != path):
                raise ValueError("Derived media source asset is missing or outside the timeline")
            digest = hashlib.sha256(raw).hexdigest()
            destination = directory / (digest + ".bin")
            if destination.exists() and (destination.resolve() != destination or not destination.is_file()):
                raise ValueError("Derived media destination must be a timeline object")
            destination, _added = self._archive({"data": data}, directory)
            if not self.persistent:
                entry = self._hot[source["sequence"]]
                path_text = str(destination)
                if path_text not in entry[3]:
                    cost = destination.stat().st_size
                    self._hot[source["sequence"]] = (*entry[:3], (*entry[3], path_text), entry[4] + cost, *entry[5:])
                    self._references[path_text] += 1
                    self.hot_bytes += cost
                # A large derivative may itself exhaust the window. Its caller
                # still holds the delivered bytes; a later reader sees expiry.
                self._prune()
            return {"sha256": digest, "asset": destination.relative_to(self.directory).as_posix(),
                    "mediaType": media_type, "bytes": len(raw), "recordId": source["recordId"],
                    "sequence": source["sequence"], "sourceAsset": source["asset"], "transform": transform}

    def _record_at(self, sequence):
        if sequence in self._hot:
            return json.loads(self._hot[sequence][2])
        if not self.persistent:
            return None
        for segment in self._segments:
            if not segment["firstSequence"] <= sequence <= segment["lastSequence"]:
                continue
            path = Path(segment["path"])
            with path.with_suffix(".idx").open("rb") as index:
                index.seek((sequence - segment["firstSequence"]) * _ENTRY.size)
                raw = index.read(_ENTRY.size)
            if len(raw) != _ENTRY.size:
                return None
            values = _ENTRY.unpack(raw)
            if values[1] != sequence:
                return None
            return self._read((*values[:4], path.with_suffix(".jsonl"), *values[4:]))
        return None

    def _delivery(self, record):
        if self.persistent:
            return record
        return {**record, "media": [{**item, "data": base64.b64encode(Path(item["path"]).read_bytes()).decode("ascii")}
                                    for item in record["media"]]}

    def _delete_unused(self, path):
        if not self.persistent and not self._references.get(path):
            Path(path).unlink(missing_ok=True)

    def _prune(self):
        cutoff = time.monotonic() - self.hot_seconds
        while self._hot:
            sequence, entry = next(iter(self._hot.items()))
            created, at, _encoded, paths, cost = entry[:5]
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

    def close(self):
        if self._writer.closed:
            return
        try:
            with self.lock:
                self._hot.clear()
                self._references.clear()
                self.hot_bytes = 0
                if self._temporary is not None:
                    shutil.rmtree(self._temporary)
                    self._temporary = None
        finally:
            self._unlock()

    def _entries(self, segment):
        path = Path(segment["path"])
        with path.with_suffix(".idx").open("rb") as stream:
            while raw := stream.read(_ENTRY.size):
                if len(raw) != _ENTRY.size:
                    return
                values = _ENTRY.unpack(raw)
                yield (*values[:4], path.with_suffix(".jsonl"), *values[4:])

    def _read(self, entry):
        _at, sequence, offset, length, path = entry[:5]
        if sequence in self._hot:
            return json.loads(self._hot[sequence][2])
        with path.open("rb") as stream:
            stream.seek(offset)
            return json.loads(stream.read(length))

    def _availability(self, query, records):
        points = []
        for segment in self._segments:
            points.extend(point for point in (segment["minimum"], segment["maximum"]) if point)
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
        if set(query) - {"at", "start", "end", "limit", "after", "capability", "id"}:
            raise ValueError("Unknown observation query parameter")
        query = {key: value for key, value in query.items()
                 if value is not None and not (key in {"at", "start", "end", "capability", "id"}
                                               and isinstance(value, str) and not value.strip())}
        capability, record_id = query.get("capability", MAIN_CAPABILITY), query.get("id")
        if not isinstance(capability, str) or not capability:
            raise ValueError("capability must be a nonempty capability ID or *")
        if record_id is not None and (not isinstance(record_id, str) or not record_id):
            raise ValueError("id must be a nonempty record ID")
        if record_id is not None and any(key in query for key in ("at", "start", "end", "after")):
            raise ValueError("id cannot be combined with a time or sequence query")
        if record_id is not None and "capability" not in query:
            capability = "*"
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
            self._prune()
            selected = []
            if not self.persistent:
                entries = ((entry[1], sequence, 0, 0, None, entry[5], entry[6]) for sequence, entry in self._hot.items())
                selected = self._select(entries, at, start, end, after, limit, latest, capability, record_id)
            else:
                segments = list(self._segments)
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
                    found = self._select(self._entries(segment), at, start, end, after, limit, latest, capability, record_id)
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
            records = [self._delivery(self._read(entry)) for entry in selected[:limit]]
            result = {"records": records, "query": query, "hasMore": has_more,
                      "availability": self._availability(query, records)}
            if has_more:
                result["nextAfter"] = records[-1]["sequence"]
            return result

    def _select(self, entries, at, start, end, after, limit, latest, capability, record_id):
        selected = []
        capability_key = None if capability == "*" else _key(capability)
        record_key = None if record_id is None else _key(record_id)
        for entry in entries:
            if (not latest and at is None and (entry[1] <= after or not start <= entry[0] <= end)) or (at is not None and entry[0] > at):
                continue
            if (capability_key is not None and entry[5] != capability_key) or (record_key is not None and entry[6] != record_key):
                continue
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
