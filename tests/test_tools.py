"""Agent tool handlers: registration shape + full workflow through the tool layer.

``screenplay.tools.TOOLS`` is a list of ``(name, schema, handler, emoji)`` tuples.
Each handler takes a single ``args`` dict and returns a JSON string
``{"success": ...}``. We drive the real handlers end-to-end (import -> read ->
propose -> check -> accept -> export).
"""
import json
import _bootstrap as B
from pathlib import Path
from screenplay import tools as T


def _handler(name):
    for entry in T.TOOLS:
        if entry[0] == name:
            return entry[2]
    raise KeyError(name)


def call(name, **args):
    return json.loads(_handler(name)(args))


def test_toolset_and_schema_shape():
    names = [e[0] for e in T.TOOLS]
    for n in ("screenplay_import", "screenplay_get_project", "screenplay_propose",
              "screenplay_check_proposal", "screenplay_accept_proposal",
              "screenplay_export_pdf", "screenplay_status",
              "screenplay_restore", "screenplay_undo"):
        assert n in names, (n, names)
    for e in T.TOOLS:
        assert e[1]["name"] == e[0]
        assert "parameters" in e[1] and e[1]["parameters"]["type"] == "object"


def test_status_empty():
    B.fresh_home()
    s = call("screenplay_status")
    assert s["success"] and s["projects"] == 0
    assert s["hermes_version"]


def test_full_workflow_through_tools():
    B.fresh_home()
    imp = call("screenplay_import", title="T", author="A", fountain_text=B.SAMPLE_FOUNTAIN)
    assert imp["success"]
    pid = imp["project"]["id"]
    gp = call("screenplay_get_project", project_id=pid)
    assert gp["revision_count"] == 1 and gp["active_revision"]["scenes"]
    scene_id = gp["active_revision"]["scenes"][0]["id"]
    rev_id = gp["project"]["active_revision_id"]
    prop = call("screenplay_propose", project_id=pid,
                operations=[{"type": "replace", "scene_id": scene_id,
                             "heading": "INT. OLD HOUSE - NIGHT", "content": "New body."}],
                base_revision_id=rev_id)
    assert prop["success"]
    chk = call("screenplay_check_proposal", proposal_id=prop["proposal"]["id"])
    assert chk["success"]
    acc = call("screenplay_accept_proposal", proposal_id=prop["proposal"]["id"])
    assert acc["success"] and acc["revision"]["id"] != rev_id
    pdf = call("screenplay_export_pdf", project_id=pid)
    assert pdf["success"] and pdf["path"]
    assert Path(pdf["path"]).read_bytes()[:4] == b"%PDF"


def test_structured_error():
    B.fresh_home()
    bad = call("screenplay_get_project", project_id="nope")
    assert bad["success"] is False and "code" in bad and "error" in bad


def test_restore_and_undo_tools():
    B.fresh_home()
    imp = call("screenplay_import", title="T", author="A", fountain_text=B.SAMPLE_FOUNTAIN)
    pid = imp["project"]["id"]
    gp = call("screenplay_get_project", project_id=pid)
    rev1 = gp["project"]["active_revision_id"]
    scene_id = gp["active_revision"]["scenes"][0]["id"]
    prop = call("screenplay_propose", project_id=pid,
                operations=[{"type": "replace", "scene_id": scene_id,
                             "heading": "INT. OLD HOUSE - NIGHT", "content": "New body."}],
                base_revision_id=rev1)
    acc = call("screenplay_accept_proposal", proposal_id=prop["proposal"]["id"])
    assert acc["success"]
    # restore the original import snapshot -> a NEW active revision
    res = call("screenplay_restore", project_id=pid, revision_id=rev1)
    assert res["success"] and res["revision"]["id"] != rev1
    assert len(res["history"]) == 3
    # undo the restore -> back to the pre-restore head (a further new revision)
    und = call("screenplay_undo", project_id=pid)
    assert und["success"] and und["revision"]["id"] != res["revision"]["id"]
