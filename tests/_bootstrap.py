"""Shared test bootstrap.

Puts the ``screenplay`` package (and this ``tests/`` dir) on ``sys.path`` and
provides :func:`fresh_home` -- a throwaway ``HERMES_HOME`` plus a service-singleton
reset -- so every test runs against an isolated database. Works under ``pytest``
or plain ``python`` (see ``run_all.py``).
"""
import os
import sys
import tempfile
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = TESTS_DIR.parent

for _p in (str(PLUGIN_ROOT), str(TESTS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from screenplay.runtime import get_service, reset_service  # noqa: E402

_FIXTURE = PLUGIN_ROOT / "tests" / "fixtures" / "sample.fountain"
SAMPLE_FOUNTAIN = _FIXTURE.read_text(encoding="utf-8") if _FIXTURE.exists() else ""


def fresh_home() -> str:
    """Point HERMES_HOME at a fresh temp dir and reset the service singleton."""
    os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="hsp-test-")
    reset_service()
    return os.environ["HERMES_HOME"]


def svc():
    """Return the process-wide service (built against the current HERMES_HOME)."""
    return get_service()
