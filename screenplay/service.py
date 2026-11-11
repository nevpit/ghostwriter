"""The ghostwriter service: orchestration over the repository.

Project/revision lifecycle, the proposal workflow (propose -> check ->
accept/reject) with atomic acceptance and stable scene identity, rules
versions, recovery (restore/undo), and export (PDF / Fountain / Final Draft).

Pure Python; fully testable headless against a temp SQLite file.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Callable, List, Optional

from . import engine
from . import formats
from . import fountain
from . import importers
from . import models as M
from . import rendering
from . import validation
from .rendering import RenderSettings, RendererError
from .repository import Repository

_OP_TYPES = ("insert", "replace", "delete")


def _next_id(ids: List[str], prefix: str = "scene") -> str:
    """Mint a fresh block id: the prefix plus one past the highest existing index."""
    pat = re.compile(re.escape(prefix) + r"-(\d+)")
    nums = [int(m.group(1)) for i in ids if (m := pat.fullmatch(i))]
    return f"{prefix}-{(max(nums) + 1) if nums else 0}"


def _safe_filename(title: str, default: str = "script") -> str:
    safe = "".join(c if (c.isalnum() or c in " -_.()'&,!") else "_" for c in (title or "")).strip(" .")
    return safe or default


def build_diff(base_rev: M.Revision, candidate_scenes: List[M.Scene],
               candidate_snapshot: str) -> List[dict]:
    """Backend-generated scene-level before/after (never a model summary)."""
    base_by_id = {s.id: s for s in base_rev.scenes}
    cand_ids = {s.id for s in candidate_scenes}
    diff: List[dict] = []
    for sc in candidate_scenes:
        base = base_by_id.get(sc.id)
        if base is None:
            status = "added"
        else:
            same = base.text(base_rev.snapshot).strip() == sc.text(candidate_snapshot).strip()
            status = "unchanged" if same else "modified"
        diff.append({"scene_id": sc.id, "order": sc.order, "heading": sc.heading, "status": status})
    for bid, bsc in base_by_id.items():
        if bid not in cand_ids:
            diff.append({"scene_id": bid, "heading": bsc.heading, "status": "removed"})
    return diff


class ScreenplayService:
    def __init__(self, repo: Repository, exports_dir: "str | Path | None" = None):
        self.repo = repo
        self.exports_dir = Path(exports_dir) if exports_dir else None
        self.settings = RenderSettings()
        self.registry = formats.build_default_registry()

    def close(self) -> None:
        self.repo.close()

    def _engine(self, project_id: Optional[str] = None,
                project: Optional[M.Project] = None) -> "engine.DocumentEngine":
        p = project if project is not None else self.get_project(project_id)
        fmt = p.format or engine.DEFAULT_FORMAT
        try:
            return self.registry.get(fmt)
        except KeyError:
            raise M.ServiceError(M.ERR_PARSE_UNSUPPORTED, f"no engine registered for format '{fmt}'")

    # ---------------- projects ----------------

    def create_project(self, title: str, author: str = "", fountain_text: str = "",
                       format: Optional[str] = None, title_page: bool = True) -> M.Project:
        """Create a project. Unless the text already has one (or ``title_page``
        is False), a standard title page is written from ``title``/``author``."""
        text = fountain_text or ""
        if title_page and (title or "").strip():
            doc = fountain.parse_document(text)
            if not doc.title_page["fields"]:
                fields = {"Title": title.strip()}
                if (author or "").strip():
                    fields.update({"Credit": "Written by", "Author": author.strip()})
                text = fountain.set_title_page(text, fields)
        return self.import_project(title, author, text, format=format)

    def import_project(self, title: str, author: str, fountain_text: str,
                       format: Optional[str] = None) -> M.Project:
        """Create a project whose first revision is ``fountain_text`` verbatim."""
        fmt = format or engine.DEFAULT_FORMAT
        try:
            eng = self.registry.get(fmt)
        except KeyError:
            raise M.ServiceError(M.ERR_VALIDATION, f"unknown format '{fmt}'", {"format": fmt})
        text = fountain_text or ""
        scenes, _problems = eng.parse(text)
        meta = fountain.extract_metadata(text)
        title = (title or "").strip() or fountain.strip_markup(meta.get("title", "")).replace("\n", " ").strip() \
            or "Untitled"
        author = (author or "").strip() or fountain.strip_markup(
            meta.get("author") or meta.get("authors") or "").replace("\n", ", ").strip()
        p = M.Project(id=M.new_id("proj"), title=title, author=author, format=fmt)
        rules = M.RulesVersion(id=M.new_id("rules"), project_id=p.id)
        rev = M.Revision(id=M.new_id("rev"), project_id=p.id, parent_id=None, snapshot=text,
                         content_hash=M.sha256_hex(text), origin=M.ORIGIN_IMPORT, scenes=scenes)
        p.active_revision_id = rev.id
        p.active_rules_id = rules.id
        self.repo.create_project(p)
        self.repo.create_rules(rules)
        self.repo.create_revision(rev)
        return p

    def import_file(self, filename: str, content: bytes, title: str = "", author: str = "",
                    format: Optional[str] = None) -> M.Project:
        """Import Fountain / plain text / Final Draft ``.fdx`` / ``.pdf`` bytes.
        The stored revision is the converted Fountain."""
        fmt = format or engine.DEFAULT_FORMAT
        try:
            text = self.registry.get(fmt).import_(filename or "", content or b"")
        except importers.ImportFormatError as exc:
            raise M.ServiceError(M.ERR_VALIDATION, f"import failed: {exc}")
        except KeyError:
            raise M.ServiceError(M.ERR_VALIDATION, f"unknown format '{fmt}'")
        if not (title or "").strip() and not fountain.extract_metadata(text).get("title"):
            title = re.sub(r"\.[^.]+$", "", filename or "").strip() or "Imported script"
        return self.import_project(title, author, text, format=fmt)

    def list_projects(self) -> List[M.Project]:
        return self.repo.list_projects()

    def get_project(self, project_id: str) -> M.Project:
        p = self.repo.get_project(project_id)
        if p is None:
            raise M.ServiceError(M.ERR_PROJECT_NOT_FOUND, f"project {project_id} not found")
        return p

    def delete_project(self, project_id: str) -> None:
        self.get_project(project_id)
        rev_ids = [h["id"] for h in self.repo.revision_headers(project_id)]
        self.repo.delete_project(project_id)
        if self.exports_dir:
            for rid in rev_ids:
                try:
                    (self.exports_dir / f"{rid}.pdf").unlink(missing_ok=True)
                except OSError:
                    pass

    # ---------------- read ----------------

    def read_revision(self, project_id: str, revision_id: Optional[str] = None) -> M.Revision:
        p = self.get_project(project_id)
        revision_id = revision_id or p.active_revision_id
        rev = self.repo.get_revision(revision_id) if revision_id else None
        if rev is None or rev.project_id != project_id:
            raise M.ServiceError(M.ERR_REVISION_NOT_FOUND, f"revision {revision_id} not found")
        return rev

    def read_scene(self, project_id: str, revision_id: Optional[str], scene_id: str) -> dict:
        rev = self.read_revision(project_id, revision_id)
        sc = next((s for s in rev.scenes if s.id == scene_id), None)
        if sc is None:
            raise M.ServiceError(M.ERR_SCENE_NOT_FOUND, f"scene {scene_id} not found",
                                 {"scene_ids": [s.id for s in rev.scenes]})
        return {"id": sc.id, "order": sc.order, "heading": sc.heading,
                "text": sc.text(rev.snapshot), "elements": sc.elements,
                "parse_ok": sc.parse_ok, "revision_id": rev.id}

    def document(self, project_id: str, revision_id: Optional[str] = None) -> dict:
        """Title page + preamble of a revision (the parts outside any scene)."""
        rev = self.read_revision(project_id, revision_id)
        doc = fountain.parse_document(rev.snapshot)
        return {"title_page": doc.title_page, "preamble": doc.preamble,
                "problems": [p.to_dict() for p in doc.problems]}

    def outline(self, project_id: str, revision_id: Optional[str] = None) -> dict:
        """Compact, token-cheap view of a revision: title page, scene list with
        speakers and word counts, and the rendered page count."""
        rev = self.read_revision(project_id, revision_id)
        doc = fountain.parse_document(rev.snapshot)
        scenes = []
        for sc in rev.scenes:
            speakers: List[str] = []
            words = 0
            for el in sc.elements:
                if el["kind"] == "character" and el.get("speaker") not in speakers:
                    speakers.append(el.get("speaker"))
                if el["kind"] not in fountain.NON_PRINTING:
                    words += len(fountain.strip_markup(el.get("text", "")).split())
            entry = {"id": sc.id, "order": sc.order, "heading": sc.heading,
                     "characters": speakers, "words": words}
            if sc.meta.get("scene_number"):
                entry["scene_number"] = sc.meta["scene_number"]
            if not sc.parse_ok:
                entry["parse_ok"] = False
            scenes.append(entry)
        return {"revision_id": rev.id,
                "title_page": fountain.title_fields(doc.title_page),
                "preamble": "\n".join(e["text"] for e in doc.preamble),
                "scenes": scenes,
                "page_count": rendering.count_pages(rev.snapshot, self.settings),
                "problems": [p.to_dict() for p in doc.problems]}

    def read_script(self, project_id: str, scene_ids: Optional[List[str]] = None,
                    revision_id: Optional[str] = None) -> dict:
        """Fountain text of the whole revision, or of selected scenes."""
        rev = self.read_revision(project_id, revision_id)
        if not scene_ids:
            return {"revision_id": rev.id, "fountain": rev.snapshot}
        by_id = {s.id: s for s in rev.scenes}
        missing = [i for i in scene_ids if i not in by_id]
        if missing:
            raise M.ServiceError(M.ERR_SCENE_NOT_FOUND, f"scene(s) not found: {', '.join(missing)}",
                                 {"scene_ids": list(by_id)})
        parts = [f"[scene id: {i}]\n" + by_id[i].text(rev.snapshot).strip() for i in scene_ids]
        return {"revision_id": rev.id, "fountain": "\n\n".join(parts)}

    def _active_rev(self, project_id: str) -> str:
        p = self.get_project(project_id)
        if p.active_revision_id is None:
            raise M.ServiceError(M.ERR_VALIDATION, "project has no active revision")
        return p.active_revision_id

    # ---------------- committing revisions ----------------

    def _header_from_snapshot(self, snapshot: str) -> dict:
        meta = fountain.extract_metadata(snapshot)
        out = {}
        title = fountain.strip_markup(meta.get("title", "")).replace("\n", " ").strip()
        author = fountain.strip_markup(meta.get("author") or meta.get("authors") or "")
        author = author.replace("\n", ", ").strip()
        if title:
            out["title"] = title
        if author:
            out["author"] = author
        return out

    def _commit(self, project: M.Project, snapshot: str, origin: str, parent_id: Optional[str],
                expected_active: Optional[str], scenes: Optional[List[M.Scene]] = None,
                extra: Optional[Callable] = None) -> M.Revision:
        """Atomically store a new revision and make it active.

        ``expected_active`` is a compare-and-swap guard on the project's active
        revision pointer, so two writers (agent + desktop, possibly in different
        processes) can never silently overwrite each other."""
        if scenes is None:
            scenes = self._engine(project=project).parse(snapshot)[0]
        rev = M.Revision(id=M.new_id("rev"), project_id=project.id, parent_id=parent_id,
                         snapshot=snapshot, content_hash=M.sha256_hex(snapshot),
                         origin=origin, scenes=scenes)
        header = self._header_from_snapshot(snapshot)
        with self.repo.transaction() as conn:
            cur = conn.execute(
                "UPDATE projects SET active_revision_id=?, updated_at=?"
                + "".join(f", {k}=?" for k in header)
                + " WHERE id=? AND active_revision_id IS ?",
                (rev.id, M._now_iso(), *header.values(), project.id, expected_active))
            if cur.rowcount != 1:
                raise M.ServiceError(M.ERR_STALE_REVISION,
                                     "the script changed while this edit was being made; "
                                     "reload and try again")
            Repository.insert_revision(conn, rev)
            if extra:
                extra(conn, rev)
        return rev

    # ---------------- manual edits ----------------

    def _check_expected(self, project: M.Project, revision_id: Optional[str]) -> str:
        active = project.active_revision_id
        if revision_id is not None and revision_id != active:
            raise M.ServiceError(M.ERR_STALE_REVISION,
                                 f"revision {revision_id} is no longer active (active: {active})",
                                 {"active_revision_id": active})
        return active

    def save_scene(self, project_id: str, scene_id: str, heading: str,
                   content: str, revision_id: Optional[str] = None) -> M.Revision:
        """Replace one scene and store a new active revision (optimistic
        concurrency via ``revision_id``)."""
        p = self.get_project(project_id)
        active = self._check_expected(p, revision_id)
        rev = self.read_revision(project_id, active)
        op = M.Operation(type="replace", scene_id=scene_id, heading=heading, content=content)
        snapshot, scenes, _problems = self._assemble(rev, [op])
        return self._commit(p, snapshot, M.ORIGIN_MANUAL_SAVE, rev.id, active, scenes)

    def save_snapshot(self, project_id: str, fountain_text: str,
                      revision_id: Optional[str] = None,
                      origin: str = M.ORIGIN_MANUAL_SAVE) -> M.Revision:
        """Store a full-text save as a new active revision. Saving text that is
        identical to the active revision is a no-op (no history noise)."""
        p = self.get_project(project_id)
        active = self._check_expected(p, revision_id)
        base = self.read_revision(project_id, active)
        if fountain_text == base.snapshot:
            return base
        scenes = self._carry_ids(base, fountain_text)
        return self._commit(p, fountain_text, origin, base.id, active, scenes)

    def _carry_ids(self, base: M.Revision, new_text: str) -> List[M.Scene]:
        """Parse ``new_text`` and keep scene ids stable when the scene list is
        structurally unchanged or scenes are matched by identical heading."""
        scenes = fountain.parse(new_text)[0]
        if len(scenes) == len(base.scenes):
            for sc, old in zip(scenes, base.scenes):
                sc.id = old.id
            return scenes
        # Different count: match by heading in order, mint ids for the rest.
        pool = list(base.scenes)
        used = [s.id for s in base.scenes]
        for sc in scenes:
            match = next((o for o in pool if o.heading.upper() == sc.heading.upper()), None)
            if match:
                pool.remove(match)
                sc.id = match.id
            else:
                sc.id = _next_id(used)
                used.append(sc.id)
        return scenes

    def set_title_page(self, project_id: str, fields, revision_id: Optional[str] = None,
                       origin: str = M.ORIGIN_MANUAL_SAVE) -> M.Revision:
        """Replace the title page (``{key: value}``; empty values drop a key)."""
        p = self.get_project(project_id)
        active = self._check_expected(p, revision_id)
        base = self.read_revision(project_id, active)
        if not isinstance(fields, (dict, list)):
            raise M.ServiceError(M.ERR_VALIDATION, "fields must be an object of title-page keys")
        return self.save_snapshot(project_id, fountain.set_title_page(base.snapshot, fields), active, origin)

    # ---------------- structure-aware find & replace ----------------

    @staticmethod
    def _case_preserve(orig: str, repl: str) -> str:
        if not orig or not repl:
            return repl
        if orig.isupper():
            return repl.upper()
        if orig.islower():
            return repl.lower()
        if orig[0].isupper() and (len(orig) == 1 or orig[1:].islower()):
            return repl[0].upper() + repl[1:]
        return repl

    @staticmethod
    def _occurrences(text: str, q_low: str) -> List[tuple]:
        low = text.lower()
        out, i = [], 0
        while True:
            j = low.find(q_low, i)
            if j == -1:
                return out
            out.append((j, j + len(q_low)))
            i = j + len(q_low)

    def find_replace(self, project_id: str, query: str, replacement: str,
                     target="all", revision_id: Optional[str] = None,
                     origin: str = M.ORIGIN_MANUAL_SAVE) -> dict:
        """Replace occurrences of ``query`` (case-insensitive) while preserving
        Fountain structure.

        Matches are enumerated element by element in document order (preamble,
        then each scene) -- the same order the desktop search uses -- so a
        numeric ``target`` lines up with the highlighted hit. A replacement
        inside a character cue or scene heading is upper-cased so the line keeps
        its element type; elsewhere the original capitalization is mirrored."""
        q = (query or "").strip()
        if not q:
            raise M.ServiceError(M.ERR_VALIDATION, "query must be a non-empty string", {"field": "query"})
        replacement = replacement if isinstance(replacement, str) else ""
        p = self.get_project(project_id)
        active = self._check_expected(p, revision_id)
        base = self.read_revision(project_id, active)
        snapshot = base.snapshot
        q_low = q.lower()
        elements = [e for e in fountain.parse_document(snapshot).elements if e.get("text")]
        match_list = [(el, rank) for el in elements
                      for rank in range(len(self._occurrences(el["text"], q_low)))]
        total = len(match_list)
        if isinstance(target, str) and target.strip().lstrip("-").isdigit():
            target = int(target)
        if isinstance(target, (int, float)) and not isinstance(target, bool):
            idx = int(target)
            if idx < 0 or idx >= total:
                raise M.ServiceError(M.ERR_VALIDATION, "match index out of range",
                                     {"target": idx, "count": total})
            selected = [match_list[idx]]
        elif target in (None, "all"):
            selected = match_list
        else:
            raise M.ServiceError(M.ERR_VALIDATION, "target must be 'all' or a match index",
                                 {"target": target})
        if not selected:
            raise M.ServiceError(M.ERR_VALIDATION, f"no matches for '{q}'", {"count": 0})

        edits = []
        for el, rank in selected:
            raw = snapshot[el["start"]:el["end"]]
            occs = self._occurrences(raw, q_low)
            if rank >= len(occs):
                continue
            rs, re_ = occs[rank]
            if el["kind"] in ("character", "scene_heading", "transition"):
                new = replacement.upper()
            else:
                new = self._case_preserve(raw[rs:re_], replacement)
            edits.append((el["start"] + rs, el["start"] + re_, new))
        if not edits:
            raise M.ServiceError(M.ERR_VALIDATION, "no replacement made", {"count": total})
        new_snapshot = snapshot
        for s, e, new in sorted(edits, reverse=True):
            new_snapshot = new_snapshot[:s] + new + new_snapshot[e:]
        rev = self.save_snapshot(project_id, new_snapshot, active, origin)
        return {"revision_id": rev.id, "replaced": len(edits), "count": total}

    def history(self, project_id: str) -> List[dict]:
        p = self.get_project(project_id)
        return [{**h, "is_active": h["id"] == p.active_revision_id}
                for h in self.repo.revision_headers(project_id)]

    # ---------------- rules ----------------

    def update_rules(self, project_id: str, rules_id: Optional[str] = None, **changes) -> M.RulesVersion:
        """Create a new rules version (append-only). Keys: dialogue_block_limit,
        page_limit, allowed_speakers, protected, guidance, limits."""
        p = self.get_project(project_id)
        base_id = rules_id or p.active_rules_id
        base = self.repo.get_rules(base_id)
        rv = M.RulesVersion(id=M.new_id("rules"), project_id=project_id, parent_id=base_id)
        if base:
            rv.dialogue_block_limit = base.dialogue_block_limit
            rv.page_limit = base.page_limit
            rv.allowed_speakers = base.allowed_speakers
            rv.protected = list(base.protected)
            rv.guidance = list(base.guidance)
            rv.limits = dict(base.limits)
        for k, v in changes.items():
            if k in ("dialogue_block_limit", "page_limit"):
                if v in (None, ""):
                    v = None
                else:
                    try:
                        v = int(v)
                    except (TypeError, ValueError):
                        raise M.ServiceError(M.ERR_VALIDATION, f"{k} must be a whole number", {k: v})
                    if v < 1:
                        raise M.ServiceError(M.ERR_VALIDATION, f"{k} must be at least 1", {k: v})
                setattr(rv, k, v)
            elif k == "protected" and v is not None:
                rv.protected = [self._protected_range(project_id, d) for d in v]
            elif k == "guidance" and v is not None:
                rv.guidance = [str(g).strip() for g in v if str(g).strip()]
            elif k in ("allowed_speakers", "limits"):
                setattr(rv, k, v)
        self.repo.create_rules(rv)
        self.repo.touch_project(project_id, active_rules_id=rv.id, updated_at=M._now_iso())
        return rv

    def _protected_range(self, project_id: str, d) -> M.ProtectedRange:
        """Coerce a protected-range dict; computes ``text_hash`` from the active
        revision when the client did not supply one (the desktop doesn't)."""
        if isinstance(d, M.ProtectedRange):
            return d
        try:
            scene_id = str(d["scene_id"])
            offset = int(d.get("offset_in_scene", 0))
            length = int(d["length"])
        except (KeyError, TypeError, ValueError):
            raise M.ServiceError(M.ERR_VALIDATION, "protected range needs scene_id, offset_in_scene, length")
        if d.get("text_hash"):
            return M.ProtectedRange(scene_id, offset, length, d["text_hash"], d.get("label", ""))
        rev = self.read_revision(project_id)
        sc = next((s for s in rev.scenes if s.id == scene_id), None)
        if sc is None:
            raise M.ServiceError(M.ERR_SCENE_NOT_FOUND, f"scene {scene_id} not found")
        if offset < 0 or length < 1 or sc.start + offset + length > sc.end:
            raise M.ServiceError(M.ERR_VALIDATION, "protected range lies outside the scene",
                                 {"scene_length": sc.end - sc.start})
        text = rev.snapshot[sc.start + offset: sc.start + offset + length]
        return M.ProtectedRange(scene_id, offset, length, M.sha256_hex(text), d.get("label", ""))

    def protect_scene_text(self, project_id: str, scene_id: str, offset_in_scene: int,
                           length: int, label: str = "", rules_id: Optional[str] = None) -> M.RulesVersion:
        """Add a protected passage anchored to a scene + in-scene offset."""
        p = self.get_project(project_id)
        base = self.repo.get_rules(rules_id or p.active_rules_id)
        pr = self._protected_range(project_id, {"scene_id": scene_id, "offset_in_scene": offset_in_scene,
                                                "length": length, "label": label})
        return self.update_rules(project_id, rules_id, protected=(base.protected if base else []) + [pr])

    # ---------------- proposals ----------------

    def _assemble(self, base_rev: M.Revision, operations: List[M.Operation]):
        """Apply operations in order onto the base snapshot, keeping scene ids
        stable. Returns ``(snapshot, scenes, problems)``.

        A replace keeps its scene's id; extra scenes inside a replacement or an
        insert get fresh ids; a delete drops its id."""
        eng = self._engine(base_rev.project_id)
        id_list = [s.id for s in base_rev.scenes]
        seen = list(id_list)
        snapshot = base_rev.snapshot
        scenes = base_rev.scenes
        for n, op in enumerate(operations):
            if op.type not in _OP_TYPES:
                raise M.ServiceError(M.ERR_INVALID_PROPOSAL, f"operation {n}: bad type {op.type!r}")
            if op.type in ("replace", "delete"):
                if op.scene_id not in id_list:
                    raise M.ServiceError(M.ERR_SCENE_NOT_FOUND,
                                         f"operation {n}: scene {op.scene_id} not found",
                                         {"scene_ids": id_list})
                pos = id_list.index(op.scene_id)
            else:
                if op.before_scene_id is not None and op.before_scene_id not in id_list:
                    raise M.ServiceError(M.ERR_SCENE_NOT_FOUND,
                                         f"operation {n}: scene {op.before_scene_id} not found",
                                         {"scene_ids": id_list})
                pos = len(id_list) if op.before_scene_id is None else id_list.index(op.before_scene_id)
            snapshot, fresh = eng.apply_operation(snapshot, scenes, op, None)
            delta = len(fresh) - len(id_list)
            if op.type == "delete":
                ok, new_ids, removed = delta == -1, [], 1
            elif op.type == "replace":
                ok, removed = delta >= 0, 1
                new_ids = [op.scene_id]
            else:
                ok, removed = delta >= 1, 0
                new_ids = []
            if not ok:
                problem = fountain.Problem(
                    "SCENE_COUNT_MISMATCH", 0, 0,
                    f"operation {n} ({op.type}) changed the scene count unexpectedly -- "
                    "does the new text start with a scene heading?")
                return snapshot, fresh, [problem]
            extra = delta + removed - len(new_ids)
            for _ in range(extra):
                new_ids.append(_next_id(seen, eng.id_prefix))
                seen.append(new_ids[-1])
            id_list = id_list[:pos] + new_ids + id_list[pos + removed:]
            for i, sc in enumerate(fresh):
                sc.id = id_list[i]
            scenes = fresh
        final, problems = eng.parse(snapshot)
        for i, sc in enumerate(final):
            sc.id = id_list[i]
        return snapshot, final, problems

    @staticmethod
    def _ops(operations) -> List[M.Operation]:
        if not isinstance(operations, list) or not operations:
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL, "operations must be a non-empty list")
        out = []
        for n, o in enumerate(operations):
            if isinstance(o, M.Operation):
                out.append(o)
                continue
            if not isinstance(o, dict) or o.get("type") not in _OP_TYPES:
                raise M.ServiceError(M.ERR_INVALID_PROPOSAL,
                                     f"operation {n}: type must be one of {', '.join(_OP_TYPES)}")
            out.append(M.Operation.from_dict(o))
        return out

    def _validate(self, project: M.Project, scenes, snapshot, problems, rules) -> List[M.Check]:
        return self._engine(project=project).validate(scenes, snapshot, problems, rules, self.settings)

    def propose(self, project_id: str, operations: List[dict],
                base_revision_id: Optional[str] = None,
                rules_id: Optional[str] = None,
                idempotency_key: Optional[str] = None) -> M.Proposal:
        p = self.get_project(project_id)
        if idempotency_key:
            existing = self.repo.find_proposal_by_idem(project_id, idempotency_key)
            if existing is not None:
                return existing
        base_rev = self.read_revision(project_id, base_revision_id)
        rid = rules_id or p.active_rules_id
        rules = self.repo.get_rules(rid)
        if rules is None:
            raise M.ServiceError(M.ERR_VALIDATION, f"rules {rid} not found")
        ops = self._ops(operations)
        snapshot, scenes, problems = self._assemble(base_rev, ops)
        checks = self._validate(p, scenes, snapshot, problems, rules)
        prop = M.Proposal(
            id=M.new_id("prop"), project_id=project_id, base_revision_id=base_rev.id,
            rules_id=rid, operations=ops, candidate_snapshot=snapshot,
            candidate_hash=M.sha256_hex(snapshot), checks=checks,
            status=M.BLOCKED if validation.proposal_has_failure(checks) else M.PENDING,
            idempotency_key=idempotency_key, diff=build_diff(base_rev, scenes, snapshot))
        self.repo.create_proposal(prop)
        return prop

    def get_proposal(self, proposal_id: str) -> M.Proposal:
        prop = self.repo.get_proposal(proposal_id)
        if prop is None:
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL, f"proposal {proposal_id} not found")
        return prop

    def list_proposals(self, project_id: str) -> List[M.Proposal]:
        self.get_project(project_id)
        return self.repo.list_proposals(project_id)

    def _conflict(self, prop: M.Proposal, base_rev: M.Revision, active: M.Revision) -> Optional[str]:
        """Why ``prop`` cannot be replayed on ``active`` (None = it can).

        Operations address scenes by stable id, so a proposal made on an older
        revision can be re-applied to the current one as long as every scene it
        touches still exists and was not edited in the meantime."""
        base_by = {s.id: s for s in base_rev.scenes}
        act_by = {s.id: s for s in active.scenes}
        for op in prop.operations:
            sid = op.scene_id if op.type in ("replace", "delete") else op.before_scene_id
            if sid is None:
                continue
            if sid not in act_by:
                return f"scene {sid} no longer exists"
            if op.type != "insert" and sid in base_by and \
                    base_by[sid].text(base_rev.snapshot).strip() != act_by[sid].text(active.snapshot).strip():
                return f"scene '{act_by[sid].heading}' was edited after this proposal was made"
        return None

    def proposal_view(self, proposal_id: str) -> dict:
        """Proposal + backend-generated before/after text for changed scenes."""
        prop = self.get_proposal(proposal_id)
        p = self.get_project(prop.project_id)
        base_rev = self.repo.get_revision(prop.base_revision_id)
        stale = base_rev is None or base_rev.project_id != p.id or prop.status == M.STALE
        view: dict = {**prop.to_dict(), "base_is_active": prop.base_revision_id == p.active_revision_id,
                      "stale": stale, "conflict": None, "changes": []}
        if stale:
            return view
        if not view["base_is_active"] and prop.status in (M.PENDING, M.BLOCKED):
            active = self.repo.get_revision(p.active_revision_id)
            view["conflict"] = self._conflict(prop, base_rev, active) if active else "no active revision"
        cand_scenes = self._engine(project=p).parse(prop.candidate_snapshot)[0]
        try:
            _s, cand_scenes, _p = self._assemble(base_rev, prop.operations)
        except M.ServiceError:
            pass
        cand_by_id = {s.id: s for s in cand_scenes}
        base_by_id = {s.id: s for s in base_rev.scenes}
        for d in prop.diff:
            if d.get("status") == "unchanged":
                continue
            before = base_by_id.get(d.get("scene_id"))
            after = cand_by_id.get(d.get("scene_id"))
            view["changes"].append({
                "scene_id": d.get("scene_id"),
                "heading": d.get("heading") or (after.heading if after else before.heading if before else ""),
                "status": d.get("status"),
                "before": before.text(base_rev.snapshot) if before else "",
                "after": after.text(prop.candidate_snapshot) if after else "",
            })
        return view

    def check_proposal(self, proposal_id: str) -> M.Proposal:
        """Re-validate a proposal against the *current* rules. Accepted and
        rejected proposals are final and are returned unchanged."""
        prop = self.get_proposal(proposal_id)
        if prop.status in (M.ACCEPTED, M.REJECTED):
            return prop
        p = self.get_project(prop.project_id)
        base_rev = self.repo.get_revision(prop.base_revision_id)
        if base_rev is None or base_rev.project_id != p.id:
            self.repo.set_proposal_status(prop.id, M.STALE)
            prop.status = M.STALE
            return prop
        if prop.base_revision_id != p.active_revision_id:
            active = self.repo.get_revision(p.active_revision_id)
            reason = self._conflict(prop, base_rev, active)
            if reason:
                prop.checks = [M.Check("BASE_REVISION", M.FAIL, f"stale: {reason}")]
                prop.status = M.STALE
                self.repo.update_proposal_checks(prop.id, prop.checks, prop.status)
                return prop
        rules = self.repo.get_rules(p.active_rules_id) or self.repo.get_rules(prop.rules_id)
        snapshot, scenes, problems = self._assemble(base_rev, prop.operations)
        prop.checks = self._validate(p, scenes, snapshot, problems, rules)
        prop.status = M.BLOCKED if validation.proposal_has_failure(prop.checks) else M.PENDING
        self.repo.update_proposal_checks(prop.id, prop.checks, prop.status)
        return prop

    def accept_proposal(self, proposal_id: str) -> M.Revision:
        """Accept a proposal atomically.

        Re-validated against the current rules at accept time. If the script
        changed since the proposal was made, the operations are replayed onto
        the current revision (scene ids are stable) unless a touched scene was
        edited meanwhile -- then the proposal is marked STALE instead of
        silently overwriting newer text."""
        prop = self.get_proposal(proposal_id)
        p = self.get_project(prop.project_id)
        if prop.status == M.ACCEPTED:
            return self.read_revision(p.id)
        if prop.status == M.REJECTED:
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL, "cannot accept a rejected proposal")
        base_rev = self.repo.get_revision(prop.base_revision_id)
        if base_rev is None or base_rev.project_id != p.id:
            self.repo.set_proposal_status(prop.id, M.STALE)
            raise M.ServiceError(M.ERR_STALE_REVISION, "base revision no longer exists")
        if M.sha256_hex(prop.candidate_snapshot) != prop.candidate_hash:
            raise M.ServiceError(M.ERR_CONFLICT, "candidate snapshot does not match its hash")

        target = base_rev
        if prop.base_revision_id != p.active_revision_id:
            active = self.read_revision(p.id)
            reason = self._conflict(prop, base_rev, active)
            if reason:
                self.repo.set_proposal_status(prop.id, M.STALE)
                raise M.ServiceError(M.ERR_STALE_REVISION, f"proposal is stale: {reason}")
            target = active
        snapshot, scenes, problems = self._assemble(target, prop.operations)
        rules = self.repo.get_rules(p.active_rules_id) or self.repo.get_rules(prop.rules_id)
        checks = self._validate(p, scenes, snapshot, problems, rules)
        if validation.proposal_has_failure(checks):
            self.repo.update_proposal_checks(prop.id, checks, M.BLOCKED)
            failed = [c for c in checks if c.status == M.FAIL]
            code = M.ERR_LOCKED_TEXT_CHANGED if any(c.name == "PROTECTED_PASSAGES" for c in failed) \
                else M.ERR_VALIDATION
            raise M.ServiceError(code, "proposal fails validation: "
                                 + "; ".join(f"{c.name}: {c.detail}" for c in failed),
                                 {"checks": [c.to_dict() for c in checks]})

        def mark(conn, rev):
            conn.execute(
                "UPDATE proposals SET status=?, checks=?, base_revision_id=?, candidate_snapshot=?, "
                "candidate_hash=?, updated_at=? WHERE id=?",
                (M.ACCEPTED, json.dumps([c.to_dict() for c in checks]), target.id,
                 snapshot, M.sha256_hex(snapshot), M._now_iso(), prop.id))
        return self._commit(p, snapshot, M.ORIGIN_PROPOSAL, target.id, target.id, scenes, extra=mark)

    def reject_proposal(self, proposal_id: str, reason: str = "") -> M.Proposal:
        prop = self.get_proposal(proposal_id)
        if prop.status == M.ACCEPTED:
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL, "proposal already accepted")
        self.repo.set_proposal_status(prop.id, M.REJECTED)
        prop.status = M.REJECTED
        return prop

    # ---------------- recovery (immutable, auditable) ----------------

    def restore_snapshot(self, project_id: str, revision_id: str) -> M.Revision:
        """Restore an earlier snapshot as a NEW active revision."""
        p = self.get_project(project_id)
        source = self.repo.get_revision(revision_id)
        if source is None or source.project_id != p.id:
            raise M.ServiceError(M.ERR_REVISION_NOT_FOUND, "revision not found in this project")
        if revision_id == p.active_revision_id:
            return source
        return self._commit(p, source.snapshot, M.ORIGIN_RESTORE, p.active_revision_id,
                            p.active_revision_id, list(source.scenes))

    def undo_latest(self, project_id: str) -> M.Revision:
        """Undo the latest change: a new active revision equal to the head's parent."""
        p = self.get_project(project_id)
        head = self.repo.get_revision(p.active_revision_id)
        if head is None:
            raise M.ServiceError(M.ERR_REVISION_NOT_FOUND, "no active revision")
        if head.parent_id is None:
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL, "nothing to undo: this is the first revision")
        parent = self.repo.get_revision(head.parent_id)
        if parent is None or parent.project_id != p.id:
            raise M.ServiceError(M.ERR_REVISION_NOT_FOUND, "parent revision not found")
        if parent.content_hash == head.content_hash:
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL, "nothing to undo: no change since the previous revision")
        return self._commit(p, parent.snapshot, M.ORIGIN_RESTORE, head.id, head.id, list(parent.scenes))

    # ---------------- export ----------------

    def export_pdf(self, project_id: str, revision_id: Optional[str] = None,
                   settings: Optional[RenderSettings] = None,
                   out_dir: Optional[Path] = None) -> M.Export:
        p = self.get_project(project_id)
        rev = self.read_revision(project_id, revision_id)
        eng = self._engine(project=p)
        s = settings or eng.default_settings() or self.settings
        out_dir = Path(out_dir) if out_dir else self.exports_dir
        if out_dir is None:
            raise M.ServiceError(M.ERR_RENDERER_UNAVAILABLE, "no export directory configured")
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            pdf_bytes, page_count = eng.render_pdf(rev.snapshot, s)
        except RendererError as exc:
            self.repo.create_export(M.Export(id=M.new_id("exp"), project_id=p.id, revision_id=rev.id,
                                             renderer_config=s.to_dict(), artifact_path="",
                                             page_count=None, status=M.EXPORT_FAILED))
            raise M.ServiceError(M.ERR_RENDERER_UNAVAILABLE, str(exc)) from exc
        artifact = out_dir / f"{rev.id}.pdf"
        tmp = artifact.with_suffix(".pdf.tmp")
        tmp.write_bytes(pdf_bytes)
        tmp.replace(artifact)
        exp = M.Export(id=M.new_id("exp"), project_id=p.id, revision_id=rev.id,
                       renderer_config=s.to_dict(), artifact_path=str(artifact),
                       page_count=page_count, status=M.EXPORT_OK)
        self.repo.create_export(exp)
        return exp

    def pdf_filename(self, project_id: str) -> str:
        return _safe_filename(self.get_project(project_id).title) + ".pdf"

    def export_fountain(self, project_id: str, revision_id: Optional[str] = None) -> dict:
        """The revision's Fountain source (lossless) plus a suggested filename."""
        p = self.get_project(project_id)
        rev = self.read_revision(project_id, revision_id)
        return {"project_id": p.id, "revision_id": rev.id, "title": p.title, "author": p.author,
                "filename": _safe_filename(p.title) + ".fountain", "fountain": rev.snapshot,
                "size_bytes": len(rev.snapshot.encode("utf-8"))}

    def export_fdx(self, project_id: str, revision_id: Optional[str] = None) -> dict:
        """The revision as a Final Draft ``.fdx`` XML document."""
        p = self.get_project(project_id)
        rev = self.read_revision(project_id, revision_id)
        xml = importers.fountain_to_fdx(rev.snapshot)
        return {"project_id": p.id, "revision_id": rev.id, "title": p.title,
                "filename": _safe_filename(p.title) + ".fdx", "fdx": xml,
                "size_bytes": len(xml.encode("utf-8"))}

    def inspect_pages(self, project_id: str, revision_id: Optional[str] = None,
                      settings: Optional[RenderSettings] = None) -> dict:
        p = self.get_project(project_id)
        rev = self.read_revision(project_id, revision_id)
        eng = self._engine(project=p)
        pages = eng.render_pages(rev.snapshot, settings or eng.default_settings() or self.settings)
        return {"revision_id": rev.id, "page_count": len(pages), "pages": pages}
