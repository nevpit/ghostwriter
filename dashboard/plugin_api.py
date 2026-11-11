"""Dashboard API for the ghostwriter plugin.

This module is **exec'd** (not imported) in the Hermes web-server process. It
must expose a module-level ``router`` (a FastAPI ``APIRouter``); the web server
mounts it at ``/api/plugins/ghostwriter/<route>``.

The desktop pane reaches these routes through ``window.hermesDesktop.api``,
which injects the gateway ticket and returns the unwrapped JSON body, so
handlers return bare objects/arrays; errors raise ``HTTPException`` with a
structured ``detail`` (``{"code", "message", "details"}``).
"""
from __future__ import annotations

import base64
import binascii
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from fastapi import APIRouter, HTTPException, Request, Response  # noqa: E402

from screenplay import models as M  # noqa: E402
from screenplay import rendering  # noqa: E402
from screenplay.runtime import get_service  # noqa: E402

router = APIRouter()

_STATUS = {M.ERR_PROJECT_NOT_FOUND: 404, M.ERR_REVISION_NOT_FOUND: 404,
           M.ERR_SCENE_NOT_FOUND: 404, M.ERR_STALE_REVISION: 409, M.ERR_CONFLICT: 409}


def _dc(obj: Any) -> Any:
    return asdict(obj) if hasattr(obj, "__dataclass_fields__") else obj


def _guard(fn, *a, **k):
    try:
        return fn(*a, **k)
    except M.ServiceError as e:
        raise HTTPException(status_code=_STATUS.get(e.code, 400),
                            detail={"code": e.code, "message": e.message, "details": e.details}) from e


async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _bad(message: str, code: str = "INVALID_BODY"):
    raise HTTPException(status_code=400, detail={"code": code, "message": message, "details": None})


def _rev_out(rev: M.Revision) -> dict:
    return {"id": rev.id, "project_id": rev.project_id, "parent_id": rev.parent_id,
            "origin": rev.origin, "created_at": rev.created_at, "scene_count": len(rev.scenes)}


@router.get("/status")
def status():
    projects = get_service().list_projects()
    return {"plugin": "ghostwriter", "hermes_version": M.HERMES_VERSION, "projects": len(projects)}


@router.get("/projects")
def list_projects():
    return [_dc(p) for p in _guard(get_service().list_projects)]


@router.post("/projects")
async def create_project(request: Request):
    """Create a project. Body: ``{title, author?, fountain_text?}`` or an
    uploaded file ``{filename, content_b64, title?, author?}``."""
    body = await _body(request)
    svc = get_service()
    if body.get("content_b64"):
        try:
            content = base64.b64decode(body["content_b64"], validate=True)
        except (binascii.Error, ValueError) as exc:
            _bad(f"content_b64 is not valid base64: {exc}", "IMPORT_BAD_BODY")
        p = _guard(svc.import_file, body.get("filename", ""), content,
                   body.get("title", ""), body.get("author", ""), format=body.get("format"))
    else:
        p = _guard(svc.create_project, body.get("title", ""), body.get("author", ""),
                   body.get("fountain_text", ""), body.get("format"))
    return _dc(p)


@router.get("/projects/{project_id}")
def get_project(project_id: str):
    svc = get_service()
    p = _guard(svc.get_project, project_id)
    rev = _guard(svc.read_revision, project_id, p.active_revision_id)
    doc = _guard(svc.document, project_id, rev.id)
    rules = svc.repo.get_rules(p.active_rules_id)
    return {
        "project": _dc(p),
        "active_revision_id": rev.id,
        "active_revision": {
            **_rev_out(rev), "snapshot": rev.snapshot,
            "scenes": [{**_dc(sc), "text": sc.text(rev.snapshot)} for sc in rev.scenes],
        },
        "title_page": doc["title_page"],
        "preamble": doc["preamble"],
        "problems": doc["problems"],
        "page_count": rendering.count_pages(rev.snapshot, svc.settings),
        "revision_count": len(svc.repo.revision_headers(project_id)),
        "rules": {"id": rules.id, **rules.to_dict()} if rules else None,
    }


@router.delete("/projects/{project_id}")
def delete_project(project_id: str):
    _guard(get_service().delete_project, project_id)
    return {"deleted": project_id}


@router.get("/projects/{project_id}/history")
def history(project_id: str):
    return list(reversed(_guard(get_service().history, project_id)))


@router.get("/projects/{project_id}/proposals")
def list_proposals(project_id: str):
    # Summaries only: the full candidate text is fetched per proposal.
    out = []
    for prop in _guard(get_service().list_proposals, project_id):
        d = prop.to_dict()
        d.pop("candidate_snapshot", None)
        out.append(d)
    return out


@router.get("/proposals/{proposal_id}")
def proposal_view(proposal_id: str):
    view = _guard(get_service().proposal_view, proposal_id)
    view.pop("candidate_snapshot", None)
    return view


@router.post("/proposals/{proposal_id}/check")
def check(proposal_id: str):
    d = _dc(_guard(get_service().check_proposal, proposal_id))
    d.pop("candidate_snapshot", None)
    return d


