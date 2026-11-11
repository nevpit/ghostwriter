import { useQuery, useQueryClient, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, KEYBINDS_AREA, host } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useMemo, useEffect, useRef, createContext, useContext } from 'react'

const ID = 'ghostwriter'
const API = `/api/plugins/${ID}`

// The desktop API bridge is the sanctioned door to this plugin's backend. It
// injects the native gateway ticket automatically, JSON-serializes `body`,
// and resolves to the unwrapped JSON body (JSON-only: binary PDFs are
// fetched separately via the bridge's readFileDataUrl for embedded viewing).
async function api(path, opts = {}) {
  const req = { path: `${API}${path}`, method: opts.method || 'GET' }
  if (opts.body !== undefined) req.body = opts.body
  return window.hermesDesktop.api(req)
}

// Extract a structured error code/message from a bridge rejection.
function errInfo(e) {
  const raw = e instanceof Error ? e.message : String(e == null ? '' : e)
  const m = raw.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      const d = JSON.parse(m[0])
      const det = d.detail && typeof d.detail === 'object' ? d.detail : d
      if (det && det.code) return { code: det.code, text: det.message || raw, raw }
    } catch (_) { /* not JSON */ }
  }
  return { code: '', text: raw, raw }
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString()
}

// Decode a base64 (data-URL payload) string to a UTF-8 text string, for the
// import preview. Throws on invalid base64 (callers catch it).
function b64ToText(b64) {
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

const TABS = [
  ['script', 'Script'],
  ['proposals', 'Proposals'],
  ['rules', 'Rules'],
  ['history', 'History'],
  ['export', 'Export'],
]

// ---------- view preferences (theme, font, size) ----------
// The manuscript is rendered in a theme + typeface the reader chooses, and the
// choice persists in localStorage so it survives restarts. "default" font
// follows the format's own convention (Courier for a screenplay); an explicit
// pick overrides it. Everything here is plain CSS + vanilla JS — no dependencies.
const VIEW_KEY = 'gw.view.v1'
const FONTS = {
  ui: 'inherit', // chrome inherits the host theme's default font (no hardcoded face)
  script: '"Courier Prime", "Courier New", Courier, monospace',
}
// Paper tones for the manuscript page (display preference; default pale blue).
const PAPER = {
  blue:  { label: 'Pale blue', bg: '#DCEBF0' },  // brand --pale-blue
  cream: { label: 'Cream',     bg: '#F1EBDD' },  // brand --paper-cream
  pink:  { label: 'Light pink', bg: '#F6DEE8' }, // light pink
  white: { label: 'White',     bg: '#FFFFFF' },  // brand --white
}
const PAPER_ORDER = ['blue', 'cream', 'pink', 'white']
// ---- standard Fountain title page ----
// A Fountain title page is the block of "Key: Value" metadata lines at the very
// top of the document (before the first scene heading). Renderers show it as a
// standalone FIRST page: the title in the upper third, the credit/author in the
// middle, and the contact (address / email / phone) in the bottom-left corner.
const TITLE_FIELDS = ['Title', 'Author', 'Source', 'Draft date', 'Address', 'Email', 'Phone', 'Contact']
// Centered block: the title (upper third) and the credit/author lines (middle).
const CENTER_FIELDS = ['Title', 'Author', 'Source', 'Draft date']
// Contact block: rendered in the bottom-left corner of the title page.
const CONTACT_FIELDS = ['Address', 'Email', 'Phone', 'Contact']
// Parse the leading title-page metadata. Returns { fields, order, bodyStart }:
// `fields` maps each metadata key to its value, `order` lists the keys in their
// original order, and `bodyStart` is the char offset of the first non-metadata
// line (the body, incl. any "FADE IN:" transition).
function parseTitlePage(fountain) {
  const src = String(fountain == null ? '' : fountain)
  const lines = src.split(/\r?\n/)
  const metaRe = /^[A-Za-z][A-Za-z ]*?:\s*\S/
  let k = 0
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (ln.trim() === '') { k = i + 1; continue }   // blank within the region
    if (metaRe.test(ln)) { k = i + 1; continue }     // "Key: value" line
    break                                            // first body line
  }
  const fields = {}
  const order = []
  let off = 0
  let metaEnd = 0  // offset right after the last "Key: Value" line (incl. its \n)
  for (let i = 0; i < k; i++) {
    const m = lines[i].match(/^([A-Za-z][A-Za-z ]*?):\s*(.*)$/)
    if (m && m[1].trim()) {
      const key = m[1].trim()
      if (!(key in fields)) order.push(key)
      fields[key] = m[2].trim()
    }
    off += lines[i].length + 1  // +1 = newline
    if (m && m[1].trim()) metaEnd = off
  }
  return { fields, order, metaEnd, bodyStart: off }
}
// Build a standard Fountain title-page block (metadata lines, single-newline
// separated). The standard fields come first (in the standard order); any extra
// fields follow in their original order, so no metadata is ever dropped.
// `title` is { fields, order }. Returns '' when nothing is filled in.
function buildTitleBlock(title) {
  const fields = (title && title.fields) ? title.fields : (title || {})
  const order = (title && title.order) ? title.order : Object.keys(fields)
  const out = []
  const seen = new Set()
  for (const key of TITLE_FIELDS) {
    const v = fields[key]
    if (v != null && String(v).trim()) { out.push(key + ': ' + String(v).trim()); seen.add(key) }
  }
  for (const key of order) {
    if (seen.has(key)) continue
    const v = fields[key]
    if (v != null && String(v).trim()) out.push(key + ': ' + String(v).trim())
  }
  return out.join('\n')
}
const FONT_LABELS = { default: 'Auto', serif: 'Serif', sans: 'Sans', mono: 'Mono' }
const SIZES = { s: '11.5px', m: '13px', l: '15px', xl: '17px' }
const SIZE_LABELS = { s: 'S', m: 'M', l: 'L', xl: 'XL' }
const DEFAULT_VIEW = { theme: 'dark', font: 'default', size: 13, paper: 'blue' }
function loadView() {
  let v = { ...DEFAULT_VIEW }
  try {
    const r = localStorage.getItem(VIEW_KEY)
    if (r) v = { ...DEFAULT_VIEW, ...JSON.parse(r) }
  } catch (_) { /* corrupt store: fall back to defaults */ }
  // Migrate the old letter size (s/m/l/xl) to a numeric px value for the slider.
  if (typeof v.size === 'string' && SIZES[v.size]) v.size = parseFloat(SIZES[v.size])
  if (!Number.isFinite(Number(v.size))) v.size = 13
  v.size = Math.round(Number(v.size) * 2) / 2
  return v
}
function saveView(v) { try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)) } catch (_) {} }
function useGwView() {
  const [view, setView] = useState(loadView)
  const update = (patch) => setView(v => { const n = { ...v, ...patch }; saveView(n); return n })
  return [view, update]
}
// The manuscript is always Courier Prime (the standard screenplay face); the chrome inherits the host theme's default font.
function effectiveFont(view) { return FONTS.script }

// ---------- formatted reading view (Fountain conventions) ----------

function El({ e, sceneId, elIndex }) {
  const search = useContext(SearchCtx)
  const t = e.text == null ? '' : String(e.text)
  const sceneHits = (search && sceneId != null && elIndex != null) ? search.matchesByScene[sceneId] : null
  const hits = sceneHits ? sceneHits[elIndex] : null
  const cm = search ? search.currentMatch : -1
  // Highlight a single-line block. `text` is the rendered (possibly uppercased)
  // text; the hit offsets were computed on the raw text (same length, so they
  // still line up).
  const hl = (text) => (hits && text) ? renderHighlighted(text, hits, cm) : text
  // Highlight a multi-line block (dialogue): map each hit onto its line.
  const hlLines = (text) => {
    const lines = String(text).split('\n')
    if (!hits || !hits.length) return lines.map((line, i) => jsx('div', { key: i, children: line }))
    let lineStart = 0
    return lines.map((line, i) => {
      const lineEnd = lineStart + line.length
      const lineHits = hits
        .filter((h) => h.start >= lineStart && h.end <= lineEnd)
        .map((h) => ({ start: h.start - lineStart, end: h.end - lineStart, globalIndex: h.globalIndex }))
      lineStart = lineEnd + 1
      return jsx('div', { key: i, children: lineHits.length ? renderHighlighted(line, lineHits, cm) : line })
    })
  }
  switch (e.kind) {
    case 'scene_heading':
      return jsx('div', { className: 'f-scene', children: hl(t.toUpperCase()) })
    case 'character':
      return jsx('div', { className: 'f-char', children: hl(t.toUpperCase()) })
    case 'parenthetical':
      return jsx('div', { className: 'f-paren', children: hl(t) })
    case 'dialogue':
      return jsx('div', { className: 'f-dialogue', children: hlLines(t) })
    case 'transition':
      return jsx('div', { className: 'f-trans', children: hl(t.toUpperCase()) })
    default:
      return jsx('div', { className: 'f-action', children: hl(t) })
  }
}

function SceneView({ scene }) {
  const allEls = Array.isArray(scene.elements) && scene.elements.length ? scene.elements : null
  // Skip the leading scene_heading element — it's already the title above.
  const bodyEls = allEls ? allEls.filter((e) => e.kind !== 'scene_heading') : null
  return jsxs('div', { className: 'hsp-scene', children: [
    jsx('div', { className: 'hsp-scene-title', children:
      (scene.heading || '(untitled scene)') + (scene.parse_ok === false ? '  ⚠ parse issues' : '') }),
    (bodyEls && bodyEls.length)
      ? bodyEls.map((e, i) => jsx(El, { e, key: i }))
      : (allEls ? null : jsx('pre', { className: 'hsp-raw', children: scene.text || '' }))
  ] })
}

// ---- title page (standard screenplay format, its own first page) ----
// Layout matches the industry-standard title page: the title in the upper third,
// the credit/author (and optional source / draft date) in the middle, and the
// contact block (address / email / phone) in the bottom-left corner. The block
// is a full page tall so it reads as a standalone first page.
function TitlePageView({ fields, order }) {
  if (!fields) return null
  const allKeys = (order && order.length) ? order : Object.keys(fields)
  const title = fields.Title
  const creditKeys = CENTER_FIELDS.slice(1).filter((k) => fields[k])   // Author, Source, Draft date
  const contactKeys = CONTACT_FIELDS.filter((k) => fields[k])
  const extraKeys = allKeys.filter((k) => TITLE_FIELDS.indexOf(k) === -1 && fields[k])
  if (!title && !creditKeys.length && !contactKeys.length && !extraKeys.length) return null
  return jsxs('div', { className: 'hsp-titlepage', children: [
    jsx('div', { className: 'hsp-titlepage-spacer' }),
    title ? jsx('div', { className: 'hsp-titlepage-title', children: title }) : null,
    creditKeys.length ? jsx('div', { className: 'hsp-titlepage-credit', children:
      creditKeys.map((k) => jsx('div', { className: 'hsp-titlepage-line', key: k,
        children: (k === 'Author' ? 'Written by ' + fields[k] : fields[k]) })) }) : null,
    jsx('div', { className: 'hsp-titlepage-grow' }),
    (contactKeys.length || extraKeys.length) ? jsx('div', { className: 'hsp-titlepage-contact', children: [
      ...contactKeys.map((k) => jsx('div', { className: 'hsp-titlepage-contact-line', key: k, children: fields[k] })),
      ...extraKeys.map((k) => jsx('div', { className: 'hsp-titlepage-contact-line', key: k, children: k + ': ' + fields[k] })),
    ] }) : null,
  ] })
}

// One editable element in the formatted editor: an auto-sizing textarea styled
// exactly like the read view's element (same .f-* class), so the standard
// screenplay formatting stays visible while editing.
function EditElement({ kind, value, onChange }) {
  const cls = {
    scene_heading: 'f-scene', character: 'f-char', parenthetical: 'f-paren',
    dialogue: 'f-dialogue', transition: 'f-trans'
  }[kind] || 'f-action'
  const text = value == null ? '' : String(value)
  return jsx('textarea', {
    className: 'hsp-edit-el ' + cls,
    value: text,
    rows: Math.max(1, text.split('\n').length),
    spellCheck: false,
    onChange: (e) => onChange(e.target.value),
    onPaste: (e) => {
      // keep edits plain-text (Fountain is source, not rich text)
      e.preventDefault()
      const plain = (e.clipboardData || window.clipboardData).getData('text/plain')
      if (plain != null) onChange(text.slice(0, e.target.selectionStart) + plain + text.slice(e.target.selectionEnd))
    },
  })
}
// The editable title-page fields (in the formatted editor). Each standard
// Fountain metadata field is a labeled input; the contact block (address /
// email / phone) is grouped separately since it sits bottom-left on the page.
function TitlePageEditor({ fields, order, onChange }) {
  const input = (key, ph, cls) => jsx('input', {
    className: 'hsp-titlepage-input' + (cls ? ' ' + cls : ''),
    type: 'text',
    value: (fields && fields[key]) || '',
    placeholder: ph,
    spellCheck: false,
    onChange: (e) => onChange(key, e.target.value),
  })
  const extra = (order || []).filter((k) => TITLE_FIELDS.indexOf(k) === -1 && fields && fields[k])
  return jsxs('div', { className: 'hsp-titlepage hsp-titlepage-edit', children: [
    input('Title', 'Title', 'hsp-titlepage-input-title'),
    input('Author', 'Author  (shown as "Written by …" on the title page)'),
    input('Source', 'Source  (e.g. Based on a novel by …)'),
    input('Draft date', 'Draft date'),
    jsx('div', { className: 'hsp-titlepage-contact-edit', children: [
      jsx('div', { className: 'hsp-titlepage-contact-label', children: 'Contact · bottom-left of the title page' }),
      input('Address', 'Address'),
      input('Email', 'Email'),
      input('Phone', 'Phone'),
      input('Contact', 'Contact  (any other contact line)'),
    ] }),
    ...extra.map((k) => jsxs('div', { className: 'hsp-titlepage-extra', key: k, children: [
      jsx('span', { className: 'hsp-titlepage-extra-key', children: k + ':' }),
      input(k, ''),
    ] })),
  ] })
}

// ---------- search / find & replace ----------
// Search hits are computed client-side over the *visible* text (each scene's
// slugline + body-element text), so a hit maps 1:1 onto a rendered node — no
// snapshot-offset bookkeeping. The replace operates on the raw Fountain source
// (via the snapshot endpoint); for a word search the Nth visible hit == the Nth
// source occurrence, so "replace current" is unambiguous.
const SearchCtx = createContext(null)

function findMatchesInText(text, query) {
  const hits = []
  const q = String(query || '').toLowerCase()
  if (!q) return hits
  const lower = String(text == null ? '' : text).toLowerCase()
  let idx = 0
  for (;;) {
    const i = lower.indexOf(q, idx)
    if (i === -1) break
    hits.push({ start: i, end: i + q.length })
    idx = i + q.length
  }
  return hits
}

// Render `text` with each hit wrapped in <mark class="hsp-mark">. Hits carry
// {start, end, globalIndex}; the current hit gets .hsp-mark-current.
function renderHighlighted(text, hits, currentMatch) {
  if (!hits || !hits.length) return text
  const out = []
  let pos = 0
  hits.forEach((h, i) => {
    if (h.start > pos) out.push(text.slice(pos, h.start))
    out.push(jsx('mark', {
      className: 'hsp-mark' + (h.globalIndex === currentMatch ? ' hsp-mark-current' : ''),
      key: 'm' + i,
      'data-match': h.globalIndex,
      children: text.slice(h.start, h.end),
    }))
    pos = h.end
  })
  if (pos < text.length) out.push(text.slice(pos))
  return out
}

// Case-insensitive replace in `text`. `occurrence` is 'all' or a 0-based index
// (replace only the Nth occurrence). Returns {text, count, replaced}.
function replaceInText(text, query, replacement, occurrence) {
  const q = String(query || '').toLowerCase()
  if (!q) return { text, count: 0, replaced: 0 }
  const lower = String(text).toLowerCase()
  let result = ''
  let i = 0, count = 0, replaced = 0
  for (;;) {
    const idx = lower.indexOf(q, i)
    if (idx === -1) break
    count++
    if (occurrence === 'all' || count - 1 === occurrence) {
      result += text.slice(i, idx) + replacement
      replaced++
    } else {
      result += text.slice(i, idx + q.length)
    }
    i = idx + q.length
  }
  result += text.slice(i)
  return { text: result, count, replaced }
}

