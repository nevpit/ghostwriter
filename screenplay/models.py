"""Data model for the screenplay service.

In-memory dataclasses mirroring the persistent entities. The repository layer
serializes these to/from SQLite; the service layer orchestrates them.

The data model is defined by the product specification (IMPLEMENTATION_PLAN.md,
"Data and revision model"). Revisions are immutable complete Fountain snapshots;
scene identity is a stable opaque id that survives a scene's replacement, and
``order`` is display data, not identity.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Any, List, Optional

# Hermes version this plugin is built and tested against (v0.22.7, 2026.9.24).
# Single source of truth: both the agent tools and the dashboard report this.
HERMES_VERSION = "0.22.7"

# --- Status / enum vocabulary ---------------------------------------------

# CheckStatus: every deterministic check reports one of these. "unavailable" is
# mandatory when parsing is incomplete — an incomplete parse must never yield a
# reassuring "pass".
PASS = "pass"
FAIL = "fail"
UNAVAILABLE = "unavailable"

# ProposalStatus lifecycle. Only a valid *pending* proposal can be accepted.
PENDING = "pending"
BLOCKED = "blocked"          # deterministic violation; blocked until text/rules change
ACCEPTED = "accepted"
REJECTED = "rejected"
STALE = "stale"              # base revision or rules version no longer matches

# RevisionOrigin: how a revision came to exist.
ORIGIN_CREATE = "create"
ORIGIN_IMPORT = "import"
ORIGIN_MANUAL_SAVE = "manual_save"
ORIGIN_PROPOSAL = "proposal"
ORIGIN_RESTORE = "restore"

# ExportStatus
EXPORT_OK = "ok"
EXPORT_FAILED = "failed"

# FindingStatus (optional continuity notes)
FINDING_OPEN = "open"
FINDING_RESOLVED = "resolved"

# Structured error codes (returned by the service and surfaced by tools/routes).
ERR_PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND"
ERR_REVISION_NOT_FOUND = "REVISION_NOT_FOUND"
ERR_SCENE_NOT_FOUND = "INVALID_SCENE"
ERR_STALE_REVISION = "STALE_REVISION"
ERR_RULES_CHANGED = "RULES_CHANGED"
ERR_LOCKED_TEXT_CHANGED = "LOCKED_TEXT_CHANGED"
ERR_PARSE_UNSUPPORTED = "PARSE_UNSUPPORTED"
ERR_RENDERER_UNAVAILABLE = "RENDERER_UNAVAILABLE"
ERR_INVALID_PROPOSAL = "INVALID_PROPOSAL"
ERR_IDEMPOTENCY_MISMATCH = "IDEMPOTENCY_MISMATCH"
ERR_CONFLICT = "CONFLICT"
ERR_VALIDATION = "VALIDATION"


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def new_id(prefix: str) -> str:
    """Opaque, sortable-enough id with a short human prefix."""
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# --- Core entities ---------------------------------------------------------

@dataclass
class Scene:
    """One scene, versioned with a revision.

    ``id`` is stable across a replacement of this scene. ``start``/``end`` are
    character offsets (half-open) into the owning revision's snapshot. Offsets
    let us splice a scene's replacement without touching any other byte.
    """
    id: str
    order: int
    heading: str
    start: int
    end: int
    # Element breakdown within this scene (typed parse). Empty when parsing is
    # incomplete for the scene.
    elements: List[dict] = field(default_factory=list)
    parse_ok: bool = True

    def text(self, snapshot: str) -> str:
        return snapshot[self.start:self.end]


@dataclass
class Project:
    id: str
    title: str
    author: str
    active_revision_id: Optional[str] = None
    active_rules_id: Optional[str] = None
    renderer_config: dict = field(default_factory=dict)
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)


@dataclass
class Revision:
    id: str
    project_id: str
    parent_id: Optional[str]
    snapshot: str                 # complete Fountain source, byte-exact
    content_hash: str             # sha256(snapshot)
    origin: str
    created_at: str = field(default_factory=_now_iso)
    # Parsed scene index for THIS revision (recomputed on read, cached).
    scenes: List[Scene] = field(default_factory=list)


@dataclass
class ProtectedRange:
    """A protected passage: a source range + exact text hash in a rules version.

    Anchored to a scene + offset-within-scene so it shifts with edits in other
    scenes and is verified by hash on accept.
    """
    scene_id: str
    offset_in_scene: int
    length: int
    text_hash: str
    label: str = ""

    def to_dict(self) -> dict:
        return {
            "scene_id": self.scene_id,
            "offset_in_scene": self.offset_in_scene,
            "length": self.length,
            "text_hash": self.text_hash,
            "label": self.label,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ProtectedRange":
        return cls(
            scene_id=d["scene_id"],
            offset_in_scene=int(d["offset_in_scene"]),
            length=int(d["length"]),
            text_hash=d["text_hash"],
            label=d.get("label", ""),
        )


@dataclass
class RulesVersion:
    id: str
    project_id: str
    parent_id: Optional[str] = None
    created_at: str = field(default_factory=_now_iso)
    # Limits
    dialogue_block_limit: Optional[int] = None
    page_limit: Optional[int] = None
    # Allowed speakers; None = unrestricted. Each entry may carry ``aliases``.
    allowed_speakers: Optional[List[dict]] = None
    # Protected passages.
    protected: List[ProtectedRange] = field(default_factory=list)
    # Editorial guidance (free text; model-interpreted, e.g. "never show Arthur moving").
    guidance: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "dialogue_block_limit": self.dialogue_block_limit,
            "page_limit": self.page_limit,
            "allowed_speakers": self.allowed_speakers,
            "protected": [p.to_dict() for p in self.protected],
            "guidance": self.guidance,
        }

    @classmethod
    def from_dict(cls, d: dict, id: str, project_id: str, parent_id=None,
                  created_at: str = "") -> "RulesVersion":
        return cls(
            id=id,
            project_id=project_id,
            parent_id=parent_id,
            created_at=created_at or _now_iso(),
            dialogue_block_limit=d.get("dialogue_block_limit"),
            page_limit=d.get("page_limit"),
            allowed_speakers=d.get("allowed_speakers"),
            protected=[ProtectedRange.from_dict(p) for p in d.get("protected", [])],
            guidance=list(d.get("guidance", [])),
        )


@dataclass
class Check:
    name: str
    status: str          # pass | fail | unavailable
    detail: str = ""

    def to_dict(self) -> dict:
        return {"name": self.name, "status": self.status, "detail": self.detail}


@dataclass
class Operation:
    """One proposed edit: an insertion or a scene replacement.

    type == "insert":  new scene; ``before_scene_id`` places it before that scene
                       (None = append at end). ``heading`` + ``content`` define it.
    type == "replace": ``scene_id`` names the target; ``heading`` + ``content`` are
                       the new scene (replacing the target's body).
    """
    type: str                 # "insert" | "replace"
    scene_id: Optional[str] = None
    before_scene_id: Optional[str] = None
    heading: str = ""
    content: str = ""

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "scene_id": self.scene_id,
            "before_scene_id": self.before_scene_id,
            "heading": self.heading,
            "content": self.content,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Operation":
        return cls(
            type=d["type"],
            scene_id=d.get("scene_id"),
            before_scene_id=d.get("before_scene_id"),
            heading=d.get("heading", ""),
            content=d.get("content", ""),
        )


@dataclass
class Proposal:
    id: str
    project_id: str
    base_revision_id: str
    rules_id: str
    operations: List[Operation]
    candidate_snapshot: str     # assembled candidate Fountain text
    candidate_hash: str
    checks: List[Check] = field(default_factory=list)
    status: str = PENDING
    idempotency_key: Optional[str] = None
    # Backend-generated before/after comparison (never a model summary).
    diff: List[dict] = field(default_factory=list)
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "base_revision_id": self.base_revision_id,
            "rules_id": self.rules_id,
            "operations": [o.to_dict() for o in self.operations],
            "candidate_snapshot": self.candidate_snapshot,
            "candidate_hash": self.candidate_hash,
            "checks": [c.to_dict() for c in self.checks],
            "status": self.status,
            "idempotency_key": self.idempotency_key,
            "diff": self.diff,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass
class Export:
    id: str
    project_id: str
    revision_id: str
    renderer_config: dict
    artifact_path: str
    page_count: Optional[int]
    status: str
    created_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "revision_id": self.revision_id,
            "renderer_config": self.renderer_config,
            "artifact_path": self.artifact_path,
            "page_count": self.page_count,
            "status": self.status,
            "created_at": self.created_at,
        }


@dataclass
class Finding:
    id: str
    project_id: str
    revision_id: str
    evidence: List[dict]     # [{scene_id, offset_in_scene, length, quote}]
    observation: str
    status: str = FINDING_OPEN
    created_at: str = field(default_factory=_now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "revision_id": self.revision_id,
            "evidence": self.evidence,
            "observation": self.observation,
            "status": self.status,
            "created_at": self.created_at,
        }


# --- Result envelope -------------------------------------------------------

@dataclass
class ServiceError(Exception):
    """Structured error. ``code`` is one of the ERR_* constants."""
    code: str
    message: str
    details: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "details": self.details}
