"""Workspace capabilities: mark ordinary typed Python functions for RSA."""

from .client import Client, RSAError


def capability(function=None):
    """Register a typed function as a workspace capability for rsa controller."""
    def mark(target):
        target.__rsa_capability__ = True
        return target

    return mark if function is None else mark(function)


__all__ = ["Client", "RSAError", "capability"]
