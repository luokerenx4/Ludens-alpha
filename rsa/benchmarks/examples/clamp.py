"""Copy to <workspace>/benchmarks/clamp.py for a dependency-free example."""

from random import Random
from time import perf_counter

from rsa_tools import benchmark, capability


@capability
def clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    """Limit a value to the inclusive interval [lower, upper]."""
    if lower > upper:
        raise ValueError("lower must not exceed upper")
    return min(upper, max(lower, value))


@benchmark(targets=["python/benchmarks/clamp.py:clamp"])
def evaluate(samples: int = 1000, seed: int = 7) -> dict:
    """Measure interval correctness and decorated call time on seeded inputs."""
    if samples <= 0:
        raise ValueError("samples must be positive")
    rng = Random(seed)
    inputs = [rng.uniform(-2.0, 3.0) for _ in range(samples)]
    started = perf_counter()
    outputs = [clamp(value) for value in inputs]
    elapsed = perf_counter() - started
    correct = sum(
        output == (0.0 if value < 0.0 else 1.0 if value > 1.0 else value)
        for value, output in zip(inputs, outputs)
    )
    return {
        "conditions": {"distribution": "uniform(-2,3)", "seed": seed},
        "metrics": [
            {"id": "correctness", "value": correct / samples, "unit": "ratio", "direction": "higher"},
            {"id": "call_time", "value": elapsed * 1000 / samples, "unit": "ms", "direction": "lower"},
        ],
    }
