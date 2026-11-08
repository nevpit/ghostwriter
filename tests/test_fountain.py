"""Fountain parser: scene detection, offset accuracy, element typing, extensions.

``fountain.parse(snapshot)`` returns ``(scenes, problems)`` where ``scenes`` is a
list of ``M.Scene`` (id, order, heading, start, end, elements, parse_ok) and
``elements`` are dicts with ``kind``/``text`` (+ ``speaker``/``extension`` for
characters).
"""
import _bootstrap as B
from screenplay import fountain


def _parse(text=B.SAMPLE_FOUNTAIN):
    return fountain.parse(text)


def test_two_scenes():
    scenes, _ = _parse()
    assert len(scenes) == 2


def test_headings():
    scenes, _ = _parse()
    assert scenes[0].heading == "INT. OLD HOUSE - NIGHT"
    assert scenes[1].heading == "EXT. OLD HOUSE - NIGHT"


def test_offset_accuracy_and_contiguity():
    scenes, _ = _parse()
    snap = B.SAMPLE_FOUNTAIN
    for s in scenes:
        # half-open offsets must slice out exactly the scene text
        assert snap[s.start:s.end] == s.text(snap), s.heading
    # contiguous: one scene's end is the next scene's start
    assert scenes[0].end == scenes[1].start
    assert scenes[0].order == 0 and scenes[1].order == 1


def test_element_kinds_present():
    scenes, _ = _parse()
    kinds = {el["kind"] for s in scenes for el in s.elements}
    for k in ("scene_heading", "action", "character", "dialogue", "transition"):
        assert k in kinds, (k, sorted(kinds))


def test_character_speaker_and_extension():
    scenes, _ = _parse()
    chars = [el for s in scenes for el in s.elements if el["kind"] == "character"]
    assert chars, "no character elements"
    assert all(el.get("speaker") for el in chars)
    assert any(el.get("extension") == "V.O." for el in chars), "V.O. extension lost"


def test_clean_parse_no_problems():
    scenes, problems = _parse()
    assert all(s.parse_ok for s in scenes)
    assert not problems, [getattr(p, "message", p) for p in problems]


def test_empty_document():
    scenes, _ = _parse("")
    assert scenes == []


def test_standalone_parenthetical():
    # Regression: a parenthetical line under dialogue must not crash the
    # parser (was: _element() called with `text` twice).
    text = (
        "INT. ROOM - DAY\n"
        "\n"
        "MIRA\n"
        "(to herself)\n"
        "Twelve years.\n"
        "\n"
        "CUT TO:\n"
    )
    scenes, _ = _parse(text)
    assert len(scenes) == 1
    els = scenes[0].elements
    kinds = [el["kind"] for el in els]
    assert "parenthetical" in kinds, kinds
    p = next(el for el in els if el["kind"] == "parenthetical")
    assert p["text"] == "(to herself)"
    assert p["content"] == "to herself"
    # the parenthetical sits between character and dialogue
    assert kinds.index("parenthetical") > kinds.index("character")
    assert kinds.index("parenthetical") < kinds.index("dialogue")
