"""Screenplay file conversion: import (Fountain / text / Final Draft / PDF) and
Final Draft export.

Every import is converted to Fountain, so a project imported from FDX or PDF is
a first-class Fountain document. Conversion is deterministic for Fountain,
text and FDX, and best-effort for PDF (text extraction using each line's
horizontal position to recover the screenplay columns).
"""

from __future__ import annotations

import re
import zlib
import xml.etree.ElementTree as ET
from collections import Counter
from typing import List, Optional, Tuple
from xml.sax.saxutils import escape as _xml_escape, quoteattr as _xml_attr

from . import fountain


class ImportFormatError(Exception):
    """Raised when a file cannot be recognized/converted."""


# --- Format detection ------------------------------------------------------

def detect_format(filename: str, content: bytes) -> str:
    """Return one of ``fountain | text | fdx | pdf``."""
    name = (filename or "").lower()
    head = content[:1024]
    if name.endswith(".pdf") or head.startswith(b"%PDF-"):
        return "pdf"
    if name.endswith(".fdx"):
        return "fdx"
    low = content[:4000].decode("utf-8", "replace").lower()
    if name.endswith(".xml") or low.lstrip().startswith("<?xml") or low.lstrip().startswith("<finaldraft"):
        return "fdx" if "finaldraft" in low else "text"
    if name.endswith((".txt", ".text", ".md")):
        return "text"
    return "fountain"


def _decode_text(content: bytes) -> str:
    if content.startswith(b"\xef\xbb\xbf"):
        content = content[3:]
    for enc in ("utf-8", "cp1252"):
        try:
            return content.decode(enc)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", "replace")


def to_fountain(filename: str, content: bytes) -> str:
    """Detect the format of ``content`` and return Fountain source."""
    fmt = detect_format(filename, content)
    if fmt in ("fountain", "text"):
        return _decode_text(content).replace("\r\n", "\n")
    if fmt == "fdx":
        return fdx_to_fountain(_decode_text(content))
    return pdf_to_fountain(content)


# --- Safe Fountain emission --------------------------------------------------

class _Writer:
    """Accumulates Fountain, escaping lines that would otherwise be parsed as
    a different element type."""

    def __init__(self):
        self.out: List[str] = []

    def block(self, *lines: str) -> None:
        if self.out and self.out[-1] != "":
            self.out.append("")
        self.out.extend(lines)

    def heading(self, text: str) -> None:
        text = " ".join(text.split())
        if not text:
            return
        self.block(text if fountain.is_scene_heading(text) else "." + text)

    def action(self, text: str) -> None:
        text = text.strip("\n")
        if not text.strip():
            return
        first = text.split("\n", 1)[0].strip()
        if fountain.is_scene_heading(first) or fountain._is_upper(first) or \
                first.startswith(("@", "~", ">", "=", "#", ".", "!")):
            text = "!" + text
        self.block(text)

    def transition(self, text: str) -> None:
        text = " ".join(text.split()).upper()
        if not text:
            return
        ok = text in fountain.KNOWN_TRANSITIONS or text.endswith("TO:")
        self.block(text if ok else ">" + text)

    def speech(self, cue: str, parts: List[Tuple[str, str]], dual: bool = False) -> None:
        cue = " ".join(cue.split())
        if not cue:
            return
        name = fountain.parse_cue(cue)["speaker"]
        if not fountain._is_upper(name):
            cue = "@" + cue
        lines = [cue + (" ^" if dual else "")]
        for kind, text in parts:
            text = text.strip()
            if not text:
                continue
            if kind == "paren":
                lines.append(text if text.startswith("(") else f"({text})")
            else:
                lines.extend(ln.strip() or "  " for ln in text.split("\n"))
        if len(lines) == 1:
            lines.append("...")
        self.block(*lines)

    def text(self) -> str:
        while self.out and self.out[-1] == "":
            self.out.pop()
        return "\n".join(self.out) + ("\n" if self.out else "")


# --- Final Draft FDX -------------------------------------------------------

