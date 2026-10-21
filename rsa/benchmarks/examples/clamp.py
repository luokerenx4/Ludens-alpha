"""Copy to <workspace>/benchmarks/clamp.py for a dependency-free example."""

import hashlib
import json
from pathlib import Path
from random import Random
from time import perf_counter

from rsa_tools import benchmark, capability, current_benchmark


@capability
def clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    """Limit a value to the inclusive interval [lower, upper]."""
    if lower > upper:
        raise ValueError("lower must not exceed upper")
    return min(upper, max(lower, value))


@benchmark(targets=["python/benchmarks/clamp.py:clamp"], protocol="1")
def evaluate(samples: int = 1000, seed: int = 7) -> dict:
    """Measure interval correctness and decorated call time on seeded inputs."""
    if samples <= 0:
        raise ValueError("samples must be positive")
    record = current_benchmark()
    record.conditions(distribution="uniform(-2,3)", seed=seed)
    source = Path(__file__)
    record.subject("implementation", path=str(source), sha256=hashlib.sha256(source.read_bytes()).hexdigest())
    record.limitations("Call timing includes capability telemetry; memory usage is not sampled.")
    rng = Random(seed)
    inputs = [rng.uniform(-2.0, 3.0) for _ in range(samples)]
    started = perf_counter()
    outputs = [clamp(value) for value in inputs]
    elapsed = perf_counter() - started
    correct = sum(
        output == (0.0 if value < 0.0 else 1.0 if value > 1.0 else value)
        for value, output in zip(inputs, outputs)
    )
    evidence = record.run_dir / "artifacts" / "samples.json"
    evidence.write_text(json.dumps({"inputs": inputs, "outputs": outputs}))
    record.artifact(evidence, label="Seeded inputs and observed outputs")
    return {
        "metrics": {
            "correctness": {"value": correct / samples, "unit": "ratio", "direction": "higher"},
            "call_time": {"value": elapsed * 1000 / samples, "unit": "ms", "direction": "lower"},
            "peak_memory": {"value": None, "unit": "B", "reason": "Memory usage was not sampled."},
        },
        "checks": {
            "all_in_range": {"passed": correct == samples, "expected": samples, "actual": correct},
        },
    }
