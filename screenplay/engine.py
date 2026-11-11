"""Document-engine abstraction.

A :class:`DocumentEngine` is everything a *format* needs so the generic service
(:mod:`service` -- revisions, the proposal workflow, rules, findings, export) can
operate on it without knowing the format's internals. Each engine supplies the
format-specific operations:

* ``parse``           -- snapshot -> ordered structural blocks (+ parse problems)
* ``apply_operation`` -- splice a proposed change (insert/replace a block)
* ``validate``        -- deterministic rules -> typed checks
* ``render_pdf`` / ``render_pages`` -- snapshot -> rendered output
* ``import_``         -- raw file bytes of a supported source format -> engine text
* ``export_formats``  -- the artifact types this engine can emit

The generic core is format-agnostic; engines are registered in an
:class:`EngineRegistry` and resolved per project via ``Project.format``.

Screenplay (Fountain) is the first registered engine (``formats.screenplay``);
it delegates to the existing, unit-tested ``fountain`` / ``validation`` /
``rendering`` / :mod:`importers` modules, so behavior is unchanged. New media
formats (novels, docs, video scripts, ...) are added as new engines without
touching the service core.
"""

from __future__ import annotations

import abc
from typing import List


#: The format a new project defaults to (the only registered format in the MVP).
DEFAULT_FORMAT = "screenplay"


class UnknownFormatError(KeyError):
    """Raised by :meth:`EngineRegistry.get` for a format with no registered engine."""


class EngineRegistry:
    """A mapping of format name -> :class:`DocumentEngine`.

    The service owns one registry per instance (see
    :func:`formats.build_default_registry`), so tests get isolated registries
    and a new format can be registered per-process.
    """

    def __init__(self) -> None:
        self._engines: "dict[str, DocumentEngine]" = {}

    def register(self, name: str, eng: "DocumentEngine") -> None:
        self._engines[name] = eng

    def get(self, name: str) -> "DocumentEngine":
        try:
            return self._engines[name]
        except KeyError:
            raise UnknownFormatError(
                f"no engine registered for format '{name}'"
            ) from None

    def names(self) -> List[str]:
        return sorted(self._engines)


class DocumentEngine(abc.ABC):
    """The contract every media-format engine must implement.

    All methods operate on a *snapshot* -- the byte-exact source text of a
    revision (Fountain for the screenplay engine, Markdown/DOCX-text for a
    prose engine, etc.) -- and/or on its parsed :class:`~models.Block` list.
    The engine is the single place a format's parsing, splicing, validation,
    and rendering knowledge lives; the service never reaches into a format's
    details directly.
    """

    #: The format name this engine is registered under (see ``DEFAULT_FORMAT``).
    name: str = "block"
    #: The :class:`~models.Block.kind` this engine produces (e.g. ``"scene"``).
    block_kind: str = "block"
    #: Prefix for the engine's positional block ids (``f"{id_prefix}-{n}"``). The
    #: service's proposal splicer uses it to mint a fresh id for an inserted block
    #: (screenplay: ``scene``; prose: ``block``).
    id_prefix: str = "scene"

    @abc.abstractmethod
    def parse(self, snapshot: str) -> tuple:
        """Parse ``snapshot`` into ``(blocks, problems)``.

        ``blocks`` is the ordered list of :class:`~models.Block` for the
        revision (with stable ``id``/``order``/``start``/``end``); ``problems``
        is a list of parse problems (may be empty).
        """

    @abc.abstractmethod
    def apply_operation(self, snapshot: str, blocks, operation, next_id) -> tuple:
        """Apply a single :class:`~models.Operation` (insert/replace a block) to
        ``snapshot`` and return ``(new_snapshot, new_blocks)``. The engine is
        responsible for byte-exact splicing that leaves every other block
        untouched (see :mod:`fountain` for the reference implementation).
        """

    @abc.abstractmethod
    def validate(self, blocks, snapshot: str, problems, rules, settings) -> list:
        """Run the deterministic ruleset against a candidate and return the list
        of typed :class:`~models.Check` results (the "gates" of the proposal
        workflow). ``problems`` are the candidate's parse problems."""

    @abc.abstractmethod
    def render_pdf(self, snapshot: str, settings) -> tuple:
        """Render ``snapshot`` to ``(pdf_bytes, page_count)``. Raises the
        engine's renderer-unavailable error when rendering is impossible."""

    @abc.abstractmethod
    def render_pages(self, snapshot: str, settings) -> list:
        """Render ``snapshot`` to a list of page descriptors (for the desktop
        page inspector)."""

    @abc.abstractmethod
    def import_(self, filename: str, content: bytes) -> str:
        """Convert raw file bytes of a supported *source* format into this
        engine's canonical text (Fountain for the screenplay engine)."""

    def default_settings(self):
        """The engine's default render settings (a dataclass with ``to_dict()``).
        The service uses it for PDF export when the caller supplies none, so each
        engine renders with its own typography rather than a shared default."""
        return None

    def export_formats(self) -> List[str]:
        """Artifact types this engine can emit (e.g. ``["fountain", "pdf"]``).
        A convenience for clients; not part of the core dispatch."""
        return []
