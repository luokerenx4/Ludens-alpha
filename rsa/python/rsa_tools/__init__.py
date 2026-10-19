"""Workspace capabilities: mark ordinary typed Python functions for RSA."""


def capability(function=None):
    """Expose a function's annotations and docstring as a model tool."""
    def mark(target):
        target.__rsa_capability__ = True
        return target

    return mark if function is None else mark(function)
