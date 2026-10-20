"""Synchronous access to the workspace's unified capability interface."""

from pathlib import Path
from ._context import RSAError, current, request, scope


class Client:
    """Call driver or Python capabilities using the current control epoch.

    Python functions run in this process. Driver requests use one connection;
    the client never acquires control or retries actions.
    """

    def __init__(self, socket_path=None, *, epoch=None, trace=None, timeout=None):
        self.socket_path = socket_path
        self.epoch = epoch
        self.trace = trace
        self.timeout = timeout

    def _context(self):
        # Resolve defaults at the call site, so a module-level Client also
        # inherits the active local function's trace.
        return {**current(), **{key: value for key, value in {
            "socket_path": self.socket_path, "epoch": self.epoch,
            "trace": self.trace, "timeout": self.timeout,
        }.items() if value is not None}}

    def _request(self, action, **fields):
        context = self._context()
        message = {"kind": "controller", "argv": [], "action": action, **fields}
        if context["epoch"] is not None:
            message["epoch"] = context["epoch"]
        if context["trace"]:
            message["trace"] = context["trace"]
        return request(context["socket_path"], message, context["timeout"])

    def list(self):
        """List registered driver and workspace capabilities."""
        return self._request("list")

    def help(self, capability_id):
        """Read the selected capability's description and arguments."""
        return self._request("help", id=capability_id)

    def call(self, capability_id, arguments=None):
        """Call a driver with argv, or a local Python function with named arguments."""
        if capability_id.startswith("python/"):
            from ._capabilities import call_local
            context = self._context()
            with scope(context):
                return call_local(Path(context["workspace"]), capability_id, arguments if arguments is not None else {})
        fields = {"id": capability_id}
        if arguments is not None:
            fields["arguments"] = arguments
        return self._request("call", **fields)
