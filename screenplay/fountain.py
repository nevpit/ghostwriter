"""Fountain parser (https://fountain.io/syntax), offset-accurate.

Design goals:
  * Preserve the source exactly. We never rewrite the snapshot; we compute
    half-open character offsets ``[start, end)`` into it, so a single-scene
    splice leaves every other byte untouched.
  * Follow the Fountain spec closely enough that anything a writer (or a
    model) types in normal Fountain is classified correctly: scene headings
    (incl. forced ``.HEADING`` and ``#1#`` scene numbers), character cues
    (all-caps line preceded by a blank line and followed by dialogue, forced
    ``@Name``, extensions, dual dialogue ``^``), parentheticals, dialogue,
    transitions (``... TO:`` and forced ``>``), centered text ``>TEXT<``,
    lyrics ``~``, forced action ``!``, page breaks ``===``, sections ``#``,
    synopses ``=``, notes ``[[...]]`` and boneyard ``/* ... */``.
  * Only genuinely unparseable input (an unclosed boneyard/note that swallows
    the rest of the document) is reported as a *problem*; supported syntax is
    never flagged, so a well-formed proposal is never blocked by the parser.

The document model:
  * ``title_page`` -- the leading ``Key: value`` block (may be empty).
  * ``preamble``   -- elements between the title page and the first scene
    heading (e.g. ``FADE IN:`` or a cold-open action line).
  * ``scenes``     -- one :class:`models.Scene` per scene heading. A scene's
    region runs from its heading to the next heading (or end of document).

Scene ids are *positional* (``scene-0, scene-1, ...``). The service re-maps
them to stable logical ids so a scene's identity survives its replacement.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import List, Optional, Tuple

from . import models as M


# --- Patterns ---------------------------------------------------------------

_HEADING_RE = re.compile(
    r"^(?:INT\.?/EXT|EXT\.?/INT|INT\.? ?- ?EXT|I/E|E/I|INT|EXT|EST)[.\s]", re.I)
_SCENE_NUMBER_RE = re.compile(r"\s*#([^#\s][^#]*)#\s*$")
_PAGE_BREAK_RE = re.compile(r"^={3,}\s*$")
_TRANSITION_SUFFIX_RE = re.compile(r"\bTO:$")
# Common transitions that do not end in "TO:" but are universally treated as
# transitions by screenwriting software.
KNOWN_TRANSITIONS = frozenset({
    "FADE IN:", "FADE OUT.", "FADE OUT:", "FADE TO BLACK.", "FADE TO BLACK:",
    "CUT TO BLACK.", "CUT TO BLACK:", "SMASH TO BLACK.", "THE END", "THE END.",
    "FADE OUT", "FADE TO BLACK",
})
_EXT_RE = re.compile(r"\(([^)]*)\)")

#: Extensions that commonly follow a character name.
KNOWN_EXTENSIONS = frozenset({"V.O.", "O.S.", "O.C.", "CONT'D", "CONT’D", "CONT.",
                              "PRE-LAP", "FILTERED", "ON PHONE", "SUBTITLED"})

#: Element kinds that never print (outline / notes).
NON_PRINTING = frozenset({"section", "synopsis", "note", "boneyard"})


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
    start: int      # offset of the first char of the line in the snapshot
    end: int        # offset just past the last char (excluding the terminator)
    index: int


def _split_lines(snapshot: str) -> List[_Line]:
    """Split into lines, tracking each line's ``[start, end)`` offsets. Handles
    ``\\n`` and ``\\r\\n`` without altering bytes."""
    lines: List[_Line] = []
    start = 0
    n = len(snapshot)
    while True:
        j = snapshot.find("\n", start)
        if j == -1:
            if start < n or not lines:
                lines.append(_Line(snapshot[start:n], start, n, len(lines)))
            break
        end = j - 1 if j > start and snapshot[j - 1] == "\r" else j
        lines.append(_Line(snapshot[start:end], start, end, len(lines)))
        start = j + 1
    return lines


# --- Small predicates -------------------------------------------------------

def _is_blank(text: str) -> bool:
    return text.strip() == ""


def _is_upper(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    return bool(letters) and all(c.isupper() for c in letters)


def is_scene_heading(text: str) -> bool:
    s = text.strip()
    if s.startswith(".") and not s.startswith("..") and len(s) > 1 and s[1].isalnum():
        return True
    return bool(_HEADING_RE.match(s))


def _heading_parts(text: str) -> Tuple[str, Optional[str], bool]:
    """``(heading, scene_number, forced)`` for a scene-heading line."""
    s = text.strip()
    forced = s.startswith(".") and not _HEADING_RE.match(s)
    if forced:
        s = s[1:].strip()
    num = None
    m = _SCENE_NUMBER_RE.search(s)
    if m:
        num = m.group(1).strip()
        s = s[:m.start()].rstrip()
    return s, num, forced


def _is_transition(s: str, prev_blank: bool, next_blank: bool) -> bool:
    if not _is_upper(s):
        return False
    if s in KNOWN_TRANSITIONS:
        return True
    return prev_blank and next_blank and bool(_TRANSITION_SUFFIX_RE.search(s))


def parse_cue(text: str) -> dict:
    """Parse a character cue line into ``speaker`` / ``extensions`` / flags.

    ``ARTHUR (V.O.) (CONT'D)`` -> speaker ``ARTHUR``, extensions
    ``["V.O.", "CONT'D"]``; ``@McCLANE`` is a forced cue; a trailing ``^``
    marks the second speaker of dual dialogue.
    """
    s = text.strip()
    forced = s.startswith("@")
    if forced:
        s = s[1:].strip()
    dual = s.endswith("^")
    if dual:
        s = s[:-1].rstrip()
    exts = [e.strip() for e in _EXT_RE.findall(s) if e.strip()]
    p = s.find("(")
    speaker = (s[:p] if p != -1 else s).strip()
    return {"speaker": speaker, "extensions": exts, "forced": forced, "dual": dual}


def _is_character(s: str, prev_blank: bool, next_line: Optional[str]) -> bool:
    if not prev_blank or next_line is None or _is_blank(next_line):
        return False
    if s.startswith("@"):
        return len(s) > 1
    if s.startswith(("!", ">", "~", "=", "#", "[[", "/*")):
        return False
    name = parse_cue(s)["speaker"]
    if not name or not _is_upper(name):
        return False
    # A cue is a name, not a sentence: "BANG!" / "THE END." stay action.
    if name[-1] in ".!?:" and not name.endswith(("JR.", "SR.", "DR.", "MR.", "MRS.", "MS.")):
        return False
    return True


# --- Title page ------------------------------------------------------------

_TITLE_KEY_RE = re.compile(r"^([A-Za-z][A-Za-z0-9 _'-]*?):[ \t]*(.*)$")
TITLE_KEYS = ("Title", "Credit", "Author", "Authors", "Source", "Draft date",
              "Date", "Contact", "Copyright", "Notes", "Revision")
_TITLE_KEYS_LOWER = {k.lower() for k in TITLE_KEYS}


def _parse_title_page(lines: List[_Line]) -> Tuple[dict, int]:
    """Return ``(title_page, first_body_line_index)``.

    ``title_page`` is ``{"fields": [{"key", "value", "start", "end"}], "end": off}``
    or ``{"fields": [], "end": 0}``. Values may span several indented lines
    (joined with ``\\n``). Blank lines are allowed *between* fields as long as
    the next block starts with a known title-page key.
    """
    fields: List[dict] = []
    i = 0
    n = len(lines)
    end_off = 0
    end_line = 0
    while i < n and _is_blank(lines[i].text):
        i += 1
    while i < n:
        t = lines[i].text
        m = _TITLE_KEY_RE.match(t)
        if not m or t[:1] in " \t":
            break
        key = m.group(1).strip()
        if not fields and key.lower() not in _TITLE_KEYS_LOWER:
            break
        if key.upper() == key and not m.group(2).strip() and key.lower() not in _TITLE_KEYS_LOWER:
            break  # "FADE IN:" style line, not metadata
        value_lines = [m.group(2).strip()] if m.group(2).strip() else []
        start = lines[i].start
        last = i
        j = i + 1
        while j < n and lines[j].text[:1] in (" ", "\t") and not _is_blank(lines[j].text):
            value_lines.append(lines[j].text.strip())
            last = j
            j += 1
        fields.append({"key": key, "value": "\n".join(value_lines),
                       "start": start, "end": lines[last].end})
        end_line = last + 1
        end_off = lines[last + 1].start if last + 1 < n else lines[last].end
        i = j
        # Allow blank lines between fields if another *known* key follows.
        k = i
        while k < n and _is_blank(lines[k].text):
            k += 1
        if k == i and k < n:
            continue  # the next field follows directly
        if k < n:
            m2 = _TITLE_KEY_RE.match(lines[k].text)
            if m2 and lines[k].text[:1] not in " \t" and \
                    m2.group(1).strip().lower() in _TITLE_KEYS_LOWER:
                i = k
                continue
        break
    if not fields:
        return {"fields": [], "end": 0}, 0
    # Absorb the blank lines that separate the title page from the body.
    while end_line < n and _is_blank(lines[end_line].text):
        end_line += 1
    end_off = lines[end_line].start if end_line < n else lines[-1].end
    return {"fields": fields, "end": end_off}, end_line


def title_fields(title_page: dict) -> dict:
    """``{Key: value}`` view of a title page (later duplicates win)."""
    return {f["key"]: f["value"] for f in title_page.get("fields", [])}


# --- Tokenizer -------------------------------------------------------------

def _el(kind: str, text: str, start: int, end: int, **extra) -> dict:
    e = {"kind": kind, "text": text, "start": start, "end": end}
    e.update(extra)
    return e


def _tokenize(snapshot: str):
    lines = _split_lines(snapshot)
    title_page, i = _parse_title_page(lines)
    n = len(lines)
    elements: List[dict] = []
    problems: List[Problem] = []
    prev_blank = True

    def nxt(k):
        return lines[k + 1].text if k + 1 < n else None

    while i < n:
        li = lines[i]
        t = li.text
        s = t.strip()
        if s == "":
            prev_blank = True
            i += 1
            continue

        # Boneyard /* ... */ (may span lines).
        if s.startswith("/*"):
            j = i
            if "*/" not in t[t.find("/*") + 2:]:
                j = i + 1
                while j < n and "*/" not in lines[j].text:
                    j += 1
            if j >= n:
                problems.append(Problem("UNCLOSED_BONEYARD", li.index, li.start,
                                        "boneyard '/*' is never closed with '*/'"))
                j = n - 1
            body = snapshot[li.start:lines[j].end]
            elements.append(_el("boneyard", body, li.start, lines[j].end))
            i = j + 1
            prev_blank = True
            continue

        # Stand-alone note [[ ... ]] (may span lines).
        if s.startswith("[[") and (s.endswith("]]") or "]]" not in s):
            j = i
            while j < n and "]]" not in lines[j].text:
                j += 1
            if j >= n:
                problems.append(Problem("UNCLOSED_NOTE", li.index, li.start,
                                        "note '[[' is never closed with ']]'"))
                j = n - 1
            if lines[j].text.rstrip().endswith("]]"):
                body = snapshot[li.start:lines[j].end].strip()
                elements.append(_el("note", body[2:-2].strip() if body.endswith("]]") else body,
                                    li.start, lines[j].end, raw=body))
                i = j + 1
                prev_blank = True
                continue
            # "[[note]] followed by text" on one line -> treat as action below.

        if _PAGE_BREAK_RE.match(s):
            elements.append(_el("page_break", s, li.start, li.end))
            i += 1
            prev_blank = True
            continue

        if s.startswith("#"):
            depth = len(s) - len(s.lstrip("#"))
            elements.append(_el("section", s[depth:].strip(), li.start, li.end, depth=depth, raw=s))
            i += 1
            prev_blank = True
            continue

        if s.startswith("=") and not s.startswith("=="):
            elements.append(_el("synopsis", s[1:].strip(), li.start, li.end, raw=s))
            i += 1
            prev_blank = True
            continue

        if s.startswith("~"):
            j = i
            while j + 1 < n and lines[j + 1].text.strip().startswith("~"):
                j += 1
            text = "\n".join(lines[k].text.strip()[1:].strip() for k in range(i, j + 1))
            elements.append(_el("lyric", text, li.start, lines[j].end))
            i = j + 1
            prev_blank = False
            continue

        if s.startswith(">") and s.endswith("<") and len(s) > 1:
            elements.append(_el("centered", s[1:-1].strip(), li.start, li.end, raw=s))
            i += 1
            prev_blank = False
            continue

        if s.startswith(">"):
            elements.append(_el("transition", s[1:].strip(), li.start, li.end, forced=True, raw=s))
            i += 1
            prev_blank = False
            continue

        if not s.startswith("!") and is_scene_heading(s):
            heading, num, forced = _heading_parts(s)
            extra = {"heading": heading, "forced": forced}
            if num:
                extra["scene_number"] = num
            elements.append(_el("scene_heading", s, li.start, li.end, **extra))
            i += 1
            prev_blank = True  # a heading always opens a fresh block
            continue

        nl = nxt(i)
        if not s.startswith("!") and _is_transition(s, prev_blank, nl is None or _is_blank(nl)):
            elements.append(_el("transition", s, li.start, li.end))
            i += 1
            prev_blank = False
            continue

        if not s.startswith("!") and _is_character(s, prev_blank, nl):
            cue = parse_cue(s)
            extra = {"speaker": cue["speaker"], "extensions": cue["extensions"]}
            if cue["extensions"]:
                extra["extension"] = cue["extensions"][0]
            if cue["forced"]:
                extra["forced"] = True
            if cue["dual"]:
                extra["dual"] = True
            elements.append(_el("character", s, li.start, li.end, **extra))
            i += 1
            # Dialogue block: until a truly blank line. A line of two spaces
            # keeps the block open (Fountain's intentional empty dialogue line).
            d_start = d_end = None
            d_lines: List[str] = []

            def flush():
                if d_start is not None:
                    elements.append(_el("dialogue", "\n".join(d_lines), d_start, d_end))

            while i < n:
                lt = lines[i].text
                ls = lt.strip()
                if ls == "" and not lt.startswith("  "):
                    break
                if ls.startswith("(") and ls.endswith(")"):
                    flush()
                    d_start = None
                    d_lines = []
                    elements.append(_el("parenthetical", ls, lines[i].start, lines[i].end,
                                        content=ls[1:-1].strip()))
                else:
                    if d_start is None:
                        d_start = lines[i].start
                    d_end = lines[i].end
                    d_lines.append(ls)
                i += 1
            flush()
            prev_blank = False
            continue

        # Action paragraph: consecutive non-blank lines, stopping before a line
        # that starts a structural element (heading, page break, boneyard).
        j = i
        while j + 1 < n:
            nt = lines[j + 1].text.strip()
            if nt == "" or is_scene_heading(nt) or _PAGE_BREAK_RE.match(nt) or nt.startswith("/*"):
                break
            j += 1
        text_lines = [lines[k].text.strip() for k in range(i, j + 1)]
        if text_lines[0].startswith("!"):
            text_lines[0] = text_lines[0][1:]
        text = "\n".join(text_lines)
        extra = {"forced": True} if s.startswith("!") else {}
        elements.append(_el("action", text, li.start, lines[j].end, **extra))
        i = j + 1
        prev_blank = False

    return title_page, elements, problems


@dataclass
class Document:
    title_page: dict
    preamble: List[dict]
    scenes: List[M.Scene]
    problems: List[Problem] = field(default_factory=list)

    @property
    def elements(self) -> List[dict]:
        out = list(self.preamble)
        for sc in self.scenes:
            out.extend(sc.elements)
        return out


@lru_cache(maxsize=64)
def _tokenize_cached(snapshot: str):
    return _tokenize(snapshot)


def parse_document(snapshot: str) -> Document:
    """Parse ``snapshot`` into a :class:`Document` (fresh objects every call)."""
    title_page, elements, problems = _tokenize_cached(snapshot or "")
    preamble: List[dict] = []
    scenes: List[M.Scene] = []
    for el in elements:
        el = dict(el)
        if el["kind"] == "scene_heading":
            scenes.append(M.Scene(id=f"scene-{len(scenes)}", order=len(scenes), kind="scene",
                                  heading=el["heading"], start=el["start"], end=len(snapshot),
                                  elements=[el], parse_ok=True))
            if "scene_number" in el:
                scenes[-1].meta["scene_number"] = el["scene_number"]
            if len(scenes) > 1:
                scenes[-2].end = el["start"]
        elif scenes:
            scenes[-1].elements.append(el)
        else:
            preamble.append(el)
    for sc in scenes:
        if any(sc.start <= p.offset < sc.end for p in problems):
            sc.parse_ok = False
    return Document(title_page={"fields": [dict(f) for f in title_page["fields"]],
                                "end": title_page["end"]},
                    preamble=preamble, scenes=scenes, problems=list(problems))


def parse(snapshot: str):
    """Parse a Fountain snapshot into ``(scenes, problems)``."""
    doc = parse_document(snapshot)
    return doc.scenes, doc.problems


def extract_metadata(snapshot: str) -> dict:
    """Title-page metadata as ``{lowercased key: value}``."""
    doc = parse_document(snapshot)
    return {f["key"].lower(): f["value"] for f in doc.title_page["fields"]}


def build_title_page(fields) -> str:
    """Serialize title-page fields (a ``{key: value}`` dict or a list of
    ``(key, value)`` pairs) to Fountain. Multi-line values are indented."""
    items = fields.items() if isinstance(fields, dict) else fields
    out = []
    for key, value in items:
        key = str(key).strip()
        value = "" if value is None else str(value).strip()
        if not key or not value:
            continue
        parts = [p.strip() for p in value.splitlines() if p.strip()]
        if len(parts) <= 1:
            out.append(f"{key}: {parts[0] if parts else ''}")
        else:
            out.append(f"{key}:")
            out.extend("    " + p for p in parts)
    return "\n".join(out)


def set_title_page(snapshot: str, fields) -> str:
    """Return ``snapshot`` with its title page replaced by ``fields``. The body
    is untouched. An empty ``fields`` removes the title page."""
    doc = parse_document(snapshot)
    body = snapshot[doc.title_page["end"]:] if doc.title_page["fields"] else snapshot.lstrip("\r\n")
    block = build_title_page(fields)
    if not block:
        return body
    return block + "\n\n" + body if body else block + "\n"


# --- Candidate assembly ----------------------------------------------------

def format_scene_text(heading: str, content: str) -> str:
    """Build a scene's Fountain text from a heading and a body.

    Tolerant of how models tend to send scenes: if ``content`` already starts
    with the same heading (or with any heading while ``heading`` is empty), it
    is not duplicated."""
    heading = (heading or "").strip()
    body = (content or "").replace("\r\n", "\n").strip("\n")
    first = body.lstrip().split("\n", 1)[0].strip() if body.strip() else ""
    if first and is_scene_heading(first):
        if not heading or _heading_parts(first)[0].upper() == _heading_parts(heading)[0].upper():
            heading = ""  # content carries its own heading
    parts = []
    if heading:
        if not is_scene_heading(heading):
            heading = "." + heading  # force it so it still parses as a heading
        parts.append(heading)
    if body.strip():
        parts.append(body.strip("\n"))
    return "\n\n".join(parts)


# Backwards-compatible alias.
_format_scene_text = format_scene_text


def _join(before: str, middle: str, after: str) -> str:
    """Join three pieces with exactly one blank line around ``middle``."""
    before = before.rstrip("\n")
    after = after.lstrip("\n")
    out = (before + "\n\n" if before else "") + middle.strip("\n")
    if after:
        out = (out + "\n\n" if out else "") + after
    return out.rstrip("\n") + "\n" if out else ""


def apply_operation(snapshot: str, scenes: List[M.Scene], op: M.Operation,
                    next_scene_id: Optional[str] = None):
    """Apply one operation (``insert`` / ``replace`` / ``delete``) to a snapshot.

    Returns ``(new_snapshot, new_scenes)``; ``new_scenes`` carry positional ids
    and the caller re-maps them. Only the target region is rewritten.
    """
    if op.type in ("replace", "delete"):
        target = next((s for s in scenes if s.id == op.scene_id), None)
        if target is None:
            raise M.ServiceError(M.ERR_SCENE_NOT_FOUND,
                                 f"scene {op.scene_id} not in base revision")
        middle = "" if op.type == "delete" else format_scene_text(op.heading, op.content)
        if op.type == "replace" and not middle.strip():
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL,
                                 "replace needs a heading and/or content (use delete to remove a scene)")
        new_snapshot = _join(snapshot[:target.start], middle, snapshot[target.end:])
        return new_snapshot, parse(new_snapshot)[0]

    if op.type == "insert":
        new_text = format_scene_text(op.heading, op.content)
        if not new_text.strip():
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL, "insert needs a heading and/or content")
        if op.before_scene_id is None:
            insert_at = len(snapshot)
        else:
            target = next((sc for sc in scenes if sc.id == op.before_scene_id), None)
            if target is None:
                raise M.ServiceError(M.ERR_SCENE_NOT_FOUND,
                                     f"scene {op.before_scene_id} not found")
            insert_at = target.start
        new_snapshot = _join(snapshot[:insert_at], new_text, snapshot[insert_at:])
        return new_snapshot, parse(new_snapshot)[0]

    raise M.ServiceError(M.ERR_INVALID_PROPOSAL, f"unknown operation type {op.type!r}")


def strip_markup(text: str) -> str:
    """Remove Fountain emphasis markup and inline notes/boneyard (for word
    counts, search previews, and plain-text views)."""
    text = re.sub(r"\[\[.*?\]\]", "", text, flags=re.S)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"(?<!\\)\*{1,3}|(?<!\\)_", "", text)
    return text.replace("\\*", "*").replace("\\_", "_")
