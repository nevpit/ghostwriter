"""Pure-stdlib PDF renderer for screenplays.

Zero runtime dependencies (no reportlab / no Node / no font embedding): it
emits a valid PDF using the PDF **base-14 Courier** fonts, which every PDF
viewer ships natively. Because Courier is monospaced, text width is exact
(``0.6 * font_size`` per glyph), so line wrapping and page counting are
deterministic with no font-metric table.

This is the "pinned settings" the plan requires: a fixed page box, margins,
font, size, and leading, plus a ``config_version`` recorded on every export so
a later config change is detectable.

If the renderer ever cannot produce output it raises :class:`RendererError`,
which the service maps to ``RENDERER_UNAVAILABLE``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from typing import List, Tuple

from . import fountain


# --- Pinned rendering settings -------------------------------------------

@dataclass
class RenderSettings:
    # Page box (points). US Letter.
    page_width: float = 612.0
    page_height: float = 792.0
    # Margins (points). Screenplay standard: 1.5 in left, 1 in elsewhere.
    margin_top: float = 72.0
    margin_bottom: float = 72.0
    margin_left: float = 108.0
    margin_right: float = 72.0
    # Typography.
    font_size: float = 12.0
    leading: float = 12.0          # points per line
    title_font_size: float = 18.0  # title-page title (larger than body)
    # config_version bumps whenever any of the above change meaningfully.
    config_version: str = "screenplay-pdf/3"

    @property
    def char_width(self) -> float:
        # Courier advance width = 600/1000 em.
        return 0.6 * self.font_size

    @property
    def text_left(self) -> float:
        return self.margin_left

    @property
    def text_right(self) -> float:
        return self.page_width - self.margin_right

    @property
    def text_top(self) -> float:
        return self.page_height - self.margin_top

    @property
    def lines_per_page(self) -> int:
        return int((self.text_top - self.margin_bottom) // self.leading)

    # Column geometry (points from the page's left edge).
    def col(self, kind: str) -> Tuple[float, float]:
        """Return (x, wrap_width) for an element kind. Transitions are
        right-aligned; their ``x`` is the right edge. All indents are the
        industry-standard screenplay positions (from the 1.5 in margin line):
        character 3.7 in, dialogue 2.5 in, parenthetical ~3.1 in from the page
        edge; dialogue + paren use a 3.5 in column; action/scene run the full
        6 in text width."""
        W = self.text_right - self.text_left
        if kind in ("scene_heading", "action"):
            return (self.text_left, W)
        if kind == "character":
            x = self.text_left + 158.4   # 2.2 in from margin -> 3.7 in from page edge
            return (x, self.text_right - x)
        if kind == "dialogue":
            x = self.text_left + 72.0    # 1.0 in from margin -> 2.5 in from page edge
            width = 252.0                # 3.5 in dialogue column
            return (x, width)
        if kind == "parenthetical":
            x = self.text_left + 115.2   # 1.6 in from margin -> 3.1 in from page edge
            width = 252.0                # 3.5 in, centered under the dialogue
            return (x, width)
        if kind == "transition":
            right = self.text_right - 72.0  # 1 in inset from text right edge
            return (right, W)              # right edge; width unused
        return (self.text_left, W)

    def to_dict(self) -> dict:
        return asdict(self)


class RendererError(Exception):
    """Raised when no PDF can be produced (maps to RENDERER_UNAVAILABLE)."""


def _classify_line(text: str, state: str) -> Tuple[str, str]:
    """Classify one line using Fountain's character -> dialogue state machine,
    mirroring :func:`fountain.parse` exactly so dialogue lands in the indented
    3.5 in column (x=180) rather than falling through to full-width action.

    ``state`` is ``"action"`` or ``"dialogue"``. Returns ``(kind, new_state)``.
    A character cue (all-caps or forced) opens a dialogue block; a blank line,
    scene heading, or transition closes it. A parenthetical only counts as one
    while inside a dialogue block; otherwise it renders as action (as the
    parser does)."""
    t = text.strip()
    if t == "":
        # A blank line closes any open dialogue block.
        return "blank", "action"
    if fountain._SCENE_RE.match(t):
        return "scene_heading", "action"
    if fountain._TRANSITION_RE.match(t):
        return "transition", "action"
    if fountain._FORCED_CHAR_RE.match(t):
        return "character", "dialogue"
    if fountain._PAREN_RE.match(t):
        return ("parenthetical" if state == "dialogue" else "action"), state
    if fountain._is_all_caps(t):
        return "character", "dialogue"
    return ("dialogue" if state == "dialogue" else "action"), state


def _wrap(text: str, max_chars: int) -> List[str]:
    """Word-wrap ``text`` (Courier) to ``max_chars``; breaks on **word
    boundaries** (no mid-word splits) and preserves embedded newlines. Whitespace
    is normalized to single spaces. A single word longer than the whole column
    is hard-broken — the only way to avoid dropping text."""
    out: List[str] = []
    for raw in text.split("\n"):
        raw = raw.rstrip()
        if max_chars <= 0 or len(raw) <= max_chars:
            out.append(raw)
            continue
        line = ""
        for w in raw.split():
            if len(w) > max_chars:
                if line:
                    out.append(line)
                    line = ""
                for i in range(0, len(w), max_chars):
                    out.append(w[i:i + max_chars])
                continue
            candidate = (line + " " + w) if line else w
            if len(candidate) <= max_chars:
                line = candidate
            else:
                out.append(line)
                line = w
        out.append(line)
    return out


# A layout line: (text, x, kind, right_aligned)
LayoutLine = Tuple[str, float, str, bool]


def layout_lines(snapshot: str, s: RenderSettings) -> List[LayoutLine]:
    """Turn a Fountain snapshot into an ordered list of layout lines,
    preserving the source's blank-line structure and line breaks. Dialogue is
    tracked with the same character -> dialogue state machine the parser uses,
    so dialogue is indented to the standard 2.5 in column."""
    lines = fountain._split_lines(snapshot)
    out: List[LayoutLine] = []
    state = "action"  # 'action' or 'dialogue'
    for li in lines:
        kind, state = _classify_line(li.text, state)
        if kind == "blank":
            out.append(("", 0.0, "blank", False))
            continue
        x, width = s.col(kind)
        max_chars = int(width // s.char_width)
        if kind in ("character", "parenthetical", "transition"):
            out.append((li.text.strip(), x, kind, kind == "transition"))
        else:
            for wrapped in _wrap(li.text, max_chars):
                out.append((wrapped, x, kind, False))
    return out


# --- Title page -----------------------------------------------------------
# A Fountain title page is the block of "Key: Value" metadata lines at the very
# top of the document (before the first scene heading). We render it as its OWN
# first page, matching the industry-standard layout: the title in the upper
# third, the credit/author in the middle, and the contact block (address /
# email / phone) in the bottom-left corner. The body then starts on page 2.

# Fields that render in the bottom-left contact block, in display order.
_CONTACT_KEYS = ("Address", "Email", "Phone", "Contact")
# All standard title-page keys (used to tell standard vs extra metadata apart).
_STANDARD_KEYS = frozenset(
    ["Title", "Author", "Source", "Draft date", "Address", "Email", "Phone", "Contact"]
)
# A metadata line: "Key: value" where the value is non-empty. This excludes
# transitions like "FADE IN:" (no value after the colon), matching the JS parser.
_META_RE = re.compile(r"^([A-Za-z][A-Za-z ]*?):\s*(\S.*)$")
_META_LINE_RE = re.compile(r"^[A-Za-z][A-Za-z ]*?:\s*\S")


def split_title(snapshot: str) -> Tuple[dict, List[str], int]:
    """Split ``snapshot`` into ``(fields, order, body_start)``.

    ``fields`` maps each metadata key to its (trimmed) value; ``order`` is the
    original key order; ``body_start`` is the character offset of the first
    non-metadata line (the script body, e.g. "FADE IN:"). Returns empty fields
    and ``body_start == 0`` when the document has no title page. Mirrors the
    frontend's ``parseTitlePage`` so the PDF and the in-app view agree.
    """
    lines = snapshot.split("\n")
    # Find the end of the title region: blank lines and "Key: value" lines only.
    k = 0
    for i, ln in enumerate(lines):
        if ln.strip() == "":
            k = i + 1
            continue
        if _META_LINE_RE.match(ln):
            k = i + 1
            continue
        break
    fields: dict = {}
    order: List[str] = []
    body_start = 0
    for i in range(k):
        m = _META_RE.match(lines[i])
        if m:
            key = m.group(1).strip()
            if key:
                if key not in fields:
                    order.append(key)
                fields[key] = m.group(2).strip()
        body_start += len(lines[i]) + 1  # +1 = newline
    if not fields:
        return {}, [], 0
    return fields, order, body_start


def _title_center_x(text: str, size: float, s: RenderSettings) -> float:
    """Center ``text`` (Courier at ``size``) horizontally on the page."""
    w = len(text) * 0.6 * size
    return (s.page_width - w) / 2.0


def title_page_content_stream(fields: dict, order: List[str], s: RenderSettings) -> bytes:
    """Build the PDF content stream for the title page (its own first page).

    Layout (fractions of page height, from the top):
      title      36%  centered, large bold
      Written by 42%  centered
      author     46%  centered
      source     52%  centered (if present)
      draft date 56%  centered (if present)
      contact   ~84%  bottom-left (address / email / phone / contact, + extras)
    """
    H = s.page_height
    yf = lambda frac: H * (1.0 - frac)  # fraction-from-top -> y from bottom
    parts: List[str] = ["BT"]

    title = (fields.get("Title") or "").strip()
    if title:
        parts.append(f"/F2 {s.title_font_size:g} Tf")
        parts.append(f"1 0 0 1 {_title_center_x(title, s.title_font_size, s):.2f} {yf(0.36):.2f} Tm")
        parts.append(f"({_pdf_escape(title)}) Tj")

    parts.append(f"/F1 {s.font_size:g} Tf")
    author = (fields.get("Author") or "").strip()
    if author:
        parts.append(f"1 0 0 1 {_title_center_x('Written by', s.font_size, s):.2f} {yf(0.42):.2f} Tm")
        parts.append("(Written by) Tj")
        parts.append(f"1 0 0 1 {_title_center_x(author, s.font_size, s):.2f} {yf(0.46):.2f} Tm")
        parts.append(f"({_pdf_escape(author)}) Tj")
    source = (fields.get("Source") or "").strip()
    if source:
        parts.append(f"1 0 0 1 {_title_center_x(source, s.font_size, s):.2f} {yf(0.52):.2f} Tm")
        parts.append(f"({_pdf_escape(source)}) Tj")
    draft = (fields.get("Draft date") or "").strip()
    if draft:
        parts.append(f"1 0 0 1 {_title_center_x(draft, s.font_size, s):.2f} {yf(0.56):.2f} Tm")
        parts.append(f"({_pdf_escape(draft)}) Tj")

    # Contact block, bottom-left corner (left margin), one line per field.
    contact: List[str] = []
    for key in _CONTACT_KEYS:
        v = (fields.get(key) or "").strip()
        if v:
            contact.append(v)
    for key in order:  # any extra, non-standard metadata -> "Key: value"
        if key in _STANDARD_KEYS:
            continue
        v = (fields.get(key) or "").strip()
        if v:
            contact.append(f"{key}: {v}")
    if contact:
        y = yf(0.84)
        for line in contact:
            parts.append(f"1 0 0 1 {s.text_left:.2f} {y:.2f} Tm")
            parts.append(f"({_pdf_escape(line)}) Tj")
            y -= s.leading
    parts.append("ET")
    return ("\n".join(parts)).encode("latin-1", "replace")


def paginate(lines: List[LayoutLine], s: RenderSettings) -> List[List[LayoutLine]]:
    cap = s.lines_per_page
    pages: List[List[LayoutLine]] = []
    cur: List[LayoutLine] = []
    for ln in lines:
        if len(cur) >= cap:
            pages.append(cur)
            cur = []
        cur.append(ln)
    if cur:
        pages.append(cur)
    return pages or [[]]


def render_pages(snapshot: str, s: RenderSettings) -> List[List[str]]:
    """Text of every page, for inspection (M4). The title page (if present) is
    listed first in reading order, then the body pages."""
    fields, order, body_start = split_title(snapshot)
    body = snapshot[body_start:] if fields else snapshot
    pages: List[List[str]] = []
    if fields:
        tp: List[str] = []
        if fields.get("Title"):
            tp.append(fields["Title"])
        if fields.get("Author"):
            tp += ["Written by", fields["Author"]]
        for key in ("Source", "Draft date"):
            if fields.get(key):
                tp.append(fields[key])
        for key in _CONTACT_KEYS:
            if fields.get(key):
                tp.append(fields[key])
        for key in order:
            if key not in _STANDARD_KEYS and fields.get(key):
                tp.append(f"{key}: {fields[key]}")
        pages.append(tp)
    if body.strip() or not fields:
        pages.extend([[ln[0] for ln in page] for page in paginate(layout_lines(body, s), s)])
    return pages or [[]]


# --- PDF byte assembly ----------------------------------------------------

def _pdf_escape(text: str) -> str:
    return (text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)"))


def render_pdf(snapshot: str, s: RenderSettings) -> Tuple[bytes, int]:
    """Render the snapshot to PDF bytes. Returns ``(pdf_bytes, page_count)``.

    A leading title page (the Fountain metadata block) is rendered as its own
    FIRST page in the standard layout (title upper-third, author middle,
    contact bottom-left); the script body starts on the next page."""
    fields, order, body_start = split_title(snapshot)
    body = snapshot[body_start:] if fields else snapshot
    try:
        body_pages = paginate(layout_lines(body, s), s) if body.strip() else []
    except Exception as exc:  # pragma: no cover - defensive
        raise RendererError(f"layout failed: {exc}") from exc

    # Build per-page content streams: the title page first (if present), then the
    # body pages. Each body page is a flow of lines from the top margin down.
    content_streams: List[bytes] = []
    if fields:
        content_streams.append(title_page_content_stream(fields, order, s))
    for page in body_pages:
        parts: List[str] = ["BT"]
        # Font selection is REQUIRED before any Tj — without a `/F1 <size> Tf`
        # in the text object, viewers have no current font and draw a blank page
        # (the text operators are present but inert). All body text uses F1
        # (Courier) at the pinned size.
        parts.append(f"/F1 {s.font_size:g} Tf")
        y = s.text_top
        for (text, x, kind, right_aligned) in page:
            if text != "":
                if right_aligned:
                    tx = x - len(text) * s.char_width
                else:
                    tx = x
                parts.append(f"1 0 0 1 {tx:.2f} {y:.2f} Tm")
                parts.append(f"({_pdf_escape(text)}) Tj")
            y -= s.leading
        parts.append("ET")
        content_streams.append(("\n".join(parts)).encode("latin-1", "replace"))

    # Object numbering:
    #   1 Catalog, 2 Pages, 3 Info, 4 F1 Courier, 5 F2 Courier-Bold,
    #   then for page i (0-based): page obj = 6 + 2i, content = 7 + 2i.
    n = len(content_streams)
    page_obj_nums = [6 + 2 * i for i in range(n)]
    content_obj_nums = [7 + 2 * i for i in range(n)]

    objects: dict[int, bytes] = {}
    objects[1] = (b"<< /Type /Catalog /Pages 2 0 R >>")
    objects[2] = (
        b"<< /Type /Pages /Kids ["
        + b" ".join(f"{num} 0 R".encode() for num in page_obj_nums)
        + b"] /Count " + str(n).encode() + b" >>"
    )
    objects[3] = (
        b"<< /Producer (Hermes Screenplay Renderer "
        + s.config_version.encode("latin-1")
        + b") /Title (Screenplay) >>"
    )
    objects[4] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"
    objects[5] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>"

    for i in range(n):
        pnum, cnum = page_obj_nums[i], content_obj_nums[i]
        objects[pnum] = (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "
            + f"{s.page_width:g} {s.page_height:g}".encode()
            + b"] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents "
            + f"{cnum} 0 R".encode() + b" >>"
        )
        stream = content_streams[i]
        objects[cnum] = b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"

    # Serialize with xref.
    buf = bytearray()
    buf += b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    offsets: dict[int, int] = {}
    for num in sorted(objects):
        offsets[num] = len(buf)
        buf += f"{num} 0 obj\n".encode()
        buf += objects[num]
        buf += b"\nendobj\n"

    xref_pos = len(buf)
    total = max(objects) + 1
    buf += b"xref\n"
    buf += f"0 {total}\n".encode()
    buf += b"0000000000 65535 f \n"
    for num in range(1, total):
        buf += f"{offsets[num]:010d} 00000 n \n".encode()
    buf += b"trailer\n"
    buf += f"<< /Size {total} /Root 1 0 R /Info 3 0 R >>\n".encode()
    buf += b"startxref\n"
    buf += f"{xref_pos}\n".encode()
    buf += b"%%EOF\n"

    return bytes(buf), n
