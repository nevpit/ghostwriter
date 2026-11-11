"""Pure-stdlib PDF renderer for screenplays (industry-standard page layout).

Zero runtime dependencies: the PDF uses the base-14 Courier family, which
every viewer ships. Courier is monospaced (``0.6 em`` per glyph), so wrapping
and pagination are exact and deterministic with no font-metric tables.

Layout follows the conventions used by Final Draft / Highland / WriterSolo:

* US Letter, Courier 12 pt, 6 lines per inch.
* Margins: 1.5" left, 1" right, 1" top and bottom; page number ``N.`` in the
  top-right corner from the second body page on (the title page is unnumbered).
* Columns (from the page's left edge): scene heading / action 1.5"; character
  cue 3.7"; dialogue 2.5" (3.5" wide); parenthetical 3.1" (2.5" wide);
  transitions flush right at 7.5".
* Spacing is derived from the *structure*, not from the source's blank lines:
  one blank line before every element except within a speech (cue,
  parenthetical, dialogue), so output is consistent however the text was typed.
* Pagination: a scene heading is never left alone at the bottom of a page; a
  speech that breaks across pages gets ``(MORE)`` and ``NAME (CONT'D)``; short
  action paragraphs are not split; ``===`` forces a page break.
* Fountain emphasis (``*italic*``, ``**bold**``, ``***both***``, ``_underline_``)
  is rendered; notes, boneyard, sections and synopses are not printed.
* Text is encoded as WinAnsi (cp1252), so curly quotes, dashes and ellipses
  print correctly.

If the renderer cannot produce output it raises :class:`RendererError`, which
the service maps to ``RENDERER_UNAVAILABLE``.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass, field
from typing import List, Optional, Tuple

from . import fountain


# --- Settings ---------------------------------------------------------------

@dataclass
class RenderSettings:
    page_width: float = 612.0
    page_height: float = 792.0
    margin_top: float = 72.0
    margin_bottom: float = 72.0
    margin_left: float = 108.0
    margin_right: float = 72.0
    font_size: float = 12.0
    leading: float = 12.0          # points per line (6 lines / inch)
    title_font_size: float = 12.0  # industry standard: same face and size
    bold_scene_headings: bool = False
    page_numbers: bool = True
    config_version: str = "screenplay-pdf/4"

    @property
    def char_width(self) -> float:
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

    def col(self, kind: str) -> Tuple[float, float]:
        """``(x, wrap_width)`` in points for an element kind. For right-aligned
        kinds (transitions) ``x`` is the right edge."""
        W = self.text_right - self.text_left
        if kind == "character":
            x = self.text_left + 158.4          # 3.7" from the page edge
            return (x, self.text_right - x)
        if kind in ("dialogue", "more"):
            return (self.text_left + 72.0, 252.0)   # 2.5", 3.5" wide
        if kind == "parenthetical":
            return (self.text_left + 115.2, 180.0)  # 3.1", 2.5" wide
        if kind == "transition":
            return (self.text_right, W)
        return (self.text_left, W)

    def to_dict(self) -> dict:
        return asdict(self)


class RendererError(Exception):
    """Raised when no PDF can be produced (maps to RENDERER_UNAVAILABLE)."""


# --- Emphasis markup --------------------------------------------------------

B, I, U = 1, 2, 4  # style flags


def styled(text: str) -> Tuple[str, List[int]]:
    """Strip Fountain emphasis markup from ``text``.

    Returns ``(plain, flags)`` where ``flags[i]`` is the style of
    ``plain[i]``. A marker only toggles when it has a partner, so a stray
    ``*`` or ``_`` prints literally. Inline notes and boneyard are removed.
    """
    text = re.sub(r"\[\[.*?\]\]", "", text, flags=re.S)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    out: List[str] = []
    flags: List[int] = []
    state = 0
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "\\" and i + 1 < n and text[i + 1] in "*_":
            out.append(text[i + 1]); flags.append(state); i += 2
            continue
        if c == "*":
            j = i
            while j < n and text[j] == "*":
                j += 1
            run = min(j - i, 3)
            bit = {1: I, 2: B, 3: B | I}[run]
            marker = "*" * run
            closing = (state & bit) == bit
            if closing or text.find(marker, i + run) != -1:
                state ^= bit
                i += run
                continue
        elif c == "_":
            if (state & U) or text.find("_", i + 1) != -1:
                state ^= U
                i += 1
                continue
        out.append(c); flags.append(state); i += 1
    return "".join(out), flags


# --- Wrapping ---------------------------------------------------------------

def _wrap_spans(text: str, max_chars: int) -> List[Tuple[int, int]]:
    """Word-wrap one line; return ``[start, end)`` spans into ``text``. Breaks
    on word boundaries; a word longer than the column is hard-broken."""
    words = [(m.start(), m.end()) for m in re.finditer(r"\S+", text)]
    if not words:
        return [(0, 0)]
    if max_chars <= 0:
        return [(words[0][0], words[-1][1])]
    spans: List[Tuple[int, int]] = []
    cur: Optional[List[int]] = None
    for ws, we in words:
        while we - ws > max_chars:
            if cur:
                spans.append(tuple(cur)); cur = None
            spans.append((ws, ws + max_chars))
            ws += max_chars
        if cur is None:
            cur = [ws, we]
        elif we - cur[0] <= max_chars:
            cur[1] = we
        else:
            spans.append(tuple(cur))
            cur = [ws, we]
    if cur:
        spans.append(tuple(cur))
    return spans


def _wrap(text: str, max_chars: int) -> List[str]:
    """Word-wrap ``text`` to ``max_chars`` (normalizing whitespace), keeping
    embedded newlines. Never splits a word unless it is longer than a line."""
    out: List[str] = []
    for raw in text.split("\n"):
        for s, e in _wrap_spans(raw, max_chars):
            out.append(" ".join(raw[s:e].split()))
    return out


# --- Layout model -----------------------------------------------------------

@dataclass
class Line:
    """One printed line: styled runs at an x position."""
    text: str
    flags: List[int]
    x: float
    kind: str
    align: str = "left"           # left | right | center
    right_text: str = ""          # e.g. right-margin scene number
    extra: List["Line"] = field(default_factory=list)  # drawn on the same row


@dataclass
class Block:
    kind: str
    lines: List[Line]
    space_before: int = 1
    keep_with_next: bool = False
    speaker: str = ""             # speech blocks: cue text for (CONT'D)
    page_break_before: bool = False
    splittable: bool = True


def _mk_lines(text: str, kind: str, s: RenderSettings, upper: bool = False,
              align: str = "left", width: Optional[float] = None) -> List[Line]:
    plain, flags = styled(text)
    if upper:
        plain = plain.upper()
    x, w = s.col(kind)
    if width is not None:
        w = width
    max_chars = int(w // s.char_width)
    out: List[Line] = []
    pos = 0
    for raw in plain.split("\n"):
        for a, b in _wrap_spans(raw, max_chars):
            out.append(Line(raw[a:b], flags[pos + a:pos + b], x, kind, align))
        pos += len(raw) + 1
    return out


def _cue_text(el: dict) -> str:
    t = el.get("text", "").strip()
    if t.startswith("@"):
        t = t[1:].strip()
    if t.endswith("^"):
        t = t[:-1].rstrip()
    return t


def _speech_lines(group: List[dict], s: RenderSettings,
                  offset: float = 0.0, width_scale: float = 1.0) -> List[Line]:
    lines: List[Line] = []
    for el in group:
        k = el["kind"]
        if k == "character":
            lines += _mk_lines(_cue_text(el), "character", s)
        elif k == "parenthetical":
            lines += _mk_lines(el["text"].strip(), "parenthetical", s,
                               width=s.col("parenthetical")[1] * width_scale)
        else:
            for raw in el["text"].split("\n"):
                if raw.strip() == "":
                    lines.append(Line("", [], s.col("dialogue")[0], "dialogue"))
                else:
                    lines += _mk_lines(raw, "dialogue", s,
                                       width=s.col("dialogue")[1] * width_scale)
    for ln in lines:
        ln.x += offset
    return lines


def _dual_lines(left: List[dict], right: List[dict], s: RenderSettings) -> List[Line]:
    """Side-by-side dual dialogue: each speech in a half-width column."""
    half = (s.text_right - s.text_left) / 2.0
    lcol = _speech_lines(left, s, width_scale=0.75)
    rcol = _speech_lines(right, s, width_scale=0.75)
    for col, base in ((lcol, s.text_left), (rcol, s.text_left + half)):
        for ln in col:
            if ln.kind == "character":
                ln.x = base + 72.0
            elif ln.kind == "parenthetical":
                ln.x = base + 36.0
            else:
                ln.x = base
    rows = max(len(lcol), len(rcol))
    merged: List[Line] = []
    for r in range(rows):
        a = lcol[r] if r < len(lcol) else None
        b = rcol[r] if r < len(rcol) else None
        if a is None:
            a = Line("", [], s.text_left, "dialogue")
        if b is not None:
            a.extra.append(b)
        merged.append(a)
    return merged


_SPEECH = ("character", "parenthetical", "dialogue")


def build_blocks(doc: "fountain.Document", s: RenderSettings) -> List[Block]:
    """Turn a parsed document's printable elements into layout blocks."""
    els = [e for e in doc.elements if e["kind"] not in fountain.NON_PRINTING]
    blocks: List[Block] = []
    pending_break = False
    i = 0
    while i < len(els):
        el = els[i]
        k = el["kind"]
        if k == "page_break":
            pending_break = True
            i += 1
            continue
        if k == "character":
            j = i + 1
            while j < len(els) and els[j]["kind"] in ("parenthetical", "dialogue"):
                j += 1
            group = els[i:j]
            # Dual dialogue: this speech + the next one marked with "^".
            if j < len(els) and els[j]["kind"] == "character" and els[j].get("dual"):
                m = j + 1
                while m < len(els) and els[m]["kind"] in ("parenthetical", "dialogue"):
                    m += 1
                blocks.append(Block("dual", _dual_lines(group, els[j:m], s),
                                    splittable=False, page_break_before=pending_break))
                pending_break = False
                i = m
                continue
            blocks.append(Block("speech", _speech_lines(group, s), speaker=_cue_text(el),
                                page_break_before=pending_break))
            pending_break = False
            i = j
            continue
        if k in ("parenthetical", "dialogue"):
            # Orphan speech parts (no cue) print in their own columns.
            lines = _speech_lines([el], s)
        elif k == "scene_heading":
            lines = _mk_lines(el.get("heading") or el["text"], "scene_heading", s,
                              upper=not el.get("forced"))
            if s.bold_scene_headings:
                for ln in lines:
                    ln.flags = [f | B for f in ln.flags]
            num = el.get("scene_number")
            if num and lines:
                lines[0].right_text = num
            blk = Block("scene_heading", lines, space_before=2 if blocks else 0,
                        keep_with_next=True, splittable=False, page_break_before=pending_break)
            blocks.append(blk)
            pending_break = False
            i += 1
            continue
        elif k == "transition":
            text = el["text"].strip()
            left = text.upper().startswith("FADE IN")
            lines = _mk_lines(text, "action" if left else "transition", s, upper=True,
                              align="left" if left else "right")
        elif k == "centered":
            lines = _mk_lines(el["text"], "action", s, align="center")
        elif k == "lyric":
            lines = _mk_lines(el["text"], "action", s)
            for ln in lines:
                ln.flags = [f | I for f in ln.flags]
        else:  # action
            lines = _mk_lines(el["text"], "action", s)
        blocks.append(Block(k, lines, splittable=(k == "action"),
                            page_break_before=pending_break))
        pending_break = False
        i += 1
    if blocks:
        blocks[0].space_before = 0
    return blocks


