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
// follows the format's own convention (Courier for a screenplay, a book serif
// for prose); an explicit pick overrides it. Everything here is plain CSS +
// vanilla JS — no dependencies.
const VIEW_KEY = 'gw.view.v1'
const FONTS = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: "-apple-system, 'Segoe UI', system-ui, sans-serif",
  mono: "'Courier New', ui-monospace, monospace",
}
const FONT_LABELS = { default: 'Auto', serif: 'Serif', sans: 'Sans', mono: 'Mono' }
const SIZES = { s: '11.5px', m: '13px', l: '15px', xl: '17px' }
const SIZE_LABELS = { s: 'S', m: 'M', l: 'L', xl: 'XL' }
const DEFAULT_VIEW = { theme: 'dark', font: 'default', size: 'm' }
function loadView() {
  try {
    const r = localStorage.getItem(VIEW_KEY)
    if (r) return { ...DEFAULT_VIEW, ...JSON.parse(r) }
  } catch (_) { /* corrupt store: fall back to defaults */ }
  return { ...DEFAULT_VIEW }
}
function saveView(v) { try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)) } catch (_) {} }
function useGwView() {
  const [view, setView] = useState(loadView)
  const update = (patch) => setView(v => { const n = { ...v, ...patch }; saveView(n); return n })
  return [view, update]
}
// The effective font for the current format: an explicit pick wins, otherwise
// the format's convention (monospace Courier for a screenplay, a serif for prose).
function effectiveFont(view, isProse) {
  if (view.font !== 'default' && FONTS[view.font]) return FONTS[view.font]
  return isProse ? FONTS.serif : FONTS.mono
}

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
// The screenplay pack reuses FullScene + the existing row (identical output);
// the prose pack renders book conventions (Part / Chapter / Section). New
// formats add a pack here keyed by their engine `name`.

function ProsePara({ e, sceneId, elIndex }) {
  const search = useContext(SearchCtx)
  const t = e.text == null ? '' : String(e.text)
  if (!t.trim()) return null
  const sceneHits = (search && sceneId != null && elIndex != null) ? search.matchesByScene[sceneId] : null
  const hits = sceneHits ? sceneHits[elIndex] : null
  const cm = search ? search.currentMatch : -1
  const content = (hits && t) ? renderHighlighted(t, hits, cm) : t
  return jsx('div', { className: 'prose-para', children: content })
}

// One prose block (Part / Chapter / Section / front matter) in the scroll view.
// It layers book styling on hsp-full-scene (inheriting spacing + the
// data-scene-id hook the scroll-spy and edit prefill rely on).
function ProseBlock({ scene, index }) {
  const search = useContext(SearchCtx)
  const kind = scene.kind || 'front'
  const paras = Array.isArray(scene.elements) ? scene.elements : []
  const titleCls = {
    part: 'prose-title-part',
    chapter: 'prose-title-chapter',
    section: 'prose-title-section',
  }[kind]
  const kids = []
  if (scene.heading) {
    let headContent = scene.heading
    const sceneHits = search ? search.matchesByScene[scene.id] : null
    const hits = sceneHits ? sceneHits.heading : null
    if (hits) headContent = renderHighlighted(scene.heading, hits, search.currentMatch)
    kids.push(jsx('div', { className: titleCls || '', children: headContent }, 'title'))
  }
  paras.forEach((p, j) => {
    if (p && p.kind === 'paragraph') kids.push(jsx(ProsePara, { e: p, sceneId: scene.id, elIndex: j, key: 'p' + j }))
  })
  return jsx('div', {
    className: 'hsp-full-scene prose-block prose-block-' + kind,
    'data-scene-id': scene.id,
    children: kids,
  })
}

const NAV_KIND_TAG = { part: 'Pt', chapter: 'Ch', section: '§', front: '·' }