def _local(tag) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _para_text(p) -> str:
    """Text of an FDX ``<Paragraph>``, with emphasis as Fountain markup."""
    parts = []
    for t in p:
        if _local(t.tag) != "Text":
            continue
        s = t.text or ""
        style = (t.get("Style") or "").lower()
        if s.strip():
            lead = s[:len(s) - len(s.lstrip())]
            trail = s[len(s.rstrip()):]
            core = s.strip()
            if "bold" in style and "italic" in style:
                core = f"***{core}***"
            elif "bold" in style:
                core = f"**{core}**"
            elif "italic" in style:
                core = f"*{core}*"
            if "underline" in style:
                core = f"_{core}_"
            s = lead + core + trail
        parts.append(s)
    return "".join(parts).replace("\r", "")


def _iter_paragraphs(content) -> List[Tuple[str, str, bool]]:
    """Flatten ``<Content>`` into ``(type, text, dual)``; paragraphs inside a
    ``<DualDialogue>`` mark the second speaker as dual."""
    out = []
    for p in content:
        if _local(p.tag) != "Paragraph":
            continue
        dd = next((c for c in p if _local(c.tag) == "DualDialogue"), None)
        if dd is not None:
            cues = 0
            for q in dd:
                if _local(q.tag) != "Paragraph":
                    continue
                typ = q.get("Type", "")
                if typ == "Character":
                    cues += 1
                out.append((typ, _para_text(q), typ == "Character" and cues == 2))
            continue
        out.append((p.get("Type", "General"), _para_text(p), False))
    return out


def _title_page_from_fdx(root) -> dict:
    tp = next((c for c in root if _local(c.tag) == "TitlePage"), None)
    if tp is None:
        return {}
    content = next((c for c in tp if _local(c.tag) == "Content"), None)
    if content is None:
        return {}
    centered, other = [], []
    for p in content:
        if _local(p.tag) != "Paragraph":
            continue
        t = _para_text(p).strip()
        if not t:
            continue
        (centered if (p.get("Alignment") or "").lower() == "center" else other).append(t)
    fields: dict = {}
    if centered:
        fields["Title"] = centered[0]
        rest = centered[1:]
        for i, t in enumerate(rest):
            if re.search(r"\bby\b", t, re.I) and "Credit" not in fields:
                fields["Credit"] = t
                if i + 1 < len(rest):
                    fields["Author"] = rest[i + 1]
                break
    if other:
        fields["Contact"] = "\n".join(other)
    return fields


def fdx_to_fountain(xml_text: str) -> str:
    """Convert a Final Draft ``.fdx`` document to Fountain."""
    try:
        root = ET.fromstring(xml_text.encode("utf-8") if isinstance(xml_text, str) else xml_text)
    except ET.ParseError as exc:
        raise ImportFormatError(f"invalid FDX XML: {exc}") from exc
    content = next((c for c in root if _local(c.tag) == "Content"), None)
    if content is None:
        raise ImportFormatError("not a Final Draft document (no <Content>)")

    w = _Writer()
    tp = _title_page_from_fdx(root)
    if tp:
        w.out.extend(fountain.build_title_page(tp).split("\n"))
    paras = _iter_paragraphs(content)
    i = 0
    while i < len(paras):
        typ, text, dual = paras[i]
        t = typ.lower()
        if t == "scene heading":
            w.heading(text)
        elif t == "character":
            parts = []
            j = i + 1
            while j < len(paras) and paras[j][0].lower() in ("dialogue", "parenthetical"):
                parts.append(("paren" if paras[j][0].lower() == "parenthetical" else "dialogue",
                              paras[j][1]))
                j += 1
            w.speech(text, parts, dual=dual)
            i = j
            continue
        elif t in ("dialogue", "parenthetical"):
            w.action(text)  # orphaned speech text: keep it, as action
        elif t == "transition":
            w.transition(text)
        elif t in ("cast list",):
            pass
        else:  # Action, General, Shot, ...
            w.action(text)
        i += 1
    return w.text()


_FDX_TYPES = {
    "scene_heading": "Scene Heading", "action": "Action", "character": "Character",
    "parenthetical": "Parenthetical", "dialogue": "Dialogue", "transition": "Transition",
    "centered": "Action", "lyric": "Dialogue",
}


