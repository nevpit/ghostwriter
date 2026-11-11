"""Deterministic validation of a candidate revision against its rules version.

Every check reports ``pass`` / ``fail`` / ``unavailable``. When the candidate's
parse is incomplete (unsupported constructs detected), content-dependent checks
report ``unavailable`` — never a reassuring ``pass`` (per the spec).
"""

from __future__ import annotations

from typing import List, Optional

from . import models as M
from . import rendering
from .rendering import RenderSettings


def _speaker_names(rules: M.RulesVersion) -> Optional[set]:
    """Resolve the allowed-speaker set (with aliases). None = unrestricted."""
    if rules.allowed_speakers is None:
        return None
    allowed = set()
    for entry in rules.allowed_speakers:
        if isinstance(entry, str):
            allowed.add(entry.upper())
        else:
            name = entry.get("name")
            if name:
                allowed.add(name.upper())
            for a in entry.get("aliases", []):
                allowed.add(a.upper())
    return allowed


def _candidate_speakers(scenes: List[M.Scene]) -> List[str]:
    speakers = []
    for sc in scenes:
        for el in sc.elements:
            if el.get("kind") == "character" and el.get("speaker"):
                speakers.append(el["speaker"])
    return speakers


def _dialogue_block_count(scenes: List[M.Scene]) -> int:
    return sum(1 for sc in scenes for el in sc.elements if el.get("kind") == "character")


def _check_protected(candidate_snapshot: str, scenes: List[M.Scene],
                     rules: M.RulesVersion) -> M.Check:
    if not rules.protected:
        return M.Check("PROTECTED_PASSAGES", M.PASS, "no protected passages")
    by_id = {sc.id: sc for sc in scenes}
    for pr in rules.protected:
        sc = by_id.get(pr.scene_id)
        if sc is None:
            return M.Check("PROTECTED_PASSAGES", M.FAIL,
                           f"protected scene {pr.scene_id} missing from candidate")
        start = sc.start + pr.offset_in_scene
        end = start + pr.length
        # A range that can't be located at all (negative / inverted) is malformed.
        # An overflow (``end > len(snapshot)``) happens when the scene shrank -- the
        # slice below then clamps and the hash correctly reports the passage altered.
        if start < 0 or end < start:
            return M.Check("PROTECTED_PASSAGES", M.FAIL,
                           f"protected range for {pr.scene_id} malformed")
        actual = M.sha256_hex(candidate_snapshot[start:end])
        if actual != pr.text_hash:
            return M.Check("PROTECTED_PASSAGES", M.FAIL,
                           f"LOCKED_TEXT_CHANGED: protected passage in {pr.scene_id} was altered")
    return M.Check("PROTECTED_PASSAGES", M.PASS,
                   f"{len(rules.protected)} protected passage(s) unchanged")


def _check_speakers(scenes: List[M.Scene], rules: M.RulesVersion) -> M.Check:
    allowed = _speaker_names(rules)
    if allowed is None:
        return M.Check("ALLOWED_SPEAKERS", M.PASS, "unrestricted")
    bad = sorted({sp for sp in _candidate_speakers(scenes) if sp.upper() not in allowed})
    if bad:
        return M.Check("ALLOWED_SPEAKERS", M.FAIL,
                       f"disallowed speakers: {', '.join(bad)}")
    return M.Check("ALLOWED_SPEAKERS", M.PASS, "all speakers allowed")


def _check_dialogue_blocks(scenes: List[M.Scene], rules: M.RulesVersion) -> M.Check:
    if rules.dialogue_block_limit is None:
        return M.Check("DIALOGUE_BLOCK_LIMIT", M.PASS, "no limit")
    count = _dialogue_block_count(scenes)
    if count > rules.dialogue_block_limit:
        return M.Check("DIALOGUE_BLOCK_LIMIT", M.FAIL,
                       f"{count} dialogue blocks exceed limit {rules.dialogue_block_limit}")
    return M.Check("DIALOGUE_BLOCK_LIMIT", M.PASS,
                   f"{count}/{rules.dialogue_block_limit} dialogue blocks")


def _check_page_limit(candidate_snapshot: str, rules: M.RulesVersion,
                      settings: RenderSettings) -> M.Check:
    if rules.page_limit is None:
        return M.Check("PAGE_LIMIT", M.PASS, "no limit")
    try:
        pages = rendering.count_pages(candidate_snapshot, settings)
    except Exception as exc:  # noqa: BLE001 - never let a layout bug pass a gate
        return M.Check("PAGE_LIMIT", M.UNAVAILABLE, f"renderer unavailable: {exc}")
    if pages > rules.page_limit:
        return M.Check("PAGE_LIMIT", M.FAIL,
                       f"{pages} pages exceed limit {rules.page_limit}")
    return M.Check("PAGE_LIMIT", M.PASS, f"{pages}/{rules.page_limit} pages")


def validate_candidate(candidate_scenes: List[M.Scene],
                       candidate_snapshot: str,
                       problems: List,
                       rules: M.RulesVersion,
                       settings: Optional[RenderSettings] = None) -> List[M.Check]:
    """Run all deterministic checks for a candidate."""
    settings = settings or RenderSettings()

    if problems:
        detail = "; ".join(f"{p.code}@line {p.line}" for p in problems[:8])
        checks = [M.Check("PARSE", M.FAIL,
                          f"parse incomplete: {detail}")]
        for name in ("PROTECTED_PASSAGES", "ALLOWED_SPEAKERS",
                     "DIALOGUE_BLOCK_LIMIT", "PAGE_LIMIT"):
            checks.append(M.Check(name, M.UNAVAILABLE,
                                  "skipped: candidate parse incomplete"))
        return checks

    checks = [M.Check("PARSE", M.PASS, "candidate parsed cleanly")]
    checks.append(_check_protected(candidate_snapshot, candidate_scenes, rules))
    checks.append(_check_speakers(candidate_scenes, rules))
    checks.append(_check_dialogue_blocks(candidate_scenes, rules))
    checks.append(_check_page_limit(candidate_snapshot, rules, settings))
    return checks


def proposal_has_failure(checks: List[M.Check]) -> bool:
    return any(c.status == M.FAIL for c in checks)