# --- Pagination -------------------------------------------------------------

Page = List[Optional[Line]]   # None = blank line


def paginate_blocks(blocks: List[Block], s: RenderSettings) -> List[Page]:
    cap = s.lines_per_page
    pages: List[Page] = []
    cur: Page = []

    def new_page():
        nonlocal cur
        pages.append(cur)
        cur = []

    def room() -> int:
        return cap - len(cur)

    def gap(b: Block) -> int:
        return 0 if not cur else b.space_before

    idx = 0
    while idx < len(blocks):
        b = blocks[idx]
        if b.page_break_before and cur:
            new_page()
        need = gap(b) + len(b.lines)
        # Keep a heading with the first lines of what follows it.
        if b.keep_with_next and idx + 1 < len(blocks):
            nb = blocks[idx + 1]
            need += nb.space_before + min(len(nb.lines), 2)
        if need <= room():
            cur.extend([None] * gap(b))
            cur.extend(b.lines)
            idx += 1
            continue
        if cur and not b.keep_with_next:
            avail = room() - gap(b)
            if b.kind == "speech" and b.splittable:
                # Leave (MORE) at the bottom; need cue + 2 lines above, 2 below.
                body = len(b.lines) - 1
                take = avail - 1
                if body >= 4 and take >= 3 and len(b.lines) - take >= 2:
                    while take > 2 and b.lines[take - 1].kind == "parenthetical":
                        take -= 1
                    cur.extend([None] * gap(b))
                    cur.extend(b.lines[:take])
                    cue_x = s.col("character")[0]
                    cur.append(Line("(MORE)", [0] * 6, cue_x, "more"))
                    new_page()
                    spk = b.speaker
                    if "CONT'D" not in spk.upper() and "CONT’D" not in spk.upper():
                        spk = spk + " (CONT'D)"
                    rest = [Line(spk, [0] * len(spk), cue_x, "character")] + b.lines[take:]
                    blocks[idx] = Block("speech", rest, space_before=0, speaker=b.speaker)
                    continue
            elif b.kind == "action" and b.splittable and len(b.lines) >= 4 and avail >= 2 \
                    and len(b.lines) - avail >= 2:
                cur.extend([None] * gap(b))
                cur.extend(b.lines[:avail])
                new_page()
                blocks[idx] = Block("action", b.lines[avail:], space_before=0)
                continue
        if not cur:
            # Taller than a page: hard split.
            cur.extend(b.lines[:cap])
            if len(b.lines) > cap:
                new_page()
                blocks[idx] = Block(b.kind, b.lines[cap:], space_before=0, speaker=b.speaker)
                continue
            idx += 1
            continue
        new_page()
    if cur or not pages:
        pages.append(cur)
    return pages


