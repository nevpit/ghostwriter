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

// ---------- view preferences (paper tone, size) ----------
// Persisted in localStorage so they survive restarts.
const VIEW_KEY = 'gw.view.v1'
const FONTS = {
  ui: 'inherit', // chrome inherits the host theme's font
  script: '"Courier Prime", "Courier New", Courier, monospace',
}
const PAPER = {
  blue:  { label: 'Pale blue', bg: '#DCEBF0' },
  cream: { label: 'Cream',     bg: '#F1EBDD' },
  pink:  { label: 'Light pink', bg: '#F6DEE8' },
  white: { label: 'White',     bg: '#FFFFFF' },
}
const PAPER_ORDER = ['blue', 'cream', 'pink', 'white']
const DEFAULT_VIEW = { size: 13, paper: 'blue' }
function loadView() {
  let v = { ...DEFAULT_VIEW }
  try {
    const r = localStorage.getItem(VIEW_KEY)
    if (r) v = { ...DEFAULT_VIEW, ...JSON.parse(r) }
  } catch (_) { /* corrupt store: defaults */ }
  const n = Number(v.size)
  v.size = Number.isFinite(n) ? Math.min(18, Math.max(11, Math.round(n * 2) / 2)) : 13
  if (!PAPER[v.paper]) v.paper = 'blue'
  return v
}
function saveView(v) { try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)) } catch (_) {} }
function useGwView() {
  const [view, setView] = useState(loadView)
  const update = (patch) => setView(v => { const n = { ...v, ...patch }; saveView(n); return n })
  return [view, update]
}

// ---------- title page ----------
// The backend parses the title page (``title_page.fields`` = [{key, value}],
// ``title_page.end`` = offset where the script body starts); the pane only
// lays it out and, in the editor, re-serializes it.
const TITLE_FIELDS = ['Title', 'Credit', 'Author', 'Source', 'Draft date', 'Contact']
const CENTER_KEYS = ['title', 'credit', 'author', 'authors', 'source']
const RIGHT_KEYS = ['draft date', 'date', 'revision', 'copyright']

function titleMap(tp) {
  const out = {}
  for (const f of ((tp && tp.fields) || [])) out[f.key] = f.value
  return out
}
// Serialize {key: value} to a Fountain title page (multi-line values indented).
function buildTitleBlock(fields, order) {
  const keys = []
  for (const k of TITLE_FIELDS) if (k in fields) keys.push(k)
  for (const k of (order || Object.keys(fields))) if (!keys.includes(k) && k in fields) keys.push(k)
  const out = []
  for (const k of keys) {
    const lines = String(fields[k] == null ? '' : fields[k]).split('\n').map(s => s.trim()).filter(Boolean)
    if (!lines.length) continue
    if (lines.length === 1) out.push(k + ': ' + lines[0])
    else { out.push(k + ':'); for (const l of lines) out.push('    ' + l) }
  }
  return out.join('\n')
}

// ---------- Fountain emphasis ----------
// *italic*, **bold**, ***both***, _underline_ (a marker toggles only when it
// has a partner, as in the PDF renderer); [[notes]] and /* boneyard */ hidden.
function Inline({ text }) {
  const src = String(text == null ? '' : text).replace(/\[\[[\s\S]*?\]\]/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  let buf = ''
  let st = 0 // 1 bold, 2 italic, 4 underline
  const flush = () => {
    if (!buf) return
    const style = {}
    if (st & 1) style.fontWeight = 700
    if (st & 2) style.fontStyle = 'italic'
    if (st & 4) style.textDecoration = 'underline'
    out.push(st ? jsx('span', { style, key: out.length, children: buf }) : buf)
    buf = ''
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\' && (src[i + 1] === '*' || src[i + 1] === '_')) { buf += src[i + 1]; i++; continue }
    if (c === '*') {
      let j = i; while (src[j] === '*') j++
      const run = Math.min(j - i, 3)
      const bit = run === 1 ? 2 : run === 2 ? 1 : 3
      if ((st & bit) === bit || src.indexOf('*'.repeat(run), i + run) !== -1) {
        flush(); st ^= bit; i += run - 1; continue
      }
    } else if (c === '_') {
      if ((st & 4) || src.indexOf('_', i + 1) !== -1) { flush(); st ^= 4; continue }
    }
    buf += c
  }
  flush()
  return out
}

// ---------- formatted reading view ----------

const NON_PRINTING = { section: 1, synopsis: 1, note: 1, boneyard: 1 }
const KIND_CLASS = {
  scene_heading: 'f-scene', action: 'f-action', character: 'f-char', parenthetical: 'f-paren',
  dialogue: 'f-dialogue', transition: 'f-trans', centered: 'f-centered', lyric: 'f-lyric',
  section: 'f-section', synopsis: 'f-synopsis', note: 'f-note', boneyard: 'f-boneyard',
  page_break: 'f-pagebreak',
}
function cueText(t) {
  let s = String(t || '').trim()
  if (s.startsWith('@')) s = s.slice(1).trim()
  if (s.endsWith('^')) s = s.slice(0, -1).trim()
  return s
}
// What an element shows when no search is active.
function displayText(e) {
  const t = e.text == null ? '' : String(e.text)
  switch (e.kind) {
    case 'scene_heading': return (e.forced ? (e.heading || t) : (e.heading || t).toUpperCase())
    case 'character': return cueText(t)
    case 'transition': return t.toUpperCase()
    default: return t
  }
}

function El({ e, group, elIndex }) {
  const search = useContext(SearchCtx)
  const groupHits = search ? search.matchesByGroup[group] : null
  const hits = groupHits ? groupHits[elIndex] : null
  const cls = KIND_CLASS[e.kind] || 'f-action'
  const extra = (e.kind === 'character' && e.dual ? ' f-dual' : '')
    + (e.kind === 'transition' && /^FADE IN/i.test(String(e.text || '').trim()) ? ' f-trans-left' : '')
  if (e.kind === 'page_break') return jsx('div', { className: cls, title: 'Page break' })
  let children
  if (hits && hits.length) {
    // Searching: show the raw element text so highlight offsets line up.
    children = renderHighlighted(String(e.text || ''), hits, search.currentMatch)
  } else if (e.kind === 'scene_heading' || e.kind === 'character' || e.kind === 'transition') {
    children = displayText(e)
  } else {
    children = jsx(Inline, { text: e.text })
  }
  const label = e.kind === 'section' ? '#'.repeat(e.depth || 1) + ' ' : e.kind === 'synopsis' ? '= ' : ''
  return jsxs('div', { className: cls + extra, title: NON_PRINTING[e.kind] ? 'Not printed' : undefined,
    children: [label, children] })
}

function TitlePageView({ titlePage }) {
  const fields = (titlePage && titlePage.fields) || []
  if (!fields.length) return null
  const low = {}
  for (const f of fields) low[f.key.toLowerCase()] = f.value
  const credit = low.credit || ((low.author || low.authors) ? 'Written by' : '')
  const author = low.author || low.authors
  const left = fields.filter(f => !CENTER_KEYS.includes(f.key.toLowerCase()) && !RIGHT_KEYS.includes(f.key.toLowerCase()))
  const right = fields.filter(f => RIGHT_KEYS.includes(f.key.toLowerCase()))
  const lines = (v) => String(v || '').split('\n').map((l, i) => jsx('div', { key: i, children: jsx(Inline, { text: l }) }))
  const known = ['contact', 'address', 'email', 'phone', 'notes']
  return jsxs('div', { className: 'hsp-titlepage', children: [
    jsx('div', { className: 'hsp-titlepage-spacer' }),
    low.title ? jsx('div', { className: 'hsp-titlepage-title', children: lines(low.title) }) : null,
    credit ? jsx('div', { className: 'hsp-titlepage-line hsp-titlepage-credit', children: lines(credit) }) : null,
    author ? jsx('div', { className: 'hsp-titlepage-line', children: lines(author) }) : null,
    low.source ? jsx('div', { className: 'hsp-titlepage-line hsp-titlepage-credit', children: lines(low.source) }) : null,
    jsx('div', { className: 'hsp-titlepage-grow' }),
    jsxs('div', { className: 'hsp-titlepage-corners', children: [
      jsx('div', { className: 'hsp-titlepage-contact', children: left.map((f, i) => jsx('div', { key: i,
        children: lines(known.includes(f.key.toLowerCase()) ? f.value : f.key + ': ' + f.value) })) }),
      jsx('div', { className: 'hsp-titlepage-contact hsp-titlepage-right', children: right.map((f, i) => jsx('div', { key: i, children: lines(f.value) })) }),
    ] }),
  ] })
}

// One editable element in the formatted editor: an auto-sizing textarea with
// the same .f-* class as the read view, so the page layout stays visible.
function EditElement({ kind, value, onChange }) {
  const text = value == null ? '' : String(value)
  const ref = useRef(null)
  // Auto-size to the wrapped content (rows alone would clip wrapped lines).
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  })
  return jsx('textarea', {
    ref,
    className: 'hsp-edit-el ' + (KIND_CLASS[kind] || 'f-action') + (kind === 'transition' && /^FADE IN/i.test(text.trim()) ? ' f-trans-left' : ''),
    value: text,
    rows: 1,
    spellCheck: true,
    onChange: (e) => onChange(e.target.value),
  })
}

function TitlePageEditor({ fields, onChange }) {
  const input = (key, ph, cls, multi) => jsx(multi ? 'textarea' : 'input', {
    className: 'hsp-titlepage-input' + (cls ? ' ' + cls : ''),
    type: multi ? undefined : 'text',
    rows: multi ? Math.max(2, String(fields[key] || '').split('\n').length) : undefined,
    value: fields[key] || '',
    placeholder: ph,
    onChange: (e) => onChange(key, e.target.value),
  })
  const extra = Object.keys(fields).filter((k) => !TITLE_FIELDS.includes(k))
  return jsxs('div', { className: 'hsp-titlepage hsp-titlepage-edit', children: [
    input('Title', 'Title', 'hsp-titlepage-input-title'),
    input('Credit', 'Credit (e.g. Written by)'),
    input('Author', 'Author'),
    input('Source', 'Source (e.g. Based on the novel by …)'),
    input('Draft date', 'Draft date'),
    jsxs('div', { className: 'hsp-titlepage-contact-edit', children: [
      jsx('div', { className: 'hsp-titlepage-contact-label', children: 'Contact · bottom-left of the title page' }),
      input('Contact', 'Name, email, phone — one per line', null, true),
    ] }),
    ...extra.map((k) => jsxs('div', { className: 'hsp-titlepage-extra', key: k, children: [
      jsx('span', { className: 'hsp-titlepage-extra-key', children: k + ':' }),
      input(k, ''),
    ] })),
  ] })
}

// ---------- search ----------
// Hits are computed over each element's raw text in document order (preamble,
// then every scene) -- the same order the backend's structure-aware replace
// uses, so a hit's global index addresses the same occurrence on the server.
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

function renderHighlighted(text, hits, currentMatch) {
  if (!hits || !hits.length) return text
  const out = []
  let pos = 0
  hits.forEach((h, i) => {
    if (h.start > pos) out.push(text.slice(pos, h.start))
    out.push(jsx('mark', {
      className: 'hsp-mark' + (h.globalIndex === currentMatch ? ' hsp-mark-current' : ''),
      key: 'm' + i, 'data-match': h.globalIndex,
      children: text.slice(h.start, h.end),
    }))
    pos = h.end
  })
  if (pos < text.length) out.push(text.slice(pos))
  return out
}

// One scene on the page: every element (heading included) in screenplay
// layout, with the scene number in the left gutter. data-scene-id drives the
// scroll-spy.
function FullScene({ scene, index }) {
  const actions = useContext(SceneActionsCtx)
  const els = Array.isArray(scene.elements) ? scene.elements : []
  const num = (scene.meta && scene.meta.scene_number) || String(index + 1)
  return jsxs('div', { className: 'hsp-full-scene', 'data-scene-id': scene.id, children: [
    jsx('span', { className: 'hsp-scene-num', children: num }),
    actions ? jsxs('button', { className: 'gw-scene-ask', title: 'Ask the assistant about this scene',
      onClick: () => actions.onAsk(scene, index), children: [jsx(Icon, { name: 'sparkles', size: 13 }), 'Ask'] }) : null,
    scene.parse_ok === false ? jsxs('div', { className: 'gw-inline-warn', children: [jsx(Icon, { name: 'alert', size: 14 }),
      'This scene has an unclosed /* or [[ — text after it is hidden.'] }) : null,
    els.length
      ? els.map((e, i) => jsx(El, { e, group: scene.id, elIndex: i, key: i }))
      : jsx('pre', { className: 'hsp-raw', children: scene.text || '' }),
  ] })
}

// ---------- format view packs ----------
// How a format's blocks render in the reading view and in the outline. The MVP
// ships the screenplay pack; new formats add a pack keyed by engine name.
const VIEW_PACKS = {
  screenplay: {
    Block: FullScene,
    navText: (s) => [
      jsx('span', { className: 'hsp-nav-idx', children: (s.meta && s.meta.scene_number) || String((s.order || 0) + 1) }),
      jsx('span', { children: s.heading || '(untitled)' }),
    ],
  },
}

// ---------- icons ----------
// Inline line icons (24x24, currentColor) so they follow the host theme.
const ICON_PATHS = {
  quill: 'M20 4c-6 1-11 5-13 11l-2 5 5-2c6-2 10-7 11-13M7 15l4 4M14 6l4 4',
  chevronDown: 'M6 9l6 6 6-6',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-4.3-4.3',
  x: 'M18 6L6 18M6 6l12 12',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  page: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
  review: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  upload: 'M12 21V9M7 14l5-5 5 5M5 3h14',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  collapse: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  undo: 'M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8',
  check: 'M20 6L9 17l-5-5',
  film: 'M4 4h16v16H4zM4 9h16M4 15h16M9 4v16M15 4v16',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
}
function Icon({ name, size = 16, className }) {
  return jsx('svg', {
    className: 'gw-icon' + (className ? ' ' + className : ''), width: size, height: size, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', children: jsx('path', { d: ICON_PATHS[name] || '' }),
  })
}

