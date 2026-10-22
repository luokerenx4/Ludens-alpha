"""Workspace-owned perception. Implement this class, then run rsa perception reload."""


class Perception:
    sample_hz = 2.0  # Target rate; slow samples do not overlap or accumulate.

    def start(self, context):
        """Initialize models/state once. context is {workspace, runDir, generation}.

        Read baseware.json to discover read-only device capabilities.
        """
        self.context = context

    def sample(self):
        """Return a result or raise NotImplementedError until it is available.

        Result: {"text": str, "media": [{"path": str, "mediaType": str}],
                 "sampledAt": ISO_timestamp, "sources": [...]}
        Fields are optional; return text and/or media as useful. Paths are relative
        to this workspace or absolute. sampledAt is source time, if known.
        RSA calls this continuously, even while Shiori thinks, and archives each
        result with its sequence, recordedAt and sampling interval. Keep media
        unchanged until the next sample call. observe() reads this history:
        latest by default, or at/start/end timestamps; it does not call sample().
        """
        raise NotImplementedError("Implement workspace perception, then reload it.")

    def close(self):
        """Stop your background workers and release local resources."""
        pass
