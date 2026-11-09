"""SQLite persistence for the screenplay service.

Path-injectable so it is testable headless (``Repository(tmp_path/"t.db")``);
production resolves the real path via ``plugin_data_dir("hermes-screenplay")``.

WAL mode + a re-entrant lock give safe concurrent reads and serialized writes
within one process. Each profile has its own data dir, so cross-profile
isolation is structural.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Optional

from . import models as M
from . import fountain

MIGRATIONS = [
    "0001_initial.sql",
    "0002_recoverable_revisions.sql",
]

# Resolved from this file so migrations load regardless of how the package is
# imported (top-level in tests, nested as <plugin>.screenplay in the loader).
_MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


class Repository:
    def __init__(self, db_path: "str | Path"):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA foreign_keys=ON;")
        self._migrate()

    # --- lifecycle ----------------------------------------------------------

    def _migrate(self) -> None:
        for name in MIGRATIONS:
            sql = (_MIGRATIONS_DIR / name).read_text(encoding="utf-8")
            with self._lock, self._conn:
                self._conn.executescript(sql)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @contextmanager
    def transaction(self):
        """Single-transaction multi-write block (atomic commit or rollback)."""
        with self._lock:
            try:
                yield self._conn
                self._conn.commit()
            except BaseException:
                self._conn.rollback()
                raise

    @property
    def schema_version(self) -> str:
        row = self._conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        return row["value"] if row else "0"

    # --- projects -----------------------------------------------------------

    def create_project(self, p: M.Project) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO projects (id,title,author,active_revision_id,active_rules_id,"
                "renderer_config,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (p.id, p.title, p.author, p.active_revision_id, p.active_rules_id,
                 json.dumps(p.renderer_config), p.created_at, p.updated_at),
            )

    def get_project(self, project_id: str) -> Optional[M.Project]:
        row = self._conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not row:
            return None
        return self._row_to_project(row)

    def list_projects(self) -> list[M.Project]:
        rows = self._conn.execute(
            "SELECT * FROM projects ORDER BY updated_at DESC"
        ).fetchall()
        return [self._row_to_project(r) for r in rows]

    def touch_project(self, project_id: str, **fields) -> None:
        allowed = {"title", "author", "active_revision_id", "active_rules_id",
                   "renderer_config", "updated_at"}
        sets, vals = [], []
        for k, v in fields.items():
            if k in allowed:
                if k == "renderer_config":
                    v = json.dumps(v)
                sets.append(f"{k}=?")
                vals.append(v)
        if sets:
            vals.append(project_id)
            with self._lock, self._conn:
                self._conn.execute(
                    f"UPDATE projects SET {', '.join(sets)} WHERE id=?", vals
                )

    def _row_to_project(self, row) -> M.Project:
        return M.Project(
            id=row["id"], title=row["title"], author=row["author"],
            active_revision_id=row["active_revision_id"],
            active_rules_id=row["active_rules_id"],
            renderer_config=json.loads(row["renderer_config"] or "{}"),
            created_at=row["created_at"], updated_at=row["updated_at"],
        )

    # --- revisions ----------------------------------------------------------

    def create_revision(self, r: M.Revision) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO revisions (id,project_id,parent_id,snapshot,content_hash,"
                "origin,created_at) VALUES (?,?,?,?,?,?,?)",
                (r.id, r.project_id, r.parent_id, r.snapshot, r.content_hash,
                 r.origin, r.created_at),
            )
            self._save_scenes(r)

    def get_revision(self, revision_id: str) -> Optional[M.Revision]:
        row = self._conn.execute("SELECT * FROM revisions WHERE id=?", (revision_id,)).fetchone()
        if not row:
            return None
        rev = M.Revision(
            id=row["id"], project_id=row["project_id"], parent_id=row["parent_id"],
            snapshot=row["snapshot"], content_hash=row["content_hash"],
            origin=row["origin"], created_at=row["created_at"],
        )
        rev.scenes = self._load_scenes(revision_id)
        # Elements are derived from the immutable snapshot (source of truth);
        # align by document order (scene_order == parse order).
        parsed, _problems = fountain.parse(rev.snapshot)
        for i, sc in enumerate(rev.scenes):
            if i < len(parsed):
                sc.elements = parsed[i].elements
        return rev

    def list_revisions(self, project_id: str) -> list[M.Revision]:
        rows = self._conn.execute(
            "SELECT id FROM revisions WHERE project_id=? ORDER BY created_at",
            (project_id,),
        ).fetchall()
        return [self.get_revision(r["id"]) for r in rows]

    def find_revision_by_hash(self, project_id: str, content_hash: str) -> Optional[str]:
        row = self._conn.execute(
            "SELECT id FROM revisions WHERE project_id=? AND content_hash=?",
            (project_id, content_hash),
        ).fetchone()
        return row["id"] if row else None

    def _save_scenes(self, rev: M.Revision) -> None:
        self._conn.execute("DELETE FROM scenes WHERE revision_id=?", (rev.id,))
        for s in rev.scenes:
            self._conn.execute(
                "INSERT INTO scenes (revision_id,id,scene_order,heading,start_offset,end_offset,"
                "parse_ok) VALUES (?,?,?,?,?,?,?)",
                (rev.id, s.id, s.order, s.heading, s.start, s.end, 1 if s.parse_ok else 0),
            )

    def _load_scenes(self, revision_id: str) -> list[M.Scene]:
        rows = self._conn.execute(
            "SELECT * FROM scenes WHERE revision_id=? ORDER BY scene_order", (revision_id,)
        ).fetchall()
        return [
            M.Scene(
                id=r["id"], order=r["scene_order"], kind="scene", heading=r["heading"],
                start=r["start_offset"], end=r["end_offset"],
                parse_ok=bool(r["parse_ok"]),
            )
            for r in rows
        ]

    # --- rules --------------------------------------------------------------

    def create_rules(self, rv: M.RulesVersion) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO rules_versions (id,project_id,parent_id,body,created_at) "
                "VALUES (?,?,?,?,?)",
                (rv.id, rv.project_id, rv.parent_id, json.dumps(rv.to_dict()), rv.created_at),
            )

    def get_rules(self, rules_id: str) -> Optional[M.RulesVersion]:
        row = self._conn.execute(
            "SELECT * FROM rules_versions WHERE id=?", (rules_id,)
        ).fetchone()
        if not row:
            return None
        return M.RulesVersion.from_dict(
            json.loads(row["body"]), id=row["id"], project_id=row["project_id"],
            parent_id=row["parent_id"], created_at=row["created_at"],
        )

    def list_rules(self, project_id: str) -> list[M.RulesVersion]:
        rows = self._conn.execute(
            "SELECT id,project_id,parent_id,created_at FROM rules_versions "
            "WHERE project_id=? ORDER BY created_at", (project_id,),
        ).fetchall()
        return [self.get_rules(r["id"]) for r in rows]

    # --- proposals ----------------------------------------------------------

    def create_proposal(self, p: M.Proposal) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO proposals (id,project_id,base_revision_id,rules_id,operations,"
                "candidate_snapshot,candidate_hash,checks,diff,status,idempotency_key,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (p.id, p.project_id, p.base_revision_id, p.rules_id,
                 json.dumps([o.to_dict() for o in p.operations]),
                 p.candidate_snapshot, p.candidate_hash, json.dumps([c.to_dict() for c in p.checks]),
                 json.dumps(p.diff), p.status, p.idempotency_key, p.created_at, p.updated_at),
            )

    def get_proposal(self, proposal_id: str) -> Optional[M.Proposal]:
        row = self._conn.execute(
            "SELECT * FROM proposals WHERE id=?", (proposal_id,)
        ).fetchone()
        if not row:
            return None
        return self._row_to_proposal(row)

    def list_proposals(self, project_id: str) -> list[M.Proposal]:
        rows = self._conn.execute(
            "SELECT * FROM proposals WHERE project_id=? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
        return [self._row_to_proposal(r) for r in rows]

    def set_proposal_status(self, proposal_id: str, status: str) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE proposals SET status=?, updated_at=? WHERE id=?",
                (status, M._now_iso(), proposal_id),
            )

    def find_proposal_by_idem(self, project_id: str, key: str) -> Optional[M.Proposal]:
        row = self._conn.execute(
            "SELECT * FROM proposals WHERE project_id=? AND idempotency_key=?",
            (project_id, key),
        ).fetchone()
        return self._row_to_proposal(row) if row else None

    def _row_to_proposal(self, row) -> M.Proposal:
        return M.Proposal(
            id=row["id"], project_id=row["project_id"],
            base_revision_id=row["base_revision_id"], rules_id=row["rules_id"],
            operations=[M.Operation.from_dict(d) for d in json.loads(row["operations"])],
            candidate_snapshot=row["candidate_snapshot"], candidate_hash=row["candidate_hash"],
            checks=[M.Check(**d) for d in json.loads(row["checks"])],
            diff=json.loads(row["diff"]), status=row["status"],
            idempotency_key=row["idempotency_key"],
            created_at=row["created_at"], updated_at=row["updated_at"],
        )

    # --- exports ------------------------------------------------------------

    def create_export(self, e: M.Export) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO exports (id,project_id,revision_id,renderer_config,artifact_path,"
                "page_count,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
                (e.id, e.project_id, e.revision_id, json.dumps(e.renderer_config),
                 e.artifact_path, e.page_count, e.status, e.created_at),
            )

    def get_export(self, export_id: str) -> Optional[M.Export]:
        row = self._conn.execute("SELECT * FROM exports WHERE id=?", (export_id,)).fetchone()
        if not row:
            return None
        return M.Export(
            id=row["id"], project_id=row["project_id"], revision_id=row["revision_id"],
            renderer_config=json.loads(row["renderer_config"] or "{}"),
            artifact_path=row["artifact_path"], page_count=row["page_count"],
            status=row["status"], created_at=row["created_at"],
        )

    def list_exports(self, project_id: str) -> list[M.Export]:
        rows = self._conn.execute(
            "SELECT * FROM exports WHERE project_id=? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
        return [self.get_export(r["id"]) for r in rows]

    # --- findings -----------------------------------------------------------

    def create_finding(self, f: M.Finding) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO findings (id,project_id,revision_id,evidence,observation,"
                "status,created_at) VALUES (?,?,?,?,?,?,?)",
                (f.id, f.project_id, f.revision_id, json.dumps(f.evidence),
                 f.observation, f.status, f.created_at),
            )

    def list_findings(self, project_id: str, status: Optional[str] = None) -> list[M.Finding]:
        if status:
            rows = self._conn.execute(
                "SELECT * FROM findings WHERE project_id=? AND status=? ORDER BY created_at",
                (project_id, status),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM findings WHERE project_id=? ORDER BY created_at", (project_id,)
            ).fetchall()
        return [
            M.Finding(
                id=r["id"], project_id=r["project_id"], revision_id=r["revision_id"],
                evidence=json.loads(r["evidence"] or "[]"), observation=r["observation"],
                status=r["status"], created_at=r["created_at"],
            )
            for r in rows
        ]

    def set_finding_status(self, finding_id: str, status: str) -> None:
        with self._lock, self._conn:
            self._conn.execute("UPDATE findings SET status=? WHERE id=?", (status, finding_id))
