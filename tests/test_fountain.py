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


# --- spec coverage (cue detection, forced elements, title page) -------------

def _kinds(text):
    doc = fountain.parse_document(text)
    return [(e["kind"], e["text"]) for e in doc.elements]


def test_all_caps_action_is_not_a_cue():
    # A cue needs dialogue on the next line; "FADE OUT." / "BANG!" stay put.
    ks = _kinds("INT. A - DAY\n\nBANG!\n\nThe door flies open.\n\nFADE OUT.\n")
    assert ("action", "BANG!") in ks
    assert ("transition", "FADE OUT.") in ks
    assert not any(k == "character" for k, _ in ks)


def test_cue_extensions_and_dual_dialogue():
    doc = fountain.parse_document(
        "INT. A - DAY\n\nARTHUR (V.O.) (CONT'D)\nHello.\n\nMARGO ^\nHi.\n\n@McCLANE\nYippee.\n")
    cues = [e for e in doc.elements if e["kind"] == "character"]
    assert cues[0]["speaker"] == "ARTHUR" and cues[0]["extensions"] == ["V.O.", "CONT'D"]
    assert cues[1]["speaker"] == "MARGO" and cues[1].get("dual")
    assert cues[2]["speaker"] == "McCLANE" and cues[2].get("forced")


def test_jr_and_unknown_extensions_never_block():
    scenes, problems = fountain.parse("INT. A - DAY\n\nJOHN JR.\nHi.\n\nBOB (WHISPERING)\nHey.\n")
    assert not problems and scenes[0].parse_ok


def test_heading_variants_and_scene_numbers():
    doc = fountain.parse_document(
        "int. kitchen - day\n\nx\n\nEST. CITY - DAWN #1A#\n\ny\n\n.FLASHBACK\n\nz\n\nINT./EXT. CAR - NIGHT\n\nw\n")
    heads = [s.heading for s in doc.scenes]
    assert heads == ["int. kitchen - day", "EST. CITY - DAWN", "FLASHBACK", "INT./EXT. CAR - NIGHT"]
    assert doc.scenes[1].meta["scene_number"] == "1A"


def test_heading_directly_followed_by_action():
    scenes, _ = fountain.parse("INT. A - DAY\nJohn enters.\nINT. B - DAY\nMary waits.\n")
    assert [s.heading for s in scenes] == ["INT. A - DAY", "INT. B - DAY"]
    assert scenes[0].elements[1]["kind"] == "action"


def test_non_printing_and_special_elements():
    ks = dict((k, t) for k, t in _kinds(
        "INT. A - DAY\n\n# ACT ONE\n\n= The setup.\n\n[[fix this]]\n\n/* cut\nthis */\n\n"
        ">THE END<\n\n~La la la\n\n===\n\n>SMASH CUT TO:\n\n!LOUD NOISES\n"))
    assert ks["section"] == "ACT ONE" and ks["synopsis"] == "The setup."
    assert ks["note"] == "fix this" and ks["boneyard"].startswith("/* cut")
    assert ks["centered"] == "THE END" and ks["lyric"] == "La la la"
    assert ks["page_break"] == "===" and ks["transition"] == "SMASH CUT TO:"
    assert ks["action"] == "LOUD NOISES"


def test_unclosed_boneyard_is_a_problem():
    _scenes, problems = fountain.parse("INT. A - DAY\n\n/* never closed\n\nmore\n")
    assert [p.code for p in problems] == ["UNCLOSED_BONEYARD"]


def test_title_page_multiline_and_body_offset():
    text = "Title:\n    BIG\n    SHOW\nCredit: Written by\nAuthor: Ann\n\nFADE IN:\n\nINT. A - DAY\n"
    doc = fountain.parse_document(text)
    assert fountain.title_fields(doc.title_page) == {"Title": "BIG\nSHOW", "Credit": "Written by",
                                                      "Author": "Ann"}
    assert text[doc.title_page["end"]:].startswith("FADE IN:")
    assert doc.preamble[0]["kind"] == "transition"


def test_set_title_page_keeps_body():
    body = "INT. A - DAY\n\nHello.\n"
    out = fountain.set_title_page("Title: Old\n\n" + body, {"Title": "New", "Author": "Me"})
    assert out == "Title: New\nAuthor: Me\n\n" + body


def test_offsets_slice_exact_text():
    text = "INT. A - DAY\r\n\r\nARTHUR\r\nHi there.\r\n"
    for e in fountain.parse_document(text).elements:
        raw = text[e["start"]:e["end"]]
        assert raw.strip().replace("\r", "") in (e["text"], "(" + e.get("content", "") + ")"), (raw, e)


def test_apply_operation_delete_and_heading_dedup():
    from screenplay import models as M
    text = "INT. A - DAY\n\nOne.\n\nINT. B - DAY\n\nTwo.\n"
    scenes, _ = fountain.parse(text)
    out, sc = fountain.apply_operation(text, scenes, M.Operation(type="delete", scene_id="scene-0"))
    assert out == "INT. B - DAY\n\nTwo.\n" and len(sc) == 1
    out, sc = fountain.apply_operation(text, scenes, M.Operation(
        type="replace", scene_id="scene-1", heading="INT. B - DAY", content="INT. B - DAY\n\nNew."))
    assert out.count("INT. B - DAY") == 1 and out.endswith("New.\n")
