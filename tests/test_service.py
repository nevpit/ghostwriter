"""Service lifecycle: import -> propose -> check -> accept/reject, immutability,
stable scene ids, and structured error paths.

Operation dicts: ``{"type": "insert", "heading", "content", "before_scene_id"?}``
and ``{"type": "replace", "scene_id", "heading", "content"}``.
"""
import _bootstrap as B
from screenplay.models import ServiceError


def _first_scene(s, p):
    rev = s.read_revision(p.id, p.active_revision_id)
    return rev, rev.scenes[0]


def test_import_creates_v1():
    B.fresh_home()
    s = B.svc()
    p = s.import_project("The Last Light", "Test", B.SAMPLE_FOUNTAIN)
    assert p.active_revision_id
    rev = s.read_revision(p.id, p.active_revision_id)
    assert len(rev.scenes) == 2
    hist = s.history(p.id)
    assert len(hist) == 1 and hist[0]["origin"] == "import"


def test_propose_check_accept_grows_history():
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    rev, scene = _first_scene(s, p)
    prop = s.propose(
        p.id,
        [{"type": "replace", "scene_id": scene.id,
          "heading": "INT. OLD HOUSE - NIGHT", "content": "A rewritten opening."}],
        base_revision_id=rev.id)
    s.check_proposal(prop.id)
    new_rev = s.accept_proposal(prop.id)
    assert new_rev.id != rev.id
    assert new_rev.parent_id == rev.id
    assert len(s.history(p.id)) == 2


def test_revisions_are_immutable():
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    rev, scene = _first_scene(s, p)
    old_hash = rev.content_hash
    prop = s.propose(
        p.id,
        [{"type": "replace", "scene_id": scene.id,
          "heading": "INT. OLD HOUSE - NIGHT", "content": "Changed body."}],
        base_revision_id=rev.id)
    s.accept_proposal(prop.id)
    # the original revision's snapshot/hash is untouched
    assert s.read_revision(p.id, rev.id).content_hash == old_hash


def test_reject_keeps_active():
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    rev, _ = _first_scene(s, p)
    prop = s.propose(
        p.id,
        [{"type": "insert", "heading": "INT. CELLAR - NIGHT", "content": "x"}],
        base_revision_id=rev.id)
    prop = s.reject_proposal(prop.id, "not needed")
    assert prop.status == "rejected"
    assert s.get_project(p.id).active_revision_id == rev.id


def test_scene_id_stable_across_replace():
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    rev, scene = _first_scene(s, p)
    prop = s.propose(
        p.id,
        [{"type": "replace", "scene_id": scene.id,
          "heading": "INT. OLD HOUSE - NIGHT", "content": "Brand new scene."}],
        base_revision_id=rev.id)
    s.accept_proposal(prop.id)
    new_rev = s.read_revision(p.id, s.get_project(p.id).active_revision_id)
    assert scene.id in [sc.id for sc in new_rev.scenes]


def test_get_project_not_found():
    B.fresh_home()
    s = B.svc()
    try:
        s.get_project("nope")
        assert False, "expected ServiceError"
    except ServiceError as e:
        assert e.code


def test_check_unknown_proposal():
    B.fresh_home()
    s = B.svc()
    try:
        s.check_proposal("nope")
        assert False, "expected ServiceError"
    except ServiceError as e:
        assert e.code


def test_protected_passage_blocks_edit():
    """Editing the protected scene -> PROTECTED_PASSAGES fails (LOCKED_TEXT_CHANGED)."""
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    rev = s.read_revision(p.id, p.active_revision_id)
    scene = rev.scenes[1]
    s.protect_scene_text(p.id, scene.id, 0, scene.end - scene.start, label="locked")
    prop = s.propose(
        p.id,
        [{"type": "replace", "scene_id": scene.id,
          "heading": scene.heading, "content": "Tampered with the locked text."}],
        base_revision_id=rev.id)
    prop = s.check_proposal(prop.id)
    assert prop.status == "blocked"
    prot = [c for c in prop.checks if c.name == "PROTECTED_PASSAGES"][0]
    assert prot.status == "fail"
    assert "LOCKED_TEXT_CHANGED" in prot.detail


def test_protected_passage_allows_other_scene():
    """Editing a *different* scene leaves the protected passage intact -> passes."""
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    rev = s.read_revision(p.id, p.active_revision_id)
    protected = rev.scenes[1]
    other = rev.scenes[0]
    s.protect_scene_text(p.id, protected.id, 0, protected.end - protected.start, label="locked")
    prop = s.propose(
        p.id,
        [{"type": "replace", "scene_id": other.id,
          "heading": other.heading, "content": "Edited a different scene."}],
        base_revision_id=rev.id)
    prop = s.check_proposal(prop.id)
    prot = [c for c in prop.checks if c.name == "PROTECTED_PASSAGES"][0]
    assert prot.status == "pass"
    assert prop.status == "pending"


