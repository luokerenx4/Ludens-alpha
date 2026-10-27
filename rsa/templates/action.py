"""Workspace-owned action program. Implement it, then run rsa action reload."""

from rsa_tools import Client, capability


class Action:
    step_hz = 30.0  # Target rate; slow steps never overlap or accumulate.

    def start(self, context):
        """Initialize state/models once for this control epoch and generation."""
        self.context = context
        self.device = Client()

    @capability
    def step(self):
        """Compose capabilities using current or historical observations as needed.

        self.device.observe() reads the same timeline envelope as rsa observe.
        Discover device contracts in baseware.json. Async play can run while later
        steps observe or compute; it need not be immediately waited on.
        State and models survive Shiori rounds. Add @record only to results worth
        retaining, returning a text/data/media/space/sources envelope.
        """
        raise NotImplementedError("Implement workspace action, then reload it.")

    def close(self):
        """Stop your background workers and release local resources."""
        pass
