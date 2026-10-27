"""Workspace-owned perception. Implement this class, then run rsa perception reload."""

from rsa_tools import perception, record


class Perception:
    sample_hz = 2.0  # Target rate; slow samples never overlap or accumulate.

    def start(self, context):
        """Initialize models/state once; discover device abilities in baseware.json."""
        self.context = context

    @record
    @perception
    def sample(self):
        """Return an observation: optional text, JSON data, media, space and sources.

        media: [{"path": "frame.png", "mediaType": "image/png"}], or base64 data
        instead of path. sampledAt optionally supplies a known source timestamp.
        The instance stays alive; choose continuous or on-demand work as useful.
        @record adds this result to the workspace timeline and returns a timeline
        reference. observe() reads that history, across runs, without resampling.
        Plain @perception functions do not record; add @record only where useful.
        """
        raise NotImplementedError("Implement workspace perception, then reload it.")

    def close(self):
        """Stop your background workers and release local resources."""
        pass
