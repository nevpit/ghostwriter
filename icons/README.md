# Ghostwriter brand assets

- `ghostwriter-logo-dark.png` — white line art on a transparent background, for **dark** themes.
- `ghostwriter-logo-light.png` — black line art on a transparent background, for **light** themes.

`desktop/plugin.js` embeds both (the `LOGO_IMG` table, used by the `Logo` component):
a 256 px cut for large placements (welcome screen) and a 64 px cut with slightly heavier
strokes for 16–28 px placements (top bar, buttons, avatars), where the original line weight
would fall below a pixel. With `tone: 'auto'` the pane shows the variant that matches the
detected Hermes theme; on blue surfaces (avatars, the Assistant button) the white variant is
always used. To change the artwork, replace these two files and regenerate `LOGO_IMG`
(crop to the artwork, pad to a square, resize to 256 and 64 px).

Brand accent: electric blue `#3847FF` (`--gw-accent`). On dark themes, accent-coloured text
and icons use a lighter tint (`--gw-accent-text`) for contrast; buttons keep `#3847FF`.
