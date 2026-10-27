"""Synchronous access to the workspace's unified capability interface."""

from pathlib import Path
from typing import Any
from ._context import RSAError, continuous, current, request, scope


class Client:
    """Call driver or Python capabilities using the current control epoch.

    Python functions run in this process. Driver requests use one connection;
    the client never acquires control or retries actions.
    """

    def __init__(self, socket_path: str | None = None, *, epoch: str | None = None,
                 trace: dict[str, Any] | None = None, timeout: float | None = None) -> None:
        self.socket_path = socket_path
        self.epoch = epoch
        self.trace = trace
        self.timeout = timeout

    def _context(self) -> dict[str, Any]:
        # Resolve defaults at the call site, so a module-level Client also
        # inherits the active local function's trace.
        parent = current()
        context = {**parent, **{key: value for key, value in {
            "socket_path": self.socket_path, "epoch": self.epoch,
            "trace": self.trace, "timeout": self.timeout,
        }.items() if value is not None}}
        # A client may choose its call trace, but it cannot accidentally discard
        # the sampler's purpose or run ownership across a driver boundary.
        trace = dict(context["trace"])
        if continuous(parent):
            trace["recordingPurpose"] = "continuous-perception"
        if parent.get("trace", {}).get("recordingId"):
            trace["recordingId"] = parent["trace"]["recordingId"]
        context["trace"] = trace
        return context

    def _request(self, action: str, **fields: Any) -> Any:
        context = self._context()
        message = {"kind": "controller", "argv": [], "action": action, **fields}
        if context["epoch"] is not None:
            message["epoch"] = context["epoch"]
        if context["trace"]:
            message["trace"] = context["trace"]
        return request(context["socket_path"], message, context["timeout"])

    def list(self) -> Any:
        """List registered driver and workspace capabilities."""
        return self._request("list")

    def help(self, capability_id: str) -> Any:
        """Read the selected capability's description and arguments."""
        return self._request("help", id=capability_id)

    def call(self, capability_id: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call a driver or local Python function with named arguments."""
        if capability_id.startswith("python/"):
            from ._capabilities import call_local
            context = self._context()
            with scope(context):
                return call_local(Path(context["workspace"]), capability_id, arguments if arguments is not None else {})
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            raise TypeError("Driver capability arguments must be a JSON object")
        fields = {"id": capability_id, "arguments": arguments}
        return self._request("call", **fields)
