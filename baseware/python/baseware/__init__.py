"""Small synchronous client for the independent Baseware Unix-socket service."""

import json
import os
import socket
import uuid


class BasewareError(RuntimeError):
    """A service error, retaining its structured wire representation."""

    def __init__(self, error):
        self.error = error
        super().__init__(error.get("message", str(error)) if isinstance(error, dict) else str(error))


class Client:
    """Use the caller's socket, epoch and trace; each request owns one connection.

    RSA keeps the control lease alive separately. This client neither acquires
    a lease automatically nor retries commands after a connection failure.
    """

    def __init__(self, socket_path=None, *, epoch=None, trace=None, timeout=None):
        self.socket_path = socket_path if socket_path is not None else os.environ.get("BASEWARE_SOCKET")
        self.epoch = epoch if epoch is not None else os.environ.get("BASEWARE_EPOCH")
        self.trace = trace if trace is not None else json.loads(os.environ.get("BASEWARE_TRACE", "{}"))
        self.timeout = timeout

    def request(self, kind, **fields):
        if not self.socket_path:
            raise ValueError("BASEWARE_SOCKET or socket_path is required")
        request = {"kind": kind, **fields}
        if self.epoch is not None:
            request["epoch"] = self.epoch
        if self.trace:
            request["trace"] = self.trace
        request_id = str(uuid.uuid4())
        wire = json.dumps({"id": request_id, "request": request}, allow_nan=False).encode("utf-8") + b"\n"
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(self.timeout)
            connection.connect(self.socket_path)
            connection.sendall(wire)
            with connection.makefile("rb") as incoming:
                for line in incoming:
                    reply = json.loads(line)
                    # A subscribed service may interleave events with replies.
                    if reply.get("id") != request_id or "ok" not in reply:
                        continue
                    if reply["ok"]:
                        return reply.get("value")
                    raise BasewareError(reply.get("error", "Baseware request failed"))
        raise ConnectionError("Baseware disconnected before replying; the request was not retried")

    def status(self):
        return self.request("status")

    def list(self):
        return self.request("list")

    def help(self, capability_id):
        return self.request("help", id=capability_id)

    def controller(self, capability_id, argv=()):
        return self.request("controller", id=capability_id, argv=list(argv))

    def release(self):
        return self.request("release")

    def revoke(self):
        return self.request("revoke")


__all__ = ["Client", "BasewareError"]
