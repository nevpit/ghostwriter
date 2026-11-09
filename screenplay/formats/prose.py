"""The prose (long-form Markdown) document engine -- engine #2.

This is the first non-screenplay engine and the proof that the
:class:`~..engine.DocumentEngine` abstraction holds: the same generic service
(revisions, the proposal workflow, rules, findings, export) drives a book the
way it drives a screenplay, with no changes to the core.

The snapshot is **Markdown**. Structural blocks are the headings:

* ``#``   -> ``kind="part"``     (a Part)
* ``##``  -> ``kind="chapter"``  (a Chapter)
* ``###`` -> ``kind="section"``  (a Section)

Text before the first heading (or a whole document with no headings) is a
single ``kind="front"`` block. Each block carries its paragraphs as ``elements``
(``{"kind": "paragraph", "text": ...}``). Block ids are positional
(``block-0, block-1, ...``), mirroring the Fountain ``scene-N`` scheme, so the
service's proposal splicer (which re-maps ids positionally) works unchanged.

Blocks are built as :class:`~..models.Scene` so the existing API, tools, and
desktop pane (which read ``scene.heading``) keep working without a separate
prose code path -- ``heading`` holds the chapter/part title.

Rendering is book-style (Times, page break before each Part/Chapter) and lives
in :mod:`prose_render`; it is a pure-stdlib PDF, no external dependencies.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
import zipfile
import io
from typing import List

from .. import models as M
from .. import rendering
from ..engine import DocumentEngine
from . import prose_render as PR

# A Markdown ATX heading: 1-6 hashes, a space, then a non-empty title.
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
# Heading level -> block kind (levels 4+ are all treated as sections).
_KIND_BY_LEVEL = {1: "part", 2: "chapter", 3: "section", 4: "section"}


def _paragraphs(lines: List[str], start_line: int, end_line: int) -> List[dict]:
    """Join consecutive non-blank lines into paragraphs (Markdown soft-wrap)."""
    elements: List[dict] = []
    para: List[str] = []
    for i in range(start_line, end_line):
        t = lines[i].strip()
        if t:
            para.append(t)
        elif para:
            elements.append({"kind": "paragraph", "text": " ".join(para)})
            para = []
    if para:
        elements.append({"kind": "paragraph", "text": " ".join(para)})
    return elements


def parse(snapshot: str):
    """Parse a Markdown snapshot into ``(blocks, problems)``.

    ``blocks`` is an ordered list of :class:`~..models.Scene` (positional ids,
    half-open offsets into ``snapshot``); ``problems`` is a list of parse
    problems (empty for the supported Markdown subset).
    """
    problems: List = []
    lines = snapshot.split("\n")
    # Byte offset where each line starts (half-open line boundaries).
    offsets: List[int] = []
    off = 0
    for ln in lines:
        offsets.append(off)
        off += len(ln) + 1
    total = len(snapshot)

    headings = []
    for idx, ln in enumerate(lines):
        m = _HEADING_RE.match(ln)
        if m:
            level = min(len(m.group(1)), 4)
            headings.append({"idx": idx, "level": level, "title": m.group(2).strip(),
                             "kind": _KIND_BY_LEVEL[level], "start": offsets[idx]})

    descs: List[dict] = []
    if headings:
        first_idx = headings[0]["idx"]
        has_front = first_idx > 0 and any(lines[i].strip() for i in range(first_idx))
        if has_front:
            descs.append({"kind": "front", "title": "", "level": 0, "start": 0,
                          "end": offsets[first_idx] if first_idx < len(lines) else total,
                          "elements": _paragraphs(lines, 0, first_idx)})
    else:
        # No headings at all: the whole document is a single front block.
        if any(l.strip() for l in lines):
            descs.append({"kind": "front", "title": "", "level": 0, "start": 0,
                          "end": total,
                          "elements": _paragraphs(lines, 0, len(lines))})

    for i, h in enumerate(headings):
        end_line = headings[i + 1]["idx"] if i + 1 < len(headings) else len(lines)
        descs.append({"kind": h["kind"], "title": h["title"], "level": h["level"],
                      "start": h["start"],
                      "end": offsets[end_line] if end_line < len(lines) else total,
                      "elements": _paragraphs(lines, h["idx"] + 1, end_line)})

    blocks: List[M.Scene] = []
    for n, d in enumerate(descs):
        parent_id = None
        if d["kind"] != "front":
            for j in range(n - 1, -1, -1):
                if descs[j]["kind"] != "front" and descs[j]["level"] < d["level"]:
                    parent_id = f"block-{j}"
                    break
        blocks.append(M.Scene(
            id=f"block-{n}", kind=d["kind"], order=n, parent_id=parent_id,
            heading=d["title"], start=d["start"], end=d["end"],
            elements=d["elements"], meta={"level": d["level"]}, parse_ok=True,
        ))
    return blocks, problems


def _format_block_text(op: M.Operation, level: int) -> str:
    """Markdown for one block: its heading (at ``level``) + body."""
    hashes = "#" * max(1, min(level, 4))
    parts: List[str] = []
    if op.heading and op.heading.strip():
        parts.append(f"{hashes} {op.heading.strip()}")
    body = (op.content or "").strip("\n")
    if body:
        parts.append(body)
    return "\n".join(parts)


def _normalize_gap(snapshot: str) -> str:
    """Collapse runs of >=2 blank lines into one (local well-formedness fix)."""
    return re.sub(r"\n{3,}", "\n\n", snapshot)


def apply_operation(snapshot: str, blocks, op: M.Operation, next_id) -> tuple:
    """Splice one insert/replace and re-parse. ``next_id`` is unused (the
    service mints and re-maps ids positionally, as it does for Fountain)."""
    if op.type == "insert":
        target = None
        if op.before_scene_id is not None:
            target = next((b for b in blocks if b.id == op.before_scene_id), None)
            if target is None:
                raise M.ServiceError(M.ERR_SCENE_NOT_FOUND,
                                     f"block {op.before_scene_id} not found")
        # New block takes the level of the block it precedes (chapter by default).
        level = target.meta.get("level") if (target and target.meta.get("level", 0) >= 1) else 2
        text = _format_block_text(op, level)
        if target is None:
            sep = "" if snapshot.endswith("\n\n") else ("\n\n" if snapshot else "")
            new_snapshot = snapshot + sep + text
        else:
            new_snapshot = snapshot[:target.start] + text + "\n\n" + snapshot[target.start:]
        new_snapshot = _normalize_gap(new_snapshot)
        return new_snapshot, parse(new_snapshot)[0]

    if op.type == "replace":
        target = next((b for b in blocks if b.id == op.scene_id), None)
        if target is None:
            raise M.ServiceError(M.ERR_SCENE_NOT_FOUND,
                                 f"block {op.scene_id} not found")
        level = target.meta.get("level", 2)
        text = _format_block_text(op, level)
        new_snapshot = snapshot[:target.start] + text + "\n\n" + snapshot[target.end:]
        new_snapshot = _normalize_gap(new_snapshot)
        return new_snapshot, parse(new_snapshot)[0]

    raise M.ServiceError(M.ERR_INVALID_PROPOSAL, f"unknown operation type {op.type!r}")


def _int(v) -> int:
    try:
        return int(v) if v is not None else 0
    except (TypeError, ValueError):
        return 0


def validate(blocks, snapshot: str, problems, rules, settings) -> list:
    """Deterministic gates for a prose candidate.

    The PARSE gate always runs. The structural gates (part/chapter counts, word
    totals, per-chapter minimums, heading hierarchy) only fire from
    ``rules.limits`` -- an empty rules version yields all-pass, so a plain
    import is never blocked by default.
    """
    checks: List[M.Check] = []
    if problems:
        checks.append(M.Check("PARSE", M.FAIL, f"{len(problems)} parse problem(s)"))
    else:
        checks.append(M.Check("PARSE", M.PASS, "ok"))
    if rules is None:
        return checks

    limits = rules.limits or {}
    parts = [b for b in blocks if b.kind == "part"]
    chapters = [b for b in blocks if b.kind == "chapter"]
    total_words = sum(len(b.text(snapshot).split()) for b in blocks)

    min_parts = _int(limits.get("min_parts"))
    checks.append(M.Check(
        "PART_COUNT",
        M.FAIL if (min_parts and len(parts) < min_parts) else M.PASS,
        f"{len(parts)} part(s)" + (f" (min {min_parts})" if min_parts else "")))

    min_chapters = _int(limits.get("min_chapters"))
    checks.append(M.Check(
        "CHAPTER_COUNT",
        M.FAIL if (min_chapters and len(chapters) < min_chapters) else M.PASS,
        f"{len(chapters)} chapter(s)" + (f" (min {min_chapters})" if min_chapters else "")))

    max_words = _int(limits.get("max_words"))
    checks.append(M.Check(
        "WORD_COUNT",
        M.FAIL if (max_words and total_words > max_words) else M.PASS,
        f"{total_words} words" + (f" (max {max_words})" if max_words else "")))

    min_wc = _int(limits.get("min_words_per_chapter"))
    if min_wc:
        under = [b for b in chapters if len(b.text(snapshot).split()) < min_wc]
        checks.append(M.Check(
            "CHAPTER_WORDS", M.FAIL if under else M.PASS,
            f"{len(under)} chapter(s) under {min_wc} words" if under
            else f"all chapters >= {min_wc} words"))

    # Heading hierarchy: no skipped levels (e.g. # then ### without a ##).
    prev = None
    skipped = False
    for b in blocks:
        if b.kind == "front":
            continue
        lvl = b.meta.get("level", 2)
        if prev is not None and lvl > prev + 1:
            skipped = True
        prev = lvl
    checks.append(M.Check("HEADING_HIERARCHY", M.FAIL if skipped else M.PASS,
                          "heading level skips detected" if skipped else "ok"))
    return checks


def _normalize_markdown(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.rstrip() for ln in text.split("\n")]
    out: List[str] = []
    for ln in lines:
        if ln == "" and out and out[-1] == "":
            continue
        out.append(ln)
    text = "\n".join(out)
    if not text.endswith("\n"):
        text += "\n"
    return text


def _import_docx(content: bytes) -> str:
    """A .docx (Office Open XML) is a ZIP; extract the paragraph text from
    ``word/document.xml`` and map heading styles to Markdown headings."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
        xml_data = zf.read("word/document.xml")
    except Exception as exc:
        raise M.ServiceError(M.ERR_PARSE_UNSUPPORTED, f"invalid .docx: {exc}") from exc
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    try:
        root = ET.fromstring(xml_data)
    except Exception as exc:
        raise M.ServiceError(M.ERR_PARSE_UNSUPPORTED, f"invalid .docx xml: {exc}") from exc
    lines: List[str] = []
    for p in root.iter(f"{ns}p"):
        style = ""
        ppr = p.find(f"{ns}pPr")
        if ppr is not None:
            pstyle = ppr.find(f"{ns}pStyle")
            if pstyle is not None:
                style = (pstyle.get(f"{ns}val") or pstyle.get("val") or "").lower()
        para = "".join((t.text or "") for t in p.iter(f"{ns}t"))
        if style.startswith("heading1") or style == "title":
            lines.append("# " + para)
        elif style.startswith("heading2"):
            lines.append("## " + para)
        elif style.startswith("heading3"):
            lines.append("### " + para)
        else:
            lines.append(para)
    return _normalize_markdown("\n".join(lines))


