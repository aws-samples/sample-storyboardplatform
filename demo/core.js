
import { GRAPH_SCHEMA, romanizeId, edgeKey } from './graph-schema.js'

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

/**
 * 앞말의 받침을 보고 조사를 고른다. 인물 이름이 한국어라서 자동 생성 문장에 필요하다.
 * 한글이 아니면(영문 이름·id) 받침 있는 쪽으로 읽는다.
 *
 * @param {string} word - 조사가 붙을 앞말
 * @param {string} withJong - 받침이 있을 때 (은, 이, 을, 과)
 * @param {string} noJong - 받침이 없을 때 (는, 가, 를, 와)
 * @returns {string} 고른 조사
 */
export function josa(word, withJong, noJong) {
  const ch = String(word ?? '').trim().slice(-1)
  const code = ch ? ch.codePointAt(0) : 0
  if (code < 0xac00 || code > 0xd7a3) return withJong
  return (code - 0xac00) % 28 ? withJong : noJong
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

const KIND_OK = new Set(GRAPH_SCHEMA.nodeKinds)
const REL_OK = new Set(GRAPH_SCHEMA.edgeRels)
const DERIVED_ONLY = new Set(GRAPH_SCHEMA.derivedRels)

const asProps = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {})

/** 문자열을 노드 id 모양([a-z0-9_])으로 만든다. 한국어면 로마자로 옮긴다. */
const asId = (v) => {
  const raw = String(v ?? '').trim()
  if (!raw) return ''
  const slug = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return (slug || romanizeId(raw)).slice(0, 48)
}

const tensionOf = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100))
}

/**
 * 모델이 뽑아온 그래프 JSON을 검사하고 mock/graph.json 모양으로 맞춘다.
 * 여기를 통과한 것만 판에 올린다. 잘못된 입력이 보드 상태를 더럽히면 안 된다.
 *
 * 하는 일
 *   - nodes/edges 배열이 아니면 빈 배열로 두고 경고를 남긴다
 *   - 노드는 name 필수, kind 는 GRAPH_SCHEMA.nodeKinds 안의 값만 남긴다
 *   - id 가 없으면 이름의 로마자로 만들고, 겹치면 뒤에 번호를 붙인다
 *   - 같은 id 가 두 번 오면 처음 것을 남기고 props 만 합친다
 *   - 엣지는 s/o 가 실제 노드를 가리켜야 한다. 이름으로 왔으면 id 로 옮긴다
 *   - p 는 GRAPH_SCHEMA.edgeRels 안의 값만, 파생 전용 술어는 asserted:false 로 내린다
 *
 * @param {Object} raw - 모델이 준 {nodes, edges}
 * @param {Object} [opts]
 * @param {number} [opts.maxNodes=300] 노드 상한
 * @param {number} [opts.maxEdges=900] 엣지 상한
 * @returns {{nodes: Array, edges: Array, warnings: Array<string>}}
 */