// One scene in the full-script scroll view: a labelled section whose
// elements render with the same Fountain styling, carrying data-scene-id so
// the scroll-spy can tell which scene is under the top edge.
function FullScene({ scene, index }) {
  const search = useContext(SearchCtx)
  const allEls = Array.isArray(scene.elements) && scene.elements.length ? scene.elements : null
  // The heading is already shown in the labelled section header above; skip the
  // leading scene_heading element so it doesn't render a second time.
  const bodyEls = allEls ? allEls.filter((e) => e.kind !== 'scene_heading') : null
  // Heading highlight: the slugline renders uppercased; hits were computed on
  // the raw heading (same offsets, so they line up).
  let headingContent = scene.heading || '(untitled scene)'
  if (search && scene.heading) {
    const sceneHits = search.matchesByScene[scene.id]
    const hits = sceneHits ? sceneHits.heading : null
    if (hits) headingContent = renderHighlighted(scene.heading.toUpperCase(), hits, search.currentMatch)
  }
  return jsxs('div', { className: 'hsp-full-scene', 'data-scene-id': scene.id, children: [
    jsxs('div', { className: 'hsp-full-heading', children: [
      jsx('span', { className: 'hsp-full-idx', children: String(index + 1) }),
      jsx('span', { className: 'hsp-full-title', children: headingContent }),
      scene.parse_ok === false ? jsx('span', { className: 'hsp-hint', children: '  ⚠ parse issues' }) : null
    ] }),
    (bodyEls && bodyEls.length)
      ? bodyEls.map((e, i) => jsx(El, { e, sceneId: scene.id, elIndex: i, key: i }))
      : (allEls ? null : jsx('pre', { className: 'hsp-raw', children: scene.text || '' }))
  ] })
}

// ---------- format view packs ----------
// How the pane renders a format's blocks in the reading view and labels them in
// the navigator. Each pack provides:
//   Block({scene, index}) -> component for the full-manuscript scroll view; it
//     must carry data-scene-id so the scroll-spy and the Edit prefill work.
//   navText(scene)        -> the spans for one navigator row.
// The MVP ships the screenplay pack only. New formats add a pack here keyed by
// their engine `name`.

const VIEW_PACKS = {
  screenplay: {
    Block: FullScene,
    navText: (s) => [
      jsx('span', { className: 'hsp-nav-idx', children: String((s.order || 0) + 1) }),
      jsx('span', { children: s.heading || '(untitled)' }),
    ],
  },
}

// ---------- status chip ----------

function Chip({ kind, children }) {
  return jsx('span', { className: `hsp-chip hsp-chip-${kind}`, children })
}

function statusKind(s) {
  switch (String(s || '').toUpperCase()) {
    case 'PENDING': return 'pending'
    case 'BLOCKED': return 'blocked'
    case 'ACCEPTED': return 'accepted'
    case 'REJECTED': return 'rejected'
    case 'STALE': return 'stale'
    case 'ADDED': case 'PASS': return 'good'
    case 'MODIFIED': case 'UNAVAILABLE': return 'warn'
    case 'REMOVED': case 'FAIL': return 'bad'
    default: return 'muted'
  }
}

// ---------- project picker (custom dropdown: full control over contrast) ----------
//
// A native <select> renders its open list as an OS menu on Windows, which
// ignores our CSS and comes up light-on-light against a dark theme. This
// dropdown is plain DOM, so its colors are fully themeable and always
// high-contrast. It keeps the same "switching projects" unsaved-change guard.

