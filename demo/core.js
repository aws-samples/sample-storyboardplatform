
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length

export function orderKeyBetween(a, b) {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`orderKeyBetween: a(${a}) must sort before b(${b})`)
  }
  const out = []
  for (let i = 0; i < 48; i++) {
    const ad = a !== null && i < a.length ? DIGITS.indexOf(a[i]) : 0
    const bd = b !== null && i < b.length ? DIGITS.indexOf(b[i]) : BASE
    if (bd - ad > 1) {
      out.push(DIGITS[Math.floor((ad + bd) / 2)])
      return out.join('')
    }
    out.push(DIGITS[ad])
  }
  throw new Error('orderKeyBetween: key too deep, rebalance needed')
}

export function orderKeyForIndex(keys, index) {
  const before = index > 0 ? keys[index - 1] : null
  const after = index < keys.length ? keys[index] : null
  return orderKeyBetween(before, after)
}

export const byOrderKey = (x, y) => (x.orderKey < y.orderKey ? -1 : x.orderKey > y.orderKey ? 1 : 0)

export const STATUS = {
  draft: { label: '초안', tone: 'idle' },
  in_progress: { label: '작업 중', tone: 'work' },
  in_review: { label: '리뷰 대기', tone: 'wait' },
  changes_requested: { label: '수정 요청', tone: 'reject' },
  approved: { label: '승인', tone: 'approve' },
}

export const TRANSITIONS = {
  assign: { draft: 'in_progress', approved: 'in_progress', changes_requested: 'in_progress' },
  submit: { in_progress: 'in_review', draft: 'in_review' },
  approve: { in_review: 'approved' },
  request_changes: { in_review: 'changes_requested', approved: 'changes_requested' },
  resume: { changes_requested: 'in_progress' },
  reopen: { approved: 'in_progress' },
}

export const ACTIONS = {
  assign: { label: '담당 지정', roles: ['director', 'planner', 'admin'] },
  submit: { label: '리뷰 요청', roles: ['artist', 'planner', 'director', 'admin'] },
  approve: { label: '승인', roles: ['director', 'admin'] },
  request_changes: { label: '수정 요청', roles: ['director', 'admin', 'reviewer'] },
  resume: { label: '수정 시작', roles: ['artist', 'planner', 'director', 'admin'] },
  reopen: { label: '승인 해제', roles: ['director', 'admin'] },
}

export const ROLES = {
  planner: '기획',
  artist: '아티스트',
  director: '감독',
  reviewer: '리뷰어',
  admin: '관리자',
}

export function canTransition(role, from, action) {
  const spec = ACTIONS[action]
  if (!spec) return { ok: false, reason: '알 수 없는 액션' }
  if (!spec.roles.includes(role)) return { ok: false, reason: `${ROLES[role]}에게 권한이 없습니다` }
  const to = TRANSITIONS[action]?.[from]
  if (!to) return { ok: false, reason: `${STATUS[from].label} 상태에서는 할 수 없습니다` }
  return { ok: true, to }
}

export function canEditContent(role, panel) {
  if (panel.status === 'approved') return false
  if (role === 'reviewer') return false
  return true
}

export const ART_ROLES = ['artist', 'planner']
export const canMakeArt = (role) => ART_ROLES.includes(role)

export const PLAN_ROLES = ['planner', 'director']
export const canPlan = (role) => PLAN_ROLES.includes(role)

export const ADMIN_VIEW_ROLES = ['director']
export const canSeeAdmin = (role) => ADMIN_VIEW_ROLES.includes(role)

export const canGrantRole = (role) => role === 'admin'

export const NEEDS = {
  unassigned: { label: '담당 없음', hit: (p) => !p.assignee && p.status !== 'approved' },
  in_review: { label: '리뷰 대기', hit: (p) => p.status === 'in_review' },
  changes_requested: { label: '수정 요청', hit: (p) => p.status === 'changes_requested' },
  open: { label: '진행 중', hit: (p) => p.status !== 'approved' },
  all: { label: '전체', hit: () => true },
}