// The Ghostwriter logo (icons/ghostwriter-logo-{dark,light}.png): white line
// art for dark backgrounds, black for light ones. Embedded at 256 px, plus a
// 64 px cut with heavier strokes so it stays legible at 16-28 px.
const LOGO_IMG = {
  dark256: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAA/cklEQVR42u19d9hkVZH+e7r7mwADDDPkDMOQVQZQFkUJihgwICJGUFAUWTHH3Z8JdFlQQdc1gICK4qpgglUUEURXMgxR1CHKABOAgWGYma/D+/vjVvHVnLnn3tvx63Dqefrp7+tw+55zqt4Kp04VEClSpEiRIkWKFClSpEiRIkWKFClSpKEmF6dgeImkS1nrImtO/2/nHOOMRgCI1L+C7rz1bHRaaEmWvN8gAEZwiAAQqfcCX9J/nXONwOfGAEwHsB6AmfJYD8AMAOvK8zQR5CqAJwAsBfAkgJUAnpa/n3TOLS8IDI0ICO2tbS/nLwLA4Gn4tQSe5LoAtgGwHYA5AHaT500BrG8EfpoBjixqAKgLKDwNYDmARwDcD+ABAAsA/APAPQAeds5VA4AQBKdI/QECEQAGQOidc3XvvU0A7AFgHwD7yd9biYDnCTbNQ814P1bgP0K0TADhLgDXAbgRwB3OuSXeOMr629E6iC5ApAJ+thV6ktMAzANwIID9jcD72ryGNQN4LvBc6FZS/qYBjJIItk8PALgewJUA/uCcu9OMo4xkcPW40hEAIq0t+FCTmWRFNPxrARwqQl/xhF3N61IBbd2V2/YeJe8elwO4GcD/Avilc+5vHhjEeEEEgJE380tWEEjuBOB1Ivh7G4Gqy8MKfL+toe9ejJn3ngDwewDfBXCpc65mgCDGCiIAjJzwlz0z/wAA7wTwaiSBOyv0pYy16uc1VDBoCJCpy3IdgPMB/MI592AEgggAIyX4qvHFtz8cwHEADhIB0S25PLOeOWvIwHNRwU2LH7g2waAu11DLYBGAnwH4pnPuNuP61KNrEAFgKM191fokjwTwcTHzrU9fbmJdVFB90xtynVIHh9DAxC4CUlyRZqjuuQhPAvgegDOcc/emWUiRIgAMhblP8iAAnwRwiLw9jomoejOCr6a1E/Pa/24NwGMAHhcBe1T+Xyz/18y1VLhLSPIF1gWwAYCNkew2bC5uybSAMDcMPzUDOmoVjMl3lwA4A8CZzrmV0S2IADDogl8SBibJrQF8GsCxIiTVJrWoL/CWxgEsBPB3APcBuAHAfAAPI9mrX9WqNiU5BcBsAYMtAeyEJMloDoDdkSQguRRAaAYMdGxqEdwE4JPOud9FayACwDBo/WMAnCLatG5M/aKCYc1lIEnXvQ3ALQBuled7nHPLcsAozY93GXGCTO1LcmMBgXlIEpL2BrCDZ4WwSZCrA5giz+cBONk594AF08hdkfra19eEF5I7kbyEEzROsl7gUTOfVVpC8hck30Zym6zflkdJ/nfeqcBWxuPkemV7/ZTPbkDyYJKnk7yJa9I4yWrB8VdlDkhyIcm3W2CNXBapn01+/ftIkg8JEytDF2H8cSM0VZK/I3ksyW3TrAwr7JMEdqU0QCA5leTLSJ5H8kEzploTQLDafO97JGdFEIjUtya/PK9L8luGcVc3ofGVHiJ5Jsl9UwS+kqZ9+8n6ka08+/omJN9J8noP3KpNguLtJPc3cxFd2Eh9ZfLvSvLPTTC4L/j/IPkxklt6Qj+mDD8oTC/3WrFgQHIKyTeTvNEDgloT1sAKku9Ks7oiRZoUE1j+PpzkIylavxFg6HF5jyTvIflBkhuaa1d8oR9UjSduggWC6QIE1wbiIw3vkTZnX5Z6BxEEIk0aU6tgfsYw5niAiRspWv8pkidLNN1q/NIwmrfWWjIWwfslwGmtpkYGCGgMgSQvJTk7xgUiTUqwT0zzcwImfxoTW3P/UpLzPMF3IzJ/6h4ogM4heb7nFmSBgHUJriG5eQSBSL0W/vVJ/tyY/LUcE7ZqtvP+1TP13ajOpecaHE5ygQGBegYAWBCYr7skEQQi9UL4Z5G8LCD8PtPWjGb7Dcnd/PhBjKNM7ByQ3ILkBSnWQD0jlkKSt2h+RASBSN1gVI30b0jyipwtPt/kX0HyQwZAKnFG1wAAfVhr4L0klzU5z3eQnBNBIFLHhV8YdH2SlxfY328Yk/9hOQAEkzQT96/DQFA2YLuP7P2HsigbARDYLIJApE76qSWJWF8sTLaqQPIKSd5Acne5zphNz40zm2sN6BbfJhIwTQNdPz6gMYG/mKzBuEUYqT3/VP7+TsHMPhX+nxkmtBHvCADFAMCZuMA0kj8wlkBawNUPDF5Ocp0435HaYUhlwM8UOMxj96e/ZjTYWGTAtoCgbNywr5jzBEVA4LvWhYszG6kpv1+e319gW8oK/8nWeogaqGMxGA2gftjsrtQK7A581IJ5pEiF/H55fo1htFpGZp8K/+dt3CDOZMdjMWqRnVjgHEHNHCR6lQX1SJHyGM2R3ErOojcyMvysz//vVltFrd8Vt6BkXKv/F4gJ+PGYhiRf7WbBPVKkEJOp6f/jAttPKvyfUjMzRvq7HhewlsB/FThIZHdk1o3gHKmI33+S5/dnRfs/H4W/t7sbZmu2TPJHBQ5haTzgrOgKRMrz+w826b21nLPpFxiz3434/PUU+AzYrkPyygIgoIB9RASBSCH/chbJv6Vo/zSf/xqSM6O5v+Y8TpLFtq13iCgEAA2Sd5OcHc9iREpjpP/K8ftV+P8pPfxiUGny107jAftJfQVruaUVFCHJM6IVEMk3/Q/KqVxrtwMPk+/EJJ/+sN4UBP41J2FLtwZXkXxBBPDIPGr6zyB5a07gT7XHJ1XzTGIl3hhkDFtxZ+WAgK7jdRI/iLsC0fTn5woyzf/aDL9+8bVHgYELAIBuE84geVsOmK/2wDy6AiNs+u8i585DUX9loiXmrHlpsoVhFAEgb6wG0F9s3LlaRuORR0nOja7A6Jr+juSvcrS/Bv5OjNqivy0BLx7wlYJW3UURAEbX9H+tSRTJEv7L7Hn+OIP9HQswW7p35rgC+vrLIriPnvafLumhIS2hLsETJJ89rFqim0HFlPP9zu9X2GydhILXVIA/NOfAkFoB10rNgZjTMULa/60Fo/4nD7N26EQD0VZ+xxf8Zu8hD1SMK3BRQRfvTdEKGBHzUQ6F3JBh/mvW2H2SNTZ0pn9IeHoFMq1WSCpiARhXwJF8HsmVOUFekvyT5nVEK2D4tf8xOUdJlSmOG1atENLIg3LvBcFB1/tbBRKEaiRfHq2A4bcAxqRoZAgAqsYvnDKq2n8Qx5wGAPK8HcnFRthD7t6lsZjL8Gv/w1KKfKQBwOuHTRu063c344N38v6KXDvDLdACIv9ewApokDxklKyA0ogIv0ue6ACcAMABYMpHGwAqAG4FcIl8vjGEc9Hy++1eP0t4875P0jnn2ORv1uX9swD8U9Y3tPYOwIl62QgAQzRO51wDwHMBvEQWOw3hlZFOc86tku8NHSPYMTnnaAXIH28rlkKv5yzn9wig7JxbDOC8DPAvC18cSnJP51xjFFyBUfN13glgCoB6QAOUAdwI4MKQ9h/0eIAKvA8CrVxHv+f/3Y4Q67XsNTtgdSjInQvgEVlnpoB/HcA0AMd4CiECwACbvCXnXF0aR75WFj5r3Oc451aL1mCI0YYhMNgJTd0ukDT7vRbjFg2x5u4H8H0R7EZAHgjgCJIbCd+4CADDMcY3ANgYQDUF2VX73wfgp3m+/6B2+WlFSzerjXsFSP7cNwFE5wB4MhALUCtgawCHjoKMDPXghEHqJKcDeGOGWUd5/QLn3NKAiRipD60UH4DT3BL5vy7W4N8BXJlhBeh3jvT+jzSAAKBbf4d4FX3Stn+eJLmbTSDJ0jy9yqKLlD3vTWYRKj+8KVD30fLDCpJ7qBsZLYAB5Rt5Pky0ej1g/jsAVzrn7kyUhavnmcRRJPvO0isaCwCA3wJYIG5Aw+MVB6AGYB0Ar8mwGiMA9DtTyFbOBjn+nC7uT5pZbN83HiVLoFPpw2nnA7o5h7IDUnbOPQbgVx4ouBSeOEwSiRrDurbDbAHo2PYHsLNo/1KKhVABsBDApR5DdMxPjSDQPBCkvdfhef4JgFWy/r7gl4QP9gKwh/xuBIABpZdnCLa+9mvn3FIJErEVQWjBHB15SnOn7P9+lD8vS7CoGyCfvQlJxmcpwBt1JDkjBw2zGzCUACDmf53kNAAvzFhAfe03whQtpclmZdINq+B2EvR8dypN2DV5qd0YjHy37JyrArjMWIJEesT/ZcOYEj7sFoAyz64AdsLENl+a+f8QgL8IYzSaNfU7kQgzbIDQKfeiyG+2mIGon71UNH3atq8mBT0PwE4CSqUIAIMFAAchSe2spQCARvovds4tasX8b8MMHRrzvRPCX2RbL/Q7oQNCBd2AawFcY4Td56E6gA0AvGBY3YBhBQBd4IMzNIAeCvlFu4sbtwb7J4bQghvw0xTF4dMLPMshAkAf+/+qybcS8y1tnAQwhiT6P7+dxR01/78b8Zp2v9Pi9qGu1eUAnkZ29ucLSc6QbWUXAWAwzP/nIsn9rwX8fwC4AcAi8e3YSyZu1RQeZEHvRAZlB7cfVZj/DuBOpKcG6w7BHADPGUY3YJgBYP8Cmv0K0dotz0OzZmhAEMokK/5RWPNeeUCF/pl7TznmW5aHazXO0A4IGDdgHMCfM3hF80f+ZRhlZqgGYw7/lMQCAMLR/6cB/KGXvp3HsE4YkM65unOuJg1HNyC5Pslp5r163hmFdrVypwVfhEzvvSTjmi2PKc65mnOuJnNfDghoU3Pawlj0N64qoN33U8thmGSmMnxxIdcguQWAXTIAwAG4S8y/niyqx5glAA0R+nUAHAjgFaJlZonb8jTJJQBuA/Ar59yVAm7lrLMKLWrCTo7xmbMUJA8C8CqJxWyKiSO4j5G8Fck23C+cc+MCGgTATuzG2BTtjOvp67cBeArADKx9XkT/nkdyPefc8hZ3HiL1wuSU55fLaa+sCrDnyGdLPbo35zWsmELyfSTvYDG6jOT+es+dSsHt4PhK5u9DSV5ecFzXkHylv4atxBOaHY/53lTTJaoaOC06TnKvXvJMpOaZUIXrM7KYqzMA4L0hhutGAM4T/h08ARmXe9WOtvoYN6XLdTwf6dR9djB4qZ2W1yf5bTOuamBcdmxK55LcqCgItHL/gfLnuiZfz6garPd5bDP3F6n3AKCM+IsCnWH37bEFoIz2IpIPGIEO3WPaPdeMsEzvFli1aHVtR/JqI/jjGT35/DLsWop9Psmdi65LMzsCGWncui7HZLSKUwD4WgSA/g4Aqha6K7CYymh3kVyvVwBghOQAkssyrJOGeYSERZnxQmlyUp4sk9QA7tYk/5oxrnrOuOryPUpH382LrE2H+hvoGPYi+bTcY6hZzBXDtkU7TL6MLsrWSJKAQgFAALhTgjlt7f8XZTCJhO8M4EdIUkurBQKwLrBeZQDjAI4A8EUJuPU8d0DnTuot/FiCruMtjgvyvXEk5ze+LZq5F2PS9b8PSWJYWtlwvYedAWycdzIxAsDkAsC2ANZFevUfpRt7MX5jlawD4DsANhfhL2cwY0PuPWtnoiLX+TDJIwUEyp2636LzLZHwM5BskeUJf9088sb1KgAfk3GVegRmjyOpEoQAADSQ7GTsnANkEQAmGQDmyHMjY7zzezW/0pDkPUgSk8YzBLVhNHwFE40qmDPeL5KcJZ91HUiOKeTSiFXzagDvyLFoGka49cGMcZUEJD5O8lmaRxC633YPJWkimDzfFgAABbBSBID+JWW0fQKLqAknKwHcm7HQ3TD9P4lwNyK99wqAFUhOp10B4H55LeSmlJDkC+wI4N8EaHLrGXRo56BBciaA/8SaR62dedhxORGuPyLJvygbgENA264P4FQN0vWIrisgF3NixK1/A4BjJG/KCQDeR3JDFdJu+c4muPT9jOiyva9fSVVi/d4GJD9ggmrVjADa0ySfbQOOXZxrDWh+2ttp8QOYtsvyQSSnyvfWJXkUyUcKzEuD5GHdHpeZ812lGnBaIFCDrxfZ70TqLwDYmuSSQBKQMuSfu13W2wjJfiKctRzhP9dsR/n18d4oIFBNEZZGL7eozDxvRHKhJygWAHRcVynY+jEGkvuaa2Rtvf2u2wFOM66ZJO81/JMGaNfbtYrS1x8AoAj+XLNwIQT/gQpKNwDA5uyTPL9AcsnlYrmskesv/0+Rvz+ecR0d70KSs7vJmGZc78y4H9XcD5Dcylhmam2VzLgOIbkq0K9Bx1YluV+PrJuSl8tggU1zMP5JcpNhAYBhMWN0IbZHuP6/0t+7HMTReoRbISlImnbaUOMRTwD4oBSmKNkcfwlK1YTpv4Lk3PoY1o6ia+WaLZB0PgY6sCMQilUI2L6pwHqc7Jx7UE45Vk0cgwCqJMecc5ch2RoNxQM0hvDmHiiRssRR7suIDxHARkh2c4YiEDhsADA3Y/H0M/NTJLapk2c5loPO6UsAzEZ6PQKN+J/tnLs144APBVCqAE5GUsa6FAhwEkluANCFw01yj0RyLv75ZgxpAvsHAN8XsKhngIkDcCqAUDs2nbeXklyny8069bp3BubWdg/eIQJAn3kB8rxNxvsV0bh3WSFJE/6shhVZZcDlb73eKzK0SAXJ6bPzvO9kad3/A3B1QFuWhBn3J7lZp3vbexWTX4GJOosIgNHXpcNy1qk57dj7NwAXIr08t762I4A9m+HZNoBiQYZw61jmRADoL1LG2SEHIJbKo6OMYwBCzf+NAOyNNbfE1tDqSKoR3SUg1MgBt5Kcnf9lhvaqA9gM3atco6Dy4sD1VfsvRHaBjTXuW+btF0hv3ALz+r7NjqvJ+I7e64MB68bSNsMSPxt4ANCz2XI4Js83WwpgeaimXB6zFEg6sclIW2Ki72Aao/1OBL/UBHNegSSPIa21tf7Wnl2KazQEYGydBZdyjzc755b4adaBOWvI6zcCeCAjFgAAexQElZbcO3PdhQCWI5x/YQFg4FOCh2kvc7YEaJAhdHdrwK2TjGRAQX/3WQCmpvi/GvyrA/hTE7+pz/8AcA/S89WVdmtFUAr6xzsB2ARrBln9uf5LGm8FBIWSMLUUE+nZoTjAHhJQzI0DtCmUiwE8knMvW5Kc2snCLBEAWvdNdQybIammk8X4t9mFzGpLlfd6wBrQv5+TwjR2zheLMBcN2GlTy5XmeyHm3CotrtDmdqd+bxejpV3gM7c0+bu6ftcWtKoK+/7NNgsRMHoK2WcClNdmDkMcYBgsAF2ALTCxTRZizvvSmMOWj2pTo6gwb1/Az3y0xXHen6PhNwawTtaJNX83o4l72CHw2xrYXInsbbQsuiMgUJoavKEBANcBkz9LHu7JcRU2kPuJMYA+om0zGM+ZGADStGO7fqSJRVSQnBrLckWWSj3AUgsm66IMQYG4QTNDY/B/K29snjWxRc64ssznPN/7ESSHikqB+EapQIwHoS7DTbp4D2aAcAPJadOhyAUYJgDYOoPBnGinJc2Y+C3ex3TREFn0eBvMsyjn/RkA1gtd32/C2eRvr58jxEslgNYKPYGkUnMp4/qzWnQTm6UHMtZHE7u2iBZAn4QC5DkrB6AE4DEjPN0sAjLDCEqI+Za1wbwrcuaijKStdSrQtSgQNOCWRSuNZdOsBbBKQDqL1Ox2gfp+7VbrLbIVSM8digAwyaQZZZvkmKcLASzJSrxp82y5M0IyNU9QmjFlParmfLfUjI9c0P1hQX6ptbGOVQGBUIwBYnpn3nuHtuUWikWSBWTbRQDoAxIGXQfJNmAWParls0ImfyjLr9lKORkCSE94W+l4U8qxYnLbnKf9XsEx5n2m4X+uCVDNmjeXd+8d2hrU+3/UuGmh+97c+04EgMmQf3neCPmBt0d6NOZaBlM44ya0Gm+YbsYVamldbcn+zdeoeUI0lmdhZXx3SgHLaVkonpE3ribdnxWheJGZg820ndsgJwMNCwDMQhL4ymKGxQWtiXb9x1XGlA3RTP1OBwNxlnlXtGpNBZhZX3sy5xIbAJiaVZ0oZbwWFKdjzQpDPj3S8uIUiA/I+PVU5uKABaD3tjHyg70RAHoEAJsI82QlqCxulXGa/IoNZjFHiFsBHH8v3n9ebDRl28FOr3nqozl8NNsCVMHEKruGM5Bdy3FJi65LM+Cuv/VQAbCbVdAyigDQZdoU6e2d7eI81ArztxAUXIlkOysLsGbr8dqs04UB/zStKKV1Bx4E8FTR04BNji1rj58ixK1uj22D9LMACkA1JDs5HQG2AvTPjDVsCFhtGi2A/qBtC1gJXd0CVGGWdtN5ueSbIyVZJ/vyriE1+HcLrN0z9e29cwmdtG4ezpjjOpJMzB2LaMUU4Mk6w+CQBOUWNQtkbezqPJbxnlqam0YLoD9okwy/vCRm+dIezueCDEGh+I9bN8E8tjHFVsZPTouc35snFCr4aRZIjrA8kME3qrmf2+Sc1aXq0fPMWNNOGd4PYFFakLFLnXoXZawPjeUZLYBJJBqNmiU8y4z/2Avz8fbAfaimnIrmzu3rZw4ULZtWZUjN5zvzNL5/DqKAltT37kISCMyq3vNCSYduFLAwtB7/XADzEC6fBgC3S02EIseM27FyaFzGUI0CepZntAB6LvkT9emLJAEtRv6+bifpZkx0AGLAVz/CjiEjoOVES07DRMmvtM+VkSSw3BwaZxuaUuf5biQnKtO2+lQw90RyHBoASjm1F/S9VyMJqNUyhOka4w6tBVohQW9hzDTuzjKkJwM5Lx7DQe0ZONAWgEkC2iRF09rFWOycW92DWu5qBt+G5NiuZR6bTdcAcAgmmpiUC2jJF4qWDNXiI4DrnXMPiUnNDs9zWTTwlRnxjRqS3ZjXFYhDKLDNAHB0BoBrz8BrvDkuHJdpEQAeQzjo+EwbOilu+swJ1EEDgkEGALt9tGnOeBb2YrzCcGXn3HJMFPxoBAJm0wC8twkNdRzSqwLb617WxXHqfV6OcJcjBbyjpcNvVrciBbbDAOwu4JFm/jtxPf6aZcGFaju2YfWszIgbWd6b6d9Hl2ISEQBCKIxkT7ae47v2+r4uQvhAiVoBR5HcRzRrmkBV5HDNiwG8JkNItMT4bxV0usCECmTXISmtXgqAWw3Jlt5HJCEoBBR1aZr6UWSnNQPApc65cc28KwrGrcyBSQaqYe3aBtaypLgtG3fAxYoA0IagzUU4B6BIgYdOkzazvBJJeawK0mv5N8Rc/g7JTYXhtBdgSYS/SnIugK+LxZBmVivI/NI5d6+Y/x3PTzfWzQoAl2RoYy0F/l6SL5cxVKQRizY+VYA6E8BegWCb7eV4QZH4TbuNQlN46+4s90XWZGgqBA9aEFDbM/1noEdd3Tz3pLNMyr29sWBfwBtJ7pRynT1J3pVxDe2ms4LkvG6P0RQw2YXkcu8e0roVLSN5VMp1ppD8Zs7c+J2cSj3kLe2AdFSgS5BtyfaxXvJWpLWZ8ecZAECSS0lu00smMpHuaSRvKMjo/yR5ogj9XiRPIvlQRgsu+90f9Wp8Zt7Pzrk3baVFkmdJg9B5JI8geVnOnGirsOUG2EqTwFt7k1zpKRQfAHoOUFH4J47pTiN5a04vtxtMLzrXw3tUK+DIHGa3lgClV95q83/e96q9tHBMj78dSC7O6VxcM0DcEGEqMi4d/zcnQ7sa/tpEgNlvFmoboM6fDP4a9RjAM+WZJeCU5hurH3inBJDKPQ7SNIRxfwbgUvF9QwUztFR4Dcmx2DEkeQT1jDXSmMFPnHNXm1Ns3Z146WXgnLsHwGcDwUC7TpSxNJAkQNUCwUwb05iCZOfm1AKdk7oJAktN/MjP51B+2wFJduZAxgEGHQDmYWIHIDT5d07KDSaCQhHK9wojTUF4t8IZYdLoeWhMdbnWLQA+MgmaR8HtmwDOkXupZaxV2QQ+Sxl8p/OwAsDRzrn7BWwaPV47mt+91dybTeTSHY/1hA8jAEwCHRRAZ4vQd04aSkmPPufcvQCORJJYUjGAlZa05HIYqSYWwj0AjnLOPYyJzj29FBD9vX8F8OscEEABAbHAd6Jz7g8ZTVM7YuIXpJuyLiXPB0fHvPf+2VSSNwf8SfX/l2t0fTKDNCYe8Arx8UNBy6xHzfjGD5Hcs13/uF3LwQTLZpO83sQwagXG4/v8umZftHPWTR4qOLa9ZK0aKeOqmjhTZVDjAIMGALowO5F8Kmdh+iZAYxjkMJKPmMDSeI7AVD0BuZPk3t0WkhbWY2uz46HjquYAWtVE01eS/OhkBP1yFM0MmfOQomkIH+462YpmVABA92jfkBFNVqY6t18WRSLnCgJzSV7gbZWpMKyW53Hv/dUkvy2dhydV82eAwIYkv2WsHAsGq81j3OwOkORVdiejX7So4bXvZGx5qrJ5T7+A16hYAOcVWJSj+21R7L2QPJDkj0kuYjrVJRHoS6r1+1XL2HsSs/kMkn9jmJ4m+SeSx5Ac6zfh9wDgqALK5pcC8gNlAbhBE34JrG2KpJvsllh7S0nPlC8FsLdz7p8daBiRqTmbvbY2zjDturZEUh9gD0wci30YSQR6vhwuWut7fQoCTgN3JDVCvh+SMxvjSOoJLABwk3Pudn9t+y3eJCnQWwi/bYa1d5wsv+3nnLu7H8cyLNq/SIrtM4jcaW1pz7J34tinaLxSkXEPgmYx81IuEp9Qt6hfA2dWo5O80GQAhnjuQ4PmBgxawEJR9fUGfUNWzW87Pcai7cSbuF5dtwpFEMbMo2IEv45JSIZpc1w1b1wV89CDQQ5AvV8tGq8i8u+R37jkrSSn9SIha5R9/2eTfCJwEEWjso+S3LYb/nI3Cz502sIYBIthgPhuB+G7RsYBqDrJg9UKihZAd+IVxyCpPZ+W/acFKP7gnLtfEkk66ot1s+CDPc46aIUlOmFR9ek9ajLXPUgSnkJHzzXL8Qivn2IEgA5pigbJ2QDegPTikRYkLvL+jxSpE8rnpxl8pdWQXkdy44RtY05ApwBAt2NOzNj6U/P/PpIzu2H+RxpZ/tOkoJkkF5jTgKFg4MmR/zrvF69H8q8ZkVjd+/+CfK8S0zIjdSEW8CWTmBWKAzwhMQMXQaBz2v+EAtr/cZJzdOIjAETqAgA8S/gsVA1JrYAvW/6N1Lr2L0mKaRHT6+xoekXqgTL6do4yqpNcQnLbaAV0ZsI/klN+Sk+U7RsBIFIX+VET0eZJHcY8K+DMaAW0YXIJem5P8uECk31xRNtIPbBIVSl9P8cKqAlI/EtUSu1p/x+ZtN+0s/M62QdGtI3UQwB4VkEr4ErN6IwxqeaF/yjj9zdSHj2vihtp5AHAFTwmbEHg7VE5NT/JW5JcaFIvfeGvmy2XnSIARJoEK2AuySe9nSh/a1pzUzYdhfTuTmr/81NM/7SyzKdFdI00iXz6VWMFpCkotQLOi3xafFJfn9GRxVoEC6V2ewz+Reo5r4pfvxnJBwOWqi19RpJHRBAIT6gmWmwmJpO/55+m/aNvFWkyXQHdFnxHjsKyrsBm0V0N+FVybvySQLEPX/h/aZA4+lWRJpNvS1ISLM0VaHip6r+WitaRb81EKpKeViDhpy79/naOSBqpj9zWHaW2Yz0QtLa7VqdYvo/Cnzy/vYDwK4p+IJr+kfrQFTguJ3BdN9WfDx55HjboeYDUVq8V6KL7G2kvHU2oSP0CACXjCvymwO6VxgO2Hlkr1gj/DqYD63iO5l9Ick7U/pH6CQCUHwUMdjRl3kP5K+OmH8J6IwcCRvhnkbw2RfjTtlFWkzw0+k6RBoCvXyx9D2qGn0MW7a9JrjsySULmkM8Mkr8NaP60wMmHo/BHGgD+1njARwueYCXJn4hcDPd5ASP8U822SVplFV/4f66TG/3+SAMQEyjL45ImQOA/hlrBeU0jfpgh/HVvv/82k0cdT1RFGiRe31xau2WBgM0UPGYoQcBo/rI5R706cIzSCv9dMegXacDjAXuTXJzRycoeaX+a5Nv0+0Oh7EyKb8k09MzS/NoR9yGSu0fhjzQEIHCAd2qwnlFKjCQ/PhQgYIR/mjH7x3OEv0FyOckDovBHGgIQ0KDgW40VUMuxBEjyMwMNAgb91jPBkNUZwZCamZgjhjogEmnUQEDbn3+6QFDQxgQ+oXIwUCBghH8zklc0Ifwk+b4o/JGGDABKxhI41YBArQAIfEC+Nxh5Amage5C8paDw6/N7otkfaQgB4Jl0Yfn/qwXlYo1mN9at7nfhf6EE8Yoc7lH//9io+SONgCWgO2LfbRIEfkhynb5UkF6dtMNJLiso/JoiedxA+jqRIrUOAlMlA9AHAb+kWM0kxP3eFBQp95Pwa7T/A95efp7wryL5Fiv8EQAijQgIaEbsTz1l2QiUv9eMwTtI7tYX1rIVWJKfNdsc1QJn+leQfF00+yONaExATw9OJ3mBOT1YL5A2fB/J50+qJWC0/hSSX8+IbKbV8ltE8iVR+CONMAA4K7wkP29AoBpwCez5mCdIvnlSQMBo/emeCVMrcLDnHpJ79WUwI9KwCpprh8+7LEPWij7RyFCowKiVJZI8vqeyZCZ1HZK/KBDJtDd8J8m5UfNH6oEwuXYBoIfusy0r9jZTWDSvtJiCxVE9AQGvCuoFBYTfFj64keT2UfNH6qXm79egsn9v8r9mDL5eDgZlNRyxVsLKntQYNFt9H21yD/N8krOj8EeK4LSW0PsPBYGXS1dsCwJZQfUHutoizwT9DhTEqRU81PBFH0Amy++ajEWOFClD2EMPVbS7kZxfIKdGrexr5exNZ+tmmBtb39xQtYDwf0TBIwuV+t1ciwAQqRcAELC2NzXnacYLxNk+03ErwNzMBwtUN1Gr4ET9bpZADJvwRwAYTXO+E9o/Q+7Wz6if6T8eJbltx0DARCrXJfnXjCw/q/nfLd/JTe2N2X+TrpVKeRZapPZAvhXhN9/V3YFZJK/OAQG1Aj7WsXibQaFX55j+Goz4rHx+LAp2Xwq8Fqwspa21gHZsujLJLoD3PQWBnaWHRkgJa7DwapNp6DoFAN/OQB8V/j9lMVikSWO+Upo2kEpNG5KcSXJamvaJ69g5S6EFF8DmCigIvM7ssNVSrPCG7M7NK+IGVPJu3jlXJzkVwL7ychqiOAB1AKfI5ysAGnH5J1/wAcA515D/N5J1PAjAswBsBWCGrNUTJO8BcCuAvwC4zjm3zCiBhnOOcVZbJ+ccQxo5a27lO3WSZefcz0heAuA1AKoAyp4c1gBMAfAiADcH5LU5BiI5V+r0pR1YqJotiDFbvjuakZMq/BXz934kzyb5IIvT3STPJLmLbw1Gai9e0KwFYB56YvbIHDeAJP+77TUzAPD8jEQE/cFTbeAvAsDkBvbk791J/tjLHR+XY9ir5e+q6Vg7Lq9XzeeXSuLXWASBzgUMmwgC2s/puu5IcklAIetaX1TEBcjz7/TGxuRvZnzmsbwBRFboDaM55xokTwBwFYA3yBqNi3lYEtevIuZjSR5leVTk/7p8ZzaA0wD8keRB4uLFuECTpn+HL7kcwJO67IHPrJPzfiEAUMry5/UHZsSlnnStrwGjMwF8A8AsEWInwu1S1i0L/CsCBFUA+wG4jOSHBWDKozCvvQCHFgBiijyQ4eM3ct4vBAB6Y0sArJTPM2AB7JbHWNEK6B4fmXX4FoD3G41fyWACeo/QtcsCAgDwJZLvE0tgqEGgm0HPFgVfLektAWwUUMx6zcc7CQD3AvhHwA3Qa7xIMpAaWdeNINAVKjnn6gBOAXA8gNXGtPdBoiHAQGP266MhGt9+XtdLhb0G4Ksk3zQKINBnYOTk+ZUApslahOTptiIAUMQM0sDD903OsV/sQ4NGZ8pnK3YnoFPHMzt9vSExUzVP4zCzPtWcgK3SYyQXknxESrRZquUcQV1matOVRnj+u8qPdgdA/p8rpwTrObkAB1r+6ASDnVAgE7BuGhmUzY5AqZ2tQW2sEEpMMVsklVHqIGzmdFOptNQIJGrZNO17SX6B5EEktye5sTRw2VnOof+PAYPxnNp0V0hhy1Ga87xsyjXe71DKsO7ArCfJdnkJeQtIzuiIxW0sgG1FY4QaHFomO8Ug1hSbXlrkhuwkBt5fj+RsecxIA60RCVIpOJ+aUZ+hZqy10yQZKO+680heXjDv/JiOaJrBANu0bMrpJDeQjMoZoUM9RdKr044FmzXemORvCq5J4RyAoqeZyuLvnQXgXVg7A8kPKlUAXAzgQ865BQZIyoHAk/U1qZlrBsHmIMlg+xcAuwLYWnwgAFgB4EEAfwNwHYCrnHP3m9/kMGawkSxJNH5zJBlfG4v/Xg4E+U5wzp2jLlog8KeZgzXROl+XmELaejfktRsBHCBBYgzbXAv/aYwFJGci2RF5IYBnA9gGyZZbWWIviwDcA+AGANcDuN0597S5XsXMH7w1KBk5aJgMzlcAOB1JoD0ke3qtOoD9nXPXK4900tTcRXy/ek4JY0WihST/XTTKtCZ+bxbJl4qp+iepgFqUHpF4xSG+phxS7X+CV5S1lmISvlc+O5YVm0nJOHMkL8xw/dTfPKwX89xrN8Or2rszyS+JeV2UqiRvJ/nfJA9Ns1Zzfn8/khfJHOdV4FKZ+2EzcRnXgsb5AIAzkGwzZZ0l0JxkAHhKopKXA/g/AA/La+OCWtMBbA7gOaLp9wOwg4dstZSINlNQdMz8/T8APuice0StmCHTTA7AbwC8VOay7GnoMQAXOOfeYs5nFNXQZbEEtgBwDZJzAw2PZ+ryG2c5597d7Tk2iU7shfCL1bsBgE8AeDeADQ1vM0OG9D1NtFK6E8DVAP4M4HYASwE8LZ9fF8BmYu3uKnLwQgBTZZ4bnoXgW2MVkasXAbhbdgwaXUHEgn3NVAOtNgimtFIsiaXyWB5Az9UZ5cZrgQhoVVJdqybodYS1ZIbB/JfnHWT+GiYibOvKLye5k9eIopmHxnHeE/A9dY7ny4GxrmvpXuz8GD4/WDQ4C3T0zaqL6adX6y7LYxLRf9jE1yw1ChQAqZr2Ya/q6q6MYYx1Sf65IAjYiRg3ZiNTJmTcPGo5k13zHvUU18Rue318WEAgZeuv6s2FRukvNkEo18JD3YXZJO9PcQU06Lu8qwUpe+gKmLk91vBPluA3Ms7JpAnruBHqLBmoFgCbqlmDd7XihjW1WCYZYQWSHPObxcyv5ZiWDhP55pqMUvcemnFWRvEEJT+A6JtkZbm3GoBTSZ4iZtGwbFvtbuYzjX5nXIWW5EHW+1FxA+C5EXoMfIYEw4B2E0+K82E3lFtFzP6TAJyDiQzIcofGZc9cMEUG4MlA1trVjQv+Xufc2a24YKUWJr8h8YCHALwMwCUCAmW5qSKL41IeofcRiGqzoE+rE1kF8G8kPyeTNMjJKzovmwWAUMf21w4Ii17rlhww3nDAwVRjHh8G8FXDy3katWEebHIN8+Qg9Hsae3kSwFucc99sNf7SkhDoYRDn3GIArwXwUSTnBcYwcZKskyht0VKDIRX5PT+FNcsCqQL4NMnjhiSNdWrO+7UO/tajOcHjgZ1L0fw1km8A8CUzb1kCqfxoT1H6mr1TMuDMdZXvLwdwgHPux+0EX1vWguZYaMM59yUke/RnS1RzzFgErUwEPTehLNecIs/LkZxPuBfAMjMpRdyQOoBvmKOt5T5iRNcGg6Rp5U6e0KzkCMXTAzBPoWh/jeQ+AM7CxE6Hy9H4Y0YL/x3AAiQHcMrmPaucGi3Igf2uXvc+ACcAONQ5N7/dnZe2+vOZRIWyc+4eAMeT/BqAtwI4Emtu5dVRvEyYf4JtBZKEkz8iSa5YAGCxvDcLwJ7ym682mq8UEJSGAMm3pMXy41L6bCASWDzmX5WhLQBg+w4Kyw454LNsADW/S544HcB/A9gA2Yk2DSMzfwTwfSRbeg8Lv80CsB2A5yNJjtoTSYKWb5UV4bWyJ58LAPwAwLecc4vk/kt9s7Xtp0pKMs/bpYHoQ2yOVpK8g+S5JI+xZaly7uEtsp1StJPKNxXABolpzfbc+wNj1V2A83V8ze4AmN/SLcQ/ml2fmrcLsILkrsoHAzSXGvH/QAGe0W28B0m+oWBK+9YkjyB5FslbSD7VhAysJvk32XI/XPIRYNezk8GkjgJBYhxMIBPJTZCkMe6KJFq8JYCZookboskeA/CImFM3A7jbplCmCKqfQkkx6fcC8FPRWFkpy4roBzvn/tyxtMneaC01Ww8E8PuAC1CS+XwOkoQTV9QEVWvIJH/tg6S60JSU36mIWbqnc+6JQbGmNE1cAqk3yHPD+PFpmv9GAG9wzt0jvFjC2rsia6Xyyu9NE+tgVwA7AthEAqfri2m/GsATsmZ3IUlt/4dzbrmNVfjX7XdN1VZ58NAJwIwii3pqakeSdxXsY3DtoJ1oM4lAs0xqajVg5Zwinx1rIxHo55729/MNfjaA2l/n8Cwzf6Hjz5SmOFsYviyaR1GxBVpbsVIGvjy7AYOKORlY8ibKf9+1+FsKAjvlNFGwQnJiUVegH0DCayD5jYD5qkL6NMkXNwkCJZJT5Dvv8gDGAoDO39sGyZUyc7e/l+TTSOGPGslFJHdPG2OBph4hHvdloew1ZhmZI9bdWGAFgSMKWAENkvdJcww3QFaAMvEBGanROr6HJeAJv25CQGNpDOCVJJ/0rm2FvyF1CGb1Czg2Y5mSvNRrv90IxFKONSZ4pAETkEtyAjxq4n2un7VYoIOsE61+bYEiEYtJvjbNmrEWhbEUPiTBvUbgzMVqz8UotzKGSZhHdWsO9QrZNDwQUOvm9wY0o0YeQB9vH4m+1jIOFdVJPm5KXJVbFdIeA4DftzGUs64gUCd5AcmXk9wwBQhmyU7KNSY3vZoyX6ox7ye5RV4zmCK175udhxYrS6n2n0LyDwHQbBheeYrkflH7D74VcFpBK+A6qe7ia0SX49tVUkzrUqeabRZsIX1yzuEsW7GJJG+U3Rm9/udIPlDg5FvVaP83m0BV1jZibgPMEIgb37gc8KNLaf33Ar+vruGnCgaIT7PjixI1mMFHJ+WUHvBMvtCin++ZwiXvoQw41mxkttVoboFAkwrgRQVOaOrx7GUkt5FrrCetwGiOroa+v0o+942siHiaABYZnx1Pq9HylEfFCP9LzXHxWk5caGPbkWcYaajNGmnGWHbOLZGKxV9G+MyAnhV4K0kAOMk593gBxtsOyV77swDMRVKvfQxJgY5lSPbI/w/An3VPV8zJetH98qzPyRiBZP/5nUj2lg/CRIEQX5D0tRomciSmYyJL0i8n/sxQZe6mArgQwIe0aWjofouMz9Pemtaq5bfmAniuzO9WANaTj64AsBBJkZnrANzlZ8R5xUM0Y/UwAN+R9fGLm2ieBOXvs4RvhqqQzKhaASUp2Di/iYyvv8oW2DaSJ1AR92AOyZdJqbPfkXy0YGbX36XE2fZ+nKJTkW35e6YJfNYC24OUMmt6hn/zwHn/urfdR5I/MsU/2i79bt0lY1G8heRlsgORR0+J63amxEK2NIE+J/PxfJLnmLFXA+f6Vfs/QHKTWHZ++GIB+0rxiqI1DbU55i3iMy+QYKFP46Z6UdrDVoNZTPJjhknLXQCBaSS/bBg+DwC2NP6/Lxx2Hj5ugqulZnrd562N/P0yU/baVsRZHZjftGpTi2StriJ5tVSEqmUENdPWfaDyGiI1BwLvKmAF1E3XXOaUKytSuaVmuvIqXU5yx6wIs+9LN7P7IX8fJNHutCo+j5nf39q0Dq96APkkya+RnGMEv0hh0SIlsCtm9+EcD1DHAxWfQpWmVqU0PvEr7dRyYiO2qGYU/iEGgfNksVc1Uc6sWlDY80qY2Sj6AzZBJ7DLsFZgrQgIGOHa0Jj3tQAAbCfJQhYAVJg+7QUx2zlUlBaR34XkTea3qy3Mac2b3/Em12u1qW244SiZ/qXRwwCWAHwIyQGQqRL4K1JHQB/tnNnXa1UkSLc1gEtIHiiHeyp5WlOCfnlbagTQkLGWAoFPO5as8++PCqBMRXbRldwgnw1EOueqJOchqWo8T+aj1CRPplXTaXa96kgOOS1CUl3ncUz04IsAMGS7Ag15fhzA65GUaJ6KiQIkmbxclOcLfrYi4LMhgItI7tsMCKQJl/+/jNfWYfBrKSo1MsY/Va7TqRNoepJxHpJyctvJPFQ6MLfNgLOWmh8T4T/cOXeHRP0boyITo9jUUbcG70fSZfVsYb6KMIRfuSWP6XR7rIaJ4qYlrFkaKigMwvyzAPyE5C7OuTWKmWgb6VA76QI+d020a54whca4qkkAzOQ3Ef5dAfwSwBbILsCh4GS7GZfMa2mVdvJq69Gs0xQktfpf6Zy7ehS3/EYOAHRfWBb7cefc8QAOQ7KnPMVoIstg/qNm3vfLlRETe/Bj5rVGDghsA+BCknouPdUMbcE0HcdEuS5maP1GAAxWdIrXpF7DVkjyCLbG2s1MfEHVc/hadPZJTDSk0fkOrZctHFtPWa8qgG8AeJFz7sZR3e8fyfxmEaK6lsx2zv0vyasAHIektNieWLv4RYgWAZgvMYVbkST+rAQwG0ly0KsBvEQ+G9J2ZWHs3QF8G8DhAFyHimsoYKW9bjvYlANavtbMvAYsEQ0GjiFJxNkNa3aWcingpO/dDuAiAFcg6QG5joDHrkg6SM0TN6Loej0p1sd/Oeeu16DpqCb7xCQHrJGBptH4vZFk0z0XSfWi6UYrLQfwTwB3iODf5Jx7OOf6hwM4U7R8lsmr5Z6/4Jz7d61W20RwzV9bFaorkNSoq2Gi/8JSAPs45+6XjLu/CGipeayFL492zp2v2YsFgDXtHisS9PsUgC8g3FZO+wxUkFTG+X8AfuCcW5Uxt+sJcO6NpDDtbpioNkUklXYeA/BXGePvpX6l7go1RiXgFylbSEtpATh5fTrJdUINTr0DQWW/uIN8Zo45Zbc6Z8uRJN9omDTo9+cV9pDPX2q22WomIUnPAsyVjEbbZUi3xt6kwNjKnr/ZjjxEipNkbc2Nm4NKO5uxjnlzq2cx0uamIlt5m5LcTDIByynrVYpcHwkB4SpllTMzAl+o5JkRgo0kfTgPBOqyT/8c/b2Mey0CAL9OAYBFpsTVnBQAUGF8RREAyDmu/Gzp2lykOtMNEgdZo5txxnhLPtiGrLyBL60Vg4C9iQ845xrOuboUxFyL6eT9mn6mwDVr4mYsBfA6AJeJiVrPMIM3BPB96Uef6lu3abraXYC0HYEykh2AxSmBwUIWlQT9NkVSpHVTGVcpw/W5FcCrpZtzxTlXlbmmWRv/oWtVk99zgTXTzzQil0cAaBYQMrfiCl6nLiDwFIC3AfiHMH09EBSsAng2gDPkN0t5+/45wt5sPMiJ//xUswCgwVVxmc4BsJOMpxQIRo4BeADA65xzD2XFPlpZr+jjRwDoFzBREFiEpLvLSkzkDIRA4O0k3y1Bymbz012TAu8fj81ruRaySDSq/hkkuRarET5iXJLA6tHOubvbEf5IEQAGCQQuB/BJTLSPYmB96gBOI7mPuhJNav9m3QJfO9eacTl0R0V6FnwQ2b0ZFABOcs79schOQ6QIAMNADdF0XwXwlQxXQLfy1gdwLsmNMJHj34z2Z4qA+zGAWsASqGeZ2AHhnwvgXEzszafl5Ot235edc99VzR/N9QgAIxFXQJKIVEbSWfnnmOiS5FLWqIokqegb8t1mtX8jRegbHgA0Alq6UTAGoH32pgE4D8D2WLPqkKWajPdiAJ+SeYiaPwLAyIGAPt6JpB1ayATWeMCRJE8U/7rSAgD4r7EZPshxO7S12lcAvADhNF89fTcfwDucc+OIyTgRAEYUBBoiOI8BeDuSNNVSTjzgP0g+1zmXd4iGKQDgAu8XsSiyCn3qCb8PIAluhoRfU3wXA3irc+5RcRui8EcAGFkQ0KDgrQBOwprFKdPiAesB+B7JbfyTgxk0HgAF5gBHFflnAVT4XwrgVIRbs6vrshrAsXL0thILbkYAGBkKmdAGBL4H4HMZroDGA3YF8GOSM4xgFQEA5/nhdU84fRAYzwGAksQytkByiGlqBl9p592T5PBVOW73RQAYKeHPMXUbEgz7PCaCgqF4wDiSgy+nqxuRZbYHrmO1eykAACErwV7bATgdE4U9Silgo5l+33POnR1LbUcAGEVTnwXe18+8B8kx2DGkB/A0KPgekseLJs3ypdMshJoXG0iLPdSRUcdAhPgTAN6M8H6/Cv98JL0ESuhcdaFIEQCGCiQ0KLgYwFsQDgrqXn0dwKkkd7dJQilC3wgIZsO7XprrkKap9Xjv6wF8FtlpvhUAS5DU23usCBhGigAwyiBgg4Lvx0QJLKasXQPJoaFvk1wf6XkEQJJynCacafkBlpYDWOXFLkoi/M9BUlGnEgAQm2NwtHPuTgn6Re0fASBSQRD4LpJCInmuwAsAnIX0CrkhAPB9/bTXH5d9+pLhF5LcGMD5ADZGOOqv2v8TzrlLY45/BIBIzZEGBT+BpHR21snBcQBHAfi3wKGhIiY3MyyHZ4BFNPiZSDITx3P8/u85506PmX4RACI1bwXoGfjVAN6BiaBgVqbgZ0gekZIkFNLQeQDQ8Ez/Gsn3YSLoV8kQ/qsBnCjuQ8z0iwAQqUVXoCLHh48B8LgInS+81vT/pgQFqznrW0f6ISFLarKPid9/IIBTMFFbMA0wxpBk+h3rnFuBEWqyEQEgUjdAoCYgcJOAgApuWlCwLn75uVIssx7Q9goaNGCAFKHWkuCrSe6ApKLv+pg4xutbEE7chjc55+4atSYbEQAidYvUErgYSaXcPFfgeQA+J+BRZN89pKFXigm/LpLKPnMCfr+eGiwDOME594eY7BMBIFJn4wF1KZhxOpK69lNyQOCDJI/LyRS0fJC6fSi//Z8ADkS4nLf6/ac7574Xc/wjAETqDgjo3v27kV1TUMt5fUXacD2ec/kK0qP5S0geieSEX+hsvx7vvQTxbH8EgEhdBYEGkhTcRUgKiz4pwhtKElofSWWebVJ8fBsE9C0AzT48EMCXjX/vWwka9PsbkrP9NQCxCGekSN0iOYevfQZeQ3JVRrONWkoPAm08cpXpGzCX5DKp21/zvsuc/gWPk3yeXKccVyhaAJF6Ew8Yc879EsBHkL41qBpf/fNnMMRob5rPucB308x5W83oeOfcddHvjwAQqbcgoNuDX0fSPHMM6Wf3HdKj/H7KsMv5jO/3VwD8h3PupzHNNwJApMkBgYZs052IpM99aGfACrSueQVr5vgXLTSqQb8LkWQexqBfBIBIkwQCenx4EZL03KUZ7gAQrgPYjPCPIWmF/i65XkzzjQAQaRJBQJOEbgFwNJKaey5DsNP6AealBGvMoCIgc4xzbpmATxT+CACRJpk0KPgbJH0GbLehIv59ngVgU4aPl7P9MdMvAkCkPooH2KDgD7FmYdG86r8uxwpQ7f8x59zPY8Q/AkCk/gQBDQp+CMAChDMF88x9+15NrnOec+6M2L8vAkCk/gWBRvLkFgN4K4AnEG40YrV+1nbfFABXADgpFvSMABBpAEBA/PNrkUTqs2oKOmPip7UGHwNwN5IuPk/p9WPgLwJApP4GAQ0K/hRJn4GxFBDw+wBYK8A2BjneOfdQPNsfKdIAEckSyYqcHbhQcvrHzVmAa0mOyWd3IfmEOSuwWj7zKXm/Emc0UqTBAgBHsizPM0neIkK9Sp7/ZA4DbUvyYTkMpO+fa0EkzmikSANqCcjzPDnxp6f4Ljaf2ZzkfcY6+BXJaQIe0U2MFGnAQaAsz28yR3x/YCyFWSTvkddvIDnTgkekSJGGBwROJXk3yUPUvxcQOJ3kApJ72M9HihRp+NyBmUb762OM5Ib6epyt0aC40KMFAM909xEwWGM/3znHAm3MI0WKNMggkKbhQ69HihQpUqRIkSJFihQpUqRIkSJFGnz6/+dGTg7S9SRnAAAAAElFTkSuQmCC',
  dark64: 'data:image/png;base64,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',
  light256: 'data:image/png;base64,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',
  light64: 'data:image/png;base64,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',
}
// tone: 'auto' follows the theme (both images rendered, CSS shows one),
// 'white' for coloured/dark surfaces, 'black' for light ones.
function Logo({ size = 16, tone = 'auto', className }) {
  const cut = size <= 28 ? '64' : '256'
  const img = (set, extra) => jsx('img', {
    key: set, src: LOGO_IMG[set + cut], width: size, height: size, alt: '', draggable: false,
    className: 'gw-logo' + (extra ? ' ' + extra : '') + (className ? ' ' + className : ''),
  })
  if (tone === 'white') return img('dark')
  if (tone === 'black') return img('light')
  return [img('dark', 'gw-logo-for-dark'), img('light', 'gw-logo-for-light')]
}