def _fdx_runs(text: str) -> str:
    from .rendering import styled, B, I, U  # local import: avoid a cycle at load
    plain, flags = styled(text)
    out, i = [], 0
    while i < len(plain):
        j = i
        while j < len(plain) and flags[j] == flags[i]:
            j += 1
        st = [name for bit, name in ((B, "Bold"), (I, "Italic"), (U, "Underline")) if flags[i] & bit]
        attr = f" Style={_xml_attr('+'.join(st))}" if st else ""
        out.append(f"<Text{attr}>{_xml_escape(plain[i:j])}</Text>")
        i = j
    return "".join(out) or "<Text></Text>"


def fountain_to_fdx(snapshot: str) -> str:
    """Serialize a Fountain snapshot to a Final Draft ``.fdx`` document."""
    doc = fountain.parse_document(snapshot)
    paras: List[str] = []

    def para(typ: str, text: str, extra: str = "") -> str:
        return f'    <Paragraph Type="{typ}"{extra}>{_fdx_runs(text)}</Paragraph>'

    els = [e for e in doc.elements if e["kind"] in _FDX_TYPES]
    i = 0
    while i < len(els):
        e = els[i]
        k = e["kind"]
        if k == "character":
            j = i + 1
            while j < len(els) and els[j]["kind"] in ("parenthetical", "dialogue"):
                j += 1
            group = els[i:j]
            if j < len(els) and els[j]["kind"] == "character" and els[j].get("dual"):
                m = j + 1
                while m < len(els) and els[m]["kind"] in ("parenthetical", "dialogue"):
                    m += 1
                inner = [para(_FDX_TYPES[x["kind"]], _cue(x) if x["kind"] == "character" else x["text"])
                         for x in group + els[j:m]]
                paras.append("    <Paragraph><DualDialogue>\n" + "\n".join("  " + s for s in inner)
                             + "\n    </DualDialogue></Paragraph>")
                i = m
                continue
            for x in group:
                paras.append(para(_FDX_TYPES[x["kind"]], _cue(x) if x["kind"] == "character" else x["text"]))
            i = j
            continue
        if k == "scene_heading":
            num = e.get("scene_number")
            paras.append(para("Scene Heading", e.get("heading") or e["text"],
                              f" Number={_xml_attr(num)}" if num else ""))
        elif k == "centered":
            paras.append(para("Action", e["text"], ' Alignment="Center"'))
        else:
            paras.append(para(_FDX_TYPES[k], e["text"]))
        i += 1

    tp = fountain.title_fields(doc.title_page)
    low = {k.lower(): v for k, v in tp.items()}
    tparas: List[str] = []

    def tpara(text: str, align: str) -> None:
        for line in str(text).split("\n"):
            tparas.append(f'      <Paragraph Alignment="{align}">{_fdx_runs(line)}</Paragraph>')

    if low.get("title"):
        tpara(low["title"], "Center")
    credit = low.get("credit") or ("Written by" if (low.get("author") or low.get("authors")) else "")
    if credit:
        tpara(credit, "Center")
    if low.get("author") or low.get("authors"):
        tpara(low.get("author") or low.get("authors"), "Center")
    if low.get("source"):
        tpara(low["source"], "Center")
    for key in ("contact", "draft date", "copyright"):
        if low.get(key):
            tpara(low[key], "Left")

    return ('<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n'
            '<FinalDraft DocumentType="Script" Template="No" Version="5">\n'
            '  <Content>\n' + "\n".join(paras) + "\n  </Content>\n"
            + ("  <TitlePage>\n    <Content>\n" + "\n".join(tparas) + "\n    </Content>\n  </TitlePage>\n"
               if tparas else "")
            + "</FinalDraft>\n")


def _cue(el: dict) -> str:
    t = el["text"].strip()
    if t.startswith("@"):
        t = t[1:].strip()
    return t[:-1].rstrip() if t.endswith("^") else t


# --- PDF (best-effort, position-aware) --------------------------------------

_TOKEN_RE = re.compile(
    rb"\((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*\)"   # literal string (1 level nesting)
    rb"|<[0-9A-Fa-f\s]*>"                           # hex string
    rb"|\[|\]"                                       # array delimiters
    rb"|/[^\s/\[\]()<>{}%]+"                         # name
    rb"|[-+]?(?:\d+\.?\d*|\.\d+)"                    # number
    rb"|[A-Za-z'\"*]+[0-9]*")                        # operator


