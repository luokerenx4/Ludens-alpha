"""Author reports share one schema with the CLI; execution facts live elsewhere."""

from datetime import datetime, timezone
from functools import lru_cache
import json
import math
import os
from pathlib import Path
import uuid


def _pointer(parts):
    return "/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in parts) if parts else ""


def json_errors(value):
    """Reject non-JSON values before schema validation or JSON encoding can coerce them."""
    errors, ancestors = [], set()

    def visit(item, path):
        if item is None or type(item) in (str, bool, int):
            return
        if type(item) is float:
            if not math.isfinite(item):
                errors.append({"path": _pointer(path), "message": "Must be a finite JSON number; use null for a missing measurement"})
            return
        if type(item) not in (dict, list):
            errors.append({"path": _pointer(path), "message": "Must be a JSON value, not " + type(item).__name__})
            return
        if id(item) in ancestors:
            errors.append({"path": _pointer(path), "message": "Circular values cannot be stored as JSON"})
            return
        ancestors.add(id(item))
        for key, child in item.items() if isinstance(item, dict) else enumerate(item):
            if isinstance(item, dict) and type(key) is not str:
                errors.append({"path": _pointer(path), "message": "JSON object keys must be strings"})
            visit(child, (*path, key))
        ancestors.remove(id(item))

    visit(value, ())
    return errors


@lru_cache(maxsize=1)
def _validator():
    from jsonschema.validators import validator_for
    schema = json.loads((Path(__file__).resolve().parents[2] / "benchmarks" / "report.schema.json").read_text())
    return validator_for(schema)(schema)


def validate_report(raw):
    """Return all author-facing errors and the canonical outcome, without side effects."""
    errors = json_errors(raw)
    if not errors:
        errors = [{"path": _pointer(error.absolute_path), "message": error.message}
                  for error in _validator().iter_errors(raw)]
    errors.sort(key=lambda error: (error["path"], error["message"]))
    if errors:
        return errors, None
    outcome = {
        "checks": [{"id": id, "label": id, "evidenceSeq": [], **item}
                   for id, item in raw.get("checks", {}).items()],
        "metrics": [{"id": id, "direction": "none", **item} for id, item in raw.get("metrics", {}).items()],
    }
    return [], outcome


def _write(path, value):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, allow_nan=False, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _ordered_reports(directory):
    reports = [json.loads(path.read_text(encoding="utf-8")) for path in directory.glob("*.json")
               if not path.name.endswith(".raw.json")]
    by_id = {report["id"]: report for report in reports}
    ordered, visited, visiting = [], set(), set()

    def visit(report):
        id = report["id"]
        if id in visited:
            return
        if id in visiting:
            raise ValueError("Benchmark report history contains a cycle")
        visiting.add(id)
        previous = report["previousReportId"]
        if previous is not None:
            if previous not in by_id:
                raise ValueError("Benchmark report history is missing " + previous)
            visit(by_id[previous])
        visiting.remove(id)
        visited.add(id)
        ordered.append(report)

    for report in sorted(reports, key=lambda report: (report["createdAt"], report["id"])):
        visit(report)
    return ordered


def write_report(directory, execution, raw, *, reason="initial"):
    """Persist the returned value before validating it, then append one immutable report."""
    directory = Path(directory) / "reports"
    directory.mkdir(exist_ok=True)
    created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    id = created_at.replace(":", "-") + "-" + uuid.uuid4().hex[:8]
    history = _ordered_reports(directory)
    previous = history[-1] if history else None
    # None is the documented empty report. Invalid Python values retain a repr;
    # never coerce NaN/Infinity to a successful missing measurement.
    raw = {} if raw is None else raw
    serialization_errors = json_errors(raw)
    saved = {"raw": None, "rawText": repr(raw)} if serialization_errors else {
        "raw": json.loads(json.dumps(raw, allow_nan=False, ensure_ascii=False))}
    _write(directory / (id + ".raw.json"), saved)
    errors, outcome = (serialization_errors, None) if serialization_errors else validate_report(saved["raw"])
    report = {"schemaVersion": 1, "id": id, "runId": execution["runId"], "createdAt": created_at,
              "previousReportId": previous["id"] if previous else None, "reason": reason,
              "protocolVersion": previous["protocolVersion"] if previous else execution["definition"]["protocolVersion"],
              **saved, "errors": errors, "outcome": outcome}
    _write(directory / (id + ".json"), report)
    return report
