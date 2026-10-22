"""Immutable perception records; payloads stay on disk, queries read only a page."""

import bisect
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import threading
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


class ObservationHistory:
    def __init__(self, run_dir):
        self.root = Path(run_dir).resolve()
        self.path = self.root / "perception" / "history" / "records.jsonl"
        self.media_dir = self.root / "observations"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.index = []  # (wall timestamp, global sequence, byte offset)
        self.by_sequence = []  # Same metadata, ordered by durable recording sequence.
        self.sequence = 0
        # A terminated append can leave an incomplete final line. Keep every
        # committed record and remove only that unfinished tail before appending.
        with self.path.open("a+b") as stream:
            stream.seek(0)
            while True:
                offset = stream.tell()
                line = stream.readline()
                if not line:
                    break
                if not line.endswith(b"\n"):
                    stream.truncate(offset)
                    break
                record = json.loads(line)
                sequence = record["sequence"]
                self.sequence = max(self.sequence, sequence)
                at = timestamp(record["recordedAt"], "recordedAt")
                self.index.append((at, sequence, offset))
                self.by_sequence.append((sequence, at, offset))
        self.index.sort()

    def append(self, sample, generation, sampling, recorded_at=None):
        if not isinstance(sample, dict):
            raise TypeError("sample() must return an object")
        text = sample.get("text", "")
        media = sample.get("media", [])
        if not isinstance(text, str):
            raise TypeError("sample.text must be a string")
        if not isinstance(media, list):
            raise TypeError("sample.media must be an array")
        if "sampledAt" in sample:
            timestamp(sample["sampledAt"], "sampledAt")
        if "sources" in sample and not isinstance(sample["sources"], list):
            raise TypeError("sample.sources must be an array")
        # Validate metadata before copying potentially large media files.
        json.dumps(sample, allow_nan=False)
        for item in media:
            if (not isinstance(item, dict) or not isinstance(item.get("path"), str)
                    or not isinstance(item.get("mediaType"), str) or not item["mediaType"]):
                raise TypeError("sample.media entries must contain path and mediaType strings")
        archived = [{"path": str(self._archive(Path(item["path"]))),
                     "mediaType": item["mediaType"]} for item in media]
        with self.lock:
            record = {
                "id": str(uuid.uuid4()), "sequence": self.sequence + 1,
                "generation": generation,
                "recordedAt": recorded_at or datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "sampling": sampling, "text": text, "media": archived,
            }
            for key in ("sampledAt", "sources"):
                if key in sample:
                    record[key] = sample[key]
            encoded = (json.dumps(record, allow_nan=False) + "\n").encode("utf-8")
            with self.path.open("ab") as stream:
                offset = stream.tell()
                stream.write(encoded)
                stream.flush()
            self.sequence = record["sequence"]
            at = timestamp(record["recordedAt"], "recordedAt")
            bisect.insort(self.index, (at, self.sequence, offset))
            self.by_sequence.append((self.sequence, at, offset))
            return record

    def _archive(self, source):
        digest = hashlib.sha256()
        descriptor, name = tempfile.mkstemp(prefix=".history-", dir=self.media_dir)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as output, source.open("rb") as incoming:
                while block := incoming.read(1024 * 1024):
                    digest.update(block)
                    output.write(block)
            suffix = source.suffix.lower()
            destination = self.media_dir / f"history-{digest.hexdigest()}{suffix}"
            if destination.exists():
                temporary.unlink()
            else:
                temporary.replace(destination)
            return destination
        finally:
            temporary.unlink(missing_ok=True)

    def observe(self, query=None):
        query = {} if query is None else query
        if not isinstance(query, dict):
            raise ValueError("Observation query must be an object")
        if set(query) - {"at", "start", "end", "limit", "after"}:
            raise ValueError("Unknown observation query parameter")
        # Optional tool arguments may arrive as null or blank timestamps.
        # Normalize once here so the CLI, model tool, and Python callers agree.
        query = {key: value for key, value in query.items()
                 if value is not None and not (key in {"at", "start", "end"}
                                               and isinstance(value, str) and not value.strip())}
        limit = query.get("limit", 8)
        after = query.get("after", 0)
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 64:
            raise ValueError("limit must be an integer from 1 to 64")
        if isinstance(after, bool) or not isinstance(after, int) or after < 0:
            raise ValueError("after must be a non-negative sequence integer")
        # Sequence zero does not advance a point query. Keep it for range
        # queries, where it explicitly requests the beginning of history.
        if "at" in query and query.get("after") == 0:
            query.pop("after")
        if "at" in query and any(key in query for key in ("start", "end", "after")):
            raise ValueError("at cannot be combined with start, end, or after")
        at = timestamp(query["at"], "at") if "at" in query else None
        start = timestamp(query["start"], "start") if "start" in query else -math.inf
        end = timestamp(query["end"], "end") if "end" in query else math.inf
        if start > end:
            raise ValueError("start must not be later than end")
        with self.lock:
            if at is not None:
                position = bisect.bisect_right(self.index, (at, math.inf, math.inf))
                selected = self.index[position - 1:position] if position else []
            elif not any(key in query for key in ("start", "end", "after")):
                selected = self.by_sequence[-1:]
            else:
                # Pagination uses recording sequence so a wall-clock correction
                # cannot make the cursor skip or repeat a successfully saved sample.
                left = bisect.bisect_right(self.by_sequence, (after, math.inf, math.inf))
                selected = []
                for position in range(left, len(self.by_sequence)):
                    entry = self.by_sequence[position]
                    if start <= entry[1] <= end:
                        selected.append(entry)
                        if len(selected) > limit:
                            break
            has_more = len(selected) > limit
            offsets = [entry[2] for entry in selected[:limit]]
        records = []
        with self.path.open("rb") as stream:
            for offset in offsets:
                stream.seek(offset)
                records.append(json.loads(stream.readline()))
        result = {"records": records, "query": query, "hasMore": has_more}
        if has_more:
            result["nextAfter"] = records[-1]["sequence"]
        return result