// ---------- small helpers ----------

function relTime(iso) {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (isNaN(t)) return String(iso)
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return Math.round(s / 60) + ' min ago'
  if (s < 86400) return Math.round(s / 3600) + ' h ago'
  if (s < 7 * 86400) return Math.round(s / 86400) + ' d ago'
  return new Date(t).toLocaleDateString()
}

// who: 'assistant' shows the Ghostwriter avatar, 'you' a pencil, 'system' an icon.
const ORIGINS = {
  create: { label: 'Project created', icon: 'plus', who: 'system' },
  import: { label: 'Imported', icon: 'upload', who: 'system' },
  manual_save: { label: 'Edited by you', icon: 'pencil', who: 'you' },
  proposal: { label: 'Written by Ghostwriter', icon: 'sparkles', who: 'assistant' },
  assistant: { label: 'Edited by Ghostwriter', icon: 'sparkles', who: 'assistant' },
  restore: { label: 'Restored an earlier version', icon: 'undo', who: 'system' },
}

// "INT. KITCHEN - NIGHT" -> { setting: 'INT', place: 'KITCHEN', time: 'NIGHT' }
function splitHeading(h) {
  const s = String(h || '').trim()
  const m = s.match(/^(INT\.?\/EXT|EXT\.?\/INT|INT\.? ?- ?EXT|I\/E|E\/I|INT|EXT|EST)[.\s]+(.*)$/i)
  if (!m) return { setting: '', place: s || 'Untitled scene', time: '' }
  const rest = m[2]
  const k = rest.lastIndexOf(' - ')
  return {
    setting: m[1].toUpperCase().replace(/\.$/, ''),
    place: (k > 0 ? rest.slice(0, k) : rest).trim() || 'Untitled',
    time: k > 0 ? rest.slice(k + 3).trim() : '',
  }
}

function sceneCast(scene) {
  const out = []
  for (const e of (scene.elements || [])) {
    if (e.kind === 'character' && e.speaker && !out.includes(e.speaker)) out.push(e.speaker)
  }
  return out
}

// ---------- status chip ----------

function Chip({ kind, children }) {
  return jsx('span', { className: `gw-chip gw-chip-${kind}`, children })
}

const STATUS_LABEL = { PENDING: 'Waiting for review', BLOCKED: 'Needs changes', ACCEPTED: 'Accepted',
  REJECTED: 'Rejected', STALE: 'Out of date', ADDED: 'New scene', MODIFIED: 'Changed', REMOVED: 'Removed',
  PASS: 'Pass', FAIL: 'Fail', UNAVAILABLE: 'Skipped' }

function statusKind(s) {
  switch (String(s || '').toUpperCase()) {
    case 'PENDING': return 'pending'
    case 'BLOCKED': return 'bad'
    case 'ACCEPTED': return 'good'
    case 'REJECTED': case 'STALE': return 'muted'
    case 'ADDED': case 'PASS': return 'good'
    case 'MODIFIED': case 'UNAVAILABLE': return 'warn'
    case 'REMOVED': case 'FAIL': return 'bad'
    default: return 'muted'
  }
}

// ---------- modal ----------

function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && onClose) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return jsx('div', { className: 'gw-modal-backdrop', onMouseDown: (e) => { if (e.target === e.currentTarget && onClose) onClose() },
    children: jsxs('div', { className: 'gw-modal' + (wide ? ' gw-modal-wide' : ''), role: 'dialog', 'aria-modal': 'true', children: [
      jsxs('div', { className: 'gw-modal-head', children: [
        jsx('div', { className: 'gw-modal-title', children: title }),
        onClose ? jsx('button', { className: 'gw-icon-btn', title: 'Close (Esc)', onClick: onClose, children: jsx(Icon, { name: 'x' }) }) : null,
      ] }),
      jsx('div', { className: 'gw-modal-body', children }),
      footer ? jsx('div', { className: 'gw-modal-foot', children: footer }) : null,
    ] }) })
}

// ---------- project picker ----------
// Plain-DOM dropdown (a native <select> opens an unthemed OS menu on Windows).