def layout_lines(snapshot: str, s: RenderSettings) -> List[Tuple[str, float, str, bool]]:
    """Flat (unpaginated) layout: ``(text, x, kind, right_aligned)`` tuples with
    blank spacing lines. Handy for tests and quick length estimates."""
    doc = fountain.parse_document(snapshot)
    out: List[Tuple[str, float, str, bool]] = []
    for n, b in enumerate(build_blocks(doc, s)):
        if n:
            out.extend([("", 0.0, "blank", False)] * b.space_before)
        for ln in b.lines:
            out.append((ln.text, ln.x, ln.kind, ln.align == "right"))
    return out


def body_pages(snapshot: str, s: RenderSettings) -> List[Page]:
    doc = fountain.parse_document(snapshot)
    blocks = build_blocks(doc, s)
    return paginate_blocks(blocks, s) if blocks else []


# --- Title page -------------------------------------------------------------

_CENTER_KEYS = ("title", "credit", "author", "authors", "source")
_RIGHT_KEYS = ("draft date", "date", "revision", "copyright")
_LEFT_KEYS = ("contact", "address", "email", "phone", "notes")


def split_title(snapshot: str) -> Tuple[dict, List[str], int]:
    """``(fields, order, body_start)`` of the Fountain title page."""
    doc = fountain.parse_document(snapshot)
    tp = doc.title_page
    if not tp["fields"]:
        return {}, [], 0
    fields: dict = {}
    order: List[str] = []
    for f in tp["fields"]:
        if f["key"] not in fields:
            order.append(f["key"])
        fields[f["key"]] = f["value"]
    return fields, order, tp["end"]