export function normalizeGraph(raw, { maxNodes = 300, maxEdges = 900 } = {}) {
  const warnings = []
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (!raw || typeof raw !== 'object') warnings.push('그래프가 객체가 아니다 — 빈 그래프로 둔다')
  const rawNodes = src.nodes ?? src.entities
  const rawEdges = src.edges ?? src.relations ?? src.links
  if (!Array.isArray(rawNodes)) warnings.push('nodes 배열이 없다')
  if (!Array.isArray(rawEdges)) warnings.push('edges 배열이 없다')

  const nodes = []
  const byId = new Map()
  const byName = new Map()
  for (const n of asList(rawNodes)) {
    if (!n || typeof n !== 'object') { warnings.push('노드가 객체가 아니다 — 버린다'); continue }
    const name = clip(n.name ?? n.label, 60)
    const kind = clip(n.kind ?? n.type, 20)
    if (!name) { warnings.push(`이름 없는 노드를 버린다 (id=${clip(n.id, 40) || '없음'})`); continue }
    if (!KIND_OK.has(kind)) {
      warnings.push(`${name}: 모르는 kind "${kind || '없음'}" — 노드를 버린다`)
      continue
    }
    const props = asProps(n.props ?? n.attrs)
    const given = asId(n.id)
    let id = given
    if (!id) {
      id = asId(name) || `n${nodes.length + 1}`
      let seq = 2
      while (byId.has(id)) id = `${asId(name) || 'n'}_${seq++}`
      warnings.push(`${name}: id 가 없어 "${id}" 로 만들었다 — 통용 표기와 다를 수 있다`)
    }
    const prev = byId.get(id)
    if (prev) {
      prev.props = { ...props, ...prev.props }
      warnings.push(`중복 id "${id}" (${prev.name} / ${name}) — 처음 것만 남기고 props 를 합친다`)
      continue
    }
    if (nodes.length >= maxNodes) { warnings.push(`노드가 ${maxNodes}개를 넘어 나머지를 잘랐다`); break }
    const node = { id, kind, name, props }
    nodes.push(node)
    byId.set(id, node)
    if (!byName.has(name)) byName.set(name, id)
  }

  // 이름·로마자로 들어온 참조를 id 로 되돌리기 위한 색인
  const alias = new Map()
  for (const [name, id] of byName) {
    alias.set(name, id)
    const rom = romanizeId(name)
    if (rom && !byId.has(rom)) alias.set(rom, id)
  }
  const refOf = (v) => {
    const raw = String(v ?? '').trim()
    if (byId.has(raw)) return raw
    const id = asId(raw)
    if (byId.has(id)) return id
    const hit = alias.get(raw) ?? alias.get(id) ?? ''
    if (hit) warnings.push(`"${raw}" 는 id 가 아니라 이름이다 — "${hit}" 로 읽었다`)
    return hit
  }

  const edges = []
  const seen = new Set()
  for (const e of asList(rawEdges)) {
    if (!e || typeof e !== 'object') { warnings.push('엣지가 객체가 아니다 — 버린다'); continue }
    const sRaw = e.s ?? e.from ?? e.subject
    const oRaw = e.o ?? e.to ?? e.object
    const s = refOf(sRaw)
    const o = refOf(oRaw)
    const p = clip(e.p ?? e.rel ?? e.pred, 40).toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    const label = `${clip(sRaw, 40) || '없음'} ${p || '?'} ${clip(oRaw, 40) || '없음'}`
    if (!REL_OK.has(p)) { warnings.push(`${label}: 모르는 술어 — 엣지를 버린다`); continue }
    if (!s || !o) { warnings.push(`${label}: 없는 노드를 가리킨다 — 엣지를 버린다`); continue }
    if (s === o) { warnings.push(`${label}: 자기 자신을 가리킨다 — 엣지를 버린다`); continue }
    const key = edgeKey({ s, p, o })
    if (seen.has(key)) { warnings.push(`${label}: 같은 엣지가 두 번 왔다 — 처음 것만 남긴다`); continue }
    if (edges.length >= maxEdges) { warnings.push(`엣지가 ${maxEdges}개를 넘어 나머지를 잘랐다`); break }
    seen.add(key)

    const props = asProps(e.props)
    const t = tensionOf(props.tension ?? e.tension)
    if (t === null) delete props.tension
    else props.tension = t
    if (e.cause && !props.cause) props.cause = clip(e.cause, 200)

    let asserted = e.asserted === undefined ? !e.derived : !!e.asserted
    let derived = clip(e.derived, 40) || null
    if (DERIVED_ONLY.has(p) && asserted) {
      warnings.push(`${label}: 파생 전용 술어라 asserted:false 로 내린다`)
      asserted = false
      derived = derived || 'unknown'
    }
    const edge = { s, p, o, asserted }
    if (derived) edge.derived = derived
    if (Object.keys(props).length) edge.props = props
    edges.push(edge)
  }

  return { nodes, edges, warnings }
}

/** 노드 props 중 어긋나면 사실이 깨지는 키. t 와 kin 종류는 서사가 갈린다 */
const CANON_KEYS = { t: 'error', claim: 'warn', age: 'warn' }

/**
 * 새로 뽑은 그래프가 이미 확립된 그래프와 어긋나지 않는지 본다.
 * 예: 기존이 A kin_of B (sibling) 인데 새로 A kin_of B (parent) 로 오면 conflict.
 *
 * @param {Object} newGraph - 새로 추출한 {nodes, edges}
 * @param {Object} existingGraph - 이미 확립된 {nodes, edges}
 * @returns {{conflicts: Array<{level: string, kind: string, msg: string}>, compatible: boolean}}
 *          compatible 은 level 'error' 인 항목이 하나도 없을 때만 true
 */
