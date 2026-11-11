# Fountain for screenplays — what to type, and how it will look

Ghostwriter follows the Fountain spec (fountain.io). Write in this plain style;
no indentation is needed — layout is applied when the page is rendered.

## Elements

```
INT. DINER - NIGHT
```
**Scene heading** — starts with `INT.`, `EXT.`, `EST.`, `INT./EXT.` or `I/E`.
Format: `INT. LOCATION - TIME`. Force any other line with a leading period:
`.FLASHBACK - 1999`. Optional scene number at the end: `INT. DINER - NIGHT #12#`.

```
Rain streaks the window. MAYA (30s, tired eyes) counts tips into a jar.
```
**Action** — present tense, what we see and hear. Introduce a character in
CAPS the first time they appear, with a short description. Keep paragraphs to
about four lines; start a new paragraph for each new beat or shot.

```
MAYA
(not looking up)
We're closed.
```
**Character cue + dialogue** — the cue is the name in CAPS on its own line,
with a **blank line before it** and the dialogue on the very next line.
A **parenthetical** goes on its own line between cue and dialogue (or between
lines of dialogue) — brief delivery notes only, not action.

Cue extensions: `MAYA (V.O.)` voice-over, `MAYA (O.S.)` off-screen,
`MAYA (CONT'D)` same speaker continuing after action. A name with lower-case
letters needs `@`: `@McCLANE`.

```
BRICK
Screw retirement.

STEEL ^
Screw retirement.
```
**Dual dialogue** — add `^` after the second cue; both speeches print side by side.

```
CUT TO:
```
**Transition** — in CAPS, ending in `TO:`, alone with blank lines around it.
`FADE IN:`, `FADE OUT.`, `FADE TO BLACK.` are recognized too. Force anything
else with `>`: `>SMASH CUT TO BLACK`. Use transitions sparingly.

Other markup:

| Type this | Meaning |
|---|---|
| `>THE END<` | centered text |
| `~Happy birthday to you` | lyrics (printed italic) |
| `!LOUD NOISES` | force a line to stay action (e.g. an all-caps action line followed by more text) |
| `*italic*`, `**bold**`, `***bold italic***`, `_underline_` | emphasis |
| `===` | page break |
| `# ACT ONE` / `= synopsis` | outline section / synopsis (not printed) |
| `[[note]]` | writer's note (not printed) |
| `/* ... */` | boneyard: cut text kept in the file (not printed) |

## Title page

The title page is the `Key: value` block at the very top, ended by a blank line.
Indent continuation lines for multi-line values:

```
Title: THE LAST LIGHT
Credit: Written by
Author: Jane Doe
Draft date: November 2026
Contact:
    jane@example.com
    +1 555 0100
```

Prefer `ghost_set_title_page` over editing these lines by hand.

## Pitfalls

- An ALL-CAPS line directly followed by a non-blank line is read as a
  character cue. For a shouted action line, either leave a blank line after it
  or start it with `!`.
- A cue needs a blank line before it. `MAYA` glued to the previous action line
  is treated as part of that action.
- Don't put the scene heading inside `content` *and* in `heading` — one is
  enough (Ghostwriter removes an exact duplicate).
- Don't add `(MORE)` / `(CONT'D)` for page breaks; the renderer adds them.
- Don't hand-indent; the layout is computed.
