"""Concrete document engines, one per supported media format.

Importing this package registers the built-in engines into a default
:class:`~..engine.EngineRegistry` via :func:`build_default_registry`. The
screenplay (Fountain) engine is engine #1 and delegates to the existing,
unit-tested ``fountain`` / ``validation`` / ``rendering`` / :mod:`importers`
modules so its behavior is byte-identical to the pre-abstraction service.

Adding a new format (Phase 1+) means adding a module here that implements
``DocumentEngine`` and registering it in :func:`build_default_registry` --
the service core, repository, proposal workflow, rules, and findings are all
format-agnostic and need no changes.
"""

from .. import engine
from .screenplay import ScreenplayEngine
from .prose import ProseEngine


def build_default_registry() -> "engine.EngineRegistry":
    """A fresh registry with all built-in engines registered.

    The service builds one of these per instance so tests (each of which resets
    the service singleton) get isolated registries and there is no cross-test
    state.
    """
    reg = engine.EngineRegistry()
    for eng in (ScreenplayEngine(), ProseEngine()):
        reg.register(eng.name, eng)
    return reg
