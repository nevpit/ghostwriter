"""Document-engine abstraction (Phase 0).

The generic service dispatches every format-specific operation (parse, splice,
validate, render, import) through a ``DocumentEngine`` resolved per project via
``Project.format``. These tests pin that the abstraction is in place and that
the screenplay (Fountain) engine is engine #1, delegating to the existing
fountain / validation / rendering / importers modules.
"""
import _bootstrap as B
from screenplay import engine
from screenplay import formats
from screenplay import models as M
from screenplay.formats.screenplay import ScreenplayEngine


def test_default_format_is_screenplay():
    assert engine.DEFAULT_FORMAT == "screenplay"


def test_default_registry_registers_ghostwriter_engine():
    reg = formats.build_default_registry()
    assert "screenplay" in reg.names()
    eng = reg.get("screenplay")
    assert isinstance(eng, engine.DocumentEngine)
    assert isinstance(eng, ScreenplayEngine)
    assert eng.name == "screenplay"
    assert eng.block_kind == "scene"


def test_registry_is_independent_per_build():
    # Each service instance builds its own registry, so there is no shared
    # cross-test / cross-project state.
    assert formats.build_default_registry() is not formats.build_default_registry()


def test_unknown_format_is_rejected():
    reg = formats.build_default_registry()
    try:
        reg.get("novel")
        assert False, "expected UnknownFormatError"
    except engine.UnknownFormatError:
        pass


def test_ghostwriter_engine_parse_returns_blocks():
    scenes, _problems = ScreenplayEngine().parse(B.SAMPLE_FOUNTAIN)
    assert scenes, "expected at least one block"
    for sc in scenes:
        assert isinstance(sc, M.Block)
        assert isinstance(sc, M.Scene)  # Scene subclasses Block
        assert sc.kind == "scene"
    # Scene-specific heading is preserved alongside the general Block fields.
    assert all(sc.heading for sc in scenes)


def test_block_is_nestable():
    part = M.Block(id="b1", kind="part", title="Part I")
    chapter = M.Block(id="b2", kind="chapter", title="Ch. 1", parent_id="b1")
    assert chapter.parent_id == "b1"
    assert part.parent_id is None
    # Offsets slice the owning snapshot (zero-length -> empty), same as a Scene.
    assert part.text("0123456789") == ""
    assert chapter.text("0123456789") == ""


def test_project_format_defaults_to_screenplay():
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    assert p.format == "screenplay"
    # The service resolves the registered engine for the project's format.
    assert s._engine(p.id).name == "screenplay"
    assert isinstance(s._engine(p.id), ScreenplayEngine)


def test_service_dispatch_end_to_end_through_engine():
    """The full propose -> check -> accept workflow runs through the engine."""
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    assert s._engine(p.id).name == "screenplay"
    rev = s.read_revision(p.id, p.active_revision_id)
    scene = rev.scenes[0]
    prop = s.propose(
        p.id,
        [{"type": "replace", "scene_id": scene.id,
          "heading": "INT. OLD HOUSE - NIGHT", "content": "Engine-routed edit."}],
        base_revision_id=rev.id)
    checked = s.check_proposal(prop.id)
    assert checked.status in ("pending", "blocked")
    new_rev = s.accept_proposal(prop.id)
    assert new_rev.id != rev.id
    assert "Engine-routed edit." in new_rev.snapshot
