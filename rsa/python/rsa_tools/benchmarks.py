"""Evidence client for a trial assigned by Shiori; never starts or finishes runs."""

import atexit
import hashlib
import json
import os
from pathlib import Path
import uuid

from . import _context

_MISSING = object()


def _json(value):
    return json.dumps(value, allow_nan=False, ensure_ascii=False)


def _write(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(_json(value) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class Trial:
    """Collect execution evidence inside one Shiori-owned Python program.

    Shiori owns identity, budgets, execution status and verification. This client
    writes only artifacts/context.json; it never appends the host event log.
    Call flush() before returning control in a persistent Python process. One
    measurement program owns context.json; collect subprocess facts in that
    parent instead of calling current_trial() in multiple writers.
    """

    def __init__(self, identity, run_dir, artifacts, task_dir, input_path):
        self.id = identity
        self.run_dir = Path(run_dir).resolve(strict=True)
        self.artifacts = Path(artifacts).resolve(strict=True)
        self.task_dir = Path(task_dir).resolve(strict=True)
        self.input_path = Path(input_path).resolve(strict=True)
        self.artifacts.relative_to(self.run_dir)
        if not self.artifacts.is_dir() or not self.task_dir.is_dir() or not self.input_path.is_file():
            raise ValueError("Shiori trial paths must name existing artifacts/task directories and input file")
        self.workspace = Path(_context.current()["workspace"]).resolve()
        self._facts = {"trialId": self.id, "workspace": str(self.workspace), "conditions": {}, "subjects": [], "artifacts": [],
                       "limitations": [], "capabilityCalls": []}
        self._calls = {}
        self.flush()

    def flush(self):
        """Commit this program's small fact manifest, not a trial result."""
        _write(self.artifacts / "context.json", self._facts)

    def conditions(self, **values):
        self._facts["conditions"].update(json.loads(_json(values)))
        self.flush()

    def subject(self, id, *, path=None, sha256=None, revision=None):
        if not isinstance(id, str) or not id:
            raise ValueError("Trial subject requires a nonempty ID")
        item = {"id": id, **{key: str(value) for key, value in
                {"path": path, "sha256": sha256, "revision": revision}.items() if value is not None}}
        if item not in self._facts["subjects"]:
            self._facts["subjects"].append(item)
        self.flush()
        return item

    def artifact(self, path, value=_MISSING, *, label=None):
        """Register a workspace file or JSON value; recorded media stays referenced.

        artifact("samples.json", samples) creates JSON in this trial's artifacts.
        artifact(existing_path) copies external files by content hash, or records
        files already in the artifacts directory. Neither operation seals files.
        Timeline envelopes are validated and referenced without copying media.
        """
        if label is not None and not isinstance(label, str):
            raise ValueError("Artifact label must be a string")
        if isinstance(path, dict):
            if value is not _MISSING:
                raise ValueError("Recorded media cannot also supply a JSON value")
            return self._timeline_artifact(path.get("timeline", path), label)
        if value is not _MISSING:
            relative = Path(path)
            if relative.is_absolute() or ".." in relative.parts or relative.name == "context.json":
                raise ValueError("JSON artifact must use a trial-relative path other than context.json")
            source = (self.artifacts / relative).resolve()
            source.relative_to(self.artifacts)
            source.parent.mkdir(parents=True, exist_ok=True)
            # Creating an artifact must not accidentally replace an existing file.
            with source.open("x", encoding="utf-8") as output:
                output.write(_json(value) + "\n")
        else:
            source = Path(path)
            source = (self.workspace / source).resolve() if not source.is_absolute() else source.resolve()
            if not source.is_relative_to(self.workspace) and not source.is_relative_to(self.artifacts):
                raise ValueError("Artifact must be inside the workspace or assigned artifacts directory")
        data = source.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if source.is_relative_to(self.artifacts):
            destination = source
        else:
            destination = self.artifacts / (digest + "-" + source.name)
            if not destination.exists():
                with destination.open("xb") as output:
                    output.write(data)
        item = {"path": destination.relative_to(self.run_dir).as_posix(), "sha256": digest,
                **({"label": label} if label is not None else {})}
        if item not in self._facts["artifacts"]:
            self._facts["artifacts"].append(item)
        self.flush()
        return item

    def _timeline_artifact(self, reference, label):
        from ._observation_history import read_timeline_record
        from ._video import media_path

        if (not isinstance(reference, dict) or not isinstance(reference.get("recordId"), str)
                or not isinstance(reference.get("asset"), str)):
            raise ValueError("A timeline artifact requires recordId, sequence and asset")
        if label is not None and not isinstance(label, str):
            raise ValueError("Benchmark artifact label must be a string")
        workspace = Path(self.workspace).resolve()
        record = read_timeline_record(workspace, reference.get("sequence"))
        if record["id"] != reference["recordId"]:
            raise ValueError("Timeline artifact record identity does not match")
        media = next((item for item in record["media"] if item["timeline"] == reference), None)
        if media is None:
            raise ValueError("Timeline artifact does not belong to the recorded observation")
        reference = media["timeline"]  # Retain the committed record, not a caller-owned mutable dict.
        timeline = workspace / ".rsa" / "timeline"
        source = media_path(timeline, reference["asset"])
        video = reference.get("video")
        item = {"path": source.relative_to(workspace).as_posix(), "timeline": reference,
                "mediaType": media["mediaType"], **({"label": label} if label is not None else {})}
        if video is not None:
            if video.get("status") == "gap":
                raise ValueError("Cannot attach an unrecorded video gap")
            status = json.loads(media_path(timeline, reference["asset"] + ".json").read_text())
            if status.get("status") not in {"pending", "ready"}:
                raise ValueError("Recorded video artifact is unavailable")
            if status["status"] == "ready" and not source.is_file():
                raise ValueError("Recorded video artifact is missing")
            item["approximate"] = True
        else:
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            if source.name != digest + ".bin":
                raise ValueError("Recorded artifact checksum does not match its source")
            item["sha256"] = digest
        self._facts["artifacts"].append(item)
        self.flush()
        return item


    def limitations(self, *messages):
        if any(not isinstance(message, str) for message in messages):
            raise ValueError("Trial limitations must be strings")
        self._facts["limitations"].extend(messages)
        self.flush()

    def _observe(self, context, event_type, data, origin):
        if event_type not in {"python_call_start", "python_call_end"} or not data.get("codeSHA"):
            return
        key = (data["id"], data["codeSHA"])
        if key not in self._calls:
            subject = {"id": data["id"], "revision": data["codeSHA"]}
            if subject not in self._facts["subjects"]:
                self._facts["subjects"].append(subject)
            self._calls[key] = {**subject, "started": 0, "succeeded": 0, "failed": 0,
                                "durationMs": 0, "firstEventId": origin["eventId"]}
            self._facts["capabilityCalls"].append(self._calls[key])
        calls = self._calls[key]
        calls["lastEventId"] = origin["eventId"]
        if event_type == "python_call_start":
            calls["started"] += 1
        else:
            calls["succeeded" if data.get("outcome") == "success" else "failed"] += 1
            calls["durationMs"] += data.get("durationMs", 0)
        # No per-call disk write. flush()/artifact()/normal process exit commits
        # aggregate evidence; a killed program remains an incomplete execution.


_current = None


def current_trial():
    """Join the identity assigned by Shiori, or raise outside such a program."""
    global _current
    keys = ["RSA_BENCH_TRIAL_ID", "RSA_BENCH_RUN_DIR", "RSA_BENCH_ARTIFACTS",
            "RSA_BENCH_TASK_DIR", "RSA_BENCH_INPUT"]
    values = [os.environ.get(key) for key in keys]
    if not all(values):
        raise RuntimeError("No Shiori trial is assigned; required environment: " + ", ".join(keys))
    if _current is not None and (_current.id, str(_current.run_dir)) == (values[0], str(Path(values[1]).resolve())):
        return _current
    if _current is not None:
        _current.flush()
    _current = Trial(*values)
    _context._trial_observer = _current._observe
    return _current


def _flush_current():
    if _current is not None:
        _current.flush()


atexit.register(_flush_current)