function ProjectPicker({ projects, value, onChange, onNew, onImport, importAccept }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const fileRef = useRef(null)
  const label = projects.find(p => p.id === value)
  useEffect(() => {
    if (!open) return
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  return jsxs('div', { className: 'hsp-dd', ref, children: [
    jsx('button', {
      className: 'hsp-dd-toggle', type: 'button', onClick: () => setOpen(o => !o),
      children: jsxs('span', { children: [
        jsx('span', { className: 'hsp-dd-label', children: (label && (label.title || label.id)) || 'Select project' }),
        jsx('span', { className: 'hsp-dd-caret', children: '▾' })
      ] })
    }),
    open && jsxs('div', { className: 'hsp-dd-list', role: 'listbox', children: [
      projects.map(p => jsx('button', {
        className: `hsp-dd-item${p.id === value ? ' hsp-dd-item-active' : ''}`,
        role: 'option', 'aria-selected': p.id === value, key: p.id,
        onClick: () => { onChange(p.id); setOpen(false) },
        children: (p.title || p.id)
      })),
      (onNew || onImport) && jsx('div', { className: 'hsp-dd-sep', key: 'sep' }),
      onNew && jsx('button', {
        className: 'hsp-dd-item hsp-dd-item-act', role: 'option', key: 'new',
        onClick: () => { setOpen(false); onNew() }, children: '＋  New project…'
      }),
      onImport && jsxs('span', {
        className: 'hsp-dd-item hsp-dd-item-act', role: 'option', key: 'import',
        onClick: () => { if (fileRef.current) fileRef.current.click() }, children: [
          '⤓  Import…',
          jsx('input', { ref: fileRef, type: 'file', accept: importAccept || '', style: { display: 'none' }, onChange: onImport })
        ] })
    ] })
  ] })
}

// ---------- main pane ----------

function ScreenplayPane() {
  const qc = useQueryClient()
  const [pid, setPid] = useState(null)
  const [tab, setTab] = useState('script')
  const [sceneId, setSceneId] = useState(null)
  const [draft, setDraft] = useState(null)      // { sceneId, text }
  const [editing, setEditing] = useState(false)
  const [propSel, setPropSel] = useState(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null)     // { kind, text, action? }
  const [noticeLeaving, setNoticeLeaving] = useState(false) // fading out
  const [guard, setGuard] = useState(null)       // { label, next }
  const [rulesForm, setRulesForm] = useState(null)
  const [pdf, setPdf] = useState(null)           // { loading, meta, dataUrl, error }
  const [confirmId, setConfirmId] = useState(null) // history row awaiting confirm
  const [importPanel, setImportPanel] = useState(null) // { name, title, author, text }
  const [newProject, setNewProject] = useState(null) // { title, author, format, text }
  const [view, updateView] = useGwView()               // { theme, font, size } — persisted
  // Search / find & replace. `searchQuery` is '' when the bar is closed;
  // `currentMatch` is the global index of the highlighted hit (-1 = none).
  const [searchQuery, setSearchQuery] = useState('')
  const [replaceQuery, setReplaceQuery] = useState('')
  const [currentMatch, setCurrentMatch] = useState(-1)
  const [chatOpen, setChatOpen] = useState(false)  // side-by-side chat rail (feature #3)
  const [chatWidth, setChatWidth] = useState(loadChatWidth) // resizable chat column width
  const [resizing, setResizing] = useState(false)   // drag-to-resize in progress
  // Layout interaction state (UI revamp):
  const [outlineOpen, setOutlineOpen] = useState(true)    // collapsible scene outline
  const [searchOpen, setSearchOpen] = useState(false)     // find/replace bar (Ctrl/Cmd+F)
  const [focusMode, setFocusMode] = useState(false)       // focus mode (hide chrome)
  const searchRef = useRef(null)
  // Ctrl/Cmd+F summons the find bar; Escape on the input closes it.
  useEffect(() => {
    function onFindKey(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); setSearchOpen(true) }
    }
    document.addEventListener('keydown', onFindKey)
    return () => document.removeEventListener('keydown', onFindKey)
  }, [])
  useEffect(() => { if (searchOpen && searchRef.current) searchRef.current.focus() }, [searchOpen])

  // Full-script scroll view: keep the scene list in sync with the scroll
  // position (scroll-spy) and let list clicks jump the scroll position.
  const fullRef = useRef(null)       // full-script scroll container
  const navRef = useRef(null)        // scene list container
  const suppressSpy = useRef(false)  // ignore scroll-spy during programmatic scroll
  const spyRaf = useRef(0)           // requestAnimationFrame throttle handle
  const goToTimer = useRef(0)        // timeout that clears suppressSpy
  const sceneIdRef = useRef(sceneId) // latest sceneId, readable inside the scroll handler
  const splitRef = useRef(null)      // the split container (resize math)
  useEffect(() => { sceneIdRef.current = sceneId }, [sceneId])

  const statusQ = useQuery({
    queryKey: [ID, 'status'], queryFn: () => api('/status'),
    staleTime: 15000, refetchInterval: 30000, retry: 1
  })
  const projectsQ = useQuery({
    queryKey: [ID, 'projects'], queryFn: () => api('/projects'),
    staleTime: 10000, refetchInterval: 15000, retry: 1
  })
  const projectQ = useQuery({
    queryKey: [ID, 'project', pid],
    queryFn: async () => (pid ? api(`/projects/${pid}`) : null),
    enabled: !!pid,
    staleTime: 10000, refetchInterval: 20000, retry: 1
  })
  const proposalsQ = useQuery({
    queryKey: [ID, 'proposals', pid],
    queryFn: async () => (pid ? api(`/projects/${pid}/proposals`) : null),
    enabled: !!pid && tab === 'proposals',
    staleTime: 10000, refetchInterval: 10000, retry: 1
  })
  const proposalQ = useQuery({
    queryKey: [ID, 'proposal', propSel],
    queryFn: async () => (propSel ? api(`/proposals/${propSel}`) : null),
    enabled: !!propSel,
    staleTime: 10000, retry: 1
  })
  const historyQ = useQuery({
    queryKey: [ID, 'history', pid],
    queryFn: async () => (pid ? api(`/projects/${pid}/history`) : null),
    enabled: !!pid && tab === 'history',
    staleTime: 10000, refetchInterval: 20000, retry: 1
  })

  const projects = Array.isArray(projectsQ.data) ? projectsQ.data : []
  const data = projectQ.data
  const scenes = (data && Array.isArray(data.active_revision?.scenes)) ? data.active_revision.scenes : []
  // Title-page metadata (lines before the first scene), parsed client-side from
  // the raw snapshot so the manuscript can render a standard title page.
  const titlePage = (data && data.active_revision && data.active_revision.snapshot)
    ? parseTitlePage(data.active_revision.snapshot)
    : { fields: {}, order: [] }
  // Whole-document word count, shown in the status bar at the bottom of the paper.
  const wordCount = useMemo(() => {
    let n = 0
    for (const s of scenes) n += String(s.text || '').split(/\s+/).filter(Boolean).length
    return n
  }, [scenes])
  const sceneById = useMemo(
    () => Object.fromEntries(scenes.map(s => [s.id, s])),
    [scenes])
  const activeRevId = data ? data.active_revision_id : null
  // Track the freshest active revision id for find & replace. It mirrors the
  // query value but is also bumped from each successful snapshot write, so a
  // quick follow-up replace never sends a stale base (STALE_REVISION) while the
  // project query is still refetching.
  const activeRevIdRef = useRef(activeRevId)
  useEffect(() => { activeRevIdRef.current = activeRevId }, [activeRevId])
  const projectFormat = (data && data.project && data.project.format) || 'screenplay'
  const pack = VIEW_PACKS[projectFormat] || VIEW_PACKS.screenplay

  // ---- search / find & replace (feature #2) ----
  // Search hits, computed over the *visible* text (each scene's slugline + body
  // elements), in document order. Each hit carries a global index (0..N-1) that
  // drives the next/prev highlight and "replace current".
  const matches = useMemo(() => {
    if (!searchQuery) return []
    const all = []
    let gi = 0
    for (const scene of scenes) {
      const heading = scene.heading || ''
      if (heading) {
        for (const h of findMatchesInText(heading, searchQuery)) {
          all.push({ scene_id: scene.id, el: 'heading', start: h.start, end: h.end, globalIndex: gi++ })
        }
      }
      const bodyEls = (scene.elements || []).filter((e) => e.kind !== 'scene_heading')
      bodyEls.forEach((e, i) => {
        const t = e.text == null ? '' : String(e.text)
        if (!t) return
        for (const h of findMatchesInText(t, searchQuery)) {
          all.push({ scene_id: scene.id, el: i, start: h.start, end: h.end, globalIndex: gi++ })
        }
      })
    }
    return all
  }, [searchQuery, scenes])

  // Group hits by scene so the renderers can look up their own hits (the
  // slugline is keyed under the string 'heading', body elements under their index).
  const matchesByScene = useMemo(() => {
    const map = {}
    for (const m of matches) {
      if (!map[m.scene_id]) map[m.scene_id] = {}
      if (!map[m.scene_id][m.el]) map[m.scene_id][m.el] = []
      map[m.scene_id][m.el].push(m)
    }
    return map
  }, [matches])

  const searchState = useMemo(
    () => (searchQuery ? { query: searchQuery, matchesByScene, currentMatch } : null),
    [searchQuery, matchesByScene, currentMatch]
  )

  // Move the highlighted hit by one step (wrapping around).
  const stepMatch = (delta) => {
    if (!matches.length) return
    const base = currentMatch < 0 ? 0 : currentMatch
    setCurrentMatch(((base + delta) % matches.length + matches.length) % matches.length)
  }

  // Find & replace: edit the raw Fountain source. For a word search the Nth
  // visible hit == the Nth source occurrence, so this is unambiguous. The title
  // page (metadata before the first scene) is left untouched so the hit count
  // matches what's visible.
  const doReplace = async (occurrence) => {
    if (!pid || !searchQuery || busy) return
    // The "Replace" button passes the 'current' sentinel for the highlighted
    // hit; resolve it to that hit's global index. replaceInText only understands
    // 'all' or a numeric index, so passing 'current' through verbatim matched
    // nothing and always reported "No replacement made."
    const target = occurrence === 'current' ? currentMatch : occurrence
    if (target !== 'all' && (!Number.isInteger(target) || target < 0)) {
      setNotice({ kind: 'err', text: 'Nothing highlighted to replace.' })
      return
    }
    setBusy(true)
    // Delegate to the backend's structure-aware replace. It matches at the
    // element level in the same document order as the highlights and
    // uppercases a matching character-cue name, so the all-caps cue (and the
    // rest of the Fountain formatting) is preserved. The old blind client-side
    // string replace lowercased character cues and collapsed dialogue into action.
    const call = (revId) => api(`/projects/${encodeURIComponent(pid)}/replace`, {
      method: 'POST',
      body: { query: searchQuery, replacement: replaceQuery || '', target, revision_id: revId },
    })
    try {
      let res
      try {
        res = await call(activeRevIdRef.current)
      } catch (e) {
        // A stale base (e.g. the agent saved in the meantime) is recoverable:
        // resync to the current active revision and retry once.
        const p = await api(`/projects/${encodeURIComponent(pid)}`)
        activeRevIdRef.current = p && p.active_revision_id
        res = await call(activeRevIdRef.current)
      }
      if (res && res.revision_id) activeRevIdRef.current = res.revision_id
      setNotice({ kind: 'ok', text: `Replaced ${res.replaced} occurrence${res.replaced === 1 ? '' : 's'}.` })
      invalidateAll()
    } catch (e) {
      setNotice({ kind: 'err', text: `Replace failed: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  // Keep the current hit in view when it changes.
  useEffect(() => {
    if (currentMatch < 0) return
    const box = fullRef.current
    const el = box && box.querySelector(`mark[data-match="${currentMatch}"]`)
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [currentMatch])

  // Auto-select a project; drop selection if it disappeared.
  useEffect(() => {
    if (!projectsQ.data) return
    const list = Array.isArray(projectsQ.data) ? projectsQ.data : []
    if (!list.length) { if (pid !== null) setPid(null); return }
    if (!pid || !list.some(p => p.id === pid)) setPid(list[0].id)
  }, [projectsQ.data, pid])

  // Reset per-project UI state when the project changes.
  useEffect(() => {
    setSceneId(null); setDraft(null); setEditing(false)
    setPropSel(null); setPdf(null); setConfirmId(null)
  }, [pid])

  // Select the first scene by default.
  useEffect(() => {
    if (sceneId && sceneById[sceneId]) return
    if (scenes.length) setSceneId(scenes[0].id)
  }, [scenes, sceneId, sceneById])

  // Keep the scene list scrolled so the active row stays visible as the
  // scroll-spy (or a click) changes the active scene.
  useEffect(() => {
    if (!sceneId) return
    const row = navRef.current && navRef.current.querySelector(`[data-nav-id="${sceneId}"]`)
    if (row) row.scrollIntoView({ block: 'nearest' })
  }, [sceneId])

  // Release the rAF throttle handle on unmount.
  useEffect(() => () => { if (spyRaf.current) cancelAnimationFrame(spyRaf.current) }, [])

  // (Re)seed the rules form when the active rules version changes.
  useEffect(() => {
    const r = data && data.rules
    if (!r) return
    setRulesForm({
      rulesId: r.id,
      dialogueBlockLimit: r.dialogue_block_limit == null ? '' : String(r.dialogue_block_limit),
      pageLimit: r.page_limit == null ? '' : String(r.page_limit),
      guidance: (r.guidance || []).join('\n'),
      protected: r.protected || [],
      addScene: scenes[0] ? scenes[0].id : '',
      addOffset: '0', addLength: '10', addLabel: ''
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data && data.rules && data.rules.id, pid])

  // Auto-dismiss transient notices (import success, saves, exports) after 5
  // seconds, fading them out as they leave. Notices that carry an action
  // button (e.g. a save-conflict "Reload latest") are kept until the user acts
  // or closes them; those fade out too when closed.
  useEffect(() => {
    if (!notice || notice.action) return
    setNoticeLeaving(false)
    const t = setTimeout(() => setNoticeLeaving(true), 5000)
    return () => clearTimeout(t)
  }, [notice])

  // After a notice is flagged as leaving, let the fade-out transition finish
  // before unmounting it.
  useEffect(() => {
    if (!notice || !noticeLeaving) return
    const t = setTimeout(() => { setNotice(null); setNoticeLeaving(false) }, 380)
    return () => clearTimeout(t)
  }, [notice, noticeLeaving])

  const dirty = !!(draft && draft.changed)

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: [ID] })
  }

  function requireSaved(next, label) {
    if (dirty) setGuard({ label, next })
    else next()
  }

  // ---- full-script scroll view: scroll-spy + jump-to-scene ----

  // Which scene is under the top edge of the reading view?
  function computeActiveScene() {
    const el = fullRef.current
    if (!el) return null
    const kids = el.querySelectorAll('[data-scene-id]')
    if (!kids.length) return null
    const probe = el.getBoundingClientRect().top + 60
    let active = kids[0].getAttribute('data-scene-id')
    for (const k of kids) {
      if (k.getBoundingClientRect().top <= probe) active = k.getAttribute('data-scene-id')
      else break // scenes are stacked in order
    }
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
      active = kids[kids.length - 1].getAttribute('data-scene-id')
    }
    return active
  }

  function onFullScroll() {
    if (spyRaf.current) return
    spyRaf.current = requestAnimationFrame(() => {
      spyRaf.current = 0
      if (suppressSpy.current) return
      const id = computeActiveScene()
      if (id && id !== sceneIdRef.current) setSceneId(id)
    })
  }

  // Jump the reading view to a scene (from a list click), without letting the
  // scroll-spy fight the programmatic scroll.
  function goToSceneNow(id) {
    setEditing(false)
    setSceneId(id)
    const el = fullRef.current
    if (el) {
      const target = el.querySelector(`[data-scene-id="${id}"]`)
      if (target) {
        suppressSpy.current = true
        const elTop = el.getBoundingClientRect().top
        const tTop = target.getBoundingClientRect().top
        el.scrollTo({ top: Math.max(0, el.scrollTop + (tTop - elTop) - 10), behavior: 'smooth' })
        window.clearTimeout(goToTimer.current)
        goToTimer.current = window.setTimeout(() => { suppressSpy.current = false }, 600)
      }
    }
  }

  // Edit the ENTIRE document: fetch the raw Fountain source and open a full
  // editor over it. Saving writes a new revision through the snapshot endpoint
  // (the same door find & replace uses), so the whole script updates at once —
  // not just the one scene on screen.
  async function startEdit() {
    if (!pid || editing) return
    setBusy(true)
    try {
      const r = await api(`/projects/${pid}/fountain`, { method: 'GET' })
      const txt = (r && r.fountain != null) ? String(r.fountain) : ''
      // Structured edit model: title-page fields + every element (with its
      // [start,end) snapshot offsets) grouped by scene. Saving splices each
      // element's text back into the snapshot at its original offset, so the
      // standard formatting is preserved and an unchanged edit round-trips
      // byte-for-byte.
      const { fields, order: titleOrder, metaEnd } = parseTitlePage(txt)
      const structure = []
      for (const s of scenes) {
        const els = (Array.isArray(s.elements) && s.elements.length ? s.elements : [])
          .map((e, j) => ({ key: s.id + ':' + j, start: e.start, end: e.end, kind: e.kind, text: e.text == null ? '' : String(e.text) }))
        structure.push({ id: s.id, order: s.order || 0, elements: els })
      }
      const values = {}
      for (const sc of structure) for (const e of sc.elements) values[e.key] = e.text
      setDraft({ base: txt, baseRev: activeRevIdRef.current, title: { fields: { ...fields }, order: titleOrder }, metaEnd, structure, values, changed: false })
      setEditing(true)
    } catch (e) {
      setNotice({ kind: 'err', text: `Could not load the script for editing: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  // Reconstruct the Fountain source from the structured edit model: the standard
  // title-page block is (re)written, and each element's text is spliced back into
  // the snapshot at its original [start,end) offset — preserving blank lines and
  // the standard formatting. An unchanged edit round-trips byte-for-byte.
  function buildDocFromDraft(d) {
    const base = d.base
    const titleBlock = buildTitleBlock(d.title)
    const metaEnd = d.metaEnd || 0
    const els = []
    for (const sc of d.structure) for (const e of sc.elements) els.push(e)
    if (!els.length) return titleBlock
    let body = ''
    let cursor = 0
    for (const e of els) {
      const v = d.values[e.key] != null ? String(d.values[e.key]) : e.text
      body += base.slice(cursor, e.start) + v
      cursor = e.end
    }
    body += base.slice(cursor)
    // Replace the metadata block [0, metaEnd) with the new title block; keep the
    // pre-first-scene gap (blank lines + any "FADE IN:" transition) byte-exact.
    const pre = base.slice(metaEnd, els[0].start)
    return (titleBlock ? titleBlock + '\n' : '') + pre + body.slice(els[0].start)
  }
  // Save the whole document as a new revision (snapshot = full Fountain source).
  // `draft.baseRev` pins the expected active revision for optimistic concurrency
  // — a stale base is rejected with STALE_REVISION.
  async function doSaveDoc() {
    if (!draft || !pid) return false
    setBusy(true); setNotice(null)
    try {
      await api(`/projects/${pid}/snapshot`, {
        method: 'POST',
        body: { content: buildDocFromDraft(draft), revision_id: draft.baseRev }
      })
      setDraft(null)
      setNotice({ kind: 'ok', text: 'Document saved as a new revision.' })
      invalidateAll()
      return true
    } catch (e) {
      const info = errInfo(e)
      if (info.code === 'STALE_REVISION') {
        setNotice({ kind: 'err', text:
          'Save conflict: the script changed while you were editing. Your text is kept — ' +
          'reload below to see the latest, then re-apply your edit.',
          action: () => { projectQ.refetch(); closeNotice() } })
      } else {
        setNotice({ kind: 'err', text: `Save failed: ${info.text}` })
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  async function doAccept(propId) {
    setBusy(true); setNotice(null)
    try {
      await api(`/proposals/${propId}/accept`, { method: 'POST', body: {} })
      setNotice({ kind: 'ok', text: 'Proposal accepted — a new revision is now active.' })
      setPropSel(null)
      invalidateAll()
    } catch (e) {
      const info = errInfo(e)
      if (info.code === 'ERR_STALE_REVISION' || info.code === 'STALE_REVISION') {
        setNotice({ kind: 'err', text: 'This proposal is stale (its base revision or rules changed). Reject it to clear it.' })
      } else {
        setNotice({ kind: 'err', text: `Accept failed: ${info.text}` })
      }
    } finally {
      setBusy(false)
    }
  }

  async function doReject(propId) {
    setBusy(true); setNotice(null)
    try {
      await api(`/proposals/${propId}/reject`, { method: 'POST', body: { reason: 'rejected in Desktop' } })
      setNotice({ kind: 'ok', text: 'Proposal rejected.' })
      setPropSel(null)
      invalidateAll()
    } catch (e) {
      setNotice({ kind: 'err', text: `Reject failed: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  async function doRestore(revId) {
    setBusy(true); setNotice(null)
    try {
      await api(`/projects/${pid}/restore`, { method: 'POST', body: { revision_id: revId } })
      setNotice({ kind: 'ok', text: `Restored ${String(revId).slice(0, 12)}… as a new active revision.` })
      setConfirmId(null)
      invalidateAll()
    } catch (e) {
      setNotice({ kind: 'err', text: `Restore failed: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  async function doUndo() {
    setBusy(true); setNotice(null)
    try {
      await api(`/projects/${pid}/undo`, { method: 'POST', body: {} })
      setNotice({ kind: 'ok', text: 'Last change undone (a new revision was created).' })
      invalidateAll()
    } catch (e) {
      setNotice({ kind: 'err', text: `Undo failed: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  async function doSaveRules() {
    if (!rulesForm) return
    setBusy(true); setNotice(null)
    try {
      const body = {
        dialogue_block_limit: rulesForm.dialogueBlockLimit === '' ? null : Number(rulesForm.dialogueBlockLimit),
        page_limit: rulesForm.pageLimit === '' ? null : Number(rulesForm.pageLimit),
        guidance: rulesForm.guidance.split('\n').map(s => s.trim()).filter(Boolean),
        protected: rulesForm.protected
      }
      const res = await api(`/projects/${pid}/rules`, { method: 'PUT', body })
      setNotice({ kind: 'ok', text: `Rules updated — new version ${String(res && res.id).slice(0, 12)}…` })
      invalidateAll()
    } catch (e) {
      setNotice({ kind: 'err', text: `Rules save failed: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  async function doExport() {
    if (!pid) return
    setPdf({ loading: true, meta: null, dataUrl: null, error: null })
    try {
      const meta = await api(`/projects/${pid}/pdf/meta`, { method: 'GET' })
      let dataUrl = null
      let readErr = null
      try {
        const r = await window.hermesDesktop.readFileDataUrl(meta.path)
        if (typeof r === 'string' && r.startsWith('data:')) dataUrl = r
        else if (r && r.ok === false) readErr = r.message
      } catch (e) {
        readErr = String(e)
      }
      setPdf({ loading: false, meta, dataUrl, error: readErr })
    } catch (e) {
      setPdf({ loading: false, meta: null, dataUrl: null, error: errInfo(e).text })
    }
  }

  function onImportFile(e) {
    const file = e.target && e.target.files && e.target.files[0]
    if (file) {
      const isPdf = /\.pdf$/i.test(file.name)
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result || '')
        const b64 = (dataUrl.split(',')[1]) || ''
        // Preview text for non-PDF uploads (Fountain / text / FDX); PDFs are
        // handled by the backend's text-extraction path, so show a hint instead.
        let preview = ''
        if (!isPdf) {
          try { preview = b64ToText(b64) } catch (_) { preview = '' }
        }
        const titleM = preview.match(/^Title:\s*(.+)$/mi)
        const creditM = preview.match(/(?:Written by|written by|story by)\s*:?\s*([^\r\n]+)/mi)
        setImportPanel({
          name: file.name,
          title: (titleM && titleM[1] || file.name.replace(/\.[^.]+$/, '')).trim(),
          author: (creditM && creditM[1] || '').trim(),
          preview,
          content_b64: b64,
          isPdf
        })
      }
      reader.onerror = () => setNotice({ kind: 'err', text: 'Could not read the selected file.' })
      reader.readAsDataURL(file)
    }
    e.target.value = ''
  }

  async function doImport() {
    if (!importPanel) return
    setBusy(true)
    try {
      const p = await api('/projects', { method: 'POST', body: {
        title: (importPanel.title || '').trim() || 'Imported script',
        author: (importPanel.author || '').trim(),
        filename: importPanel.name,
        content_b64: importPanel.content_b64
      } })
      setImportPanel(null)
      setSceneId(null)
      setDraft(null)
      setEditing(false)
      setPid(p.id)
      setTab('script')
      setNotice({ kind: 'ok', text: `Imported "${p.title}" as a new project.` })
      await invalidateAll()
    } catch (e) {
      setNotice({ kind: 'err', text: `Import failed: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  async function doNewProject() {
    if (!newProject) return
    const title = (newProject.title || '').trim()
    if (!title) { setNotice({ kind: 'err', text: 'Give the project a title first.' }); return }
    setBusy(true)
    try {
      const p = await api('/projects', { method: 'POST', body: {
        title,
        author: (newProject.author || '').trim(),
        format: newProject.format || 'screenplay',
        fountain_text: newProject.text || ''
      } })
      setNewProject(null)
      setSceneId(null)
      setDraft(null)
      setEditing(false)
      setPid(p.id)
      setTab('script')
      setNotice({ kind: 'ok', text: `Created "${p.title}".` })
      await invalidateAll()
    } catch (e) {
      setNotice({ kind: 'err', text: `Create failed: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  async function doExportFountain() {
    if (!pid) return
    setBusy(true)
    try {
      const r = await api(`/projects/${pid}/fountain`, { method: 'GET' })
      downloadText(r.fountain, r.filename)
      setNotice({ kind: 'ok', text: `Exported ${r.filename} (${r.size_bytes} bytes) for use in other screenplay software.` })
    } catch (e) {
      setNotice({ kind: 'err', text: `Fountain export failed: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  function downloadText(text, filename) {
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename || 'script.fountain'
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e) {
      setNotice({ kind: 'err', text: `Download failed: ${String(e)}` })
    }
  }

  // Fade a notice out before it's removed (used by the ✕ and action buttons).
  function closeNotice() {
    if (!notice) return
    setNoticeLeaving(true)
  }

  // ---------- render ----------

  const failed = projectsQ.isError
  const projectFailed = !!pid && projectQ.isError
  const loading = !!pid && !data && !projectFailed
  const scene = sceneId ? sceneById[sceneId] : null

  const projectName = (data && data.project && (data.project.title || data.project.id)) || pid || 'No project'

  const topbar = jsxs('div', { className: 'hsp-topbar', children: [
    jsxs('div', { className: 'hsp-topbar-left', children: [
      jsx('span', { className: 'hsp-brand', children: 'Ghostwriter' }),
      jsx('span', { className: 'hsp-topbar-sep', children: '/' }),
      jsx(ProjectPicker, {
        projects,
        value: pid || '',
        onChange: (newId) => requireSaved(() => setPid(newId), 'switching projects'),
        onNew: () => setNewProject({ title: '', author: '', format: 'screenplay', text: '' }),
        onImport: onImportFile,
        importAccept: '.fountain,.fdx,.pdf,.txt,.xml,.text,.md,text/plain,application/pdf'
      }),
      data && jsx('span', { className: 'hsp-format-chip', children: 'SCREENPLAY' })
    ] }),
    jsxs('div', { className: 'hsp-viewtabs', children:
      TABS.map(([key, label]) => {
        const active = tab === key
        let badge = null
        if (key === 'proposals' && proposalsQ.data && Array.isArray(proposalsQ.data)) {
          const open = proposalsQ.data.filter(p => {
            const s = String(p.status).toUpperCase()
            return s === 'PENDING' || s === 'BLOCKED'
          }).length
          if (open > 0) badge = jsx('span', { className: 'hsp-badge', children: String(open) })
        }
        if (key === 'script' && dirty) badge = jsx('span', { className: 'hsp-dot', children: '●' })
        return jsx('button', {
          className: `hsp-vtab${active ? ' hsp-vtab-active' : ''}`,
          key,
          onClick: () => setTab(key),
          children: [jsx('span', { children: label }), badge]
        })
      })
    }),
    jsxs('div', { className: 'hsp-topbar-right', children: [
      jsx('button', {
        className: 'hsp-btn hsp-btn-small hsp-iconbtn',
        title: focusMode ? 'Exit focus mode' : 'Focus mode (hide chrome)',
        onClick: () => setFocusMode(f => !f),
        children: focusMode ? '⤢' : '⤡'
      }),
      jsx('button', {
        className: 'hsp-btn hsp-btn-small hsp-btn-primary' + (chatOpen ? ' hsp-btn-on' : ''),
        title: chatOpen ? 'Close the assistant' : 'Open Ghostwriter chat',
        onClick: () => { const next = !chatOpen; setChatOpen(next); if (next) setTab('script') },
        children: '💬'
      }),
      jsx('span', { className: 'hsp-status', children:
        statusQ.data
          ? `${statusQ.data.projects} project${statusQ.data.projects === 1 ? '' : 's'} · v${statusQ.data.hermes_version}`
          : (failed ? 'offline' : '…') })
    ] })
  ] })

  const noticeEl = notice ? jsxs('div', {
    className: `hsp-notice hsp-notice-${notice.kind}${noticeLeaving ? ' hsp-notice-leave' : ''}`,
    key: `${notice.kind}:${notice.text}`,
    children: [
      jsx('span', { children: notice.text }),
      notice.action && jsx('button', { className: 'hsp-btn hsp-btn-small', onClick: notice.action, children: 'Reload latest' }),
      jsx('button', { className: 'hsp-btn hsp-btn-small hsp-btn-ghost', onClick: closeNotice, children: '✕' })
    ]
  }) : null

  // ---------------- Script tab ----------------

  const scriptInner = !pid
    ? null
    : loading
      ? jsx('div', { className: 'hsp-muted', children: 'Loading project…' })
      : projectFailed
        ? jsxs('div', { className: 'hsp-error', children: [
            jsx('div', { children: `Project load failed: ${String((projectQ.error && projectQ.error.message) || projectQ.error)}` }),
            jsx('button', { className: 'hsp-btn', onClick: () => projectQ.refetch(), children: 'Retry' })
          ] })
        : scenes.length === 0
          ? jsx('div', { className: 'hsp-empty', children: 'This project has no scenes yet. Ask in chat to add or rewrite scenes.' })
          : jsxs('div', { className: 'gw-workspace' + (outlineOpen ? '' : ' gw-outline-hidden'), children: [
              // Left: collapsible scene outline (click to jump; syncs with scroll)
              jsx('div', { className: 'gw-outline', children: [
                jsxs('div', { className: 'gw-outline-head', children: [
                  jsx('span', { className: 'gw-outline-title', children: 'Scenes' }),
                  jsx('span', { className: 'gw-outline-count', children: String(scenes.length) }),
                  jsx('button', { className: 'gw-iconbtn', title: 'Hide outline', onClick: () => setOutlineOpen(false), children: '⟨' })
                ] }),
                jsx('div', { className: 'gw-outline-list', ref: navRef, children: scenes.map(s =>
                  jsx('button', {
                    className: `gw-outline-row${sceneId === s.id ? ' gw-outline-active' : ''}`,
                    'data-nav-id': s.id,
                    key: s.id,
                    onClick: () => {
                      if (s.id === sceneId) return
                      requireSaved(() => goToSceneNow(s.id),
                        `jumping to “${s.heading || 'untitled'}”`)
                    },
                    children: jsxs('span', { className: 'gw-outline-text', children: pack.navText(s) })
                  })) })
              ] }),
              // Center: the manuscript paper
              jsxs('div', { className: 'gw-stage', children: [
                !outlineOpen && jsx('button', { className: 'gw-iconbtn gw-outline-show', title: 'Show outline', onClick: () => setOutlineOpen(true), children: '⟩' }),
                scene ? jsxs('div', { className: 'gw-slate', children: [
                  jsx('div', { className: 'gw-slate-title', children:
                    (scene.heading || '(untitled scene)') + (dirty ? '  ● unsaved' : '') }),
                  !editing ? jsx('button', { className: 'hsp-btn hsp-btn-small', title: 'Edit the entire script in Fountain', onClick: startEdit, children: 'Edit document' }) : null
                ] }) : null,
                // View settings: find (Ctrl/Cmd+F) + paper tone + size (persisted in localStorage).
                jsxs('div', { className: 'hsp-viewbar', children: [
                  jsx('button', {
                    className: 'hsp-btn hsp-btn-small hsp-iconbtn' + (searchOpen ? ' hsp-btn-on' : ''), type: 'button',
                    title: 'Find (Ctrl/Cmd+F)',
                    onClick: () => {
                      const next = !searchOpen
                      setSearchOpen(next)
                      if (!next) { setSearchQuery(''); setReplaceQuery(''); setCurrentMatch(-1) }
                    },
                    children: '🔍'
                  }),
                  jsx('span', { className: 'hsp-viewbar-sep', children: '|' }),
                  jsx('button', {
                    className: 'gw-tone', type: 'button',
                    title: 'Paper tone: ' + (PAPER[view.paper] ? PAPER[view.paper].label : 'Pale blue') + ' (click to change)',
                    onClick: () => {
                      const order = PAPER_ORDER
                      const idx = order.indexOf(view.paper)
                      updateView({ paper: order[(idx + 1) % order.length] })
                    },
                    children: jsx('span', { className: 'gw-tone-dot', style: { background: (PAPER[view.paper] || PAPER.blue).bg } })
                  }),
                  jsx('span', { className: 'hsp-viewbar-sep', children: '|' }),
                  jsx('span', { className: 'hsp-viewbar-label', children: 'Size' }),
                  jsx('input', {
                    className: 'hsp-size-range', type: 'range', min: 11, max: 18, step: 0.5,
                    value: Number.isFinite(Number(view.size)) ? Number(view.size) : 13,
                    onChange: (e) => updateView({ size: Number(e.target.value) }),
                    title: 'Manuscript font size'
                  }),
                  jsx('span', { className: 'hsp-viewbar-label hsp-size-val', children: (Number.isFinite(Number(view.size)) ? Number(view.size) : 13) + 'px' }),
                ] }),
                // Search / find & replace bar — hidden until Ctrl/Cmd+F or the Find button.
                searchOpen ? jsxs('div', { className: 'hsp-searchbar', children: [
                  jsx('span', { className: 'hsp-searchbar-ico', children: '🔍' }),
                  jsx('input', {
                    className: 'hsp-searchbar-input', type: 'text', ref: searchRef,
                    placeholder: 'Search…', value: searchQuery,
                    onChange: (e) => { setSearchQuery(e.target.value); setCurrentMatch(-1) },
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') stepMatch(e.shiftKey ? -1 : 1)
                      else if (e.key === 'Escape') { setSearchQuery(''); setCurrentMatch(-1) }
                    }
                  }),
                  matches.length
                    ? jsxs('span', { className: 'hsp-searchbar-count', children: [
                        (currentMatch < 0 ? 0 : currentMatch + 1), '/', matches.length
                      ] })
                    : null,
                  jsx('button', { className: 'hsp-btn hsp-btn-small', title: 'Previous match (Shift+Enter)', disabled: !matches.length, onClick: () => stepMatch(-1), children: '↑' }),
                  jsx('button', { className: 'hsp-btn hsp-btn-small', title: 'Next match (Enter)', disabled: !matches.length, onClick: () => stepMatch(1), children: '↓' }),
                  jsx('span', { className: 'hsp-viewbar-sep', children: '|' }),
                  jsx('input', {
                    className: 'hsp-searchbar-input', type: 'text',
                    placeholder: 'Replace with…', value: replaceQuery,
                    onChange: (e) => setReplaceQuery(e.target.value)
                  }),
                  jsx('button', { className: 'hsp-btn hsp-btn-small', title: 'Replace the highlighted match', disabled: !matches.length || currentMatch < 0 || busy, onClick: () => doReplace('current'), children: 'Replace' }),
                  jsx('button', { className: 'hsp-btn hsp-btn-small', title: 'Replace every match', disabled: !matches.length || busy, onClick: () => doReplace('all'), children: 'All' }),
                  jsx('button', { className: 'hsp-btn hsp-btn-small hsp-iconbtn', title: 'Close search', onClick: () => { setSearchQuery(''); setReplaceQuery(''); setCurrentMatch(-1) }, children: '×' })
                ] }) : null,
                editing && draft
                  ? jsxs('div', { className: 'hsp-editor hsp-editor-doc', children: [
                      jsx('div', { className: 'hsp-editor-scroll', children: [
                        jsx(TitlePageEditor, {
                          fields: draft.title.fields, order: draft.title.order,
                          onChange: (key, val) => setDraft(d => ({ ...d, title: { ...d.title, fields: { ...d.title.fields, [key]: val } }, changed: true })),
                        }),
                        draft.structure.map((sc) => jsxs('div', { className: 'hsp-edit-scene', key: sc.id, children:
                          sc.elements.map((e) => jsx(EditElement, {
                            kind: e.kind, key: e.key,
                            value: draft.values[e.key] != null ? draft.values[e.key] : e.text,
                            onChange: (val) => setDraft(d => ({ ...d, values: { ...d.values, [e.key]: val }, changed: true })),
                          })),
                        })),
                        jsx('div', { className: 'hsp-hint hsp-full-hint', children:
                          'Editing the whole script — the standard format is preserved. Save to commit a new revision.' }),
                      ] }),
                      jsxs('div', { className: 'hsp-actions', children: [
                        jsx('button', { className: 'hsp-btn hsp-btn-primary', disabled: busy, onClick: () => doSaveDoc(), children: busy ? 'Saving…' : 'Save document' }),
                        jsx('button', {
                          className: 'hsp-btn', disabled: busy,
                          onClick: () => { setDraft(null); setEditing(false) },
                          children: 'Cancel' }),
                        dirty
                          ? jsx('span', { className: 'hsp-hint', children: 'unsaved changes' })
                          : null
                      ] })
                    ] })
                  : jsxs('div', { className: 'hsp-full', ref: fullRef, onScroll: onFullScroll, children: [
                      jsx(TitlePageView, { fields: titlePage.fields, order: titlePage.order }),
                      scenes.map((s, i) => jsx(pack.Block, { scene: s, index: i, key: s.id })),
                      jsx('div', { className: 'hsp-hint hsp-full-hint', children:
                        'Scroll to read the whole script — the list highlights the scene at the top edge. Click a scene to jump; use Edit document to change it.' })
                    ] }),
                jsx('div', { className: 'gw-statusbar', children: [
                  jsx('span', { children: wordCount.toLocaleString() + ' words' }),
                  jsx('span', { className: 'gw-statusbar-sep', children: '·' }),
                  jsx('span', { children: scenes.length + ' scene' + (scenes.length === 1 ? '' : 's') })
                ] })
              ] })
            ] })

  // Drag the divider to resize the chat column (width persists per user).
  function onResizeStart(e) {
    e.preventDefault()
    setResizing(true)
    const onMove = (ev) => {
      const el = splitRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const w = Math.max(260, Math.min(Math.max(280, rect.width - 360), Math.round(rect.right - ev.clientX)))
      setChatWidth(w)
      saveChatWidth(w)
    }
    const onUp = () => {
      setResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      try { document.body.style.cursor = ''; document.body.style.userSelect = '' } catch (_) {}
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    try { document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none' } catch (_) {}
  }
  // Side-by-side split (feature #3): when the Chat rail is open, the manuscript
  // shares the Script tab with a compact chat column — read your text and talk
  // to the model at the same time, in the same view (no separate window/tab).
  const scriptTab = chatOpen
    ? jsxs('div', { className: 'hsp-split', ref: splitRef, children: [
        jsx('div', { className: 'hsp-split-main', children: scriptInner }),
        jsx('div', {
          className: 'gw-resize-handle' + (resizing ? ' gw-resize-active' : ''),
          onMouseDown: onResizeStart
        }),
        jsx('div', { className: 'gw-chat-col', style: { width: chatWidth + 'px' }, children:
          jsx(GwChatRail, {
            projects, currentPid: pid, currentData: data,
            onClose: () => setChatOpen(false)
          })
        })
      ] })
    : scriptInner

  // ---------------- Proposals tab ----------------

  const proposals = (proposalsQ.data && Array.isArray(proposalsQ.data)) ? proposalsQ.data : []
  const proposal = proposalQ.data
  const proposalsTab = !pid ? null : jsxs('div', { className: 'hsp-proposals', children: [
    jsx('div', { className: 'hsp-list-label', children:
      proposalsQ.isPending ? 'Loading proposals…' : (proposalsQ.isError ? 'Failed to load proposals.' : `${proposals.length} proposal${proposals.length === 1 ? '' : 's'}`) }),
    jsx('div', { className: 'hsp-list', children: proposals.map(p => {
      const st = String(p.status || '').toUpperCase()
      const heads = (p.diff || [])
        .filter(d => d.status && d.status !== 'unchanged')
        .map(d => d.heading || d.scene_id)
      return jsxs('button', {
        className: `hsp-row${propSel === p.id ? ' hsp-row-active' : ''}`,
        key: p.id,
        onClick: () => setPropSel(p.id),
        children: [
          jsxs('div', { className: 'hsp-row-main', children: [
            jsx('div', { className: 'hsp-row-title', children: heads.length ? heads.join(', ') : '(no scene changes)' }),
            jsxs('div', { className: 'hsp-row-meta', children: [
              fmtTime(p.created_at),
              ` · based ${String(p.base_revision_id || '').slice(0, 12)}…`
            ] })
          ] }),
          jsx(Chip, { kind: statusKind(st), children: st })
        ]
      })
    }) }),
    proposal && jsxs('div', { className: 'hsp-proposal-detail', children: [
      jsxs('div', { className: 'hsp-proposal-head', children: [
        jsx(Chip, { kind: statusKind(proposal.status), children: String(proposal.status || '').toUpperCase() }),
        jsx('span', { className: 'hsp-hint', children:
          `base ${String(proposal.base_revision_id || '').slice(0, 12)}…${proposal.base_is_active ? ' (active)' : ' (older)'} · rules ${String(proposal.rules_id || '').slice(0, 12)}…` }),
        jsx('button', { className: 'hsp-btn hsp-btn-small hsp-btn-ghost', onClick: () => setPropSel(null), children: 'Close' })
      ] }),
      proposal.stale &&
        jsx('div', { className: 'hsp-notice hsp-notice-err', children:
          'Stale proposal: its base revision or rules no longer exist. Reject it to clear it.' }),
      !proposal.stale && !proposal.base_is_active &&
        jsx('div', { className: 'hsp-notice hsp-notice-err', children:
          'Heads up: this proposal is based on an older revision. Accepting applies it to its base, not the current text.' }),
      jsx('div', { className: 'hsp-changes', children: (proposal.changes || []).map(c =>
        jsxs('div', { className: 'hsp-change', key: c.scene_id || c.heading, children: [
          jsxs('div', { className: 'hsp-change-head', children: [
            jsx(Chip, { kind: statusKind(c.status), children: String(c.status || '').toUpperCase() }),
            jsx('span', { className: 'hsp-change-heading', children: c.heading || '(untitled)' })
          ] }),
          jsxs('div', { className: 'hsp-diff', children: [
            c.status !== 'added' ? jsxs('div', { className: 'hsp-diff-col', children: [
              jsx('div', { className: 'hsp-diff-label', children: 'Before' }),
              jsx('pre', { className: 'hsp-pre', children: c.before || '—' })
            ] }) : null,
            c.status !== 'removed' ? jsxs('div', { className: 'hsp-diff-col', children: [
              jsx('div', { className: 'hsp-diff-label', children: 'After' }),
              jsx('pre', { className: 'hsp-pre', children: c.after || '—' })
            ] }) : null
          ] })
        ] })) }),
      (proposal.checks || []).length > 0 && jsxs('div', { className: 'hsp-checks', children: [
        jsx('div', { className: 'hsp-list-label', children: 'Deterministic checks' }),
        (proposal.checks || []).map((c, i) => jsxs('div', { className: 'hsp-check', key: i, children: [
          jsx(Chip, { kind: statusKind(c.status), children: String(c.status || '').toUpperCase() }),
          jsx('span', { className: 'hsp-check-name', children: c.name }),
          c.detail ? jsx('span', { className: 'hsp-hint', children: c.detail }) : null
        ] }))
      ] }),
      jsxs('div', { className: 'hsp-actions', children: [
        (() => {
          const s = String(proposal.status).toUpperCase()
          return (s === 'PENDING' || s === 'BLOCKED') && !proposal.stale
            ? jsx('button', {
                className: 'hsp-btn hsp-btn-primary', disabled: busy,
                onClick: () => requireSaved(() => doAccept(proposal.id), 'accepting this proposal'),
                children: 'Accept proposal'
              }) : null
        })(),
        (() => {
          const s = String(proposal.status).toUpperCase()
          return (s !== 'ACCEPTED' && s !== 'REJECTED')
            ? jsx('button', {
                className: 'hsp-btn hsp-btn-danger', disabled: busy,
                onClick: () => doReject(proposal.id),
                children: 'Reject'
              }) : null
        })()
      ] })
    ] })
  ] })

  // ---------------- Rules tab ----------------

  const rules = data ? data.rules : null
  const rulesTab = !pid || loading || projectFailed
    ? jsx('div', { className: 'hsp-muted', children: 'Loading rules…' })
    : !rulesForm
      ? jsx('div', { className: 'hsp-muted', children: 'No rules version recorded for this project yet.' })
      : jsxs('div', { className: 'hsp-rules', children: [
          jsx('div', { className: 'hsp-list-label', children: `Rules version ${String(rulesForm.rulesId).slice(0, 12)}… — append-only: saving creates a new version` }),
          jsxs('div', { className: 'hsp-field', children: [
            jsx('label', { className: 'hsp-label', children: 'Max lines per dialogue block (empty = keep current)' }),
            jsx('input', { className: 'hsp-input', type: 'number', min: '1', value: rulesForm.dialogueBlockLimit,
              onChange: (e) => setRulesForm(f => ({ ...f, dialogueBlockLimit: e.target.value })) })
          ] }),
          jsxs('div', { className: 'hsp-field', children: [
            jsx('label', { className: 'hsp-label', children: 'Max pages (empty = keep current)' }),
            jsx('input', { className: 'hsp-input', type: 'number', min: '1', value: rulesForm.pageLimit,
              onChange: (e) => setRulesForm(f => ({ ...f, pageLimit: e.target.value })) })
          ] }),
          jsxs('div', { className: 'hsp-field', children: [
            jsx('label', { className: 'hsp-label', children: 'Editorial guidance (one rule per line; interpreted by the model)' }),
            jsx('textarea', { className: 'hsp-textarea hsp-textarea-small', value: rulesForm.guidance,
              onChange: (e) => setRulesForm(f => ({ ...f, guidance: e.target.value })) })
          ] }),
          rules.allowed_speakers && Array.isArray(rules.allowed_speakers) ? jsxs('div', { className: 'hsp-field', children: [
            jsx('label', { className: 'hsp-label', children: `Allowed speakers (managed via chat — ${rules.allowed_speakers.length} configured)` }),
            jsx('pre', { className: 'hsp-pre', children: JSON.stringify(rules.allowed_speakers, null, 1) })
          ] }) : null,
          jsxs('div', { className: 'hsp-field', children: [
            jsx('label', { className: 'hsp-label', children: `Protected passages (${(rulesForm.protected || []).length}) — edits touching these are rejected` }),
            (rulesForm.protected || []).map((pr, i) => jsxs('div', { className: 'hsp-proto-row', key: i, children: [
              jsxs('span', { className: 'hsp-hint', children: [
                jsx('strong', { children: pr.label || '(no label)' }),
                ` · scene ${String(pr.scene_id).slice(0, 10)}… · offset ${pr.offset_in_scene} · len ${pr.length}`
              ] }),
              jsx('button', { className: 'hsp-btn hsp-btn-small hsp-btn-ghost',
                onClick: () => setRulesForm(f => ({ ...f, protected: f.protected.filter((_, j) => j !== i) })),
                children: 'Remove' })
            ] })),
            scenes.length > 0 && jsxs('div', { className: 'hsp-proto-add', children: [
              jsx('select', { className: 'hsp-select', value: rulesForm.addScene,
                onChange: (e) => setRulesForm(f => ({ ...f, addScene: e.target.value })),
                children: scenes.map(s => jsx('option', { value: s.id, children: s.heading || '(untitled)', key: s.id })) }),
              jsx('input', { className: 'hsp-input hsp-input-num', type: 'number', min: '0', placeholder: 'offset',
                value: rulesForm.addOffset, onChange: (e) => setRulesForm(f => ({ ...f, addOffset: e.target.value })) }),
              jsx('input', { className: 'hsp-input hsp-input-num', type: 'number', min: '1', placeholder: 'length',
                value: rulesForm.addLength, onChange: (e) => setRulesForm(f => ({ ...f, addLength: e.target.value })) }),
              jsx('input', { className: 'hsp-input', type: 'text', placeholder: 'label', style: { flex: 1, minWidth: 100 },
                value: rulesForm.addLabel, onChange: (e) => setRulesForm(f => ({ ...f, addLabel: e.target.value })) }),
              jsx('button', { className: 'hsp-btn hsp-btn-small', onClick: () => setRulesForm(f => ({
                ...f,
                protected: [...(f.protected || []), {
                  scene_id: f.addScene,
                  offset_in_scene: Number(f.addOffset) || 0,
                  length: Number(f.addLength) || 0,
                  label: f.addLabel || ''
                }]
              })), children: 'Add' })
            ] })
          ] }),
          jsxs('div', { className: 'hsp-actions', children: [
            jsx('button', { className: 'hsp-btn hsp-btn-primary', disabled: busy, onClick: () => doSaveRules(), children: busy ? 'Saving…' : 'Save rules' }),
            jsx('span', { className: 'hsp-hint', children: 'Saving rules invalidates pending proposals (RULES_CHANGED).' })
          ] })
        ] })

  // ---------------- History tab ----------------

  const hist = (historyQ.data && Array.isArray(historyQ.data)) ? historyQ.data : []
  const historyTab = !pid ? null : jsxs('div', { className: 'hsp-history', children: [
    jsxs('div', { className: 'hsp-actions', children: [
      jsx('button', { className: 'hsp-btn', disabled: busy || confirmId === 'undo',
        onClick: () => (confirmId === 'undo' ? doUndo() : setConfirmId('undo')),
        children: confirmId === 'undo' ? 'Confirm undo last change' : 'Undo last change' })
    ] }),
    jsx('div', { className: 'hsp-list-label', children: historyQ.isPending ? 'Loading history…' : `${hist.length} revision${hist.length === 1 ? '' : 's'} (immutable — restore creates a new one)` }),
    jsx('div', { className: 'hsp-list', children: hist.map(r => jsxs('div', { className: 'hsp-hist-row', key: r.id, children: [
      jsxs('div', { className: 'hsp-row-main', children: [
        jsxs('div', { className: 'hsp-row-title', children: [
          String((r.origin || 'revision').toLowerCase().replace('_', ' ')),
          r.is_active ? '  ·  active' : null
        ] }),
        jsxs('div', { className: 'hsp-row-meta', children: [
          fmtTime(r.created_at),
          ` · ${r.scene_count} scenes · ${String(r.content_hash || '').slice(0, 8)}`
        ] })
      ] }),
      r.is_active
        ? null
        : jsxs('div', { className: 'hsp-actions', children: [
            confirmId === r.id
              ? jsx('button', { className: 'hsp-btn hsp-btn-small hsp-btn-primary', disabled: busy,
                  onClick: () => doRestore(r.id), children: 'Confirm restore' })
              : jsx('button', { className: 'hsp-btn hsp-btn-small', disabled: busy,
                  onClick: () => setConfirmId(r.id), children: 'Restore' })
          ] })
    ] })) }),
    confirmId ? jsx('div', { className: 'hsp-hint', children: 'Click the confirm button to apply, or take another action to cancel.' }) : null
  ] })

  // ---------------- Export tab ----------------

  const exportTab = !pid ? null : jsxs('div', { className: 'hsp-export', children: [
    jsxs('div', { className: 'hsp-actions', children: [
      jsx('button', { className: 'hsp-btn hsp-btn-primary', disabled: busy || !!(pdf && pdf.loading), onClick: () => doExport(),
        children: pdf && pdf.loading ? 'Rendering…' : 'Export current revision to PDF' })
    ] }),
    pdf && pdf.error ? jsx('div', { className: 'hsp-notice hsp-notice-err', children:
      `Renderer unavailable: ${pdf.error}` }) : null,
    pdf && pdf.meta && jsxs('div', { className: 'hsp-export-result', children: [
      jsx('div', { className: 'hsp-list-label', children:
        `Exported ${pdf.meta.page_count} page${pdf.meta.page_count === 1 ? '' : 's'} · ${pdf.meta.size_bytes} bytes · ${pdf.meta.filename}` }),
      pdf.dataUrl
        ? jsxs('div', { className: 'hsp-pdf-wrap', children: [
            jsx('iframe', { className: 'hsp-pdf', src: pdf.dataUrl, title: `PDF: ${pdf.meta.filename}` }),
            jsxs('div', { className: 'hsp-actions', children: [
              jsx('a', { className: 'hsp-btn hsp-btn-small', href: pdf.dataUrl, download: pdf.meta.filename, children: 'Download PDF' }),
              jsx('button', { className: 'hsp-btn hsp-btn-small hsp-btn-ghost', onClick: () => setPdf(null), children: 'Close' })
            ] })
          ] })
        : jsxs('div', { className: 'hsp-actions', children: [
          jsx('span', { className: 'hsp-hint', children:
            `Rendered at ${pdf.meta.path}${pdf.error ? ` — embedded view unavailable: ${pdf.error}` : ''}` }),
          jsx('button', { className: 'hsp-btn hsp-btn-small hsp-btn-ghost', onClick: () => setPdf(null), children: 'Dismiss' })
        ] })
    ] }),
    jsxs('div', { className: 'hsp-export-fountain', children: [
      jsx('div', { className: 'hsp-list-label', children:
        'Fountain (.fountain) — opens in Fountain, Final Draft, Highland, or any Fountain-compatible tool' }),
      jsx('button', { className: 'hsp-btn hsp-btn-primary', disabled: busy, onClick: () => doExportFountain(),
        children: busy ? 'Preparing…' : 'Export current revision as Fountain' })
    ] })
  ] })

  const emptyProjects = !failed && projectsQ.data && projects.length === 0
  const connecting = !failed && !projectsQ.data && projectsQ.isPending

  const importPanelEl = importPanel ? jsxs('div', { className: 'hsp-import', children: [
    jsxs('div', { className: 'hsp-import-head', children: [
      jsx('span', { className: 'hsp-import-title', children: 'Import screenplay file' }),
      jsx('button', { className: 'hsp-btn hsp-btn-small hsp-btn-ghost', disabled: busy, onClick: () => setImportPanel(null), children: '✕' })
    ] }),
    jsx('div', { className: 'hsp-hint', children: `File: ${importPanel.name} · ${importPanel.isPdf ? 'PDF (text will be extracted)' : 'text (Fountain / Final Draft / plain text)'}` }),
    jsxs('div', { className: 'hsp-import-field', children: [
      jsx('label', { children: 'Title' }),
      jsx('input', { className: 'hsp-input', value: importPanel.title, onChange: (e) => setImportPanel({ ...importPanel, title: e.target.value }) })
    ] }),
    jsxs('div', { className: 'hsp-import-field', children: [
      jsx('label', { children: 'Author' }),
      jsx('input', { className: 'hsp-input', value: importPanel.author, onChange: (e) => setImportPanel({ ...importPanel, author: e.target.value }) })
    ] }),
    (importPanel.isPdf)
      ? jsx('div', { className: 'hsp-hint', children: 'PDF detected — text will be extracted and re-structured into Fountain on import. Complex layouts may need a light cleanup in the Script tab afterward.' })
      : jsx('pre', { className: 'hsp-raw hsp-import-preview', children:
          (importPanel.preview || '').slice(0, 500) + ((importPanel.preview || '').length > 500 ? ' …' : '') }),
    jsxs('div', { className: 'hsp-actions', children: [
      jsx('button', { className: 'hsp-btn hsp-btn-primary', disabled: busy, onClick: () => doImport(),
        children: busy ? 'Importing…' : 'Import as new project' }),
      jsx('button', { className: 'hsp-btn', disabled: busy, onClick: () => setImportPanel(null), children: 'Cancel' })
    ] })
  ] }) : null

  const newProjectEl = newProject ? jsxs('div', { className: 'hsp-import', children: [
    jsxs('div', { className: 'hsp-import-head', children: [
      jsx('span', { className: 'hsp-import-title', children: 'New project' }),
      jsx('button', { className: 'hsp-btn hsp-btn-small hsp-btn-ghost', disabled: busy, onClick: () => setNewProject(null), children: '✕' })
    ] }),
    jsx('div', { className: 'hsp-hint', children: 'Start from scratch — no file needed. Paste Fountain, or leave it blank and build it in chat.' }),
    jsxs('div', { className: 'hsp-import-field', children: [
      jsx('label', { children: 'Title' }),
      jsx('input', { className: 'hsp-input', autoFocus: true, value: newProject.title, placeholder: 'My screenplay', onChange: (e) => setNewProject({ ...newProject, title: e.target.value }) })
    ] }),
    jsxs('div', { className: 'hsp-import-field', children: [
      jsx('label', { children: 'Author' }),
      jsx('input', { className: 'hsp-input', value: newProject.author, placeholder: 'Optional', onChange: (e) => setNewProject({ ...newProject, author: e.target.value }) })
    ] }),
    jsxs('div', { className: 'hsp-import-field', children: [
      jsx('label', { children: 'Initial text (optional — leave blank to start empty)' }),
      jsx('textarea', { className: 'hsp-textarea hsp-textarea-small', value: newProject.text, placeholder: 'Paste Fountain…', onChange: (e) => setNewProject({ ...newProject, text: e.target.value }) })
    ] }),
    jsxs('div', { className: 'hsp-actions', children: [
      jsx('button', { className: 'hsp-btn hsp-btn-primary', disabled: busy || !(newProject.title || '').trim(), onClick: () => doNewProject(),
        children: busy ? 'Creating…' : 'Create project' }),
      jsx('button', { className: 'hsp-btn', disabled: busy, onClick: () => setNewProject(null), children: 'Cancel' })
    ] })
  ] }) : null

  return jsx(SearchCtx.Provider, { value: searchState, children: jsxs('div', {
    className: 'hsp-pane' + (focusMode ? ' hsp-pane-focus' : ''),
    style: {
      '--gw-ui': FONTS.ui,
      '--gw-font': FONTS.script,
      '--gw-size': (Number.isFinite(Number(view.size)) ? Number(view.size) : 13) + 'px',
      '--gw-paper': (PAPER[view.paper] || PAPER.blue).bg,
    },
    children: [
    topbar,
    noticeEl,
    importPanelEl,
    newProjectEl,
    failed
      ? jsxs('div', { className: 'hsp-error', children: [
          jsx('div', { children: `Backend error: ${String((projectsQ.error && projectsQ.error.message) || projectsQ.error)}` }),
          jsx('button', { className: 'hsp-btn', onClick: () => projectsQ.refetch(), children: 'Retry' })
        ] })
      : emptyProjects
        ? jsxs('div', { className: 'hsp-empty', children: [
            jsx('div', { children: 'No projects yet.' }),
            jsx('button', { className: 'hsp-btn hsp-btn-primary', onClick: () => setNewProject({ title: '', author: '', format: 'screenplay', text: '' }), children: '+ New project' }),
            jsx('div', { className: 'hsp-hint', children: 'Or create one in chat — e.g. “create a screenplay project called X” or “import this Fountain file: …”.' })
          ] })
        : connecting
          ? jsx('div', { className: 'hsp-muted', children: 'Connecting…' })
          : !pid
            ? jsx('div', { className: 'hsp-muted', children: 'Selecting a project…' })
            : jsxs('div', { className: 'hsp-tabbody', children: [
                tab === 'script' ? scriptTab : null,
                tab === 'proposals' ? proposalsTab : null,
                tab === 'rules' ? rulesTab : null,
                tab === 'history' ? historyTab : null,
                tab === 'export' ? exportTab : null
              ] }),
    guard && jsxs('div', { className: 'hsp-guard', children: [
      jsxs('div', { className: 'hsp-guard-box', children: [
        jsx('div', { className: 'hsp-guard-title', children: 'Unsaved changes' }),
        jsx('div', { className: 'hsp-guard-text', children:
          `You have unsaved edits in the document editor. ${guard.label ? guard.label + '. ' : ''}Save or discard them first.` }),
        jsxs('div', { className: 'hsp-guard-actions', children: [
          jsx('button', { className: 'hsp-btn hsp-btn-primary', disabled: busy,
            onClick: async () => {
              const ok = await doSaveDoc()
              if (ok) { const n = guard.next; setGuard(null); n() }
            },
            children: 'Save changes' }),
          jsx('button', { className: 'hsp-btn', disabled: busy,
            onClick: () => { const n = guard.next; setDraft(null); setEditing(false); setGuard(null); n() },
            children: 'Discard' }),
          jsx('button', { className: 'hsp-btn hsp-btn-ghost', onClick: () => setGuard(null), children: 'Cancel' })
        ] })
      ] })
    ] })
  ] }) })
}

const CSS = `
/* ---- Self-hosted manuscript font (Courier Prime, latin, SIL OFL) ---- */

@font-face { font-family:'Courier Prime'; font-style:normal; font-weight:400; font-display:block; src:url(data:font/woff2;base64,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) format('woff2'); }

@font-face { font-family:'Courier Prime'; font-style:normal; font-weight:700; font-display:block; src:url(data:font/woff2;base64,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) format('woff2'); }

.hsp-pane { display: flex; flex-direction: column; gap: 8px; padding: 12px; font-size: 13px; height: 100%; box-sizing: border-box; overflow: hidden; }
.hsp-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hsp-header-right { display: flex; align-items: center; gap: 10px; min-width: 0; }
.hsp-title { font-weight: 650; font-size: 15px; }
.hsp-sub { opacity: 0.65; font-size: 12px; }
.hsp-select { width: 100%; padding: 6px 8px; border-radius: 8px; border: 1px solid color-mix(in oklab, currentColor 30%, transparent); background: transparent; color: inherit; font-size: 13px; }
.hsp-tabs { display: flex; gap: 2px; border-bottom: 1px solid color-mix(in oklab, currentColor 15%, transparent); }
.hsp-tab { appearance: none; background: transparent; border: none; color: inherit; opacity: 0.6; padding: 6px 10px; font-size: 12.5px; cursor: pointer; border-radius: 6px 6px 0 0; display: flex; align-items: center; gap: 5px; }
.hsp-tab:hover { opacity: 0.85; }
.hsp-tab-active { opacity: 1; font-weight: 600; box-shadow: inset 0 -2px 0 currentColor; }
.hsp-badge { background: color-mix(in oklab, currentColor 18%, transparent); border-radius: 9px; padding: 0 6px; font-size: 11px; }
.hsp-dot { color: #f0b429; font-size: 9px; }
.hsp-tabbody { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.hsp-muted { opacity: 0.6; padding: 8px 2px; font-size: 12.5px; }
.hsp-empty { opacity: 0.75; padding: 10px 4px; font-size: 12.5px; line-height: 1.5; }
.hsp-error { color: #ff9c9c; background: color-mix(in oklab, #ff7676 12%, transparent); padding: 8px 10px; border-radius: 8px; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
.hsp-notice { padding: 8px 10px; border-radius: 8px; font-size: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hsp-import { border: 1px solid color-mix(in oklab, currentColor 18%, transparent); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px; background: color-mix(in oklab, currentColor 3%, transparent); }
.hsp-import-head { display: flex; align-items: center; justify-content: space-between; }
.hsp-import-title { font-weight: 650; }
.hsp-import-field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
.hsp-import-field label { opacity: 0.6; }
.hsp-input { padding: 5px 8px; border-radius: 7px; border: 1px solid color-mix(in oklab, currentColor 20%, transparent); background: transparent; color: inherit; font-size: 12.5px; }
.hsp-import-preview { margin: 0; max-height: 120px; overflow: auto; font-size: 11px; opacity: 0.7; white-space: pre-wrap; font-family: ui-monospace, monospace; }
.hsp-export-fountain { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; margin-top: 4px; border-top: 1px solid color-mix(in oklab, currentColor 12%, transparent); }
.hsp-notice-ok { background: color-mix(in oklab, #4cc38a 16%, transparent); }
.hsp-notice-err { background: color-mix(in oklab, #ff7676 14%, transparent); }
.hsp-list-label { opacity: 0.65; font-size: 11.5px; padding: 4px 2px; }
.hsp-list { display: flex; flex-direction: column; gap: 4px; }
.hsp-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; text-align: left; padding: 8px 10px; border-radius: 8px; border: 1px solid color-mix(in oklab, currentColor 12%, transparent); background: transparent; color: inherit; cursor: pointer; font-size: 13px; }
.hsp-row:hover { background: color-mix(in oklab, currentColor 8%, transparent); }
.hsp-row-active { border-color: currentColor; background: color-mix(in oklab, currentColor 10%, transparent); }
.hsp-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.hsp-row-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hsp-row-meta { opacity: 0.6; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hsp-chip { display: inline-block; border-radius: 9px; padding: 1px 8px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; }
.hsp-chip-pending { background: color-mix(in oklab, #f0b429 22%, transparent); }
.hsp-chip-blocked, .hsp-chip-stale, .hsp-chip-bad { background: color-mix(in oklab, #ff7676 24%, transparent); }
.hsp-chip-accepted, .hsp-chip-good { background: color-mix(in oklab, #4cc38a 24%, transparent); }
.hsp-chip-rejected, .hsp-chip-muted { background: color-mix(in oklab, currentColor 14%, transparent); }
.hsp-chip-warn { background: color-mix(in oklab, #f0b429 20%, transparent); }
.hsp-script { display: grid; grid-template-columns: 160px minmax(0,1fr); grid-template-rows: minmax(0,1fr); gap: 10px; flex: 1; min-height: 0; }
.hsp-nav { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; min-height: 0; }
.hsp-nav-row { appearance: none; text-align: left; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 5px 7px; color: inherit; cursor: pointer; font-size: 12px; display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.hsp-nav-row:hover { background: color-mix(in oklab, currentColor 8%, transparent); }
.hsp-nav-active { border-color: color-mix(in oklab, currentColor 30%, transparent); background: color-mix(in oklab, currentColor 8%, transparent); }
.hsp-nav-text { display: flex; gap: 6px; align-items: baseline; min-width: 0; overflow: hidden; }
.hsp-nav-idx { opacity: 0.5; font-size: 10.5px; flex: none; }
.hsp-nav-text span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hsp-scenearea { min-width: 0; display: flex; flex-direction: column; gap: 6px; min-height: 0; }
.hsp-scenehead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hsp-scenehead-title { font-weight: 650; font-size: 13px; }
.hsp-reading { border: 1px solid color-mix(in oklab, currentColor 12%, transparent); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.hsp-scene-title { font-weight: 650; font-size: 12px; opacity: 0.85; border-bottom: 1px solid color-mix(in oklab, currentColor 15%, transparent); padding-bottom: 6px; }
.hsp-scene { display: flex; flex-direction: column; gap: 7px; font-family: 'Courier New', ui-monospace, monospace; font-size: 12.5px; line-height: 1.45; }
.hsp-full { flex: 1; min-height: 0; overflow-y: auto; border: 1px solid color-mix(in oklab, currentColor 12%, transparent); border-radius: 10px; padding: 6px 14px; display: flex; flex-direction: column; }
.hsp-full-scene { display: flex; flex-direction: column; gap: 7px; font-family: 'Courier New', ui-monospace, monospace; font-size: 12.5px; line-height: 1.45; padding: 12px 0; border-bottom: 1px solid color-mix(in oklab, currentColor 10%, transparent); }
.hsp-full-scene:last-of-type { border-bottom: none; }
.hsp-full-heading { display: flex; align-items: baseline; gap: 7px; font-weight: 700; font-size: 12.5px; opacity: 0.95; }
.hsp-full-idx { opacity: 0.45; font-size: 11px; flex: none; }
.hsp-full-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hsp-full-hint { padding: 10px 2px 4px; }
.f-scene { font-weight: 700; margin-top: 4px; }
.f-char { text-align: center; font-weight: 600; margin-top: 3px; }
.f-paren { text-align: center; font-style: italic; padding: 0 26%; opacity: 0.9; }
.f-dialogue { text-align: center; padding: 0 14%; }
.f-trans { text-align: right; font-weight: 600; }
.hsp-raw { white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; margin: 0; opacity: 0.9; }
.hsp-editor { display: flex; flex-direction: column; gap: 8px; }
.hsp-textarea { width: 100%; box-sizing: border-box; min-height: 260px; resize: vertical; background: transparent; color: inherit; border: 1px solid color-mix(in oklab, currentColor 22%, transparent); border-radius: 8px; padding: 8px; font-family: 'Courier New', ui-monospace, monospace; font-size: 12.5px; line-height: 1.5; }
.hsp-textarea-small { min-height: 72px; font-family: inherit; }
.hsp-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hsp-btn { appearance: none; border: 1px solid color-mix(in oklab, currentColor 25%, transparent); background: transparent; color: inherit; border-radius: 7px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; text-decoration: none; display: inline-block; }
.hsp-btn:hover { background: color-mix(in oklab, currentColor 8%, transparent); }
.hsp-btn:disabled { opacity: 0.45; cursor: default; }
.hsp-btn-primary { background: color-mix(in oklab, currentColor 14%, transparent); color: inherit; border-color: currentColor; font-weight: 600; }
.hsp-btn-primary:hover { background: color-mix(in oklab, currentColor 20%, transparent); }
.hsp-btn-danger { border-color: color-mix(in oklab, #ff7676 55%, transparent); color: #ff9c9c; }
.hsp-btn-ghost { border-color: transparent; opacity: 0.7; }
.hsp-btn-small { padding: 3px 9px; font-size: 11.5px; }
.hsp-hint { opacity: 0.55; font-size: 11px; }
.hsp-proposals { display: flex; flex-direction: column; gap: 8px; }
.hsp-proposal-detail { border-top: 1px solid color-mix(in oklab, currentColor 15%, transparent); padding-top: 8px; display: flex; flex-direction: column; gap: 10px; }
.hsp-proposal-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hsp-changes { display: flex; flex-direction: column; gap: 10px; }
.hsp-change { border: 1px solid color-mix(in oklab, currentColor 12%, transparent); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.hsp-change-head { display: flex; align-items: center; gap: 8px; }
.hsp-change-heading { font-weight: 650; font-size: 12.5px; }
.hsp-diff { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.hsp-diff-col { min-width: 0; }
.hsp-diff-label { font-size: 10.5px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3px; }
.hsp-pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: 'Courier New', ui-monospace, monospace; font-size: 11.5px; line-height: 1.5; background: color-mix(in oklab, currentColor 6%, transparent); border-radius: 7px; padding: 7px; max-height: 260px; overflow-y: auto; }
.hsp-checks { display: flex; flex-direction: column; gap: 5px; }
.hsp-check { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hsp-check-name { font-size: 12px; font-weight: 550; }
.hsp-rules { display: flex; flex-direction: column; gap: 10px; }
.hsp-field { display: flex; flex-direction: column; gap: 4px; }
.hsp-label { font-size: 11.5px; opacity: 0.75; }
.hsp-input { background: transparent; color: inherit; border: 1px solid color-mix(in oklab, currentColor 22%, transparent); border-radius: 7px; padding: 5px 8px; font-size: 12.5px; }
.hsp-input-num { width: 72px; flex: none; }
.hsp-proto-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px; border-radius: 6px; background: color-mix(in oklab, currentColor 6%, transparent); }
.hsp-proto-add { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.hsp-proto-add .hsp-select { flex: 1; min-width: 120px; }
.hsp-history { display: flex; flex-direction: column; gap: 8px; }
.hsp-hist-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border: 1px solid color-mix(in oklab, currentColor 12%, transparent); border-radius: 8px; }
.hsp-export { display: flex; flex-direction: column; gap: 10px; }
.hsp-export-result { display: flex; flex-direction: column; gap: 8px; }
.hsp-pdf-wrap { display: flex; flex-direction: column; gap: 8px; }
.hsp-pdf { width: 100%; height: 460px; border: 1px solid color-mix(in oklab, currentColor 20%, transparent); border-radius: 8px; background: #fff; }
.hsp-guard { position: fixed; inset: 0; background: color-mix(in oklab, #000 45%, transparent); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.hsp-guard-box { background: color-mix(in oklab, currentColor 8%, transparent); color: inherit; border: 1px solid color-mix(in oklab, currentColor 25%, transparent); border-radius: 12px; padding: 16px; width: min(420px, 80vw); display: flex; flex-direction: column; gap: 10px; }
.hsp-guard-title { font-weight: 700; font-size: 14px; }
.hsp-guard-text { font-size: 12.5px; opacity: 0.85; line-height: 1.45; }
.hsp-guard-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.hsp-notice { animation: hsp-notice-in 0.35s ease backwards; }
@keyframes hsp-notice-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.hsp-notice-leave { opacity: 0; transform: translateY(-4px); transition: opacity 0.35s ease, transform 0.35s ease; }
.hsp-dd { position: relative; width: 100%; }
.hsp-dd-toggle { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border-radius: 8px; border: 1px solid color-mix(in oklab, currentColor 25%, transparent); background: color-mix(in oklab, currentColor 6%, transparent); color: inherit; font-size: 13px; cursor: pointer; text-align: left; appearance: none; }
.hsp-dd-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hsp-dd-caret { opacity: 0.55; font-size: 11px; flex: none; }
.hsp-dd-list { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 50; max-height: 280px; overflow-y: auto; background: color-mix(in oklab, currentColor 14%, transparent); color: inherit; border: 1px solid color-mix(in oklab, currentColor 24%, transparent); border-radius: 10px; padding: 4px; display: flex; flex-direction: column; gap: 2px; box-shadow: 0 10px 28px rgba(0,0,0,0.30); }
.hsp-dd-item { appearance: none; border: 1px solid transparent; background: transparent; color: inherit; text-align: left; padding: 6px 10px; border-radius: 7px; cursor: pointer; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hsp-dd-item:hover { background: color-mix(in oklab, currentColor 10%, transparent); }
.hsp-dd-item-active { background: color-mix(in oklab, currentColor 18%, transparent); color: inherit; font-weight: 600; }
/* ---- View settings: font + size + light "paper" theme ----
   --gw-font / --gw-size are set inline on .hsp-pane (see effectiveFont/SIZES).
   The reading surface (paper) switches between the host's dark surface and a
   warm-white light theme; the chrome (header, tabs, scene head) keeps the
   host theme. All of this is plain CSS — no dependencies. */
.hsp-full-scene { font-family: var(--gw-font, 'Courier New', ui-monospace, monospace); font-size: var(--gw-size, 13px); }
.hsp-full-heading { font-size: var(--gw-size, 13px); }
.hsp-viewbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hsp-viewbar-label { opacity: 0.6; font-size: 11.5px; }
.hsp-viewbar-sep { opacity: 0.3; font-size: 11px; }
/* search / find & replace bar */
.hsp-searchbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.hsp-searchbar-ico { opacity: 0.6; font-size: 13px; }
.hsp-searchbar-input { flex: 1 1 120px; min-width: 96px; padding: 4px 8px; border-radius: 7px; border: 1px solid color-mix(in oklab, currentColor 30%, transparent); background: color-mix(in oklab, currentColor 6%, transparent); color: inherit; font-size: 12.5px; }
.hsp-searchbar-input::placeholder { color: color-mix(in oklab, currentColor 45%, transparent); }
.hsp-searchbar-count { opacity: 0.6; font-size: 11.5px; white-space: nowrap; }
/* search highlights: yellow background, blue font; the current hit is stronger. */
.hsp-mark { background: #ffe873; color: #1a3fbf; border-radius: 2px; padding: 0 1px; }
.hsp-mark-current { background: #ffcf33; color: #102a9e; box-shadow: 0 0 0 1px #ffcf33; }
.hsp-vbsel { width: auto; min-width: 74px; padding: 3px 7px; font-size: 11.5px; background: transparent; color: inherit; }
.hsp-iconbtn { padding: 3px 9px; font-size: 14px; line-height: 1; }
/* ---- side-by-side chat rail (feature #3) ----
   The manuscript and the chat share the Script tab: a two-column grid where the
   text stays on the left and a compact, plugin-owned chat docks on the right —
   read and talk at once, no separate window. Colors follow the host theme via
   currentColor/color-mix, so it works in both dark and light host themes. */
.hsp-btn-on { border-color: currentColor; background: color-mix(in oklab, currentColor 16%, transparent); }
.hsp-split { display: flex; flex-direction: row; align-items: stretch; flex: 1; min-height: 0; }
.hsp-split-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.gw-resize-handle { flex: none; width: 12px; margin: 0 2px; cursor: col-resize; display: flex; align-items: center; justify-content: center; touch-action: none; }
.gw-resize-handle::before { content: ''; width: 3px; height: 44px; border-radius: 3px; background: color-mix(in oklab, currentColor 16%, transparent); transition: background .15s ease, height .15s ease; }
.gw-resize-handle:hover::before, .gw-resize-handle.gw-resize-active::before { background: color-mix(in oklab, currentColor 42%, transparent); height: 64px; }
.gw-chat-col { flex: none; min-width: 260px; min-height: 0; display: flex; flex-direction: column; }
.gw-rail { display: flex; flex-direction: column; flex: 1; min-height: 0; border: 1px solid color-mix(in oklab, currentColor 16%, transparent); border-radius: 12px; background: color-mix(in oklab, currentColor 4%, transparent); overflow: hidden; }
.gw-rail-head { display: flex; align-items: center; gap: 6px; padding: 7px 8px; border-bottom: 1px solid color-mix(in oklab, currentColor 14%, transparent); flex: none; }
.gw-tabs { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; overflow-x: auto; padding-right: 2px; }
.gw-tab { display: flex; align-items: center; gap: 5px; max-width: 160px; padding: 4px 6px 4px 10px; border-radius: 8px; font-size: 12px; cursor: pointer; border: 1px solid transparent; white-space: nowrap; transition: background .12s ease, border-color .12s ease; }
.gw-tab:hover { background: color-mix(in oklab, currentColor 8%, transparent); }
.gw-tab-active { border-color: color-mix(in oklab, currentColor 30%, transparent); background: color-mix(in oklab, currentColor 11%, transparent); font-weight: 600; }
.gw-tab-title { overflow: hidden; text-overflow: ellipsis; }
.gw-tab-x { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; opacity: 0.5; border-radius: 4px; flex: none; }
.gw-tab-x:hover { opacity: 1; background: color-mix(in oklab, currentColor 18%, transparent); }
.gw-add-wrap { position: relative; flex: none; }
.gw-add-btn { border: 1px solid color-mix(in oklab, currentColor 22%, transparent); background: color-mix(in oklab, currentColor 6%, transparent); color: inherit; cursor: pointer; font-size: 13px; line-height: 1; padding: 3px 9px; border-radius: 8px; }
.gw-add-btn:hover { background: color-mix(in oklab, currentColor 12%, transparent); }
.gw-add-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 40; min-width: 200px; max-width: 280px; max-height: 300px; overflow-y: auto; padding: 5px; border-radius: 10px; border: 1px solid var(--border, color-mix(in oklab, currentColor 26%, transparent)); background: var(--card, #1c1c20); box-shadow: 0 12px 34px rgba(0,0,0,0.38); }
.gw-add-item { display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; border: none; background: transparent; color: var(--foreground, #e6e6e6); cursor: pointer; font-size: 12.5px; padding: 7px 9px; border-radius: 7px; }
.gw-add-item:hover { background: color-mix(in oklab, currentColor 12%, transparent); }
.gw-add-item-primary { font-weight: 600; }
.gw-add-sep { height: 1px; margin: 5px 4px; background: color-mix(in oklab, currentColor 16%, transparent); }
.gw-add-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; opacity: 0.8; }
.gw-add-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-close-btn { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; padding: 4px 7px; border-radius: 7px; flex: none; opacity: 0.7; }
.gw-close-btn:hover { opacity: 1; background: color-mix(in oklab, currentColor 12%, transparent); }
.gw-chat-list { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.gw-chat-empty { opacity: 0.6; font-size: 12px; line-height: 1.5; }
.gw-msg { display: flex; flex-direction: column; gap: 2px; max-width: 100%; }
.gw-msg-user { align-items: flex-end; }
.gw-msg-asst { align-items: flex-start; }
.gw-msg-text { white-space: pre-wrap; word-break: break-word; font-size: 12.5px; line-height: 1.5; padding: 6px 9px; border-radius: 8px; max-width: 100%; }
.gw-msg-user .gw-msg-text { background: color-mix(in oklab, currentColor 12%, transparent); }
.gw-msg-asst .gw-msg-text { background: transparent; opacity: 0.92; }
.gw-chat-err { margin: 0 10px 8px; }
.gw-chat-input { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid color-mix(in oklab, currentColor 14%, transparent); align-items: flex-end; }
.gw-chat-field { flex: 1; resize: none; background: transparent; color: inherit; border: 1px solid color-mix(in oklab, currentColor 22%, transparent); border-radius: 8px; padding: 6px 8px; font-size: 12.5px; line-height: 1.4; font-family: inherit; }
.gw-chat-field::placeholder { color: color-mix(in oklab, currentColor 45%, transparent); }
.gw-chat-send { flex: none; padding: 6px 12px; }

/* ================= UI Revamp — design system =================
   Fonts: the manuscript is Courier Prime (self-hosted, the standard screenplay
   face); the chrome (--gw-ui) is 'inherit', so it uses the host theme's default
   font. The manuscript sits on a centred "paper" page whose tone is --gw-paper
   (pale blue by default). The chrome follows the host theme via currentColor /
   color-mix, so it stays correct in both light and dark hosts. */

/* --- app shell --- */
.hsp-pane { padding: 0; gap: 0; font-family: var(--gw-ui, ui-monospace, monospace); }
.hsp-notice { margin: 8px 16px 0; }
.hsp-import { margin: 12px 16px; }
.hsp-error, .hsp-empty, .hsp-muted { padding: 16px; }
.hsp-tabbody { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }

/* --- topbar (identity row) --- */
.hsp-topbar { display: flex; align-items: center; gap: 12px; height: 52px; flex: none; padding: 0 16px; border-bottom: 1px solid color-mix(in oklab, currentColor 12%, transparent); }
.hsp-topbar-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.hsp-brand { font-weight: 700; font-size: 12.5px; letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.92; flex: none; }
.hsp-topbar-sep { opacity: 0.28; font-size: 13px; flex: none; }
.hsp-topbar-left .hsp-dd { width: auto; min-width: 140px; max-width: 300px; }
.hsp-topbar-left .hsp-dd-toggle { padding: 5px 11px; font-size: 13px; border-radius: 8px; font-family: var(--gw-ui, ui-monospace, monospace); }
.hsp-format-chip { font-size: 9.5px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; padding: 3px 9px; border-radius: 20px; background: color-mix(in oklab, currentColor 12%, transparent); opacity: 0.8; flex: none; }
.hsp-viewtabs { display: flex; align-items: center; gap: 2px; margin-left: 6px; padding: 3px; border-radius: 10px; background: color-mix(in oklab, currentColor 6%, transparent); flex: none; }
.hsp-vtab { appearance: none; border: none; background: transparent; color: inherit; opacity: 0.6; padding: 4px 12px; font-size: 12px; font-family: var(--gw-ui, ui-monospace, monospace); cursor: pointer; border-radius: 7px; display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.hsp-vtab:hover { opacity: 0.9; }
.hsp-vtab-active { opacity: 1; font-weight: 600; background: color-mix(in oklab, currentColor 15%, transparent); }
.hsp-topbar-right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }
.hsp-status { font-size: 10.5px; opacity: 0.45; white-space: nowrap; }

/* --- workspace (outline | stage) --- */
.gw-workspace { display: flex; flex-direction: row; align-items: stretch; flex: 1; min-height: 0; }
.gw-outline { flex: none; width: 244px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid color-mix(in oklab, currentColor 10%, transparent); background: color-mix(in oklab, currentColor 3%, transparent); }
.gw-outline-hidden .gw-outline { display: none; }
.gw-outline-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; flex: none; }
.gw-outline-title { font-size: 10.5px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.55; }
.gw-outline-count { font-size: 10.5px; opacity: 0.5; background: color-mix(in oklab, currentColor 10%, transparent); border-radius: 10px; padding: 0 7px; }
.gw-outline-head .gw-iconbtn { margin-left: auto; }
.gw-outline-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 12px; display: flex; flex-direction: column; gap: 2px; }
.gw-outline-row { appearance: none; text-align: left; background: transparent; border: 1px solid transparent; border-radius: 7px; padding: 6px 9px; color: inherit; cursor: pointer; font-size: 12px; font-family: var(--gw-ui, ui-monospace, monospace); display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.gw-outline-row:hover { background: color-mix(in oklab, currentColor 7%, transparent); }
.gw-outline-active { border-color: color-mix(in oklab, currentColor 28%, transparent); background: color-mix(in oklab, currentColor 9%, transparent); }
.gw-outline-text { display: flex; gap: 8px; align-items: baseline; min-width: 0; overflow: hidden; }
.gw-outline-text span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hsp-nav-idx { opacity: 0.5; font-size: 10.5px; flex: none; }

/* --- stage (manuscript column) --- */
.gw-stage { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 16px 20px; position: relative; }
.gw-slate, .hsp-viewbar, .hsp-searchbar, .hsp-editor { width: 100%; max-width: 610px; }
.gw-slate { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: none; }
.gw-slate-title { font-weight: 650; font-size: 13px; font-family: var(--gw-ui, ui-monospace, monospace); }
.gw-outline-show { position: absolute; top: 18px; left: 6px; z-index: 5; }

/* --- the paper (centred manuscript page) --- */
.hsp-full { flex: 1; min-height: 0; width: 100%; max-width: 720px; overflow-y: auto; background: var(--gw-paper, #dbe3f4); color: #1b1e28; border-radius: 3px; box-shadow: 0 2px 16px rgba(0,0,0,0.22); padding: 30px 54px; box-sizing: border-box; border: none; }
.hsp-full-scene { font-family: var(--gw-font, 'Courier Prime', monospace); font-size: var(--gw-size, 13px); line-height: 1.55; padding: 12px 0; border-bottom: 1px solid color-mix(in oklab, #1b1e28 9%, transparent); }
.hsp-full-scene:last-of-type { border-bottom: none; }
.hsp-full-heading { display: flex; align-items: baseline; gap: 8px; font-family: var(--gw-font, 'Courier Prime', monospace); font-weight: 700; font-size: calc(var(--gw-size, 13px) + 0.5px); margin-bottom: 6px; color: #14171f; text-transform: uppercase; letter-spacing: 0.01em; }
.hsp-full-idx { opacity: 0.45; font-size: 0.85em; flex: none; }
.hsp-full-hint { font-family: var(--gw-ui, ui-monospace, monospace); font-size: 11px; opacity: 0.55; text-align: center; padding: 18px 0 6px; }

/* --- Fountain (screenplay) typography on the paper --- */
.f-scene { font-weight: 700; margin-top: 2px; }
.f-char { text-align: center; font-weight: 600; margin-top: 10px; }
.f-paren { text-align: center; font-style: italic; padding: 0 22%; opacity: 0.82; }
.f-dialogue { text-align: center; padding: 0 12%; }
.f-trans { text-align: right; font-weight: 600; margin-top: 10px; }
.hsp-raw { font-family: var(--gw-font, 'Courier Prime', monospace); color: #1b1e28; }

/* --- editor (write on the page) --- */
.hsp-editor { display: flex; flex-direction: column; gap: 8px; }
.hsp-textarea { width: 100%; box-sizing: border-box; min-height: 320px; resize: vertical; background: var(--gw-paper, #dbe3f4); color: #1b1e28; border: 1px solid color-mix(in oklab, #1b1e28 16%, transparent); border-radius: 3px; padding: 28px 52px; font-family: var(--gw-font, 'Courier Prime', monospace); font-size: var(--gw-size, 13px); line-height: 1.55; }

/* --- viewbar + searchbar (chrome above the paper) --- */
.hsp-viewbar { justify-content: center; }
.hsp-searchbar { justify-content: center; }

/* --- focus mode: hide chrome, let the page breathe --- */
.hsp-pane-focus .hsp-topbar { opacity: 0; transition: opacity .18s ease; }
.hsp-pane-focus .hsp-topbar:hover { opacity: 1; }
.hsp-pane-focus .gw-outline { display: none; }
.hsp-pane-focus .hsp-viewbar, .hsp-pane-focus .hsp-searchbar, .hsp-pane-focus .gw-slate, .hsp-pane-focus .gw-outline-show { display: none; }
.hsp-pane-focus .gw-stage { padding: 32px 0 40px; }
/* Companion pages: side margins + a readable max-width so they don't hug the sidebars. */
.hsp-proposals, .hsp-rules, .hsp-history, .hsp-export { width: 100%; max-width: 880px; margin: 0 auto; box-sizing: border-box; padding: 18px 32px 28px; }
/* Paper tone: a single round swatch filled with the current paper color; click to cycle. */
.gw-tone { appearance: none; width: 26px; height: 26px; border-radius: 50%; padding: 3px; border: 1px solid color-mix(in oklab, currentColor 30%, transparent); background: transparent; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.gw-tone:hover { border-color: color-mix(in oklab, currentColor 50%, transparent); }
.gw-tone-dot { width: 100%; height: 100%; border-radius: 50%; box-shadow: inset 0 0 0 1px color-mix(in oklab, currentColor 22%, transparent); }
/* Font-size slider (replaces the S/M/L/XL dropdown). */
.hsp-size-range { appearance: none; width: 92px; height: 4px; border-radius: 2px; background: color-mix(in oklab, currentColor 25%, transparent); cursor: pointer; }
.hsp-size-range::-webkit-slider-thumb { appearance: none; width: 13px; height: 13px; border-radius: 50%; background: currentColor; border: none; }
.hsp-size-range::-moz-range-thumb { width: 13px; height: 13px; border-radius: 50%; background: currentColor; border: none; }
.hsp-size-val { min-width: 34px; text-align: right; }
/* Word + scene counter at the bottom of the paper stage. */
.gw-statusbar { display: flex; align-items: center; gap: 8px; flex: none; font-size: 11px; opacity: 0.6; padding-top: 2px; }
.gw-statusbar-sep { opacity: 0.5; }
/* Whole-document editor: the textarea fills the stage like the paper does. */
.hsp-editor-doc { flex: 1; min-height: 0; width: 100%; max-width: 720px; }
.hsp-textarea-doc { flex: 1; min-height: 0; }
.hsp-pane-focus .hsp-full { max-width: 960px; box-shadow: none; }

/* ================= Theme-aware chrome + manuscript palette ================
   The chrome inherits the host theme: the pane sits on the app's editor
   background (no forced background) and every element is driven by
   currentColor / color-mix, so the whole UI reskins with whatever theme the
   host is running (light or dark) - nothing is forced to a fixed brand colour.
   Only the manuscript keeps its own palette: --gw-ink (the ink) on --gw-paper
   (the toned page, set inline by the tone switcher). */
.hsp-pane { --gw-ink: #13243B; }
button:focus-visible, .hsp-input:focus, .hsp-select:focus, .hsp-textarea:focus, .hsp-searchbar-input:focus, .hsp-vbsel:focus { outline: 2px solid color-mix(in oklab, currentColor 50%, transparent); outline-offset: 1px; }
/* manuscript ink on the toned paper */
.hsp-full { color: var(--gw-ink); }
.hsp-full-scene { border-bottom-color: color-mix(in oklab, var(--gw-ink) 10%, transparent); }
.hsp-full-heading { color: var(--gw-ink); }
.hsp-raw { color: var(--gw-ink); }
.hsp-textarea { background: var(--gw-paper, #DCEBF0); color: var(--gw-ink); border-color: color-mix(in oklab, var(--gw-ink) 18%, transparent); }
/* Standard title page: its own FIRST page (full page tall) - title in the upper
   third, credit/author in the middle, contact bottom-left, with a page-edge at
   the bottom so the body clearly starts on the next page. */
.hsp-titlepage { text-align: center; }
.hsp-full .hsp-titlepage { display: flex; flex-direction: column; min-height: 100%; border-bottom: 1px solid color-mix(in oklab, var(--gw-ink) 16%, transparent); box-shadow: 0 8px 22px -10px rgba(0,0,0,0.42); margin-bottom: 12px; }
.hsp-titlepage-spacer { flex: 3 1 0; min-height: 16px; }
.hsp-titlepage-grow { flex: 5 1 0; min-height: 16px; }
.hsp-titlepage-title { font-family: var(--gw-font, 'Courier Prime', monospace); font-size: 1.9em; line-height: 1.2; letter-spacing: 0.06em; font-weight: 700; color: var(--gw-ink); }
.hsp-titlepage-credit { margin-top: 18px; display: flex; flex-direction: column; gap: 6px; align-items: center; }
.hsp-titlepage-line { font-family: var(--gw-font, 'Courier Prime', monospace); font-size: 1.1em; color: var(--gw-ink); }
.hsp-titlepage-contact { align-self: flex-start; text-align: left; padding-bottom: 8px; }
.hsp-titlepage-contact-line { font-family: var(--gw-font, 'Courier Prime', monospace); font-size: 1em; line-height: 1.5; color: var(--gw-ink); }
/* Formatted editor: per-element fields that reuse the read-view .f-* classes so
   the standard screenplay format stays visible while editing. */
.hsp-editor-doc .hsp-editor-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.hsp-edit-scene { font-family: var(--gw-font, 'Courier Prime', monospace); font-size: var(--gw-size, 13px); line-height: 1.55; color: var(--gw-ink); margin-bottom: 6px; }
.hsp-edit-el { display: block; width: 100%; box-sizing: border-box; background: transparent; border: none; border-radius: 3px; padding: 1px 4px; margin: 0; color: var(--gw-ink); font-family: inherit; font-size: inherit; line-height: inherit; resize: none; overflow: hidden; white-space: pre-wrap; }
.hsp-edit-el:focus { outline: 2px solid color-mix(in oklab, currentColor 45%, transparent); outline-offset: 1px; background: color-mix(in oklab, currentColor 6%, transparent); }
/* Editable title-page fields (in the formatted editor). */
.hsp-titlepage-edit { padding: 22px 8px; }
.hsp-titlepage-contact-edit { max-width: 440px; margin: 16px auto 4px; display: flex; flex-direction: column; gap: 9px; }
.hsp-titlepage-contact-edit .hsp-titlepage-input { text-align: left; }
.hsp-titlepage-contact-label { font-family: 'Courier New', ui-monospace, monospace; font-size: 0.82em; color: color-mix(in oklab, var(--gw-ink) 55%, transparent); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
.hsp-titlepage-input { display: block; width: 100%; max-width: 440px; margin: 0 auto 9px; background: transparent; border: 1px dashed color-mix(in oklab, var(--gw-ink) 30%, transparent); border-radius: 4px; padding: 4px 8px; color: var(--gw-ink); font-family: 'Courier New', ui-monospace, monospace; font-size: 1em; text-align: center; }
.hsp-titlepage-input-title { font-size: 1.6em; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; margin-bottom: 16px; }
.hsp-titlepage-input::placeholder { color: color-mix(in oklab, var(--gw-ink) 45%, transparent); }
.hsp-titlepage-input:focus { outline: 2px solid color-mix(in oklab, currentColor 45%, transparent); outline-offset: 1px; border-color: transparent; }
.hsp-titlepage-extra { display: flex; align-items: center; justify-content: center; gap: 8px; max-width: 440px; margin: 0 auto 9px; }
.hsp-titlepage-extra-key { font-family: 'Courier New', ui-monospace, monospace; font-size: 1em; color: color-mix(in oklab, var(--gw-ink) 70%, transparent); white-space: nowrap; }
.hsp-titlepage-extra .hsp-titlepage-input { margin: 0; width: 100%; max-width: none; text-align: left; }
`

// ---------- Ghostwriter chat (project-scoped, multi-tab, resizable) ----------
// Each chat tab is bound to a project: its own Hermes session (adopted by a
// per-tab title "Ghostwriter · <Project>", or "… · 2" for a second tab on the
// same project), its own transcript, and a project-context block prepended to
// every prompt so the model always knows which project_id to operate on with
// the ghost_* tools. Open as many tabs as you like — different projects, or
// several chats on the same project — each streams independently.

const GHOSTWRITER_TITLE = 'Ghostwriter'
const CHAT_TABS_KEY = 'gw.chatTabs.v2'
const CHAT_WIDTH_KEY = 'gw.chatWidth.v1'

function newTabId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}
function nextNumForProject(tabs, projectId) {
  const nums = tabs.filter((t) => t.projectId === projectId).map((t) => t.num || 1)
  return (nums.length ? Math.max.apply(null, nums) : 0) + 1
}
function sessionTitleForTab(tab) {
  const base = GHOSTWRITER_TITLE + ' · ' + (tab.title || 'Untitled')
  return (tab.num && tab.num > 1) ? base + ' · ' + tab.num : base
}
async function getSessionByTitle(title) {
  try {
    const list = await host.request('session.list', { title, limit: 200, include_hidden: true })
    const sessions = (list && list.sessions) || []
    const existing = sessions.find((s) => (s.root_title || s.title || '') === title)
    if (existing) return existing
  } catch (_) {}
  return host.request('session.create', { title })
}

function projectContextBlock(project) {
  const scenes = (project && Array.isArray(project.scenes)) ? project.scenes : []
  const lines = scenes.map((s, i) =>
    '  ' + (i + 1) + '. ' + (s.heading || '(untitled)') + ' [scene id: ' + (s.id || '') + ']')
  return [
    '[Ghostwriter context — you are working on the screenplay project below. Use the ghost_* tools with this project_id and stay on this project.]',
    'Project id: ' + (project.id || ''),
    'Project title: ' + (project.title || ''),
    'Current scenes (' + scenes.length + '):',
    lines.length ? lines.join('\n') : '  (none yet)',
    '[/Ghostwriter context]',
  ].join('\n')
}
function stripProjectContext(text) {
  if (typeof text !== 'string') return text
  const marker = '[/Ghostwriter context]'
  const end = text.indexOf(marker)
  if (end === -1) return text
  return text.slice(end + marker.length).replace(/^\s+/, '')
}

function loadChatTabs(projects, currentPid) {
  let stored = []
  try {
    const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(CHAT_TABS_KEY)
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) stored = a }
  } catch (_) {}
  const list = Array.isArray(projects) ? projects : []
  const tabs = []
  stored.forEach((s) => {
    if (!s || typeof s !== 'object') return
    const p = list.find((x) => x.id === s.projectId)
    if (!p) return
    tabs.push({ id: (s.id && typeof s.id === 'string') ? s.id : newTabId(), projectId: s.projectId, num: s.num || 1, title: p.title || '' })
  })
  if (currentPid && !tabs.some((t) => t.projectId === currentPid)) {
    const cur = list.find((p) => p.id === currentPid)
    tabs.unshift({ id: newTabId(), projectId: currentPid, num: 1, title: cur ? cur.title : '' })
  }
  if (!tabs.length && currentPid) tabs.push({ id: newTabId(), projectId: currentPid, num: 1, title: '' })
  return tabs
}
function saveChatTabs(tabs) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CHAT_TABS_KEY, JSON.stringify(tabs.map((t) => ({ id: t.id, projectId: t.projectId, num: t.num }))))
    }
  } catch (_) {}
}

function loadChatWidth() {
  try {
    const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(CHAT_WIDTH_KEY)
    const n = raw ? parseInt(raw, 10) : NaN
    if (n >= 280 && n <= 1200) return n
  } catch (_) {}
  return 380
}
function saveChatWidth(w) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(CHAT_WIDTH_KEY, String(w)) } catch (_) {}
}

function GwChat({ project, sessionTitle }) {
  const [sid, setSid] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streamText, setStreamText] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const listRef = useRef(null)
  const streamRef = useRef('')
  const turnActive = useRef(false)

  useEffect(() => {
    let alive = true
    setSid(null); setMessages([]); setError(null)
    ;(async () => {
      try {
        const s = await getSessionByTitle(sessionTitle)
        if (!alive || !s) return
        const id = s.resolved_id || s.stored_session_id || s.id || s.session_id
        if (!alive || !id) return
        setSid(id)
        const h = await host.request('session.history', { session_id: id })
        if (!alive) return
        const msgs = (h && Array.isArray(h.messages))
          ? h.messages.map((m) => ({ role: m.role, text: m.text || '' }))
            .map((m) => ({ role: m.role, text: (m.role === 'user') ? stripProjectContext(m.text) : m.text }))
            .filter((m) => m.text)
          : []
        setMessages(msgs)
      } catch (e) {
        if (alive) setError('Chat unavailable: ' + errInfo(e).text)
      }
    })()
    return () => { alive = false }
  }, [sessionTitle])

  useEffect(() => {
    if (!sid) return
    const onStart = (ev) => {
      if (ev.session_id !== sid) return
      turnActive.current = true
      streamRef.current = ''
      setStreamText(''); setStreaming(true); setWaiting(false); setError(null)
    }
    const onDelta = (ev) => {
      if (ev.session_id !== sid || !turnActive.current) return
      const t = ev.payload && typeof ev.payload.text === 'string' ? ev.payload.text : ''
      if (t) { streamRef.current += t; setStreamText(streamRef.current) }
    }
    const onDone = (ev) => {
      if (ev.session_id !== sid) return
      const p = ev.payload || {}
      turnActive.current = false
      const finalText = (typeof p.text === 'string' && p.text) ? p.text : streamRef.current
      streamRef.current = ''
      setStreamText(''); setStreaming(false); setWaiting(false); setBusy(false)
      if (finalText.trim()) setMessages((m) => [...m, { role: 'assistant', text: finalText }])
      if (p.error) setError(String(p.error))
      else if (p.status === 'interrupted') setError('Reply was interrupted.')
    }
    const d1 = host.onEvent('message.start', onStart)
    const d2 = host.onEvent('message.delta', onDelta)
    const d3 = host.onEvent('message.complete', onDone)
    return () => { if (d1) d1(); if (d2) d2(); if (d3) d3() }
  }, [sid])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streamText, streaming, waiting])

  async function send() {
    const text = input.trim()
    if (!text || !sid || busy) return
    setBusy(true); setWaiting(true); setInput(''); setError(null)
    setMessages((m) => [...m, { role: 'user', text }])
    try {
      await host.request('prompt.submit', { session_id: sid, text: projectContextBlock(project) + '\n' + text })
    } catch (e) {
      setBusy(false); setWaiting(false); setStreaming(false)
      setError('Send failed: ' + errInfo(e).text)
    }
  }

  const live = waiting || streaming || streamText
  const empty = messages.length === 0 && !live
  return jsxs('div', { className: 'gw-chat', children: [
    jsx('div', { className: 'gw-chat-list', ref: listRef, children:
      empty
        ? jsx('div', { className: 'gw-chat-empty', children: 'Say something — e.g. “write a cold open for scene 1” or “tighten the dialogue in the café scene.”' })
        : messages.map((m, i) => jsx('div', {
            className: 'gw-msg ' + (m.role === 'user' ? 'gw-msg-user' : 'gw-msg-asst'), key: i,
            children: jsx('div', { className: 'gw-msg-text', children: m.text })
          }))
    }),
    live && jsx('div', { className: 'gw-msg gw-msg-asst', children: jsx('div', {
      className: 'gw-msg-text', children: (streamText ? streamText + '▍' : 'Thinking…')
    }) }),
    error ? jsx('div', { className: 'hsp-notice hsp-notice-err gw-chat-err', children: error }) : null,
    jsxs('div', { className: 'gw-chat-input', children: [
      jsx('textarea', {
        className: 'gw-chat-field', value: input, rows: '2',
        placeholder: 'Message Ghostwriter… (Enter to send, Shift+Enter for a newline)',
        onChange: (e) => setInput(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }
      }),
      jsx('button', { className: 'hsp-btn hsp-btn-primary gw-chat-send', disabled: busy || !input.trim(), onClick: send, children: busy ? '…' : 'Send' })
    ] })
  ] })
}

function GwChatRail({ projects, currentPid, currentData, onClose }) {
  const [tabs, setTabs] = useState(() => loadChatTabs(projects, currentPid))
  const [activeKey, setActiveKey] = useState(() => {
    const t = loadChatTabs(projects, currentPid)
    return (t[0] && t[0].id) || null
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [projData, setProjData] = useState({})
  const prevPidRef = useRef(currentPid)
  const addWrapRef = useRef(null)

  useEffect(() => { saveChatTabs(tabs) }, [tabs])

  // Reconcile tabs with the live project list: drop tabs whose project is gone,
  // and make sure the current project always has a tab (the chat follows it).
  useEffect(() => {
    if (!Array.isArray(projects)) return
    setTabs((prev) => {
      const valid = prev.filter((t) => projects.some((p) => p.id === t.projectId))
      if (currentPid && !valid.some((t) => t.projectId === currentPid)) {
        const cur = projects.find((p) => p.id === currentPid)
        valid.push({ id: newTabId(), projectId: currentPid, num: 1, title: cur ? cur.title : '' })
      }
      const same = valid.length === prev.length && valid.every((t, i) => t.id === prev[i].id)
      return same ? prev : valid
    })
  }, [projects, currentPid])

  // Follow the main project switch: jump to that project's first tab.
  useEffect(() => {
    if (currentPid && currentPid !== prevPidRef.current) {
      const first = tabs.find((t) => t.projectId === currentPid)
      if (first) setActiveKey(first.id)
    }
    prevPidRef.current = currentPid
  }, [currentPid, tabs])

  // Keep activeKey pointing at a real tab.
  useEffect(() => {
    if (!tabs.length) { if (activeKey !== null) setActiveKey(null); return }
    if (!activeKey || !tabs.some((t) => t.id === activeKey)) setActiveKey(tabs[0].id)
  }, [tabs, activeKey])

  // Close the "＋" menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (ev) => {
      if (addWrapRef.current && !addWrapRef.current.contains(ev.target)) setMenuOpen(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [menuOpen])

  // Resolve each open tab's project data (current project uses live page data;
  // others are fetched once and cached) so every tab can anchor its prompts.
  // Background tabs keep this data while hidden so they stay fully functional.
  useEffect(() => {
    const needed = Array.from(new Set(tabs.map((t) => t.projectId)))
    needed.forEach((pid2) => {
      if (pid2 === currentPid) {
        if (currentData) {
          const scenes = (currentData.active_revision && Array.isArray(currentData.active_revision.scenes)) ? currentData.active_revision.scenes : []
          const title = (currentData.project && currentData.project.title) || ''
          setProjData((pd) => (pd[pid2] && pd[pid2].scenes === scenes && pd[pid2].title === title) ? pd : { ...pd, [pid2]: { id: pid2, title, scenes } })
        }
        return
      }
      if (projData[pid2]) return
      ;(async () => {
        try {
          const p = await api('/projects/' + encodeURIComponent(pid2))
          const scenes = (p && p.active_revision && Array.isArray(p.active_revision.scenes)) ? p.active_revision.scenes : []
          setProjData((pd) => ({ ...pd, [pid2]: { id: pid2, title: (p && p.title) || '', scenes } }))
        } catch (_) { /* leave unresolved; the tab renders once data lands */ }
      })()
    })
  }, [tabs, currentPid, currentData, projData])

  // Add a brand-new chat tab for a project (a 2nd+ tab on the same project).
  function newChatForProject(projectId) {
    const num = nextNumForProject(tabs, projectId)
    const title = ((projects.find((p) => p.id === projectId) || {}).title) || ''
    const tab = { id: newTabId(), projectId, num, title }
    setTabs((prev) => prev.some((t) => t.id === tab.id) ? prev : [...prev, tab])
    setActiveKey(tab.id)
    setMenuOpen(false)
  }
  // Open a chat for a project: activate an existing tab for it, else create one.
  function openProjectTab(projectId) {
    const existing = tabs.find((t) => t.projectId === projectId)
    if (existing) { setActiveKey(existing.id); setMenuOpen(false); return }
    newChatForProject(projectId)
  }
  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    setTabs(next)
    if (activeKey === id) {
      const fallback = next[idx] || next[idx - 1] || next[0] || null
      setActiveKey(fallback ? fallback.id : null)
    }
    if (next.length === 0) onClose()
  }

  const allProjects = Array.isArray(projects) ? projects : []
  const activeTab = tabs.find((t) => t.id === activeKey) || null
  const activeProjectId = activeTab ? activeTab.projectId : null

  return jsxs('div', { className: 'gw-rail', children: [
    jsxs('div', { className: 'gw-rail-head', children: [
      jsx('div', { className: 'gw-tabs', children: tabs.map((t) => jsxs('div', {
        className: 'gw-tab' + (t.id === activeKey ? ' gw-tab-active' : ''),
        key: t.id, onClick: () => setActiveKey(t.id), title: sessionTitleForTab(t),
        children: [
          jsx('span', { className: 'gw-tab-title', children: (t.title || 'Untitled') + (t.num > 1 ? ' · ' + t.num : '') }),
          jsx('button', {
            className: 'gw-tab-x', title: 'Close this chat',
            onClick: (e) => { e.stopPropagation(); closeTab(t.id) }, children: '×'
          }),
        ]
      })) }),
      jsxs('div', { className: 'gw-add-wrap', ref: addWrapRef, children: [
        jsx('button', { className: 'gw-add-btn', title: 'New chat',
          onClick: (e) => { e.stopPropagation(); setMenuOpen((v) => !v) }, children: '＋' }),
        menuOpen ? jsxs('div', { className: 'gw-add-menu', children: [
          activeTab ? jsx('button', { className: 'gw-add-item gw-add-item-primary',
            onClick: () => newChatForProject(activeTab.projectId),
            children: jsx('span', { className: 'gw-add-label', children: 'New chat · ' + (activeTab.title || 'Untitled') }) }) : null,
          (activeTab && allProjects.length) ? jsx('div', { className: 'gw-add-sep' }) : null,
          allProjects.map((p) => {
            const openCount = tabs.filter((t) => t.projectId === p.id).length
            return jsx('button', { className: 'gw-add-item', key: p.id,
              onClick: () => openProjectTab(p.id),
              children: [
                (p.id === activeProjectId) ? jsx('span', { className: 'gw-add-dot' }) : null,
                jsx('span', { className: 'gw-add-label', children: (p.title || 'Untitled') + (openCount > 1 ? '  (' + openCount + ')' : '') })
              ] })
          })
        ] }) : null,
      ] }),
      jsx('button', { className: 'gw-close-btn', title: 'Close chat', onClick: onClose, children: '✕' }),
    ] }),
    // Every tab's chat stays mounted (hidden when not active) so a background
    // chat keeps streaming while you work in another.
    tabs.map((t) => {
      const pd = projData[t.projectId]
      if (!pd) return null
      return jsx('div', {
        key: t.id,
        style: { display: (t.id === activeKey) ? 'flex' : 'none', flexDirection: 'column', flex: '1 1 0%', minHeight: 0 },
        children: jsx(GwChat, { project: pd, sessionTitle: sessionTitleForTab(t) })
      })
    }),
    !tabs.length ? jsx('div', { className: 'gw-chat-empty', style: { padding: 16 }, children: 'No project selected.' }) : null,
  ] })
}

export default {
  id: ID,
  name: 'Ghostwriter',
  description: 'Ghostwriter: a local writing workspace for screenplays — parse, revise, propose, validate, and export PDF.',
  defaultEnabled: true,
  register(ctx) {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())

    // Top-level section: a sidebar row that opens a full page in the
    // workspace pane (like any built-in view), not a docked pane next to the
    // chat. The user can leave the normal chat untouched and come here only
    // when they want to work in Ghostwriter.
    ctx.register({
      id: `${ID}.route`,
      area: ROUTES_AREA,
      data: { path: '/ghostwriter' },
      render: () => jsx(ScreenplayPane, {})
    })
    ctx.register({
      id: `${ID}.nav`,
      area: SIDEBAR_NAV_AREA,
      data: { path: '/ghostwriter', label: 'Ghostwriter', codicon: 'writing' }
    })
    ctx.register({
      id: `${ID}.palette`,
      area: PALETTE_AREA,
      data: { command: 'ghostwriter.open', label: 'Ghostwriter', run: () => host.navigate('/ghostwriter') }
    })
    ctx.register({
      id: `${ID}.keybind`,
      area: KEYBINDS_AREA,
      data: { command: 'ghostwriter.open', label: 'Ghostwriter', run: () => host.navigate('/ghostwriter') }
    })
  }
}