function ProjectPicker({ projects, value, onChange, onNew, onImport, importAccept, onDelete }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const fileRef = useRef(null)
  const cur = projects.find(p => p.id === value)
  useEffect(() => {
    if (!open) return
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  const item = (key, icon, label, onClick, cls) => jsxs('button', {
    className: 'gw-menu-item' + (cls ? ' ' + cls : ''), key, role: 'menuitem',
    onClick: () => { setOpen(false); onClick() },
    children: [jsx(Icon, { name: icon, size: 15 }), jsx('span', { children: label })] })
  return jsxs('div', { className: 'gw-dd', ref, children: [
    jsxs('button', {
      className: 'gw-dd-toggle' + (open ? ' gw-dd-open' : ''), type: 'button', onClick: () => setOpen(o => !o),
      'aria-haspopup': 'menu', 'aria-expanded': open,
      children: [
        jsx(Icon, { name: 'film', size: 15 }),
        jsx('span', { className: 'gw-dd-label', children: (cur && cur.title) || 'Select a project' }),
        jsx(Icon, { name: 'chevronDown', size: 14, className: 'gw-dd-caret' }),
      ] }),
    open && jsxs('div', { className: 'gw-menu', role: 'menu', children: [
      projects.length ? jsx('div', { className: 'gw-menu-label', children: 'Projects' }) : null,
      jsx('div', { className: 'gw-menu-scroll', children: projects.map(p => jsxs('button', {
        className: 'gw-menu-item gw-menu-project' + (p.id === value ? ' gw-menu-active' : ''), key: p.id, role: 'menuitemradio',
        'aria-checked': p.id === value,
        onClick: () => { setOpen(false); if (p.id !== value) onChange(p.id) },
        children: [
          jsxs('span', { className: 'gw-menu-project-text', children: [
            jsx('span', { className: 'gw-menu-project-title', children: p.title || 'Untitled' }),
            jsx('span', { className: 'gw-menu-project-meta', children: (p.author ? p.author + ' · ' : '') + 'edited ' + relTime(p.updated_at) }),
          ] }),
          p.id === value ? jsx(Icon, { name: 'check', size: 15 }) : null,
        ] })) }),
      jsx('div', { className: 'gw-menu-sep' }),
      onNew && item('new', 'plus', 'New screenplay…', onNew),
      onImport && item('import', 'upload', 'Import a file…', () => { if (fileRef.current) fileRef.current.click() }),
      (onDelete && value) && item('delete', 'trash', 'Delete this project…', () => onDelete(value), 'gw-menu-danger'),
    ] }),
    onImport && jsx('input', { ref: fileRef, type: 'file', accept: importAccept || '', style: { display: 'none' }, onChange: onImport })
  ] })
}

// ---------- demo script ----------
// An original short script for "Open the sample script" on the welcome screen.
const SAMPLE_TITLE = 'The Night Shift'
const SAMPLE_SCRIPT = `Title: THE NIGHT SHIFT
Credit: Written by
Author: Sam Rivera
Draft date: First draft

FADE IN:

INT. ALL-NIGHT DINER - 3 A.M.

Rain beads on the windows. A neon sign buzzes: OPEN 24 HOURS, though the second "H" gave up years ago.

MAYA OKAFOR (30s, sharp eyes, tired apron) wipes the same stretch of counter for the third time.

The door chimes. LEO (60s, rumpled raincoat, a man who carries his own weather) shakes off the rain and takes the stool nearest the register.

MAYA
Coffee's fresh. Pie isn't.

LEO
Then I'll take the coffee and a lie about the pie.

She pours. He wraps both hands around the mug like it owes him money.

MAYA
(studying him)
You were here last night. Same stool.

LEO
Same rain, too. I'm starting to think it follows me.

He slides a folded napkin across the counter. On it, in shaky ink: an address.

MAYA
What's this?

LEO
Somewhere you used to live.

Maya goes very still.

CUT TO:

EXT. DINER PARKING LOT - CONTINUOUS

Through the window we watch Maya unfold the napkin. Rain hammers the hood of a lone station wagon. Its headlights blink on, by themselves.

INT. ALL-NIGHT DINER - CONTINUOUS

Maya looks up. Leo's stool is empty. The mug is still steaming.

MAYA
(quietly)
*Nobody* knows that address.

She reaches for the phone, hesitates, and pulls off her apron instead.

FADE OUT.
`

// ---------- scene actions (hover "Ask" chip on the page) ----------
const SceneActionsCtx = createContext(null)

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
  const [confirmDelete, setConfirmDelete] = useState(null) // project id awaiting delete confirm
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
  const [chatSeed, setChatSeed] = useState(null)
  // Follow the host theme: light text on the root means a dark theme.
  const rootRef = useRef(null)
  const [theme, setTheme] = useState('dark')
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const check = () => {
      const m = getComputedStyle(el).color.match(/\d+(\.\d+)?/g)
      if (!m) return
      const [r, g, b] = m.map(Number)
      setTheme((0.299 * r + 0.587 * g + 0.114 * b) > 140 ? 'dark' : 'light')
    }
    check()
    const mo = new MutationObserver(check)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    return () => mo.disconnect()
  }, [])          // { text, n }: pre-fill the assistant's message box
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
  // Ctrl/Cmd+S saves the editor (read through a ref so the listener stays stable).
  const saveRef = useRef(null)
  useEffect(() => {
    function onSaveKey(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S') && saveRef.current) {
        e.preventDefault()
        saveRef.current()
      }
    }
    document.addEventListener('keydown', onSaveKey)
    return () => document.removeEventListener('keydown', onSaveKey)
  }, [])

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
    enabled: !!pid,  // also drives the Review badge and the script banner
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
  const titlePage = (data && data.title_page) || { fields: [], end: 0 }
  const preamble = (data && Array.isArray(data.preamble)) ? data.preamble : []
  // Word count over printed elements (status bar).
  const wordCount = useMemo(() => {
    let n = 0
    const count = (e) => { if (!NON_PRINTING[e.kind]) n += String(e.text || '').split(/\s+/).filter(Boolean).length }
    preamble.forEach(count)
    for (const s of scenes) (s.elements || []).forEach(count)
    return n
  }, [scenes, preamble])
  const sceneById = useMemo(
    () => Object.fromEntries(scenes.map(s => [s.id, s])),
    [scenes])
  const activeRevId = data ? data.active_revision_id : null
  // Freshest active revision id for writes: mirrors the query value but is
  // bumped by each successful write, so a quick follow-up edit never sends a
  // stale base while the project query is still refetching.
  const activeRevIdRef = useRef(activeRevId)
  useEffect(() => { activeRevIdRef.current = activeRevId }, [activeRevId])
  const projectFormat = (data && data.project && data.project.format) || 'screenplay'
  const pack = VIEW_PACKS[projectFormat] || VIEW_PACKS.screenplay

  // ---- search / find & replace ----
  // Hits over every element's raw text, in document order (preamble, then each
  // scene); each carries a global index used for next/prev and "replace current".
  const matches = useMemo(() => {
    if (!searchQuery) return []
    const all = []
    let gi = 0
    const groups = [['preamble', preamble]].concat(scenes.map(s => [s.id, s.elements || []]))
    for (const [group, els] of groups) {
      els.forEach((e, i) => {
        for (const h of findMatchesInText(e.text, searchQuery)) {
          all.push({ group, el: i, start: h.start, end: h.end, globalIndex: gi++ })
        }
      })
    }
    return all
  }, [searchQuery, scenes, preamble])

  const matchesByGroup = useMemo(() => {
    const map = {}
    for (const m of matches) {
      if (!map[m.group]) map[m.group] = {}
      if (!map[m.group][m.el]) map[m.group][m.el] = []
      map[m.group][m.el].push(m)
    }
    return map
  }, [matches])

  const searchState = useMemo(
    () => (searchQuery ? { query: searchQuery, matchesByGroup, currentMatch } : null),
    [searchQuery, matchesByGroup, currentMatch]
  )

  // Move the highlighted hit by one step (wrapping around).
  const stepMatch = (delta) => {
    if (!matches.length) return
    const base = currentMatch < 0 ? 0 : currentMatch
    setCurrentMatch(((base + delta) % matches.length + matches.length) % matches.length)
  }

  // Find & replace runs on the backend, which keeps cues/headings upper-case
  // and enumerates matches in the same order as the highlights above.
  const doReplace = async (occurrence) => {
    if (!pid || !searchQuery || busy) return
    const target = occurrence === 'current' ? currentMatch : occurrence
    if (target !== 'all' && (!Number.isInteger(target) || target < 0)) {
      setNotice({ kind: 'err', text: 'Nothing highlighted to replace.' })
      return
    }
    setBusy(true)
    const call = (revId) => api(`/projects/${encodeURIComponent(pid)}/replace`, {
      method: 'POST',
      body: { query: searchQuery, replacement: replaceQuery || '', target, revision_id: revId },
    })
    try {
      let res
      try {
        res = await call(activeRevIdRef.current)
      } catch (e) {
        // "Replace all" is safe to retry on a newer revision; a single
        // highlighted hit may point elsewhere now, so that one is not retried.
        if (errInfo(e).code !== 'STALE_REVISION' || target !== 'all') throw e
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

  // Opening Review with nothing selected shows the first waiting suggestion.
  useEffect(() => {
    if (tab !== 'proposals' || propSel || !Array.isArray(proposalsQ.data)) return
    const first = proposalsQ.data.find(p => ['PENDING', 'BLOCKED'].includes(String(p.status).toUpperCase()))
    if (first) setPropSel(first.id)
  }, [tab, propSel, proposalsQ.data])

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
  saveRef.current = (editing && dirty && !busy) ? () => doSaveDoc() : null

  function invalidateAll() {
    return qc.invalidateQueries({ queryKey: [ID] })
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

  // Edit the whole document. Two modes:
  //   'formatted' -- one field per element, laid out like the page; saving
  //                  splices only the changed elements back at their offsets,
  //                  so untouched text round-trips byte-for-byte.
  //   'source'    -- the raw Fountain text in one editor.
  function startEdit(mode) {
    if (!pid || editing || !data) return
    const base = String(data.active_revision.snapshot || '')
    const groups = [{ id: 'preamble', elements: preamble }].concat(scenes.map(s => ({ id: s.id, elements: s.elements || [] })))
    const structure = groups.map(g => ({
      id: g.id,
      elements: g.elements.map((e, j) => ({ key: g.id + ':' + j, start: e.start, end: e.end, kind: e.kind,
        text: base.slice(e.start, e.end) })),
    }))
    const values = {}
    for (const g of structure) for (const e of g.elements) values[e.key] = e.text
    setDraft({ mode: mode === 'source' ? 'source' : 'formatted', base, baseRev: activeRevIdRef.current,
      title: titleMap(titlePage), titleOrder: (titlePage.fields || []).map(f => f.key), titleEnd: titlePage.end || 0,
      titleChanged: false, structure, values, source: base, changed: false })
    setEditing(true)
  }

  function buildDocFromDraft(d) {
    if (d.mode === 'source') return d.source
    const base = d.base
    let out = ''
    let cursor = d.titleEnd
    if (d.titleChanged) {
      const block = buildTitleBlock(d.title, d.titleOrder)
      out = block ? block + '\n\n' : ''
    } else {
      out = base.slice(0, d.titleEnd)
    }
    for (const g of d.structure) {
      for (const e of g.elements) {
        const v = d.values[e.key]
        if (v == null || v === e.text) continue
        out += base.slice(cursor, e.start) + v
        cursor = e.end
      }
    }
    return out + base.slice(cursor)
  }

  async function doSaveDoc(overwrite) {
    if (!draft || !pid) return false
    setBusy(true); setNotice(null)
    try {
      let rev = draft.baseRev
      if (overwrite) {
        const p = await api(`/projects/${encodeURIComponent(pid)}`)
        rev = p && p.active_revision_id
      }
      const res = await api(`/projects/${encodeURIComponent(pid)}/snapshot`, {
        method: 'POST',
        body: { content: buildDocFromDraft(draft), revision_id: rev }
      })
      if (res && res.id) activeRevIdRef.current = res.id
      setDraft(null)
      setEditing(false)
      setNotice({ kind: 'ok', text: 'Saved. Undo is in the History tab.' })
      invalidateAll()
      return true
    } catch (e) {
      const info = errInfo(e)
      if (info.code === 'STALE_REVISION') {
        setNotice({ kind: 'err', text:
          'Save conflict: the script changed while you were editing (maybe from the chat). ' +
          'Your text is still in the editor.',
          actionLabel: 'Overwrite with my version',
          action: () => { closeNotice(); doSaveDoc(true) } })
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
      if (info.code === 'STALE_REVISION') {
        setNotice({ kind: 'err', text: `This proposal is out of date: ${info.text}` })
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
        // Title/author are left blank so the backend takes them from the
        // file's own title page (Fountain, Final Draft or PDF).
        if (/\.fdx$/i.test(file.name)) preview = ''
        setImportPanel({
          name: file.name,
          title: '',
          author: '',
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
        title: (importPanel.title || '').trim(),
        author: (importPanel.author || '').trim(),
        filename: importPanel.name,
        content_b64: importPanel.content_b64
      } })
      setImportPanel(null)
      setSceneId(null)
      setDraft(null)
      setEditing(false)
      setTab('script')
      setNotice({ kind: 'ok', text: `Imported "${p.title}" as a new project.` })
      await invalidateAll()  // refresh the list first, or the auto-select reverts it
      setPid(p.id)
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
      setTab('script')
      setNotice({ kind: 'ok', text: `Created "${p.title}".` })
      await invalidateAll()  // refresh the list first, or the auto-select reverts it
      setPid(p.id)
    } catch (e) {
      setNotice({ kind: 'err', text: `Create failed: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  async function doCreateSample() {
    setBusy(true)
    try {
      const p = await api('/projects', { method: 'POST', body: { title: SAMPLE_TITLE, author: 'Sam Rivera', fountain_text: SAMPLE_SCRIPT } })
      setTab('script')
      await invalidateAll()
      setPid(p.id)
      setNotice({ kind: 'ok', text: `Opened “${p.title}”. Try the Assistant: “Make Leo more mysterious”.` })
    } catch (e) {
      setNotice({ kind: 'err', text: `Could not create the sample: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  async function doDeleteProject(id) {
    setBusy(true)
    try {
      await api(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setConfirmDelete(null)
      setDraft(null); setEditing(false)
      if (id === pid) setPid(null)
      setNotice({ kind: 'ok', text: 'Project deleted.' })
      invalidateAll()
    } catch (e) {
      setNotice({ kind: 'err', text: `Delete failed: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  async function doExportFdx() {
    if (!pid) return
    setBusy(true)
    try {
      const r = await api(`/projects/${encodeURIComponent(pid)}/fdx`, { method: 'GET' })
      downloadText(r.fdx, r.filename, 'application/xml')
      setNotice({ kind: 'ok', text: `Exported ${r.filename} — opens in Final Draft and most screenwriting apps.` })
    } catch (e) {
      setNotice({ kind: 'err', text: `Final Draft export failed: ${errInfo(e).text}` })
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
      setNotice({ kind: 'ok', text: `Exported ${r.filename} for use in other screenplay software.` })
    } catch (e) {
      setNotice({ kind: 'err', text: `Fountain export failed: ${errInfo(e).text}` })
    } finally {
      setBusy(false)
    }
  }

  function downloadText(text, filename, mime) {
    try {
      const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' })
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
  const proposals = (proposalsQ.data && Array.isArray(proposalsQ.data)) ? proposalsQ.data : []
  const openProposals = proposals.filter(p => ['PENDING', 'BLOCKED'].includes(String(p.status).toUpperCase()))
  const pageCount = (data && data.page_count) || 0
  const runtime = Math.max(1, Math.round(pageCount - ((titlePage.fields || []).length ? 1 : 0)))

  // Open the assistant, optionally pre-filling the message box.
  function openAssistant(text) {
    setChatOpen(true)
    if (tab !== 'script') setTab('script')
    if (text != null) setChatSeed({ text, n: Date.now() })
  }
  const sceneActions = useMemo(() => ({
    onAsk: (s, i) => openAssistant(`In scene ${i + 1} (${s.heading}), `),
  }), [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const iconBtn = (icon, title, onClick, extra = {}) => jsx('button', {
    className: 'gw-icon-btn' + (extra.on ? ' gw-on' : ''), title, 'aria-label': title, onClick,
    disabled: extra.disabled, children: jsx(Icon, { name: icon }) })

  const NAV = [
    ['script', 'Script', 'page'],
    ['proposals', 'Review', 'review'],
    ['history', 'History', 'history'],
    ['export', 'Export', 'download'],
    ['rules', 'Rules', 'sliders'],
  ]

  const topbar = jsxs('header', { className: 'gw-topbar', children: [
    jsxs('div', { className: 'gw-topbar-left', children: [
      jsxs('div', { className: 'gw-brand', children: [
        jsx('span', { className: 'gw-brand-mark', children: jsx(Logo, { size: 20, tone: 'white' }) }),
        jsx('span', { className: 'gw-brand-name', children: 'Ghostwriter' }),
      ] }),
      projects.length ? jsx(ProjectPicker, {
        projects, value: pid || '',
        onChange: (newId) => requireSaved(() => setPid(newId), 'switching projects'),
        onNew: () => setNewProject({ title: '', author: '', format: 'screenplay', text: '' }),
        onImport: onImportFile,
        importAccept: '.fountain,.spmd,.fdx,.pdf,.txt,.text,.md,text/plain,application/pdf',
        onDelete: (id) => requireSaved(() => setConfirmDelete(id), 'deleting the project'),
      }) : null,
    ] }),
    pid ? jsx('nav', { className: 'gw-nav', children: NAV.map(([key, label, icon]) => {
      const badge = key === 'proposals' && openProposals.length
        ? jsx('span', { className: 'gw-badge', children: String(openProposals.length) })
        : key === 'script' && dirty ? jsx('span', { className: 'gw-dot', title: 'Unsaved changes' }) : null
      return jsxs('button', {
        className: 'gw-nav-item' + (tab === key ? ' gw-nav-active' : ''), key,
        onClick: () => setTab(key), children: [jsx(Icon, { name: icon, size: 15 }), jsx('span', { children: label }), badge],
      })
    }) }) : jsx('div', {}),
    jsxs('div', { className: 'gw-topbar-right', children: [
      failed ? jsx(Chip, { kind: 'bad', children: 'Offline' }) : null,
      pid ? iconBtn(focusMode ? 'collapse' : 'expand', focusMode ? 'Exit focus mode' : 'Focus mode', () => setFocusMode(f => !f), { on: focusMode }) : null,
      pid ? jsxs('button', {
        className: 'gw-btn gw-btn-accent' + (chatOpen ? ' gw-on' : ''),
        title: chatOpen ? 'Hide the assistant' : 'Write with the assistant',
        onClick: () => (chatOpen ? setChatOpen(false) : openAssistant()),
        children: [jsx(Logo, { size: 18, tone: chatOpen ? 'auto' : 'white' }), jsx('span', { children: 'Assistant' })],
      }) : null,
    ] }),
  ] })

  const toast = notice ? jsx('div', { className: 'gw-toasts', children: jsxs('div', {
    className: `gw-toast gw-toast-${notice.kind}${noticeLeaving ? ' gw-toast-leave' : ''}`,
    key: `${notice.kind}:${notice.text}`, role: 'status',
    children: [
      jsx(Icon, { name: notice.kind === 'ok' ? 'check' : 'alert', size: 16 }),
      jsx('span', { className: 'gw-toast-text', children: notice.text }),
      notice.action && jsx('button', { className: 'gw-btn gw-btn-small', onClick: notice.action, children: notice.actionLabel || 'Retry' }),
      jsx('button', { className: 'gw-icon-btn gw-icon-btn-small', 'aria-label': 'Dismiss', onClick: closeNotice, children: jsx(Icon, { name: 'x', size: 14 }) }),
    ] }) }) : null

  const emptyState = (icon, title, text, action) => jsxs('div', { className: 'gw-empty', children: [
    jsx('div', { className: 'gw-empty-icon', children: jsx(Icon, { name: icon, size: 22 }) }),
    jsx('div', { className: 'gw-empty-title', children: title }),
    text ? jsx('div', { className: 'gw-empty-text', children: text }) : null,
    action || null,
  ] })

  // ---------------- Script tab ----------------

  const modeSwitch = jsx('div', { className: 'gw-segmented', role: 'tablist', children: [
    ['read', 'Read', 'eye'], ['formatted', 'Edit', 'pencil'], ['source', 'Fountain', 'code'],
  ].map(([m, label, icon]) => {
    const active = m === 'read' ? !editing : (editing && draft && draft.mode === m)
    return jsxs('button', {
      className: 'gw-seg' + (active ? ' gw-seg-active' : ''), key: m, role: 'tab', 'aria-selected': active,
      title: m === 'read' ? 'Read the formatted script' : m === 'formatted' ? 'Edit text on the page' : 'Edit the raw Fountain text',
      onClick: () => {
        if (active) return
        if (m === 'read') requireSaved(() => { setDraft(null); setEditing(false) }, 'leaving the editor')
        else if (editing) requireSaved(() => { setDraft(null); setEditing(false); setTimeout(() => startEdit(m), 0) }, 'switching editor')
        else startEdit(m)
      },
      children: [jsx(Icon, { name: icon, size: 14 }), label],
    })
  }) })

  const stageToolbar = jsxs('div', { className: 'gw-toolbar', children: [
    jsxs('div', { className: 'gw-toolbar-left', children: [
      !outlineOpen ? iconBtn('chevronRight', 'Show scenes', () => setOutlineOpen(true)) : null,
      modeSwitch,
    ] }),
    jsxs('div', { className: 'gw-toolbar-right', children: [
      iconBtn('search', 'Find & replace (Ctrl/⌘+F)', () => {
        const next = !searchOpen
        setSearchOpen(next)
        if (!next) { setSearchQuery(''); setReplaceQuery(''); setCurrentMatch(-1) }
      }, { on: searchOpen }),
      jsx('span', { className: 'gw-toolbar-sep' }),
      jsxs('div', { className: 'gw-zoom', title: 'Text size', children: [
        iconBtn('minus', 'Smaller text', () => updateView({ size: Math.max(11, view.size - 1) }), { disabled: view.size <= 11 }),
        jsx('span', { className: 'gw-zoom-val', children: Math.round(view.size / 13 * 100) + '%' }),
        iconBtn('plus', 'Larger text', () => updateView({ size: Math.min(18, view.size + 1) }), { disabled: view.size >= 18 }),
      ] }),
      jsx('span', { className: 'gw-toolbar-sep' }),
      jsx('div', { className: 'gw-swatches', role: 'radiogroup', 'aria-label': 'Paper colour', children: PAPER_ORDER.map(k => jsx('button', {
        className: 'gw-swatch' + (view.paper === k ? ' gw-swatch-active' : ''), key: k, role: 'radio', 'aria-checked': view.paper === k,
        title: 'Paper: ' + PAPER[k].label, style: { background: PAPER[k].bg }, onClick: () => updateView({ paper: k }) })) }),
    ] }),
  ] })

  const searchBar = searchOpen ? jsxs('div', { className: 'gw-findbar', children: [
    jsxs('div', { className: 'gw-find-field', children: [
      jsx(Icon, { name: 'search', size: 14 }),
      jsx('input', {
        type: 'text', ref: searchRef, placeholder: 'Find in script', value: searchQuery,
        onChange: (e) => { setSearchQuery(e.target.value); setCurrentMatch(e.target.value ? 0 : -1) },
        onKeyDown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1) }
          else if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); setReplaceQuery(''); setCurrentMatch(-1) }
        }
      }),
      jsx('span', { className: 'gw-find-count', children: searchQuery ? (matches.length ? `${currentMatch < 0 ? 0 : currentMatch + 1} of ${matches.length}` : 'No results') : '' }),
      iconBtn('chevronDown', 'Next (Enter)', () => stepMatch(1), { disabled: !matches.length }),
    ] }),
    jsxs('div', { className: 'gw-find-field', children: [
      jsx(Icon, { name: 'pencil', size: 14 }),
      jsx('input', { type: 'text', placeholder: 'Replace with', value: replaceQuery, onChange: (e) => setReplaceQuery(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); doReplace('current') } } }),
    ] }),
    jsxs('div', { className: 'gw-btn-group', children: [
      jsx('button', { className: 'gw-btn gw-btn-small', disabled: !matches.length || currentMatch < 0 || busy || editing, onClick: () => doReplace('current'), children: 'Replace' }),
      jsx('button', { className: 'gw-btn gw-btn-small', disabled: !matches.length || busy || editing, onClick: () => doReplace('all'), children: 'Replace all' }),
    ] }),
    iconBtn('x', 'Close (Esc)', () => { setSearchOpen(false); setSearchQuery(''); setReplaceQuery(''); setCurrentMatch(-1) }),
  ] }) : null

  const reviewBanner = (openProposals.length && !editing) ? jsxs('div', { className: 'gw-banner', children: [
    jsx(Logo, { size: 20 }),
    jsx('span', { children: openProposals.length === 1 ? 'The assistant suggested a change for you to review.'
      : `The assistant suggested ${openProposals.length} changes for you to review.` }),
    jsx('button', { className: 'gw-btn gw-btn-small gw-btn-accent', onClick: () => { setTab('proposals'); setPropSel(openProposals[0].id) }, children: 'Review' }),
  ] }) : null

  const outline = jsxs('aside', { className: 'gw-outline', children: [
    jsxs('div', { className: 'gw-outline-head', children: [
      jsx('span', { className: 'gw-outline-title', children: 'Scenes' }),
      jsx('span', { className: 'gw-count', children: String(scenes.length) }),
      jsx('span', { style: { flex: 1 } }),
      iconBtn('chevronLeft', 'Hide scenes', () => setOutlineOpen(false)),
    ] }),
    jsx('div', { className: 'gw-outline-list', ref: navRef, children: scenes.length === 0
      ? jsx('div', { className: 'gw-outline-empty', children: 'Scenes appear here as you write.' })
      : scenes.map((s, i) => {
          const h = splitHeading(s.heading)
          const cast = sceneCast(s)
          return jsxs('button', {
            className: 'gw-scene-row' + (sceneId === s.id ? ' gw-scene-row-active' : ''),
            'data-nav-id': s.id, key: s.id,
            onClick: () => { if (s.id !== sceneId) requireSaved(() => goToSceneNow(s.id), `jumping to “${s.heading || 'untitled'}”`) },
            children: [
              jsx('span', { className: 'gw-scene-idx', children: (s.meta && s.meta.scene_number) || String(i + 1) }),
              jsxs('span', { className: 'gw-scene-text', children: [
                jsxs('span', { className: 'gw-scene-place', children: [
                  h.setting ? jsx('span', { className: 'gw-setting', children: h.setting }) : null, h.place] }),
                jsx('span', { className: 'gw-scene-meta', children: [h.time, cast.slice(0, 3).join(', ') + (cast.length > 3 ? ` +${cast.length - 3}` : '')].filter(Boolean).join(' · ') || ' ' }),
              ] }),
              s.parse_ok === false ? jsx(Icon, { name: 'alert', size: 14, className: 'gw-warn-icon' }) : null,
            ] })
        }) }),
    jsxs('button', { className: 'gw-outline-add', onClick: () => openAssistant('Write a new scene where '),
      children: [jsx(Icon, { name: 'plus', size: 14 }), 'New scene with the assistant'] }),
  ] })

  const page = editing && draft
    ? jsxs('div', { className: 'gw-editor', children: [
        draft.mode === 'source'
          ? jsx('textarea', {
              className: 'gw-source', value: draft.source, spellCheck: true, autoFocus: true,
              'aria-label': 'Fountain source',
              onChange: (e) => { const v = e.target.value; setDraft(d => ({ ...d, source: v, changed: true })) },
            })
          : jsx('div', { className: 'hsp-editor-paper', children: jsxs('div', { className: 'hsp-page', children: [
              jsx(TitlePageEditor, {
                fields: draft.title,
                onChange: (key, val) => setDraft(d => ({ ...d, title: { ...d.title, [key]: val }, titleChanged: true, changed: true })),
              }),
              draft.structure.map((sc) => jsx('div', { className: 'hsp-edit-scene', key: sc.id, children:
                sc.elements.map((e) => jsx(EditElement, {
                  kind: e.kind, key: e.key,
                  value: draft.values[e.key] != null ? draft.values[e.key] : e.text,
                  onChange: (val) => setDraft(d => ({ ...d, values: { ...d.values, [e.key]: val }, changed: true })),
                })),
              })),
              jsx('div', { className: 'gw-page-hint', children: 'Tip: to add new scenes or speeches, switch to Fountain or ask the assistant.' }),
            ] }) }),
        jsxs('div', { className: 'gw-savebar' + (dirty ? ' gw-savebar-dirty' : ''), children: [
          jsx('span', { className: 'gw-savebar-text', children: dirty ? 'Unsaved changes' : 'No changes yet' }),
          jsxs('div', { className: 'gw-btn-group', children: [
            jsx('button', { className: 'gw-btn', disabled: busy, onClick: () => { setDraft(null); setEditing(false) },
              children: dirty ? 'Discard' : 'Done' }),
            jsxs('button', { className: 'gw-btn gw-btn-primary', disabled: busy || !dirty, onClick: () => doSaveDoc(),
              children: [busy ? 'Saving…' : 'Save', jsx('kbd', { children: '⌘S' })] }),
          ] }),
        ] }),
      ] })
    : jsx('div', { className: 'hsp-full', ref: fullRef, onScroll: onFullScroll, children:
        jsx(SceneActionsCtx.Provider, { value: sceneActions, children: jsxs('div', { className: 'hsp-page', children: [
          jsx(TitlePageView, { titlePage }),
          preamble.length ? jsx('div', { className: 'hsp-full-scene hsp-preamble', children:
            preamble.map((e, i) => jsx(El, { e, group: 'preamble', elIndex: i, key: i })) }) : null,
          scenes.map((s, i) => jsx(pack.Block, { scene: s, index: i, key: s.id })),
          scenes.length === 0 ? jsxs('div', { className: 'gw-page-empty', children: [
            jsx('div', { className: 'gw-page-empty-title', children: 'FADE IN:' }),
            jsx('div', { children: 'Your first scene is waiting. Describe it to the assistant, or start typing in Fountain.' }),
            jsxs('div', { className: 'gw-row', children: [
              jsxs('button', { className: 'gw-btn gw-btn-accent', onClick: () => openAssistant('Write the opening scene: '),
                children: [jsx(Icon, { name: 'sparkles', size: 15 }), 'Write it with the assistant'] }),
              jsxs('button', { className: 'gw-btn', onClick: () => startEdit('source'),
                children: [jsx(Icon, { name: 'code', size: 15 }), 'Type it myself'] }),
            ] }),
          ] }) : null,
        ] }) }) })

  const scriptInner = !pid ? null
    : loading
      ? jsx('div', { className: 'gw-loading', children: [jsx('span', { className: 'gw-spinner' }), 'Opening your script…'] })
      : projectFailed
        ? emptyState('alert', 'Could not open this project', String((projectQ.error && projectQ.error.message) || projectQ.error),
            jsx('button', { className: 'gw-btn', onClick: () => projectQ.refetch(), children: 'Try again' }))
        : jsxs('div', { className: 'gw-workspace' + (outlineOpen ? '' : ' gw-outline-hidden'), children: [
            outlineOpen ? outline : null,
            jsxs('section', { className: 'gw-stage', children: [
              stageToolbar,
              searchBar,
              reviewBanner,
              page,
              jsxs('footer', { className: 'gw-statusbar', children: [
                jsx('span', { children: pageCount + (pageCount === 1 ? ' page' : ' pages') }),
                jsx('span', { children: '·' }),
                jsx('span', { title: 'Rule of thumb: one page ≈ one minute', children: '≈ ' + runtime + ' min' }),
                jsx('span', { children: '·' }),
                jsx('span', { children: scenes.length + (scenes.length === 1 ? ' scene' : ' scenes') }),
                jsx('span', { children: '·' }),
                jsx('span', { children: wordCount.toLocaleString() + ' words' }),
                scene && !editing ? jsx('span', { className: 'gw-statusbar-right', children: scene.heading }) : null,
              ] }),
            ] }),
          ] })

  // Drag the divider to resize the chat column (width persists per user).
  function onResizeStart(e) {
    e.preventDefault()
    setResizing(true)
    const onMove = (ev) => {
      const el = splitRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const w = Math.max(300, Math.min(Math.max(320, rect.width - 420), Math.round(rect.right - ev.clientX)))
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

  // One stable tree whether or not the assistant is open, so opening it never
  // re-mounts the page (and loses the reading position).
  const scriptTab = jsxs('div', { className: 'gw-split', ref: splitRef, children: [
    jsx('div', { className: 'gw-split-main', key: 'main', children: scriptInner }),
    chatOpen ? jsx('div', { className: 'gw-resize' + (resizing ? ' gw-resize-active' : ''), key: 'rz', onMouseDown: onResizeStart,
      title: 'Drag to resize' }) : null,
    chatOpen ? jsx('div', { className: 'gw-chat-col', key: 'chat', style: { width: chatWidth + 'px' }, children:
      jsx(GwChatRail, {
        projects, currentPid: pid, currentData: data, focusScene: scene, seed: chatSeed,
        onClose: () => setChatOpen(false),
        onTurnDone: invalidateAll,
      }) }) : null,
  ] })

  // ---------------- Review tab ----------------

  const proposal = proposalQ.data
  const pStatus = proposal ? String(proposal.status || '').toUpperCase() : ''
  const proposalsTab = !pid ? null : jsxs('div', { className: 'gw-review', children: [
    proposals.length === 0 ? null : jsxs('div', { className: 'gw-review-list', children: [
      jsx('div', { className: 'gw-section-label', children: proposalsQ.isPending ? 'Loading…'
        : `${openProposals.length} waiting · ${proposals.length} total` }),
      proposals.length === 0 && !proposalsQ.isPending
        ? jsx('div', { className: 'gw-muted gw-pad', children: 'Nothing to review yet.' })
        : jsx('div', { className: 'gw-joined-col', children: proposals.map(p => {
            const st = String(p.status || '').toUpperCase()
            const changes = (p.diff || []).filter(d => d.status && d.status !== 'unchanged')
            return jsxs('button', {
              className: 'gw-card gw-proposal-card' + (propSel === p.id ? ' gw-card-active' : ''), key: p.id,
              onClick: () => setPropSel(p.id),
              children: [
                jsxs('div', { className: 'gw-card-top', children: [
                  jsx(Chip, { kind: statusKind(st), children: STATUS_LABEL[st] || st }),
                  jsx('span', { className: 'gw-muted gw-small', children: relTime(p.created_at) }),
                ] }),
                jsx('div', { className: 'gw-card-title', children: changes.length
                  ? changes.map(d => d.heading || d.scene_id).join(' · ') : 'No scene changes' }),
                jsx('div', { className: 'gw-muted gw-small', children: changes.length + (changes.length === 1 ? ' scene' : ' scenes') }),
              ] })
          }) }),
    ] }),
    jsx('div', { className: 'gw-review-detail', children: !proposal
      ? emptyState('review', proposals.length ? 'Select a suggestion' : 'No suggestions yet',
          proposals.length ? 'Pick one on the left to compare it with your script.'
            : 'When you ask the assistant for options or bigger rewrites, its suggestions wait here so you can compare them with your script before accepting.',
          proposals.length ? null : jsxs('button', { className: 'gw-btn gw-btn-accent', onClick: () => openAssistant(), children: [jsx(Icon, { name: 'sparkles', size: 15 }), 'Open the assistant'] }))
      : jsxs('div', { className: 'gw-detail', children: [
          jsxs('div', { className: 'gw-detail-head', children: [
            jsxs('div', { children: [
              jsx('div', { className: 'gw-detail-title', children: (proposal.changes || []).map(c => c.heading).join(' · ') || 'Suggested change' }),
              jsxs('div', { className: 'gw-muted gw-small', children: [
                jsx(Chip, { kind: statusKind(pStatus), children: STATUS_LABEL[pStatus] || pStatus }),
                '  Suggested ' + relTime(proposal.created_at)] }),
            ] }),
            jsxs('div', { className: 'gw-btn-group', children: [
              (pStatus !== 'ACCEPTED' && pStatus !== 'REJECTED') ? jsx('button', {
                className: 'gw-btn', disabled: busy, onClick: () => doReject(proposal.id), children: 'Reject' }) : null,
              ((pStatus === 'PENDING' || pStatus === 'BLOCKED') && !proposal.stale && !proposal.conflict) ? jsxs('button', {
                className: 'gw-btn gw-btn-primary', disabled: busy || pStatus === 'BLOCKED',
                title: pStatus === 'BLOCKED' ? 'A check failed — see below' : 'Apply this change to your script',
                onClick: () => requireSaved(() => doAccept(proposal.id), 'accepting this change'),
                children: [jsx(Icon, { name: 'check', size: 15 }), 'Accept change'] }) : null,
            ] }),
          ] }),
          proposal.stale ? jsxs('div', { className: 'gw-callout gw-callout-warn', children: [jsx(Icon, { name: 'alert', size: 16 }),
            'This suggestion is out of date — the script it was based on no longer exists. Reject it and ask again.'] }) : null,
          !proposal.stale && !proposal.base_is_active && ['PENDING', 'BLOCKED'].includes(pStatus) ? jsxs('div', {
            className: 'gw-callout ' + (proposal.conflict ? 'gw-callout-warn' : 'gw-callout-info'), children: [jsx(Icon, { name: 'alert', size: 16 }),
              proposal.conflict
                ? 'This suggestion can no longer be applied: ' + proposal.conflict + '. Reject it and ask for the change again.'
                : 'Your script changed since this was suggested. Accepting applies it to the current text; only its own scenes change.'] }) : null,
          (proposal.checks || []).some(c => String(c.status).toUpperCase() !== 'PASS') ? jsx('div', { className: 'gw-checks', children:
            (proposal.checks || []).filter(c => String(c.status).toUpperCase() !== 'PASS').map((c, i) => jsxs('div', { className: 'gw-check', key: i, children: [
              jsx(Chip, { kind: statusKind(c.status), children: STATUS_LABEL[String(c.status).toUpperCase()] || c.status }),
              jsx('span', { className: 'gw-check-name', children: String(c.name).replace(/_/g, ' ').toLowerCase() }),
              c.detail ? jsx('span', { className: 'gw-muted gw-small', children: c.detail }) : null,
            ] })) }) : jsxs('div', { className: 'gw-checks-ok', children: [jsx(Icon, { name: 'check', size: 14 }), 'All checks passed: formatting, protected text, cast and length rules.'] }),
          jsx('div', { className: 'gw-changes gw-joined-col', children: (proposal.changes || []).map(c => jsxs('div', { className: 'gw-change', key: c.scene_id || c.heading, children: [
            jsxs('div', { className: 'gw-change-head', children: [
              jsx(Chip, { kind: statusKind(c.status), children: STATUS_LABEL[String(c.status).toUpperCase()] || c.status }),
              jsx('span', { className: 'gw-change-heading', children: c.heading || '(untitled)' }),
            ] }),
            jsxs('div', { className: 'gw-diff' + (c.status === 'added' || c.status === 'removed' ? ' gw-diff-single' : ''), children: [
              c.status !== 'added' ? jsxs('div', { className: 'gw-diff-col gw-diff-before', children: [
                jsx('div', { className: 'gw-diff-label', children: 'Current' }),
                jsx('pre', { className: 'gw-pre', children: c.before || '—' }),
              ] }) : null,
              c.status !== 'removed' ? jsxs('div', { className: 'gw-diff-col gw-diff-after', children: [
                jsx('div', { className: 'gw-diff-label', children: 'Suggested' }),
                jsx('pre', { className: 'gw-pre', children: c.after || '—' }),
              ] }) : null,
            ] }),
          ] })) }),
        ] }) }),
  ] })

  // ---------------- Rules tab ----------------

  const rules = data ? data.rules : null
  const rulesTab = !pid || loading || projectFailed
    ? jsx('div', { className: 'gw-loading', children: [jsx('span', { className: 'gw-spinner' }), 'Loading…'] })
    : !rulesForm
      ? emptyState('sliders', 'No rules yet', null)
      : jsxs('div', { className: 'gw-page-narrow', children: [
          jsx('h2', { className: 'gw-h2', children: 'Rules' }),
          jsx('p', { className: 'gw-lead', children: 'Guardrails the assistant follows. Suggestions that break a rule are held back for you to fix.' }),
          jsxs('div', { className: 'gw-joined-col', children: [
          jsxs('div', { className: 'gw-card gw-form', children: [
            jsx('div', { className: 'gw-form-title', children: 'Length' }),
            jsxs('div', { className: 'gw-grid2', children: [
              jsxs('label', { className: 'gw-field', children: [
                jsx('span', { className: 'gw-label', children: 'Maximum pages' }),
                jsx('input', { className: 'gw-input', type: 'number', min: '1', placeholder: 'No limit', value: rulesForm.pageLimit,
                  onChange: (e) => setRulesForm(f => ({ ...f, pageLimit: e.target.value })) }),
                jsx('span', { className: 'gw-help', children: 'About one minute of screen time per page.' }),
              ] }),
              jsxs('label', { className: 'gw-field', children: [
                jsx('span', { className: 'gw-label', children: 'Maximum speeches' }),
                jsx('input', { className: 'gw-input', type: 'number', min: '1', placeholder: 'No limit', value: rulesForm.dialogueBlockLimit,
                  onChange: (e) => setRulesForm(f => ({ ...f, dialogueBlockLimit: e.target.value })) }),
                jsx('span', { className: 'gw-help', children: 'Across the whole script. Useful for dialogue-light pieces.' }),
              ] }),
            ] }),
          ] }),
          jsxs('div', { className: 'gw-card gw-form', children: [
            jsx('div', { className: 'gw-form-title', children: 'Notes for the assistant' }),
            jsx('textarea', { className: 'gw-input gw-textarea', rows: 5, value: rulesForm.guidance,
              placeholder: 'One note per line, e.g.\nKeep Maya’s dialogue clipped and dry\nNo voice-over',
              onChange: (e) => setRulesForm(f => ({ ...f, guidance: e.target.value })) }),
            rules && Array.isArray(rules.allowed_speakers) ? jsxs('div', { className: 'gw-help', children: [
              'Cast limited to: ', rules.allowed_speakers.map(x => typeof x === 'string' ? x : x.name).join(', '), ' (set via the assistant).'] }) : null,
          ] }),
          jsxs('details', { className: 'gw-card gw-form gw-details', children: [
            jsxs('summary', { className: 'gw-form-title', children: [jsx(Icon, { name: 'lock', size: 15 }),
              `Protected passages (${(rulesForm.protected || []).length})`] }),
            jsx('p', { className: 'gw-help', children: 'Lock a stretch of a scene (by character offset) so no suggestion can change it.' }),
            (rulesForm.protected || []).map((pr, i) => jsxs('div', { className: 'gw-proto-row', key: i, children: [
              jsx('strong', { children: pr.label || 'Locked text' }),
              jsx('span', { className: 'gw-muted gw-small', children: `${(sceneById[pr.scene_id] || {}).heading || pr.scene_id} · characters ${pr.offset_in_scene}–${pr.offset_in_scene + pr.length}` }),
              jsx('button', { className: 'gw-btn gw-btn-small gw-btn-ghost',
                onClick: () => setRulesForm(f => ({ ...f, protected: f.protected.filter((_, j) => j !== i) })), children: 'Remove' }),
            ] })),
            scenes.length > 0 && jsxs('div', { className: 'gw-proto-add', children: [
              jsx('select', { className: 'gw-input', value: rulesForm.addScene, 'aria-label': 'Scene',
                onChange: (e) => setRulesForm(f => ({ ...f, addScene: e.target.value })),
                children: scenes.map(s => jsx('option', { value: s.id, children: s.heading || '(untitled)', key: s.id })) }),
              jsx('input', { className: 'gw-input gw-input-num', type: 'number', min: '0', title: 'Start offset', 'aria-label': 'Start offset',
                value: rulesForm.addOffset, onChange: (e) => setRulesForm(f => ({ ...f, addOffset: e.target.value })) }),
              jsx('input', { className: 'gw-input gw-input-num', type: 'number', min: '1', title: 'Length', 'aria-label': 'Length',
                value: rulesForm.addLength, onChange: (e) => setRulesForm(f => ({ ...f, addLength: e.target.value })) }),
              jsx('input', { className: 'gw-input', type: 'text', placeholder: 'Label', style: { flex: 1, minWidth: 100 },
                value: rulesForm.addLabel, onChange: (e) => setRulesForm(f => ({ ...f, addLabel: e.target.value })) }),
              jsx('button', { className: 'gw-btn gw-btn-small', onClick: () => setRulesForm(f => ({
                ...f, protected: [...(f.protected || []), { scene_id: f.addScene, offset_in_scene: Number(f.addOffset) || 0,
                  length: Number(f.addLength) || 0, label: f.addLabel || '' }] })), children: 'Add' }),
            ] }),
          ] }),
          ] }),
          jsx('div', { className: 'gw-row gw-row-end', children:
            jsx('button', { className: 'gw-btn gw-btn-primary', disabled: busy, onClick: () => doSaveRules(), children: busy ? 'Saving…' : 'Save rules' }) }),
        ] })

  // ---------------- History tab ----------------

  const hist = (historyQ.data && Array.isArray(historyQ.data)) ? historyQ.data : []
  const historyTab = !pid ? null : jsxs('div', { className: 'gw-page-narrow', children: [
    jsxs('div', { className: 'gw-heading-row', children: [
      jsxs('div', { children: [
        jsx('h2', { className: 'gw-h2', children: 'History' }),
        jsx('p', { className: 'gw-lead', children: 'Every change is kept. Restoring an older version adds it on top — nothing is ever lost.' }),
      ] }),
      confirmId === 'undo'
        ? jsxs('div', { className: 'gw-btn-group', children: [
            jsx('button', { className: 'gw-btn', onClick: () => setConfirmId(null), children: 'Cancel' }),
            jsx('button', { className: 'gw-btn gw-btn-primary', disabled: busy, onClick: () => doUndo(), children: 'Undo last change' }) ] })
        : jsxs('button', { className: 'gw-btn', disabled: busy || hist.length < 2, onClick: () => setConfirmId('undo'),
            children: [jsx(Icon, { name: 'undo', size: 15 }), 'Undo last change'] }),
    ] }),
    historyQ.isPending ? jsx('div', { className: 'gw-loading', children: [jsx('span', { className: 'gw-spinner' }), 'Loading…'] }) : null,
    jsx('ol', { className: 'gw-timeline', children: hist.map(r => {
      const o = ORIGINS[r.origin] || { label: String(r.origin || 'Revision').replace('_', ' '), icon: 'file', who: 'system' }
      return jsxs('li', { className: 'gw-tl-item' + (r.is_active ? ' gw-tl-active' : ''), key: r.id, children: [
        o.who === 'assistant'
          ? jsx('span', { className: 'gw-tl-dot gw-tl-ghost', title: 'Ghostwriter', children: jsx(Logo, { size: 20, tone: 'white' }) })
          : jsx('span', { className: 'gw-tl-dot' + (o.who === 'you' ? ' gw-tl-you' : ''), title: o.who === 'you' ? 'You' : undefined,
              children: jsx(Icon, { name: o.icon, size: 14 }) }),
        jsxs('div', { className: 'gw-tl-body', children: [
          jsxs('div', { className: 'gw-tl-title', children: [o.label, r.is_active ? jsx(Chip, { kind: 'good', children: 'Current' }) : null] }),
          jsx('div', { className: 'gw-muted gw-small', title: fmtTime(r.created_at), children:
            `${relTime(r.created_at)} · ${r.scene_count} scene${r.scene_count === 1 ? '' : 's'}` }),
        ] }),
        r.is_active ? null : confirmId === r.id
          ? jsxs('div', { className: 'gw-btn-group', children: [
              jsx('button', { className: 'gw-btn gw-btn-small', onClick: () => setConfirmId(null), children: 'Cancel' }),
              jsx('button', { className: 'gw-btn gw-btn-small gw-btn-primary', disabled: busy, onClick: () => doRestore(r.id), children: 'Restore this version' }) ] })
          : jsx('button', { className: 'gw-btn gw-btn-small gw-btn-ghost', disabled: busy, onClick: () => setConfirmId(r.id), children: 'Restore' }),
      ] })
    }) }),
  ] })

  // ---------------- Export tab ----------------

  const exportCard = (icon, title, text, button, onClick, primary) => jsxs('div', { className: 'gw-card gw-export-card', children: [
    jsx('div', { className: 'gw-export-icon', children: jsx(Icon, { name: icon, size: 20 }) }),
    jsx('div', { className: 'gw-export-title', children: title }),
    jsx('div', { className: 'gw-muted gw-small gw-grow', children: text }),
    jsx('button', { className: 'gw-btn ' + (primary ? 'gw-btn-primary' : ''), disabled: busy || !!(pdf && pdf.loading), onClick, children: button }),
  ] })
  const exportTab = !pid ? null : jsxs('div', { className: 'gw-page-wide', children: [
    jsx('h2', { className: 'gw-h2', children: 'Export' }),
    jsx('p', { className: 'gw-lead', children: 'Share your script or take it to other screenwriting software.' }),
    jsxs('div', { className: 'gw-export-grid gw-joined', children: [
      exportCard('page', 'PDF', 'Industry-standard pages: Courier 12, standard margins, page numbers, title page.',
        pdf && pdf.loading ? 'Rendering…' : 'Create PDF', () => doExport(), true),
      exportCard('film', 'Final Draft', 'An .fdx file for Final Draft, WriterDuet, Fade In and Highland.', 'Download .fdx', () => doExportFdx()),
      exportCard('code', 'Fountain', 'Plain-text screenplay (.fountain) — open in any Fountain app or text editor.', 'Download .fountain', () => doExportFountain()),
    ] }),
    pdf && pdf.error && !pdf.meta ? jsxs('div', { className: 'gw-callout gw-callout-warn', children: [jsx(Icon, { name: 'alert', size: 16 }), `PDF export failed: ${pdf.error}`] }) : null,
    pdf && pdf.meta ? jsxs('div', { className: 'gw-card gw-pdf-card', children: [
      jsxs('div', { className: 'gw-heading-row', children: [
        jsxs('div', { children: [
          jsx('div', { className: 'gw-export-title', children: pdf.meta.filename }),
          jsx('div', { className: 'gw-muted gw-small', children: `${pdf.meta.page_count} page${pdf.meta.page_count === 1 ? '' : 's'} · ${Math.max(1, Math.round((pdf.meta.size_bytes || 0) / 1024))} KB` }),
        ] }),
        jsxs('div', { className: 'gw-row', children: [
          pdf.dataUrl ? jsxs('a', { className: 'gw-btn gw-btn-primary', href: pdf.dataUrl, download: pdf.meta.filename, children: [jsx(Icon, { name: 'download', size: 15 }), 'Download'] }) : null,
          iconBtn('x', 'Close preview', () => setPdf(null)),
        ] }),
      ] }),
      pdf.dataUrl
        ? jsx('iframe', { className: 'gw-pdf', src: pdf.dataUrl, title: `PDF: ${pdf.meta.filename}` })
        : jsx('div', { className: 'gw-muted gw-small', children: `Saved to ${pdf.meta.path}${pdf.error ? ` (preview unavailable: ${pdf.error})` : ''}` }),
    ] }) : null,
  ] })

  // ---------------- Welcome / dialogs ----------------

  const welcome = jsxs('div', { className: 'gw-welcome', children: [
    jsx('div', { className: 'gw-welcome-mark', children: jsx(Logo, { size: 72 }) }),
    jsx('h1', { className: 'gw-welcome-title', children: 'Write your screenplay with an AI partner' }),
    jsx('p', { className: 'gw-welcome-text', children: 'Describe a scene in plain words. Ghostwriter writes it in proper screenplay format, keeps every version, and exports to PDF and Final Draft.' }),
    jsxs('div', { className: 'gw-welcome-cards gw-joined', children: [
      jsxs('button', { className: 'gw-card gw-welcome-card', onClick: () => setNewProject({ title: '', author: '', format: 'screenplay', text: '' }), children: [
        jsx('span', { className: 'gw-export-icon', children: jsx(Icon, { name: 'plus', size: 20 }) }),
        jsx('span', { className: 'gw-export-title', children: 'New screenplay' }),
        jsx('span', { className: 'gw-muted gw-small', children: 'Start from a blank page.' }) ] }),
      jsxs('label', { className: 'gw-card gw-welcome-card', children: [
        jsx('span', { className: 'gw-export-icon', children: jsx(Icon, { name: 'upload', size: 20 }) }),
        jsx('span', { className: 'gw-export-title', children: 'Import a script' }),
        jsx('span', { className: 'gw-muted gw-small', children: 'Fountain, Final Draft (.fdx) or PDF.' }),
        jsx('input', { type: 'file', accept: '.fountain,.spmd,.fdx,.pdf,.txt,.text,.md,text/plain,application/pdf', style: { display: 'none' }, onChange: onImportFile }) ] }),
      jsxs('button', { className: 'gw-card gw-welcome-card', disabled: busy, onClick: () => doCreateSample(), children: [
        jsx('span', { className: 'gw-export-icon', children: jsx(Icon, { name: 'book', size: 20 }) }),
        jsx('span', { className: 'gw-export-title', children: 'Open a sample' }),
        jsx('span', { className: 'gw-muted gw-small', children: `“${SAMPLE_TITLE}”, a short scene to explore.` }) ] }),
    ] }),
  ] })

  const importDialog = importPanel ? jsx(Modal, {
    title: 'Import a script', onClose: busy ? null : () => setImportPanel(null),
    footer: [
      jsx('button', { className: 'gw-btn', key: 'c', disabled: busy, onClick: () => setImportPanel(null), children: 'Cancel' }),
      jsx('button', { className: 'gw-btn gw-btn-primary', key: 'i', disabled: busy, onClick: () => doImport(), children: busy ? 'Importing…' : 'Import' }),
    ],
    children: [
      jsxs('div', { className: 'gw-file-pill', key: 'f', children: [jsx(Icon, { name: 'file', size: 16 }), importPanel.name] }),
      jsxs('div', { className: 'gw-grid2', key: 'g', children: [
        jsxs('label', { className: 'gw-field', children: [jsx('span', { className: 'gw-label', children: 'Title' }),
          jsx('input', { className: 'gw-input', value: importPanel.title, placeholder: 'From the file’s title page', onChange: (e) => setImportPanel({ ...importPanel, title: e.target.value }) })] }),
        jsxs('label', { className: 'gw-field', children: [jsx('span', { className: 'gw-label', children: 'Author' }),
          jsx('input', { className: 'gw-input', value: importPanel.author, placeholder: 'From the file’s title page', onChange: (e) => setImportPanel({ ...importPanel, author: e.target.value }) })] }),
      ] }),
      importPanel.isPdf
        ? jsx('div', { className: 'gw-help', key: 'h', children: 'The text is read from the PDF and rebuilt as a screenplay. Unusual layouts may need a quick tidy-up afterwards.' })
        : (importPanel.preview ? jsx('pre', { className: 'gw-pre gw-preview', key: 'p', children: importPanel.preview.slice(0, 600) + (importPanel.preview.length > 600 ? ' …' : '') }) : null),
    ] }) : null

  const newDialog = newProject ? jsx(Modal, {
    title: 'New screenplay', onClose: busy ? null : () => setNewProject(null),
    footer: [
      jsx('button', { className: 'gw-btn', key: 'c', disabled: busy, onClick: () => setNewProject(null), children: 'Cancel' }),
      jsx('button', { className: 'gw-btn gw-btn-primary', key: 'n', disabled: busy || !(newProject.title || '').trim(), onClick: () => doNewProject(), children: busy ? 'Creating…' : 'Create' }),
    ],
    children: [
      jsxs('div', { className: 'gw-grid2', key: 'g', children: [
        jsxs('label', { className: 'gw-field', children: [jsx('span', { className: 'gw-label', children: 'Title' }),
          jsx('input', { className: 'gw-input', autoFocus: true, value: newProject.title, placeholder: 'My screenplay',
            onChange: (e) => setNewProject({ ...newProject, title: e.target.value }),
            onKeyDown: (e) => { if (e.key === 'Enter' && (newProject.title || '').trim()) doNewProject() } })] }),
        jsxs('label', { className: 'gw-field', children: [jsx('span', { className: 'gw-label', children: 'Author' }),
          jsx('input', { className: 'gw-input', value: newProject.author, placeholder: 'Optional',
            onChange: (e) => setNewProject({ ...newProject, author: e.target.value }) })] }),
      ] }),
      jsxs('details', { className: 'gw-details-plain', key: 'd', children: [
        jsx('summary', { children: 'Paste existing Fountain text (optional)' }),
        jsx('textarea', { className: 'gw-input gw-textarea gw-mono', rows: 6, value: newProject.text, placeholder: 'INT. DINER - NIGHT\n\n…',
          onChange: (e) => setNewProject({ ...newProject, text: e.target.value }) }),
      ] }),
    ] }) : null

  const deleteDialog = confirmDelete ? jsx(Modal, {
    title: 'Delete project?', onClose: busy ? null : () => setConfirmDelete(null),
    footer: [
      jsx('button', { className: 'gw-btn', key: 'c', disabled: busy, onClick: () => setConfirmDelete(null), children: 'Cancel' }),
      jsx('button', { className: 'gw-btn gw-btn-danger', key: 'd', disabled: busy, onClick: () => doDeleteProject(confirmDelete), children: busy ? 'Deleting…' : 'Delete permanently' }),
    ],
    children: jsx('p', { className: 'gw-modal-text', children: `“${((projects.find(p => p.id === confirmDelete) || {}).title) || 'This project'}” and its whole history will be permanently deleted. Export it first if you want to keep a copy.` }),
  }) : null

  const guardDialog = guard ? jsx(Modal, {
    title: 'Unsaved changes', onClose: () => setGuard(null),
    footer: [
      jsx('button', { className: 'gw-btn gw-btn-ghost', key: 'x', onClick: () => setGuard(null), children: 'Keep editing' }),
      jsx('button', { className: 'gw-btn', key: 'd', disabled: busy, onClick: () => { const n = guard.next; setDraft(null); setEditing(false); setGuard(null); n() }, children: 'Discard' }),
      jsx('button', { className: 'gw-btn gw-btn-primary', key: 's', disabled: busy, onClick: async () => { const ok = await doSaveDoc(); if (ok) { const n = guard.next; setGuard(null); n() } }, children: 'Save and continue' }),
    ],
    children: jsx('p', { className: 'gw-modal-text', children: `You have unsaved edits${guard.label ? ' — save them before ' + guard.label : ''}?` }),
  }) : null

  const emptyProjects = !failed && projectsQ.data && projects.length === 0
  const connecting = !failed && !projectsQ.data && projectsQ.isPending

  return jsx(SearchCtx.Provider, { value: searchState, children: jsxs('div', {
    className: 'gw-root hsp-pane' + (focusMode ? ' gw-focus' : ''), ref: rootRef, 'data-theme': theme,
    style: {
      '--gw-font': FONTS.script,
      '--gw-size': view.size + 'px',
      // Width of the side columns, so the tab bar centres over the content
      // column (the script page) rather than the whole window.
      '--gw-left': ((tab === 'script' && outlineOpen && !focusMode) ? 250 : (tab === 'proposals' && proposals.length) ? 300 : 0) + 'px',
      '--gw-right': ((tab === 'script' && chatOpen) ? chatWidth + 5 : 0) + 'px',
      // Courier is 0.6em per character; a page is 85 characters wide.
      '--gw-page-w': Math.round(view.size * 0.6 * 85 + 2) + 'px',
      '--gw-paper': (PAPER[view.paper] || PAPER.blue).bg,
    },
    children: [
      topbar,
      jsx('main', { className: 'gw-main', children: failed
        ? emptyState('alert', 'Ghostwriter can’t reach its backend', String((projectsQ.error && projectsQ.error.message) || projectsQ.error),
            jsx('button', { className: 'gw-btn', onClick: () => projectsQ.refetch(), children: 'Try again' }))
        : emptyProjects ? welcome
        : connecting || !pid ? jsx('div', { className: 'gw-loading', children: [jsx('span', { className: 'gw-spinner' }), 'Loading…'] })
        : [
            tab === 'script' ? jsx('div', { className: 'gw-tab gw-tab-script', key: 's', children: scriptTab }) : null,
            tab === 'proposals' ? jsx('div', { className: 'gw-tab', key: 'p', children: proposalsTab }) : null,
            tab === 'rules' ? jsx('div', { className: 'gw-tab gw-scroll', key: 'r', children: rulesTab }) : null,
            tab === 'history' ? jsx('div', { className: 'gw-tab gw-scroll', key: 'h', children: historyTab }) : null,
            tab === 'export' ? jsx('div', { className: 'gw-tab gw-scroll', key: 'e', children: exportTab }) : null,
          ] }),
      toast, importDialog, newDialog, deleteDialog, guardDialog,
    ] }) })
}

const CSS = `
/* ---- Self-hosted manuscript font (Courier Prime, latin, SIL OFL) ---- */
@font-face { font-family:'Courier Prime'; font-style:normal; font-weight:400; font-display:block; src:url(data:font/woff2;base64,d09GMgABAAAAAEjQAA8AAAAAq+QAAEhyAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHII0BmAAggYIbAmcFREICoKgfIH+EAuDQgABNgIkA4NCBCAFhDQHhEwMgT0bq5cV7JhPwMbBAJ7lSxFFORk1kf1/TnIyhjA7TE2tev2Qg0w4EKq5JTKp71k1Zl9Hx15PUWLUbJoNluCeo14w6zbEZrFYoomEG4vqxlk68f0UPzRfNByRSThpIh02CD+Ww91Q4TWkxg6lcCnM9MZrqUrhG73/0aJHuNnkVV7LjtDYJ7k8/P/a//a5Mw9TqWIWSeKJRKLjyTJZNGnS1SX9RXOdczW2dhczCwU/pjOErFcxyx4q/b808PaiifjTfwC2KcacYkMrKBKlImUjrQ0GBmUBNoKBFbNqm9grN5fOlUvnMnXZX9Vj23vwL9v7cpIQLrzxdbeaW7W2EqMqhCs84n7ky2+T0j/CHoxZA2D89LQmVG7GkTsgAMfWLWRoPkf9LevVXCa54EHyYHwVKvHAClBVPdDZ23lZ16lVD1TFnNmp/1/OPu99UK9Ktj+DockDCBrwD3QcUmtIqVXCSx8F3Lt1lgMRzO1voiWRKFVCUh0+RDWUgP+8Or/OU0QCJEG2SQ8UkIgS2QLMJYyNM/4RNuSinqLa6m/XzOR2qmYbnMp78Py7pZA6/2RZq1OnFTtRnzrsiPXRk7hAahYToO5z+v6gXebWZH2JU6VgXov54a0Qcyjsf+pKb6CogBR4yg/v2AE6cEimQ5CC0q1vi/qKWl315GNf83V2GvSpNUuWL8Vv2Z7+RG93gWiHZWRLZymA4JW0Bk5kB2hnvsSi+qIpDj+rc0GINiePyEKMs12IbfTZmvtf+TGhsNKFzmGqwIC1/d6MBKH5IV7a5t9Us/b/wUAIm0BH7GZ6Uy46kKulaV+ifSG+PhXNx5+PCX8GA2IAjElgwKVASiZBngUClIwjZT/MANAbjEA/EqKD5BzpS2kEhcTN1EY6pFBeyLG/onF/bX8u2ivKIm1Tw1MB1y+Et+UaLIPMMOb2/PlTax5gsDu54qYoBoQQoIaEZOOyXsj9Zu9HNvvadOCrjngJViRiL3Fod+8+AQLopKaR1ZKbcckAzu6ynCIA/UC2yQCAgLBYfCUZAwCCTEZAuHwMKJZE4ouC1v/FYD8A4r+LDhi1egAGgELGUinQEcCWtSdIK90sGQGbk753eRB7P9+QZMRTwqTXfGczVvTgLKmJTTC57iBD2XqNYGymiyAgyXA5Q2PBKI+nxDO5sj3HbgfMnWLsUj/jCpaA1ux1EgDnY7HEQkuhor7e0XZweyfZuDVRADjBcdSCDX9bfBM+EDB7mHPPUV2KUwCM4CzD4fI+rGCPtf8vnRkwrGk5Wpg0bd7PmCmy4Zw8kEePIBg3jAcGiyFiWJgQjBgzE8BiQVjoz1R05TVpve2OBEOSqC8HYxAY1NMwMcEf/vye/0LyAUDezY2p3/7n//6/t89m7bLTdlvNGNHP7+nun3xyHmAh/WaY4N9Bz+ndVczAqESpMuUeq1CpSrUa96XKrJlWz5ntFXa/NyenJNYiGMLGDLdGhNUuzTGb233fkoXZSW9y2ba1AuSX8bLrYJV6+C/0s20csHwBY3OZyt0vy8kh/Rc/Rfz8TCHCZUJsM+1EDpTWxIXYSz2AZSJvcjKQ12lOAaJF5xSB/ljcupWZijnCe5OErcokt7+nwJ0jMOUUWIWe0vXRIPR69IbNxQNNgdVgbI92D0CBYoac5ipvhDjZQzcUVWgNSHPEZIGWkR0UY4UPV6EH/7imVH4NvqbZTBoqndUUw239toVzVTwbT9d/SzRoXJxmFy8OCbaFnj7FMJRjQhpSgT9KMEX8FjagSz6hPJ/qJ2YGZiPeubJTUAimOCE+WOIpkfRZVMTUy+tn4cKSCdH1QhaNc31wZCkx6YF7iCxSjMspAw0oRehBlRuWqhsm4qjSunyi5lS6GjHIYlLnBgVYVUWJjv9FJNZlG+WZhodPRP7/wyhTOHQplU3rN1TYclacdiDdWabKJDExjpRTBTWOBwg2BolSzY2AGG8VKMynZN8jVGddVgMkLTU4uZBE00ngLFVXnPJ1eDwdg7Yposa81k4DkmYnUlINjLIU7WiUwqOJdkPf0Roq1kA7mhPUWSMUI6vU9beTrpqkUwFRNwIGVuZEx+l1sWo2rFai3WvtqkwkodfxP5ZtOS10IiBrcqlydCm6cbQw+EG2+gpk0Mp1yAlxIYk22o0ZesR/mKBbICfMYnnHJumndk+ZXshRAnKTm3Z5e5FUuvPkrplHQrbaFbPTArJmmEmnTlEIk8wltKrIdgQUY6Sp68ophYnf0OY2a6blCY8URQJCNHLrKUeT3YIwqlhYqhH7nTYBOanJSNwOTHX18ArIEkKzY5l1g4aGG6adYjVgPjmlJ2vn5b0RXLMbmTHGCGK+Cuffg5Rf7vJ/48MnLmcRCYWxgBLDQJkRwBUjgmtGAhVGBlVGATVGBXUmARqMNtaFWKErlbq8YwUF2cc1g1p7r8BXZH8j+z6P/fsx4sg4lcpiPdlTPDfpBpuQwxY0aEODDjToQoMeNNiGBn1oMIAGO9AmBkDptWA417NcUclRrvoVCbrDjlsVgsPkcOZ7IwBdfZsWJMzI3b1xIlWagxGZF5Ix6tzucIxmSdbtxr51GirjrmmcPDEBPkmdnyKDfXT8UOeYcgh5BRRPkC44fJOZNNGCnj8mM6BEJ/sIsW9+HeWco7hT5lyUQ4LUaGn1DZIgsGcofJawr5mpxfit81AMsAdq6K12MyyUbd98TXNjEEWW3kkp/nBlRlJKjq5Jjg/jwIEyLqCfZRpFU8NUEp4yC/5jYKmmG3ss2XWupmK5fu3McDujE9GmHpa276jwlqV+yCOPJheJvhfKDH0TPSSDYuqHO0v60SAwdivShhkl1Nk+ttDMcdivR0QFJFGpt8SoHCFalshSKgIwIYlTbDit4SO6t7oygwQlIxcYkXLm2rdOUSeJLeAWcQ+qt/mcIsTIKLnFJ1ugFK2EBYVMcakwqcSpZfEFhliwrqfHeoq6u9s3Uqi0FfW/5Fiqy9u3SBAUBkTxxCXaDbXlLEpXpFDz40zf7dNuqY1979gapn6L92CcrZUewGVGPmD/WmVclJtDhQVDM/guhaJvKsXoI4GpnqiNN7sKShQy03TlHZI+CFN+L7vzf4rOg7E++B72hqXMKO0rGe1kBPdjiMcGkY4nNGS0zDrIjPrwQSlc89qAm1u8oflns615nHpCAjskOWfxOS/dzODlWCg2ggJttJuhtFc4c5Iv25w3JGtWAMs8jDIWIBYEAOOMBU2Q4XImiQGkggBgmrEYz/jslQEulrKDxwLkzgIA8x4LWtgxwRSZYEoMMmUmaIUfXMpU8RF4QQCwxljQOhmuYBoYQDMIALYYC7ktE1zCdLgV8M8CALseC7kHGGDfYwEGZwGAQ4/FzpHPHuFYTx5jyd2hlp3AMJ12OBfAiDi7jEMGcy+ehRewfIaENQhXbBhcs2F0A2QLt7Et2HkBey/S4e3jwiPLhSeWC88sF15iAK5ewM2LdAcfDz5YHnyyPPhiefAdA/DxAr5eJn4+s+7r7QPfrbh/0Cyrpa9xXu5eCoXQe7eV807EP65+UHfxBVjA/OkgDbTZXNwHwEeAIUcBgDEnBFAtAVCGAJj7EmAljZcxEkk0OeOHnQ6QQgIkYCRWBFDvw0tbi4QkNCflVwiaYrSWgouh0MwSayxHhGNBgGpSnp8JrIgvIQS0iJpj7eO8qQXpBajhZSIQiJkEFB5zr6tlnmk8l48Nzcpa30Ns9DTnM54xDHDh4cYTpzWrWvVoEg0azlx3H/tr33jqDqSGlhhfJVfz9WHvfeJtblktLbbWiWdv4E8PR6+cLdeN7DDlWWPPaqqT0FrR+v1uWR3/voleook/P8Teylh5hrnU/n62PneN26xhWFZvqOcsq65tP5Ib4So7aDYb55FsQ6TkYNXdF8Pflj+ovO9pWleLb9TkRxEsehSDhyVaW001yzw35RtGJmN8P1vK5axTMlyranwd5uA9juMas4iaYP/GpKKdjqNjbVNqPW4OlTuChrs8/KhgC1S0i0VsmjK4aQEbQ4dXQBzqfmmchRtAB5fD18LocoNwGvpGE44ckxnGxNVps53RDIY7RmLpJJ/nJ1ux2cNrgDJlS8BcIYRBPeGfNGlyfUMEOMej29QbEnJUI500suIpuq4pCVKW0UZWHNh7lwn0Qhbk/rdCDmH1DFQULs8I/OMIX3Psb39gYluw848/QIg0SbYj7AS/104z0jORGEaEQcQRqssxi6mAQWffrW10holoTEXIRhRWV3wXlbE4zAp1lHV3DzDUJWofUR0rv9ArYanP8KLmmfjmxHe3EHoFFI6Z3iiZQKXWev+F3ig3EpQnqVQN71w0NbqcYi9FxG4FiXFEboz3MD7lkgHdUk2FR+5SGuV7XnMTtkeLiJiOEDPJjV+v6pLwXtmTIPRTmgI9ham+FOUzKuboFL+4Q/DpEGCjoGoyazgq3d7h1yUw8kQB6240NzQunMSg9UekbDAyGqSHWS6Po3avEChT2gQzGhLYGURvwtMK1qPUuhOzANwxLq1QPgQzVQ2s7TpifRbXjnFOK+uwpzYzuYXq9jzMFzPlrcCHNQq6uSg+zWBqe3pUpsHtsma7PvxgqwowX/X7P/thFGxGKDDbCZuMuBaThoJjNeCoTisc1UnETSk/eDCDb2lvff5nXq789qkCPdyyw6zyndc+gkZ/WAzniiVN0nHB0x6Z4ObQ8Z7WNcblZ6rpAtuLlbJuTqW1Q+5XDVcwZSEleVGWbD/LIUoI7QkV1wNynQfgHh5vtIDY22BLxRXNpam7CrOIcD2vgK0TRCtlLxKP+WAb5pZ3HCxlS1xk+phTTya89pIY8Wlh4n7xFkfN+KZmi+M8yFFDlCJyeTmOQr9p2HjZjlXqDUBcQKWmOfKeE52vlPZJXIH59TuiMA5nWd8Qj6McA4MJnRvB0PjAH++PZaixcke/30ZWoTN0aqTLq6PGJLce8rKTTdaDEW48cXQG0gVBMU2N288LpkblEkewU+ZEFw0JJYaG5lMnwcI4fpkHQKYNwhp6AwH8MF0IWTMys7Tnz3dxWg61ClAyXl22CKNaylq251UI+pIMf1Pk0NWzNdIXUAH9MAM6J9p0tDm4O7wFrHk1B9sxMW6M6XpQkGehn2EP3mbhLP0uU+StXdK1fbntfD2e/htjx5aszHD71Ihr4Y36tBGfJ/6MRGdIs26PvjMKYDoVwb/AvCoCR3ktyLBNwDFRAyIEqtltaJO6n6EU3tfKZjwNO3KbCCp/HquAWcISAolVeI5ImpVUaB0FxjpZ2pidux0csDZO/d5juI3tdzagAthKX4tO5RiVOuWijzrV4v10ynq6O9Y5v3rSbD6majrlnP+cMDo2hshhMIlPLvcHIPfFbuWE5i0W1ie2o829zY5jJ0oCS130r5GWzRRrRaI83Qw3zUjKM2K774E8qVCEZYspiXJNcWS/byzkCY8EovfeYQgCmQiV6nAauOKcjc6xdUpZcrDJARmx2K1x66Q9IYrqXTvdy3PjIO8VrSUucWZ3YJe6ZVNPjdLvHQJKCC4MDOOROUQp7PRusVcu3gJJ43VQoaGDCZ0CSGSZLoMuSu74CcXtxYsrvd+4qKj1p13do8ZkI7VjYF6RFBFesiSmAwrwqnCkURQ6TU00U+UYJVkRj7yy0uMijvFbrSnUfyp8sVsnk2tJClnXS9AMV9d8H0vBpEQ4tlo6tPx9Vycz6xzdyTV6OiwoAd2cvDl//nMbPkLODLwkVrNAjovpHf6IIzmM+pts0VIXTqYB7wsnBEVQiMrcVtvJ9AgE2+SnsY9svb/0U2tkQAHjJN20FVtmK5QtemR78vy5Amb4dtFPLUkNd46/18RLdynHrCWwWe5HV42nHBoRBoZczM0yQhgcI1c5Fc7AHH4R0zUsjZSsSIk9x6AZDSmhkr3K9iP3fVLEdl07juNr6gkRwRHksAndwShL6rHwKM7sAKsiJ+yKClDorp8AhEBgAqEDSkOKfxNnQA5LQ+kTKQV3U/6ACI/Klo4wXr4VDPAwPZ2jc4ZX/PfWyBlh39+X7o/Fp6+JnXEKBDXgicwqbGHkdlAzByUyU9SrBrmK7wlyuj/ugLQAqbcqXpTA2QKZxa9gkvrBQyPUDcZcEzcA/C/OzHAgBDgFIdf83Jw0C53ReaWmptFmymEbGnrVkvVpDR/YMGFAv1lAJKHQTJoHkoLwJEaIiaqE01R5pgqJt6nSo5nQTnlyFmaOZ8O7FVgQFL91+kDDjx4k+KF/fmH//4i1/LBUzyqY8uhmhQsxldE07kXatWbAOPdu79TOFuQfZ6CF8fKVHfp6MTouKWqQPXNtnOAYHfA3g2lZFkzzcAbAg3EPqa4pvsgvKegRE11gLOlL4Cf+ZQ9ZLWQLVDylIy8jmgwmjuSVqrke0AvscbhcaQFX6cmRCHyZeiODgjhyZO6Gxl3L0whXcKCbbxSBY8CWUurhuuDJHQmGALf4YUx+eejgr+OOzh4UiecpwWXwkL2G+4PrTMsuENvDh2k5b4SH9uYsqPhbBzliShSWGhBL4V/yy28h1gISimpp/9vJ1nCADosQNAE+P1G3EEbz9GDgP3Ia5Mw5J3Kvr8sOvCSM6rMB1T6arxcxDtZBuNIvnpq+nG97sJyDZUDe0MZM6TCl8jwzIQqF0xIxD67YCCKuBYkE7101LBAM5KsitHwyE217gWXGES9B5r7DonjQNvjWlvkSSMzXugiLJjUzzjA0wHo0ZrT1eNRg64m4sc7GEtDqYdYkFEgHOjDifJJgyumf6cySjAn/Pt1Bk7D8yKfXW6VFdMwZQWXfpfK2Od/7LSES9JDrgxhCnBAk+ZrVqm2h+5OtiXrIG1Ai68PTlh/FCtA+c8WBJyTrzGm6BtJAyCuHJDaaSbWZdjVoR5bSyeygZhBMzuWOpPATk7mfVswItl7DosNVtpDYVfK1ZdYJk7nKM9wyTohEz8Yjo0ZDSPoaCb3b6X9tXidispwWT91WRc5xKyhR4sASFm/gEzEE3FjycIUQTUjKEk6qI1/adsBVnsQZ8y1Sl2anXAc+5Uf2u7wI8hniRl5b3o2HKj+rgO7++HVBX3GZ29JgIeMj2cwC8oCNafHH4xnP7O5QTsFouJqhpzaV0ipw3txKJeJaLxnY7vQBUVuyzUWWqMW5rQQJpkp0Zty+GNHfg6tjEByL8Nt10ygaw41v3WRJWnl41OlR1wV6l0cGTzwkxlOAEYvlNp/5c1pTGccvVmlqO1bfVholeII7zgDzXb18suAPiuetar3iBJ/W2W61wQNknmxBzQjeR7ybPJ8a4SvqAgHgf5SwgPXHQnWaa3n7KeCpeRbv0eA3uqM14fb47VHQUidXKKgnen2cr4ruAUFdnZaCFKSWE6wd6VBiy3zTLcQ075ffApH0U7ALbm5vbfxOIQPhLYDtzQx2AjsjFO5PkxLJyj5BIp3AnuL9cQS7+G28SOLznoFRRxFWyBgPm4UyWSieLWOPP+FlQsABkZAlwciajjaDuKS7N3JyCsYJuzMDnhDli0NTKGjcsfkhYe+Hlg+4/Wh0jHWPR8mLlfLUts2xFRazWCcCwXiDo3WI5OQg+PVhQMva3WNKUuRO8GXO4agoVEKuLE1ZP8nLXd+8VzaYcsUcTGe9dzzwy++TxUlC7Hz/sWQ7502Il3MN0dENMTHRDYJ8LTr8kSa4W20PDF4ZMMVNiQKIiqqrYAGRKCCRIhLka9Fq+sm1rIa4jHpPDU08N5InJTUp8MFRxtKKAxN8KRI/Nlm+Fh9NSvPUz5HXYBcIhAVsOq6GkaGvScY+emX0a6lZLaM7C8YUCSOqnJw1ar6mvE+RtHJUprt5i1MoYvvKEv38K5VGa8JnmulbYsBJircHOpQi6OqjsDGA/ioH6HJ2vQMScmGm9F35z593xh2lFyBIh/VnXYCbaqLu/NaVeOFCl+zuH9VRnngCDNAePYuJGtLVTUzIjCoQokrbDLwXPCniucVoHPxndXVF8NcmgVDQb1D26cUuNGHNLTdqf8cfwbWf6nZrDQHddXIRzL6pQoGS1vIRrgXm0y3g1kDceWoyeZ/lR2xwsI74AD5a4fff9wEB5OxkuPkLQhzFtHZPf87cCD3lwU/qKU7/jd2PeO7wrhEPlaajooLfCjKMUBYGtyVTbYqMODj5fOIAmm7uxFg+7NChfOjxsWXLjjsIFWFpdbPUXG0Q3RgcjOHq4vj4WFBhiPfhAbraUDZw+mA5Kv+csHPC5N+FYZ9XvwmFwK64/fcz9NvmdiZlrinO1U0X6uOTZxv7WDpVLB2oWZ/45eBRVXpMfVR6pb7YkBVoKPqkmknGKPa2EKXeBzK3PSF9SJcaXx+FVxJ0K3OLszbNqZZpzoukwbdREIdxjAtKQB8PktYvM+XmtRRWRkty5MCyikx1SkWW3pRAFNV49GLYxXsDabtj2bo5aZ3AxoZnbUdlZzw69OwJnNZrzS+TGWji0IXUpV8Cgk1T2V/vbjjwtYHl1bty1PsqKvIOHS9ozDrJkwa89ID9NYFxQfF9R/1jE6v4XJM0JqTUwIsRF2Fxf2GpviDw76D/KLCIUOvDr1ieVBc7R/R395ss0Wh0qmF3um57iT5n+nBmTfEBbWBGXOvijkEW/8oPYFFpeQA/ixfBLS4Li4srDQzLFYdz8kqCpBxu29QCAZHpttGzI9cdfwXhFIMs/+XBoH70jj4PIcnn5dzW1MxRVaKqKZqkphiHNXkFG+fSTaaIZDhPcx5WUbRhZdMdyiNLdX6YOcsnUBbEimGNH4cTDpSxglBaxY362+jPzeJ+p7KNAdHRiCS6i1npm4gW+5jmRG17Uq3lsWbZ7dHbAzloo2+ujKz57ORTtJ+uaH93p3KGwK5eyoMgr9Z1gnDyVi/QQaWXazB9ZUNvJhKZ2bu8sidflnRNrPRa/nkHXTTYTNdGcDMfVE9f3bfV0qS+9FRxbYdS7+OwPD6M5+dwFvzGRuwej1EH+0QyYnUKdVMaXmGF9Zugh8+PKI9YQJzV2DKsOixs//Whmnkr4HVPw49JU/hsk0YmUAsMLGG6kMdI8PfVRahSLq7sSEmlaD8rwc7EgPywON9CJLURF5syWNOSeWx3bk3Xo6F6i3XNiiM7curC28D8UivUFQHQvSZtxD1x3auW2t+3nFobAt27I3QqWR7UE+kX5sFIVbK6hbQyvIraNuW0BwZ+EKazooH5nYmfXiV9qvmkSGE2CLLXPL/evBHfeRjVNYcK8huamopPWpEdJzb9UeBVMmIsUIxuT6wNLGPUmmuPm/v28q/F8opMubo8vWLRbFfXVpC98I9TmMB6Do2L6ZaPjZhjbBCm6zeXqm8ODKTdWF+q1+4NjgxwhHjkouEer9T8BwLT6rdjjdBDB5fB3o+PZqzkuYU8cxXR2VOfBlocDhxosZf0mrutGSXmkpXrXUeI++GqXfmZV8zmeKhdBVWHvYXrd6JxFF1pLDZyzbmhVOiV/yU54mF4uaUK94lM/oTjwrTKcsz71c34oGhoqoS1/Z7OwDv/N/5ve9uQYhlm2sz3kamuZXzxXLmCZdooh5/ewE4zTpdm3hwYUN7YXGrYVRf0y48Zu2PTGHsGK5F2m16x+vNYC+zggQ745/GxjBUhNgwcmhIT/sfdx4gyR5VVQvY71WO/jakv6hOfUP5buSEKY9fxOIC5sccMiBkQT45QIoaK17m4sOvy3jNlhxJ44b9h0DocwVYWM9haUV6zO4Xy3H0BGwvbMFTi0irRvqFp3WOCMcn/EiNZqBJnlpQT0bPMK1VPkGWVRuFoVAn60SOf+67TVuvFNfJetGP/TNRF4hjffZO/mb9Ei2Drt2Vmg7mRPJUZqdcbMy2mzAHq/zEaLbSsy8GnduDxO05dCbaQsYxFswEWZjPjfMybiOMJj7MeZU3Sb4rU+uUHf3ePJ/q/xpSvsw7qF9EQmSXxUZ7BdjSgpxKsX9YI7JJNx899Hm+BHTwYw5/HVq+Ood3HVxebN5cqXUAyALwBb27Ah2WaOpqu2V5aqtl6VN3+gfK1JieylqfAvS+407uyobR8sKnnjn8rpSta7GdnW4Dy0VuNKm3uSPCMx3RuFTuRyHHIne1A5zd7HWBumRO5OJbblojSELEdWW+ia2y9fFcinXr2Xh4P3oldrIT2VQbzpgLl+e7uGN6UbzTG0B9ZgXGOrpualalHc8rMa5pRFfy33gnTRz7Yd2NRnCQuMVblGYkW4KPM92XU0K66lshpcGD4JP/9Dn7Z6XxWZ379bV5Y2xwa9xqHphDv+yl3ZBgN1TmplFGtVzpM6pTiooNZacklgw352auPpXXopqO44dK+l3zm9533O3L5bF1rc1exiseVziUoIBLnRGeD+8t4nLxWl6cZ3Z1QKp8SjYfZ5ieKkqcWCDUVJ/3tzR/FUAzh5EezvX+2VHPSlew+L+UOXn9w9cKFaFwf5C5ZcWlJ4/iy9t5eyI83lmQavjHJFdaRwMq/nvL18abtgYm+xiVs5R79YJwJLDPp1nmpbyyPMw2wnfoq6iMngfmHxIfFEL6M1M+0lX31xri8C+/SRuQ1H/skBIOTHU6yafWqdzJ+UFhTwN6jeBbimmsW/6+31svEXpOrfhG4K7zReYpHoY9DOUin86+gK8Qqmu4Fq3zjFzoFLeLxsEv6X2P/jAmYegJ5t+Yj11DKd0McuxImSv9/5sNuUVgz3//KgGEzzwLYK46+D9G1b20BGy+0cl/+SCIB3h1JAQ+X4YxUmyKyLTyMDF+92oCAFHVpAvdsLZmMn7s+yJIq7F0Pp8Lg4Cuqj0+Di+oKGA5LPexqr1DXGbyOIkuu/buNSt3mcMdh/0HAMPcZwMhaOcIJWfFA7Ya+Y4sFo1Q/kQft7PyWTQPxQpx6n318gZr/JDHymKQoZ0Kc1qpa+3xk77oVzJRsvbImdj0lCm/r5JW5xQUnlHmfoGUf/6dNmhqtS1CdX7exWARdBYt/CfHHLBAWmzceqT9tMj4YGopIjlav2ZTGTUwgLGDX3SnjLs+m6qMIi5546Wh+PiGqUiiakoWjWi0g2Kl4wSuffay8d8N46Y0sRdZoSsp4VnbC2GBKlnomKMI/HoTuegvHfY8PvS8qW/6goephT0/NQyjrVwzxQzlP0UpuCmaBkJzUEtfyGgncxE1pGrm2H2ne2DvgvOhfLyy42xVSvVdf0K1mr5iKF5Z2YC9jb9kMbRgbVu+liYi2TrjkNlfy/jjidb/C0dvlxvsjy+FDcre6t3bFZD3CoIWUjVS38EJyCK3MX+n2tHt4+zONdMOl+waly8U5iXIgyJ/jnDv+TOs2HTq0pYoCnu229xqzSjd9XNGZdRqT7FFMcqmCkeynJO7bPeN7elvKLtatOll/2mBc7OuLSKrrpeYmqbBPpQIEVQpFT7S0LysLEPwxK346BhSzQPiNnzWdq1W1SyPN2pdJN9BvU31bkZiXkDKYnba90EOdnUlywd9ob3HEZNdy7ai/KfvX9UTfPIbRpTWAD14ZUR8fSVgYSrCM7wqpoBKsxAoUl60R7OIaTuZHxq1oAw4fOSHcR8z0i0+lTWgFwQunFVksm38uK31acYz/ANVS06syIsQ5Kle5fF9/qDokoFruwT3Aws12wDl9uVE6YbUgZ3dR7kba77MP6+of9fZGJMu7u1FVlnkwOX5Mo0GEy7Ozg1flwzDPemLrzCtD51wX112NxnzFOO73FeE6E+rqNNN7W65Gavb3De/namdFpCoiqDOK4HweGKTcX29arDiVGLBtxpq+pqN0xR/zkl9aZ+t4ZGwlZ2p2Qud+UhOnhI3ZejEX01kPTLUX22QBK0HC8R30/Rl07Iyu1U+FXpnU+SPGZW5J6zPVySKw8/1UpVO4TbpdA1Q8wlPMngw2+z7u5nuy59A4n1XcN7lKXyYt0IjM/mKf+67YhotgjJWEfpwrm169e3fNZTK9/EQdD+BMrT4lrnVp7iqhxnYW1wDcZkf2PDsw82og8ubqxS+bJ3x73cCgS5/z3nIfRzdodukF96ZNhvjGmstuEHHmrVlP9HbaM7ZnYs8emjdR3XriLQgU4nq9uuXhmxd1Ck/e3U13zOE5MAkKCf+deU0BOYifxHqmrZn1xeKzRfxL3ppMcTIhIJJit7ibr269Cnzy8bL/jeAizRH8trrRiQiDFSbZTyDMtC7xz2gR9xRf5elyJZLhwFD0sHmsXdDPste/mumx6JX0PjPP44lmw/nhLbw/c2UlB6p+Xm22sDqYXmultYy0rjKsbmQBG/AlAwYYcGm1A7KppXzgobbOxSd79+FcgbXuDqXtJSuCjfa2NpggdtbRaMe5R4cu55O/laFxABtZ8+Q4TvNsV+tVc45o62g7iMmq9DKts6K9pNTBHVjritv3ZO/Fy80OtJQ3IR2WVgNhhpKBBjywkWVYbV1lGWmlpddWBxcu/yXMefhER/mxMtKTlBIu+w0G4/9AORXSYjuV0hAtRUAqicYQMw+Mw/WPnh50Seub6dV1kgXXI+G47wLGLl6G3YHpzHUPNDgeWZZzrakpb/FIS53jppzyLXxgMaeRo57w6OuWaNDnOYxG2rb51z7u/si+buT1mZQSB3Ocs0nF75ZpfcRzUwFi+sjinUloFYEymncCg4qS3K9DviV8ymD28N39feEIMaag+gk+Ji6wHeh0c/Y7wnHzyIQOT3cnb3UT2BHzTfQWW8yZdWjwvEGnXJWKIP8u8FAzQbgoXHaIOtk8kaybEmc9y4XCr1yBQ3MHBnKFbW0RCX9R0t8fmdPRgQibJFelTQqqKoUSCSJcHhuLEtGvaMby17XR9sWiHSQPd/r80pb+zIxF0j27+JLWDbx+jZPljqSkxXh/oKX5X1xLCn3hVM6uHtmyL/16Nj+ZTyLsT2LKamR8kTacCQiI5BXVc5TtK/dp+h2+kVATwXIOLPV7dRxF/pOuT7ZcObd4OvLtrjHUflk9vgVfHxg4b32IubDpt+ZsNpiR09MxvHRq82aCUOq2pa1qsans2cBA2XNJtrcjfA6f3dPQUTVkMDoI5JL1A+UA5/OdiPE5JQUFcTieCG58uAPqR5YLKCh60FDlqxpIip8oLEQkX4yqPL+XcyNttRSPajdXNz3Gs9CNwZTS5pv149IaZrg2snZbRVdbjjuLKxElhbSj77cCvf7Vunp9FKJWecZ+HjXSI1hcc6UpXI8okwvMkgVCT4ekI26b+8Q+BD9owMPO2ncDA7XvH3b19hIitKMzSqt7DdqZgsz5yqoYnik0GhEFqio/IQXG+AEVjS4L4HJTzPLMNAjIxRkMs2oZiSlBV6NR+ejdqDHU6gKQPKjRmyJhZxYF3XpxDaeB2L0LibBxrjkmpjkujpAgX4uqiB1CIlFIIhEiRLXh7oHkfbkfsf+NQcP/nAj4gcjf9eNqH3Suz5KAZq6oXCKR1svCP58VSt3+xOPfuo24TSBC/aJI72Lhzex4Rki8OIaaDHHNI3yxmN2lm0ep0XrvnID20IiiiBpjqAAapY2p2tCxNsaM2aVydzV5eAJbKWXoAGU2P0yY4a9g+3BRQjgpOSWYF5LGkcaLULyaPsUGdNyy5djIeMa3TjDW9g7aTV3xAOmEkNciwf+ofno+9m52xNFwj0mWpMe45dzsfTU5OiEtF+dIsaQ44mYPXYlKeW563FBOxkyO8Ws+UGx9+xkAN/VkdElMfvpqiTdZzSZpRvMK8yeOJNb97WP3jzEnPTatLq9G3AQnFSCdTA5oW8GuXKgfa4WnVyY3yxkPv9rWXx88m1Xv5dWAhDJ5Xn3IK6StaQhHpOC9C2LGZ/Q7EFQJmTlF94XMzWRqthUWabZKsqho791aVKjZdsLwVn1YqD48PLRYz4mILOLsIOJTpC8Ki6S6nA6CHqX6s6nTV/qi7zjAP5xxhhT+3djm6MxwDd0ADXKPDYOA7wZrGFo7eOxNEOhe9O/F4l8CUaggiGocYvbwmIKMh0CaMc5JtZzqF8+h6EsQk+qKtd0jO2Pdt238arTB5Q5BG3wpj8kczAj07Q+qiMIQBHHx4S4LqbAhD48hWC0CCNjhwoyN5Rq+oCA86NxGRwF0yOOnpZ8tNzBClSG6dKaGk8TVdpa0hdW5AykwR80d96Utw5kI39jEAGag1CfGB89GoEBeEZF+/oxoVxBV+UO3v9NQtZvtv1WoUPoGtB089rpwmqNGuTYhyv+0/2+4Z233Z8L+0d2XvV2b8yhxqsYufRHx0NSkpGFtOHELTZ5Y4/LqMk4Zs3tj5vPIT/IXpFmma6tZe/7zzcK6cwp1CL1RnHAI7vFqfcmCc7oO4Hs/g8kOl/PripZuG3FdMmXMNjNtlzYwOXv22IA+UD5Oe4CNtXucKT82GmmMHebXcqgg1mkIbHoaBqmy/i61Cq2DCcdfdge9ljcJEyKedIy7nXRDbVKcwYgAnYpyd/2R1iBQmXYwfpiaRInRiATPBhybjDvi/qiqD2eTQ0qWgreUTsklD0YnskmQuO9IzQbu1b+p2JCcOJSZkTi4QVbxpvueyApwlV9tXo1/3ji2Am8Ul2uUcmN+6Q0BDUqYVqas1qhUHYnUInLtbG1lzsxBZQ0T4EO4jm3srymr7e6oxJ7A4xdB2Xa5RmWGqbA4t6zZmPUrdazbvpZPMsi3bskoW+DenO19s+Qm9jJ2uTVnHT0ePwYIz4EoJGqrttU/aiphuZ9wRVyitILHq0jY8ufMXVhOYHasb4rXDRocVR3phtLWFgyOi8qrS0IixSskefYmH5siQYnwYf6IVhd8nBWkDGLreLocwbV5OO57OPswX7fUcd6ZGpcDLZqrDVMMS6ZMUrhOi61Ceztqr94t7eyMSJQO9JGpqYiLquos/KKwcQJVjpeBvHYNBV6MIwrQ4Pv1WFdEPSdT/FGe7zYZumTqwkCstFutJkTLMzLCI22hvPR0wOZjHYKClivXDj2gVor9CUcURLaOwWCdRfnJtRveUH9LqaPMJ/r8DghsfhUMWqUvyLxsjLFQlHdE+DzrVAw59t6F+ADDG2yyU3u86Lw00GgrHPtp4o02D/ChpL1t4z9Lbh0gXL5NvBloAB482GAvLhPvFH2rCpMvLV8eEbwW+VaDHR7kLq0Rk8Qx3asn1vz97h3+dBOrY3pJ4TXhUmcpIVnGTO7aBZn4+IMmD/jNcXMrd6/ePS07zpXQrTDgiw1Y1/tiH7O/SCMtKONvWdyD/9nkTSbZH2//B0ELIuEuHx7NhKoPLvDIAijof+VNyPBkyu2XPhcS9QC0hMcrCQ+PSJCvRc9itT5ms7d/6gO9oLiWUsxPt/1Ji3lXpDwcDr72n57jn+G87L/J03E3vrA9m+jxPPTFy9mh9OEJJRvtjVjirjva6b3Ll2H9LWdwjH+1HQ2covdl09g/va7ueARPx1e2qA6UbVBQ3O4FzN3P12oWgvrnPcLl6TencIKnLoj3/6AgxxipPY7OXVOpG5spcnbs6fZ9rMSrdxdMpT6/ED7SHKojCD0P6sdiZ8CulurjB+QwWP7m9OMuluAZLLY/v8QRy5zrpwb3OWa13SUvr4vYZfW4o/ArfxRXvwx70cvrErbx/0JD7Y1vZUaS4/l+ik8kEviCfC3KiqinRxqsJrXO7vuvIplkF8b4bwZH8P5FPIXi7w+PKgopqRDKcgfqvcqx1WaDAsmEkMWxiB5V3U35qi1BkYHfKB4pnW+RV+vt7f+/Rj7skecl4LxDWYno0eqoB/5XN9a9+ev1jKbownJpPsil5GN5uEwcguKLiD5eCViEB3uf7+nQ86j+iAX+95vbDor/I6qfE/K3GwAHmG4AKnJ/AEa5DaA41gBPgAo11wCI9nTXi+tg4a9m+SCchnbz1NBDPg0956qV53tPHvKLMhgY2s1nQw88vNzjM5QB9O32PXi5h+E9e5hDGdjQbr4fegAQWMzNtQbJ0Teob1BkkBTJA+BEFFnTe8TL2Dw0qPtw0EHkOZIHT+3tUU2wUbY3MOjQZxnv1Oc6ewk8zy23BfBweyJ/T5LO+gHPh00iZGta0oQiZ7N1QYO6zaDDjyB/51EP6pK5IcHd9d9MOOeTAZUEfMuPdgH33uWLACourzBK/CvG3mPk7zg8djEjj33xNX4t9Lzmil7OY5/kMX1wzNTSQBdzSvV1O/zsHsqXVl3O4md5qlftG/MA9UqVcayJa6f8jslTbhs+yVMAQf0wDR+8Ld5QNvv8wJHw9NbYsLdFzpZFqjWLwHv8ULuIyPd1h4Uil6dnsmG2hScJtE7DgbcFYS8HoD7NdHbSTvCavL6s7HyDMiiJyAK8prjMVE6d4DX1yJBMn1Ff2kiKylkErEmAHhlRoNoKvCYEvczmR5sg8FBksn8HEpwQ2VO+RrvWYE6US4aI3zihBUzEyc0A9VTFMO5A7RdmWQOQ9T+XB02Z/hs2c6dsi+A488nz8s6sj4tyGlvFJImlsTZJKkl3GUKMMhQUEE8LqugAEd/k8/0+IP8cn+Xg6N22P+qPhgMwMXt5ypv5X10UZHvvh9LpTCUArI+QS2VUpUdkUc5OBQkCIlHhC8Epax4A897mZDcGA9NVq5sxn+9XQm8e74ou0k6nFy0XsoAFf8qYTZlMRCnDSNMc8ag+rub9Z+D5LXxt6vUFX+KL7/a0ic/Z0SLGCZJFw/pFTEV2ybgWyL95FBfKla/T/ehQtOLtvR/46Uy9JJnIWwNgDla8iG9HilG0SEU1+krEspqdRjoBjS0DLp3U3uSmG6fq+/vxCKyoGT6ewv8/wKf4pO46uGano/sxf4fQKT6iOWVNIwaohpoiZiw5Sm24s6+QRyLn1JPScTuv7kYjpQC7993p8TjajiheqFQlnrNaDPtg4sLBqpv5+UN0OlM5Cfgahs+Yy6f7C6XQZ6nmbc+GUvysOAz8DxYTQkYEaqIVMvpCxJEJzLw33BfN7OMsbYQrwdwtv4yXtFPYQkVlWvlG/UJZ4O6Ad6yzIF1JN3U/0wWpAlg3CGXX4rVCWQEC7PTRo0APMGwupBcghWZZ6WY+BHzRzv8rpLbd9WeA7y+/FPMF3bgDBXzO8ohOsF49sTFfKPbsERc9T4S0ZaCjUe6E3XmumB0pAnTn0aUgAqOB41v5f0eG6znA9COcmkwp4qruxHQUHOLbCJQUcKAw1qJH47IBaKgXRMKa7sZUNEC2rDBBNeV5Rd3KtFSXznQLvgGQxuSld7opkmQCttdng9PV5Hcz0XPIaQojcyJpUqQvjO5JQMh4QYbVNRNop8E+impKZFAQYKNSYc362/lULDmtv0XfQJQt61OFI6pHyiEkzqZCFil2pkKQ4tc+FjoZaIw6kCqAcSue/AuqQkiP5qcLZyBkd5u8Bkrs6tM4GQUYGhQvwxk97+MxYumJatKS3DzZCPUKq2c3pWnFPfosn6ZFaoA83qqQCM2CxhHN2C+UxDYBZyOy+1OakhBROl91UZW2G7ic6E5hkWroXsxexcmRgQK9L2qutoPwRK8AaleBecoMXMFxFcDEKOsxpxUd0jeJAWYZdOvyA4m9oXr0CNZrgNpm4zNCVaUR1XU7Xw0IqWFKKm/rgfI3SO0iqnOXalTo6vnOGGv5ooWnrrjKE7ui2zHbvGIu3F6U6SZek6Cwdq7Zfe711mtA7y24ymHtrz1SUHG9aQiM/yYD7XgGoUlNuK9GJztbIMTURmMmkOScuuxCNUAx6Y85uQPG3fV4O4K0TUq3S4IZUojtx1aLwgT18XSMxTRzqkkJ4fCp4XYx6yG4WeO6p/YtIRwmRPTUHdKuz/g3o/YcbYdnTV56ZjXbM1WO2J5VbR9FP8Y4I0RscMKj/Z6QCd9BEkNbShjRhp+R2aKenZxG0TzF+lrq1/vllPcdgH91JA6hzSuBS7dP0Pm6VBzSUBtpSXAkHxsZJtkqMmWj0tSCkkiKCo/wrX58PhEem3tPwNP56euHE77A5+2R5kiT7uhBzBQaFEUHInJXyXmuEqIA6xRywQThHvq678TBoGGry2SsEGIAIhuDKlOqy8IXVwwdAZBTDreeY7O1g7pqpHtjLbM0YDhvp6EyctrepxRQqLlLiZAFHHcHGImajZq5rp6KfzKP9ZVOZ8fVAsqKkfKabuf/wL95mkGKJPa3kUnJnPyNhDJJZSCQGbn2RakYnT3LVmjRaiIsjfVrXyZ5rLH2weKZLMX3PBPGwYjFoqyjh7PpNgREIf4GgS7etwGFJbVaIJuu0TRzgWp+dEQsOif9OFG0+eaoB/nDYGZyiEis0QRoOzQr3i8YoWBAQuZUzeanJPUy4E4X+XwqgJVlYxKlmZsyECZM8KgmNowjK6B1k5uUMletqqR0BsDfCcAe76+X18s5P8RShGbam0i5JwHInVNANZrIG5Uq11CDZM4lTIxLBQcvzii0jG0oYAygHfPhhi47k43b7h9ZaNQcyXMQJrTa5nnOxErFGLF2SICP2Lw8Pdzv6X1dcuScUncjQwgghKMCKF0iJbmrsSPjcLT8kzIcUH0urRqzUgConbbAMXPK1bRBnyLhnWf+hdKCMZt2+z6eNoHPX6ioVcY1iqSuEGEfWPPBOzWOEJnMLcTRnFPGz8mOqwyvIXFv7wUMXUZQAJYwqIHk/rrMrgWdBSloarAsqBuPPDcqlLgBeDaEaFsRfnnvB+d0pjYYTAlfWAA1/RF6xASce84jwi/Cvi30DBdqAaXRNmJf+EOhDmT1c0TQzei++4VK8RUQf8fHHeF1iyOHiLrFuemVgmS/KEOQpRatkqvVz8su0RcBxwWH3WYNK/HbEVeeDO4vfL1npMeYC10FU5+brEkH7kgIkAw4tJ3jjilI4iqXURj6mnYb5A+4lY8U/HQMyiT84FksCN9ooN1iTec8EKVjyGfELjcJDJa7K8loX9dJEklDrV6wpHFtflZKAXOizU1XWK7L/x93Os4klexVURWQar/ZbkhppYAuq0MBO3HE0AU+EN+Jlonwh7J17M5rMZme2mM20Y2LuCaiMw4KK7OXkyj6gQE2aSZPGe9JaVQesZ55yY+EbciY+xr7rEwXOecBRpy8PZMJDwxpshKT+oi4EEBJsWQSgr3MvyerX0/dPt9AqDIkGbCLDXxBIVJW9mZ/16nWP5BkYD75XgC+B1BT7YuybuVT5SMcx0I/B7hO8ZhulIno5fyzf9xPP9ROZzJPkb76L5Z8CaBtfwIaH70WAsjmOd9yRBtmaE6bKV5hrYr6sIPSB13iuDFAXtzywfNL3CnqkECVR0TF6bx/GFcPX/ElO8JAWyQmEbTb97RoGuZWtwFy25dqwJHW/bcUZOKeY8jb7DcjshbroFLBSOpaf1xhcKvv90vBpwSqMaRUif7tSkVPA7yrliiQ1GtEyjQ1G/W+Itdbt8YE+r6tmQagQVUzdwlqtBmCICnw1QIBXeLQnCBrTBUVPvAf6qHLk2ZBdWXr/XhOcKSNmvV2L7U2yJfJhvn3Nk/V7JYmBK7RUXEjWb4gwAK5GpRXihkJvoXD4tJXSlmqWFKFIo5ObbzozTsAUVhbmLC4Asx2jI2S1ixOW4A3mrwsjfKtUIcwptCF6NHr4cYqIdFrKREYAlLWERJR+WlaQ6d11pzXItJ11R3ewGjLZJyA46q8DmDu1pmiNmPkXO0TbzDrQqUwqQi/kuc5LyAUaUaUqTAm/harcJDIpSO1EOk6dr2vbKcWvUFeXa4NyFdj6cZ/QlHmw3NpP9febozR9nQhe+pIScK75o6cVyaHia0iIxJbUDuVA7ndikF8+Dkbt+9Xcdg+UjmQk7iUIKp1iplLCOpAyXZFL9aAwnR4Tw7ZiqteMOIYtvi3oxGMbPu1ngnehUYiREo5f9VlZXoNNxE43cUvg5HcaQKaWZpmLf4qOt68ArUl8Dim1P+EDXT3MoATvnl6uDtsVtSm/EPqAnfKBb8uWFG2/W8i5kureY1i7msXSloksvxkqXecKF9qLS6Cup9ehBzgvASIqFSXCD2+1BiZwurbs575PqRZyCpTorp3RF1Pz3In7Wo8l8ShqslDvFrVIvDQYJuV1NOqZppi/fJ3vC6dp3c+JBDw15dS2k7STUMjTLgB42I79k/BoXBoClTMbawPTTSth2jSGpqhYxjdyfQUBnB8RhMhteClt64+HtCpe5yUHVNrcTt2vAk5WZMIDSUhNW3EArd1jFxv7foHfsaXd4dxNDqGyEBlK2x6tGNEyaSsr1fQzlbjKTzrawoos+i1Z0EtLnhTZitlRw0jJ+eoYEFbZWfb0mpisrOD3DmCGGOR/raHycbWrGbMvK+7df1EYsuK5DuSmd63Qw/IKhe54wRcsdGEReLYGyA/PeLEQC8pPhdJkQyPYkcSyt+K5MKnyBUmM5MSmlnEHEtZFdTr4yj+0RyfVOhfBGaIOI1EpZC+JyGUHwGy8/QEoKXm+g4AyVGbAMEFUSBRa2Jj8LocY9/db5dzqu14NZ3UCNscvwSjPwCuB+eMrgEwBYFCPcfMWxPvt6YJEIRBVUZZc/wm5Ab0Vu7ERAu3acBHhOrefXI4MWIqajICUbAd9AI1VzwMAEe+6ziJbEU4+Xn238uZfsllE7ZeTptAlZovTNQcpSFw4ErODvey3b+dzOZgbacVl3c+3TRwZ6dCDftyfCRDl4cEP7KTAm6P12yzVf7ecd3IrRRgQGpdPkPogmqfnheaW5tTsY29zTEpbF8x6Ucmk/wELiDLocjbU5/ZMnyezTvgz9jJZ477nOhp/4Y/fPl0es05ITI5ZGvYh+IucIvNXv2sZuWMWREmbRU16BZDJIuq9T1VuV+9ABSbw24Vh76j0ULkUnnq81OW8LIGG5Ktdi0zrDyDYWqfKpDuZqziNpur4qPJi8Lmgk948vr8eDwUKS88yyGl9D0xDLWEbfdBPGEOIyucQC5XasL0fu5WJn8vCY6biJiAa3KAKXFnaqZ/wSAmP0CWHzhQhoatifNqqbar09Q6vkoda8XLLuusLdeupt0auaZbyjITyG66CcJdy6Q1YL01COWCD/1fYB5uMRLJI+0qnFALtY4UuBWvJGRJuSKAsPWIigI2nNdl/Jc/HnYXE7xiHLpOeBRfxtDoc54h8MovfBmCT/tvUUgwTyZ8jH3yvQhe5hL+Jz3ikxzA8DKUrNU5Qmk4t6ejlNOZivs6pvAbgCwrc5kmXf/hsZqPCZfWfk+6ybhGT6QClw38HJDhln1Av0t3B7rlj/0tlzSJgn/wOM3sHQtN/D0Ji1tnKkXrBJmEgrblzjbIBUh4dlMKFzgtWB+OH+mbPRzAt3vfph1v2BR2grc273th61804wgoWF3YA88D6PRSca3J3WDfC55paCmGx5DX6Byt8nmDDcPnwh7yX4d5aWsBTZKYXsL8drMqqjcEUIIywCx5s+fMrbJsWlUz4azW7no1yO47DfsY8tOHKa4+wEAsSCX8Wf7fvdPI/Kpv8kJd8p+8aVPxv61LYCjz3S5PKhQoiHxTeISaBY4P42LegR2U+um9f+8LsPOMQ3U1gKCvMG3xEkhrKVmw48/J/zT4P7xvJcoHko22C5rJF4jLHqfvsdIUa8YAAY0YUCzKdmKZapOZokmVUuI7osSTR29h+Pf97T18DV8ej7at54sAVdrVQ9kPmBezH0mEjEPssm15MinrhUnYZAPvFZtm8peTuiOsRKVJqTkFd01npCZ96/u2s2ovRrfE3ZsVtFtvVeSwPJKH75g82eHslBh+j/Av/Mvl/OHkBvnS+3TUa+0ovC9GDbnrP0u/8KMsTWrv/ZA7nelVYfRMjW5/G82F0ozTrMFTeBWdEkNQM2zsOr2wnaKZcTJtJo/GL0y/o9s5fdLpkwYWs1KzQgMBUrfPgch/9E7O6yswwVAs1UuLtNkZakWaLDEyggtH1uobHNZB+en0E0KOcNuGBwaM2iKW7Swkw2Ym8F1KHjbgZDdKotevrP6T+Wie4uKX14+bb/Ni5uSY/sdj4GfZ/3/xuj8juq3E/hLqiz4L803fsM5ENzZD2CyGaWNRctpNMZ3OjeiZM7oItbascMfX2cxjrKud+HYLbA/hFPsd3sM7r/MpSyNrtEuJpgke1C8uozqqfNUYymVQNUinWEOPEk0ZgWa6Ve03DetI8Us5DgoqfyLnM3sQxG7xhnXLbdfXXYGNNY6jF5xenx5cl33o4sqb+psQud41a00frzBrFc3ps1KLqnKFbD3ZIRDYC1otQOuqJPJOe86uZtiivC0MthcFosLUvPWwHonKg7hxZ6eVh3nCCfblS8/OrMALZvLqP/Bn5XS7thhct9j25GDgOaoFY86joUfhNcnakIRgQhTd4zTwuuuFzKtDGutIh6NAveioeWp6SZrb/4b6Ra8aDCCHUiJ+eeURp607n0UDNCtAhx9EA01b5YcnGmLn9qeQ+kSxVJZpAiU9sGfQTgeHnCTWXEUFoy1+tJDi3Nu26tckeWXAIzyPe2VDlbpcIku8RXzdknlEQb3iX1OW+VbymiWSyVPHXYOyil9a7P14NRdx2dxPZiTRoKWoU5G66jLd3ADoMWzs7nCzuTzvN1iYN8QJ2miRYsLXwEH75LoSsR74tbk1Rpe8vz0/MrPDG+P9tF8PKmYX6RG9UuGDYTTOccX3xHIXWlvJyFq+Qa56uMIZd0IXM2Y12RBN95jz79FlX5swMMfEj+/iH5PdwNuyJqTfKpEaUIsQV/GCf9jMt/l8rKLbZq1qA+ZVl2sHrcvEuM90QItzvBDy/NOxNTQ9YwVbSmOzKaZ3EWv9Hxdp1OindRPyYYF2vSef3GqG1T/lTIZc7m0qaIUaF0O55hxLOEpaFkyNjsbZYkurDU/vVApcQPBwT2kMPi/HS6mOXawkuK5z1KBzpjJmAshlxfCMWWyJcPPXTt3GGmFpuRcAepewy/EAXYFzCrV1P/DZlm9rmbAvBwNEIT2mKqBK27Vs0XQrfGpg26cfPKOzHOzQDjwXPG55R7tykI2S7HvwfrSwmZJYxRGgT3x41MqzC4TJLvs3lG1dWVKsM3MM59kyvWfzzTddXTnqL6fjmjbE0FXoO8H5xVxyv8e64q/FK/mt0Spc4vyoRWqsQI9lTvt5HqyvkBTCaPMuqiKoqeS0mdeSX5V5oVaSqpACyloJLTJL+S9nUuOGQdBTCoHhQnKJkFkkiLNUga20GbovMr1EDU3uahTbcjIrPClxCMgoJeqlplxPxGWT80yL5VJn6OT4gsPwurj2uB3ycqwZXM7s/n9Ptun0yE9tZySpTeFI/60qZuqu2xvk5N5HjW8KxT8jXwvRrPsOZWT3fKrmHK4nPw/TfQ+kOYDWQGYHMDeQhQEsDmR5wK720qA2/9aVrhwCOC86y+FM21/rYGtVrbmVd3QPZKUhSDC8lPkZITnqeY39l1/CQRfgXvgY+uc3Mi2bA5TmrWfT/jLxLgM77aaMhf+fH8pmbAkvHZ4/jojfpKpihR7mJLK/lH5ql9nsSAB3OLQiGeZoO/IFv/La82OJrWt8tlERkWLuByfxyr+tqNmP4M+zgpkr6RzhwQXM5SM6/KiAARBNsl7cvPz5RGbA+Z+dOwC8uLTnAodT/43+9D+7//7w3oQDoD0KMQP5wTvD9TP0/3kFX5hTMdQMhs/vi9f46dteTOZ4RYoUcdx0mJiOpzjniEfmSTL3j+6iVxaciKfsosG0Xf7HBFRVKeFD0jS5C8pRpYcIcgnw8NeqFQGY3zFxbIkYzkUub/MqgulE0ESjg+ZfUDL3GJE9+S/JbfknNturQhRm/hCBaba5VXHns5F4N32ZEef83tkb/uD9pk9bYPluOjBCk/U80BpPmSlsPiSG7xckbMgTIDmOSUCZIMCV78hFfP8cBmSdciwQ8M7TPhDgymnJokaZCM0944pwLEjD0jgiTp7zRWyW/RBmjxMLopHi6JZ+nb6kTEswz+yRcWsAbHDag1jLHRZAmxI2GqyRJKV+AJe7QbEkADposoJ1R+BR2KArkd3HK4na40qBvMkrheIqJZHVq75SLIotqcdpgD1MobdECL+55bTKFJwl095DUy7pRTIqUl7ucPEixBExqqCRciY54SQVN9O+kuSQVGGXsr2cSsLsv1NGBhgsNHQMQbEdA/1gaumnQyVKiS8bgVDuZqxRjjg3V6ImkfPMkcNg8pT8Vyk5ATmNshLUY1Qoa9eSwCSZamSj9ndgkI0cL09yeQqIoxU0KGlNUrEilZ4lI0o5YjdgUnYVTtrz07uCgsZSelkup8VTDcU2gCiexf+QsRCpLyQ5BSUVNQ0tVyBgEFAwcAhIbtyhoHnwhOEFCwePgIiEjILKmw9fNH7mGmVijbf2FyBQkOD/pgjFEYaLh09ASEQsXIRIUaLFiBVHQipegkRJZJKlSJVGTkFJRS1dhkxZsk1p0+6oEW91GNBrjY16PNDKHFZR28USS6c9CRt73/zhuw12uOi8nTS0VtC5LMcFlyy64qoF7+S66Zrrdsnz1Up33HJbvg8+6VaoQJFiegaTjEqVKFOugkmlKu9Vq1WjToN6h6zXpFGzZT767LDd9sRSvx557L5Zex1w0Bn77HdWp+2OOe6IPl/C1k/YRSdPpsM+ukTX6Bbdo0eUvoiLW1rxtoBOFzIPHlaeJRThnuBDMFmB1nFvjCZr/ZvkZgTiUKNb/6H2+NN2JpPhXyXtb/MzwxSbP7VrHUDsHVzYlNnDLE76bvYzWLoe2YOliz7Be7AVIH7e82tojcmgZNVpcb2JJdmQemjgol8pfubHE7CiaICjBv4HB9L3qSssuepYdD2R76auM4A64xuHEoBZGSzZ6b4nmJQcTjRjUVv0fydn4vSeHBxZYg2iVt0mfeNn+xXr/veWQ/l1WWeAyhIAAA==) format('woff2'); }
@font-face { font-family:'Courier Prime'; font-style:normal; font-weight:700; font-display:block; src:url(data:font/woff2;base64,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) format('woff2'); }
/* ================= Ghostwriter design system =================
   Colours derive from the host's text colour (currentColor), so the chrome
   follows a light or dark Hermes theme; the page itself is always paper. */
.gw-root {
  --gw-accent: #3847FF; --gw-accent-strong: #2532e6; --gw-accent-soft: color-mix(in oklab, #3847FF 14%, transparent);
  --gw-accent-text: #3847FF; /* accent used as text/icon colour (lightened on dark themes) */
  --gw-brand-grad: linear-gradient(135deg, #6470ff, #3847FF);
  --gw-good: #2fae76; --gw-warn: #d99a2b; --gw-bad: #e5534b;
  --gw-line: color-mix(in oklab, currentColor 11%, transparent);
  --gw-line-strong: color-mix(in oklab, currentColor 20%, transparent);
  --gw-soft: color-mix(in oklab, currentColor 4%, transparent);
  --gw-soft-2: color-mix(in oklab, currentColor 7%, transparent);
  --gw-muted: color-mix(in oklab, currentColor 58%, transparent);
  --gw-ink: #1d2030;
  --gw-surface: #ffffff; --gw-surface-fg: #1d2030;
  --gw-field-bg: #ffffff; --gw-field-fg: #1d2030; --gw-field-ph: #6b7080; --gw-field-border: rgba(0,0,0,.18);
  --gw-radius: 0; --gw-radius-sm: 0;
  --gw-shadow: 0 1px 2px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.16);
  --gw-ui-font: "Inter", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; overflow: hidden;
  font-family: var(--gw-ui-font); font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; position: relative;
}
.gw-root *, .gw-root *::before, .gw-root *::after { box-sizing: border-box; }
.gw-root button, .gw-root input, .gw-root textarea, .gw-root select { font: inherit; color: inherit; }
.gw-root :focus-visible { outline: 2px solid var(--gw-accent); outline-offset: 2px; }
.gw-root input:focus-visible, .gw-root textarea:focus-visible, .gw-root select:focus-visible { outline: none; }
.gw-icon { flex: none; display: block; }
.gw-muted { color: var(--gw-muted); }
.gw-small { font-size: 12px; }
.gw-pad { padding: 14px; }
.gw-grow { flex: 1; }
.gw-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.gw-row-end { justify-content: flex-end; }
.gw-mono { font-family: var(--gw-font, 'Courier Prime', monospace); }

/* --- buttons --- */
.gw-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 32px; padding: 0 13px; border-radius: 0; border: 1px solid var(--gw-line-strong); background: var(--gw-soft); cursor: pointer; font-weight: 550; font-size: 13px; white-space: nowrap; text-decoration: none; transition: background .15s, border-color .15s, transform .05s, box-shadow .15s; }
.gw-btn:hover:not(:disabled) { background: var(--gw-soft-2); border-color: color-mix(in oklab, currentColor 28%, transparent); }
.gw-btn:active:not(:disabled) { transform: translateY(1px); }
.gw-btn:disabled { opacity: .45; cursor: default; }
.gw-btn-small { height: 27px; padding: 0 10px; font-size: 12px; }
.gw-btn-primary, .gw-btn-accent { background: var(--gw-accent); border-color: transparent; color: #fff !important; box-shadow: 0 1px 2px rgba(56,71,255,.3); }
.gw-btn-primary:hover:not(:disabled), .gw-btn-accent:hover:not(:disabled) { background: var(--gw-accent-strong); border-color: transparent; }
.gw-btn-accent.gw-on { background: var(--gw-accent-soft); color: inherit !important; box-shadow: inset 0 0 0 1px var(--gw-accent); }
.gw-btn-danger { background: var(--gw-bad); border-color: transparent; color: #fff !important; }
.gw-btn-danger:hover:not(:disabled) { background: color-mix(in oklab, var(--gw-bad) 85%, black); }
.gw-btn-ghost { background: transparent; border-color: transparent; }
.gw-btn kbd { font: 600 10.5px var(--gw-ui-font); opacity: .75; padding: 1px 5px; border-radius: 0; background: rgba(255,255,255,.18); }
.gw-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 0; border: 1px solid transparent; background: transparent; cursor: pointer; color: var(--gw-muted); transition: background .15s, color .15s; }
.gw-icon-btn:hover:not(:disabled) { background: var(--gw-soft-2); color: inherit; }
.gw-icon-btn:disabled { opacity: .35; cursor: default; }
.gw-icon-btn.gw-on { background: var(--gw-accent-soft); color: var(--gw-accent-text); }
.gw-icon-btn-small { width: 24px; height: 24px; }

/* --- chips / badges --- */
.gw-chip { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 0; font-size: 11px; font-weight: 600; letter-spacing: .01em; white-space: nowrap; background: var(--gw-soft-2); color: var(--gw-muted); vertical-align: middle; }
.gw-chip-pending { background: var(--gw-accent-soft); color: var(--gw-accent-text); }
.gw-chip-good { background: color-mix(in oklab, var(--gw-good) 16%, transparent); color: var(--gw-good); }
.gw-chip-warn { background: color-mix(in oklab, var(--gw-warn) 18%, transparent); color: var(--gw-warn); }
.gw-chip-bad { background: color-mix(in oklab, var(--gw-bad) 16%, transparent); color: var(--gw-bad); }
.gw-badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 50%; background: var(--gw-accent); color: #fff; font-size: 10.5px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.gw-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--gw-warn); }
.gw-count { font-size: 11px; font-weight: 600; color: var(--gw-muted); background: var(--gw-soft-2); border-radius: 0; padding: 1px 7px; }

/* --- topbar --- */
.gw-topbar { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 52px; padding: 0 14px; border-bottom: 1px solid var(--gw-line); flex: none; }
.gw-topbar-left, .gw-topbar-right { display: flex; align-items: center; gap: 10px; min-width: 0; }
.gw-topbar-right { justify-content: flex-end; }
.gw-brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; letter-spacing: -.01em; }
.gw-brand-mark { width: 30px; height: 30px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--gw-brand-grad); box-shadow: 0 2px 8px rgba(56,71,255,.35); }
.gw-brand-mark-sm { width: 24px; height: 24px; box-shadow: 0 1px 4px rgba(56,71,255,.3); }
.gw-logo { display: block; flex: none; user-select: none; }
.gw-root[data-theme="dark"] .gw-logo-for-light, .gw-root[data-theme="light"] .gw-logo-for-dark { display: none; }
.gw-nav { position: absolute; top: 50%; left: calc(var(--gw-left, 0px) + (100% - var(--gw-left, 0px) - var(--gw-right, 0px)) / 2); transform: translate(-50%, -50%); z-index: 2; display: flex; gap: 2px; padding: 3px; border-radius: 0; background: var(--gw-soft); border: 1px solid var(--gw-line); transition: left .2s ease; }
.gw-nav-item { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: none; border-radius: 0; background: transparent; cursor: pointer; color: var(--gw-muted); font-weight: 550; transition: background .15s, color .15s; }
.gw-nav-item:hover { color: inherit; }
.gw-nav-active { background: color-mix(in oklab, currentColor 9%, transparent); color: inherit; box-shadow: 0 1px 2px rgba(0,0,0,.12); }

/* --- project picker & menus --- */
.gw-dd { position: relative; min-width: 0; }
.gw-dd-toggle { display: inline-flex; align-items: center; gap: 8px; max-width: 280px; height: 32px; padding: 0 10px; border-radius: 0; border: 1px solid var(--gw-line); background: transparent; cursor: pointer; font-weight: 600; }
.gw-dd-toggle:hover, .gw-dd-open { background: var(--gw-soft-2); }
.gw-dd-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-dd-caret { opacity: .6; }
.gw-menu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; min-width: 270px; padding: 6px; border-radius: 0; border: 1px solid var(--gw-line-strong); background: var(--gw-surface); color: var(--gw-surface-fg); box-shadow: var(--gw-shadow); animation: gw-pop .14s ease-out; }
.gw-menu-right { left: auto; right: 0; }
.gw-menu-scroll { max-height: 280px; overflow-y: auto; }
.gw-menu-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--gw-muted); padding: 6px 8px 4px; }
.gw-menu-item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 8px 9px; border: none; background: transparent; border-radius: 0; cursor: pointer; text-align: left; }
.gw-menu-item:hover { background: var(--gw-soft-2); }
.gw-menu-active { background: var(--gw-accent-soft); }
.gw-menu-danger { color: var(--gw-bad); }
.gw-menu-sep { height: 1px; background: var(--gw-line); margin: 5px 2px; }
.gw-menu-project-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.gw-menu-project-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-menu-project-meta { font-size: 11.5px; color: var(--gw-muted); }

/* --- layout --- */
.gw-main { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.gw-tab { flex: 1; min-height: 0; display: flex; flex-direction: column; animation: gw-fade .18s ease-out; }
.gw-scroll { overflow-y: auto; }
.gw-workspace { flex: 1; min-height: 0; display: flex; }
.gw-split { flex: 1; min-height: 0; display: flex; }
.gw-split-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.gw-resize { width: 5px; flex: none; cursor: col-resize; position: relative; }
.gw-resize::after { content: ''; position: absolute; inset: 0 2px; background: var(--gw-line); transition: background .15s; }
.gw-resize:hover::after, .gw-resize-active::after { background: var(--gw-accent); }
.gw-chat-col { flex: none; min-width: 300px; display: flex; flex-direction: column; border-left: 1px solid var(--gw-line); }

/* --- outline --- */
.gw-outline { width: 250px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--gw-line); background: var(--gw-soft); }
.gw-outline-head { display: flex; align-items: center; gap: 8px; height: 46px; padding: 12px 10px 0 14px; margin-bottom: 8px; }
.gw-outline-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--gw-muted); }
.gw-outline-list { flex: 1; overflow-y: auto; padding: 0; display: flex; flex-direction: column; gap: 0; border-top: 1px solid var(--gw-line); }
.gw-scene-row { border-bottom: 1px solid var(--gw-line) !important; padding: 10px 12px 10px 14px !important; }
.gw-outline-empty { padding: 10px 8px; color: var(--gw-muted); font-size: 12.5px; }
.gw-scene-row { display: flex; align-items: flex-start; gap: 9px; width: 100%; padding: 8px 8px; border: none; border-radius: 0; background: transparent; cursor: pointer; text-align: left; position: relative; transition: background .12s; }
.gw-scene-row:hover { background: var(--gw-soft-2); }
.gw-scene-row-active { background: var(--gw-accent-soft); }
.gw-scene-row-active::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; border-radius: 0; background: var(--gw-accent); }
.gw-scene-idx { flex: none; min-width: 22px; height: 22px; padding: 0 4px; border-radius: 0; background: var(--gw-soft-2); color: var(--gw-muted); font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.gw-scene-row-active .gw-scene-idx { background: var(--gw-accent); color: #fff; }
.gw-scene-text { display: flex; flex-direction: column; min-width: 0; flex: 1; gap: 1px; }
.gw-scene-place { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: uppercase; letter-spacing: .01em; }
.gw-setting { font-size: 9.5px; font-weight: 700; letter-spacing: .05em; padding: 1px 4px; margin-right: 5px; border-radius: 0; border: 1px solid var(--gw-line-strong); color: var(--gw-muted); vertical-align: 1px; }
.gw-scene-meta { font-size: 11.5px; color: var(--gw-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-warn-icon { color: var(--gw-warn); margin-top: 3px; }
.gw-outline-add { display: flex; align-items: center; gap: 7px; margin: 8px; padding: 9px 10px; border-radius: 0; border: 1px dashed var(--gw-line-strong); background: transparent; color: var(--gw-muted); cursor: pointer; font-weight: 550; font-size: 12.5px; }
.gw-outline-add:hover { color: var(--gw-accent-text); border-color: var(--gw-accent); background: var(--gw-accent-soft); }

/* --- stage --- */
.gw-stage { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; align-items: center; gap: 0; padding: 12px 22px 8px; position: relative; }
.gw-toolbar { margin-bottom: 10px; width: 100%; min-height: 34px; max-width: var(--gw-page-w, 720px); display: flex; align-items: center; justify-content: space-between; gap: 10px; flex: none; }
.gw-toolbar-left, .gw-toolbar-right { display: flex; align-items: center; gap: 6px; }
.gw-toolbar-sep { width: 1px; height: 18px; background: var(--gw-line-strong); margin: 0 2px; }
.gw-segmented { display: inline-flex; padding: 3px; border-radius: 0; background: var(--gw-soft); border: 1px solid var(--gw-line); gap: 2px; }
.gw-seg { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px; border: none; border-radius: 0; background: transparent; cursor: pointer; color: var(--gw-muted); font-weight: 550; font-size: 12.5px; }
.gw-seg:hover { color: inherit; }
.gw-seg-active { background: color-mix(in oklab, currentColor 10%, transparent); color: inherit; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.gw-zoom { display: inline-flex; align-items: center; gap: 0; }
.gw-zoom-val { min-width: 40px; text-align: center; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--gw-muted); }
.gw-swatches { display: inline-flex; gap: 6px; padding: 0 4px; }
.gw-swatch { width: 16px; height: 16px; border-radius: 50%; border: 1px solid rgba(0,0,0,.18); cursor: pointer; padding: 0; transition: transform .12s, box-shadow .12s; }
.gw-swatch:hover { transform: scale(1.15); }
.gw-swatch-active { box-shadow: 0 0 0 2px var(--gw-surface), 0 0 0 4px var(--gw-accent); }
.gw-findbar { border-bottom: none !important; width: 100%; max-width: var(--gw-page-w, 720px); display: flex; align-items: center; gap: 8px; flex: none; padding: 7px 8px; border-radius: 0; border: 1px solid var(--gw-line-strong); background: var(--gw-soft); animation: gw-pop .14s ease-out; flex-wrap: wrap; }
.gw-find-field { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 160px; height: 30px; padding: 0 4px 0 9px; border-radius: 0; border: 1px solid var(--gw-line); background-color: var(--gw-field-bg) !important; color: var(--gw-field-fg) !important; border-color: var(--gw-field-border); color: var(--gw-muted); }
.gw-find-field:focus-within { border-color: var(--gw-accent-text); }
.gw-find-field input { flex: 1; min-width: 0; border: none; background: transparent; outline: none; color: inherit; }
.gw-find-count { font-size: 11.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.gw-banner { border-bottom: none !important; width: 100%; max-width: var(--gw-page-w, 720px); display: flex; align-items: center; gap: 10px; padding: 8px 10px 8px 14px; border-radius: 0; background: var(--gw-accent-soft); border: 1px solid color-mix(in oklab, var(--gw-accent) 35%, transparent); color: inherit; flex: none; animation: gw-pop .2s ease-out; }
.gw-banner > span { flex: 1; font-size: 13px; }
.gw-banner > .gw-icon { color: var(--gw-accent-text); }
.gw-statusbar { margin-top: 8px; display: flex; align-items: center; gap: 7px; width: 100%; max-width: var(--gw-page-w, 720px); font-size: 11.5px; color: var(--gw-muted); flex: none; padding: 2px 4px; font-variant-numeric: tabular-nums; }
.gw-statusbar-right { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }

/* --- the paper --- */
.hsp-full { flex: 1; min-height: 0; width: 100%; max-width: var(--gw-page-w, 720px); overflow-y: auto; background: var(--gw-paper, #dcebf0); color: var(--gw-ink); border-radius: 0; box-shadow: 0 1px 1px rgba(0,0,0,.1), 0 10px 30px rgba(0,0,0,.22); padding: 3em 0 4em; font-family: var(--gw-font, 'Courier Prime', monospace); font-size: var(--gw-size, 13px); scroll-behavior: smooth; }
.hsp-page { padding: 0 11.8% 0 17.6%; font-family: var(--gw-font, 'Courier Prime', monospace); font-size: var(--gw-size, 13px); line-height: 1.25; color: var(--gw-ink); }
.hsp-full-scene, .hsp-edit-scene { position: relative; display: block; }
.hsp-full-scene + .hsp-full-scene, .hsp-edit-scene + .hsp-edit-scene { margin-top: 2.5em; }
.hsp-preamble { margin-bottom: 2.5em; }
.hsp-scene-num { position: absolute; left: -5ch; top: 0; opacity: .4; font-size: .9em; }
.gw-scene-ask { position: absolute; right: -9.5ch; top: -2px; display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 0; border: 1px solid color-mix(in oklab, var(--gw-accent) 40%, transparent); background: color-mix(in oklab, var(--gw-paper, #fff) 70%, white); color: var(--gw-accent); font: 600 11px var(--gw-ui-font); cursor: pointer; opacity: 0; transform: translateX(-4px); transition: opacity .15s, transform .15s; }
.hsp-full-scene:hover .gw-scene-ask, .gw-scene-ask:focus-visible { opacity: 1; transform: none; }
.gw-scene-ask:hover { background: var(--gw-accent); color: #fff; }
.gw-inline-warn { display: flex; align-items: center; gap: 6px; font: 12px var(--gw-ui-font); color: #9a6200; margin-bottom: .6em; }
.f-scene, .f-action, .f-char, .f-trans, .f-centered, .f-lyric, .f-section, .f-synopsis, .f-note, .f-boneyard { margin-top: 1.25em; white-space: pre-wrap; }
.f-paren, .f-dialogue { margin-top: 0; white-space: pre-wrap; }
.hsp-full-scene > .f-scene, .hsp-preamble > :first-child, .hsp-edit-scene > :first-child { margin-top: 0; }
.f-scene { font-weight: 700; }
.f-char { margin-left: 36.67%; }
.f-paren { margin-left: 26.67%; width: 41.67%; }
.f-dialogue { margin-left: 16.67%; width: 58.33%; }
.f-trans { text-align: right; }
.f-trans-left { text-align: left; }
.f-centered { text-align: center; }
.f-lyric { font-style: italic; }
.f-section, .f-synopsis, .f-note, .f-boneyard { font-family: var(--gw-ui-font); font-size: .82em; color: color-mix(in oklab, var(--gw-ink) 50%, transparent); }
.f-section { font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.f-synopsis, .f-note { font-style: italic; }
.f-note { border-left: 2px solid #e2b93b; padding-left: 8px; }
.f-boneyard { text-decoration: line-through; }
.f-pagebreak { margin: 1.25em 0 0; border-top: 1px dashed color-mix(in oklab, var(--gw-ink) 30%, transparent); }
.hsp-raw { white-space: pre-wrap; font: inherit; margin: 0; }
.hsp-mark { background: #ffe58a; color: #1d2030; border-radius: 0; padding: 0 1px; }
.hsp-mark-current { background: #ffb020; box-shadow: 0 0 0 2px #ffb020; }
.gw-page-empty { margin-top: 3em; display: flex; flex-direction: column; align-items: flex-start; gap: 1em; font-family: var(--gw-ui-font); font-size: 13.5px; color: color-mix(in oklab, var(--gw-ink) 75%, transparent); }
.gw-page-empty-title { font-family: var(--gw-font, 'Courier Prime', monospace); font-size: var(--gw-size, 13px); color: var(--gw-ink); }
.gw-page-empty .gw-btn { color: var(--gw-ink); }
.gw-page-empty .gw-btn-accent { color: #fff; }
.gw-page-hint { margin-top: 3em; font: 12px var(--gw-ui-font); color: color-mix(in oklab, var(--gw-ink) 50%, transparent); text-align: center; }

/* title page */
.hsp-titlepage { display: flex; flex-direction: column; text-align: center; }
.hsp-full .hsp-titlepage { min-height: 52em; margin-bottom: 3.75em; padding-bottom: 1.25em; border-bottom: 1px dashed color-mix(in oklab, var(--gw-ink) 25%, transparent); }
.hsp-titlepage-spacer { flex: 3 1 0; min-height: 2em; }
.hsp-titlepage-grow { flex: 5 1 0; min-height: 2em; }
.hsp-titlepage-title { font-weight: 700; }
.hsp-titlepage-line { margin-top: 1.25em; }
.hsp-titlepage-credit { margin-top: 3.75em; }
.hsp-titlepage-corners { display: flex; justify-content: space-between; align-items: flex-end; gap: 2ch; text-align: left; }
.hsp-titlepage-right { text-align: right; }

/* --- editor --- */
.gw-editor { flex: 1; min-height: 0; width: 100%; max-width: var(--gw-page-w, 720px); display: flex; flex-direction: column; gap: 0; }
.hsp-editor-paper { flex: 1; min-height: 0; overflow-y: auto; background: var(--gw-paper, #dcebf0); color: var(--gw-ink); border-radius: 0; padding: 3em 0 3em; box-shadow: 0 0 0 2px var(--gw-accent-soft), 0 10px 30px rgba(0,0,0,.22); }
.hsp-edit-el { display: block; width: 100%; background: transparent; border: none; border-radius: 0; padding: 0; margin-bottom: 0; color: var(--gw-ink); font: inherit; resize: none; overflow: hidden; white-space: pre-wrap; transition: background .12s; }
.hsp-edit-el:hover { background: color-mix(in oklab, var(--gw-ink) 4%, transparent); }
.hsp-edit-el:focus { outline: none; background: color-mix(in oklab, white 55%, transparent); box-shadow: 0 0 0 2px color-mix(in oklab, var(--gw-accent) 55%, transparent); }
textarea.hsp-edit-el.f-char { width: 63.33%; }
textarea.hsp-edit-el.f-dialogue { width: 58.33%; }
textarea.hsp-edit-el.f-paren { width: 41.67%; }
.hsp-titlepage-edit { gap: 8px; padding-bottom: 2.5em; margin-bottom: 2.5em; border-bottom: 1px dashed color-mix(in oklab, var(--gw-ink) 25%, transparent); }
.hsp-titlepage-input { display: block; width: 100%; max-width: 46ch; margin: 0 auto; background: color-mix(in oklab, white 35%, transparent); border: 1px solid color-mix(in oklab, var(--gw-ink) 16%, transparent); border-radius: 0; padding: 6px 10px; color: var(--gw-ink); font: inherit; text-align: center; resize: vertical; }
.hsp-titlepage-input::placeholder { color: color-mix(in oklab, var(--gw-ink) 40%, transparent); }
.hsp-titlepage-input:focus { outline: none; border-color: var(--gw-accent); box-shadow: 0 0 0 3px var(--gw-accent-soft); }
.hsp-titlepage-input-title { font-weight: 700; font-size: 1.15em; margin-bottom: 6px; }
.hsp-titlepage-contact-edit { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.hsp-titlepage-contact-edit .hsp-titlepage-input { text-align: left; }
.hsp-titlepage-contact-label { font: 600 10.5px var(--gw-ui-font); letter-spacing: .07em; text-transform: uppercase; color: color-mix(in oklab, var(--gw-ink) 50%, transparent); }
.hsp-titlepage-extra { display: flex; align-items: center; gap: 8px; max-width: 46ch; margin: 0 auto; width: 100%; }
.hsp-titlepage-extra-key { white-space: nowrap; color: color-mix(in oklab, var(--gw-ink) 60%, transparent); }
.gw-source { flex: 1; min-height: 300px; width: 100%; resize: none; border-radius: 0; border: none; padding: 2.5em 3em; background: var(--gw-paper, #dcebf0); color: var(--gw-ink) !important; font-family: var(--gw-font, 'Courier Prime', monospace) !important; font-size: var(--gw-size, 13px) !important; line-height: 1.45; box-shadow: 0 0 0 2px var(--gw-accent-soft), 0 10px 30px rgba(0,0,0,.22); }
.gw-source:focus { outline: none; box-shadow: 0 0 0 2px var(--gw-accent), 0 10px 30px rgba(0,0,0,.22); }
.gw-savebar { border-top: none !important; display: flex; align-items: center; gap: 8px; flex: none; padding: 8px 8px 8px 14px; border-radius: 0; border: 1px solid var(--gw-line); background: var(--gw-soft); transition: border-color .2s, background .2s; }
.gw-savebar-dirty { border-color: color-mix(in oklab, var(--gw-warn) 45%, transparent); background: color-mix(in oklab, var(--gw-warn) 8%, transparent); }
.gw-savebar-text { flex: 1; font-weight: 550; color: var(--gw-muted); }
.gw-savebar-dirty .gw-savebar-text { color: inherit; }

/* --- generic pages (Rules, History, Export) --- */
.gw-page-narrow, .gw-page-wide { width: 100%; max-width: 860px; margin: 0 auto; padding: 28px 24px 48px; display: flex; flex-direction: column; gap: 14px; }
.gw-h2 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -.02em; }
.gw-lead { margin: -6px 0 6px; color: var(--gw-muted); font-size: 13.5px; }
.gw-heading-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.gw-heading-row .gw-lead { margin-top: 4px; }
.gw-card { border: 1px solid var(--gw-line); border-radius: 0; background: var(--gw-soft); padding: 16px; text-align: left; }
.gw-section-label { font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--gw-muted); padding: 2px 2px 6px; }
.gw-form { display: flex; flex-direction: column; gap: 12px; }
.gw-form-title { font-weight: 650; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.gw-details > summary { cursor: pointer; list-style: none; }
.gw-details > summary::-webkit-details-marker { display: none; }
.gw-details > summary::after { content: '›'; margin-left: auto; transform: rotate(90deg); color: var(--gw-muted); transition: transform .15s; }
.gw-details[open] > summary::after { transform: rotate(-90deg); }
.gw-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
.gw-grid2 > .gw-field:first-child { padding-right: 14px; }
.gw-grid2 > .gw-field + .gw-field { padding-left: 14px; border-left: 1px solid var(--gw-line); }
.gw-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.gw-label { font-weight: 600; font-size: 12.5px; }
.gw-help { font-size: 12px; color: var(--gw-muted); }
.gw-input { width: 100%; height: 34px; padding: 0 10px; border-radius: 0; border: 1px solid var(--gw-line-strong); background-color: var(--gw-field-bg) !important; color: var(--gw-field-fg) !important; border-color: var(--gw-field-border); transition: border-color .15s, box-shadow .15s; }
.gw-input:focus { outline: none; border-color: var(--gw-accent); box-shadow: 0 0 0 3px var(--gw-accent-soft); }
.gw-textarea { height: auto; padding: 9px 10px; resize: vertical; line-height: 1.5; }
.gw-input-num { width: 86px; flex: none; }
.gw-proto-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--gw-line); }
.gw-proto-row .gw-small { flex: 1; }
.gw-proto-add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.gw-proto-add select { width: auto; flex: 1; min-width: 160px; }

/* history timeline */
.gw-timeline { list-style: none; margin: 6px 0 0; padding: 0; position: relative; }
.gw-timeline::before { content: ''; position: absolute; left: 15px; top: 12px; bottom: 12px; width: 2px; background: var(--gw-line); }
.gw-tl-item { display: flex; align-items: center; gap: 14px; padding: 10px 0; position: relative; border-radius: 0; }
.gw-tl-item:hover { background: var(--gw-soft); }
.gw-tl-dot { width: 32px; height: 32px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--gw-surface); border: 2px solid var(--gw-line-strong); color: var(--gw-muted); z-index: 1; }
.gw-tl-active .gw-tl-dot { border-color: var(--gw-accent); color: var(--gw-accent-text); background: color-mix(in oklab, var(--gw-surface) 85%, var(--gw-accent)); }
.gw-tl-ghost { border: none; color: #fff; background: var(--gw-brand-grad); box-shadow: 0 2px 8px rgba(56,71,255,.35); }
.gw-tl-active .gw-tl-ghost { color: #fff; background: var(--gw-brand-grad); box-shadow: 0 0 0 3px var(--gw-accent-soft), 0 2px 8px rgba(56,71,255,.35); }
.gw-tl-you { color: inherit; }
.gw-tl-body { flex: 1; min-width: 0; }
.gw-tl-title { font-weight: 600; display: flex; align-items: center; gap: 8px; }

/* export */
.gw-export-grid { }
.gw-export-card { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; transition: border-color .15s, transform .15s; }
.gw-export-card { background: transparent; }
.gw-export-card .gw-btn { align-self: stretch; margin-top: 6px; }
.gw-export-icon { width: 38px; height: 38px; border-radius: 0; display: inline-flex; align-items: center; justify-content: center; background: var(--gw-accent-soft); color: var(--gw-accent-text); }
.gw-export-title { font-weight: 650; font-size: 14.5px; }
.gw-pdf-card { display: flex; flex-direction: column; gap: 12px; animation: gw-pop .2s ease-out; }
.gw-pdf { width: 100%; height: 640px; border: 1px solid var(--gw-line); border-radius: 0; background: white; }

/* review */
.gw-review { flex: 1; min-height: 0; display: flex; }
.gw-review-list { width: 300px; flex: none; overflow-y: auto; padding: 14px 12px; border-right: 1px solid var(--gw-line); display: flex; flex-direction: column; gap: 8px; background: var(--gw-soft); }
.gw-proposal-card { display: flex; flex-direction: column; gap: 6px; cursor: pointer; padding: 12px; background: transparent; transition: border-color .15s, background .15s; }
.gw-proposal-card:hover { background: var(--gw-soft-2); }
.gw-card-active { background: var(--gw-accent-soft) !important; box-shadow: inset 3px 0 0 var(--gw-accent) !important; }
.gw-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.gw-card-title { font-weight: 600; font-size: 12.5px; text-transform: uppercase; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.gw-review-detail { flex: 1; min-width: 0; overflow-y: auto; }
.gw-detail { max-width: 1000px; margin: 0 auto; padding: 22px 24px 40px; display: flex; flex-direction: column; gap: 14px; }
.gw-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.gw-detail-title { font-size: 17px; font-weight: 700; letter-spacing: -.01em; margin-bottom: 6px; text-transform: uppercase; }
.gw-callout { display: flex; align-items: flex-start; gap: 9px; padding: 10px 12px; border-radius: 0; font-size: 13px; }
.gw-callout .gw-icon { margin-top: 1px; }
.gw-callout-info { background: var(--gw-accent-soft); }
.gw-callout-warn { background: color-mix(in oklab, var(--gw-warn) 14%, transparent); }
.gw-checks { display: flex; flex-direction: column; gap: 6px; }
.gw-check { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.gw-check-name { font-weight: 600; text-transform: capitalize; }
.gw-checks-ok { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--gw-good); }
.gw-changes { display: flex; flex-direction: column; gap: 16px; }
.gw-change { border: 1px solid var(--gw-line); border-radius: 0; overflow: hidden; }
.gw-change-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--gw-line); background: var(--gw-soft); }
.gw-change-heading { font-weight: 650; text-transform: uppercase; font-size: 12.5px; }
.gw-diff { display: grid; grid-template-columns: 1fr 1fr; }
.gw-diff-single { grid-template-columns: 1fr; }
.gw-diff-col { min-width: 0; }
.gw-diff-col + .gw-diff-col { border-left: 1px solid var(--gw-line); }
.gw-diff-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: 7px 14px; }
.gw-diff-before .gw-diff-label { color: var(--gw-bad); background: color-mix(in oklab, var(--gw-bad) 7%, transparent); }
.gw-diff-after .gw-diff-label { color: var(--gw-good); background: color-mix(in oklab, var(--gw-good) 8%, transparent); }
.gw-pre { margin: 0; padding: 12px 14px; white-space: pre-wrap; word-break: break-word; font-family: var(--gw-font, 'Courier Prime', monospace); font-size: 12.5px; line-height: 1.45; max-height: 460px; overflow: auto; }
.gw-preview { max-height: 200px; border-radius: 0; background: var(--gw-soft); border: 1px solid var(--gw-line); }

/* --- empty states, loading, welcome --- */
.gw-empty { margin: auto; max-width: 440px; padding: 40px 24px; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
.gw-empty-icon { width: 48px; height: 48px; border-radius: 0; display: inline-flex; align-items: center; justify-content: center; background: var(--gw-accent-soft); color: var(--gw-accent-text); margin-bottom: 4px; }
.gw-empty-title { font-weight: 700; font-size: 15px; }
.gw-empty-text { color: var(--gw-muted); font-size: 13px; margin-bottom: 6px; }
.gw-loading { margin: auto; display: flex; align-items: center; gap: 10px; color: var(--gw-muted); padding: 40px; }
.gw-spinner { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--gw-line-strong); border-top-color: var(--gw-accent); animation: gw-spin .8s linear infinite; }
.gw-welcome { margin: auto; max-width: 760px; padding: 40px 24px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px; animation: gw-fade .3s ease-out; }
.gw-welcome-mark { width: 72px; height: 72px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 6px; }
.gw-welcome-title { margin: 0; font-size: 28px; font-weight: 750; letter-spacing: -.03em; line-height: 1.15; }
.gw-welcome-text { margin: 0 0 14px; max-width: 520px; color: var(--gw-muted); font-size: 14.5px; }
.gw-welcome-cards { width: 100%; }
.gw-welcome-card { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; cursor: pointer; transition: border-color .15s, transform .15s, box-shadow .15s; }
.gw-welcome-card { background: transparent; }
.gw-welcome-card:hover { background: var(--gw-accent-soft); }

/* --- modal --- */
.gw-modal-backdrop { position: absolute; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(10,10,20,.45); backdrop-filter: blur(3px); animation: gw-fade .15s ease-out; }
.gw-modal { width: 100%; max-width: 520px; max-height: 100%; display: flex; flex-direction: column; border-radius: 0; border: 1px solid var(--gw-line-strong); background: var(--gw-surface); color: var(--gw-surface-fg); box-shadow: 0 24px 70px rgba(0,0,0,.4); animation: gw-pop .18s ease-out; }
.gw-modal-wide { max-width: 760px; }
.gw-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 4px 20px; }
.gw-modal-title { font-size: 16px; font-weight: 700; letter-spacing: -.01em; }
.gw-modal-body { padding: 10px 20px 4px; display: flex; flex-direction: column; gap: 14px; overflow-y: auto; }
.gw-modal-text { margin: 0; color: var(--gw-muted); font-size: 13.5px; }
.gw-modal-foot > .gw-btn + .gw-btn { margin-left: -1px; }
.gw-modal-foot { display: flex; justify-content: flex-end; gap: 0; padding: 16px 20px 18px; }
.gw-file-pill { display: inline-flex; align-items: center; gap: 8px; align-self: flex-start; padding: 6px 12px; border-radius: 0; background: var(--gw-soft-2); font-weight: 600; }
.gw-details-plain > summary { cursor: pointer; color: var(--gw-muted); font-size: 12.5px; margin-bottom: 8px; }

/* --- toast --- */
.gw-toasts { position: absolute; left: 0; right: 0; bottom: 18px; z-index: 120; display: flex; justify-content: center; pointer-events: none; }
.gw-toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; max-width: min(640px, calc(100% - 32px)); padding: 9px 9px 9px 14px; border-radius: 0; background: #23233a; color: #f2f2f8; box-shadow: 0 12px 34px rgba(0,0,0,.35); animation: gw-up .22s ease-out; transition: opacity .35s, transform .35s; }
.gw-toast .gw-btn { color: #f2f2f8; border-color: rgba(255,255,255,.25); background: rgba(255,255,255,.08); }
.gw-toast .gw-icon-btn { color: rgba(255,255,255,.7); }
.gw-toast-ok > .gw-icon { color: #4ad295; }
.gw-toast-err > .gw-icon { color: #ff8a80; }
.gw-toast-text { flex: 1; font-size: 13px; }
.gw-toast-leave { opacity: 0; transform: translateY(8px); }

/* --- assistant rail --- */
.gw-rail { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.gw-rail-head { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--gw-line); flex: none; }
.gw-rail-title { display: flex; align-items: center; gap: 6px; font-weight: 700; color: var(--gw-accent-text); flex: none; }
.gw-tabs { flex: 1; min-width: 0; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
.gw-tab-pill { display: inline-flex; align-items: center; gap: 2px; height: 26px; padding: 0 4px 0 10px; border-radius: 0; cursor: pointer; font-size: 12px; font-weight: 550; color: var(--gw-muted); white-space: nowrap; max-width: 170px; }
.gw-tab-pill:hover { background: var(--gw-soft-2); }
.gw-tab-pill-active { background: var(--gw-soft-2); color: inherit; }
.gw-tab-pill-title { overflow: hidden; text-overflow: ellipsis; padding-right: 6px; }
.gw-tab-pill-x { width: 18px; height: 18px; border: none; border-radius: 50%; background: transparent; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; color: var(--gw-muted); }
.gw-tab-pill-x:hover { background: var(--gw-line-strong); color: inherit; }
.gw-add-wrap { position: relative; }
.gw-chat-wrap { flex: 1; min-height: 0; flex-direction: column; }
.gw-chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.gw-chat-list { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 14px; }
.gw-chat-welcome { margin: auto 0; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 10px 6px; }
.gw-chat-hello { font-size: 17px; font-weight: 700; letter-spacing: -.01em; }
.gw-suggestions { display: flex; flex-direction: column; gap: 7px; width: 100%; margin-top: 10px; }
.gw-suggestion { text-align: left; padding: 9px 12px; border-radius: 0; border: none; background: transparent; cursor: pointer; font-size: 12.5px; transition: border-color .15s, background .15s; }
.gw-suggestion:hover { background: var(--gw-accent-soft); }
.gw-msg { display: flex; gap: 9px; align-items: flex-start; animation: gw-up .18s ease-out; }
.gw-msg-user { justify-content: flex-end; }
.gw-msg-text { max-width: 88%; font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
.gw-msg-user .gw-msg-text { padding: 8px 12px; border-radius: 0; background: var(--gw-accent); color: #fff; white-space: pre-wrap; }
.gw-msg-asst .gw-msg-text { padding-top: 3px; }
.gw-msg-asst .gw-msg-text p { margin: 0 0 8px; }
.gw-msg-asst .gw-msg-text p:last-child { margin-bottom: 0; }
.gw-msg-asst .gw-msg-text ul, .gw-msg-asst .gw-msg-text ol { margin: 0 0 8px; padding-left: 20px; }
.gw-msg-asst .gw-msg-text code { font-size: 12px; padding: 1px 5px; border-radius: 0; background: var(--gw-soft-2); }
.gw-chat-code { margin: 0 0 8px; padding: 10px 12px; border-radius: 0; background: var(--gw-paper, #dcebf0); color: var(--gw-ink); font-family: var(--gw-font, 'Courier Prime', monospace); font-size: 12px; white-space: pre-wrap; overflow-x: auto; }
.gw-chat-avatar { width: 26px; height: 26px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #fff; background: var(--gw-brand-grad); }
.gw-chat-avatar-lg { width: 44px; height: 44px; border-radius: 50%; margin-bottom: 4px; }
.gw-typing { display: inline-flex; gap: 4px; padding: 6px 0; }
.gw-typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--gw-muted); animation: gw-bounce 1.1s infinite ease-in-out; }
.gw-typing i:nth-child(2) { animation-delay: .15s; }
.gw-typing i:nth-child(3) { animation-delay: .3s; }
.gw-chat-err { margin: 0 12px 8px; }
.gw-composer { flex: none; padding: 8px 12px 10px; border-top: 1px solid var(--gw-line); display: flex; flex-direction: column; gap: 6px; }
.gw-composer-context { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--gw-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.gw-composer-context strong { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.gw-composer-box { display: flex; align-items: flex-end; gap: 6px; padding: 6px 6px 6px 12px; border-radius: 0; border: 1px solid var(--gw-line-strong); background-color: var(--gw-field-bg) !important; color: var(--gw-field-fg) !important; border-color: var(--gw-field-border); transition: border-color .15s, box-shadow .15s; }
.gw-composer-box:focus-within { border-color: var(--gw-accent); box-shadow: 0 0 0 3px var(--gw-accent-soft); }
.gw-composer-field { flex: 1; min-height: 22px; max-height: 180px; border: none; background: transparent; resize: none; outline: none; padding: 4px 0; line-height: 1.45; }
.gw-send { width: 32px; height: 32px; flex: none; border-radius: 0; border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; background: var(--gw-accent); color: #fff; transition: background .15s, opacity .15s; }
.gw-send:hover:not(:disabled) { background: var(--gw-accent-strong); }
.gw-send:disabled { opacity: .35; cursor: default; }
.gw-composer-hint { font-size: 10.5px; color: var(--gw-muted); text-align: center; }

/* --- focus mode --- */
.gw-focus .gw-topbar { height: 44px; }
.gw-focus .gw-nav, .gw-focus .gw-dd, .gw-focus .gw-statusbar, .gw-focus .gw-outline { display: none; }
.gw-focus .hsp-full { box-shadow: 0 0 0 1px var(--gw-line); }

.gw-root[data-theme="dark"] { --gw-surface: #1f2029; --gw-surface-fg: #ececf1; --gw-accent-text: #8b94ff; --gw-accent-soft: color-mix(in oklab, #3847FF 30%, transparent);
  --gw-field-bg: #15161d; --gw-field-fg: #e8e9ef; --gw-field-ph: #8b90a0; --gw-field-border: rgba(255,255,255,.14); }
.gw-root .gw-input, .gw-root .gw-textarea, .gw-root select.gw-input { background-color: var(--gw-field-bg) !important; color: var(--gw-field-fg) !important; border-color: var(--gw-field-border); }
.gw-root .gw-input:focus { border-color: var(--gw-accent); }
.gw-root .gw-composer-field, .gw-root .gw-find-field input { background: transparent !important; color: var(--gw-field-fg) !important; }
.gw-root .gw-input::placeholder, .gw-root .gw-textarea::placeholder, .gw-root .gw-composer-field::placeholder, .gw-root .gw-find-field input::placeholder { color: var(--gw-field-ph); opacity: 1; }
/* Joined groups: neighbouring boxes share one frame, split by divider lines. */
.gw-joined, .gw-joined-col { display: flex; gap: 0 !important; border: 1px solid var(--gw-line); background: var(--gw-soft); }
.gw-joined { flex-direction: row; align-items: stretch; }
.gw-joined-col { flex-direction: column; }
.gw-joined > *, .gw-joined-col > * { border: none !important; border-radius: 0 !important; margin: 0 !important; box-shadow: none !important; transform: none !important; }
.gw-joined > * { flex: 1 1 0; min-width: 0; }
.gw-joined > * + * { border-left: 1px solid var(--gw-line) !important; }
.gw-joined-col > * + * { border-top: 1px solid var(--gw-line) !important; }
.gw-btn-group { display: inline-flex; gap: 0 !important; }
.gw-btn-group > .gw-btn + .gw-btn { margin-left: -1px; }
.gw-btn-group > .gw-btn:hover:not(:disabled) { position: relative; z-index: 1; }
.gw-btn-group > .gw-btn-primary, .gw-btn-group > .gw-btn-danger { position: relative; z-index: 2; }
@keyframes gw-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes gw-pop { from { opacity: 0; transform: translateY(-4px) scale(.98) } to { opacity: 1; transform: none } }
@keyframes gw-up { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
@keyframes gw-spin { to { transform: rotate(360deg) } }
@keyframes gw-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: .45 } 40% { transform: translateY(-4px); opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .gw-root * { animation: none !important; transition: none !important; } }
@media (max-width: 1100px) { .gw-nav-item span { display: none; } .gw-nav-item { padding: 0 10px; } }
@media (max-width: 900px) { .gw-welcome-cards { grid-template-columns: 1fr; } .gw-grid2 { grid-template-columns: 1fr; } .gw-nav-item span { display: none; } .gw-review-list { width: 220px; } .gw-diff { grid-template-columns: 1fr; } }
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

function projectContextBlock(project, focusScene) {
  const scenes = (project && Array.isArray(project.scenes)) ? project.scenes : []
  const lines = scenes.map((s, i) =>
    '  ' + (i + 1) + '. ' + (s.heading || '(untitled)') + ' [scene id: ' + (s.id || '') + ']')
  return [
    '[Ghostwriter context — the writer is working on the screenplay project below in the Ghostwriter workspace. Use the ghost_* tools (see the ghostwriter:screenplay skill) with this project_id and stay on this project.]',
    'Project id: ' + (project.id || ''),
    'Project title: ' + (project.title || ''),
    'Current scenes (' + scenes.length + '):',
    lines.length ? lines.join('\n') : '  (none yet)',
    focusScene ? 'The writer is currently looking at: ' + (focusScene.heading || '(untitled)') + ' [scene id: ' + focusScene.id + '] — "this scene" means this one.' : '',
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

function GwChat({ project, sessionTitle, onTurnDone, focusScene, seed, active }) {
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
  const turnDoneRef = useRef(onTurnDone)
  turnDoneRef.current = onTurnDone

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
      // The agent may have edited the script: refresh the workspace now
      // instead of waiting for the next poll.
      if (turnDoneRef.current) turnDoneRef.current()
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
      await host.request('prompt.submit', { session_id: sid, text: projectContextBlock(project, focusScene).replace(/\n\n/g, '\n') + '\n' + text })
    } catch (e) {
      setBusy(false); setWaiting(false); setStreaming(false)
      setError('Send failed: ' + errInfo(e).text)
    }
  }

  // Pre-fill the box from "Ask about this scene" / "New scene" shortcuts.
  const fieldRef = useRef(null)
  useEffect(() => {
    if (!seed || !active) return
    setInput(seed.text)
    setTimeout(() => {
      const el = fieldRef.current
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
    }, 0)
  }, [seed && seed.n, active]) // eslint-disable-line react-hooks/exhaustive-deps
  // Auto-grow the composer.
  useEffect(() => {
    const el = fieldRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(180, el.scrollHeight) + 'px'
  }, [input])

  const live = waiting || streaming || streamText
  const empty = messages.length === 0 && !live
  const hasScenes = project && Array.isArray(project.scenes) && project.scenes.length > 0
  const suggestions = hasScenes ? [
    focusScene ? 'Tighten the dialogue in this scene' : 'Tighten the dialogue in the first scene',
    'Write the next scene',
    'Give me three title ideas',
    'What would make the ending land harder?',
  ] : [
    'Write an opening scene: a stranger walks into an all-night diner',
    'Help me outline a 10-page short',
    'Add a title page with my name',
  ]
  return jsxs('div', { className: 'gw-chat', children: [
    jsx('div', { className: 'gw-chat-list', ref: listRef, children: empty
      ? jsxs('div', { className: 'gw-chat-welcome', children: [
          jsx('div', { className: 'gw-chat-avatar gw-chat-avatar-lg', children: jsx(Logo, { size: 34, tone: 'white' }) }),
          jsx('div', { className: 'gw-chat-hello', children: 'What are we writing?' }),
          jsx('div', { className: 'gw-muted gw-small', children: 'Describe a scene, a change or a question. I write in proper screenplay format and you can undo anything.' }),
          jsx('div', { className: 'gw-suggestions gw-joined-col', children: suggestions.map((t) => jsx('button', {
            className: 'gw-suggestion', key: t, onClick: () => { setInput(t); if (fieldRef.current) fieldRef.current.focus() }, children: t })) }),
        ] })
      : messages.map((m, i) => jsx(ChatMessage, { role: m.role, text: m.text, key: i })) }),
    live ? jsx(ChatMessage, { role: 'assistant', text: streamText, typing: !streamText }) : null,
    error ? jsxs('div', { className: 'gw-callout gw-callout-warn gw-chat-err', children: [jsx(Icon, { name: 'alert', size: 15 }), error] }) : null,
    jsxs('div', { className: 'gw-composer', children: [
      focusScene ? jsxs('div', { className: 'gw-composer-context', title: 'The assistant knows which scene you are looking at', children: [
        jsx(Icon, { name: 'eye', size: 13 }), 'Looking at: ', jsx('strong', { children: focusScene.heading || 'untitled scene' })] }) : null,
      jsxs('div', { className: 'gw-composer-box', children: [
        jsx('textarea', {
          ref: fieldRef, className: 'gw-composer-field', value: input, rows: 1,
          placeholder: sid ? 'Ask for a scene, a rewrite, a note…' : 'Connecting…',
          disabled: !sid,
          onChange: (e) => setInput(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } },
        }),
        jsx('button', { className: 'gw-send', disabled: busy || !input.trim() || !sid, onClick: send, title: 'Send (Enter)', 'aria-label': 'Send',
          children: jsx(Icon, { name: 'send', size: 16 }) }),
      ] }),
      jsx('div', { className: 'gw-composer-hint', children: 'Enter to send · Shift+Enter for a new line' }),
    ] }),
  ] })
}

// Minimal, safe formatting for replies: paragraphs, bullet/numbered lists,
// **bold**, *italic*, `code`, and fenced blocks (shown in screenplay type).
function inlineMd(text, keyBase) {
  const out = []
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g
  let last = 0, m, k = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('**')) out.push(jsx('strong', { key: keyBase + '-' + k++, children: t.slice(2, -2) }))
    else if (t.startsWith('`')) out.push(jsx('code', { key: keyBase + '-' + k++, children: t.slice(1, -1) }))
    else out.push(jsx('em', { key: keyBase + '-' + k++, children: t.slice(1, -1) }))
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
function MdText({ text }) {
  const blocks = []
  const parts = String(text || '').split(/```[a-zA-Z]*\n?/)
  parts.forEach((part, pi) => {
    if (pi % 2 === 1) { blocks.push(jsx('pre', { className: 'gw-chat-code', key: 'c' + pi, children: part.replace(/\n$/, '') })); return }
    part.split(/\n{2,}/).forEach((para, i) => {
      const lines = para.split('\n').filter((l) => l.trim() !== '')
      if (!lines.length) return
      const key = pi + '-' + i
      if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
        const ordered = /^\s*\d/.test(lines[0])
        blocks.push(jsx(ordered ? 'ol' : 'ul', { key, children: lines.map((l, j) =>
          jsx('li', { key: j, children: inlineMd(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''), key + j) })) }))
      } else {
        blocks.push(jsx('p', { key, children: lines.flatMap((l, j) => j ? [jsx('br', { key: 'b' + j }), ...inlineMd(l, key + j)] : inlineMd(l, key + j)) }))
      }
    })
  })
  return blocks
}
function ChatMessage({ role, text, typing }) {
  const user = role === 'user'
  return jsxs('div', { className: 'gw-msg ' + (user ? 'gw-msg-user' : 'gw-msg-asst'), children: [
    user ? null : jsx('div', { className: 'gw-chat-avatar', children: jsx(Logo, { size: 20, tone: 'white' }) }),
    jsx('div', { className: 'gw-msg-text', children: typing
      ? jsxs('span', { className: 'gw-typing', 'aria-label': 'Thinking', children: [jsx('i', {}), jsx('i', {}), jsx('i', {})] })
      : (user ? text : jsx(MdText, { text })) }),
  ] })
}

function GwChatRail({ projects, currentPid, currentData, onClose, onTurnDone, focusScene, seed }) {
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
      jsx('div', { className: 'gw-rail-title', children: [jsx('span', { className: 'gw-brand-mark gw-brand-mark-sm', key: 'i', children: jsx(Logo, { size: 16, tone: 'white' }) }), jsx('span', { key: 't', children: 'Ghostwriter' })] }),
      jsx('div', { className: 'gw-tabs', children: tabs.map((t) => jsxs('div', {
        className: 'gw-tab-pill' + (t.id === activeKey ? ' gw-tab-pill-active' : ''),
        key: t.id, onClick: () => setActiveKey(t.id), title: sessionTitleForTab(t),
        children: [
          jsx('span', { className: 'gw-tab-pill-title', children: (t.title || 'Untitled') + (t.num > 1 ? ' · ' + t.num : '') }),
          tabs.length > 1 ? jsx('button', { className: 'gw-tab-pill-x', title: 'Close this chat', 'aria-label': 'Close this chat',
            onClick: (e) => { e.stopPropagation(); closeTab(t.id) }, children: jsx(Icon, { name: 'x', size: 12 }) }) : null,
        ] })) }),
      jsxs('div', { className: 'gw-add-wrap', ref: addWrapRef, children: [
        jsx('button', { className: 'gw-icon-btn', title: 'New chat', 'aria-label': 'New chat',
          onClick: (e) => { e.stopPropagation(); setMenuOpen((v) => !v) }, children: jsx(Icon, { name: 'plus' }) }),
        menuOpen ? jsxs('div', { className: 'gw-menu gw-menu-right', children: [
          activeTab ? jsxs('button', { className: 'gw-menu-item', onClick: () => newChatForProject(activeTab.projectId),
            children: [jsx(Icon, { name: 'chat', size: 15 }), jsx('span', { children: 'New chat about ' + (activeTab.title || 'this project') })] }) : null,
          allProjects.length > 1 ? jsx('div', { className: 'gw-menu-sep' }) : null,
          allProjects.length > 1 ? jsx('div', { className: 'gw-menu-label', children: 'Chat about another project' }) : null,
          allProjects.length > 1 ? allProjects.filter((p) => p.id !== activeProjectId).map((p) => jsxs('button', { className: 'gw-menu-item', key: p.id,
            onClick: () => openProjectTab(p.id), children: [jsx(Icon, { name: 'film', size: 15 }), jsx('span', { children: p.title || 'Untitled' })] })) : null,
        ] }) : null,
      ] }),
      jsx('button', { className: 'gw-icon-btn', title: 'Hide the assistant', 'aria-label': 'Hide the assistant', onClick: onClose, children: jsx(Icon, { name: 'x' }) }),
    ] }),
    // Every tab's chat stays mounted (hidden when inactive) so a background
    // chat keeps streaming while you work in another.
    tabs.map((t) => {
      const pd = projData[t.projectId]
      if (!pd) return null
      const isActive = t.id === activeKey
      return jsx('div', {
        key: t.id, className: 'gw-chat-wrap', style: { display: isActive ? 'flex' : 'none' },
        children: jsx(GwChat, { project: pd, sessionTitle: sessionTitleForTab(t), onTurnDone, active: isActive,
          focusScene: t.projectId === currentPid ? focusScene : null,
          seed: isActive ? seed : null })
      })
    }),
    !tabs.length ? jsx('div', { className: 'gw-muted gw-pad', children: 'No project selected.' }) : null,
  ] })
}

// Light text on the page body means the host uses a dark theme.
function hostIsDark() {
  try {
    const m = getComputedStyle(document.body).color.match(/\d+(\.\d+)?/g)
    if (!m) return true
    const [r, g, b] = m.map(Number)
    return (0.299 * r + 0.587 * g + 0.114 * b) > 140
  } catch (_) { return true }
}

export default {
  id: ID,
  name: 'Ghostwriter',
  description: 'Ghostwriter: write screenplays with your model — formatted pages, revisions with undo, Fountain / Final Draft / PDF export.',
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
      // The Ghostwriter mark as the sidebar icon; 'writing' is the fallback
      // for hosts that only render codicons.
      data: { path: '/ghostwriter', label: 'Ghostwriter', codicon: 'writing',
        icon: jsx(Logo, { size: 16, tone: hostIsDark() ? 'white' : 'black' }),
        iconUrl: hostIsDark() ? LOGO_IMG.dark64 : LOGO_IMG.light64 }
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
