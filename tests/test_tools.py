"""Agent tool handlers: registration shape + workflows through the tool layer.

``screenplay.tools.TOOLS`` is a list of ``(name, schema, handler, emoji)``
tuples; each handler takes an ``args`` dict and returns a JSON string.
"""
import json
import re
from pathlib import Path

import _bootstrap as B
from screenplay import tools as T

PLUGIN_YAML = Path(B.PLUGIN_ROOT) / "plugin.yaml"


def _handler(name):
    for entry in T.TOOLS:
        if entry[0] == name:
            return entry[2]
    raise KeyError(name)


def call(name, **args):
    return json.loads(_handler(name)(args))


def _new(text=None):
    B.fresh_home()
    r = call("ghost_create_project", title="T", author="A",
             fountain_text=B.SAMPLE_FOUNTAIN if text is None else text)
    assert r["success"], r
    return r["project"]["id"]


def test_toolset_and_schema_shape():
    names = [e[0] for e in T.TOOLS]
    assert len(names) == len(set(names))
    for e in T.TOOLS:
        assert e[1]["name"] == e[0]
        params = e[1]["parameters"]
        assert params["type"] == "object"
        for req in params.get("required", []):
            assert req in params["properties"], (e[0], req)


def test_manifest_lists_every_tool():
    declared = re.findall(r"^\s+-\s+(\S+)\s*$", PLUGIN_YAML.read_text(), re.M)
    assert sorted(declared) == sorted(e[0] for e in T.TOOLS)


def test_status_empty():
    B.fresh_home()
    s = call("ghost_status")
    assert s["success"] and s["projects"] == 0


def test_create_empty_project_gets_title_page():
    B.fresh_home()
    r = call("ghost_create_project", title="Night Shift", author="Ada Lane")
    assert r["success"]
    gp = call("ghost_get_project", project_id=r["project"]["id"])
    assert gp["outline"]["title_page"]["Title"] == "Night Shift"
    assert gp["outline"]["title_page"]["Author"] == "Ada Lane"
    assert gp["outline"]["scenes"] == []


def test_full_workflow_through_tools():
    pid = _new()
    gp = call("ghost_get_project", project_id=pid)
    assert gp["success"]
    scenes = gp["outline"]["scenes"]
    assert len(scenes) == 2 and "ARTHUR" in scenes[0]["characters"]
    assert "snapshot" not in json.dumps(gp), "overview must stay compact"

    prop = call("ghost_propose", project_id=pid, operations=[
        {"type": "replace", "scene_id": scenes[0]["id"], "heading": "INT. OLD HOUSE - NIGHT",
         "content": "A new opening.\n\nARTHUR\nIt starts here."}])
    assert prop["success"] and prop["proposal"]["status"] == "pending", prop
    assert "candidate_snapshot" not in prop["proposal"]
    chk = call("ghost_check_proposal", proposal_id=prop["proposal"]["id"])
    assert chk["proposal"]["status"] == "pending"
    acc = call("ghost_accept_proposal", proposal_id=prop["proposal"]["id"])
    assert acc["success"] and acc["scene_count"] == 2 and acc["page_count"] >= 2

    text = call("ghost_read_script", project_id=pid, scene_ids=[scenes[0]["id"]])["fountain"]
    assert "It starts here." in text

    for fmt in ("pdf", "fountain", "fdx"):
        ex = call("ghost_export", project_id=pid, format=fmt)
        assert ex["success"], ex
        assert Path(ex["path"]).exists()


def test_propose_apply_insert_and_delete():
    pid = _new()
    scenes = call("ghost_get_project", project_id=pid)["outline"]["scenes"]
    r = call("ghost_propose", project_id=pid, apply=True, operations=[
        {"type": "insert", "before_scene_id": scenes[1]["id"], "heading": "EXT. ROAD - NIGHT",
         "content": "Headlights."},
        {"type": "delete", "scene_id": scenes[0]["id"]}])
    assert r["success"] and r["applied"], r
    after = call("ghost_get_project", project_id=pid)["outline"]["scenes"]
    assert [s["heading"] for s in after] == ["EXT. ROAD - NIGHT", "EXT. OLD HOUSE - NIGHT"]
    assert after[1]["id"] == scenes[1]["id"], "untouched scene keeps its id"
    und = call("ghost_undo", project_id=pid)
    assert und["success"] and und["scene_count"] == 2


def test_propose_with_heading_inside_content_is_not_duplicated():
    pid = _new()
    sid = call("ghost_get_project", project_id=pid)["outline"]["scenes"][0]["id"]
    r = call("ghost_propose", project_id=pid, apply=True, operations=[
        {"type": "replace", "scene_id": sid, "heading": "INT. OLD HOUSE - NIGHT",
         "content": "INT. OLD HOUSE - NIGHT\n\nQuiet."}])
    assert r["applied"], r
    text = call("ghost_read_script", project_id=pid)["fountain"]
    assert text.count("INT. OLD HOUSE - NIGHT") == 1


def test_bad_operations_are_structured_errors():
    pid = _new()
    for ops in ([], [{"type": "explode"}], [{"type": "replace", "scene_id": "scene-99",
                                             "content": "x"}]):
        r = call("ghost_propose", project_id=pid, operations=ops)
        assert not r["success"] and r["code"], r


def test_title_page_rules_and_find_replace():
    pid = _new()
    tp = call("ghost_set_title_page", project_id=pid,
              fields={"Title": "The Lamp", "Credit": "Written by", "Author": "Jo"})
    assert tp["success"] and tp["title_page"]["Title"] == "The Lamp"
    assert call("ghost_list_projects")["projects"][0]["title"] == "The Lamp"
    rules = call("ghost_update_rules", project_id=pid, page_limit=50)
    assert rules["rules"]["page_limit"] == 50
    fr = call("ghost_find_replace", project_id=pid, query="Arthur", replacement="Walter")
    assert fr["success"] and fr["replaced"] >= 5
    text = call("ghost_read_script", project_id=pid)["fountain"]
    assert "WALTER" in text and "ARTHUR" not in text


def test_structured_error():
    B.fresh_home()
    bad = call("ghost_get_project", project_id="nope")
    assert not bad["success"] and bad["code"] == "PROJECT_NOT_FOUND"
    missing = call("ghost_get_project")
    assert not missing["success"]


def test_restore_and_undo_tools():
    pid = _new()
    hist = call("ghost_history", project_id=pid)
    rev1 = hist["revisions"][0]["id"]
    sid = call("ghost_get_project", project_id=pid)["outline"]["scenes"][0]["id"]
    call("ghost_propose", project_id=pid, apply=True, operations=[
        {"type": "replace", "scene_id": sid, "heading": "INT. OLD HOUSE - DAY", "content": "Sun."}])
    res = call("ghost_restore", project_id=pid, revision_id=rev1)
    assert res["success"]
    assert call("ghost_history", project_id=pid)["total"] == 3
    und = call("ghost_undo", project_id=pid)
    assert und["success"]


def test_assistant_edits_are_attributed_in_history():
    pid = _new()
    call("ghost_find_replace", project_id=pid, query="Arthur", replacement="Walter")
    call("ghost_set_title_page", project_id=pid, fields={"Title": "X"})
    origins = [r["origin"] for r in call("ghost_history", project_id=pid)["revisions"]]
    assert origins[:2] == ["assistant", "assistant"], origins