def _title_layout(fields: dict, order: List[str], s: RenderSettings) -> List[Tuple[Line, float]]:
    """Positioned title-page lines: ``[(Line, y)]``."""
    low = {k.lower(): (k, v) for k, v in fields.items() if (v or "").strip()}
    placed: List[Tuple[Line, float]] = []
    L = s.leading
    y = s.page_height * (1.0 - 0.36)

    def center(text: str, bold: bool = False):
        nonlocal y
        for ln in _mk_lines(text, "action", s, align="center"):
            if bold and not any(ln.flags):
                ln.flags = [B] * len(ln.text)
            placed.append((ln, y))
            y -= L

    if "title" in low:
        center(low["title"][1], bold=True)
    credit = low.get("credit", (None, ""))[1]
    author = (low.get("author") or low.get("authors") or (None, ""))[1]
    if author and not credit:
        credit = "Written by"
    if credit:
        y -= 3 * L
        center(credit)
    if author:
        y -= L
        center(author)
    if "source" in low:
        y -= 3 * L
        center(low["source"][1])

    def corner(keys, align):
        texts = [low[k][1] for k in keys if k in low]
        if align == "left":
            texts += [f"{k}: {v}" for k, v in fields.items()
                      if k.lower() not in _CENTER_KEYS + _RIGHT_KEYS + _LEFT_KEYS and (v or "").strip()]
        lines: List[Line] = []
        for t in texts:
            lines += _mk_lines(t, "action", s, width=(s.text_right - s.text_left) / 2 - 12)
        yy = s.margin_bottom + (len(lines) - 1) * L
        for ln in lines:
            if align == "right":
                ln.align = "right"
                ln.x = s.text_right
            placed.append((ln, yy))
            yy -= L

    corner(_LEFT_KEYS, "left")
    corner(_RIGHT_KEYS, "right")
    return placed


