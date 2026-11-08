"""Process-wide service locator for the screenplay service.

Both the agent (tools) and the web-server (dashboard router) resolve the same
: class:`ScreenplayService` through :func:`get_service`. The SQLite database
and PDF exports live under the profile-scoped plugin data dir so state
survives plugin updates and stays isolated per profile.

Inside the plugin loader the data dir comes from
``plugins.plugin_storage.plugin_data_dir``; outside it (tests / CLI smoke
runs) it falls back to ``$HERMES_HOME/plugin-data/hermes-screenplay``.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

from .repository import Repository
from .service import ScreenplayService

PLUGIN_NAME = "hermes-screenplay"

_lock = threading.Lock()
_service: "ScreenplayService | None" = None


def _data_dir() -> Path:
    try:
        from plugins.plugin_storage import plugin_data_dir
        return Path(plugin_data_dir(PLUGIN_NAME))
    except Exception:
        home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
        return Path(home) / "plugin-data" / PLUGIN_NAME


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