def test_restore_snapshot_creates_new_revision():
    """Restoring an earlier snapshot creates a NEW active revision; history is kept."""
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    rev1 = s.read_revision(p.id, p.active_revision_id)
    prop = s.propose(
        p.id,
        [{"type": "replace", "scene_id": rev1.scenes[0].id,
          "heading": "INT. OLD HOUSE - NIGHT", "content": "Edited opening."}],
        base_revision_id=rev1.id)
    s.accept_proposal(prop.id)
    rev2 = s.read_revision(p.id, s.get_project(p.id).active_revision_id)
    assert rev2.id != rev1.id
    rev3 = s.restore_snapshot(p.id, rev1.id)
    p3 = s.get_project(p.id)
    assert p3.active_revision_id == rev3.id
    assert rev3.snapshot == rev1.snapshot
    assert rev3.content_hash == rev1.content_hash
    assert rev3.parent_id == rev2.id
    hist = s.history(p.id)
    assert len(hist) == 3
    ids = [r["id"] for r in hist]
    assert rev1.id in ids and rev2.id in ids


def test_restore_is_noop_for_active():
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    rev = s.read_revision(p.id, p.active_revision_id)
    out = s.restore_snapshot(p.id, rev.id)
    assert out.id == rev.id
    assert len(s.history(p.id)) == 1


def test_restore_unknown_revision():
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    try:
        s.restore_snapshot(p.id, "nope")
        assert False, "expected ServiceError"
    except ServiceError as e:
        assert e.code == "REVISION_NOT_FOUND"


def test_undo_latest_reverts_last_change():
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    rev1 = s.read_revision(p.id, p.active_revision_id)
    prop = s.propose(
        p.id,
        [{"type": "replace", "scene_id": rev1.scenes[0].id,
          "heading": "INT. OLD HOUSE - NIGHT", "content": "Edited opening."}],
        base_revision_id=rev1.id)
    s.accept_proposal(prop.id)
    undone = s.undo_latest(p.id)
    assert undone.snapshot == rev1.snapshot
    assert s.get_project(p.id).active_revision_id == undone.id
    assert len(s.history(p.id)) == 3  # import, edit, undo


def test_undo_on_initial_refused():
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    try:
        s.undo_latest(p.id)
        assert False, "expected ServiceError"
    except ServiceError as e:
        assert e.code == "INVALID_PROPOSAL"


def test_rule_change_invalidates_old_proposal():
    """Editing a rule creates a new rules version; the older proposal is stale."""
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    rev = s.read_revision(p.id, p.active_revision_id)
    prop = s.propose(
        p.id,
        [{"type": "replace", "scene_id": rev.scenes[0].id,
          "heading": "INT. OLD HOUSE - NIGHT", "content": "Edited opening."}],
        base_revision_id=rev.id)
    s.update_rules(p.id, guidance=["stay on theme"])  # new rules version, active
    try:
        s.accept_proposal(prop.id)
        assert False, "expected stale proposal to be refused"
    except ServiceError as e:
        assert e.code == "RULES_CHANGED"
    assert s.get_proposal(prop.id).status == "stale"


def test_import_parse_failure_leaves_no_orphan_project():
    """A parse failure during import must not leave an orphan project row."""
    B.fresh_home()
    s = B.svc()
    import screenplay.fountain as fountain
    original = fountain.parse
    def boom(_snapshot):
        raise ValueError("simulated parse failure")
    fountain.parse = boom
    try:
        try:
            s.import_project("T", "A", "whatever")
            assert False, "expected parse failure to propagate"
        except ValueError:
            pass
    finally:
        fountain.parse = original
    assert s.list_projects() == []