# --- Text encoding ----------------------------------------------------------

_FALLBACK = {"‐": "-", "‑": "-", "‒": "-", "―": "--",
             "′": "'", "″": '"', "\u00a0": " ", "\u2009": " ", "\u200b": ""}


def _encode(text: str) -> bytes:
    out = bytearray()
    for ch in text:
        try:
            out += ch.encode("cp1252")
            continue
        except UnicodeEncodeError:
            pass
        rep = _FALLBACK.get(ch)
        if rep is None:
            rep = unicodedata.normalize("NFKD", ch).encode("cp1252", "ignore").decode("cp1252") or "?"
        out += rep.encode("cp1252", "replace")
    return bytes(out).replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _font_for(flag: int) -> str:
    return {0: "/F1", B: "/F2", I: "/F3", B | I: "/F4"}[flag & (B | I)]


def _draw_line(ln: Line, y: float, s: RenderSettings, parts: List[bytes]) -> None:
    for sib in ln.extra:
        _draw_line(sib, y, s, parts)
    if not ln.text:
        return
    width = len(ln.text) * s.char_width
    if ln.align == "right":
        x0 = ln.x - width
    elif ln.align == "center":
        x0 = s.text_left + ((s.text_right - s.text_left) - width) / 2.0
    else:
        x0 = ln.x
    flags = ln.flags if len(ln.flags) == len(ln.text) else [0] * len(ln.text)
    i = 0
    underlines = []
    while i < len(ln.text):
        j = i
        while j < len(ln.text) and flags[j] == flags[i]:
            j += 1
        x = x0 + i * s.char_width
        parts.append(f"{_font_for(flags[i])} {s.font_size:g} Tf\n".encode())
        parts.append(f"1 0 0 1 {x:.2f} {y:.2f} Tm\n(".encode() + _encode(ln.text[i:j]) + b") Tj\n")
        if flags[i] & U:
            underlines.append((x, (j - i) * s.char_width))
        i = j
    if ln.right_text:
        rx = s.text_right - len(ln.right_text) * s.char_width
        parts.append(f"/F1 {s.font_size:g} Tf\n1 0 0 1 {x0 - 54:.2f} {y:.2f} Tm\n(".encode()
                     + _encode(ln.right_text) + b") Tj\n")
        parts.append(f"1 0 0 1 {rx:.2f} {y:.2f} Tm\n(".encode() + _encode(ln.right_text) + b") Tj\n")
    for (ux, uw) in underlines:
        parts.append(f"ET\n0.6 w {ux:.2f} {y - 1.5:.2f} m {ux + uw:.2f} {y - 1.5:.2f} l S\nBT\n".encode())


