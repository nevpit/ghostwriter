"""End-to-end prose workflow through the service: import -> parse -> propose ->
accept -> export (markdown + PDF) -> DB round-trip, plus the Phase-1 format
persistence seam (project.format survives a repository reopen and the snapshot
re-parses with the prose engine)."""
import _bootstrap as B  # noqa: F401
from screenplay import models as M
from screenplay.repository import Repository

MD = (
    "# The Voyage\n"
    "\n"
    "The ship left the harbor at dawn.\n"
    "\n"
    "## Chapter 1: Departure\n"
    "\n"
    "Mara stood at the rail and watched the city shrink.\n"
    "The wind smelled of salt and diesel.\n"
    "\n"
    "## Chapter 2: The Sea\n"
    "\n"
    "For three days the horizon did not move.\n"
)


def test_import_md_creates_prose_project():
    B.fresh_home()
    s = B.svc()
    p = s.import_file("the_voyage.md", MD.encode("utf-8"), title="The Voyage")
    assert p.format == "prose"
    rev = s.read_revision(p.id, p.active_revision_id)
    kinds = [b.kind for b in rev.scenes]
    assert kinds == ["part", "chapter", "chapter"], kinds
    # elements are present (not just headings)
    ch = next(b for b in rev.scenes if b.kind == "chapter")
    assert ch.elements and ch.elements[0]["kind"] == "paragraph"


def test_import_txt_requires_explicit_format():
    """A .txt file keeps the screenplay default (backward compat); passing
    format="prose" imports it as prose."""
    B.fresh_home()
    s = B.svc()
    # .md auto-detects as prose
    p = s.import_file("note.md", b"# T\n\nBody.\n")
    assert p.format == "prose"
    # .txt with explicit format
    q = s.import_file("note.txt", b"## Ch\n\nBody.\n", format="prose")
    assert q.format == "prose"
    # .txt with NO format -> screenplay default (unchanged behavior)
    r = s.import_file("note.txt", b"INT. ROOM - DAY\n\nAction line.\n")
    assert r.format == "screenplay"


def test_elements_survive_db_roundtrip():
    B.fresh_home()
    s = B.svc()
    p = s.import_file("the_voyage.md", MD.encode("utf-8"))
    rev1 = s.read_revision(p.id, p.active_revision_id)
    ch = next(b for b in rev1.scenes if b.kind == "chapter")
    # re-read from disk: elements must be re-derived identically
    rev2 = s.read_revision(p.id, p.active_revision_id)
    ch2 = next(b for b in rev2.scenes if b.id == ch.id)
    assert ch2.elements == ch.elements
    assert ch2.kind == ch.kind == "chapter"
    assert ch2.parent_id == ch.parent_id


def test_propose_insert_and_accept():
    B.fresh_home()
    s = B.svc()
    p = s.import_file("the_voyage.md", MD.encode("utf-8"))
    rev = s.read_revision(p.id, p.active_revision_id)
    last_chapter = [b for b in rev.scenes if b.kind == "chapter"][-1]
    prop = s.propose(p.id, [{
        "type": "insert", "before_scene_id": last_chapter.id,
        "heading": "Chapter 1.5: The Storm",
        "content": "The storm arrived before nightfall.",
    }], base_revision_id=rev.id)
    assert prop.status == "pending"
    assert all(c.status != M.FAIL for c in prop.checks)
    s.check_proposal(prop.id)
    new_rev = s.accept_proposal(prop.id)
    p2 = s.get_project(p.id)
    assert p2.active_revision_id == new_rev.id
    rev2 = s.read_revision(p.id, p2.active_revision_id)
    assert any(b.heading == "Chapter 1.5: The Storm" for b in rev2.scenes)
    assert len(rev2.scenes) == len(rev.scenes) + 1


def test_propose_blocked_by_limits():
    """A rules version with a min-chapters limit blocks a candidate that
    violates it (the prose structural gate fires through the generic service)."""
    B.fresh_home()
    s = B.svc()
    p = s.import_file("the_voyage.md", MD.encode("utf-8"))
    s.update_rules(p.id, limits={"min_chapters": 10})
    p2 = s.get_project(p.id)
    rev = s.read_revision(p2.id, p2.active_revision_id)
    prop = s.propose(p2.id, [{
        "type": "insert", "heading": "Chapter X", "content": "More.",
    }], base_revision_id=rev.id)
    cc = next(c for c in prop.checks if c.name == "CHAPTER_COUNT")
    assert cc.status == M.FAIL
    assert prop.status == M.BLOCKED


def test_export_markdown_roundtrip():
    B.fresh_home()
    s = B.svc()
    p = s.import_file("the_voyage.md", MD.encode("utf-8"))
    out = s.export_markdown(p.id)
    assert out["filename"].endswith(".md")
    assert out["markdown"] == MD  # lossless: snapshot IS the markdown
    # re-importing the export reproduces an identical project
    p2 = s.import_file("roundtrip.md", out["markdown"].encode("utf-8"))
    rev1 = s.read_revision(p.id, p.active_revision_id)
    rev2 = s.read_revision(p2.id, p2.active_revision_id)
    assert len(rev1.scenes) == len(rev2.scenes)
    assert [b.heading for b in rev1.scenes] == [b.heading for b in rev2.scenes]


def test_export_pdf_prose():
    B.fresh_home()
    s = B.svc()
    p = s.import_file("the_voyage.md", MD.encode("utf-8"))
    exp = s.export_pdf(p.id)
    assert exp.status == M.EXPORT_OK
    assert exp.page_count and exp.page_count >= 1
    data = open(exp.artifact_path, "rb").read()
    assert data.startswith(b"%PDF-")
    # the renderer config stored is the prose settings (book layout)
    assert exp.renderer_config.get("page_width") == 612.0


def test_inspect_pages_prose():
    B.fresh_home()
    s = B.svc()
    p = s.import_file("the_voyage.md", MD.encode("utf-8"))
    pages = s.inspect_pages(p.id)
    assert pages["page_count"] >= 1
    assert "The Voyage" in pages["pages"][0]


def test_format_persists_across_repo_reopen():
    """The Phase-1 persistence seam: project.format is a DB column, and a fresh
    Repository (simulating a process restart) re-derives the revision's blocks
    with the *prose* engine (not the hardcoded Fountain parser)."""
    B.fresh_home()
    s = B.svc()
    p = s.import_file("the_voyage.md", MD.encode("utf-8"))
    assert p.format == "prose"
    # Reopen the same database with a brand-new Repository (new registry).
    repo2 = Repository(str(s.repo.db_path))
    p2 = repo2.get_project(p.id)
    assert p2 is not None and p2.format == "prose"
    rev2 = repo2.get_revision(p2.active_revision_id)
    kinds = [b.kind for b in rev2.scenes]
    assert kinds == ["part", "chapter", "chapter"], kinds
    ch = next(b for b in rev2.scenes if b.kind == "chapter")
    assert ch.elements, "elements must be re-derived by the prose engine"
    assert ch.parent_id == "block-0"
