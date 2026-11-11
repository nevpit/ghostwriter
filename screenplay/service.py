"""The screenplay service: orchestration over the repository.

All higher-level behavior lives here: project/revision lifecycle, the
conversational proposal workflow (propose -> check -> accept/reject) with
atomic acceptance and scene-identity preservation, rules versions, PDF export,
and findings.

The service is pure Python and depends only on :mod:`repository`,
:mod:`fountain`, :mod:`validation`, :mod:`rendering`, and :mod:`models`. It is
fully testable headless against a temp SQLite file.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import List, Optional

from . import models as M
from . import fountain
from . import validation
from . import engine
from . import formats
from .rendering import RenderSettings, RendererError
from .repository import Repository


def _next_id(ids: List[str], prefix: str = "scene") -> str:
    """Mint a fresh block id: the prefix plus one past the highest existing index."""
    pat = re.compile(re.escape(prefix) + r"-(\d+)")
    nums = [int(m.group(1)) for i in ids if (m := pat.fullmatch(i))]
    return f"{prefix}-{(max(nums) + 1) if nums else 0}"


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
        diff.append({"scene_id": sc.id, "order": sc.order,
                     "heading": sc.heading, "status": status})
    for bid, bsc in base_by_id.items():
        if bid not in cand_ids:
            diff.append({"scene_id": bid, "heading": bsc.heading, "status": "removed"})
    return diff


class ScreenplayService:
    def __init__(self, repo: Repository, exports_dir: "str | Path | None" = None):
        self.repo = repo
        self.exports_dir = Path(exports_dir) if exports_dir else None
        self.settings = RenderSettings()
        # Per-instance engine registry: the service dispatches every
        # format-specific operation (parse / splice / validate / render / import)
        # through the engine registered for the project's ``format``.
        self.registry = formats.build_default_registry()

    def _engine(self, project_id: Optional[str] = None,
                project: Optional[M.Project] = None) -> "engine.DocumentEngine":
        """Resolve the :class:`DocumentEngine` for a project (by its ``format``)."""
        p = project if project is not None else self.get_project(project_id)
        fmt = p.format or engine.DEFAULT_FORMAT
        try:
            return self.registry.get(fmt)
        except KeyError:
            raise M.ServiceError(M.ERR_PARSE_UNSUPPORTED,
                                 f"no engine registered for format '{fmt}'")

    # ---------------- projects ----------------

    def create_project(self, title: str, author: str = "") -> M.Project:
        p = M.Project(id=M.new_id("proj"), title=title, author=author)
        self.repo.create_project(p)
        rev = self._make_revision(p.id, "", M.ORIGIN_CREATE, None)
        rules = self._default_rules(p.id)
        self.repo.touch_project(p.id, active_revision_id=rev.id, active_rules_id=rules.id,
                                updated_at=M._now_iso())
        p.active_revision_id = rev.id
        p.active_rules_id = rules.id
        return p

    def import_project(self, title: str, author: str, fountain_text: str,
                       format: Optional[str] = None) -> M.Project:
        # Fail fast: parse before any DB write so a malformed document
        # cannot leave an orphaned project row behind.
        eng = self.registry.get(format or engine.DEFAULT_FORMAT)
        parsed, _problems = eng.parse(fountain_text)
        p = M.Project(id=M.new_id("proj"), title=title, author=author,
                      format=format or engine.DEFAULT_FORMAT)
        self.repo.create_project(p)
        rev = self._make_revision(p.id, fountain_text, M.ORIGIN_IMPORT, None,
                                  scenes=parsed)
        rules = self._default_rules(p.id)
        self.repo.touch_project(p.id, active_revision_id=rev.id, active_rules_id=rules.id,
                                updated_at=M._now_iso())
        p.active_revision_id = rev.id
        p.active_rules_id = rules.id
        return p

    def import_file(self, filename: str, content: bytes,
                    title: str = "", author: str = "",
                    format: Optional[str] = None) -> M.Project:
        """Import a screenplay from raw file bytes of any supported format
        (Fountain, plain text, Final Draft ``.fdx``, or ``.pdf``). The format is
        detected, converted to Fountain, then imported (the stored revision is
        the converted Fountain, so it round-trips back out to Fountain)."""
        fmt = format or self._detect_format(filename or "")
        eng = self.registry.get(fmt)
        fountain_text = eng.import_(filename or "", content or b"")
        if not (title or "").strip():
            m = re.search(r"^Title:\s*(.+)$", fountain_text, re.M | re.I)
            stem = ""
            if filename:
                stem = re.sub(r"\.[^.]+$", "", filename).strip()
            title = (m.group(1).strip() if m else stem or "Imported script")
        if not (author or "").strip():
            m = re.search(
                r"^(?:Credit:\s*)?(?:Written by|written by|story by|Story by)"
                r"\s*:?\s*([^\r\n]+)", fountain_text, re.M | re.I)
            author = (m.group(1).strip() if m else "")
        return self.import_project(title, author, fountain_text, format=fmt)

    @staticmethod
    def _detect_format(filename: str) -> str:
        """Default format for an imported file by extension.

        The MVP ships a single engine (screenplay), so every import uses that
        default regardless of extension. When more formats are added, map their
        extensions here (e.g. ``.md`` -> a prose/book engine) so the caller never
        has to pass a format explicitly."""
        return engine.DEFAULT_FORMAT

    def list_projects(self) -> List[M.Project]:
        return self.repo.list_projects()

    def get_project(self, project_id: str) -> M.Project:
        p = self.repo.get_project(project_id)
        if p is None:
            raise M.ServiceError(M.ERR_PROJECT_NOT_FOUND, f"project {project_id} not found")
        return p

    # ---------------- read ----------------

    def read_revision(self, project_id: str, revision_id: str) -> M.Revision:
        self.get_project(project_id)
        rev = self.repo.get_revision(revision_id)
        if rev is None or rev.project_id != project_id:
            raise M.ServiceError(M.ERR_REVISION_NOT_FOUND, f"revision {revision_id} not found")
        return rev

    def read_scene(self, project_id: str, revision_id: Optional[str], scene_id: str) -> dict:
        rev = self.read_revision(project_id, revision_id or self._active_rev(project_id))
        sc = next((s for s in rev.scenes if s.id == scene_id), None)
        if sc is None:
            raise M.ServiceError(M.ERR_SCENE_NOT_FOUND, f"scene {scene_id} not found")
        return {
            "id": sc.id, "order": sc.order, "heading": sc.heading,
            "text": sc.text(rev.snapshot), "elements": sc.elements,
            "parse_ok": sc.parse_ok, "revision_id": rev.id,
        }

    def _active_rev(self, project_id: str) -> str:
        p = self.get_project(project_id)
        if p.active_revision_id is None:
            raise M.ServiceError(M.ERR_VALIDATION, "project has no active revision")
        return p.active_revision_id

    # ---------------- manual edits (agent read->edit->save loop) ----------

    def save_scene(self, project_id: str, scene_id: str, heading: str,
                   content: str, revision_id: Optional[str] = None) -> M.Revision:
        """Replace one scene and store a new (active) revision. Preserves all
        other bytes of the source.

        ``revision_id`` is the writer's expected revision (optimistic
        concurrency): if it is not the currently active revision the save is
        rejected with STALE_REVISION so the editor can re-apply its input on
        top of the newer text instead of silently clobbering it.
        """
        p = self.get_project(project_id)
        if revision_id is None:
            revision_id = p.active_revision_id
        elif revision_id != p.active_revision_id:
            raise M.ServiceError(M.ERR_STALE_REVISION,
                                 f"expected revision {revision_id} is not the "
                                 f"active revision ({p.active_revision_id})")
        rev = self.read_revision(project_id, revision_id)
        op = M.Operation(type="replace", scene_id=scene_id, heading=heading, content=content)
        snapshot, scenes, id_list, problems = self._assemble(rev, [op])
        new_rev = self._make_revision(project_id, snapshot, M.ORIGIN_MANUAL_SAVE, rev.id,
                                      scenes=scenes)
        self.repo.touch_project(project_id, active_revision_id=new_rev.id,
                                updated_at=M._now_iso())
        return new_rev

    def save_snapshot(self, project_id: str, fountain_text: str,
                      revision_id: Optional[str] = None) -> M.Revision:
        """Store a full manual save as a new revision (fresh scene mapping).

        ``revision_id`` pins the writer's expected active revision (optimistic
        concurrency): a stale base is rejected with STALE_REVISION so an
        editor working on an old revision cannot clobber newer text."""
        active = self._active_rev(project_id)
        if revision_id is not None and revision_id != active:
            raise M.ServiceError(
                M.ERR_STALE_REVISION,
                f"revision {revision_id[:8]}... is no longer active "
                f"(active: {active[:8]}...)",
            )
        base = self.read_revision(project_id, revision_id or active)
        new_rev = self._make_revision(project_id, fountain_text, M.ORIGIN_MANUAL_SAVE, base.id)
        self.repo.touch_project(project_id, active_revision_id=new_rev.id,
                                updated_at=M._now_iso())
        return new_rev

    # ---------------- structure-aware find & replace ----------------

    @staticmethod
    def _case_preserve(orig: str, repl: str) -> str:
        """Apply the case pattern of ``orig`` onto ``repl`` so a rename keeps
        the surrounding convention: all-caps stays all-caps, all-lower stays
        all-lower, title-case stays title-case. Falls back to ``repl`` unchanged
        for any other pattern."""
        if not orig or not repl:
            return repl
        if orig.isupper():
            return repl.upper()
        if orig.islower():
            return repl.lower()
        if orig[0].isupper() and (len(orig) == 1 or orig[1:].islower()):
            return repl[0].upper() + repl[1:].lower()
        return repl

    def find_replace(self, project_id: str, query: str, replacement: str,
                     target, revision_id: Optional[str] = None) -> dict:
        """Replace occurrences of ``query`` (case-insensitive) with
        ``replacement`` while preserving Fountain element structure.

        Matches are walked in document order (scene by scene, element by
        element) exactly as the client's search computes them, so a ``target``
        of a 0-based global match index lines up with the client's highlighted
        hit. For a ``character`` cue whose name matches, the replacement is
        uppercased so the all-caps cue survives re-parse -- a lowercase name in
        the character column would be re-read as ``action`` and collapse the
        following dialogue block. Only the matched lines are spliced back at
        their exact offsets; every other byte of the snapshot is untouched.
        """
        q = (query or "").strip()
        if not q:
            raise M.ServiceError(M.ERR_VALIDATION,
                                 "query must be a non-empty string",
                                 {"field": "query"})
        if not isinstance(replacement, str):
            replacement = ""
        active = self._active_rev(project_id)
        if revision_id is not None and revision_id != active:
            raise M.ServiceError(
                M.ERR_STALE_REVISION,
                f"revision {revision_id[:8]}... is no longer active "
                f"(active: {active[:8]}...)",
            )
        base = self.read_revision(project_id, revision_id or active)
        snapshot = base.snapshot
        scenes, _problems = fountain.parse(snapshot)
        qlen = len(q)
        q_low = q.lower()

        def occurrences(t):
            low = t.lower()
            i = 0
            out = []
            while True:
                j = low.find(q_low, i)
                if j == -1:
                    break
                out.append((j, j + qlen))
                i = j + qlen
            return out

        match_list = []
        for scene in scenes:
            for el in scene.elements:
                etext = el.get("text") or ""
                if not etext:
                    continue
                for rank in range(len(occurrences(etext))):
                    match_list.append((el, rank))
        total = len(match_list)

        if isinstance(target, (int, float)) and not isinstance(target, bool):
            idx = int(target)
            if idx < 0 or idx >= total:
                raise M.ServiceError(M.ERR_VALIDATION,
                                     "match index out of range",
                                     {"target": idx, "count": total})
            selected = [match_list[idx]]
        else:
            if target not in (None, "all"):
                raise M.ServiceError(M.ERR_VALIDATION,
                                     "target must be 'all' or a match index",
                                     {"target": target})
            selected = match_list

        if not selected:
            raise M.ServiceError(M.ERR_VALIDATION, "no matches found",
                                 {"count": 0})

        edits = []
        for (el, rank) in selected:
            span_start = el.get("start")
            span_end = el.get("end")
            if span_start is None or span_end is None:
                continue
            raw = snapshot[span_start:span_end]
            occs = occurrences(raw)
            if rank >= len(occs):
                continue
            rs, re_ = occs[rank]
            speaker = el.get("speaker")
            if speaker and (q_low in speaker.lower()):
                # Character cue: always keep the all-caps convention so the
                # cue survives re-parse and the dialogue block is not collapsed.
                new = replacement.upper()
            else:
                new = self._case_preserve(raw[rs:re_], replacement)
            edits.append((span_start + rs, span_start + re_, new))

        if not edits:
            raise M.ServiceError(M.ERR_VALIDATION, "no replacement made",
                                 {"count": total})

        new_snapshot = snapshot
        for (s, e, new) in sorted(edits, key=lambda x: x[0], reverse=True):
            new_snapshot = new_snapshot[:s] + new + new_snapshot[e:]

        rev = self.save_snapshot(project_id, new_snapshot, revision_id)
        return {"revision_id": rev.id, "replaced": len(edits), "count": total}

    def history(self, project_id: str) -> List[dict]:
        self.get_project(project_id)
        out = []
        for rev in self.repo.list_revisions(project_id):
            out.append({
                "id": rev.id, "parent_id": rev.parent_id, "origin": rev.origin,
                "content_hash": rev.content_hash, "created_at": rev.created_at,
                "scene_count": len(rev.scenes),
                "is_active": rev.id == self.get_project(project_id).active_revision_id,
            })
        return out

    # ---------------- rules ----------------

    def _default_rules(self, project_id: str) -> M.RulesVersion:
        rv = M.RulesVersion(id=M.new_id("rules"), project_id=project_id)
        self.repo.create_rules(rv)
        return rv

    def update_rules(self, project_id: str, rules_id: Optional[str] = None, **changes) -> M.RulesVersion:
        """Create a new rules version (append-only). ``changes`` keys:
        dialogue_block_limit, page_limit, allowed_speakers, protected, guidance."""
        self.get_project(project_id)
        base_id = rules_id or self.get_project(project_id).active_rules_id
        base = self.repo.get_rules(base_id) if base_id else None
        rv = M.RulesVersion(id=M.new_id("rules"), project_id=project_id, parent_id=base_id)
        if base:
            rv.dialogue_block_limit = base.dialogue_block_limit
            rv.page_limit = base.page_limit
            rv.allowed_speakers = base.allowed_speakers
            rv.protected = base.protected
            rv.guidance = list(base.guidance)
            rv.limits = dict(base.limits)
        for k, v in changes.items():
            if k == "protected" and v is not None:
                rv.protected = [d if isinstance(d, M.ProtectedRange) else M.ProtectedRange.from_dict(d)
                                for d in v]
            elif hasattr(rv, k):
                setattr(rv, k, v)
        self.repo.create_rules(rv)
        self.repo.touch_project(project_id, active_rules_id=rv.id, updated_at=M._now_iso())
        return rv

    def protect_scene_text(self, project_id: str, scene_id: str, offset_in_scene: int,
                           length: int, label: str = "", rules_id: Optional[str] = None) -> M.RulesVersion:
        """Add a protected passage anchored to a scene + in-scene offset."""
        self.get_project(project_id)
        base_id = rules_id or self.get_project(project_id).active_rules_id
        base = self.repo.get_rules(base_id)
        rev = self.read_revision(project_id, self._active_rev(project_id))
        sc = next((s for s in rev.scenes if s.id == scene_id), None)
        if sc is None:
            raise M.ServiceError(M.ERR_SCENE_NOT_FOUND, f"scene {scene_id} not found")
        text = rev.snapshot[sc.start + offset_in_scene: sc.start + offset_in_scene + length]
        pr = M.ProtectedRange(scene_id=scene_id, offset_in_scene=offset_in_scene,
                              length=length, text_hash=M.sha256_hex(text), label=label)
        return self.update_rules(project_id, base_id, protected=base.protected + [pr])

    # ---------------- proposals ----------------

    def _assemble(self, base_rev: M.Revision, operations: List[M.Operation]):
        """Splice operations onto the base snapshot, tracking stable scene ids.

        Returns ``(snapshot, scenes, id_list, problems)`` where ``scenes`` carry
        their stable ids and ``problems`` are the candidate's parse problems.
        """
        eng = self._engine(base_rev.project_id)
        id_list = [s.id for s in base_rev.scenes]
        snapshot = base_rev.snapshot
        scenes = base_rev.scenes
        ok = True
        for op in operations:
            if op.type == "insert":
                new_id = _next_id(id_list, eng.id_prefix)
                pos = len(id_list) if op.before_scene_id is None else id_list.index(op.before_scene_id)
                id_list.insert(pos, new_id)
            elif op.type != "replace":
                raise M.ServiceError(M.ERR_INVALID_PROPOSAL, f"bad op type {op.type}")
            try:
                snapshot, fresh = eng.apply_operation(snapshot, scenes, op, None)
            except M.ServiceError:
                raise
            if len(fresh) != len(id_list):
                ok = False
                break
            for i, sc in enumerate(fresh):
                sc.id = id_list[i]
            scenes = fresh

        final_scenes, problems = eng.parse(snapshot)
        if not ok or len(final_scenes) != len(id_list):
            # Malformed candidate: keep positional ids, flag it.
            if len(final_scenes) == len(id_list):
                for i, sc in enumerate(final_scenes):
                    sc.id = id_list[i]
            problems = problems or [fountain.Problem("SCENE_COUNT_MISMATCH", 0, 0,
                                                     "operations changed the scene count unexpectedly")]
            return snapshot, final_scenes, id_list, problems
        for i, sc in enumerate(final_scenes):
            sc.id = id_list[i]
        return snapshot, final_scenes, id_list, problems

    def propose(self, project_id: str, operations: List[dict],
                base_revision_id: Optional[str] = None,
                rules_id: Optional[str] = None,
                idempotency_key: Optional[str] = None) -> M.Proposal:
        p = self.get_project(project_id)
        if idempotency_key:
            existing = self.repo.find_proposal_by_idem(project_id, idempotency_key)
            if existing is not None:
                return existing
        base_id = base_revision_id or p.active_revision_id
        base_rev = self.read_revision(project_id, base_id)
        rid = rules_id or p.active_rules_id
        rules = self.repo.get_rules(rid)
        if rules is None:
            raise M.ServiceError(M.ERR_VALIDATION, f"rules {rid} not found")

        ops = [M.Operation.from_dict(o) for o in operations]
        eng = self._engine(project=p)
        snapshot, scenes, _id_list, problems = self._assemble(base_rev, ops)
        checks = eng.validate(scenes, snapshot, problems, rules, self.settings)
        status = M.BLOCKED if validation.proposal_has_failure(checks) else M.PENDING
        diff = build_diff(base_rev, scenes, snapshot)

        prop = M.Proposal(
            id=M.new_id("prop"), project_id=project_id, base_revision_id=base_id,
            rules_id=rid, operations=ops, candidate_snapshot=snapshot,
            candidate_hash=M.sha256_hex(snapshot), checks=checks, status=status,
            idempotency_key=idempotency_key, diff=diff,
        )
        self.repo.create_proposal(prop)
        return prop

    def get_proposal(self, proposal_id: str) -> M.Proposal:
        prop = self.repo.get_proposal(proposal_id)
        if prop is None:
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL, f"proposal {proposal_id} not found")
        return prop

    def proposal_view(self, proposal_id: str) -> dict:
        """Proposal plus backend-generated before/after text for changed scenes.

        The comparison is computed here from the stored operations against the
        proposal's base revision — never from a model summary — so the Desktop
        proposal review cannot be misled by the chat transcript.
        """
        prop = self.get_proposal(proposal_id)
        p = self.get_project(prop.project_id)
        base_rev = self.repo.get_revision(prop.base_revision_id)
        stale = (base_rev is None or base_rev.project_id != p.id
                 or prop.status == M.STALE)
        view: dict = {
            **prop.to_dict(),
            "base_is_active": prop.base_revision_id == p.active_revision_id,
            "stale": stale,
            "changes": [],
        }
        if not stale:
            _snap, cand_scenes, _ids, _problems = self._assemble(
                base_rev, prop.operations)
            cand_by_id = {s.id: s for s in cand_scenes}
            base_by_id = {s.id: s for s in base_rev.scenes}
            for d in prop.diff:
                if d.get("status") == "unchanged":
                    continue
                before = base_by_id.get(d.get("scene_id"))
                after = cand_by_id.get(d.get("scene_id"))
                heading = d.get("heading")
                if not heading:
                    heading = (after.heading if after
                               else (before.heading if before else ""))
                view["changes"].append({
                    "scene_id": d.get("scene_id"),
                    "heading": heading,
                    "status": d.get("status"),
                    "before": before.text(base_rev.snapshot) if before else "",
                    "after": (after.text(prop.candidate_snapshot) if after else ""),
                })
        return view

    def list_proposals(self, project_id: str) -> List[M.Proposal]:
        self.get_project(project_id)
        return self.repo.list_proposals(project_id)

    def check_proposal(self, proposal_id: str) -> M.Proposal:
        """Re-validate a stored proposal against its base revision + rules."""
        prop = self.get_proposal(proposal_id)
        p = self.get_project(prop.project_id)
        base_rev = self.repo.get_revision(prop.base_revision_id)
        if base_rev is None or base_rev.project_id != p.id:
            self.repo.set_proposal_status(prop.id, M.STALE)
            prop.status = M.STALE
            return prop
        rules = self.repo.get_rules(prop.rules_id)
        if rules is None:
            self.repo.set_proposal_status(prop.id, M.STALE)
            prop.status = M.STALE
            return prop
        if M.sha256_hex(prop.candidate_snapshot) != prop.candidate_hash:
            raise M.ServiceError(M.ERR_CONFLICT, "candidate snapshot does not match its hash")
        eng = self._engine(project=p)
        scenes, problems = eng.parse(prop.candidate_snapshot)
        checks = eng.validate(scenes, prop.candidate_snapshot, problems, rules, self.settings)
        prop.checks = checks
        prop.status = M.BLOCKED if validation.proposal_has_failure(checks) else M.PENDING
        # persist updated checks/status
        import dataclasses
        self.repo._conn.execute(
            "UPDATE proposals SET checks=?, status=?, updated_at=? WHERE id=?",
            (json.dumps([c.to_dict() for c in checks]), prop.status, M._now_iso(), prop.id),
        )
        self.repo._conn.commit()
        return prop

    def accept_proposal(self, proposal_id: str) -> M.Revision:
        """Atomically accept a valid pending proposal: revalidate, create a new
        revision from the candidate, make it active, and mark the proposal
        accepted. Protection carries over via the immutable rules version."""
        prop = self.get_proposal(proposal_id)
        p = self.get_project(prop.project_id)

        if prop.status == M.ACCEPTED:
            return self.read_revision(p.id, p.active_revision_id)
        if prop.status == M.REJECTED:
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL, "cannot accept a rejected proposal")

        base_rev = self.repo.get_revision(prop.base_revision_id)
        if base_rev is None or base_rev.project_id != p.id:
            self.repo.set_proposal_status(prop.id, M.STALE)
            raise M.ServiceError(M.ERR_STALE_REVISION, "base revision no longer valid")
        rules = self.repo.get_rules(prop.rules_id)
        if rules is None:
            self.repo.set_proposal_status(prop.id, M.STALE)
            raise M.ServiceError(M.ERR_RULES_CHANGED, "rules version no longer valid")
        # Editing a rule creates a new rules version and invalidates older proposals
        # (plan M3): a proposal validated against a superseded rules version is stale.
        if prop.rules_id != p.active_rules_id:
            self.repo.set_proposal_status(prop.id, M.STALE)
            raise M.ServiceError(M.ERR_RULES_CHANGED,
                                 "rules changed after this proposal was made")

        if M.sha256_hex(prop.candidate_snapshot) != prop.candidate_hash:
            raise M.ServiceError(M.ERR_CONFLICT, "candidate snapshot does not match its hash")

        # Re-run deterministic validation at accept time.
        eng = self._engine(project=p)
        scenes, problems = eng.parse(prop.candidate_snapshot)
        # re-assign stable ids using stored operations
        _snap, scenes, id_list, problems = self._assemble(base_rev, prop.operations)
        checks = eng.validate(scenes, prop.candidate_snapshot, problems, rules, self.settings)
        if validation.proposal_has_failure(checks):
            self.repo.set_proposal_status(prop.id, M.BLOCKED)
            prop.checks = checks
            prop.status = M.BLOCKED
            raise M.ServiceError(M.ERR_LOCKED_TEXT_CHANGED if any(
                c.name == "PROTECTED_PASSAGES" and c.status == M.FAIL for c in checks
            ) else M.ERR_VALIDATION, "proposal now fails validation")

        # Atomic commit: new revision + active pointer + proposal accepted.
        new_rev = M.Revision(
            id=M.new_id("rev"), project_id=p.id, parent_id=prop.base_revision_id,
            snapshot=prop.candidate_snapshot,
            content_hash=M.sha256_hex(prop.candidate_snapshot),
            origin=M.ORIGIN_PROPOSAL, scenes=scenes,
        )
        with self.repo.transaction() as conn:
            conn.execute(
                "INSERT INTO revisions (id,project_id,parent_id,snapshot,content_hash,"
                "origin,created_at) VALUES (?,?,?,?,?,?,?)",
                (new_rev.id, p.id, new_rev.parent_id, new_rev.snapshot,
                 new_rev.content_hash, new_rev.origin, new_rev.created_at))
            for s in scenes:
                conn.execute(
                    "INSERT INTO scenes (revision_id,id,scene_order,heading,start_offset,"
                    "end_offset,parse_ok) VALUES (?,?,?,?,?,?,?)",
                    (new_rev.id, s.id, s.order, s.heading, s.start, s.end,
                     1 if s.parse_ok else 0))
            conn.execute(
                "UPDATE projects SET active_revision_id=?, updated_at=? WHERE id=?",
                (new_rev.id, M._now_iso(), p.id))
            conn.execute(
                "UPDATE proposals SET status=?, updated_at=? WHERE id=?",
                (M.ACCEPTED, M._now_iso(), prop.id))
        self.repo.get_revision(new_rev.id)  # cache-warm / validate
        return new_rev

    def reject_proposal(self, proposal_id: str, reason: str = "") -> M.Proposal:
        prop = self.get_proposal(proposal_id)
        if prop.status in (M.ACCEPTED,):
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL, "proposal already accepted")
        self.repo.set_proposal_status(prop.id, M.REJECTED)
        prop.status = M.REJECTED
        return prop

    # ---------------- recovery (immutable, auditable) ----------------

    def _commit_restored(self, p: M.Project, source: M.Revision) -> M.Revision:
        """Atomically create a new active revision whose content is *source*'s
        snapshot. Scene identity and offsets are carried over from *source* (the
        snapshot is byte-identical, so its stored scene offsets remain valid)."""
        new_rev = M.Revision(
            id=M.new_id("rev"), project_id=p.id, parent_id=p.active_revision_id,
            snapshot=source.snapshot, content_hash=M.sha256_hex(source.snapshot),
            origin=M.ORIGIN_RESTORE, scenes=list(source.scenes),
        )
        with self.repo.transaction() as conn:
            conn.execute(
                "INSERT INTO revisions (id,project_id,parent_id,snapshot,content_hash,"
                "origin,created_at) VALUES (?,?,?,?,?,?,?)",
                (new_rev.id, p.id, new_rev.parent_id, new_rev.snapshot,
                 new_rev.content_hash, new_rev.origin, new_rev.created_at))
            for s in source.scenes:
                conn.execute(
                    "INSERT INTO scenes (revision_id,id,scene_order,heading,start_offset,"
                    "end_offset,parse_ok) VALUES (?,?,?,?,?,?,?)",
                    (new_rev.id, s.id, s.order, s.heading, s.start, s.end,
                     1 if s.parse_ok else 0))
            conn.execute(
                "UPDATE projects SET active_revision_id=?, updated_at=? WHERE id=?",
                (new_rev.id, M._now_iso(), p.id))
        return new_rev

    def restore_snapshot(self, project_id: str, revision_id: str) -> M.Revision:
        """Restore an earlier snapshot as a NEW active revision. The current head
        is preserved in history (audit trail); scene ids stay stable."""
        p = self.get_project(project_id)
        target = self.repo.get_revision(revision_id)
        if target is None or target.project_id != p.id:
            raise M.ServiceError(M.ERR_REVISION_NOT_FOUND,
                                 "revision not found in this project")
        if revision_id == p.active_revision_id:
            return self.repo.get_revision(p.active_revision_id)
        return self._commit_restored(p, target)

    def undo_latest(self, project_id: str) -> M.Revision:
        """Undo only the LATEST change against an unchanged head: create a new
        active revision whose content is the head's parent (the state before the
        latest change). Refused when the head is the initial revision."""
        p = self.get_project(project_id)
        head = self.repo.get_revision(p.active_revision_id)
        if head is None:
            raise M.ServiceError(M.ERR_REVISION_NOT_FOUND, "no active revision")
        if head.parent_id is None:
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL,
                                 "nothing to undo: head is the initial revision")
        parent = self.repo.get_revision(head.parent_id)
        if parent is None or parent.project_id != p.id:
            raise M.ServiceError(M.ERR_REVISION_NOT_FOUND, "parent revision not found")
        if parent.content_hash == head.content_hash:
            raise M.ServiceError(M.ERR_INVALID_PROPOSAL,
                                 "head already equals its parent; nothing to undo")
        return self._commit_restored(p, parent)

    # ---------------- export ----------------

    def export_pdf(self, project_id: str, revision_id: Optional[str] = None,
                   settings: Optional[RenderSettings] = None,
                   out_dir: Optional[Path] = None) -> M.Export:
        p = self.get_project(project_id)
        rev = self.read_revision(project_id, revision_id or p.active_revision_id)
        s = settings or self._engine(project=p).default_settings() or self.settings
        out_dir = Path(out_dir) if out_dir else self.exports_dir
        if out_dir is None:
            raise M.ServiceError(M.ERR_RENDERER_UNAVAILABLE, "no export directory configured")
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            pdf_bytes, page_count = self._engine(project=p).render_pdf(rev.snapshot, s)
        except RendererError as exc:
            exp = M.Export(id=M.new_id("exp"), project_id=p.id, revision_id=rev.id,
                           renderer_config=s.to_dict(), artifact_path="",
                           page_count=None, status=M.EXPORT_FAILED)
            self.repo.create_export(exp)
            raise M.ServiceError(M.ERR_RENDERER_UNAVAILABLE, str(exc)) from exc
        artifact = out_dir / f"{rev.id}.pdf"
        artifact.write_bytes(pdf_bytes)
        exp = M.Export(id=M.new_id("exp"), project_id=p.id, revision_id=rev.id,
                       renderer_config=s.to_dict(), artifact_path=str(artifact),
                       page_count=page_count, status=M.EXPORT_OK)
        self.repo.create_export(exp)
        return exp

    def export_fountain(self, project_id: str,
                        revision_id: Optional[str] = None) -> dict:
        """Serialize a revision to Fountain text.

        The snapshot is the byte-exact Fountain source (see models.Revision),
        so this is a lossless round-trip of whatever was imported or edited.
        Returns metadata plus the ``fountain`` text for the client to download
        as a ``.fountain`` file (openable in Fountain, Final Draft, etc.).
        """
        p = self.get_project(project_id)
        rev = self.read_revision(project_id, revision_id or p.active_revision_id)
        title = (p.title or "script").strip()
        # Build a filesystem-safe filename from the title.
        safe = "".join(c if (c.isalnum() or c in " -_.") else "_" for c in title).strip()
        filename = (safe or "script") + ".fountain"
        snapshot = rev.snapshot
        return {
            "project_id": p.id,
            "revision_id": rev.id,
            "title": p.title,
            "author": p.author,
            "filename": filename,
            "fountain": snapshot,
            "size_bytes": len(snapshot.encode("utf-8")),
        }

    def inspect_pages(self, project_id: str, revision_id: Optional[str] = None,
                      settings: Optional[RenderSettings] = None) -> dict:
        p = self.get_project(project_id)
        rev = self.read_revision(project_id, revision_id or p.active_revision_id)
        s = settings or self._engine(project=p).default_settings() or self.settings
        pages = self._engine(project=p).render_pages(rev.snapshot, s)
        return {"revision_id": rev.id, "page_count": len(pages), "pages": pages}

    # ---------------- findings ----------------

    def add_finding(self, project_id: str, revision_id: str, observation: str,
                    evidence: Optional[List[dict]] = None) -> M.Finding:
        self.get_project(project_id)
        f = M.Finding(id=M.new_id("find"), project_id=project_id, revision_id=revision_id,
                      evidence=evidence or [], observation=observation)
        self.repo.create_finding(f)
        return f

    def list_findings(self, project_id: str, status: Optional[str] = None) -> List[M.Finding]:
        self.get_project(project_id)
        return self.repo.list_findings(project_id, status)

    def resolve_finding(self, finding_id: str) -> None:
        self.repo.set_finding_status(finding_id, M.FINDING_RESOLVED)

    # ---------------- helpers ----------------

    def _make_revision(self, project_id: str, snapshot: str, origin: str,
                       parent_id: Optional[str],
                       scenes: Optional[List[M.Scene]] = None) -> M.Revision:
        if scenes is None:
            scenes, _problems = self._engine(project_id).parse(snapshot)
        rev = M.Revision(
            id=M.new_id("rev"), project_id=project_id, parent_id=parent_id,
            snapshot=snapshot, content_hash=M.sha256_hex(snapshot),
            origin=origin, scenes=scenes,
        )
        self.repo.create_revision(rev)
        return rev
