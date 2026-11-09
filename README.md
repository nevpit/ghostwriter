# hermes-screenplay

A local screenplay workspace for Hermes Agent: Fountain parsing, immutable
revisions, a proposal workflow with deterministic validation, and stdlib PDF
export. Ships as **11 agent tools** plus a **desktop pane**. No third-party
runtime dependencies (Python stdlib + SQLite only).

Tested against **Hermes v0.22.7** (git install `b200f5bc60e3`).

## What it does

- **Import** a Fountain script into a project with an immutable `v1` revision
  (the exact source is the snapshot of record).
- **Parse** each revision into typed scenes — `scene_heading`, `action`,
  `character` (with `speaker` + optional `V.O.`/`O.S.` extension), `dialogue`,
  `parenthetical`, `transition` — with **byte-accurate character offsets** so a
  scene can be spliced without touching any other byte.
- **Propose** edits as operations (`insert` / `replace`), **check** them with a
  deterministic validator, then **accept** (creates a new immutable revision) or
  **reject** (no revision is created).
- **Stable scene ids** across a scene replacement (diff/anchor-friendly).
- **Export** the active (or any) revision to a Courier PDF (base-14, pure
  stdlib, zero deps).

## Repository layout

```
hermes-screenplay/
  plugin.yaml              # manifest: name, version, provides_tools
  __init__.py              # agent entry point: register(ctx) -> 13 tools
  screenplay/              # the service package (pure stdlib)
    models.py              # dataclasses + ServiceError + HERMES_VERSION
    fountain.py            # offset-accurate Fountain parser + op application
    repository.py          # SQLite (WAL) persistence + migrations
    service.py             # project/revision/proposal lifecycle (orchestrator)
    engine.py              # DocumentEngine ABC + EngineRegistry (format dispatch)
    formats/               # one module per supported format
      __init__.py          # build_default_registry() -> EngineRegistry
      screenplay.py        # ScreenplayEngine: Fountain parse/validate/render/import
      prose.py             # ProseEngine: Markdown parse/validate/render/import
      prose_render.py      # pure-stdlib book-style PDF writer (prose)
    rendering.py           # pure-stdlib Courier PDF writer (screenplay)
    validation.py          # deterministic proposal validator
    runtime.py             # process-wide get_service() singleton + reset_service()
    tools.py               # agent tool handlers + JSON schemas
    migrations/0001_initial.sql
    migrations/0002_recoverable_revisions.sql   # relax UNIQUE content-hash index (recovery)
    migrations/0003_format.sql                  # add projects.format column (multi-format)
  dashboard/
    manifest.json          # {"name","api"} -> web-server router mount
    plugin_api.py          # FastAPI APIRouter (exec'd by the web server)
  desktop/
    plugin.js              # Desktop SDK pane (react/jsx-runtime, no JSX transform)
  tests/
    fixtures/sample.fountain
    test_*.py              # parser / service / rendering / tools / api
    run_all.py             # no-pytest runner
```

## Document engines

The service core is **format-agnostic**: it stores a snapshot (the source of
record), splices it by byte offset, and manages revisions / proposals / rules /
findings. Everything format-specific — parsing into blocks, applying edits,
validating, rendering to PDF, and importing alternate files — is delegated to a
`DocumentEngine` (see `screenplay/engine.py`), resolved per project by
`Project.format`. Two engines are registered by default:

