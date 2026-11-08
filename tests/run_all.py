"""Run the whole test suite WITHOUT pytest.

Discovers ``test_*`` functions in each ``tests/test_*.py`` module, runs each
against an isolated HERMES_HOME (tests reset the singleton themselves), prints a
pass/fail summary, and exits 0 iff everything passes.

Usage::

    python tests/run_all.py

Each test function is also plain ``def test_x(): assert ...`` so the suite runs
unchanged under ``pytest`` if it is later installed.
"""
import importlib
import sys
import traceback
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

MODULES = sorted(p.stem for p in TESTS_DIR.glob("test_*.py"))


def main():
    total = passed = failed = 0
    failures = []
    for mod_name in MODULES:
        mod = importlib.import_module(mod_name)
        fns = [getattr(mod, n) for n in dir(mod)
               if n.startswith("test_") and callable(getattr(mod, n))]
        print(f"\n== {mod_name} ({len(fns)} tests) ==")
        for fn in sorted(fns, key=lambda f: f.__name__):
            total += 1
            try:
                fn()
                passed += 1
                print(f"  PASS  {fn.__name__}")
            except Exception:
                failed += 1
                failures.append((mod_name, fn.__name__))
                print(f"  FAIL  {fn.__name__}")
                traceback.print_exc()
    print(f"\n{'=' * 40}\n{passed}/{total} passed, {failed} failed")
    if failures:
        print("Failures:")
        for m, n in failures:
            print(f"  - {m}.{n}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
