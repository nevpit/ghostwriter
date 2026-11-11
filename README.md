# Ghostwriter

A Hermes plugin for writing screenplays by talking to your model. Describe a
scene in plain language; the model writes it in proper screenplay format and
saves it to your project, and you read it — laid out like a real script page —
in the Ghostwriter workspace next to the chat.

Pure Python standard library + SQLite on the backend, a single-file desktop
pane, no third-party runtime dependencies. Requires **Hermes Agent and
Hermes Desktop v0.22.7 or later** for the desktop workspace.

## Features

- **Industry-standard formatting.** Scripts are stored as
  [Fountain](https://fountain.io). The parser follows the spec (scene headings
  incl. forced and numbered, character cues with extensions and dual dialogue,
  parentheticals, transitions, centered text, lyrics, notes, boneyard,
  sections, synopses, page breaks, multi-line title page).
- **PDF export with a real screenplay layout**: Courier 12, 1.5"/1" margins,
  standard column positions, page numbers, `(MORE)` / `(CONT'D)` across page
  breaks, no orphaned scene headings, standard title page, bold/italic/underline.
- **Import** Fountain, plain text, Final Draft `.fdx`, and PDF (best effort,
  using text positions to recover the columns). **Export** PDF, Fountain and
  Final Draft `.fdx`.
- **Safe revisions.** Every change is an immutable revision; undo and restore
  never delete anything. Model edits go through *proposals* that are checked
  (Fountain parse, protected passages, allowed speakers, page/speech limits)
  and can be reviewed before they are accepted — or applied immediately and
  undone later. Concurrent edits from the chat and the editor never silently
  overwrite each other.
- **Desktop workspace**: formatted reading view with a scene outline, in-place
  editor and raw Fountain editor, structure-aware find & replace, title page
  editor, proposals review with before/after, rules, history, export, and a
  project-scoped multi-tab chat that refreshes the script as the model works.

## Layout

```
plugin.yaml              manifest (name, version, requires_hermes, provides_tools)
__init__.py              register(ctx): agent tools + bundled skills
screenplay/              backend package (stdlib only)
  fountain.py            Fountain parser, title page, scene splicing
  rendering.py           PDF layout + writer (base-14 Courier, WinAnsi)
  importers.py           Fountain/text/FDX/PDF import, FDX export
  validation.py          deterministic proposal checks
  service.py             projects, revisions, proposals, rules, export
  repository.py          SQLite (WAL) persistence + migrations
  engine.py, formats/    document-engine abstraction (screenplay = engine #1)
  tools.py               agent tool handlers + JSON schemas
  runtime.py             process-wide service, data-dir resolution
dashboard/plugin_api.py  FastAPI router for the desktop pane
desktop/plugin.js        desktop pane (React via the Hermes plugin SDK)
skills/screenplay/       bundled skill, served as ghostwriter:screenplay
tests/                   stdlib test suite (pytest-compatible)
```

## Agent tools

| Tool | Purpose |
|------|---------|
| `ghost_create_project` | new project (optional Fountain text; title page from title/author) |
| `ghost_list_projects` / `ghost_get_project` | projects; compact outline (scenes, characters, words, pages, rules) |
| `ghost_read_script` / `ghost_read_scene` | Fountain text of the script or selected scenes; one scene's elements |
| `ghost_propose` | insert / replace / delete scenes, checked; `apply: true` accepts at once |
| `ghost_check_proposal` / `ghost_accept_proposal` / `ghost_reject_proposal` | proposal lifecycle |
| `ghost_find_replace` | structure-aware rename across the script |
| `ghost_set_title_page` | replace the title page |
| `ghost_update_rules` | page limit, speech limit, allowed speakers, guidance |
| `ghost_history` / `ghost_restore` / `ghost_undo` | recovery |
| `ghost_export` | PDF, Fountain or Final Draft file |
| `ghost_status` | plugin status |

The bundled skill (`skills/screenplay/`) teaches the model the workflow and the
Fountain conventions; `tests/test_skill_tools.py` keeps it in sync with
`provides_tools`.

## Install

Copy the folder into the user plugin directory and enable it:

```bash
cp -r ghostwriter ~/.hermes/plugins/
hermes plugins enable ghostwriter
hermes plugins doctor ghostwriter
```

Agent tools appear in the next agent session. In Hermes Desktop, open
**Capabilities → Plugins**, rescan if needed, and enable Ghostwriter for the
active profile and in the Desktop UI. If the backend is unreachable after
enabling, restart the gateway so it mounts the plugin's routes.

## Data and network disclosure

- **Model access.** The Desktop assistant sends your message, project title and
  ID, scene headings and IDs, and focused-scene context to your active Hermes
  gateway. Hermes routes the turn to its configured model provider, which may
  also receive screenplay text, project rules, and other context returned by
  Ghostwriter tools. Hermes handles provider credentials and chat history.
- **Files and storage.** Desktop sends the contents of files you select for
  import to the active gateway. SQLite projects, revisions, and generated export
  files live in the profile's `plugin-data/ghostwriter/` directory on that
  gateway. On first use Ghostwriter may inspect and move its previous
  `plugin-data/hermes-screenplay/` directory to preserve existing projects.
  Desktop keeps view preferences and assistant tab IDs in its local browser
  storage. The Delete Project action permanently removes the project and its
  revision history after you confirm.
- **Desktop surfaces.** Ghostwriter registers a workspace route, sidebar
  entry, command palette command and keybind. It uses scoped SDK REST for
  project operations and exports, and gateway session RPCs and events for chat.

## Development

```bash
python tests/run_all.py          # no pytest needed; FastAPI is needed for test_api
node --check desktop/plugin.js   # (as an ES module: node --input-type=module --check < desktop/plugin.js)
```

Implementation notes:

- Desktop uses `ctx.rest` for the plugin backend. The router returns bare JSON
  objects and raises `HTTPException` with `{"code", "message", "details"}`
  (`409` for stale writes). The PDF preview route delivers the generated PDF
  and its metadata over the same scoped connection.
- The agent process and the web-server process each open the same SQLite file;
  every revision commit is a compare-and-swap on the project's active revision.
- Scene ids are stable across edits, so a proposal made on an older revision is
  replayed onto the current one unless a scene it touches was edited meanwhile.

## Known limitations

- PDF import needs a text layer and standard font encodings (scans and some
  CID-font PDFs can't be read).
- Dual dialogue prints side by side in the PDF but is shown stacked in the
  workspace.
- Action paragraphs keep the line breaks you type (per the Fountain spec), so
  hard-wrapped text prints hard-wrapped.