def _pdf_unescape(b: bytes) -> bytes:
    out = bytearray()
    i = 0
    simple = {b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"\b", b"f": b"\f"}
    while i < len(b):
        c = b[i:i + 1]
        if c == b"\\" and i + 1 < len(b):
            n = b[i + 1:i + 2]
            if n in simple:
                out += simple[n]; i += 2
            elif n.isdigit():
                j = i + 1
                while j < len(b) and j < i + 4 and b[j:j + 1].isdigit():
                    j += 1
                out.append(int(b[i + 1:j], 8) & 0xFF); i = j
            elif n in (b"\n", b"\r"):
                i += 2
            else:
                out += n; i += 2
            continue
        out += c
        i += 1
    return bytes(out)


def _string_bytes(tok: bytes) -> bytes:
    if tok.startswith(b"("):
        return _pdf_unescape(tok[1:-1])
    hexs = re.sub(rb"\s", b"", tok[1:-1])
    if len(hexs) % 2:
        hexs += b"0"
    try:
        return bytes.fromhex(hexs.decode())
    except ValueError:
        return b""


def _decode_pdf_bytes(b: bytes) -> str:
    if b.startswith(b"\xfe\xff"):
        return b[2:].decode("utf-16-be", "replace")
    return b.decode("cp1252", "replace")


def _text_runs(stream: bytes) -> List[Tuple[float, float, str]]:
    """Extract ``(x, y, text)`` runs from a content stream."""
    runs: List[Tuple[float, float, str]] = []
    stack: list = []
    in_array: Optional[list] = None
    lx = ly = x = y = 0.0
    leading = 12.0
    for m in _TOKEN_RE.finditer(stream):
        tok = m.group(0)
        if tok.startswith((b"(", b"<")) and not tok.startswith(b"<<"):
            s = _string_bytes(tok)
            (in_array if in_array is not None else stack).append(s)
            continue
        if tok == b"[":
            in_array = []
            continue
        if tok == b"]":
            stack.append(in_array or [])
            in_array = None
            continue
        if in_array is not None:
            try:
                in_array.append(float(tok))
            except ValueError:
                pass
            continue
        if tok[:1] == b"/" or re.match(rb"^[-+.\d]", tok):
            try:
                stack.append(float(tok))
            except ValueError:
                stack.append(tok)
            continue
        op = tok
        nums = [v for v in stack if isinstance(v, float)]
        if op == b"BT":
            lx = ly = x = y = 0.0
        elif op == b"Tm" and len(nums) >= 6:
            lx, ly = nums[-2], nums[-1]
            x, y = lx, ly
        elif op in (b"Td", b"TD") and len(nums) >= 2:
            lx += nums[-2]; ly += nums[-1]
            x, y = lx, ly
            if op == b"TD":
                leading = -nums[-1]
        elif op == b"TL" and nums:
            leading = nums[-1]
        elif op == b"T*":
            ly -= leading; x, y = lx, ly
        elif op in (b"Tj", b"'", b'"'):
            if op != b"Tj":
                ly -= leading; x, y = lx, ly
            strs = [v for v in stack if isinstance(v, bytes)]
            if strs:
                runs.append((x, y, _decode_pdf_bytes(strs[-1])))
        elif op == b"TJ":
            arr = next((v for v in reversed(stack) if isinstance(v, list)), [])
            text = ""
            for part in arr:
                if isinstance(part, bytes):
                    text += _decode_pdf_bytes(part)
                elif isinstance(part, float) and part < -200:
                    text += " "
            runs.append((x, y, text))
        stack = []
    return runs


