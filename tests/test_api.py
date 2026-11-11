"""Dashboard FastAPI router: all routes, the bare-object contract, and error shape.

``plugin_api.py`` is exec'd by the web server (top-level code runs). We load it
the same way and mount its ``router`` in a TestClient. Handlers return the data
object/array directly (no ``success`` wrapper); errors are ``HTTPException`` ->
4xx with a structured ``detail``.
"""
import base64
import importlib.util
import _bootstrap as B

_ROUTER = None


def _router():
    global _ROUTER
    if _ROUTER is None:
        spec = importlib.util.spec_from_file_location(
            "plugin_api_under_test", B.PLUGIN_ROOT / "dashboard" / "plugin_api.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _ROUTER = mod.router
    return _ROUTER


def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    app.include_router(_router())
    return TestClient(app, raise_server_exceptions=False)


def _seed():
    B.fresh_home()
    s = B.svc()
    p = s.import_project("The Last Light", "Test", B.SAMPLE_FOUNTAIN)
    return p.id


def test_status():
    _seed()
    r = _client().get("/status")
    assert r.status_code == 200
    d = r.json()
    assert d["projects"] >= 1 and d["hermes_version"]
    assert d["plugin"] == "ghostwriter"


def test_projects_bare_array():
    pid = _seed()
    arr = _client().get("/projects").json()
    assert isinstance(arr, list) and pid in [x["id"] for x in arr]


def test_project_detail():
    pid = _seed()
    d = _client().get(f"/projects/{pid}").json()
    assert d["revision_count"] == 1 and d["active_revision"]["scenes"]
    assert d["active_revision_id"]


def test_history_is_dicts():
    pid = _seed()
    hist = _client().get(f"/projects/{pid}/history").json()
    assert isinstance(hist, list) and hist[0]["origin"] == "import"


def test_proposals_list():
    pid = _seed()
    r = _client().get(f"/projects/{pid}/proposals")
    assert r.status_code == 200 and isinstance(r.json(), list)


def test_pdf_binary():
    pid = _seed()
    r = _client().get(f"/projects/{pid}/pdf")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:4] == b"%PDF"
    assert "attachment" in r.headers.get("content-disposition", "")


def test_pdf_preview_returns_export_bytes_over_json():
    pid = _seed()
    response = _client().get(f"/projects/{pid}/pdf/preview")
    assert response.status_code == 200
    preview = response.json()
    content = base64.b64decode(preview["content_b64"], validate=True)
    assert content.startswith(b"%PDF")
    assert preview["size_bytes"] == len(content)
    assert preview["filename"].endswith(".pdf")
    assert preview["page_count"] > 0
    assert "path" not in preview


def test_error_404_structured():
    _seed()
    r = _client().get("/projects/nope")
    assert r.status_code == 404
    assert "code" in r.json()["detail"]


def test_restore_and_undo_routes():
    pid = _seed()
    c = _client()
    detail = c.get(f"/projects/{pid}").json()
    rev1 = detail["active_revision"]["id"]
    scene = detail["active_revision"]["scenes"][0]
    prop = c.post(f"/projects/{pid}/propose", json={
        "operations": [{"type": "replace", "scene_id": scene["id"],
                        "heading": "INT. OLD HOUSE - NIGHT", "content": "Edited opening."}]}).json()
    c.post(f"/proposals/{prop['id']}/accept")
    # restore the import snapshot via the API -> a new active revision
    r = c.post(f"/projects/{pid}/restore", json={"revision_id": rev1})
    assert r.status_code == 200
    new_rev = r.json()
    assert new_rev["id"] != rev1 and new_rev["origin"] == "restore"
    # undo the restore via the API
    u = c.post(f"/projects/{pid}/undo")
    assert u.status_code == 200 and u.json()["origin"] == "restore"


def test_project_detail_scene_text():
    """``Scene.text`` is a method, so plain ``asdict`` drops it; the detail
    route must compute the raw scene text (the Desktop editor seeds from it)."""
    pid = _seed()
    d = _client().get(f"/projects/{pid}").json()
    scene = d["active_revision"]["scenes"][0]
    assert scene["text"].strip().startswith(scene["heading"].split()[0][:4])
    assert scene["text"]  # non-empty raw text


