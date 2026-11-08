"""Hermes screenplay plugin — agent-side registration.

``register(ctx)`` exposes the screenplay service to the Hermes agent as tools
in the ``screenplay`` toolset. The heavy lifting lives in the ``screenplay``
service package; this module only wires tool handlers to service calls.

The same process-wide service instance (``screenplay.runtime.get_service``) is
also exposed to the desktop workspace through the dashboard FastAPI router
(``dashboard/plugin_api.py``) and the Desktop SDK pane (``desktop/plugin.js``),
so agent tools and the workspace always see the same state.
"""
from __future__ import annotations

from .screenplay.tools import TOOLS


def register(ctx) -> None:
    """Register the screenplay tools with the Hermes plugin context."""
    for name, schema, handler, emoji in TOOLS:
        ctx.register_tool(
            name=name,
            toolset="screenplay",
            schema=schema,
            handler=handler,
            emoji=emoji,
        )