def _page_stream(lines: List[Tuple[Line, float]], s: RenderSettings,
                 number: Optional[int] = None) -> bytes:
    parts: List[bytes] = [b"BT\n"]
    if number is not None:
        label = f"{number}."
        x = s.text_right - len(label) * s.char_width
        parts.append(f"/F1 {s.font_size:g} Tf\n1 0 0 1 {x:.2f} {s.page_height - 36:.2f} Tm\n({label}) Tj\n".encode())
    for ln, y in lines:
        _draw_line(ln, y, s, parts)
    parts.append(b"ET")
    return b"".join(parts)


# --- Public API -------------------------------------------------------------

def _body_streams(snapshot: str, s: RenderSettings) -> List[bytes]:
    streams = []
    for n, page in enumerate(body_pages(snapshot, s), start=1):
        placed = []
        y = s.text_top
        for ln in page:
            if ln is not None:
                placed.append((ln, y))
            y -= s.leading
        streams.append(_page_stream(placed, s, n if (s.page_numbers and n > 1) else None))
    return streams


def count_pages(snapshot: str, s: Optional[RenderSettings] = None) -> int:
    """Page count (title page included) without assembling PDF bytes."""
    s = s or RenderSettings()
    fields, _order, _ = split_title(snapshot)
    n = len(body_pages(snapshot, s))
    return (1 if fields else 0) + n or 1


def render_pages(snapshot: str, s: RenderSettings) -> List[List[str]]:
    """Text of every page (title page first), for inspection."""
    fields, order, _ = split_title(snapshot)
    pages: List[List[str]] = []
    if fields:
        pages.append([ln.text for ln, _y in _title_layout(fields, order, s)])
    for page in body_pages(snapshot, s):
        pages.append(["" if ln is None else
                      "    ".join([ln.text] + [x.text for x in ln.extra]).strip() if ln.extra else
                      ln.text for ln in page])
    return pages or [[]]


def _pdf_string(text: str) -> bytes:
    return b"(" + _encode(text) + b")"


def render_pdf(snapshot: str, s: RenderSettings) -> Tuple[bytes, int]:
    """Render the snapshot to PDF. Returns ``(pdf_bytes, page_count)``."""
    try:
        fields, order, _ = split_title(snapshot)
        streams: List[bytes] = []
        if fields:
            streams.append(_page_stream(_title_layout(fields, order, s), s))
        streams.extend(_body_streams(snapshot, s))
    except Exception as exc:  # pragma: no cover - defensive
        raise RendererError(f"layout failed: {exc}") from exc
    if not streams:
        streams = [b"BT\nET"]

    n = len(streams)
    first_page = 8
    page_nums = [first_page + 2 * i for i in range(n)]
    objects: dict = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [" + b" ".join(f"{p} 0 R".encode() for p in page_nums)
           + b"] /Count " + str(n).encode() + b" >>",
    }
    low = {k.lower(): v for k, v in fields.items()}
    title = fountain.strip_markup(low.get("title", "")).replace("\n", " ").strip() or "Screenplay"
    author = fountain.strip_markup(low.get("author") or low.get("authors") or "").replace("\n", " ")
    objects[3] = (b"<< /Producer (Ghostwriter " + s.config_version.encode() + b") /Title "
                  + _pdf_string(title) + (b" /Author " + _pdf_string(author) if author else b"")
                  + b" >>")
    for num, face in ((4, "Courier"), (5, "Courier-Bold"), (6, "Courier-Oblique"),
                      (7, "Courier-BoldOblique")):
        objects[num] = (f"<< /Type /Font /Subtype /Type1 /BaseFont /{face} "
                        f"/Encoding /WinAnsiEncoding >>").encode()
    for i, stream in enumerate(streams):
        pnum = page_nums[i]
        objects[pnum] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {s.page_width:g} {s.page_height:g}] "
            f"/Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R /F4 7 0 R >> >> "
            f"/Contents {pnum + 1} 0 R >>").encode()
        objects[pnum + 1] = (b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n"
                             + stream + b"\nendstream")

    buf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for num in sorted(objects):
        offsets[num] = len(buf)
        buf += f"{num} 0 obj\n".encode() + objects[num] + b"\nendobj\n"
    xref = len(buf)
    total = max(objects) + 1
    buf += f"xref\n0 {total}\n0000000000 65535 f \n".encode()
    for num in range(1, total):
        buf += f"{offsets[num]:010d} 00000 n \n".encode()
    buf += f"trailer\n<< /Size {total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(buf), n