export function validateAgainstCanon(newGraph, existingGraph) {
  const conflicts = []
  const put = (level, kind, msg) => conflicts.push({ level, kind, msg })
  const nn = asList(newGraph?.nodes)
  const ne = asList(newGraph?.edges)
  const on = asList(existingGraph?.nodes)
  const oe = asList(existingGraph?.edges)

  const oldById = new Map(on.map((n) => [n.id, n]))
  const oldByName = new Map(on.map((n) => [n.name, n]))

  for (const n of nn) {
    const prev = oldById.get(n.id)
    if (prev) {
      if (prev.kind !== n.kind) put('error', 'node_kind', `${n.id}: 기존 ${prev.kind} 인데 새로 ${n.kind} 로 왔다`)
      if (prev.name !== n.name) put('error', 'node_name', `${n.id}: 기존 "${prev.name}" 인데 새로 "${n.name}" 이다 — 다른 인물이 같은 id 를 쓴다`)
      for (const [k, level] of Object.entries(CANON_KEYS)) {
        const a = prev.props?.[k]
        const b = n.props?.[k]
        if (a !== undefined && b !== undefined && String(a) !== String(b)) {
          put(level, `node_${k}`, `${n.name}: ${k} 가 기존 ${a} 인데 새로 ${b} 다`)
        }
      }
      continue
    }
    const same = oldByName.get(n.name)
    if (same) put('warn', 'alias_split', `"${n.name}" 이 기존 id "${same.id}" 와 새 id "${n.id}" 로 갈라진다`)
  }

  const oldEdges = new Map(oe.map((e) => [edgeKey(e), e]))
  const oldPairs = new Map()
  for (const e of oe) oldPairs.set(`${e.s}|${e.o}`, [...(oldPairs.get(`${e.s}|${e.o}`) || []), e])

  for (const e of ne) {
    const prev = oldEdges.get(edgeKey(e))
    if (prev) {
      const a = prev.props?.type
      const b = e.props?.type
      if (a !== undefined && b !== undefined && a !== b) {
        put('error', 'edge_type', `${e.s} ${e.p} ${e.o}: 기존 type "${a}" 인데 새로 "${b}" 다`)
      }
      if (prev.asserted === true && e.asserted === false) {
        put('warn', 'edge_downgrade', `${e.s} ${e.p} ${e.o}: 기존은 명시인데 새로 추론으로 왔다`)
      }
      continue
    }
    // 같은 두 노드 사이에 서로 못 서는 관계가 붙는 경우
    for (const old of oldPairs.get(`${e.s}|${e.o}`) || []) {
      if ((old.p === 'targets' && e.p === 'protects') || (old.p === 'protects' && e.p === 'targets')) {
        put('warn', 'rel_mutex', `${e.s}→${e.o}: 기존 ${old.p} 와 새 ${e.p} 가 함께 선다`)
      }
    }
    // 비밀: 아는 사람과 모르는 사람이 같을 수는 없다
    if (e.p === 'knows' && oldEdges.has(edgeKey({ s: e.o, p: 'hidden_from', o: e.s }))) {
      put('error', 'secret_contradiction', `${e.s} 는 ${e.o} 를 모르는 쪽으로 기록돼 있다 (hidden_from)`)
    }
    if (e.p === 'hidden_from' && oldEdges.has(edgeKey({ s: e.o, p: 'knows', o: e.s }))) {
      put('error', 'secret_contradiction', `${e.o} 는 ${e.s} 를 아는 쪽으로 기록돼 있다 (knows)`)
    }
  }

  return { conflicts, compatible: !conflicts.some((c) => c.level === 'error') }
}

/**
 * 그래프 여러 조각을 하나로 합친다. 긴 대본을 나눠 추출할 때 쓴다.
 * 노드는 id 기준으로 처음 것을 남기고 props 를 합치고, 엣지는 s·p·o 로 중복을 뺀다.
 *
 * @param {...Object} parts - {nodes, edges} 조각들
 * @returns {{nodes: Array, edges: Array}}
 */