def import_(filename: str, content: bytes) -> str:
    """Convert raw file bytes (``.md``/``.markdown``/``.txt``/``.docx``) into
    the engine's canonical text (Markdown)."""
    if (filename or "").lower().endswith(".docx"):
        return _import_docx(content)
    return _normalize_markdown(content.decode("utf-8-sig", errors="replace"))


class ProseEngine(DocumentEngine):
    """Long-form prose (Markdown): parse, splice, validate, render book PDF."""

    name = "prose"
    block_kind = "block"
    id_prefix = "block"

    def parse(self, snapshot: str):
        return parse(snapshot)

    def apply_operation(self, snapshot: str, blocks, operation, next_id):
        return apply_operation(snapshot, blocks, operation, next_id)

    def validate(self, blocks, snapshot: str, problems, rules, settings) -> list:
        return validate(blocks, snapshot, problems, rules, settings)

    def render_pdf(self, snapshot: str, settings):
        s = settings if isinstance(settings, PR.ProseSettings) else self.default_settings()
        try:
            return PR.render_pdf(snapshot, s)
        except Exception as exc:
            raise rendering.RendererError(str(exc)) from exc

    def render_pages(self, snapshot: str, settings):
        s = settings if isinstance(settings, PR.ProseSettings) else self.default_settings()
        try:
            return PR.render_pages(snapshot, s)
        except Exception as exc:
            raise rendering.RendererError(str(exc)) from exc

    def import_(self, filename: str, content: bytes) -> str:
        return import_(filename or "", content or b"")

    def default_settings(self):
        return PR.ProseSettings()

    def export_formats(self):
        return ["markdown", "pdf", "text"]
