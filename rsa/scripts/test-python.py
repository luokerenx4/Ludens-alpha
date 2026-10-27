"""Run the framework's offline Python tests using the active interpreter."""

from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys
import unittest


def main() -> int:
    suite = unittest.TestSuite()
    for index, path in enumerate(sorted((Path(__file__).resolve().parents[1] / "tests").glob("*.test.py"))):
        spec = spec_from_file_location(f"rsa_test_{index}", path)
        assert spec is not None and spec.loader is not None
        module = module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
