"""Agent-facing tools for the ghostwriter plugin.

Every handler takes the tool's argument dict and returns a JSON string:
``{"success": true, ...}`` or ``{"success": false, "code", "error", "details"}``.
Handlers are wrapped by :func:`_tool`, so a tool call never crashes the agent
loop. Results are kept compact (no full snapshots unless asked for) because
everything a tool returns lands in the model's context.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import models as M
from .runtime import get_service

HERMES_VERSION = M.HERMES_VERSION


# ---- result helpers ---------------------------------------------------------

def _ok(**fields: Any) -> str:
    return json.dumps({"success": True, **fields}, ensure_ascii=False, default=str)


def _err(code: str, message: str, details: "dict | None" = None) -> str:
    out: dict = {"success": False, "code": code, "error": message}
    if details:
        out["details"] = details
    return json.dumps(out, ensure_ascii=False, default=str)


def _tool(fn):
    def wrapper(args: dict, **_kw) -> str:
        try:
            return fn(args or {})
        except M.ServiceError as e:
            return _err(e.code, e.message, e.details or None)
        except KeyError as e:
            return _err(M.ERR_VALIDATION, f"missing required argument {e}")
        except Exception as e:  # noqa: BLE001
            return _err("ERR_INTERNAL", f"{type(e).__name__}: {e}")
    wrapper.__name__ = fn.__name__
    return wrapper


def _schema(name: str, description: str, properties: dict, required=None) -> dict:
    params: dict = {"type": "object", "properties": properties, "additionalProperties": False}
    if required:
        params["required"] = required
    return {"name": name, "description": description, "parameters": params}


def _project(p: M.Project) -> dict:
    return {"id": p.id, "title": p.title, "author": p.author, "format": p.format,
            "active_revision_id": p.active_revision_id, "updated_at": p.updated_at}


def _proposal(prop: M.Proposal, **extra) -> dict:
    return {"id": prop.id, "status": prop.status, "base_revision_id": prop.base_revision_id,
            "checks": [c.to_dict() for c in prop.checks],
            "changes": [d for d in prop.diff if d.get("status") != "unchanged"], **extra}


def _revision(svc, project_id: str, rev: M.Revision) -> dict:
    o = svc.outline(project_id, rev.id)
    return {"revision_id": rev.id, "scene_count": len(o["scenes"]), "page_count": o["page_count"]}


# ---- handlers ---------------------------------------------------------------

@_tool
def _status(args):
    projects = get_service().list_projects()
    return _ok(plugin="ghostwriter", hermes_version=HERMES_VERSION, projects=len(projects))


@_tool
def _list_projects(args):
    return _ok(projects=[_project(p) for p in get_service().list_projects()])


@_tool
def _create_project(args):
    svc = get_service()
    p = svc.create_project(args.get("title", ""), args.get("author", ""),
                           args.get("fountain_text", ""))
    o = svc.outline(p.id)
    return _ok(project=_project(p), scenes=o["scenes"], page_count=o["page_count"],
               problems=o["problems"])


@_tool
def _get_project(args):
    svc = get_service()
    pid = args["project_id"]
    p = svc.get_project(pid)
    o = svc.outline(pid)
    rules = svc.repo.get_rules(p.active_rules_id)
    pending = [x.id for x in svc.list_proposals(pid) if x.status in (M.PENDING, M.BLOCKED)]
    return _ok(project=_project(p), outline=o, pending_proposals=pending,
               rules=rules.to_dict() if rules else None)


@_tool
def _read_script(args):
    out = get_service().read_script(args["project_id"], args.get("scene_ids") or None,
                                    args.get("revision_id"))
    return _ok(**out)


@_tool
def _read_scene(args):
    scene = get_service().read_scene(args["project_id"], args.get("revision_id"), args["scene_id"])
    return _ok(scene=scene)


@_tool
def _history(args):
    svc = get_service()
    revs = list(reversed(svc.history(args["project_id"])))
    limit = int(args.get("limit") or 20)
    return _ok(revisions=revs[:limit], total=len(revs))


@_tool
def _propose(args):
    svc = get_service()
    pid = args["project_id"]
    prop = svc.propose(pid, args.get("operations"), base_revision_id=args.get("base_revision_id"))
    if args.get("apply") and prop.status == M.PENDING:
        rev = svc.accept_proposal(prop.id)
        return _ok(applied=True, proposal=_proposal(svc.get_proposal(prop.id)),
                   **_revision(svc, pid, rev))
    hint = None
    if prop.status == M.BLOCKED:
        hint = "Blocked by a failed check; fix the operations and propose again."
    return _ok(applied=False, proposal=_proposal(prop, hint=hint) if hint else _proposal(prop))


@_tool
def _check_proposal(args):
    return _ok(proposal=_proposal(get_service().check_proposal(args["proposal_id"])))


@_tool
def _accept_proposal(args):
    svc = get_service()
    rev = svc.accept_proposal(args["proposal_id"])
    return _ok(**_revision(svc, rev.project_id, rev))


@_tool
def _reject_proposal(args):
    prop = get_service().reject_proposal(args["proposal_id"], reason=args.get("reason", ""))
    return _ok(proposal={"id": prop.id, "status": prop.status})


@_tool
def _set_title_page(args):
    svc = get_service()
    fields = args.get("fields")
    if not isinstance(fields, dict):
        raise M.ServiceError(M.ERR_VALIDATION, "fields must be an object, e.g. {\"Title\": \"...\"}")
    rev = svc.set_title_page(args["project_id"], fields, origin=M.ORIGIN_ASSISTANT)
    return _ok(title_page=svc.outline(args["project_id"])["title_page"], revision_id=rev.id)


@_tool
def _update_rules(args):
    svc = get_service()
    changes = {k: args[k] for k in ("page_limit", "dialogue_block_limit", "allowed_speakers",
                                     "guidance") if k in args}
    if not changes:
        raise M.ServiceError(M.ERR_VALIDATION, "no rule fields supplied")
    rv = svc.update_rules(args["project_id"], **changes)
    return _ok(rules={"id": rv.id, **rv.to_dict()})


@_tool
def _find_replace(args):
    out = get_service().find_replace(args["project_id"], args.get("query", ""),
                                     args.get("replacement", ""), args.get("target", "all"),
                                     revision_id=args.get("revision_id"), origin=M.ORIGIN_ASSISTANT)
    return _ok(**out)


@_tool
def _export(args):
    svc = get_service()
    pid = args["project_id"]
    fmt = (args.get("format") or "pdf").lower()
    if fmt == "pdf":
        exp = svc.export_pdf(pid, revision_id=args.get("revision_id"))
        return _ok(format="pdf", path=exp.artifact_path, page_count=exp.page_count,
                   revision_id=exp.revision_id)
    if fmt not in ("fountain", "fdx"):
        raise M.ServiceError(M.ERR_VALIDATION, "format must be pdf, fountain or fdx")
    data = svc.export_fountain(pid, args.get("revision_id")) if fmt == "fountain" \
        else svc.export_fdx(pid, args.get("revision_id"))
    if svc.exports_dir is None:
        raise M.ServiceError(M.ERR_RENDERER_UNAVAILABLE, "no export directory configured")
    path = Path(svc.exports_dir) / f"{data['revision_id']}.{fmt}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data[fmt], encoding="utf-8")
    return _ok(format=fmt, path=str(path), filename=data["filename"], revision_id=data["revision_id"])


@_tool
def _restore(args):
    svc = get_service()
    rev = svc.restore_snapshot(args["project_id"], args["revision_id"])
    return _ok(**_revision(svc, args["project_id"], rev))


@_tool
def _undo(args):
    svc = get_service()
    rev = svc.undo_latest(args["project_id"])
    return _ok(**_revision(svc, args["project_id"], rev))


# ---- schemas + registry -----------------------------------------------------

_S = {"type": "string"}
_PID = {"project_id": _S}

_OP_ITEM = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["insert", "replace", "delete"],
                 "description": "insert a new scene, replace an existing scene, or delete one"},
        "scene_id": {"type": "string", "description": "target scene (replace/delete)"},
        "before_scene_id": {"type": "string",
                            "description": "insert before this scene; omit to append at the end"},
        "heading": {"type": "string", "description": "scene heading, e.g. 'INT. KITCHEN - NIGHT'"},
        "content": {"type": "string",
                    "description": "the scene body in Fountain (everything after the heading). "
                                   "May contain additional scenes, each starting with its own heading."},
    },
    "required": ["type"],
    "additionalProperties": False,
}

TOOLS = [
    ("ghost_status",
     _schema("ghost_status", "Ghostwriter plugin status: Hermes version and project count.", {}),
     _status, "🎬"),
    ("ghost_list_projects",
     _schema("ghost_list_projects", "List screenplay projects (id, title, author).", {}),
     _list_projects, "📚"),
    ("ghost_create_project",
     _schema("ghost_create_project",
             "Create a new screenplay project. Optionally seed it with Fountain text; a title page "
             "is added from title/author when the text has none. Returns the scene outline.",
             {"title": _S, "author": _S,
              "fountain_text": {"type": "string", "description": "optional initial Fountain script"}},
             required=["title"]),
     _create_project, "📥"),
    ("ghost_get_project",
     _schema("ghost_get_project",
             "Compact overview of a project: title page, scene list (id, heading, characters, word "
             "count), page count, pending proposals and rules. Use ghost_read_script/ghost_read_scene "
             "for the text.",
             _PID, required=["project_id"]),
     _get_project, "📄"),
    ("ghost_read_script",
     _schema("ghost_read_script",
             "Read the Fountain text of the whole script, or of selected scenes (each prefixed with "
             "its scene id).",
             {**_PID, "scene_ids": {"type": "array", "items": _S}, "revision_id": _S},
             required=["project_id"]),
     _read_script, "📖"),
    ("ghost_read_scene",
     _schema("ghost_read_scene",
             "Read one scene: its Fountain text and typed elements (scene_heading, action, character, "
             "parenthetical, dialogue, transition, ...). revision_id defaults to the active revision.",
             {**_PID, "scene_id": _S, "revision_id": _S}, required=["project_id", "scene_id"]),
     _read_scene, "🎭"),
    ("ghost_propose",
     _schema("ghost_propose",
             "Write, rewrite, insert or delete scenes. Runs deterministic checks (Fountain parse, "
             "protected passages, allowed speakers, limits). With apply=true a passing proposal is "
             "accepted immediately (the user can still undo); otherwise it waits for the user to "
             "accept it in the Proposals tab.",
             {**_PID, "operations": {"type": "array", "items": _OP_ITEM, "minItems": 1},
              "apply": {"type": "boolean", "description": "accept immediately if all checks pass"},
              "base_revision_id": _S},
             required=["project_id", "operations"]),
     _propose, "✏️"),
    ("ghost_check_proposal",
     _schema("ghost_check_proposal", "Re-run the checks on a pending proposal.",
             {"proposal_id": _S}, required=["proposal_id"]),
     _check_proposal, "🔍"),
    ("ghost_accept_proposal",
     _schema("ghost_accept_proposal",
             "Accept a proposal: creates the new active revision. If the script changed meanwhile, "
             "the edit is replayed onto the current text unless a touched scene was edited.",
             {"proposal_id": _S}, required=["proposal_id"]),
     _accept_proposal, "✅"),
    ("ghost_reject_proposal",
     _schema("ghost_reject_proposal", "Reject a pending proposal (no revision is created).",
             {"proposal_id": _S, "reason": _S}, required=["proposal_id"]),
     _reject_proposal, "❌"),
    ("ghost_set_title_page",
     _schema("ghost_set_title_page",
             "Replace the title page. fields is an object such as {\"Title\": \"...\", \"Credit\": "
             "\"Written by\", \"Author\": \"...\", \"Source\": \"...\", \"Draft date\": \"...\", "
             "\"Contact\": \"line 1\\nline 2\"}. Saved directly as a new revision.",
             {**_PID, "fields": {"type": "object", "additionalProperties": {"type": "string"}}},
             required=["project_id", "fields"]),
     _set_title_page, "🏷️"),
    ("ghost_update_rules",
     _schema("ghost_update_rules",
             "Set project rules enforced on every proposal: page_limit (max pages), "
             "dialogue_block_limit (max speeches in the whole script), allowed_speakers (list of "
             "names; null = anyone), guidance (editorial notes for you to follow).",
             {**_PID, "page_limit": {"type": ["integer", "null"]},
              "dialogue_block_limit": {"type": ["integer", "null"]},
              "allowed_speakers": {"type": ["array", "null"], "items": _S},
              "guidance": {"type": "array", "items": _S}},
             required=["project_id"]),
     _update_rules, "📏"),
    ("ghost_find_replace",
     _schema("ghost_find_replace",
             "Case-insensitive find & replace across the script that preserves Fountain structure "
             "(character cues and headings stay upper-case; other text mirrors the original case). "
             "Best tool for renaming a character or place. Saved directly as a new revision. "
             "target is 'all' (default) or a 0-based match index.",
             {**_PID, "query": _S, "replacement": _S, "target": _S, "revision_id": _S},
             required=["project_id", "query", "replacement"]),
     _find_replace, "🔁"),
    ("ghost_history",
     _schema("ghost_history", "Revision history, newest first.",
             {**_PID, "limit": {"type": "integer"}}, required=["project_id"]),
     _history, "🕘"),
    ("ghost_restore",
     _schema("ghost_restore",
             "Restore an earlier revision as a new active revision (nothing is deleted).",
             {**_PID, "revision_id": _S}, required=["project_id", "revision_id"]),
     _restore, "⏪"),
    ("ghost_undo",
     _schema("ghost_undo", "Undo the latest change (creates a new revision equal to the previous one).",
             _PID, required=["project_id"]),
     _undo, "↩️"),
    ("ghost_export",
     _schema("ghost_export",
             "Export the script to a file: pdf (industry-standard screenplay layout), fountain, or "
             "fdx (Final Draft). Returns the file path (and page count for PDF).",
             {**_PID, "format": {"type": "string", "enum": ["pdf", "fountain", "fdx"]},
              "revision_id": _S},
             required=["project_id"]),
     _export, "📤"),
]
