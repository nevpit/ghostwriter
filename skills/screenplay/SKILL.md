---
name: screenplay
description: "Use when editing or creating a screenplay in ghostwriter."
version: 1
---

# Screenplay (ghostwriter)

## When to Use
The user asks to change a screenplay in the ghostwriter plugin — rename a character, rewrite a scene, tweak dialogue, fix a slugline — OR to create a new one from a prose description / beat-sheet + editorial notes. Goal: edits are **near-instant AND correct**; do not over-investigate for simple changes. Creating/importing a new project, or fully REWRITING an existing one (not via `ghost_import`, which only makes a new project): see references/authoring-and-import.md. Modifying the plugin's own UI/backend code (a button, a route, a UI bug) rather than a script's content → the app runs a **deployed** copy, not the source; see references/plugin-code-changes.md before editing.

## Modifying the plugin's UI/backend code (not script content)
The desktop app runs the **deployed** copy `...\desktop-plugins\ghostwriter\`, which can be NEWER than the source `...\plugins\ghostwriter\`. `diff -q` the two trees first; edit the **deployed** copy; then **sync source ← deployed** for every changed file, or a later reload wipes the change. Verify with `node --check` + `python tests/run_all.py` (no pytest in the env) + a source-vs-deployed `diff -q`. Full workflow + the execute_code stale-module pitfall: references/plugin-code-changes.md.

## The lean path (simple edits: rename, single-scene rewrite, dialogue tweak)
1. `ghost_get_project(project_id)` → active revision + scenes (heading, `start`/`end` offsets, elements).
2. Build `operations`. For a `replace`: `scene_id`, `heading` (unchanged unless renaming the slugline), `content` = the scene **body** Fountain (everything after the heading line, heading excluded).
   - **Name/character rename** (the common case): use `ghost_find_replace(project_id, query, replacement, target="all")` — one structure-aware call, not hand-built per-scene `replace` ops. A blind case-insensitive string swap lowercases the **ALL-CAPS character cue**, and the parser then collapses that character/parenthetical/dialogue block into `action` (this is what "breaks the formatting"); `find_replace` keeps cues ALL-CAPS, case-preserves the prose (`MARTHA`→`ARTHUR` in a cue, `Martha`→`Arthur` in an action line), and splices at byte offsets so nothing else moves. No `ghost_propose`/accept round-trip.
   - Non-rename body edits stay on the `replace`-op path above. Preserve Fountain indentation (character cue ~20 spaces, dialogue/parenthetical ~10 spaces).
3. `ghost_propose(project_id, operations)`. This runs 5 deterministic checks incl. **PARSE**. If `PARSE: pass` and `status: pending`, the candidate is well-formed — **that is the correctness gate. Do NOT pre-verify in Python for structure-preserving edits.**
4. Tell the user it's PENDING; they **Accept** in the Proposals tab (or ask you to `ghost_accept_proposal(proposal_id)`).

That's ~2 tool calls. Do not re-read plugin source you already understand, and batch tool calls (e.g. `tool_describe` several tools in one call) to cut round-trips.

## When to pre-verify first
Only when the edit is **structurally risky**: changes scene count, reorders/inserts scenes, or you're unsure the candidate re-parses. Then, with the venv Python, `sys.path.insert(0, plugin_dir)` and `from screenplay import fountain`: run `fountain.apply_operation` per op then `fountain.parse`, confirm N clean scenes + `problems == []`, then propose.
- venv python: `C:\Users\Salvatore\AppData\Local\hermes\installs\9e08840c9185483d\environments\0e972a9ce1d2448381dc67447903bc8a\venv\Scripts\python.exe`
- plugin_dir: `C:\Users\Salvatore\AppData\Local\hermes\plugins\ghostwriter`

## Content-format gotchas
- `content` is the body only; the tool's `_format_scene_text(heading, content)` = `heading + "\n" + content.strip("\n")`. Outer newlines are stripped, so the blank line between heading and first body line collapses — **harmless, still parses**. Don't fight it.
- `replace` splices only that scene's region; all other scene bytes are untouched. Scene ids stay stable.
- A standalone **ALL-CAPS** line at the END of a scene (e.g. `FADE OUT.`) is mis-parsed as a character cue (speaker + extension) → that scene's `parse_ok` goes false. End on a normal-case action line. `FADE IN:` at the very top is safe (absorbed as front matter).
- Consecutive non-blank lines merge into ONE paragraph. For a list (on-screen rules, a Notes doc), blank-line separate each item.

## Rewriting an existing project (full replace — NOT a new project)
`ghost_import` ALWAYS creates a NEW project. To replace the entire script already in a project, commit it via `ghost_propose` as ops against the active revision:
- one `replace` per EXISTING scene (`scene_id` + `heading` + `content` = that scene's body),
- one `insert` per ADDED scene (`before_scene_id` = the scene it lands before; omit for append).
Ops are plain dicts `{"type","scene_id","before_scene_id","heading","content"}`; `Operation.from_dict` fills absent keys with None/"". `_assemble` applies them SEQUENTIALLY against the evolving snapshot, re-mapping STABLE scene ids — so referencing the original `scene-0..n` ids works in any order (a `replace` keeps its id; an `insert` adds a new one at the target's position). This IS the structurally-risky case: confirm scene count + `problems == []` on the candidate before `ghost_accept_proposal`.

### Fast path: drive the service from Python (many ops / length iteration)
The `ghost_*` routes are thin wrappers over one service. For a measure→propose→check→accept→export→verify flow, drive it from `execute_code` rather than hand-transcribing multi-line JSON into a tool call:
```python
import sys, os, json
sys.path.insert(0, r"C:\Users\Salvatore\AppData\Local\hermes\plugins\ghostwriter")
from screenplay import runtime, rendering, fountain
svc  = runtime.get_service()
p    = svc.get_project(project_id)
snap = svc.read_revision(project_id, p.active_revision_id).snapshot
ops  = json.load(open("ops.json"))      # list of op dicts (shape above)
prop = svc.propose(project_id, ops)      # .status 'pending'|'blocked', .checks
checked = svc.check_proposal(prop.id)    # re-runs the deterministic checks
rev  = svc.accept_proposal(prop.id)      # -> new active Revision
exp  = svc.export_pdf(project_id)        # M.Export
exp.to_dict()                            # {'artifact_path':..., 'page_count':...}
```
Build `ops` from your Fountain source: `fountain.parse(text)` → each scene has `.start/.end/.heading`; a scene's body = `text[after-heading-line : scene.end]`.

### Fast page-count (iterate length WITHOUT exporting each time)
```python
s   = rendering.RenderSettings()
npp = int((s.page_height - s.margin_top - s.margin_bottom) // s.leading)
pages = (len(rendering.layout_lines(snapshot, s)) + npp - 1) // npp
```
Tune length here; confirm the final count with `export_pdf(...).page_count`. When the user wants it "longer" / to fill the cap, target the UPPER end (e.g. a solid ~4.5–5 of a 5-page cap) — a 1–2 line leftover final page reads as unfinished.

### Verify a committed rewrite
A splice normalizes whitespace, so the accepted snapshot's inter-scene blank-line count can differ from your source — cosmetic only (parsed elements and the PDF are unaffected). Confirm CONTENT survived with a whitespace-insensitive compare, not byte-for-byte: `re.sub(r"\s+"," ",accepted) == re.sub(r"\s+"," ",source)`, and `fountain.parse(accepted)` → N clean scenes, `problems == []`.

## Workflow semantics (for explaining to the user)
- Accept → new **immutable** revision (History count +1, new one active). Reject → nothing changes.
- Changing the base revision or saving new rules → the pending proposal becomes **STALE** (must reject).
- A failed check (e.g. `PROTECTED_PASSAGES`, `PAGE_LIMIT`) → **BLOCKED** (can't accept).
- Restore (History) → copies an old revision to the top as a NEW revision; nothing deleted. Undo → reverts the last change.

## Deterministic checks run on every proposal
`PARSE`, `PROTECTED_PASSAGES` (locked text unchanged / `LOCKED_TEXT_CHANGED`), `ALLOWED_SPEAKERS`, `DIALOGUE_BLOCK_LIMIT`, `PAGE_LIMIT`. Any FAIL → BLOCKED. `PAGE_LIMIT` only fires when the project has a `page_limit` RULE set (default: none); for a length cap, verify with `ghost_export_pdf` → `page_count`.