const VIEW_PACKS = {
  screenplay: {
    Block: FullScene,
    navText: (s) => [
      jsx('span', { className: 'hsp-nav-idx', children: String((s.order || 0) + 1) }),
      jsx('span', { children: s.heading || '(untitled)' }),
    ],
  },
  prose: {
    Block: ProseBlock,
    navText: (s) => {
      const kind = s.kind || 'front'
      return [
        jsx('span', { className: 'hsp-nav-idx', children: NAV_KIND_TAG[kind] || '·' }),
        jsx('span', { className: 'prose-nav-title prose-nav-' + kind, children: s.heading || '(untitled)' }),
      ]
    },
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

function ProjectPicker({ projects, value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
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
    open && jsxs('div', { className: 'hsp-dd-list', role: 'listbox', children: projects.map(p => jsx('button', {
      className: `hsp-dd-item${p.id === value ? ' hsp-dd-item-active' : ''}`,
      role: 'option', 'aria-selected': p.id === value, key: p.id,
      onClick: () => { onChange(p.id); setOpen(false) },
      children: (p.title || p.id)
    })) })
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

  // Full-script scroll view: keep the scene list in sync with the scroll
  // position (scroll-spy) and let list clicks jump the scroll position.
  const fullRef = useRef(null)       // full-script scroll container
  const navRef = useRef(null)        // scene list container
  const suppressSpy = useRef(false)  // ignore scroll-spy during programmatic scroll
  const spyRaf = useRef(0)           // requestAnimationFrame throttle handle
  const goToTimer = useRef(0)        // timeout that clears suppressSpy
  const sceneIdRef = useRef(sceneId) // latest sceneId, readable inside the scroll handler
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
  const isProse = projectFormat === 'prose'
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

  const dirty = !!(draft && draft.sceneId && sceneById[draft.sceneId]
    && draft.text !== (sceneById[draft.sceneId].text || ''))

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

  // Edit the currently-active (scroll-focused) scene, guarding unsaved edits.
  function startEdit() {
    if (!scene || editing) return
    const begin = () => { setDraft({ sceneId: scene.id, text: scene.text || '' }); setEditing(true) }
    if (dirty) requireSaved(begin, `editing “${scene.heading || 'untitled'}”`)
    else begin()
  }

  async function doSaveScene() {
    if (!draft || !pid) return false
    setBusy(true); setNotice(null)
    try {
      // `draft.text` is the full edited region (slugline + body). The save
      // endpoint expects the heading + the body *without* the heading, so split
      // here — otherwise the slugline is prepended twice and the scene collapses
      // to just the slugline on re-parse. The edited slugline (first non-blank
      // line) is sent as `heading`.
      const lines = String(draft.text || '').split('\n')
      let hi = 0
      while (hi < lines.length && !lines[hi].trim()) hi++
      const bodyText = lines.slice(hi + 1).join('\n')
      await api(`/projects/${pid}/scenes/${draft.sceneId}`, {
        method: 'POST',
        body: { content: bodyText, heading: lines[hi], revision_id: activeRevId }
      })
      setDraft(null)
      setNotice({ kind: 'ok', text: 'Scene saved as a new revision.' })
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

  async function doExportMarkdown() {
    if (!pid) return
    setBusy(true)
    try {
      const r = await api(`/projects/${pid}/markdown`, { method: 'GET' })
      downloadText(r.markdown, r.filename)
      setNotice({ kind: 'ok', text: `Exported ${r.filename} (${r.size_bytes} bytes).` })
    } catch (e) {
      setNotice({ kind: 'err', text: `Markdown export failed: ${errInfo(e).text}` })
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

  const header = jsxs('div', { className: 'hsp-header', children: [
    jsx('div', { className: 'hsp-title', children: 'Ghostwriter' }),
    data ? jsx('span', { className: 'hsp-sub', title: 'Document format',
      children: isProse ? 'Prose' : 'Script' }) : null,
    jsxs('div', { className: 'hsp-header-right', children: [
      jsx('span', { className: 'hsp-sub', children:
        statusQ.data
          ? `${statusQ.data.projects} project${statusQ.data.projects === 1 ? '' : 's'} · v${statusQ.data.hermes_version}`
          : (failed ? 'backend unavailable' : 'connecting…') }),
      jsx('button', {
        className: 'hsp-btn hsp-btn-small hsp-btn-primary' + (chatOpen ? ' hsp-btn-on' : ''),
        title: chatOpen ? 'Close the side-by-side chat' : 'Chat with Ghostwriter side-by-side',
        onClick: () => { const next = !chatOpen; setChatOpen(next); if (next) setTab('script') },
        children: '💬 Chat'
      }),
      jsx('button', {
        className: 'hsp-btn hsp-btn-small',
        title: 'Create a new project from scratch (no file needed)',
        onClick: () => setNewProject({ title: '', author: '', format: 'screenplay', text: '' }),
        children: '+ New'
      }),
      jsxs('label', { className: 'hsp-btn hsp-btn-small', title: 'Import a screenplay (Fountain, text, Final Draft .fdx, PDF) or a book (Markdown)', children: [
        'Import…',
        jsx('input', { type: 'file', accept: '.fountain,.fdx,.pdf,.txt,.xml,.text,.md,text/plain,application/pdf', style: { display: 'none' }, onChange: onImportFile })
      ] })
    ] })
  ] })

  const projectPicker = projects.length > 1 ? jsx(ProjectPicker, {
    projects,
    value: pid || '',
    onChange: (newId) => requireSaved(() => setPid(newId), 'switching projects')
  }) : null

  const tabBar = jsxs('div', { className: 'hsp-tabs', children:
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
        className: `hsp-tab${active ? ' hsp-tab-active' : ''}`,
        key,
        onClick: () => setTab(key),
        children: [jsx('span', { children: label }), badge]
      })
    })})

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
          : jsxs('div', { className: 'hsp-script', children: [
              // scene navigator (click to jump; stays in sync with scroll position)
              jsx('div', { className: 'hsp-nav', ref: navRef, children: scenes.map(s =>
                jsx('button', {
                  className: `hsp-nav-row${sceneId === s.id ? ' hsp-nav-active' : ''}`,
                  'data-nav-id': s.id,
                  key: s.id,
                  onClick: () => {
                    if (s.id === sceneId) return
                    requireSaved(() => goToSceneNow(s.id),
                      `jumping to “${s.heading || 'untitled'}”`)
                  },
                  children: jsxs('span', { className: 'hsp-nav-text', children: pack.navText(s) })
                })) }),
              // scene area: header + full-script scroll view (or the editor)
              jsxs('div', { className: 'hsp-scenearea', children: [
                scene ? jsxs('div', { className: 'hsp-scenehead', children: [
                  jsx('div', { className: 'hsp-scenehead-title', children:
                    (scene.heading || '(untitled scene)') + (dirty ? '  ● unsaved' : '') }),
                  !editing ? jsx('button', { className: 'hsp-btn hsp-btn-small', onClick: startEdit, children: 'Edit' }) : null
                ] }) : null,
                // View settings: theme + font + size (persisted in localStorage).
                jsxs('div', { className: 'hsp-viewbar', children: [
                  jsx('button', {
                    className: 'hsp-btn hsp-btn-small hsp-iconbtn', type: 'button',
                    title: view.theme === 'dark' ? 'Switch to light (paper) theme' : 'Switch to dark theme',
                    onClick: () => updateView({ theme: view.theme === 'dark' ? 'light' : 'dark' }),
                    children: view.theme === 'dark' ? '☀' : '☾'
                  }),
                  jsx('span', { className: 'hsp-viewbar-sep', children: '|' }),
                  jsx('span', { className: 'hsp-viewbar-label', children: 'Font' }),
                  jsx('select', {
                    className: 'hsp-select hsp-vbsel', value: view.font,
                    onChange: (e) => updateView({ font: e.target.value }),
                    children: Object.keys(FONT_LABELS).map(k => jsx('option', { value: k, key: k, children: FONT_LABELS[k] }))
                  }),
                  jsx('span', { className: 'hsp-viewbar-label', children: 'Size' }),
                  jsx('select', {
                    className: 'hsp-select hsp-vbsel', value: view.size,
                    onChange: (e) => updateView({ size: e.target.value }),
                    children: Object.keys(SIZE_LABELS).map(k => jsx('option', { value: k, key: k, children: SIZE_LABELS[k] }))
                  }),
                ] }),
                // Search / find & replace bar (persistent; highlights appear as you type).
                jsxs('div', { className: 'hsp-searchbar', children: [
                  jsx('span', { className: 'hsp-searchbar-ico', children: '🔍' }),
                  jsx('input', {
                    className: 'hsp-searchbar-input', type: 'text',
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
                ] }),
                editing && draft
                  ? jsxs('div', { className: 'hsp-editor', children: [
                      jsx('textarea', {
                        className: 'hsp-textarea',
                        value: draft.text,
                        onChange: (e) => setDraft({ sceneId: draft.sceneId, text: e.target.value }),
                        spellCheck: false
                      }),
                      jsxs('div', { className: 'hsp-actions', children: [
                        jsx('button', { className: 'hsp-btn hsp-btn-primary', disabled: busy, onClick: () => doSaveScene(), children: busy ? 'Saving…' : 'Save scene' }),
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
                      scenes.map((s, i) => jsx(pack.Block, { scene: s, index: i, key: s.id })),
                      jsx('div', { className: 'hsp-hint hsp-full-hint', children:
                        isProse
                          ? 'Scroll to read the whole manuscript — the list highlights the block at the top edge. Click a block to jump; use Edit to change it.'
                          : 'Scroll to read the whole script — the list highlights the scene at the top edge. Click a scene to jump; use Edit to change it.' })
                    ] })
              ] })
            ] })

  // Side-by-side split (feature #3): when the Chat rail is open, the manuscript
  // shares the Script tab with a compact chat column — read your text and talk
  // to the model at the same time, in the same view (no separate window/tab).
  const scriptTab = chatOpen
    ? jsxs('div', { className: 'hsp-split', children: [
        jsx('div', { className: 'hsp-split-main', children: scriptInner }),
        jsx(GwChat, {
          projectTitle: (data && data.project && data.project.title) || null,
          onClose: () => setChatOpen(false)
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
    !isProse ? jsxs('div', { className: 'hsp-export-fountain', children: [
      jsx('div', { className: 'hsp-list-label', children:
        'Fountain (.fountain) — opens in Fountain, Final Draft, Highland, or any Fountain-compatible tool' }),
      jsx('button', { className: 'hsp-btn hsp-btn-primary', disabled: busy, onClick: () => doExportFountain(),
        children: busy ? 'Preparing…' : 'Export current revision as Fountain' })
    ] })
      : jsxs('div', { className: 'hsp-export-markdown', children: [
        jsx('div', { className: 'hsp-list-label', children:
          'Markdown (.md) — the document’s canonical Markdown source (lossless round-trip)' }),
        jsx('button', { className: 'hsp-btn hsp-btn-primary', disabled: busy, onClick: () => doExportMarkdown(),
          children: busy ? 'Preparing…' : 'Export current revision as Markdown' })
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
    jsx('div', { className: 'hsp-hint', children: 'Start from scratch — no file needed. Paste Fountain or Markdown, or leave it blank and build it in chat.' }),
    jsxs('div', { className: 'hsp-import-field', children: [
      jsx('label', { children: 'Title' }),
      jsx('input', { className: 'hsp-input', autoFocus: true, value: newProject.title, placeholder: 'My screenplay', onChange: (e) => setNewProject({ ...newProject, title: e.target.value }) })
    ] }),
    jsxs('div', { className: 'hsp-import-field', children: [
      jsx('label', { children: 'Author' }),
      jsx('input', { className: 'hsp-input', value: newProject.author, placeholder: 'Optional', onChange: (e) => setNewProject({ ...newProject, author: e.target.value }) })
    ] }),
    jsxs('div', { className: 'hsp-import-field', children: [
      jsx('label', { children: 'Format' }),
      jsx('select', { className: 'hsp-select', value: newProject.format, onChange: (e) => setNewProject({ ...newProject, format: e.target.value }), children: [
        jsx('option', { value: 'screenplay', children: 'Screenplay (Fountain)' }),
        jsx('option', { value: 'prose', children: 'Book (Markdown)' })
      ] })
    ] }),
    jsxs('div', { className: 'hsp-import-field', children: [
      jsx('label', { children: 'Initial text (optional — leave blank to start empty)' }),
      jsx('textarea', { className: 'hsp-textarea hsp-textarea-small', value: newProject.text, placeholder: newProject.format === 'prose' ? 'Paste Markdown…' : 'Paste Fountain…', onChange: (e) => setNewProject({ ...newProject, text: e.target.value }) })
    ] }),
    jsxs('div', { className: 'hsp-actions', children: [
      jsx('button', { className: 'hsp-btn hsp-btn-primary', disabled: busy || !(newProject.title || '').trim(), onClick: () => doNewProject(),
        children: busy ? 'Creating…' : 'Create project' }),
      jsx('button', { className: 'hsp-btn', disabled: busy, onClick: () => setNewProject(null), children: 'Cancel' })
    ] })
  ] }) : null

  return jsx(SearchCtx.Provider, { value: searchState, children: jsxs('div', {
    className: 'hsp-pane',
    'data-gw-theme': view.theme,
    style: {
      '--gw-font': effectiveFont(view, isProse),
      '--gw-size': SIZES[view.size] || SIZES.m,
    },
    children: [
    header,
    projectPicker,
    tabBar,
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
          `You have unsaved edits in the scene editor. ${guard.label ? guard.label + '. ' : ''}Save or discard them first.` }),
        jsxs('div', { className: 'hsp-guard-actions', children: [
          jsx('button', { className: 'hsp-btn hsp-btn-primary', disabled: busy,
            onClick: async () => {
              const ok = await doSaveScene()
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
.hsp-pane { display: flex; flex-direction: column; gap: 8px; padding: 12px; font-size: 13px; height: 100%; box-sizing: border-box; overflow: hidden; }
.hsp-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hsp-header-right { display: flex; align-items: center; gap: 10px; min-width: 0; }
.hsp-title { font-weight: 650; font-size: 15px; }
.hsp-sub { opacity: 0.65; font-size: 12px; }
.hsp-select { width: 100%; padding: 6px 8px; border-radius: 8px; border: 1px solid color-mix(in oklab, currentColor 30%, transparent); background: #141418; color: #f0f0f4; font-size: 13px; }
select.hsp-select option { background: #141418; color: #f0f0f4; }
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
/* Prose (book) reading view — layered on hsp-full-scene so the scroll-spy and
   spacing work for free; override the monospace with a book-like serif and add
   part/chapter/section hierarchy. */
.prose-block { font-family: Georgia, 'Times New Roman', serif; font-size: 13px; line-height: 1.6; }
.prose-block-part { padding-top: 30px; }
.prose-title-part { text-align: center; font-size: 22px; font-weight: 600; letter-spacing: 0.01em; padding: 6px 0 2px; }
.prose-title-chapter { text-align: center; font-size: 17px; font-weight: 600; padding: 2px 0; }
.prose-title-section { font-size: 13.5px; font-weight: 700; padding-top: 10px; }
.prose-para { text-indent: 1.4em; margin: 0 0 8px; }
.prose-nav-title { font-weight: 600; }
.prose-nav-chapter { margin-left: 12px; }
.prose-nav-section { margin-left: 24px; font-weight: 400; opacity: 0.85; }
.hsp-raw { white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; margin: 0; opacity: 0.9; }
.hsp-editor { display: flex; flex-direction: column; gap: 8px; }
.hsp-textarea { width: 100%; box-sizing: border-box; min-height: 260px; resize: vertical; background: transparent; color: inherit; border: 1px solid color-mix(in oklab, currentColor 22%, transparent); border-radius: 8px; padding: 8px; font-family: 'Courier New', ui-monospace, monospace; font-size: 12.5px; line-height: 1.5; }
.hsp-textarea-small { min-height: 72px; font-family: inherit; }
.hsp-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hsp-btn { appearance: none; border: 1px solid color-mix(in oklab, currentColor 25%, transparent); background: transparent; color: inherit; border-radius: 7px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; text-decoration: none; display: inline-block; }
.hsp-btn:hover { background: color-mix(in oklab, currentColor 8%, transparent); }
.hsp-btn:disabled { opacity: 0.45; cursor: default; }
.hsp-btn-primary { background: #262631; color: #f2f2f5; border-color: color-mix(in oklab, currentColor 40%, transparent); font-weight: 600; }
.hsp-btn-primary:hover { background: #33333f; }
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
.hsp-guard-box { background: color-mix(in oklab, currentColor 6%, #2b2b30); color: inherit; border: 1px solid color-mix(in oklab, currentColor 25%, transparent); border-radius: 12px; padding: 16px; width: min(420px, 80vw); display: flex; flex-direction: column; gap: 10px; }
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
.hsp-dd-list { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 50; max-height: 280px; overflow-y: auto; background: #141418; color: #f0f0f4; border: 1px solid color-mix(in oklab, currentColor 30%, transparent); border-radius: 10px; padding: 4px; display: flex; flex-direction: column; gap: 2px; box-shadow: 0 10px 28px rgba(0,0,0,0.5); }
.hsp-dd-item { appearance: none; border: 1px solid transparent; background: transparent; color: inherit; text-align: left; padding: 6px 10px; border-radius: 7px; cursor: pointer; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hsp-dd-item:hover { background: rgba(255,255,255,0.10); }
.hsp-dd-item-active { background: rgba(255,255,255,0.16); color: #ffffff; font-weight: 600; }
/* ---- View settings: font + size + light "paper" theme ----
   --gw-font / --gw-size are set inline on .hsp-pane (see effectiveFont/SIZES).
   The reading surface (paper) switches between the host's dark surface and a
   warm-white light theme; the chrome (header, tabs, scene head) keeps the
   host theme. All of this is plain CSS — no dependencies. */
.hsp-full-scene, .prose-block { font-family: var(--gw-font, 'Courier New', ui-monospace, monospace); font-size: var(--gw-size, 13px); }
.hsp-full-heading { font-size: var(--gw-size, 13px); }
.hsp-pane[data-gw-theme="light"] .hsp-full { background: #f7f4ee; color: #1c1a17; border-color: #d8d2c6; }
.hsp-pane[data-gw-theme="light"] .hsp-full-scene { border-bottom-color: rgba(28,26,23,0.10); }
.hsp-pane[data-gw-theme="light"] .hsp-full-idx { opacity: 0.55; }
.hsp-viewbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hsp-viewbar-label { opacity: 0.6; font-size: 11.5px; }
.hsp-viewbar-sep { opacity: 0.3; font-size: 11px; }
/* search / find & replace bar */
.hsp-searchbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.hsp-searchbar-ico { opacity: 0.6; font-size: 13px; }
.hsp-searchbar-input { flex: 1 1 120px; min-width: 96px; padding: 4px 8px; border-radius: 7px; border: 1px solid color-mix(in oklab, currentColor 30%, transparent); background: #141418; color: #f0f0f4; font-size: 12.5px; }
.hsp-searchbar-input::placeholder { color: color-mix(in oklab, currentColor 45%, transparent); }
.hsp-searchbar-count { opacity: 0.6; font-size: 11.5px; white-space: nowrap; }
/* search highlights: yellow background, blue font; the current hit is stronger. */
.hsp-mark { background: #ffe873; color: #1a3fbf; border-radius: 2px; padding: 0 1px; }
.hsp-mark-current { background: #ffcf33; color: #102a9e; box-shadow: 0 0 0 1px #ffcf33; }
.hsp-vbsel { width: auto; min-width: 74px; padding: 3px 7px; font-size: 11.5px; background: transparent; color: inherit; }
select.hsp-vbsel option { background: #141418; color: #f0f0f4; }
.hsp-iconbtn { padding: 3px 9px; font-size: 14px; line-height: 1; }
/* ---- side-by-side chat rail (feature #3) ----
   The manuscript and the chat share the Script tab: a two-column grid where the
   text stays on the left and a compact, plugin-owned chat docks on the right —
   read and talk at once, no separate window. Colors follow the host theme via
   currentColor/color-mix, so it works in both dark and light host themes. */
.hsp-btn-on { border-color: currentColor; background: color-mix(in oklab, currentColor 16%, transparent); }
.hsp-split { display: grid; grid-template-columns: minmax(0, 1fr) clamp(300px, 32vw, 400px); grid-template-rows: minmax(0, 1fr); gap: 10px; flex: 1; min-height: 0; }
.hsp-split-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.gw-chat { display: flex; flex-direction: column; height: 100%; min-height: 0; border: 1px solid color-mix(in oklab, currentColor 14%, transparent); border-radius: 10px; background: color-mix(in oklab, currentColor 4%, transparent); overflow: hidden; }
.gw-chat-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid color-mix(in oklab, currentColor 14%, transparent); }
.gw-chat-title { font-weight: 650; font-size: 12.5px; display: flex; align-items: baseline; gap: 4px; min-width: 0; }
.gw-chat-proj { opacity: 0.55; font-weight: 400; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gw-chat-close { padding: 2px 8px; font-size: 12px; flex: none; }
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
`

// ---------- Ghostwriter chat session (Design 1) ----------
// A dedicated, plugin-owned Hermes session the user can talk to from the
// Chat button / palette / keybind. The model's ghost_* tools operate on the
// projects this page edits, so the chat and the workspace stay in sync.
//
// Identity is by TITLE, mirroring the built-in Bot Chat's canonical
// forever-chat: the gateway's exact-title index makes "Ghostwriter" a stable
// registry, so every open consults it directly. That lookup is window-free and
// reaches the row even when the session is idle/closed across an app restart —
// a plain live `session.list` scan would miss it there and mint a duplicate.
// We adopt the existing row when present (history survives restarts) and only
// create when there is none.
const GHOSTWRITER_TITLE = 'Ghostwriter'
async function getGhostwriterSession() {
  try {
    // Indexed `WHERE title = ?` (not a live listing): reaches idle rows.
    // include_hidden guards a future hidden flag; 200 mirrors the core picker.
    const list = await host.request('session.list', {
      title: GHOSTWRITER_TITLE,
      limit: 200,
      include_hidden: true,
    })
    const sessions = (list && list.sessions) || []
    const existing = sessions.find((s) =>
      /ghostwriter/i.test(s.root_title || s.title || '')
    )
    if (existing) return existing
  } catch (_) {
    // A transient lookup failure (backend mid-warm) falls through to create;
    // project data lives in the DB, not the session, so a fresh chat is safe.
  }
  return host.request('session.create', { title: GHOSTWRITER_TITLE })
}
// The side-by-side chat rail (feature #3). A compact, plugin-owned chat that
// renders BESIDE the manuscript in the same view, so the user reads their text
// and talks to the model at once — no separate window or tab. It drives the same
// title-adopted Ghostwriter session as the Chat button: the transcript loads via
// session.history, prompts go through prompt.submit, and the live reply streams
// over message.* events. Every event is filtered to this session's id, so a chat
// happening elsewhere can't bleed into the rail. Zero dependencies — plain React
// state + the host's gateway bridge.
function GwChat({ projectTitle, onClose }) {
  const [sid, setSid] = useState(null)
  const [messages, setMessages] = useState([]) // { role, text }[]
  const [input, setInput] = useState('')
  const [streamText, setStreamText] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const listRef = useRef(null)
  const streamRef = useRef('')     // in-progress assistant text (read on complete)
  const turnActive = useRef(false) // true between message.start and message.complete

  // Resolve the shared Ghostwriter session and load its transcript.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const s = await getGhostwriterSession()
        if (!alive || !s) return
        // Adopted rows carry the compression-lineage tip as resolved_id; a fresh
        // create reports stored_session_id. Bare id is the fallback.
        const id = s.resolved_id || s.stored_session_id || s.id || s.session_id
        if (!alive || !id) return
        setSid(id)
        const h = await host.request('session.history', { session_id: id })
        if (!alive) return
        const msgs = (h && Array.isArray(h.messages))
          ? h.messages.map((m) => ({ role: m.role, text: m.text || '' })).filter((m) => m.text)
          : []
        setMessages(msgs)
      } catch (e) {
        if (alive) setError(`Chat unavailable: ${errInfo(e).text}`)
      }
    })()
    return () => { alive = false }
  }, [])

  // Stream the live reply for THIS session only.
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
      // Prefer the gateway's authoritative final text; fall back to what streamed.
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

  // Keep the newest message in view.
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
      await host.request('prompt.submit', { session_id: sid, text })
    } catch (e) {
      setBusy(false); setWaiting(false); setStreaming(false)
      setError(`Send failed: ${errInfo(e).text}`)
    }
  }

  const live = waiting || streaming || streamText
  const empty = messages.length === 0 && !live
  return jsxs('div', { className: 'gw-chat', children: [
    jsxs('div', { className: 'gw-chat-head', children: [
      jsxs('div', { className: 'gw-chat-title', children: [
        '💬 Ghostwriter',
        projectTitle ? jsx('span', { className: 'gw-chat-proj', children: ' · ' + projectTitle }) : null
      ] }),
      jsx('button', { className: 'hsp-btn hsp-btn-small hsp-btn-ghost gw-chat-close', title: 'Close chat', onClick: onClose, children: '✕' })
    ] }),
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

export default {
  id: ID,
  name: 'Ghostwriter',
  description: 'Ghostwriter: a local writing workspace for screenplays and prose — parse, revise, propose, validate, and export PDF/Markdown.',
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
