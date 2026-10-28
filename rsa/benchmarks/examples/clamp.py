"""Copy to <workspace>/benchmarks/clamp.py for a dependency-free example."""

import hashlib
import json
from pathlib import Path
from random import Random
from time import perf_counter

from rsa_tools import capability, current_trial


@capability
def clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    """Limit a value to the inclusive interval [lower, upper]."""
    if lower > upper:
        raise ValueError("lower must not exceed upper")
    return min(upper, max(lower, value))


def evaluate(samples: int = 1000, seed: int = 7) -> dict:
    """Measure interval correctness and decorated call time on seeded inputs."""
    if samples <= 0:
        raise ValueError("samples must be positive")
    record = current_trial()
    record.conditions(distribution="uniform(-2,3)", seed=seed)
    source = Path(__file__)
    record.subject("implementation", path=str(source), sha256=hashlib.sha256(source.read_bytes()).hexdigest())
    record.limitations("Call timing includes capability telemetry; memory usage is not sampled.")
    rng = Random(seed)
    inputs = [rng.uniform(-2.0, 3.0) for _ in range(samples)]
    started = perf_counter()
    outputs = [clamp(value) for value in inputs]
    elapsed = perf_counter() - started
    facts = {"inputs": inputs, "outputs": outputs, "elapsedMs": elapsed * 1000}
    record.artifact("measurements.json", facts, label="Seeded inputs and observed outputs")
    record.flush()
    return facts


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    evaluate(args.samples, args.seed)