export function mergeGraphs(...parts) {
  const byId = new Map()
  const byKey = new Map()
  for (const g of parts) {
    for (const n of asList(g?.nodes)) {
      const prev = byId.get(n.id)
      if (prev) prev.props = { ...asProps(n.props), ...asProps(prev.props) }
      else byId.set(n.id, { ...n, props: asProps(n.props) })
    }
    for (const e of asList(g?.edges)) {
      const key = edgeKey(e)
      const prev = byKey.get(key)
      if (!prev) byKey.set(key, e)
      else if (!prev.asserted && e.asserted) byKey.set(key, e) // 명시가 추론을 이긴다
    }
  }
  const nodes = [...byId.values()]
  const ids = new Set(byId.keys())
  return { nodes, edges: [...byKey.values()].filter((e) => ids.has(e.s) && ids.has(e.o)) }
}

const BRANCH_IDS = ['A', 'B', 'C', 'D']

/** 역기입 엣지 목록을 정리한다. s·o 는 id 든 이름이든 그대로 둔다 — 얹을 때 store 가 옮긴다 */
const wbEdges = (list, warnings, label) => {
  const out = []
  for (const e of asList(list)) {
    if (!e || typeof e !== 'object') { warnings.push(`${label}: 엣지가 객체가 아니다 — 버린다`); continue }
    const s = clip(e.s ?? e.from ?? e.subject, 60)
    const o = clip(e.o ?? e.to ?? e.object, 60)
    const p = clip(e.p ?? e.rel ?? e.pred, 40).toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    if (!REL_OK.has(p)) { warnings.push(`${label}: 어휘에 없는 술어 "${p || '없음'}" — 엣지를 버린다`); continue }
    if (!s || !o) { warnings.push(`${label}: ${p} 엣지의 s/o 가 비었다 — 버린다`); continue }
    const edge = { s, p, o }
    const note = clip(e.note ?? e.cause, 120)
    if (note) edge.note = note
    const props = asProps(e.props)
    const t = tensionOf(props.tension ?? e.tension)
    if (t === null) delete props.tension
    else props.tension = t
    if (Object.keys(props).length) edge.props = props
    out.push(edge)
  }
  return out
}

/**
 * 모델이 만든 분기 스토리를 검사하고 mock/stories.json 모양으로 맞춘다.
 * normalizeGraph 와 같은 자리에서 같은 일을 한다: 뷰어에 올릴 수 있는 것만 통과시키고,
 * 버린 것은 warnings 로 남겨 화면에 띄운다.
 *
 * 받아 주는 별칭 (지시서 스키마 ↔ mock/stories.json 스키마)
 *   label ← title / tone ← subtitle / premise ← summary / outcome ← consequence
 *   writeback.nodes ← add_nodes / writeback.edges ← add_edges / writeback.remove_edges ← remove
 *
 * beats 는 문자열(mock/stories.json)과 {scene, action, secs, cast} 객체를 모두 받는다.
 * 객체로 온 것은 구조를 지켜 준다 — 다음 단계에서 컷으로 펼칠 때 쓴다.
 *
 * @param {Object} raw - 모델이 준 {title, logline, pivot, branches}
 * @param {Object} [opts]
 * @param {number} [opts.maxBranches=4] 분기 상한
 * @param {number} [opts.maxBeats=8] 분기 하나의 비트 상한
 * @returns {{title: string, logline: string, pivot: {title: string, body: string},
 *            branches: Array, warnings: Array<string>}}
 */
