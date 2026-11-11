# Modifying the Ghostwriter plugin's own code (UI / backend)

For changes to the plugin's React UI (`plugin.js`) or FastAPI backend (`dashboard/plugin_api.py`, `screenplay/service.py`) — adding a button, fixing a UI bug, adding a route — NOT for editing a script's content (that's the main SKILL.md path).

## Two copies — edit the deployed one
The desktop app loads the plugin from the **deployed** copy, which can be NEWER than the source:
- Deployed (what the app runs): `C:\Users\Salvatore\AppData\Local\hermes\desktop-plugins\ghostwriter\`
- Source: `C:\Users\Salvatore\AppData\Local\hermes\plugins\ghostwriter\`

They can diverge (deployed may have features the source lacks; different line counts). Always:
1. `diff -q` the corresponding files in both trees first to see which is newer and how far apart they are.
2. Make edits in the **deployed** copy (that's what the user sees).
3. **Sync source ← deployed** for every changed file (`shutil.copyfile` deployed → source) so a later reload-from-source doesn't wipe the change.
4. Confirm with `diff -q` that the changed files are now identical in both trees.

The user must reload/restart the desktop app to pick up `plugin.js` changes.

## CRLF line endings — the `patch` tool silently no-ops on most plugin files
Most deployed plugin files are **CRLF** (`service.py`, `plugin_api.py`, `plugin.js`, `tools.py`, `plugin.yaml`); only `fountain.py` is LF-only. On a CRLF file the `patch` tool can match, print a diff, and report "Update succeeded", yet the **post-write verification fails and the file is NOT modified** — a follow-up read/grep shows the old content and you re-apply the same edit in a loop.
- Check the ending first: on `open(path,"rb").read()`, `b.count(b"\r\n")` vs `b.count(b"\n") - b.count(b"\r\n")`.
- For CRLF files, edit by **direct byte I/O** in `execute_code`: build the anchor with the file's real ending (`NL = b"\r\n"`; multi-line anchors via `NL.join([b"l1", b"l2"])`), `assert b.count(old) == 1`, `b.replace(old, new)`, then `open(path,"wb").write(...)`. Emoji/unicode in the anchor must match exact UTF-8 bytes (inspect with `repr()`).
- Verify the change landed on disk (read back / grep) before moving on — never trust the `patch` diff on a CRLF file.

## Verify a code change (no pytest in the env)
- JS syntax: `node --check plugin.js` (and `desktop/plugin.js`).
- Python syntax: `ast.parse(open(f, encoding="utf-8").read())` on each edited `.py`.
- Full suite: `python tests/run_all.py` from `plugins/ghostwriter` (the suite has **no** pytest dep — `run_all.py` discovers `test_*` fns and reports N/N; `python -m pytest` fails with "No module named pytest"). A passing suite is the backend gate.
- For a UI feature you can't render here, verify the backend contract it depends on by driving the service directly from Python in a temp `HERMES_HOME`/DB (e.g. `svc.import_project(...)` then `svc.save_snapshot(...)`), and trust `node --check` + the fact the JSX mirrors a known-good existing component (e.g. a new panel modeled on the import panel).

## Fast-path caveat
The main SKILL.md's fast-path examples do `sys.path.insert(0, plugins/ghostwriter)` — that drives the **source** service. If the deployed copy has diverged, the live app and your Python session are editing two different backends. `diff -q` first; if they differ, drive (or point `sys.path` at) the deployed copy.

## execute_code persistent kernel serves stale modules
`execute_code` runs in a persistent kernel. If you import a module, edit its `.py` on disk, then re-import it in a later cell, the already-loaded module object is reused (stale) — a guard or newly added method can appear missing, and a guard can look like it "doesn't fire." `del sys.modules['<pkg>']` (and submodules) before the import, or run the cell with `reset=true`, to force a fresh load. Distinguish a real bug from a stale import by re-running the probe in a clean kernel before concluding the code is wrong.

## Adding a new document-type skill (naming standard)
Skills are the "how to use ghostwriter for <format>" docs. The standard is **one namespaced skill per document type**: `ghostwriter:<doctype>` — bare format name, no verb or suffix (`screenplay`, later `novel`, `essay`, `tv-script`). The `ghostwriter` prefix already carries the app identity, so the bare name just has to be the format; that keeps the namespace predictable as formats multiply.
- Drop a new `skills/<doctype>/SKILL.md` (frontmatter: `name: <doctype>`, `description: "Use when ..."`). `__init__.py`'s `register()` loops every `skills/<doctype>/SKILL.md` and calls `ctx.register_skill(doctype, path, description=..., frontmatter=...)`, so a new dir is picked up automatically — **no code change needed**.
- `register_skill(name, path, description="", frontmatter=None)`: `name` must not contain `:` (the `ghostwriter` namespace is added automatically) and `path` may be a str. The skill serves read-only as `ghostwriter:<doctype>` (not copied into `~/.hermes/skills/`, so it updates with the plugin; a user's customized copy is a separate bare-name skill).
- `provides_tools` in `plugin.yaml` is the source of truth for tool names. The drift test `tests/test_skill_tools.py` scans every bundled `skills/*/SKILL.md` + `references/` and fails if it references a `ghost_*`/`ghostwriter_*` tool that is not in `provides_tools` — keep the two in sync when you rename or remove a tool.
- Testing a registration in an isolated home: plugins are **opt-in** (`plugins.enabled` in `config.yaml`). A fresh temp `HERMES_HOME` has nothing enabled, so copy the plugin into `<home>/plugins/<name>/`, write a `config.yaml` containing `plugins.enabled: [name]`, then `discover_plugins(force=True)` and assert `get_plugin_manager().list_plugin_skills(name)` includes the doctype.