"""One target sampling frequency for perception and its video recordings."""

import math


DEFAULT_SAMPLE_HZ = 30.0


def validate_sample_hz(value: float, name: str = "sample_hz") -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be a positive finite number")
    return float(value)
