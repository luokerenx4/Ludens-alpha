"""Internal JSON bridge. Discovery parses source only; invocation executes it."""

import contextlib
import hashlib
import json
import os
from pathlib import Path
import sys
import traceback

from rsa_tools._capabilities import discover, load_function, validate
from rsa_tools.benchmarks import discover as discover_benchmarks, prepared_run


def invoke(workspace, request):
    capability = request["capability"]
    validate(request["arguments"], capability["parameters"])
    source = (workspace / capability["origin"]["path"]).resolve()
    source.relative_to(workspace)
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != capability["codeSHA"]:
        raise ValueError("Capability source changed after discovery; refresh before invoking it")
    # -B prevents cache writes, but still reads existing timestamp-based pyc.
    # Give this fresh process a nonexistent cache root so quick helper edits load.
    sys.pycache_prefix = str(workspace / "__pycache__" / ("rsa-" + os.urandom(12).hex()))
    with invocation_output():
        function = load_function(workspace, capability["origin"]["path"], capability["origin"]["function"], raw=raw)
        result = function(**request["arguments"])
        # JSON is the cross-process contract; incidental prints go to stderr.
        encoded = json.dumps({"ok": True, "result": result}, allow_nan=False)
    return encoded


def invoke_benchmark(workspace, request):
    definition = request["definition"]
    validate(request["arguments"], definition["parameters"])
    entry = definition["entry"]
    source = (workspace / entry["path"]).resolve()
    source.relative_to(workspace)
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != entry["codeSHA"]:
        raise ValueError("Benchmark source changed after discovery; refresh before invoking it")
    sys.pycache_prefix = str(workspace / "__pycache__" / ("rsa-" + os.urandom(12).hex()))
    with invocation_output():
        function = load_function(workspace, entry["path"], entry["function"], raw=raw, marker="benchmark")
        request["errorPhase"] = "execute"
        with prepared_run(request["runDir"], request["result"]):
            function(**request["arguments"])
        encoded = json.dumps({"ok": True, "result": request["result"]}, allow_nan=False)
    return encoded


@contextlib.contextmanager
def invocation_output():
    # Redirect the descriptor too, so subprocesses and native libraries cannot
    # mix incidental stdout into the bridge's single JSON reply.
    sys.stdout.flush()
    saved_stdout = os.dup(1)
    try:
        os.dup2(2, 1)
        with contextlib.redirect_stdout(sys.stderr):
            yield
    finally:
        sys.stderr.flush()
        os.dup2(saved_stdout, 1)
        os.close(saved_stdout)


def main():
    request = {}
    try:
        request = json.load(sys.stdin)
        workspace = Path(request["workspace"]).resolve()
        if request["action"] == "discover":
            print(json.dumps(discover(workspace), allow_nan=False))
        elif request["action"] == "discover_benchmarks":
            print(json.dumps(discover_benchmarks(workspace), allow_nan=False))
        elif request["action"] == "invoke":
            print(invoke(workspace, request))
        elif request["action"] == "invoke_benchmark":
            request["errorPhase"] = "load"
            print(invoke_benchmark(workspace, request))
        else:
            raise ValueError("Unknown Python bridge action")
    except BaseException as error:
        phase = "report" if request.get("result", {}).get("status") == "completed" else request.get("errorPhase")
        print(json.dumps({"ok": False, "error": {"type": type(error).__name__, "message": str(error),
                         "traceback": traceback.format_exc(), **({"phase": phase} if phase else {})}}))
        return 1
    return 0


if __name__ == "__main__":
    # This is a package-internal script, not a directory of top-level user
    # modules. Leaving its folder on sys.path shadows namespace packages such
    # as workspace/benchmarks/ with rsa_tools/benchmarks.py.
    package_directory = Path(__file__).resolve().parent
    sys.path[:] = [entry for entry in sys.path if Path(entry).resolve() != package_directory]
    sys.exit(main())
