"""Workspace capabilities: mark ordinary typed Python functions for RSA."""

from .client import Client, RSAError


def capability(function=None, *, hook=None):
    """Register a capability; hook="observe" also supplies the loop's observation."""
    if hook not in (None, "observe"):
        raise ValueError('The only supported capability hook is "observe"')

    def mark(target):
        target.__rsa_capability__ = True
        target.__rsa_hook__ = hook
        return target

    return mark if function is None else mark(function)


__all__ = ["Client", "RSAError", "capability"]
