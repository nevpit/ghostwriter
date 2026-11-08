"""PDF rendering: structural validity (header, xref, page count, Courier, text ops).

The renderer is a pure-stdlib writer using the base-14 Courier font, so validity
is checked structurally (no external PDF library needed).
"""
import re
import _bootstrap as B
from pathlib import Path


def _pdf_bytes():
    B.fresh_home()
    s = B.svc()
    p = s.import_project("T", "A", B.SAMPLE_FOUNTAIN)
    exp = s.export_pdf(p.id)
    return Path(exp.artifact_path).read_bytes(), exp


def test_header_and_eof():
    data, _ = _pdf_bytes()
    assert data[:5] == b"%PDF-"
    assert b"%%EOF" in data


def test_page_count_matches():
    data, exp = _pdf_bytes()
    page_objs = len(re.findall(rb"/Type\s*/Page\b", data))
    pages_objs = len(re.findall(rb"/Type\s*/Pages\b", data))
    assert pages_objs >= 1, "no page tree"
    assert exp.page_count >= 1
    assert page_objs == exp.page_count, (page_objs, exp.page_count)


def test_courier_and_text_ops():
    data, _ = _pdf_bytes()
    assert b"/Courier" in data, "Courier font not referenced"
    assert (b"Tj" in data) or (b"TJ" in data), "no text-showing operators"


def test_font_selected_before_text():
    """Regression: the content stream MUST select a font (`/F1 <size> Tf`)
    before showing text. Without it the operators are present but inert and
    every viewer renders a blank page (the original export bug)."""
    data, _ = _pdf_bytes()
    # A font-size operator must appear inside the text object.
    assert re.search(rb"/F\d+\s+[\d.]+\s+Tf", data), (
        "no font-selection operator (/F<n> <size> Tf) in content stream — "
        "PDF would render blank"
    )
    # The selection must come before the first text-show.
    tf = re.search(rb"/F\d+\s+[\d.]+\s+Tf", data).start()
    tj = data.find(b" Tj")
    assert tf != -1 and tj != -1 and tf < tj, "font must be selected before Tj"


def test_text_content_present():
    """Regression: the sample's text must actually be embedded in the PDF
    (guards against a structurally-valid but empty/blank document)."""
    data, _ = _pdf_bytes()
    # The PDF escapes parentheses, so search for a distinctive paren-free line.
    for needle in (b"INT. OLD HOUSE - NIGHT", b"The night everything ended."):
        assert needle in data, f"expected text not embedded in PDF: {needle!r}"


def test_xref_present():
    data, _ = _pdf_bytes()
    assert b"xref" in data, "no xref table"
    assert b"startxref" in data


def test_standard_indents():
    """RenderSettings geometry matches industry-standard screenplay margins.

    Letter page, 1.5 in left margin, Courier 12:
      action/scene   -> 1.5 in (108 pt)
      character      -> 3.7 in (266.4 pt)
      dialogue       -> 2.5 in (180 pt), 3.5 in wide (252 pt)
      parenthetical  -> 3.1 in (223.2 pt)
    """
    from screenplay import rendering
    r = rendering.RenderSettings()
    assert abs(r.margin_left - 108.0) < 0.01, r.margin_left
    action_x, _ = r.col("action")
    assert abs(action_x - 108.0) < 0.01, action_x
    scene_x, _ = r.col("scene_heading")
    assert abs(scene_x - 108.0) < 0.01, scene_x
    char_x, _ = r.col("character")
    assert abs(char_x - 266.4) < 0.01, char_x
    dlg_x, dlg_w = r.col("dialogue")
    assert abs(dlg_x - 180.0) < 0.01, dlg_x
    assert abs(dlg_w - 252.0) < 0.01, dlg_w
    paren_x, _ = r.col("parenthetical")
    assert abs(paren_x - 223.2) < 0.01, paren_x
    assert r.config_version == "screenplay-pdf/2"


def test_dialogue_indented_in_pdf():
    """Regression: dialogue lines must render in the indented 2.5 in column
    (x=180), NOT at the left margin (x=108). This guards against the renderer
    classifying each line statelessly (which sent all dialogue to full-width
    action). We parse the real content stream and check where the sample's
    dialogue line actually lands."""
    from screenplay import rendering
    data, _ = _pdf_bytes()
    # Pull every (x, text) pair from the first page's content stream.
    stream = re.search(rb"stream\n(.*?)\nendstream", data, re.S).group(1)
    cs = stream.decode("latin-1")
    pairs = {t: float(x) for x, t in
             re.findall(r"1 0 0 1 ([\d.]+) [\d.]+ Tm\n\((.*)\) Tj", cs)}
    # A dialogue line from the sample must be at x=180 (indented).
    dlg = "The night everything ended."
    assert dlg in pairs, f"dialogue line not found in content stream: {dlg!r}"
    assert abs(pairs[dlg] - 180.0) < 0.01, (
        f"dialogue rendered at x={pairs[dlg]}, expected 180.0 (2.5 in indent)")
    # A character cue must be at x=266.4, an action line at the 108 margin.
    assert abs(pairs["ARTHUR"] - 266.4) < 0.01, pairs.get("ARTHUR")
    assert abs(pairs["INT. OLD HOUSE - NIGHT"] - 108.0) < 0.01, (
        pairs.get("INT. OLD HOUSE - NIGHT"))


def test_wrap_breaks_on_word_boundaries():
    """Regression: ``_wrap`` must break on **word boundaries**, never mid-word.
    The original character-slice wrap cut ``breakwater`` into
    ``breakwa``/``ter``. The invariant: joining the wrapped lines with a single
    space reconstructs the input exactly (same words, same order) -> no word
    was split or dropped."""
    from screenplay import rendering
    text = ("Boats rock in the dark water. LENA watches the breakwater "
            "light on the harbor and logs the bearing.")
    wrapped = rendering._wrap(text, 30)
    assert " ".join(wrapped) == text, wrapped
    assert all(len(line) <= 30 for line in wrapped), wrapped
    # A single word longer than the column must still be placed (hard-broken)
    # with no text lost; every other word stays whole.
    long = "supercalifragilisticexpialidocious short"
    out = rendering._wrap(long, 10)
    assert all(len(line) <= 10 for line in out), out
    overlong = [line for line in out if line != "short"]
    assert "".join(overlong) == "supercalifragilisticexpialidocious", out
    assert "short" in out, out


def test_no_midword_break_in_layout():
    """Regression (layout-level): a long action line must wrap at word
    boundaries in the real layout pipeline, never mid-word, and no wrapped line
    may exceed its column width."""
    from screenplay import rendering
    s = rendering.RenderSettings()
    para = ("Boats rock in the dark water and the lighthouse beam "
            "sweeps across the breakwater while LENA watches from the "
            "headland, logging every bearing the compass gives her.")
    snapshot = "INT. THE HARBOR - NIGHT\n\n" + para
    lines = rendering.layout_lines(snapshot, s)
    action_lines = [t for (t, x, k, ra) in lines if k == "action" and t]
    # The action words, in order, must all be present whole (rejoin == source).
    assert " ".join(action_lines) == para, action_lines
    max_chars = int(s.col("action")[1] // s.char_width)
    assert all(len(t) <= max_chars for t in action_lines), (max_chars, action_lines)
