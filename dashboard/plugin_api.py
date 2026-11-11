"""Dashboard API for the ghostwriter plugin.

This module is **exec'd** (not imported) in the Hermes web-server process. It
must expose a module-level ``router`` (a FastAPI ``APIRouter``); the web server
mounts it at ``/api/plugins/ghostwriter/<route>``.

The desktop pane (``desktop/plugin.js``) reaches these routes through the
authenticated desktop API bridge (``window.hermesDesktop.api``), which injects
the gateway ticket automatically and returns the unwrapped JSON body. Handlers
therefore return the data object/array directly; errors raise ``HTTPException``
with a structured ``detail`` (mirroring the agent tools' ``code`` vocabulary).

The same process-wide service instance used by the agent tools is reused here,
so tools and the workspace always see identical state.
"""
from __future__ import annotations

import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

# plugin_api.py lives in dashboard/; the screenplay service package is the
# plugin root one level up. The loader already puts the plugin dir on
# sys.path, but adding it here keeps the module robust to how it is exec'd.
_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from fastapi import APIRouter, HTTPException, Request, Response  # noqa: E402

from screenplay import models as M  # noqa: E402
from screenplay.runtime import get_service  # noqa: E402

router = APIRouter()


def _dc(obj: Any) -> Any:
    return asdict(obj) if hasattr(obj, "__dataclass_fields__") else obj


def _http(e: M.ServiceError) -> HTTPException:
    status = 404 if "NOT_FOUND" in (e.code or "").upper() else 400
    return HTTPException(status_code=status,
                         detail={"code": e.code, "message": e.message, "details": e.details})


def _guard(fn, *a, **k):
    try:
        return fn(*a, **k)
    except M.ServiceError as e:
        raise _http(e) from e


@router.get("/status")
def status():
    projects = get_service().list_projects()
    return {"plugin": "ghostwriter",
            "hermes_version": M.HERMES_VERSION,
            "projects": len(projects),
            "project_ids": [p.id for p in projects]}


@router.get("/projects")
def list_projects():
    return [_dc(p) for p in _guard(get_service().list_projects)]


@router.get("/projects/{project_id}")
def get_project(project_id: str):
    svc = get_service()
    p = _guard(svc.get_project, project_id)
    rev = _guard(svc.read_revision, project_id, p.active_revision_id)
    hist = _guard(svc.history, project_id)
    rules = None
    if p.active_rules_id:
        r = svc.repo.get_rules(p.active_rules_id)
        if r is not None:
            rules = {"id": r.id, **r.to_dict()}
    # ``Scene.text`` is a method (sliced from the snapshot), so ``asdict``
    # drops it; compute the raw text explicitly for clients (the Desktop
    # editor seeds from it).
    rev_dict = _dc(rev)
    rev_dict["scenes"] = [
        {**s, "text": sc.text(rev.snapshot)}
        for s, sc in zip(rev_dict["scenes"], rev.scenes)
    ]
    return {"project": _dc(p), "active_revision": rev_dict,
            "active_revision_id": p.active_revision_id, "revision_count": len(hist),
            "rules": rules}


@router.get("/projects/{project_id}/history")
def history(project_id: str):
    # service.history() returns dicts, not dataclasses.
    revs = _guard(get_service().history, project_id)
    return [{"id": r["id"], "parent_id": r["parent_id"], "origin": r["origin"],
             "content_hash": r["content_hash"], "created_at": r["created_at"],
             "scene_count": r["scene_count"], "is_active": r["is_active"]} for r in revs]


@router.get("/projects/{project_id}/proposals")
def list_proposals(project_id: str):
    return [_dc(p) for p in _guard(get_service().list_proposals, project_id)]


@router.get("/proposals/{proposal_id}")
def proposal_view(proposal_id: str):
    """Proposal detail with backend-generated before/after scene text."""
    return _guard(get_service().proposal_view, proposal_id)


@router.post("/projects/{project_id}/scenes/{scene_id}")
async def save_scene(project_id: str, scene_id: str, request: Request):
    """Manual scene save: stores a new (active) revision.

    Body: ``{"content": str, "heading"?: str, "revision_id"?: str}``. The
    ``revision_id`` is the expected revision for optimistic concurrency;
    a mismatch raises STALE_REVISION and the scene text is left untouched.
    """
    body = await request.json()
    svc = get_service()
    expected = body.get("revision_id")
    cur = _guard(svc.read_scene, project_id, expected, scene_id)
    heading = body.get("heading") or cur["heading"]
    rev = _guard(svc.save_scene, project_id, scene_id, heading,
                 body.get("content", ""), expected)
    return _dc(rev)


@router.post("/projects/{project_id}/snapshot")
async def save_snapshot_endpoint(project_id: str, request: Request):
    """Replace a revision's full snapshot (the raw Fountain source). Used by the
    desktop find & replace, which edits the raw source directly. ``revision_id``
    pins the expected active revision (optimistic concurrency — a stale base is
    rejected with STALE_REVISION)."""
    body = await request.json()
    rev = _guard(get_service().save_snapshot, project_id, body["content"], body.get("revision_id"))
    return _dc(rev)


