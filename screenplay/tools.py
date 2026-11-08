"""Agent-facing tools for the hermes-screenplay plugin.

Every handler takes the tool's argument dict and returns a JSON string:
``{"success": true, ...}`` on success, or ``{"success": false, "code", "error",
"details"}`` on failure. Handlers are wrapped by :func:`_tool`, which converts
``ServiceError`` (and any unexpected exception) into a structured error result
so a tool call never crashes the agent loop.
"""
from __future__ import annotations

import dataclasses
import json
from typing import Any

from . import models as M
from .runtime import get_service

HERMES_VERSION = M.HERMES_VERSION


# ---- result helpers ---------------------------------------------------------

def _json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


def _ok(**fields: Any) -> str:
    return _json({"success": True, **fields})


def _err(code: str, message: str, details: "dict | None" = None) -> str:
    out: dict[str, Any] = {"success": False, "code": code, "error": message}
    if details:
        out["details"] = details
    return _json(out)


def _dc(obj: Any) -> Any:
    return dataclasses.asdict(obj) if dataclasses.is_dataclass(obj) else obj


def _tool(fn):
    """Wrap a handler so ServiceError / unexpected errors become JSON errors."""
    def wrapper(args: dict, **_kw) -> str:
        try:
            return fn(args or {})
        except M.ServiceError as e:
            return _err(e.code, e.message, e.details or None)
        except Exception as e:  # noqa: BLE001
            return _err("ERR_INTERNAL", f"{type(e).__name__}: {e}")
    return wrapper


def _schema(name: str, description: str, properties: dict, required=None) -> dict:
    params: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        params["required"] = required
    params["additionalProperties"] = False
    return {"name": name, "description": description, "parameters": params}


def _rev_header(r) -> dict:
    """history() returns dicts (see service.history), not dataclasses."""
    return {
        "id": r["id"], "origin": r["origin"], "scene_count": r["scene_count"],
        "content_hash": r["content_hash"], "created_at": r["created_at"],
        "parent_id": r["parent_id"],
    }


# ---- handlers ---------------------------------------------------------------

@_tool
def _status(args):
    svc = get_service()
    projects = svc.list_projects()
    return _ok(plugin="hermes-screenplay", hermes_version=HERMES_VERSION,
               projects=len(projects), project_ids=[p.id for p in projects])


@_tool
def _list_projects(args):
    return _ok(projects=[_dc(p) for p in get_service().list_projects()])


@_tool
def _get_project(args):
    svc = get_service()
    pid = args["project_id"]
    p = svc.get_project(pid)
    rev = svc.read_revision(pid, p.active_revision_id)
    return _ok(project=_dc(p), active_revision=_dc(rev),
               revision_count=len(svc.history(pid)))


@_tool
def _history(args):
    revs = get_service().history(args["project_id"])
    return _ok(revisions=[_rev_header(r) for r in revs])


@_tool
def _read_scene(args):
    scene = get_service().read_scene(args["project_id"], args["revision_id"], args["scene_id"])
    return _ok(scene=_dc(scene))


@_tool
def _import(args):
    svc = get_service()
    p = svc.import_project(args.get("title", ""), args.get("author", ""),
                           args.get("fountain_text", ""))
    return _ok(project=_dc(p))


@_tool
def _propose(args):
    svc = get_service()
    # propose() takes raw operation dicts (it builds Operation objects internally).
    prop = svc.propose(
        args["project_id"], args.get("operations", []),
        base_revision_id=args.get("base_revision_id"),
    )
    return _ok(proposal=_dc(prop))


@_tool
def _check_proposal(args):
    prop = get_service().check_proposal(args["proposal_id"])
    return _ok(proposal=_dc(prop))


@_tool
def _accept_proposal(args):
    rev = get_service().accept_proposal(args["proposal_id"])
    return _ok(revision=_dc(rev))


@_tool
def _reject_proposal(args):
    prop = get_service().reject_proposal(args["proposal_id"], reason=args.get("reason", ""))
    return _ok(proposal=_dc(prop))


@_tool
def _export_pdf(args):
    exp = get_service().export_pdf(args["project_id"], revision_id=args.get("revision_id"))
    # Export is a value object (not a dataclass); pick the fields the client needs.
    return _ok(path=exp.artifact_path, page_count=exp.page_count, status=exp.status,
               export_id=exp.id, revision_id=exp.revision_id)


