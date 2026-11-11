"""SQLite persistence for the ghostwriter service.

Path-injectable so it is testable headless (``Repository(tmp_path/"t.db")``);
production resolves the real path via ``plugin_data_dir("ghostwriter")``.

The agent process and the desktop web-server process each open their own
connection to the same file: WAL mode plus a busy timeout make that safe.
Within a process every statement runs under one re-entrant lock, because a
``sqlite3`` connection must not be used by two threads at once.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import List, Optional

from . import formats
from . import models as M

MIGRATIONS = [
    "0001_initial.sql",
    "0002_recoverable_revisions.sql",
    "0003_format.sql",
]

_MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


class Repository:
    def __init__(self, db_path: "str | Path", registry=None):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False, timeout=15.0)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL;")
        self._conn.execute("PRAGMA foreign_keys=ON;")
        self._conn.execute("PRAGMA busy_timeout=15000;")
        self._registry = registry or formats.build_default_registry()
        self._migrate()

    # --- low-level helpers --------------------------------------------------

    def _all(self, sql: str, params=()) -> list:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def _one(self, sql: str, params=()):
        with self._lock:
            return self._conn.execute(sql, params).fetchone()

    def _write(self, sql: str, params=()) -> None:
        with self._lock, self._conn:
            self._conn.execute(sql, params)

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

    # --- lifecycle ----------------------------------------------------------

    def _migrate(self) -> None:
        for name in MIGRATIONS:
            version = int(name.split("_", 1)[0])
            if version <= self._current_version():
                continue
            sql = (_MIGRATIONS_DIR / name).read_text(encoding="utf-8")
            with self._lock, self._conn:
                self._conn.executescript(sql)

    def _current_version(self) -> int:
        try:
            row = self._one("SELECT value FROM meta WHERE key='schema_version'")
        except sqlite3.OperationalError:
            return 0
        return int(row["value"]) if row else 0

    @property
    def schema_version(self) -> str:
        return str(self._current_version())

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # --- projects -----------------------------------------------------------

    def create_project(self, p: M.Project) -> None:
        self._write(
            "INSERT INTO projects (id,title,author,format,active_revision_id,"
            "active_rules_id,renderer_config,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (p.id, p.title, p.author, p.format, p.active_revision_id, p.active_rules_id,
             json.dumps(p.renderer_config), p.created_at, p.updated_at))

    def get_project(self, project_id: str) -> Optional[M.Project]:
        row = self._one("SELECT * FROM projects WHERE id=?", (project_id,))
        return self._row_to_project(row) if row else None

    def list_projects(self) -> List[M.Project]:
        return [self._row_to_project(r)
                for r in self._all("SELECT * FROM projects ORDER BY updated_at DESC")]

    def touch_project(self, project_id: str, **fields) -> None:
        allowed = {"title", "author", "format", "active_revision_id",
                   "active_rules_id", "renderer_config", "updated_at"}
        sets, vals = [], []
        for k, v in fields.items():
            if k in allowed:
                sets.append(f"{k}=?")
                vals.append(json.dumps(v) if k == "renderer_config" else v)
        if sets:
            vals.append(project_id)
            self._write(f"UPDATE projects SET {', '.join(sets)} WHERE id=?", vals)

    def delete_project(self, project_id: str) -> None:
        """Delete a project and (via ON DELETE CASCADE) all of its data."""
        with self.transaction() as conn:
            conn.execute("DELETE FROM scenes WHERE revision_id IN "
                         "(SELECT id FROM revisions WHERE project_id=?)", (project_id,))
            conn.execute("DELETE FROM projects WHERE id=?", (project_id,))

    @staticmethod
    def _row_to_project(row) -> M.Project:
        return M.Project(
            id=row["id"], title=row["title"], author=row["author"],
            format=row["format"] or "screenplay",
            active_revision_id=row["active_revision_id"],
            active_rules_id=row["active_rules_id"],
            renderer_config=json.loads(row["renderer_config"] or "{}"),
            created_at=row["created_at"], updated_at=row["updated_at"],
        )

    # --- revisions ----------------------------------------------------------

    @staticmethod
    def insert_revision(conn, r: M.Revision) -> None:
        """Insert a revision + its scene index using ``conn`` (no commit), so
        callers can make it part of a larger transaction."""
        conn.execute(
            "INSERT INTO revisions (id,project_id,parent_id,snapshot,content_hash,"
            "origin,created_at) VALUES (?,?,?,?,?,?,?)",
            (r.id, r.project_id, r.parent_id, r.snapshot, r.content_hash, r.origin, r.created_at))
        conn.executemany(
            "INSERT INTO scenes (revision_id,id,scene_order,heading,start_offset,end_offset,"
            "parse_ok) VALUES (?,?,?,?,?,?,?)",
            [(r.id, s.id, s.order, s.heading, s.start, s.end, 1 if s.parse_ok else 0)
             for s in r.scenes])

    def create_revision(self, r: M.Revision) -> None:
        with self.transaction() as conn:
            self.insert_revision(conn, r)

    def get_revision(self, revision_id: str) -> Optional[M.Revision]:
        row = self._one("SELECT * FROM revisions WHERE id=?", (revision_id,))
        if not row:
            return None
        rev = M.Revision(
            id=row["id"], project_id=row["project_id"], parent_id=row["parent_id"],
            snapshot=row["snapshot"], content_hash=row["content_hash"],
            origin=row["origin"], created_at=row["created_at"],
        )
        rev.scenes = self._load_scenes(revision_id)
        # Elements are derived from the immutable snapshot (the source of truth);
        # stored ids/order/offsets are authoritative and the fresh parse supplies
        # each scene's elements. Parsing is memoized by snapshot.
        parsed = self._engine_for(rev.project_id).parse(rev.snapshot)[0]
        for i, sc in enumerate(rev.scenes):
            if i < len(parsed):
                sc.elements = parsed[i].elements
                sc.meta = parsed[i].meta
        return rev

    def _engine_for(self, project_id: str):
        project = self.get_project(project_id)
        try:
            return self._registry.get(project.format if project else "screenplay")
        except KeyError:
            return self._registry.get("screenplay")

    def revision_headers(self, project_id: str) -> List[dict]:
        """Cheap history listing (no snapshot parsing), oldest first."""
        rows = self._all(
            "SELECT r.id, r.parent_id, r.origin, r.content_hash, r.created_at, "
            "(SELECT COUNT(*) FROM scenes s WHERE s.revision_id = r.id) AS scene_count "
            "FROM revisions r WHERE r.project_id=? ORDER BY r.created_at, r.rowid",
            (project_id,))
        return [dict(r) for r in rows]

    def list_revisions(self, project_id: str) -> List[M.Revision]:
        return [self.get_revision(h["id"]) for h in self.revision_headers(project_id)]

    def _load_scenes(self, revision_id: str) -> List[M.Scene]:
        rows = self._all("SELECT * FROM scenes WHERE revision_id=? ORDER BY scene_order",
                         (revision_id,))
        return [M.Scene(id=r["id"], order=r["scene_order"], kind="scene", heading=r["heading"],
                        start=r["start_offset"], end=r["end_offset"], parse_ok=bool(r["parse_ok"]))
                for r in rows]

    # --- rules --------------------------------------------------------------

    def create_rules(self, rv: M.RulesVersion) -> None:
        self._write(
            "INSERT INTO rules_versions (id,project_id,parent_id,body,created_at) VALUES (?,?,?,?,?)",
            (rv.id, rv.project_id, rv.parent_id, json.dumps(rv.to_dict()), rv.created_at))

    def get_rules(self, rules_id: Optional[str]) -> Optional[M.RulesVersion]:
        if not rules_id:
            return None
        row = self._one("SELECT * FROM rules_versions WHERE id=?", (rules_id,))
        if not row:
            return None
        return M.RulesVersion.from_dict(
            json.loads(row["body"]), id=row["id"], project_id=row["project_id"],
            parent_id=row["parent_id"], created_at=row["created_at"])

    # --- proposals ----------------------------------------------------------

    def create_proposal(self, p: M.Proposal) -> None:
        self._write(
            "INSERT INTO proposals (id,project_id,base_revision_id,rules_id,operations,"
            "candidate_snapshot,candidate_hash,checks,diff,status,idempotency_key,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (p.id, p.project_id, p.base_revision_id, p.rules_id,
             json.dumps([o.to_dict() for o in p.operations]),
             p.candidate_snapshot, p.candidate_hash, json.dumps([c.to_dict() for c in p.checks]),
             json.dumps(p.diff), p.status, p.idempotency_key, p.created_at, p.updated_at))

    def get_proposal(self, proposal_id: str) -> Optional[M.Proposal]:
        row = self._one("SELECT * FROM proposals WHERE id=?", (proposal_id,))
        return self._row_to_proposal(row) if row else None

    def list_proposals(self, project_id: str) -> List[M.Proposal]:
        return [self._row_to_proposal(r) for r in self._all(
            "SELECT * FROM proposals WHERE project_id=? ORDER BY created_at DESC, rowid DESC",
            (project_id,))]

    def set_proposal_status(self, proposal_id: str, status: str) -> None:
        self._write("UPDATE proposals SET status=?, updated_at=? WHERE id=?",
                    (status, M._now_iso(), proposal_id))

    def update_proposal_checks(self, proposal_id: str, checks: List[M.Check], status: str) -> None:
        self._write("UPDATE proposals SET checks=?, status=?, updated_at=? WHERE id=?",
                    (json.dumps([c.to_dict() for c in checks]), status, M._now_iso(), proposal_id))

    def find_proposal_by_idem(self, project_id: str, key: str) -> Optional[M.Proposal]:
        row = self._one("SELECT * FROM proposals WHERE project_id=? AND idempotency_key=?",
                        (project_id, key))
        return self._row_to_proposal(row) if row else None

    @staticmethod
    def _row_to_proposal(row) -> M.Proposal:
        return M.Proposal(
            id=row["id"], project_id=row["project_id"],
            base_revision_id=row["base_revision_id"], rules_id=row["rules_id"],
            operations=[M.Operation.from_dict(d) for d in json.loads(row["operations"])],
            candidate_snapshot=row["candidate_snapshot"], candidate_hash=row["candidate_hash"],
            checks=[M.Check(**d) for d in json.loads(row["checks"])],
            diff=json.loads(row["diff"]), status=row["status"],
            idempotency_key=row["idempotency_key"],
            created_at=row["created_at"], updated_at=row["updated_at"])

    # --- exports ------------------------------------------------------------

    def create_export(self, e: M.Export) -> None:
        self._write(
            "INSERT INTO exports (id,project_id,revision_id,renderer_config,artifact_path,"
            "page_count,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (e.id, e.project_id, e.revision_id, json.dumps(e.renderer_config),
             e.artifact_path, e.page_count, e.status, e.created_at))
