"""Screenplay service package.

Pure-Python, stdlib-only. No third-party runtime dependencies so the plugin loads
in the Hermes runtime venv (which has no pip) and stays installable in a fresh
profile with zero friction.
"""

__all__ = [
    "models",
    "repository",
    "fountain",
    "validation",
    "service",
    "rendering",
]
