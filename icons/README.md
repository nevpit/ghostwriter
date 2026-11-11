# Ghostwriter brand assets

- `ghostwriter-logo.jpg` — the original logo artwork (white line art on a light background).
- `ghostwriter.svg` — a vector trace of it using `currentColor`, so it follows the theme.

`desktop/plugin.js` draws the same mark inline (the `GhostLogo` component) for the
top bar, the welcome screen, the assistant's avatar and the sidebar entry. Small sizes use
heavier strokes and a single nib line so it stays legible at 16–24 px. If you update the
artwork, update `ghostwriter.svg` and the paths in `GhostLogo` together.

Brand accent: electric blue `#0759B7` (`--gw-accent`). On dark themes, accent-coloured text
and icons use a lighter tint (`--gw-accent-text`) for contrast; buttons keep `#0759B7`.
