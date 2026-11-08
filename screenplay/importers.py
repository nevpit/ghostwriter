"""Multi-format screenplay import.

Turns an uploaded file (Fountain, plain text, Final Draft ``.fdx`` XML, or a
screenplay ``.pdf``) into Fountain source so the rest of the service can treat
every import uniformly. Detection is by extension + content sniffing; conversion
is deterministic for Fountain/text/FDX and best-effort for PDF (text extraction
+ heuristic re-structuring).

The service stores the *converted Fountain* as the revision snapshot, so a
project imported from FDX/PDF is still a first-class Fountain document that can
be exported back out to Fountain for other software.
"""

from __future__ import annotations

import re
import zlib
import xml.etree.ElementTree as ET
from typing import List

import base64  # noqa: F401  (kept for callers that want to decode before calling)


class ImportFormatError(Exception):
    """Raised when a file cannot be recognized/converted."""


# --- Format detection ------------------------------------------------------

def detect_format(filename: str, content: bytes) -> str:
    """Return one of ``fountain | text | fdx | pdf | unknown``."""
    name = (filename or "").lower()
    head = content[:8]
    if name.endswith(".pdf") or head.startswith(b"%PDF-"):
        return "pdf"
    if name.endswith(".fdx"):
        return "fdx"
    if name.endswith(".xml"):
        low = content[:4000].decode("utf-8", "replace").lower()
        if "finaldraft" in low or "<scene" in low:
            return "fdx"
        return "text"
    if name.endswith(".fountain"):
        return "fountain"
    if name.endswith((".txt", ".text", ".md")):
        return "text"
    # No extension: sniff the content.
    if head.startswith(b"%PDF-"):
        return "pdf"
    try:
        low = content[:4000].decode("utf-8", "replace").lower()
    except Exception:
        return "unknown"
    if low.lstrip().startswith("<?xml") and ("finaldraft" in low or "<scene" in low):
        return "fdx"
    return "fountain"


def to_fountain(filename: str, content: bytes) -> str:
    """Detect the format of ``content`` (named ``filename``) and return
    Fountain source. Raises :class:`ImportFormatError` if unsupported."""
    fmt = detect_format(filename, content)
    if fmt in ("fountain", "text"):
        return content.decode("utf-8", "replace")
    if fmt == "fdx":
        return fdx_to_fountain(content.decode("utf-8", "replace"))
    if fmt == "pdf":
        return pdf_to_fountain(content)
    raise ImportFormatError(f"unrecognized screenplay format: {filename or '<file>'}")


# --- Final Draft FDX (XML) -------------------------------------------------

def _local(tag) -> str:
    if isinstance(tag, str):
        return tag.rsplit("}", 1)[-1]
    return ""


def _desc_text(el) -> str:
    """Join every ``<text>`` descendant's content in document order."""
    parts: List[str] = []
    for node in el.iter():
        if _local(node.tag) == "text" and (node.text or "").strip():
            parts.append(node.text.strip())
    return "\n".join(parts)


def _find_child(parent, name: str):
    """Return the first direct child of ``parent`` with local tag ``name``."""
    for c in parent:
        if _local(c.tag) == name:
            return c
    return None


def _find_text(parent, name: str) -> str:
    for node in parent.iter():
        if _local(node.tag) == name:
            t = _desc_text(node)
            if t.strip():
                return t
            if (node.text or "").strip():
                return node.text.strip()
    return ""