export function workload(panels, ids = []) {
  const blank = () => ({ open: 0, approved: 0, by: {}, cuts: [] })
  const out = {}
  for (const id of ids) out[id] = blank()
  for (const p of panels || []) {
    if (!p.assignee) continue
    const w = (out[p.assignee] ??= blank())
    w.by[p.status] = (w.by[p.status] || 0) + 1
    if (p.status === 'approved') w.approved++
    else { w.open++; w.cuts.push(p) }
  }
  return out
}

const RANK = { draft: 0, changes_requested: 0.5, in_progress: 1, in_review: 2, approved: 3 }

export function tally(panels) {
  const t = { n: 0, byStatus: {}, unassigned: 0, generating: 0, secs: 0, secsDone: 0 }
  for (const p of panels || []) {
    t.n++
    t.byStatus[p.status] = (t.byStatus[p.status] || 0) + 1
    if (NEEDS.unassigned.hit(p)) t.unassigned++
    if (p.generating) t.generating++
    if (p.charId == null) {
      t.secs += Number(p.secs) || 0
      if (p.status === 'approved') t.secsDone += Number(p.secs) || 0
    }
  }
  return t
}

export function stalls(panels, events, at) {
  const last = {}
  for (const e of events || []) last[e.panelId] = e.ts
  return (panels || [])
    .map((p) => {
      const since = last[p.id] || touchedAt(p)
      return { p, since, secs: since ? Math.max(0, (at - since) / 1000) : 0, known: !!since }
    })
    .sort((a, b) => b.secs - a.secs)
}

export function retakes(events) {
  const out = {}
  for (const e of events || []) if (e.to === 'changes_requested') out[e.panelId] = (out[e.panelId] || 0) + 1
  return out
}

export function flow(events) {
  const seen = new Map()
  let fwd = 0
  let back = 0
  for (const e of events || []) {
    const isBack = (RANK[e.to] ?? 0) < (RANK[e.from] ?? 0)
    if (isBack) back++
    else fwd++
    const key = `${e.from}>${e.to}`
    const row = seen.get(key) || { from: e.from, to: e.to, n: 0, back: isBack }
    row.n++
    seen.set(key, row)
  }
  return { fwd, back, pairs: [...seen.values()].sort((a, b) => b.n - a.n) }
}

export function pace(events, at) {
  const day = Math.floor(at / 864e5) * 864e5
  const today = (events || []).filter((e) => e.ts >= day)
  if (!today.length) return { cols: [], total: 0 }
  const hour = 36e5
  const end = Math.floor(Math.max(at, ...today.map((e) => e.ts)) / hour) * hour
  const cols = []
  for (let h = Math.floor(Math.min(...today.map((e) => e.ts)) / hour) * hour; h <= end; h += hour) {
    cols.push({ h, n: today.filter((e) => e.ts >= h && e.ts < h + hour).length })
  }
  return { cols, total: today.length }
}

export function actorPace(events, at) {
  const day = Math.floor(at / 864e5) * 864e5
  const out = {}
  for (const e of events || []) {
    if (e.ts < day || !e.actor) continue
    const a = (out[e.actor] ??= { n: 0, by: {} })
    a.n++
    a.by[e.to] = (a.by[e.to] || 0) + 1
  }
  return out
}

export function firstPass(panels, events) {
  const redone = new Set((events || []).filter((e) => e.to === 'changes_requested').map((e) => e.panelId))
  const done = (panels || []).filter((p) => p.status === 'approved')
  return { total: done.length, clean: done.filter((p) => !redone.has(p.id)).length }
}

export function reviewLag(panels, events) {
  const firstAt = (id, to) => (events || []).find((e) => e.panelId === id && e.to === to)?.ts || 0
  const spans = (panels || [])
    .filter((p) => p.status === 'approved')
    .map((p) => firstAt(p.id, 'approved') - firstAt(p.id, 'in_review'))
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b)
  return spans.length ? spans[(spans.length - 1) >> 1] / 1000 : null
}