@router.post("/proposals/{proposal_id}/accept")
def accept(proposal_id: str):
    return _rev_out(_guard(get_service().accept_proposal, proposal_id))


@router.post("/proposals/{proposal_id}/reject")
async def reject(proposal_id: str, request: Request):
    body = await _body(request)
    prop = _guard(get_service().reject_proposal, proposal_id, reason=body.get("reason", ""))
    return {"id": prop.id, "status": prop.status}


@router.post("/projects/{project_id}/propose")
async def propose(project_id: str, request: Request):
    body = await _body(request)
    prop = _guard(get_service().propose, project_id, body.get("operations", []),
                  base_revision_id=body.get("base_revision_id"), rules_id=body.get("rules_id"),
                  idempotency_key=body.get("idempotency_key"))
    d = _dc(prop)
    d.pop("candidate_snapshot", None)
    return d


@router.post("/projects/{project_id}/scenes/{scene_id}")
async def save_scene(project_id: str, scene_id: str, request: Request):
    """Body: ``{"content": str, "heading"?: str, "revision_id"?: str}``."""
    body = await _body(request)
    svc = get_service()
    expected = body.get("revision_id")
    heading = body.get("heading")
    if heading is None:
        heading = _guard(svc.read_scene, project_id, expected, scene_id)["heading"]
    return _rev_out(_guard(svc.save_scene, project_id, scene_id, heading,
                           body.get("content", ""), expected))


@router.post("/projects/{project_id}/snapshot")
async def save_snapshot(project_id: str, request: Request):
    """Save the full Fountain text. ``revision_id`` is the expected active
    revision (a stale base returns 409 STALE_REVISION)."""
    body = await _body(request)
    if not isinstance(body.get("content"), str):
        _bad("content (the full Fountain text) is required")
    return _rev_out(_guard(get_service().save_snapshot, project_id, body["content"],
                           body.get("revision_id")))


@router.put("/projects/{project_id}/title-page")
async def set_title_page(project_id: str, request: Request):
    body = await _body(request)
    fields = body.get("fields")
    if not isinstance(fields, (dict, list)):
        _bad("fields must be an object or a list of [key, value] pairs")
    return _rev_out(_guard(get_service().set_title_page, project_id, fields, body.get("revision_id")))


@router.post("/projects/{project_id}/replace")
async def replace(project_id: str, request: Request):
    body = await _body(request)
    return _guard(get_service().find_replace, project_id, body.get("query", ""),
                  body.get("replacement", ""), body.get("target", "all"), body.get("revision_id"))


@router.put("/projects/{project_id}/rules")
async def update_rules(project_id: str, request: Request):
    """Body: any subset of dialogue_block_limit, page_limit, allowed_speakers,
    protected, guidance, limits (null clears a limit)."""
    body = await _body(request)
    allowed = {"dialogue_block_limit", "page_limit", "allowed_speakers", "protected",
               "guidance", "limits"}
    changes = {k: v for k, v in body.items() if k in allowed}
    if not changes:
        _bad("no rule fields supplied")
    rv = _guard(get_service().update_rules, project_id, **changes)
    return {"id": rv.id, **rv.to_dict()}


@router.post("/projects/{project_id}/restore")
async def restore(project_id: str, request: Request):
    body = await _body(request)
    if not body.get("revision_id"):
        _bad("revision_id is required")
    return _rev_out(_guard(get_service().restore_snapshot, project_id, body["revision_id"]))


@router.post("/projects/{project_id}/undo")
def undo(project_id: str):
    return _rev_out(_guard(get_service().undo_latest, project_id))


def _disposition(filename: str) -> str:
    ascii_name = filename.encode("ascii", "replace").decode().replace('"', "'")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


@router.get("/projects/{project_id}/pdf")
def export_pdf(project_id: str, revision_id: Optional[str] = None):
    svc = get_service()
    exp = _guard(svc.export_pdf, project_id, revision_id=revision_id)
    return Response(content=Path(exp.artifact_path).read_bytes(), media_type="application/pdf",
                    headers={"Content-Disposition": _disposition(svc.pdf_filename(project_id))})


@router.get("/projects/{project_id}/pdf/meta")
def export_pdf_meta(project_id: str, revision_id: Optional[str] = None):
    """Render the PDF and return its location (the desktop reads the file via
    the bridge's ``readFileDataUrl``; the ``api`` bridge is JSON-only)."""
    svc = get_service()
    exp = _guard(svc.export_pdf, project_id, revision_id=revision_id)
    path = Path(exp.artifact_path)
    return {"id": exp.id, "revision_id": exp.revision_id, "status": exp.status,
            "path": exp.artifact_path, "filename": svc.pdf_filename(project_id),
            "size_bytes": path.stat().st_size if path.exists() else None,
            "page_count": exp.page_count}


@router.get("/projects/{project_id}/fountain")
def export_fountain(project_id: str, revision_id: Optional[str] = None):
    return _guard(get_service().export_fountain, project_id, revision_id)


@router.get("/projects/{project_id}/fdx")
def export_fdx(project_id: str, revision_id: Optional[str] = None):
    return _guard(get_service().export_fdx, project_id, revision_id)