export function normalizeStory(raw, { maxBranches = 4, maxBeats = 8 } = {}) {
  const warnings = []
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (src !== raw) warnings.push('스토리가 객체가 아니다 — 빈 스토리로 둔다')
  const rawBranches = src.branches ?? src.options ?? src.paths
  if (!Array.isArray(rawBranches)) warnings.push('branches 배열이 없다')

  const branches = []
  for (const b of asList(rawBranches)) {
    if (!b || typeof b !== 'object') { warnings.push('분기가 객체가 아니다 — 버린다'); continue }
    if (branches.length >= maxBranches) { warnings.push(`분기가 ${maxBranches}개를 넘어 나머지를 잘랐다`); break }
    const id = clip(b.id, 2).toUpperCase() || BRANCH_IDS[branches.length] || String(branches.length + 1)
    const label = clip(b.label ?? b.title, 40)
    const premise = clip(b.premise ?? b.summary ?? b.desc, 800)

    const beats = []
    for (const t of asList(b.beats ?? b.cuts)) {
      if (beats.length >= maxBeats) { warnings.push(`${id}: 비트가 ${maxBeats}개를 넘어 나머지를 잘랐다`); break }
      if (typeof t === 'string' || typeof t === 'number') {
        const line = clip(t, 400)
        if (line) beats.push(line)
        continue
      }
      if (!t || typeof t !== 'object') { warnings.push(`${id}: 비트가 문자열도 객체도 아니다 — 버린다`); continue }
      const action = clip(t.action ?? t.summary ?? t.text, 400)
      if (!action) { warnings.push(`${id}: action 없는 비트를 버린다`); continue }
      const beat = { action }
      const scene = clip(t.scene, 24)
      if (scene) beat.scene = scene
      const secs = Number(t.secs ?? t.duration)
      if (Number.isFinite(secs) && secs > 0) beat.secs = secsOf(secs)
      const cast = [...new Set(asList(t.cast).map((n) => clip(n, 20)).filter(Boolean))].slice(0, 6)
      if (cast.length) beat.cast = cast
      beats.push(beat)
    }

    const outcome = {}
    for (const [k, v] of Object.entries(asProps(b.outcome ?? b.consequence))) {
      const key = clip(k, 24)
      const val = clip(v && typeof v === 'object' ? Object.values(v).join(' ') : v, 160)
      if (!key || !val) { warnings.push(`${id}: 결과 "${key || k}" 를 읽지 못해 버린다`); continue }
      outcome[key] = val
    }

    const wb = asProps(b.writeback)
    const nodes = []
    for (const n of asList(wb.nodes ?? wb.add_nodes)) {
      const name = clip(n?.name ?? n?.label, 60)
      const kind = clip(n?.kind ?? n?.type, 20)
      if (!name) { warnings.push(`${id} 역기입: 이름 없는 노드를 버린다`); continue }
      if (!KIND_OK.has(kind)) {
        warnings.push(`${id} 역기입: 모르는 kind "${kind || '없음'}" (${name}) — 노드를 버린다`)
        continue
      }
      const node = { name, kind }
      const nid = clip(n.id, 48)
      if (nid) node.id = nid
      const t = Number(n.t ?? n.props?.t)
      if (Number.isFinite(t)) node.t = t
      const desc = clip(n.desc ?? n.brief ?? n.props?.desc, 300)
      if (desc) node.desc = desc
      const claim = clip(n.claim ?? n.props?.claim, 300)
      if (claim) node.claim = claim
      nodes.push(node)
    }

    const writeback = {
      nodes,
      edges: wbEdges(wb.edges ?? wb.add_edges, warnings, `${id} 역기입`),
      remove_edges: wbEdges(wb.remove_edges ?? wb.remove ?? wb.removeEdges, warnings, `${id} 역기입 삭제`),
    }

    if (!label && !premise && !beats.length) { warnings.push(`${id}: 빈 분기를 버린다`); continue }
    if (!label) warnings.push(`${id}: label 이 없어 "분기 ${id}" 로 둔다`)
    if (!premise) warnings.push(`${id}: 전개 요약(premise)이 없다`)
    if (!beats.length) warnings.push(`${id}: 비트가 없다`)

    branches.push({
      id,
      label: label || `분기 ${id}`,
      tone: clip(b.tone ?? b.subtitle, 60),
      premise,
      beats,
      outcome,
      writeback,
    })
  }

  if (!branches.length) warnings.push('쓸 수 있는 분기가 하나도 없다')

  const pivot = asProps(src.pivot)
  const out = {
    title: clip(src.title, 80),
    logline: clip(src.logline, 400),
    pivot: {
      title: clip(pivot.title ?? src.pivotTitle, 120),
      body: clip(pivot.body ?? pivot.desc ?? src.pivotBody, 800),
    },
    branches,
    warnings,
  }
  const probe = clip(src.probe, 40)
  if (probe) out.probe = probe
  return out
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