def test_save_scene_stale_revision_rejected():
    """Manual saves carry the expected revision (optimistic concurrency): a
    stale base is rejected with STALE_REVISION and creates no revision, so a
    writer can re-apply its input on the newer text instead of clobbering it.
    A save against the active base works and stores a new active revision."""
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    rev1 = s.read_revision(p.id, p.active_revision_id)
    scene = rev1.scenes[0]
    # Create a second revision so rev1 is no longer active.
    prop = s.propose(
        p.id,
        [{"type": "replace", "scene_id": scene.id,
          "heading": "INT. OLD HOUSE - NIGHT", "content": "Changed body."}],
        base_revision_id=rev1.id)
    rev2 = s.accept_proposal(prop.id)  # returns the new active revision
    rev2 = s.read_revision(p.id, rev2.id)
    assert rev2.id != rev1.id
    # Saving against the stale base must be rejected...
    try:
        s.save_scene(p.id, scene.id, "INT. OLD HOUSE - NIGHT",
                     "Late edit.", revision_id=rev1.id)
        assert False, "expected STALE_REVISION for stale base"
    except ServiceError as e:
        assert e.code == "STALE_REVISION"
    # ...and must not have created a revision (history is unchanged).
    assert len(s.history(p.id)) == 2
    # Saving against the active base works.
    new_rev = s.save_scene(p.id, scene.id, "INT. OLD HOUSE - NIGHT",
                           "Late edit.", revision_id=rev2.id)
    assert new_rev.id != rev2.id
    rev3 = s.read_revision(p.id, new_rev.id)
    t3 = rev3.scenes[0].text(rev3.snapshot).strip()
    assert t3.startswith("INT. OLD HOUSE - NIGHT")
    assert t3.endswith("Late edit.")


def test_export_fountain_round_trip():
    """Fountain export is the byte-exact snapshot, so re-importing the exported
    text reproduces the identical script (lossless interop with other tools)."""
    B.fresh_home()
    s = B.svc()
    p = s.import_project("The Long Light", "Jane Doe", B.SAMPLE_FOUNTAIN)
    out = s.export_fountain(p.id)
    assert out["fountain"] == B.SAMPLE_FOUNTAIN            # byte-exact
    assert out["filename"].endswith(".fountain")
    assert out["title"] == "The Long Light"
    assert out["size_bytes"] == len(B.SAMPLE_FOUNTAIN.encode("utf-8"))
    # Re-import the exported text: identical scene count and snapshot.
    p2 = s.import_project(out["title"], out["author"], out["fountain"])
    rev2 = s.read_revision(p2.id, p2.active_revision_id)
    rev1 = s.read_revision(p.id, p.active_revision_id)
    assert len(rev2.scenes) == len(rev1.scenes)
    assert rev2.snapshot == B.SAMPLE_FOUNTAIN


def test_export_fountain_reflects_edit():
    """After a manual scene save, the export reflects the new active text."""
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    rev1 = s.read_revision(p.id, p.active_revision_id)
    scene = rev1.scenes[0]
    new_rev = s.save_scene(p.id, scene.id, scene.heading,
                           "BRAND NEW DIALOGUE.", revision_id=rev1.id)
    out = s.export_fountain(p.id)  # defaults to the active revision
    assert out["revision_id"] == new_rev.id
    assert "BRAND NEW DIALOGUE." in out["fountain"]


def test_export_fountain_filename_sanitized():
    """A title with path-hostile characters yields a safe .fountain filename."""
    B.fresh_home()
    s = B.svc()
    p = s.import_project("A/B:C\\D?", "A", B.SAMPLE_FOUNTAIN)
    out = s.export_fountain(p.id)
    assert out["filename"].endswith(".fountain")
    assert "/" not in out["filename"] and "\\" not in out["filename"]
    assert ":" not in out["filename"]


def test_import_file_fdx():
    """Multi-format import: a Final Draft .fdx file is detected, converted to
    Fountain, and imported as a first-class project with the right title."""
    B.fresh_home()
    s = B.svc()
    from pathlib import Path
    fdx = (Path(B.__file__).resolve().parent / "fixtures" / "sample.fdx").read_bytes()
    p = s.import_file("sample.fdx", fdx)
    assert p.title == "The Harbor Light"
    assert p.author == "Jane Doe"
    rev = s.read_revision(p.id, p.active_revision_id)
    assert len(rev.scenes) == 2
    headings = [sc.heading for sc in rev.scenes]
    assert "INT. ROOM 1 - NIGHT" in headings
    assert "EXT. ROOM 2 - DAY" in headings
    # The stored revision is Fountain, so Fountain export round-trips.
    out = s.export_fountain(p.id)
    assert "INT. ROOM 1 - NIGHT" in out["fountain"]


def test_import_file_pdf_roundtrip():
    """Multi-format import: a PDF is detected, its text extracted and
    re-structured into Fountain, and the scene headings survive."""
    B.fresh_home()
    s = B.svc()
    from pathlib import Path
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    pdf_bytes = Path(s.export_pdf(p.id).artifact_path).read_bytes()
    q = s.import_file("rendered.pdf", pdf_bytes)
    rev = s.read_revision(q.id, q.active_revision_id)
    headings = [sc.heading for sc in rev.scenes]
    assert any("OLD HOUSE" in h for h in headings), headings
    assert len(rev.scenes) >= 2