@_tool
def _restore(args):
    svc = get_service()
    rev = svc.restore_snapshot(args["project_id"], args["revision_id"])
    return _ok(revision=_dc(rev),
               history=[_rev_header(r) for r in svc.history(args["project_id"])])


@_tool
def _undo(args):
    svc = get_service()
    rev = svc.undo_latest(args["project_id"])
    return _ok(revision=_dc(rev))


# ---- schemas + registry -----------------------------------------------------

_OP_ITEM = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["insert", "replace"]},
        "scene_id": {"type": "string"},
        "before_scene_id": {"type": "string"},
        "heading": {"type": "string"},
        "content": {"type": "string"},
    },
    "required": ["type"],
}

TOOLS = [
    ("screenplay_status",
     _schema("screenplay_status",
             "Read-only status of the screenplay plugin: backend liveness, active "
             "Hermes version, and the count + ids of all projects.", {}),
     _status, "🎬"),
    ("screenplay_list_projects",
     _schema("screenplay_list_projects",
             "List all screenplay projects (id, title, author, active revision).", {}),
     _list_projects, "📚"),
    ("screenplay_get_project",
     _schema("screenplay_get_project",
             "Full detail for one project: header, active revision with its scenes, "
             "and revision count.",
             {"project_id": {"type": "string"}}, required=["project_id"]),
     _get_project, "📄"),
    ("screenplay_history",
     _schema("screenplay_history",
             "Revision history for a project (newest first).",
             {"project_id": {"type": "string"}}, required=["project_id"]),
     _history, "🕘"),
    ("screenplay_read_scene",
     _schema("screenplay_read_scene",
             "Read one scene (heading + ordered elements) from a revision.",
             {"project_id": {"type": "string"}, "revision_id": {"type": "string"},
              "scene_id": {"type": "string"}},
             required=["project_id", "revision_id", "scene_id"]),
     _read_scene, "🎭"),
    ("screenplay_import",
     _schema("screenplay_import",
             "Import Fountain text as a new project with a v1 revision.",
             {"title": {"type": "string"}, "author": {"type": "string"},
              "fountain_text": {"type": "string"}}, required=["fountain_text"]),
     _import, "📥"),
    ("screenplay_propose",
     _schema("screenplay_propose",
             "Propose scene insert/replace operations against the active revision. "
             "Returns a proposal to check, then accept or reject.",
             {"project_id": {"type": "string"},
              "operations": {"type": "array", "items": _OP_ITEM},
              "base_revision_id": {"type": "string"}},
             required=["project_id", "operations"]),
     _propose, "✏️"),
    ("screenplay_check_proposal",
     _schema("screenplay_check_proposal",
             "Run deterministic validation checks on a pending proposal and return "
             "the findings.",
             {"proposal_id": {"type": "string"}}, required=["proposal_id"]),
     _check_proposal, "🔍"),
    ("screenplay_accept_proposal",
     _schema("screenplay_accept_proposal",
             "Accept a proposal: applies its operations atomically and creates the "
             "new revision.",
             {"proposal_id": {"type": "string"}}, required=["proposal_id"]),
     _accept_proposal, "✅"),
    ("screenplay_reject_proposal",
     _schema("screenplay_reject_proposal",
             "Reject a pending proposal (no revision is created).",
             {"proposal_id": {"type": "string"}, "reason": {"type": "string"}},
             required=["proposal_id"]),
     _reject_proposal, "❌"),
    ("screenplay_export_pdf",
     _schema("screenplay_export_pdf",
             "Export a revision (default: active) to a stdlib-rendered PDF. Returns "
             "the file path.",
             {"project_id": {"type": "string"}, "revision_id": {"type": "string"}},
             required=["project_id"]),
     _export_pdf, "📄"),
    ("screenplay_restore",
     _schema("screenplay_restore",
             "Restore an earlier snapshot as a NEW active revision. The current head "
             "is preserved in history; scene ids stay stable.",
             {"project_id": {"type": "string"}, "revision_id": {"type": "string"}},
             required=["project_id", "revision_id"]),
     _restore, "⏪"),
    ("screenplay_undo",
     _schema("screenplay_undo",
             "Undo the latest change against an unchanged head: create a new active "
             "revision whose content is the state before the latest change.",
             {"project_id": {"type": "string"}}, required=["project_id"]),
     _undo, "↩️"),
]