def fdx_to_fountain(xml_text: str) -> str:
    """Convert a Final Draft ``.fdx`` XML document to Fountain source."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise ImportFormatError(f"invalid FDX XML: {exc}") from exc

    out: List[str] = []
    title = _find_text(root, "main_title")
    credit = _find_text(root, "credit")
    if title:
        out.append(f"Title: {title}")
    if credit:
        out.append(f"Credit: {credit}")
    if out:
        out.append("")

    # Prefer explicit <scene> structure; otherwise walk top-level containers.
    scenes = root.findall(".//scene")
    if not scenes:
        # No <scene> wrappers: treat each recognized container as its own block.
        scenes = [root]

    for scene in scenes:
        heading = _find_text(scene, "scene_heading")
        if heading:
            out.append(heading.strip().upper())
            out.append("")
        for child in scene:
            tag = _local(child.tag)
            if tag == "scene_heading":
                continue
            if tag == "action":
                txt = _desc_text(child).strip()
                if txt:
                    out.append(txt)
                    out.append("")
            elif tag == "character":
                name = _find_text(child, "name").strip()
                if not name:
                    continue
                out.append(name.upper())
                paren = _find_text(child, "parenthetical").strip()
                if paren:
                    out.append(f"({paren})")
                # Dialogue: a <dialogue> element if present, otherwise the
                # character's own <line> children (the real FDX structure).
                dlg_el = _find_child(child, "dialogue")
                if dlg_el is not None:
                    dlg = _desc_text(dlg_el).strip()
                else:
                    dlg = " ".join(
                        t for t in (_desc_text(ln).strip() for ln in child
                                    if _local(ln.tag) == "line") if t)
                if dlg:
                    out.append(dlg)
                out.append("")
            elif tag == "transition":
                txt = _desc_text(child).strip()
                if txt:
                    out.append(txt.upper())
                    out.append("")

    return "\n".join(out)


# --- PDF (best-effort) -----------------------------------------------------

_PDF_STR_RE = re.compile(rb"\((?:\\.|[^\\()])*\)")


def _pdf_unescape(b: bytes) -> str:
    out = bytearray()
    i = 0
    while i < len(b):
        c = b[i:i + 1]
        if c == b"\\" and i + 1 < len(b):
            n = b[i + 1:i + 2]
            if n == b"n":
                out += b"\n"
            elif n == b"r":
                out += b"\r"
            elif n == b"t":
                out += b"\t"
            elif n in (b"(", b")", b"\\"):
                out += n
            elif n.isdigit():
                j = i + 1
                digits = b""
                while j < len(b) and b[j:j + 1].isdigit() and len(digits) < 3:
                    digits += b[j:j + 1]
                    j += 1
                if digits:
                    out.append(int(digits, 8))
                i = j
                continue
            else:
                out += n
            i += 2
            continue
        out += c
        i += 1
    return out.decode("latin-1", "replace")


def _decode_pdf_stream(raw: bytes) -> str:
    blob = raw
    if raw[:2] in (b"\x78\x9c", b"\x78\x01", b"\x78\xda"):
        try:
            blob = zlib.decompress(raw)
        except Exception:
            try:
                blob = zlib.decompress(raw, -15)
            except Exception:
                return ""
    if b"Tj" not in blob and b"TJ" not in blob:
        return ""
    pieces = [_pdf_unescape(m.group(0)[1:-1]) for m in _PDF_STR_RE.finditer(blob)]
    return "\n".join(p for p in pieces if p)


def _pdf_extract_text(pdf_bytes: bytes) -> str:
    data = pdf_bytes
    idx = 0
    out: List[str] = []
    while True:
        s = data.find(b"stream", idx)
        if s == -1:
            break
        p = s + 6
        if data[p:p + 2] == b"\r\n":
            p += 2
        elif data[p:p + 1] in (b"\n", b"\r"):
            p += 1
        e = data.find(b"endstream", p)
        if e == -1:
            break
        txt = _decode_pdf_stream(data[p:e])
        if txt:
            out.append(txt)
        idx = e + 9
    return "\n".join(out)


_TRANSITION_RE = re.compile(
    r"^(CUT TO|FADE (IN|OUT|TO)|SMASH CUT|DISSOLVE TO|MATCH CUT|JUMP CUT)"
    r"[.\s]*$", re.I)
_SCENE_START_RE = re.compile(r"^(INT\.|EXT\.|INT/EXT|I/E|EST\.|E/S|INT-EXT)\b", re.I)


def _looks_like_character(s: str) -> bool:
    if not s or len(s) > 30:
        return False
    letters = sum(c.isalpha() for c in s)
    return letters > 0 and (letters / len(s)) >= 0.8 and s.isupper()


def _heuristic_to_fountain(text: str) -> str:
    """Re-structure raw extracted PDF lines into Fountain.

    Best-effort: scene headings (INT./EXT.) open new scenes; all-caps short
    lines are character cues; parenthesized lines are parentheticals;
    transitions are detected; everything else is action/dialogue text."""
    out: List[str] = []
    for raw in text.split("\n"):
        s = raw.strip()
        if not s:
            continue
        if _SCENE_START_RE.match(s):
            out.append(s.upper())
            out.append("")
        elif _TRANSITION_RE.match(s):
            out.append(s.upper())
            out.append("")
        elif re.match(r"^\(.*\)$", s):
            out.append(s)
        elif _looks_like_character(s):
            out.append(s.upper())
        else:
            out.append(s)
    if not out:
        raise ImportFormatError("PDF had no extractable text")
    return "\n".join(out) + "\n"


def pdf_to_fountain(pdf_bytes: bytes) -> str:
    """Best-effort: extract text from a screenplay PDF and infer Fountain."""
    text = _pdf_extract_text(pdf_bytes)
    if not text.strip():
        raise ImportFormatError("could not extract text from PDF (no text layer)")
    return _heuristic_to_fountain(text)
