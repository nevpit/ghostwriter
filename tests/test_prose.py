"""Unit tests for the prose (Markdown) engine -- parse, splice, validate,
import, and render -- exercising :class:`ProseEngine` directly."""
import io
import zipfile
import zipfile as _zf
from xml.sax.saxutils import escape

import _bootstrap as B  # noqa: F401  (puts screenplay on sys.path)
from screenplay.formats.prose import ProseEngine, parse, apply_operation, validate, import_
from screenplay import models as M
from screenplay.formats import prose_render as PR

ENG = ProseEngine()

DOC = (
    "# Part One\n"
    "\n"
    "Intro paragraph for the part.\n"
    "\n"
    "## Chapter 1: Start\n"
    "\n"
    "First line.\n"
    "Second line of the same paragraph.\n"
    "\n"
    "Third paragraph.\n"
    "\n"
    "### Section 1a\n"
    "\n"
    "A section under chapter 1.\n"
    "\n"
    "## Chapter 2: End\n"
    "\n"
    "Closing chapter.\n"
)


def test_parse_kinds_and_ids():
    blocks, problems = parse(DOC)
    assert problems == []
    kinds = [b.kind for b in blocks]
    assert kinds == ["part", "chapter", "section", "chapter"], kinds
    ids = [b.id for b in blocks]
    assert ids == ["block-0", "block-1", "block-2", "block-3"], ids
    # nesting: section under chapter 1, chapters under the part
    assert blocks[1].parent_id == "block-0"
    assert blocks[2].parent_id == "block-1"
    assert blocks[3].parent_id == "block-0"


def test_parse_headings_and_elements():
    blocks, _ = parse(DOC)
    assert blocks[0].heading == "Part One"
    assert blocks[1].heading == "Chapter 1: Start"
    # chapter 1's elements: two paragraphs (soft-wrapped line + third para)
    ch1 = blocks[1]
    texts = [e["text"] for e in ch1.elements if e["kind"] == "paragraph"]
    assert "First line. Second line of the same paragraph." in texts
    assert "Third paragraph." in texts
    # offsets slice back to the source text
    assert ch1.text(DOC).startswith("## Chapter 1: Start")


def test_parse_front_matter():
    doc = "Preface text here.\n\n## Chapter 1\n\nBody.\n"
    blocks, _ = parse(doc)
    assert blocks[0].kind == "front"
    assert blocks[0].heading == ""
    assert any("Preface text here." in e["text"] for e in blocks[0].elements)
    assert blocks[1].kind == "chapter"


def test_parse_no_headings_single_front():
    blocks, _ = parse("Just some plain text.\n\nMore text.\n")
    assert len(blocks) == 1
    assert blocks[0].kind == "front"
    assert len(blocks[0].elements) == 2


def test_parse_empty():
    blocks, _ = parse("")
    assert blocks == []


def test_apply_insert_before():
    blocks, _ = parse(DOC)
    op = M.Operation(type="insert", before_scene_id="block-2",
                     heading="Chapter 1.5: Middle",
                     content="A brand-new chapter.")
    new_snap, new_blocks = apply_operation(DOC, blocks, op, None)
    headings = [b.heading for b in new_blocks]
    assert "Chapter 1.5: Middle" in headings
    # it lands before the old block-2 (Section 1a)
    assert headings.index("Chapter 1.5: Middle") < headings.index("Section 1a")
    # the new snapshot re-parses to the same block count
    assert len(new_blocks) == len(parse(new_snap)[0])


def test_apply_replace():
    blocks, _ = parse(DOC)
    op = M.Operation(type="replace", scene_id="block-1",
                     heading="Chapter 1: Rewritten", content="New body text.")
    new_snap, new_blocks = apply_operation(DOC, blocks, op, None)
    headings = [b.heading for b in new_blocks]
    assert "Chapter 1: Rewritten" in headings
    assert "Chapter 1: Start" not in headings
    # block count preserved (replace does not add/remove blocks)
    assert len(new_blocks) == len(blocks)


