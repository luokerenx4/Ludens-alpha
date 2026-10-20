"""Workspace-owned perception. Implement this class, then run rsa perception reload."""


class Perception:
    def start(self, context):
        """Initialize models/state once. context is {workspace, runDir, generation}.

        Read baseware.json to discover read-only device capabilities. Choose your
        sampling and processing; any background worker belongs to this class.
        """
        self.context = context

    def observe(self):
        """Return a result or raise NotImplementedError until it is available.

        Result: {"sequence": str | int, "text": str,
                 "media": [{"path": str, "mediaType": str}],
                 "sampledAt": ISO_timestamp, "sources": [...]}
        Only sequence is required; return text and/or media as useful. Paths are
        relative to this workspace or absolute. Increment sequence for new data,
        retain it for a reused result, and report the actual sample time if known.
        RSA archives the selected result; do not overwrite a media file while it
        is being read. Sampling may happen here or in your own background loop.
        """
        raise NotImplementedError("Implement workspace perception, then reload it.")

    def close(self):
        """Stop your background workers and release local resources."""
        pass
