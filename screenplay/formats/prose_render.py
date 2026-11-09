"""Pure-stdlib PDF renderer for prose (book-style).

Mirrors the screenplay renderer's zero-dependency approach (see ``rendering.py``):
a valid PDF using the PDF **base-14 Times** fonts (Times-Roman / Times-Bold),
which every PDF viewer ships natively. ``config_version`` is recorded on every
export so a later layout change is detectable.

Times is proportional, not monospaced, so unlike the Courier-based screenplay
renderer the glyph width is not a single constant. We therefore wrap against a
small per-character width estimate (conservative, in thousandths-of-an-em) so a
line never overflows the text column. The estimate is approximate — good enough
for a clean, readable first book rendering, and the exact bytes stay valid PDF.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Tuple

# A layout line: (text, style, size, bold, break_before)
LayoutLine = Tuple[str, str, float, bool, bool]

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")


@dataclass
class ProseSettings:
    # Page box (points). US Letter.
    page_width: float = 612.0
    page_height: float = 792.0
    # Margins (points). Book-style: 1 inch all around.
    margin_top: float = 72.0
    margin_bottom: float = 72.0
    margin_left: float = 72.0
    margin_right: float = 72.0
    # Body typography.
    body_size: float = 12.0
    body_leading: float = 17.0
    # Heading sizes.
    part_size: float = 18.0
    chapter_size: float = 15.0
    section_size: float = 13.0
    heading_gap: float = 12.0  # extra space after a heading line
    config_version: str = "prose-pdf/1"

    @property
    def text_left(self) -> float:
        return self.margin_left

    @property
    def text_top(self) -> float:
        return self.page_height - self.margin_top

    @property
    def column_width(self) -> float:
        return self.page_width - self.margin_left - self.margin_right

    @property
    def lines_per_page(self) -> int:
        return int((self.page_height - self.margin_top - self.margin_bottom) // self.body_leading)

    def size_for(self, style: str) -> float:
        return {
            "part": self.part_size,
            "chapter": self.chapter_size,
            "section": self.section_size,
        }.get(style, self.body_size)

    def to_dict(self) -> dict:
        return {
            "page_width": self.page_width, "page_height": self.page_height,
            "margin_top": self.margin_top, "margin_bottom": self.margin_bottom,
            "margin_left": self.margin_left, "margin_right": self.margin_right,
            "body_size": self.body_size, "body_leading": self.body_leading,
            "part_size": self.part_size, "chapter_size": self.chapter_size,
            "section_size": self.section_size, "config_version": self.config_version,
        }


class ProseRendererError(Exception):
    """Raised when no PDF can be produced (maps to RENDERER_UNAVAILABLE)."""


# Conservative per-character width in thousandths of an em (Times-Roman-ish).
_NARROW = set("ilftj.,:;!?()[]/1|'`-")
_WIDE = set("WMmw@")


def _char_width_em(ch: str) -> float:
    if ch == " ":
        return 0.250
    if ch in _NARROW:
        return 0.300
    if ch in _WIDE:
        return 0.700
    if ch.isupper():
        return 0.620
    if ch.isdigit():
        return 0.500
    return 0.470


def _line_width_em(text: str) -> float:
    return sum(_char_width_em(c) for c in text)


def _wrap(text: str, max_em: float) -> List[str]:
    """Word-wrap ``text`` so each line is <= ``max_em`` (estimated width)."""
    out: List[str] = []
    for raw in text.split("\n"):
        words = raw.split()
        if not words:
            continue
        line = ""
        for w in words:
            # A single word longer than the whole column is hard-broken.
            if _line_width_em(w) > max_em:
                if line:
                    out.append(line)
                    line = ""
                for i in range(0, len(w), max(1, int(max_em / 0.47))):
                    out.append(w[i:i + max(1, int(max_em / 0.47))])
                continue
            candidate = (line + " " + w) if line else w
            if _line_width_em(candidate) <= max_em:
                line = candidate
            else:
                out.append(line)
                line = w
        out.append(line)
    return out


def _split_blocks(snapshot: str) -> List[Tuple[str, str]]:
    """Split Markdown into ``(style, text)`` items: part/chapter/section
    (headings) and paragraph (consecutive non-blank lines joined per the
    Markdown soft-wrap convention)."""
    out: List[Tuple[str, str]] = []
    para: List[str] = []

    def flush() -> None:
        if para:
            out.append(("paragraph", " ".join(para)))
            para.clear()

    for raw in snapshot.split("\n"):
        line = raw.rstrip()
        m = _HEADING_RE.match(line)
        if m:
            flush()
            level = min(len(m.group(1)), 3)  # 1=part, 2=chapter, 3+=section
            style = {1: "part", 2: "chapter", 3: "section"}[level]
            out.append((style, m.group(2).strip()))
        elif line.strip() == "":
            flush()
        else:
            para.append(line.strip())
    flush()
    return out


def layout_lines(snapshot: str, s: ProseSettings) -> List[LayoutLine]:
    """Turn a Markdown snapshot into ordered layout lines."""
    lines: List[LayoutLine] = []
    for style, text in _split_blocks(snapshot):
        if not text:
            continue
        size = s.size_for(style)
        bold = style in ("part", "chapter", "section")
        em_budget = s.column_width / size
        wrapped = _wrap(text, em_budget)
        for i, w in enumerate(wrapped):
            lines.append((w, style, size, bold, i == 0 and style in ("part", "chapter")))
    return lines


def paginate(lines: List[LayoutLine], s: ProseSettings) -> List[List[LayoutLine]]:
    """Paginate with a page break before every part/chapter heading."""
    cap = s.lines_per_page
    pages: List[List[LayoutLine]] = []
    cur: List[LayoutLine] = []
    for ln in lines:
        if ln[4]:  # break_before
            if cur:
                pages.append(cur)
                cur = []
        if len(cur) >= cap:
            pages.append(cur)
            cur = []
        cur.append(ln)
    if cur:
        pages.append(cur)
    return pages or [[]]


def render_pages(snapshot: str, s: ProseSettings) -> List[List[str]]:
    """Text of every page, for inspection."""
    return [[ln[0] for ln in page] for page in paginate(layout_lines(snapshot, s), s)]


def _pdf_escape(text: str) -> str:
    return (text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)"))


def render_pdf(snapshot: str, s: ProseSettings) -> Tuple[bytes, int]:
    """Render the snapshot to PDF bytes. Returns ``(pdf_bytes, page_count)``."""
    try:
        pages = paginate(layout_lines(snapshot, s), s)
    except Exception as exc:  # pragma: no cover - defensive
        raise ProseRendererError(f"layout failed: {exc}") from exc

    content_streams: List[bytes] = []
    for page in pages:
        parts: List[str] = ["BT"]
        y = s.text_top
        for (text, style, size, bold, _break) in page:
            if text != "":
                font = "/F2" if bold else "/F1"
                w = _line_width_em(text) * size  # points
                if style == "part":
                    tx = (s.page_width - w) / 2.0  # centered part title
                else:
                    tx = s.text_left
                parts.append(f"{font} {size:g} Tf")
                parts.append(f"1 0 0 1 {tx:.2f} {y:.2f} Tm")
                parts.append(f"({_pdf_escape(text)}) Tj")
            y -= s.body_leading
            if text != "" and style in ("part", "chapter", "section"):
                y -= s.heading_gap
        parts.append("ET")
        content_streams.append(("\n".join(parts)).encode("latin-1", "replace"))

    n = len(pages)
    page_obj_nums = [6 + 2 * i for i in range(n)]
    content_obj_nums = [7 + 2 * i for i in range(n)]

    objects: dict = {}
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[2] = (
        b"<< /Type /Pages /Kids ["
        + b" ".join(f"{num} 0 R".encode() for num in page_obj_nums)
        + b"] /Count " + str(n).encode() + b" >>"
    )
    objects[3] = (
        b"<< /Producer (Hermes Prose Renderer "
        + s.config_version.encode("latin-1")
        + b") /Title (Prose) >>"
    )
    objects[4] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>"
    objects[5] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>"

    for i in range(n):
        pnum, cnum = page_obj_nums[i], content_obj_nums[i]
        objects[pnum] = (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "
            + f"{s.page_width:g} {s.page_height:g}".encode()
            + b"] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents "
            + f"{cnum} 0 R".encode() + b" >>"
        )
        stream = content_streams[i]
        objects[cnum] = (
            b"<< /Length " + str(len(stream)).encode()
            + b" >>\nstream\n" + stream + b"\nendstream"
        )

    buf = bytearray()
    buf += b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    offsets: dict = {}
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
        buf += f"{offsets[num]:010d} 0000 n \n".encode()
    buf += b"trailer\n"
    buf += f"<< /Size {total} /Root 1 0 R /Info 3 0 R >>\n".encode()
    buf += b"startxref\n"
    buf += f"{xref_pos}\n".encode()
    buf += b"%%EOF\n"
    return bytes(buf), n