def test_apply_insert_unknown_target_raises():
    blocks, _ = parse(DOC)
    op = M.Operation(type="insert", before_scene_id="block-99",
                     heading="X", content="y")
    try:
        apply_operation(DOC, blocks, op, None)
        assert False, "expected ServiceError"
    except M.ServiceError as e:
        assert e.code == M.ERR_SCENE_NOT_FOUND


def test_validate_defaults_all_pass():
    blocks, problems = parse(DOC)
    checks = validate(blocks, DOC, problems, M.RulesVersion(id="r", project_id="p"), None)
    by_name = {c.name: c for c in checks}
    assert by_name["PARSE"].status == M.PASS
    assert all(c.status == M.PASS for c in checks), checks


def test_validate_limits_fail():
    blocks, problems = parse(DOC)  # 1 part, 2 chapters
    rules = M.RulesVersion(id="r", project_id="p",
                           limits={"min_chapters": 5, "min_parts": 3})
    checks = validate(blocks, DOC, problems, rules, None)
    by_name = {c.name: c for c in checks}
    assert by_name["CHAPTER_COUNT"].status == M.FAIL
    assert by_name["PART_COUNT"].status == M.FAIL
    assert by_name["WORD_COUNT"].status == M.PASS  # no max_words set


def test_validate_no_rules_parse_only():
    blocks, problems = parse(DOC)
    checks = validate(blocks, DOC, problems, None, None)
    assert [c.name for c in checks] == ["PARSE"]


def test_import_normalizes_markdown():
    raw = "Title line\r\n\r\n\r\n## Ch\r\nBody.   \r\n"
    out = import_("book.md", raw.encode("utf-8"))
    assert "\r" not in out
    assert "\n\n\n" not in out
    assert out.endswith("\n")
    assert "## Ch" in out


def _make_docx(paragraphs):
    """Build a minimal .docx (OOXML zip) from (style, text) paragraphs."""
    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    body = "".join(
        f'<w:p>{("<w:pPr><w:pStyle w:val=\"%s\"/></w:pPr>" % style) if style else ""}'
        f'<w:r><w:t>{escape(text)}</w:t></w:r></w:p>'
        for style, text in paragraphs
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document {ns}><w:body>{body}</w:body></w:document>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )
    buf = io.BytesIO()
    with _zf.ZipFile(buf, "w", _zf.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("word/document.xml", document)
    return buf.getvalue()


def test_import_docx_maps_headings():
    docx = _make_docx([
        ("Heading1", "Part One"),
        ("", "Part intro text."),
        ("Heading2", "Chapter 1"),
        ("", "Chapter body."),
        ("Heading3", "Section 1a"),
        ("", "Section body."),
    ])
    out = import_("book.docx", docx)
    blocks, _ = parse(out)
    kinds = [b.kind for b in blocks]
    assert kinds == ["part", "chapter", "section"], kinds
    assert blocks[0].heading == "Part One"
    assert blocks[1].heading == "Chapter 1"


def test_import_bad_docx_raises():
    try:
        import_("book.docx", b"not a zip at all")
        assert False, "expected ServiceError"
    except M.ServiceError as e:
        assert e.code == "PARSE_UNSUPPORTED"


def test_render_pdf_valid_bytes():
    pdf, pages = ENG.render_pdf(DOC, PR.ProseSettings())
    assert pdf.startswith(b"%PDF-")
    assert pages >= 1
    assert b"%%EOF" in pdf


def test_render_pages_nonempty():
    pages = ENG.render_pages(DOC, PR.ProseSettings())
    assert len(pages) >= 1
    # the first page should contain the part title
    assert "Part One" in pages[0]


def test_default_settings_and_formats():
    s = ENG.default_settings()
    assert isinstance(s, PR.ProseSettings)
    d = s.to_dict()
    assert d["page_width"] == 612.0
    assert set(ENG.export_formats()) >= {"markdown", "pdf", "text"}


def test_engine_metadata():
    assert ENG.name == "prose"
    assert ENG.id_prefix == "block"
    assert ENG.block_kind == "block"
