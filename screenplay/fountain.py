"""Fountain parser: the *supported subset*, offset-accurate.

Design goals (per IMPLEMENTATION_PLAN.md "Fountain parser and scene index"):
  * Preserve the original source text exactly. We never rewrite the snapshot;
    we only compute half-open character offsets [start, end) into it, so a
    single-scene splice leaves every other byte untouched.
  * Produce a lossless scene index: stable opaque scene ids, display order,
    heading, offsets, and a typed element breakdown per scene.
  * Detect unsupported constructs and mark the parse incomplete (``problems``)
    so the validator can report ``unavailable`` rather than a false ``pass``.

The parser assigns *positional* ids (``scene-0, scene-1, ...``). The service
re-maps them to stable logical ids when building candidates so that a scene's
identity survives its own replacement.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional

from . import models as M

# Character extensions we understand (Fountain). Anything else after a cue is an
# unknown extension -> flagged.
KNOWN_EXTENSIONS = {"V.O.", "O.S.", "P.M."}

_SCENE_RE = re.compile(
    r"^\s*(INT\.|EXT\.|INT/EXT\.|I/E\.|INT\s*[-\u2013]\s*EXT\.?|EXT\s*[-\u2013]\s*INT\.?)"
)
_SCENE_NUMBER_RE = re.compile(r"^\s*\d+[.]\s")
_SECTION_RE = re.compile(r"^\s*#{1,6}\s")
_FORCED_BREAK_RE = re.compile(r"\{pagebreak\}")
_PAREN_RE = re.compile(r"^\s*\(([^)]*)\)\s*$")
_FORCED_CHAR_RE = re.compile(r"^\s*\[([^\]]+)\]\s*$")
_TRANSITION_RE = re.compile(r"^[A-Z0-9][A-Z0-9 \-]*:\s*$")


@dataclass
class Problem:
    code: str
    line: int
    offset: int
    detail: str

    def to_dict(self) -> dict:
        return {"code": self.code, "line": self.line, "offset": self.offset,
                "detail": self.detail}


@dataclass
class _Line:
    text: str
    start: int      # offset of first char of the line text in the snapshot
    end: int        # offset just past the last char of the line text (excl. terminator)
    index: int


def _split_lines(snapshot: str) -> List[_Line]:
    """Split into lines, tracking each line's [start, end) offsets in the
    original string. Handles both ``\\n`` and ``\\r\\n`` without altering bytes."""
    lines: List[_Line] = []
    n = len(snapshot)
    i = 0
    start = 0
    while i <= n:
        if i == n:
            if start < n or (not lines and n == 0):
                lines.append(_Line(snapshot[start:n], start, n, len(lines)))
            break
        ch = snapshot[i]
        if ch == "\n":
            end = i
            lines.append(_Line(snapshot[start:end], start, end, len(lines)))
            i += 1
            start = i
        elif ch == "\r" and i + 1 < n and snapshot[i + 1] == "\n":
            end = i
            lines.append(_Line(snapshot[start:end], start, end, len(lines)))
            i += 2
            start = i
        else:
            i += 1
    # A trailing line with no terminator is already added by the i==n branch.
    return lines


def _is_blank(text: str) -> bool:
    return text.strip() == ""


def _is_all_caps(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    return bool(letters) and all(c.isupper() for c in letters)


def _parse_character(line: str):
    """Return (speaker, extension, parenthetical) for an all-caps cue line.

    Handles a trailing parenthetical on the cue line: ``ARTHUR (V.O.)`` (a
    known extension in parens) and ``ARTHUR (whispering)`` (a speech direction),
    plus the space form ``ARTHUR V.O.``.
    """
    text = line.strip()
    paren = None
    ext = None
    # Trailing parenthetical on the cue line.
    m = re.search(r"\(([^)]*)\)\s*$", text)
    if m and "(" in text:
        inner = m.group(1).strip()
        before = text[: m.start()].strip()
        if inner.upper() in KNOWN_EXTENSIONS:
            ext = inner.upper()
            text = before
        elif before:  # "ARTHUR (whispering)" -> speech direction
            paren = inner
            text = before
        # A lone "(V.O.)" line has no speaker; leave text as-is.
    # Space-separated extension form: ARTHUR V.O.
    if ext is None:
        parts = text.rsplit(" ", 1)
        if len(parts) == 2 and parts[1].upper() in KNOWN_EXTENSIONS:
            ext = parts[1].upper()
            text = parts[0].strip()
    # Unknown-extension heuristic: a trailing token ending in '.' not known.
    if ext is None:
        parts = text.rsplit(" ", 1)
        if len(parts) == 2 and re.fullmatch(r"[A-Z]{2,}\.", parts[1]):
            ext = parts[1].upper()  # flagged as unknown by caller
            text = parts[0].strip()
    return text, ext, paren


def _element(kind: str, text: str, **extra) -> dict:
    e = {"kind": kind, "text": text}
    e.update(extra)
    return e


def parse(snapshot: str):
    """Parse a Fountain snapshot.

    Returns ``(scenes, problems)`` where ``scenes`` is a list of
    :class:`models.Scene` (positional ids, offsets into ``snapshot``) and
    ``problems`` is a list of :class:`Problem`.
    """
    lines = _split_lines(snapshot)
    problems: List[Problem] = []

    # Identify scene-heading line indices.
    heading_idx = []
    for li in lines:
        t = li.text
        if _is_blank(t):
            continue
        if _SCENE_RE.match(t):
            heading_idx.append(li.index)
        elif _SCENE_NUMBER_RE.match(t) and _SCENE_RE.match(t.lstrip() and re.sub(r"^\s*\d+[.]\s", "", t)):
            problems.append(Problem("SCENE_NUMBERING", li.index, li.start,
                                    "numbered scene heading is unsupported"))
            heading_idx.append(li.index)

    # Title-page metadata = lines strictly before the first scene heading.
    first_heading_pos = heading_idx[0] if heading_idx else len(lines)

    # Walk scenes.
    scenes: List[M.Scene] = []
    for s_no, hi in enumerate(heading_idx):
        hline = lines[hi]
        if s_no + 1 < len(heading_idx):
            region_end = lines[heading_idx[s_no + 1]].start
        else:
            region_end = len(snapshot)

        # Element classification within this scene (lines[hi..region_end)).
        # Determine the last line index that lies within this region.
        last_in_scene = hi
        for k in range(hi + 1, len(lines)):
            if lines[k].start < region_end:
                last_in_scene = k
            else:
                break

        elements = [_element("scene_heading", hline.text.strip())]
        state = "action"  # 'action' or 'dialogue'
        for k in range(hi + 1, last_in_scene + 1):
            li = lines[k]
            t = li.text
            if _is_blank(t):
                if state == "dialogue":
                    state = "action"
                continue

            if _FORCED_BREAK_RE.search(t):
                problems.append(Problem("FORCED_PAGE_BREAK", li.index, li.start,
                                        "forced page breaks are unsupported"))
                elements.append(_element("action", t, unsupported="FORCED_PAGE_BREAK"))
                continue

            if _SECTION_RE.match(t):
                problems.append(Problem("SECTION_HEADING", li.index, li.start,
                                        "section headings (#) are unsupported"))
                elements.append(_element("action", t, unsupported="SECTION_HEADING"))
                continue

            if _TRANSITION_RE.match(t):
                elements.append(_element("transition", t.strip()))
                state = "action"
                continue

            fm = _FORCED_CHAR_RE.match(t)
            if fm:
                elements.append(_element("character", fm.group(1), speaker=fm.group(1),
                                         forced=True))
                state = "dialogue"
                continue

            pm = _PAREN_RE.match(t)
            if pm:
                if state == "dialogue":
                    elements.append(_element("parenthetical", t.strip(),
                                             content=pm.group(1)))
                    continue
                # A parenthetical in action position: keep as action (unusual).
                elements.append(_element("action", t))
                continue

            if _is_all_caps(t):
                speaker, ext, paren = _parse_character(t)
                if ext is not None and ext not in KNOWN_EXTENSIONS:
                    problems.append(
                        Problem("UNKNOWN_EXTENSION", li.index, li.start,
                                f"unknown character extension '{ext}'"))
                el = _element("character", t.strip(), speaker=speaker)
                if ext:
                    el["extension"] = ext
                if paren:
                    el["parenthetical"] = paren
                elements.append(el)
                state = "dialogue"
                continue

            # Non all-caps, non structural.
            if state == "dialogue":
                elements.append(_element("dialogue", t.rstrip()))
            else:
                elements.append(_element("action", t.rstrip()))

        scene = M.Scene(
            id=f"scene-{s_no}",
            order=s_no,
            kind="scene",
            heading=hline.text.strip(),
            start=hline.start,
            end=region_end,
            elements=elements,
            parse_ok=True,
        )
        scenes.append(scene)

    # Mark parse_ok per scene based on problems that fall in its range.
    for sc in scenes:
        if any(sc.start <= p.offset < sc.end for p in problems):
            sc.parse_ok = False

    # Metadata block (title/author) before first scene -> surfaced for import.
    return scenes, problems


def extract_metadata(snapshot: str) -> dict:
    """Pull Fountain title-page metadata (``Title:``, ``Credit:``, ...) from the
    lines before the first scene heading."""
    lines = _split_lines(snapshot)
    meta: dict = {}
    for li in lines:
        t = li.text.strip()
        if _is_blank(t):
            continue
        if _SCENE_RE.match(t):
            break
        if _is_all_caps(t):
            continue  # transitions like "FADE IN:" / "CUT TO:" are not metadata
        m = re.match(r"^([A-Za-z][A-Za-z ]*?):\s*(.*)$", t)
        if m:
            meta[m.group(1).strip().lower()] = m.group(2).strip()
    return meta


# --- Candidate assembly ----------------------------------------------------

def _format_scene_text(heading: str, content: str) -> str:
    parts = []
    if heading and heading.strip():
        parts.append(heading.strip())
    body = (content or "").strip("\n")
    if body:
        parts.append(body)
    return "\n".join(parts)


def apply_operation(snapshot: str, scenes: List[M.Scene], op: M.Operation,
                    next_scene_id: str):
    """Apply one operation to a snapshot + its scene index.

    Returns ``(new_snapshot, new_scenes)`` where ``new_scenes`` carries
    positional ids and the caller re-maps them. The replaced/inserted scene's
    region is spliced so no other scene's bytes change.
    """
    if op.type == "replace":
        target = next((s for s in scenes if s.id == op.scene_id), None)
        if target is None:
            raise M.ServiceError(M.ERR_SCENE_NOT_FOUND,
                                 f"scene {op.scene_id} not in base revision")
        new_text = _format_scene_text(op.heading, op.content)
        s, e = target.start, target.end
        # ``e`` is the next scene heading's start (or end of doc). The replaced
        # region's trailing separator is gone, so re-emit a single blank line to
        # keep the following scene heading on its own line.
        new_snapshot = snapshot[:s] + new_text + "\n\n" + snapshot[e:]
        new_snapshot = _normalize_gap(new_snapshot)
        return new_snapshot, parse(new_snapshot)[0]

    if op.type == "insert":
        new_text = _format_scene_text(op.heading, op.content)
        if op.before_scene_id is None:
            # Append at end.
            base = snapshot
            # ensure the doc ends with a newline separator
            sep = "" if base.endswith("\n\n") else ("\n\n" if base else "")
            insert_at = len(base)
            new_snapshot = base + sep + new_text
        else:
            target = next((sc for sc in scenes if sc.id == op.before_scene_id), None)
            if target is None:
                raise M.ServiceError(M.ERR_SCENE_NOT_FOUND,
                                     f"scene {op.before_scene_id} not found")
            insert_at = target.start
            new_snapshot = snapshot[:insert_at] + new_text + "\n\n" + snapshot[insert_at:]
        return new_snapshot, parse(new_snapshot)[0]

    raise M.ServiceError(M.ERR_INVALID_PROPOSAL, f"unknown operation type {op.type!r}")


def _normalize_gap(snapshot: str) -> str:
    """Collapse any run of >=2 blank lines into a single blank line. A minimal,
    local well-formedness fix used around spliced scenes; it never rewrites a
    scene's own content."""
    return re.sub(r"\n{3,}", "\n\n", snapshot)
