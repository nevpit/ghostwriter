"""The screenplay (Fountain) document engine -- engine #1.

This is a thin, behavior-preserving adapter over the existing, unit-tested
screenplay modules. It does **not** re-implement parsing, splicing, validation,
rendering, or importing; it forwards each engine operation to the module that
already implements it. The point of the adapter is the *boundary*: the generic
service now talks to a :class:`~..engine.DocumentEngine`, and this class is
where the screenplay format plugs into that boundary.

Note on ``fountain.parse``: it is called through module-attribute access
(``fountain.parse(...)``) so that tests which monkeypatch
``ghostwriter.screenplay.fountain.parse`` keep working unchanged.
"""

from __future__ import annotations

from typing import List

from .. import fountain
from .. import importers
from .. import models as M
from .. import rendering
from .. import validation
from ..engine import DocumentEngine


class ScreenplayEngine(DocumentEngine):
    """Fountain screenplay: parse, splice, validate, render PDF, import FDX/text/PDF."""

    name = "screenplay"
    block_kind = "scene"

    def parse(self, snapshot: str):
        scenes, problems = fountain.parse(snapshot)
        return scenes, problems

    def apply_operation(self, snapshot: str, blocks, operation, next_id):
        return fountain.apply_operation(snapshot, blocks, operation, next_id)

    def validate(self, blocks, snapshot: str, problems, rules, settings) -> list:
        return validation.validate_candidate(blocks, snapshot, problems, rules, settings)

    def render_pdf(self, snapshot: str, settings):
        return rendering.render_pdf(snapshot, settings)

    def render_pages(self, snapshot: str, settings):
        return rendering.render_pages(snapshot, settings)

    def import_(self, filename: str, content: bytes) -> str:
        return importers.to_fountain(filename or "", content or b"")

    def default_settings(self):
        return rendering.RenderSettings()

    def export_formats(self) -> List[str]:
        return ["fountain", "fdx", "pdf"]
