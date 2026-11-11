"""Multi-format import: detection + conversion (Fountain / text / FDX / PDF).

The FDX path is deterministic (industry-standard XML); the PDF path is
best-effort (text extraction + heuristic re-structuring), so its tests assert
that the key structural lines (scene headings, a character, a dialogue line)
survive a render->extract round trip rather than byte-exactness.
"""
import _bootstrap as B
from pathlib import Path

from screenplay import importers

FIXTURES = Path(B.__file__).resolve().parent / "fixtures"
SAMPLE_FDX = (FIXTURES / "sample.fdx").read_text(encoding="utf-8")


def test_detect_format_by_extension_and_sniff():
    assert importers.detect_format("a.fountain", b"") == "fountain"
    assert importers.detect_format("a.txt", b"") == "text"
    assert importers.detect_format("a.fdx", b"") == "fdx"
    assert importers.detect_format("a.pdf", b"") == "pdf"
    # Content sniffing beats a missing/misleading extension.
    assert importers.detect_format("script.bin", b"%PDF-1.4\n") == "pdf"
    assert importers.detect_format("script.bin",
                                   b"<?xml version=\"1.0\"?><FinalDraft><Content>") == "fdx"
    assert importers.detect_format("script.bin", b"INT. ROOM - NIGHT\n") == "fountain"


def test_to_fountain_passthrough():
    txt = "Title: X\n\nINT. ROOM - NIGHT\n\nAction line.\n"
    assert importers.to_fountain("x.fountain", txt.encode()) == txt
    assert importers.to_fountain("x.txt", txt.encode()) == txt


def test_fdx_to_fountain_structure():
    f = importers.fdx_to_fountain(SAMPLE_FDX)
    assert "Title: The Harbor Light" in f
    assert "Credit: Written by" in f and "Author: Jane Doe" in f
    assert "INT. ROOM 1 - NIGHT" in f
    assert "EXT. ROOM 2 - DAY" in f
    # Character cue + parenthetical + dialogue land on their own lines.
    assert "LENA" in f
    assert "(whispering)" in f
    assert "I can't believe you're here." in f
    assert "MAX" in f
    assert "We need to talk." in f
    # Transitions are preserved.
    assert "CUT TO:" in f
    # The converted text must re-parse as a Fountain document with two scenes.
    from screenplay import fountain
    scenes, _problems = fountain.parse(f)
    assert len(scenes) == 2, [s.heading for s in scenes]


def test_importer_roundtrip_via_to_fountain():
    f = importers.to_fountain("sample.fdx", SAMPLE_FDX.encode())
    assert "INT. ROOM 1 - NIGHT" in f


def test_pdf_roundtrip_preserves_structure():
    """Render a known Fountain to PDF, extract the text back, and confirm the
    scene headings + a character + a dialogue line survive (best-effort)."""
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    pdf_bytes = Path(s.export_pdf(p.id).artifact_path).read_bytes()
    back = importers.pdf_to_fountain(pdf_bytes)
    assert "INT. OLD HOUSE - NIGHT" in back
    assert "EXT. OLD HOUSE - NIGHT" in back
    assert "ARTHUR" in back
    assert "The night everything ended." in back


def test_pdf_no_text_layer_raises():
    # A PDF with no extractable text streams must raise, not crash silently.
    try:
        importers.pdf_to_fountain(b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n")
    except importers.ImportFormatError:
        return
    raise AssertionError("expected ImportFormatError for a textless PDF")