def _streams(pdf_bytes: bytes) -> List[bytes]:
    out = []
    for m in re.finditer(rb"(?<!end)stream\r?\n", pdf_bytes):
        p = m.end()
        e = pdf_bytes.find(b"endstream", p)
        if e == -1:
            break
        raw = pdf_bytes[p:e].rstrip(b"\r\n")
        dict_start = pdf_bytes.rfind(b"<<", 0, m.start())
        header = pdf_bytes[dict_start:m.start()] if dict_start != -1 else b""
        if b"FlateDecode" in header or raw[:1] == b"\x78":
            try:
                raw = zlib.decompress(raw)
            except zlib.error:
                try:
                    raw = zlib.decompressobj().decompress(raw)
                except zlib.error:
                    continue
        if b"BT" in raw and (b"Tj" in raw or b"TJ" in raw):
            out.append(raw)
    return out


def _page_lines(runs) -> List[Tuple[float, float, str]]:
    """Merge runs into ``(x, y, text)`` lines (top to bottom)."""
    rows: dict = {}
    for x, y, t in runs:
        if not t.strip():
            continue
        rows.setdefault(round(y), []).append((x, t))
    lines = []
    for y in sorted(rows, reverse=True):
        parts = sorted(rows[y])
        text = ""
        for x, t in parts:
            text = (text + " " + t) if text and not text.endswith(" ") and not t.startswith(" ") else text + t
        lines.append((parts[0][0], float(y), " ".join(text.split())))
    return lines


def pdf_to_fountain(pdf_bytes: bytes) -> str:
    """Best-effort: recover a screenplay from a PDF's text layer."""
    pages = [_page_lines(_text_runs(s)) for s in _streams(pdf_bytes)]
    pages = [p for p in pages if p]
    if not pages:
        raise ImportFormatError("could not extract text from PDF (no text layer, or an "
                                "unsupported font encoding)")
    xs = Counter(round(x) for p in pages for x, _y, _t in p)
    left = min((x for x, c in xs.items() if c >= max(2, xs.most_common(1)[0][1] // 10)),
               default=min(xs))

    w = _Writer()
    # Title page: a first page without any scene heading.
    first_has_heading = any(fountain.is_scene_heading(t) for _x, _y, t in pages[0])
    if len(pages) > 1 and not first_has_heading:
        texts = [t for _x, _y, t in pages[0]]
        fields = {"Title": texts[0]}
        for i, t in enumerate(texts[1:], 1):
            if re.search(r"\bby\b", t, re.I):
                fields["Credit"] = t
                if i + 1 < len(texts):
                    fields["Author"] = texts[i + 1]
                break
        w.out.extend(fountain.build_title_page(fields).split("\n"))
        pages = pages[1:]

    cue: Optional[str] = None
    parts: List[Tuple[str, str]] = []
    action: List[str] = []
    prev_y: Optional[float] = None

    def flush_speech():
        nonlocal cue, parts
        if cue is not None:
            w.speech(cue, parts)
        cue, parts = None, []

    def flush_action():
        nonlocal action
        if action:
            w.action(" ".join(action))
        action = []

    for page in pages:
        prev_y = None
        for x, y, t in page:
            off = x - left
            if re.fullmatch(r"\d+\.?", t) or t.upper() in ("(MORE)", "(CONTINUED)", "CONTINUED:"):
                continue
            gap = (prev_y - y) if prev_y is not None else 0
            prev_y = y
            upper = fountain._is_upper(t)
            if off < 30 and fountain.is_scene_heading(t):
                flush_speech(); flush_action(); w.heading(t)
            elif upper and (t.endswith("TO:") or t in fountain.KNOWN_TRANSITIONS) and (off > 200 or off < 30):
                flush_speech(); flush_action(); w.transition(t)
            elif off >= 140 and upper:
                flush_speech(); flush_action()
                cue = re.sub(r"\s*\(CONT['’]D\)\s*$", "", t)
            elif cue is not None and 90 <= off < 140 and t.startswith("("):
                parts.append(("paren", t))
            elif cue is not None and 40 <= off < 140:
                if parts and parts[-1][0] == "dialogue" and gap < 20:
                    parts[-1] = ("dialogue", parts[-1][1] + " " + t)
                else:
                    parts.append(("dialogue", t))
            else:
                flush_speech()
                if action and gap > 18:
                    flush_action()
                action.append(t)
        # Speeches and paragraphs may continue onto the next page.
    flush_speech(); flush_action()
    out = w.text()
    if not out.strip():
        raise ImportFormatError("PDF had no extractable text")
    return out