@router.post("/projects/{project_id}/replace")
async def replace_endpoint(project_id: str, request: Request):
    """Structure-aware find & replace. Replaces occurrences of ``query``
    (case-insensitive) with ``replacement`` at the element level so Fountain
    formatting -- all-caps character cues, scene headings, etc. -- is never
    broken. ``target`` is either ``"all"`` or a 0-based global match index
    (the client's highlighted hit, which matches the document order used
    here). A matching character-cue name is uppercased so the cue survives
    re-parse. Returns the new revision id and the number replaced."""
    body = await request.json()
    out = _guard(get_service().find_replace, project_id,
                 body.get("query", ""), body.get("replacement", ""),
                 body.get("target"), body.get("revision_id"))
    return _dc(out)


@router.put("/projects/{project_id}/rules")
async def update_rules(project_id: str, request: Request):
    """Create a new (active) rules version.

    Body: any subset of ``dialogue_block_limit``, ``page_limit``,
    ``allowed_speakers``, ``protected``, ``guidance``.
    """
    body = await request.json()
    allowed = {"dialogue_block_limit", "page_limit", "allowed_speakers",
               "protected", "guidance", "limits"}
    changes = {k: v for k, v in body.items() if k in allowed and v is not None}
    if not changes:
        raise HTTPException(status_code=400, detail={
            "code": "INVALID_BODY", "message": "no rule fields supplied",
            "details": None})
    rv = _guard(get_service().update_rules, project_id, **changes)
    return {"id": rv.id, **rv.to_dict()}


@router.post("/projects")
async def import_project(request: Request):
    body = await request.json()
    if body.get("content_b64"):
        # Multi-format import: the client uploads raw file bytes (base64) + the
        # original filename; the service detects the format (Fountain/text/FDX/PDF)
        # and converts it to Fountain.
        import base64
        try:
            content = base64.b64decode(body["content_b64"])
        except Exception as exc:
            raise HTTPException(status_code=400, detail={
                "code": "IMPORT_BAD_BODY", "message": "content_b64 is not valid base64",
                "details": {"error": str(exc)}})
        p = _guard(get_service().import_file,
                   body.get("filename", ""), content,
                   body.get("title", ""), body.get("author", ""),
                   format=body.get("format"))
    else:
        p = _guard(get_service().import_project,
                   body.get("title", ""), body.get("author", ""),
                   body.get("fountain_text", ""), body.get("format"))
    return _dc(p)


@router.post("/projects/{project_id}/propose")
async def propose(project_id: str, request: Request):
    body = await request.json()
    # propose() takes raw operation dicts (it builds Operation objects internally).
    # base_revision_id is optional: when given, the proposal is based on that
    # (possibly stale) revision; when omitted it defaults to the active one.
    prop = _guard(
        get_service().propose, project_id,
        body.get("operations", []),
        base_revision_id=body.get("base_revision_id"),
        rules_id=body.get("rules_id"),
        idempotency_key=body.get("idempotency_key"),
    )
    return _dc(prop)


@router.post("/proposals/{proposal_id}/check")
def check(proposal_id: str):
    return _dc(_guard(get_service().check_proposal, proposal_id))


@router.post("/proposals/{proposal_id}/accept")
def accept(proposal_id: str):
    return _dc(_guard(get_service().accept_proposal, proposal_id))


@router.post("/proposals/{proposal_id}/reject")
async def reject(proposal_id: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    return _dc(_guard(get_service().reject_proposal, proposal_id,
                      reason=body.get("reason", "")))


@router.post("/projects/{project_id}/restore")
async def restore(project_id: str, request: Request):
    body = await request.json()
    rev = _guard(get_service().restore_snapshot, project_id, body["revision_id"])
    return _dc(rev)


@router.post("/projects/{project_id}/undo")
def undo(project_id: str):
    return _dc(_guard(get_service().undo_latest, project_id))


@router.get("/projects/{project_id}/pdf")
def export_pdf(project_id: str, revision_id: Optional[str] = None):
    exp = _guard(get_service().export_pdf, project_id, revision_id=revision_id)
    data = Path(exp.artifact_path).read_bytes()
    filename = Path(exp.artifact_path).name
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/projects/{project_id}/pdf/meta")
def export_pdf_meta(project_id: str, revision_id: Optional[str] = None):
    """Render the PDF and return its location as JSON (no binary body).

    The Desktop pane uses this + the bridge's ``readFileDataUrl`` for embedded
    viewing and an explicit download action (the ``api`` bridge is JSON-only).
    """
    exp = _guard(get_service().export_pdf, project_id, revision_id=revision_id)
    path = Path(exp.artifact_path)
    return {"id": exp.id, "revision_id": exp.revision_id, "status": exp.status,
            "path": exp.artifact_path, "filename": path.name,
            "size_bytes": path.stat().st_size if path.exists() else None,
            "page_count": exp.page_count}


@router.get("/projects/{project_id}/fountain")
def export_fountain(project_id: str, revision_id: Optional[str] = None):
    """Serialize a revision to Fountain text (JSON body with the ``fountain``
    text + a suggested ``.fountain`` filename). The Desktop pane turns this
    into a file download so the script can be opened in Fountain/Final Draft."""
    return _guard(get_service().export_fountain, project_id, revision_id)