def test_propose_route_forwards_base_revision():
    """The propose route must honour ``base_revision_id``; without it, HTTP
    proposals could only ever target the active revision and the stale-base
    (re-propose-on-old-snapshot) workflow was silently broken."""
    pid = _seed()
    c = _client()
    detail = c.get(f"/projects/{pid}").json()
    rev1 = detail["active_revision"]["id"]
    scene = detail["active_revision"]["scenes"][0]
    # a manual edit makes rev2 active, leaving rev1 stale
    r = c.post(f"/projects/{pid}/scenes/{scene['id']}", json={
        "content": "MANUAL EDIT VIA ROUTE", "heading": scene["heading"],
        "revision_id": rev1})
    assert r.status_code == 200
    rev2 = r.json()["id"]
    assert rev2 != rev1
    # propose against the now-stale rev1
    prop = c.post(f"/projects/{pid}/propose", json={
        "base_revision_id": rev1,
        "operations": [{"type": "replace", "scene_id": scene["id"],
                        "heading": "INT. OLD HOUSE - NIGHT", "content": "Stale-base rewrite."}]}).json()
    assert prop["base_revision_id"] == rev1
    # the proposal view flags the non-active base
    view = c.get(f"/proposals/{prop['id']}").json()
    assert view["base_is_active"] is False
    assert view["changes"]  # before/after computed from the base revision


def test_fountain_export_route():
    """GET /projects/{id}/fountain returns the byte-exact snapshot + a
    .fountain filename so the pane can offer a download for other software."""
    pid = _seed()
    r = _client().get(f"/projects/{pid}/fountain")
    assert r.status_code == 200
    d = r.json()
    assert d["fountain"] == B.SAMPLE_FOUNTAIN
    assert d["filename"].endswith(".fountain")
    assert d["size_bytes"] == len(B.SAMPLE_FOUNTAIN.encode("utf-8"))
    assert d["revision_id"]


def test_create_title_page_fdx_conflict_and_delete():
    B.fresh_home()
    c = _client()
    p = c.post("/projects", json={"title": "Pilot", "author": "Sam"}).json()
    d = c.get(f"/projects/{p['id']}").json()
    assert [f["key"] for f in d["title_page"]["fields"]] == ["Title", "Credit", "Author"]
    assert d["page_count"] == 1 and d["preamble"] == []

    r = c.put(f"/projects/{p['id']}/title-page",
              json={"fields": {"Title": "Pilot (v2)", "Author": "Sam"}})
    assert r.status_code == 200
    assert c.get(f"/projects/{p['id']}").json()["project"]["title"] == "Pilot (v2)"

    old = d["active_revision_id"]
    r = c.post(f"/projects/{p['id']}/snapshot", json={"content": "x", "revision_id": old})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "STALE_REVISION"

    fdx = c.get(f"/projects/{p['id']}/fdx").json()
    assert fdx["filename"] == "Pilot (v2).fdx" and "<FinalDraft" in fdx["fdx"]

    assert c.delete(f"/projects/{p['id']}").status_code == 200
    assert c.get(f"/projects/{p['id']}").status_code == 404


def test_rules_from_desktop_shape():
    pid = _seed()
    c = _client()
    sid = c.get(f"/projects/{pid}").json()["active_revision"]["scenes"][0]["id"]
    r = c.put(f"/projects/{pid}/rules", json={
        "dialogue_block_limit": None, "page_limit": 20, "guidance": ["Keep it tense"],
        "protected": [{"scene_id": sid, "offset_in_scene": 0, "length": 5, "label": "x"}]})
    assert r.status_code == 200, r.text
    assert r.json()["protected"][0]["text_hash"]


def test_bad_base64_import_is_400():
    B.fresh_home()
    r = _client().post("/projects", json={"filename": "a.fdx", "content_b64": "!!!"})
    assert r.status_code == 400
