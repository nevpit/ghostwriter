# Custom icons for Ghostwriter

Drop your icon files in **this folder** — one file per icon, **SVG**.
When you've added them, tell Hermes and it will wire them into `desktop/plugin.js`
(monochrome ones are inlined as `<svg>` using `currentColor`, so they follow the
app's light/dark theme automatically).

## Format rules

- **Type:** `.svg` (raster `.png` works for a multi-colour logo, but it won't
  theme-adapt — prefer SVG).
- **Grid:** `viewBox="0 0 24 24"`. Hermes renders them at 16–20 px.
- **Colour:** make them **monochrome** and use `currentColor` — never a hard-coded
  `#hex`. That is what lets an icon follow the active theme (light/dark) with no
  extra code.
  - Line/outline style (recommended): `fill="none" stroke="currentColor" stroke-width="2"`
  - Solid style: `fill="currentColor"`
- **Style:** keep them simple and minimal to match the chrome.

### Copy-paste template (line icon)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <!-- your path(s) here, drawn inside the 24x24 box -->
</svg>
```

### Copy-paste template (solid icon)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
  <!-- your path(s) here -->
</svg>
```

## Which icons to provide

These map to the glyphs the app currently uses. Name the file after the name in
the left column — if you'd rather name them differently, just tell Hermes and it
will map them for you.

| File name              | Replaces  | Where it appears                          |
|------------------------|-----------|-------------------------------------------|
| `caret-down.svg`       | `▾`       | Project picker / dropdowns                 |
| `close.svg`            | `✕` / `×` | Close buttons (notices, dialogs, chat)     |
| `warning.svg`          | `⚠`       | "parse issues" hint on scenes              |
| `dot.svg`              | `●`       | Unsaved-change indicator                   |
| `chevron-left.svg`     | `⟨`       | Hide outline                               |
| `chevron-right.svg`    | `⟩`       | Show outline                               |
| `search.svg`           | (new)     | Find / search toggle                       |
| `palette.svg`          | (new)     | Paper-tone switcher                        |
| `ghostwriter.svg`      | codicon `writing` | Sidebar nav brand mark          |

Optional but nice to have for future buttons: `save.svg`, `export.svg`,
`plus.svg`, `chat.svg`.

> A multi-colour brand logo is fine as a `.png` (or a coloured `.svg`) — that one
> will be embedded as an `<img data: URL>` instead of a themed `currentColor` svg.

## Notes

- No build step, no new dependencies: Hermes inlines the SVG directly into the
  single-file `plugin.js`, exactly like the self-hosted fonts are inlined.
- You do **not** edit `plugin.js` by hand for icons — just drop files here and
  say the word.