export function fmtDur(secs) {
  const m = Math.floor((Number(secs) || 0) / 60)
  if (m < 1) return '방금'
  if (m < 60) return `${m}분`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}시간` : `${Math.floor(h / 24)}일`
}

export const POSES = ['정면', '3/4', '측면', '후면', '전신', '표정']

export const FEEDBACK_TAGS = ['구도', '조명', '배경', '의상', '표정', '비율']

export function mentionsIn(body, people = []) {
  let text = String(body || '')
  const out = []
  for (const p of [...people].sort((a, b) => (b.name || '').length - (a.name || '').length)) {
    if (!p.name || !text.includes(`@${p.name}`)) continue
    text = text.split(`@${p.name}`).join(' ')
    out.push(p.id)
  }
  return out
}

export function notifFor(op, panel, ctx = {}) {
  const out = []
  const from = op.comment?.author ?? op.actor
  const add = (to, kind) => {
    if (to && to !== from && !out.some((n) => n.to === to)) out.push({ to, kind })
  }
  if (op.kind === 'comment.add') {
    for (const id of mentionsIn(op.comment.body, ctx.people)) add(id, 'mention')
    if (op.comment.parentId) add(ctx.parentAuthor, 'reply')
    add(panel?.assignee, 'comment')
  } else if (op.kind === 'panel.status') {
    add(op.assignee, 'status')
  } else if (op.kind === 'panel.patch' && op.fields && 'assignee' in op.fields) {
    add(op.fields.assignee, 'assign')
  } else if (op.kind === 'panel.version.remove') {
    add(ctx.verAuthor, 'version')
    add(panel?.assignee, 'version')
  }
  return out
}

export function handBackTo(events, panelId, fallback) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.panelId === panelId && e.to === 'in_review') return e.actor
  }
  return fallback
}

export function sceneGroups(panels) {
  const out = []
  for (const p of panels) {
    const name = p.scene || ''
    if (!out.length || out.at(-1).name !== name) out.push({ name, cuts: [], secs: 0 })
    out.at(-1).cuts.push(p)
    out.at(-1).secs += Number(p.secs) || 0
  }
  return out
}

export function startTimes(panels) {
  const out = {}
  let t = 0
  for (const p of panels || []) { out[p.id] = t; t += Number(p.secs) || 0 }
  return out
}

export function clock(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const CAMERA_HINTS = [
  [/클로즈업|close|얼굴|눈/, 'CU'],
  [/와이드|전경|풍경|넓게/, 'WS'],
  [/미디엄|허리|상반신/, 'MS'],
  [/추적|따라가|달리/, 'TRACKING'],
  [/올려다|로우|아래에서/, 'LOW ANGLE'],
  [/내려다|하이|위에서/, 'HIGH ANGLE'],
]

export function splitScenario(text) {
  const blocks = String(text || '')
    .split(/\n[ \t]*\n|(?<=[.!?…])[ \t]+(?=[가-힣A-Z"'“])/)
    .map((s) => s.trim())
    .filter(Boolean)

  const isDialogue = (line) => /^["'“]|^[가-힣A-Za-z ]{1,10}\s*:/.test(line)

  return blocks.slice(0, 12).map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    const dialogue = lines.filter(isDialogue).join(' ')
    const action = lines.filter((l) => !isDialogue(l)).join(' ')
    const camera = CAMERA_HINTS.find(([re]) => re.test(block))?.[1] || 'MS'
    return { action: action || (dialogue ? '' : block), dialogue, camera }
  })
}

export const CAMERAS = ['WS', 'MS', 'CU', 'ECU', 'MCU', 'OTS', 'POV',
  'TWO SHOT', 'INSERT', 'TRACKING', 'PAN', 'TILT', 'LOW ANGLE', 'HIGH ANGLE']

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const asList = (v) => (Array.isArray(v) ? v : [])
const secsOf = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 2
  return Math.min(30, Math.max(0.5, Math.round(n * 10) / 10))
}

export function normalizePlan(raw, { maxChars = 4, maxCuts = 24 } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const chars = []
  const named = new Set()
  for (const c of asList(src.chars ?? src.characters)) {
    const name = clip(c?.name, 20)
    if (!name || named.has(name)) continue
    named.add(name)
    chars.push({ name, brief: clip(c?.brief ?? c?.description, 200) })
    if (chars.length >= maxChars) break
  }
  const cuts = []
  for (const c of asList(src.cuts ?? src.beats)) {
    const action = clip(c?.action ?? c?.summary, 300)
    const dialogue = clip(c?.dialogue, 200)
    if (!action && !dialogue) continue
    const cam = clip(c?.camera, 20).toUpperCase()
    cuts.push({
      scene: clip(c?.scene, 24),
      secs: secsOf(c?.secs ?? c?.duration),
      action,
      dialogue,
      camera: CAMERAS.includes(cam) ? cam : 'MS',
      cast: [...new Set(asList(c?.cast).map((n) => clip(n, 20)).filter(Boolean))].slice(0, 6),
    })
    if (cuts.length >= maxCuts) break
  }
  return {
    title: clip(src.title, 60),
    logline: clip(src.logline, 200),
    synopsis: clip(src.synopsis, 1200),
    chars,
    cuts,
  }
}

export function epLabel(ep) {
  if (!ep) return '본편'
  const t = String(ep.title || '').trim()
  if (ep.spinoff) return t ? `스핀오프 · ${t}` : '스핀오프'
  return t ? `${ep.epNo || 1}회 · ${t}` : `${ep.epNo || 1}회`
}

export function mergeField(target, field, value, ts) {
  const seen = target._ts?.[field] ?? 0
  if (ts < seen) return false
  target._ts = { ...(target._ts || {}), [field]: ts }
  target[field] = value
  return true
}

export const deadVer = (p, v) => !!v?.vid && Object.hasOwn(p?.dead || {}, v.vid)

export function liveVer(p) {
  const vs = p?.versions || []
  const cur = p?.current
  if (vs[cur] && !deadVer(p, vs[cur])) return { i: cur, ver: vs[cur] }
  for (let i = vs.length - 1; i >= 0; i--) if (!deadVer(p, vs[i])) return { i, ver: vs[i] }
  return null
}

export function lostEdit(rec, field, value, actor, meId) {
  if (!rec || !meId || actor === meId || rec._by?.[field] !== meId) return null
  const mine = rec[field]
  if (typeof mine !== 'string' || !mine.trim() || mine === value) return null
  return mine
}

export function isActionable(n) {
  return !!n && !(n.kind === 'status' && n.status === 'approved')
}

export function touchedAt(rec) {
  let max = 0
  for (const t of Object.values(rec?._ts || {})) if (t > max) max = t
  return max
}

export function changedSince(panels, since) {
  if (!since) return []
  return Object.values(panels || {})
    .filter((p) => touchedAt(p) > since)
    .sort((a, b) => touchedAt(a) - touchedAt(b))
    .map((p) => p.id)
}

export function debounceBy(ms, set = setTimeout, clear = clearTimeout) {
  const live = new Map()
  return (key, run) => {
    clear(live.get(key))
    live.set(key, set(() => { live.delete(key); run() }, ms))
  }
}

const RE = {
  id: /^[A-Za-z0-9._:#-]{1,64}$/,
  color: /^#[0-9A-Fa-f]{3,8}$/,
  src: /^(?:\/[\w./-]{1,200}|data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]{1,4000000})$/,
}

const SHAPE = {
  id: RE.id, panelId: RE.id, charId: RE.id, parentId: RE.id, refPanelId: RE.id,
  verId: RE.id,
  actor: RE.id, author: RE.id, assignee: RE.id, generating: RE.id, to: RE.id,
  epId: RE.id, fromEp: RE.id, centerChar: RE.id,
  userId: RE.id,
  at: RE.id, view: RE.id,
  color: RE.color, src: RE.src,
}
const NUMS = new Set(['x', 'y', 'secs', 'ts', 'onVersion', 'current', 'w', 'h', 'genAt', 'epNo'])

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

export function scrub(v, key = '') {
  if (Array.isArray(v)) return v.map((x) => scrub(x, key))
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = k === '_ts' ? x : scrub(x, k)
    if (typeof out.status === 'string' && !STATUS[out.status]) out.status = 'draft'
    if (typeof out.role === 'string' && !ROLES[out.role]) out.role = 'reviewer'
    return out
  }
  if (NUMS.has(key) || key === 'mark') return num(v)
  return SHAPE[key] && typeof v === 'string' ? (SHAPE[key].test(v) ? v : '') : v
}