- **`screenplay`** (engine #1) — Fountain, delegating to the existing
  `fountain` / `validation` / `rendering` / `importers` modules.
- **`prose`** (engine #2) — long-form Markdown books. Parses a document into
  nestable blocks (`#` part, `##` chapter, `###` section, pre-heading front
  matter), validates word/part/chapter-count targets from the rules `limits`,
  renders a book-style PDF (`prose_render.py`), and round-trips losslessly to
  Markdown.

`import_file` auto-detects the format from the extension (`.md`/`.markdown`/
`.docx` → prose; everything else → screenplay), and `export_markdown` returns a
prose document's canonical Markdown. New media (novels, docs, video scripts, …)
are added by registering another engine under `screenplay/formats/` without
touching the service core. The agent tool surface and plugin name are unchanged
in this phase.

## Install

The plugin is a **user plugin** — drop it in the user plugin dir and enable it.
`hermes plugins install` only pulls from the catalog / Git / owner-repo, so a
local folder is installed by copy + enable:

```bash
# 1) copy into the user plugin dir (strip build artifacts)
cp -r hermes-screenplay ~/.hermes/plugins/
find ~/.hermes/plugins/hermes-screenplay -name __pycache__ -type d -exec rm -rf {} +

# 2) enable it (adds it to plugins.enabled in config.yaml)
hermes plugins enable hermes-screenplay

# 3) verify the real runtime loads it (13 tools registered)
hermes plugins doctor hermes-screenplay
```

- Agent tools become available on the **next agent session** (the gateway
  defers tool registration across a live reload).
- The **desktop pane** materializes when the desktop app refreshes its plugin
  list (app restart, or opening the pane area); it is copied into
  `~/.hermes/desktop-plugins/hermes-screenplay/` with a `.hermes-package.json`
  marker.
- Data lives under `~/.hermes/plugin-data/hermes-screenplay/` (profile-scoped,
  survives updates).

To uninstall: `hermes plugins disable hermes-screenplay` (or `remove`) and delete
`~/.hermes/plugins/hermes-screenplay/`.

## Tests

No `pytest` required — the suite runs on plain Python (each test is also
pytest-compatible):

```bash
python hermes-screenplay/tests/run_all.py
```

Covers: Fountain parsing (offsets, element typing, extensions), service
lifecycle (import → propose → check → accept/reject, revision immutability,
stable scene ids, error paths), PDF structural validity (header/xref/page count/
Courier/text ops), the 11 agent tool handlers end-to-end, and the dashboard
FastAPI router via `TestClient`.

## Agent tools

All in toolset `screenplay`, returning JSON `{"success": ...}`:

| Tool | Purpose |
|------|---------|
| `screenplay_status` | plugin + version + project count |
| `screenplay_import` | import Fountain text as a new project (v1) |
| `screenplay_list_projects` | list projects |
| `screenplay_get_project` | project + active revision + scene index |
| `screenplay_history` | immutable revision history (dicts) |
| `screenplay_read_scene` | one scene's typed elements |
| `screenplay_propose` | propose insert/replace operations |
| `screenplay_check_proposal` | run deterministic validation |
| `screenplay_accept_proposal` | accept → new immutable revision |
| `screenplay_reject_proposal` | reject (reason recorded, no revision) |
| `screenplay_export_pdf` | export active/any revision to PDF |
| `screenplay_restore` | restore an earlier snapshot as a new revision |
| `screenplay_undo` | restore the previous revision (undo the latest change) |

## Implementation notes

- **Desktop→backend calls use `window.hermesDesktop.api(request)`, not `ctx.rest`.**
  `ctx.rest` does not exist in v0.22.7. The Desktop SDK's native bridge
  auto-injects the `x-hermes-gateway-ticket` and returns the **unwrapped** JSON
  body, which is what the pane's data layer expects.
- **The dashboard router returns bare objects/arrays** (no `{"success"}`
  envelope); errors are `HTTPException` with a structured `detail`. This matches
  the unwrapped-body contract of `window.hermesDesktop.api`.

## Known limitations

- `(beat)`-style parentheticals immediately after dialogue are currently typed
  as `action`; the text is preserved either way (a parser-fidelity nit).
- PDF layout is a single-column Courier rendering (correct content + page
  count); it is not a full industry-standard screenplay page template.
- A fully-authenticated **live** HTTP route probe and the in-GUI pane render
  require a running desktop session (gateway ticket / app refresh) — verified
  here via the real-loader `doctor` (13 tools), the `TestClient` router tests,
  and the live gateway mounting the route (HTTP 401 auth gate, not 404).
- The **agent-in-the-loop** turn (the configured model itself calling
  `screenplay_propose` with generated text) is not exercised headlessly; the 13
  tools are registered and the full service workflow they drive is demonstrated
  end-to-end.
