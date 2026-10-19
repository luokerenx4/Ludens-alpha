"""Synchronous access to the workspace's unified capability interface."""

import json
import os
import socket


class RSAError(RuntimeError):
    """The RSA host rejected a capability request."""


class Client:
    """Call driver or Python capabilities using the current control epoch.

    Each request uses one connection. The client does not acquire control or
    retry actions; closing the connection cancels the outstanding host request.
    """

    def __init__(self, socket_path=None, *, epoch=None, trace=None, timeout=None):
        self.socket_path = socket_path if socket_path is not None else os.environ.get("RSA_SOCKET")
        self.epoch = epoch if epoch is not None else os.environ.get("BASEWARE_EPOCH")
        self.trace = trace if trace is not None else json.loads(os.environ.get("BASEWARE_TRACE", "{}"))
        self.timeout = timeout

    def _request(self, action, **fields):
        if not self.socket_path:
            raise ValueError("RSA_SOCKET or socket_path is required")
        request = {"kind": "controller", "argv": [], "action": action, **fields}
        if self.epoch is not None:
            request["epoch"] = self.epoch
        if self.trace:
            request["trace"] = self.trace
        wire = json.dumps(request, allow_nan=False).encode("utf-8") + b"\n"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(self.timeout)
            connection.connect(self.socket_path)
            connection.sendall(wire)
            with connection.makefile("rb") as incoming:
                line = incoming.readline()
                if not line:
                    raise ConnectionError("RSA disconnected before replying; the request was not retried")
                reply = json.loads(line)
                if reply["ok"]:
                    return reply.get("value")
                raise RSAError(reply["error"])

    def list(self):
        """List registered driver and workspace capabilities."""
        return self._request("list")

    def help(self, capability_id):
        """Read the selected capability's description and arguments."""
        return self._request("help", id=capability_id)

    def call(self, capability_id, arguments=None):
        """Call with argv for a driver, or named arguments for Python functions."""
        fields = {"id": capability_id}
        if arguments is not None:
            fields["arguments"] = arguments
        return self._request("call", **fields)
