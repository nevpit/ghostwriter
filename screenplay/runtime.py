"""Process-wide service locator for the screenplay service.

Both the agent (tools) and the web-server (dashboard router) resolve the same
: class:`ScreenplayService` through :func:`get_service`. The SQLite database
and PDF exports live under the profile-scoped plugin data dir so state
survives plugin updates and stays isolated per profile.

Inside the plugin loader the data dir comes from
``plugins.plugin_storage.plugin_data_dir``; outside it (tests / CLI smoke
runs) it falls back to ``$HERMES_HOME/plugin-data/ghostwriter``.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

from .repository import Repository
from .service import ScreenplayService

PLUGIN_NAME = "ghostwriter"
# Pre-rebrand name. The data dir is keyed by plugin name, so a plugin that was
# installed as ``hermes-screenplay`` has its projects under that old name; we
# adopt that dir on first run so nothing is lost across the rebrand.
LEGACY_PLUGIN_NAMES = ("hermes-screenplay",)

_lock = threading.Lock()
_service: "ScreenplayService | None" = None


def _resolve_data_dir(name: str) -> Path:
    try:
        from plugins.plugin_storage import plugin_data_dir
        return Path(plugin_data_dir(name))
    except Exception:
        home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
        return Path(home) / "plugin-data" / name


def _data_dir() -> Path:
    d = _resolve_data_dir(PLUGIN_NAME)
    # plugin_data_dir auto-creates the directory, so "exists" is NOT a signal
    # of "already holds data". Key on the database file instead, otherwise the
    # freshly-created empty dir would mask a legacy install and its projects.
    if (d / "screenplay.db").exists():
        return d
    # Rebrand migration: adopt the first legacy data dir that holds a database
    # so a previously installed hermes-screenplay keeps its projects under the
    # new name. The whole-dir move is atomic; if it is blocked (e.g. the app is
    # still holding the files) we keep pointing at the legacy dir so nothing is
    # lost, and a clean later run completes the move.
    for legacy in LEGACY_PLUGIN_NAMES:
        legacy_dir = _resolve_data_dir(legacy)
        if not (legacy_dir / "screenplay.db").exists():
            continue
        try:
            # The (auto-created) new dir must not exist for rename() to target
            # it; clear it if empty. If it already holds other files, leave it.
            if d.exists():
                if any(d.iterdir()):
                    return d
                d.rmdir()
            legacy_dir.rename(d)
        except Exception:
            return legacy_dir
        return d
    return d


def get_service() -> ScreenplayService:
    """Return the process-wide service instance, creating it on first use."""
    global _service
    with _lock:
        if _service is None:
            d = _data_dir()
            d.mkdir(parents=True, exist_ok=True)
            (d / "exports").mkdir(parents=True, exist_ok=True)
            repo = Repository(str(d / "screenplay.db"))
            _service = ScreenplayService(repo, exports_dir=d / "exports")
        return _service


def reset_service() -> None:
    """Testing hook: drop the cached instance so the next get_service() rebuilds
    against the (possibly new) HERMES_HOME data dir. Not used in production."""
    global _service
    with _lock:
        if _service is not None:
            try:
                _service.close()
            except Exception:
                pass
        _service = None
