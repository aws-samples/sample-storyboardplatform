
import {
  orderKeyBetween, orderKeyForIndex, byOrderKey,
  STATUS, ACTIONS, ROLES, POSES, FEEDBACK_TAGS, NEEDS,
  canTransition, canEditContent, canMakeArt, canGrantRole, canSeeAdmin, canPlan, splitScenario, mergeField, handBackTo, notifFor,
  sceneGroups, clock, startTimes, scrub, debounceBy, epLabel,
  lostEdit, isActionable, changedSince, touchedAt, workload, liveVer, deadVer,
  tally, stalls, retakes, flow, pace, actorPace, firstPass, reviewLag, fmtDur,
} from './core.js'
import { MODES, GENRES, TONES, LENGTHS, CUTCOUNTS, planOutline, planCuts } from './story.js'
import { esc, setHtml } from './dom.js'
import { srcOf, downscale } from './art.js'
import { SEED_ART } from './seed-art.js'
import { connect } from './net.js'
import { configured, idToken, session, logout } from './auth.js'
import { showLogin } from './login.js'

const ROSTER = [
  { id: 'u1', name: '김하나', role: 'planner', color: '#E3A93C', job: '시나리오를 컷으로 쪼갠다' },
  { id: 'u2', name: '이도현', role: 'artist', color: '#4FA97A', job: '구도를 그리고 올린다' },
  { id: 'u3', name: '박서준', role: 'director', color: '#7FB3E8', job: '피드백하고 승인한다' },
  { id: 'u4', name: '최유진', role: 'reviewer', color: '#D69AC9', job: '메모로 의견을 남긴다' },
  { id: 'u5', name: '정민아', role: 'admin', color: '#C77B62', job: '팀원을 등록하고 역할을 정한다' },
]

const PALETTE = ['#E3A93C', '#4FA97A', '#7FB3E8', '#D69AC9', '#C77B62', '#8FA65B']
const tint = (id) => PALETTE[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length]

const look = (s) => ({ color: tint(s.id), job: '', ...ROSTER.find((u) => u.id === s.id), ...s })

let claimed = false

function resolveMe() {
  const asked = new URL(location.href).searchParams.get('as')
  const fromUrl = ROSTER.find((u) => u.role === asked || u.id === asked)
  if (fromUrl) { claimed = true; return fromUrl }
  const saved = sessionStorage.getItem('sb.me')
  if (saved && ROSTER.some((u) => u.id === saved)) { claimed = true; return ROSTER.find((u) => u.id === saved) }
  const n = Number(localStorage.getItem('sb.seat') || 0)
  localStorage.setItem('sb.seat', String(n + 1))
  return ROSTER[n % ROSTER.length]
}

let me = configured ? look(session() || { id: '…', name: '…', role: 'reviewer' }) : resolveMe()
if (!configured) sessionStorage.setItem('sb.me', me.id)

const emptyState = () => ({
  board: { title: '스토리보드', scenario: '', _ts: {} },
  eps: {},
  chars: {},
  panels: {},
  members: {},
  comments: [],
  events: [],
  notifs: [],
})

let state = emptyState()
let selectedId = null
let viewChar = null
let viewEp = null
let viewing = null
let tool = 'pin'
let cmpVer = null
let pending = { pin: null, mark: [] }
let focusCmt = null
let replyTo = null
let latency = 0
const seenOps = new Set()
const peers = new Map()

const now = () => Date.now()
const uid = () => now().toString(36) + Math.random().toString(36).slice(2, 8)
const pad = (n) => String(n).padStart(2, '0')
function person(id) {
  if (!id) return null
  const seat = ROSTER.find((u) => u.id === id) || (id === me.id ? me : peers.get(id)) || null
  const m = state.members?.[id] || null
  if (!seat && !m) return { id, name: id, role: 'reviewer', color: tint(id) }
  return { color: tint(id), role: 'reviewer', name: id, ...seat, ...m, id }
}

const roleOf = (id) => person(id)?.role || 'reviewer'

const people = () => {
  const m = new Map()
  const all = [...ROSTER, ...Object.values(state.members || {}), ...peers.values(), me]
  for (const u of all) if (u?.id && u.name) m.set(u.id, { id: u.id, name: u.name })
  return [...m.values()]
}

function roster() {
  const ids = new Set([
    ...(configured ? [] : ROSTER.map((u) => u.id)),
    ...Object.keys(state.members || {}),
    ...peers.keys(),
    me.id,
    ...Object.values(state.panels).map((p) => p.assignee).filter(Boolean),
  ])
  return [...ids].map(person).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
}

function assignOpts(sel) {
  const list = roster().filter((u) => u.role !== 'reviewer' || u.id === sel)
  return `<option value="">담당 없음</option>${list.map((u) =>
    `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name)} · ${ROLES[u.role] || u.role}</option>`).join('')}`
}

const cutsOf = (epId) =>
  Object.values(state.panels).filter((p) => !p.charId && (p.epId ?? null) === epId).sort(byOrderKey)
const epList = () => Object.values(state.eps || {})
  .sort((a, b) => (a.epNo || 0) - (b.epNo || 0) || (a.id < b.id ? -1 : 1))

const panelsIn = (charId) =>
  charId === null ? cutsOf(viewEp) : Object.values(state.panels).filter((p) => p.charId === charId).sort(byOrderKey)
const viewPanels = () => panelsIn(viewChar)
const charList = () => Object.values(state.chars).sort(byOrderKey)
const cutNo = (p) => cutsOf(p.epId ?? null).findIndex((x) => x.id === p.id) + 1
const labelOf = (p) => (p ? (p.charId ? (p.pose || '구도') : `CUT ${pad(cutNo(p))}`) : '')
const whereOf = (p) => {
  if (!p) return ''
  if (p.charId) return state.chars[p.charId]?.name || '인물'
  return epList().length ? epLabel(state.eps[p.epId]) : '스토리보드'
}

function ro(word) {
  const s = String(word).trim()
  const c = s.charCodeAt(s.length - 1) - 0xac00
  return `${s}${c >= 0 && c < 11172 && c % 28 ? '으로' : '로'}`
}

const genBy = (p) =>
  (typeof p?.generating === 'string' && Math.abs(now() - (p.genAt || 0)) < 180_000
    ? person(p.generating) : null)

function refOf(ch) {
  if (!ch?.refPanelId) return null
  const p = state.panels[ch.refPanelId]
  const v = p?.versions?.[(ch.refN ?? 1) - 1]
  return v && !deadVer(p, v) ? { src: srcOf(v), panelId: p.id, pose: p.pose, n: ch.refN ?? 1 } : null
}

let net = null
let link = 'open'
let unsent = 0
let linkTimer = 0
let replaying = false
let lastTs = 0

function emit(op) {
  op.id = uid()
  op.ts = now()
  op.actor = me.id
  seenOps.add(op.id)
  applyOp(op)
  net?.sendOp(op)
  save()
  render()
}

function emitMany(ops) {
  for (const op of ops) {
    op.id = uid()
    op.ts = now()
    op.actor = me.id
    seenOps.add(op.id)
    applyOp(op)
    net?.sendOp(op)
  }
  save()
  render()
}

function recvOp(raw) {
  const op = scrub(raw)
  if (!op?.id || seenOps.has(op.id)) return
  seenOps.add(op.id)
  if (op.ts > lastTs) lastTs = op.ts
  if (paused && !replaying) { held.push(op); renderHold(); return }
  applyOp(op)
  if (!replaying) { save(); render() }
}

let paused = false
const held = []

function resume() {
  paused = false
  const n = held.length
  for (const op of held.splice(0)) applyOp(op)
  save()
  render()
  announce(n ? `멈춰둔 변경 ${n}건을 적용했습니다.` : '실시간 갱신을 다시 받습니다.')
}

function push(op) {
  if (seenOps.has(op.id)) return
  seenOps.add(op.id)
  applyOp(op)
  net?.sendOp(op)
}

function recvPresence(raw) {
  const p = scrub(raw)
  if (!p?.id || p.id === me.id) return
  if (p.left) peers.delete(p.id)
  else peers.set(p.id, {
    id: p.id,
    name: String(p.name ?? '').slice(0, 40) || p.id,
    role: ROLES[p.role] ? p.role : 'reviewer',
    color: p.color || tint(p.id),
    cursor: p.cursor ? { x: p.cursor.x, y: p.cursor.y } : null,
    editing: p.editing?.panelId ? { panelId: p.editing.panelId, field: String(p.editing.field ?? '') } : null,
    at: p.at || null,
    view: p.view || null,
    lastSeen: now(),
  })
  renderPeers()
  renderCursors()
  const sig = peerSig()
  if (sig !== lastPeerSig) { lastPeerSig = sig; renderBoard(); renderDetail() }
}

let lastPeerSig = ''
const peerSig = () =>
  [...peers.values()].map((p) => `${p.id}@${p.view ?? ''}/${p.at ?? ''}:${p.editing?.field ?? ''}`).sort().join('|')

async function resync() {
  const ops = await net.fetchOps(lastTs)
  if (!ops?.length) return
  for (const op of ops) recvOp(op)
  render()
}

function applyOp(op) {
  const p = op.panelId ? state.panels[op.panelId] : null
  let landed = true

  switch (op.kind) {
    case 'char.add':
      if (state.chars[op.char.id]) { landed = false; break }
      state.chars[op.char.id] = { ...op.char, _ts: {} }
      break

    case 'char.patch': {
      const ch = state.chars[op.charId]
      if (!ch) { landed = false; break }
      for (const [k, v] of Object.entries(op.fields)) mergeField(ch, k, v, op.ts)
      break
    }

    case 'panel.add':
      if (state.panels[op.panel.id]) { landed = false; break }
      state.panels[op.panel.id] = { ...op.panel, _ts: {} }
      break

    case 'panel.patch':
      if (!p) { landed = false; break }
      for (const [k, v] of Object.entries(op.fields)) {
        const lost = lostEdit(p, k, v, op.actor, me.id)
        if (mergeField(p, k, v, op.ts)) {
          p._by = { ...(p._by || {}), [k]: op.actor }
          if (lost && !replaying) keepLost(op.panelId, k, lost, op.actor)
        }
      }
      break

    case 'panel.remove':
      delete state.panels[op.panelId]
      state.comments = state.comments.filter((c) => c.panelId !== op.panelId)
      if (selectedId === op.panelId) selectedId = null
      break

    case 'panel.version':
      if (!p) { landed = false; break }
      p.versions = [...(p.versions || []), { ...op.version, vid: op.id }]
      if (!deadVer(p, { vid: op.id })) mergeField(p, 'current', p.versions.length - 1, op.ts)
      mergeField(p, 'generating', false, op.ts)
      break

    case 'panel.version.remove':
      if (!p || !op.verId) { landed = false; break }
      p.dead = { ...(p.dead || {}), [op.verId]: op.ts }
      p._ts = { ...(p._ts || {}), dead: op.ts }
      break

    case 'panel.status': {
      if (!p) { landed = false; break }
      const to = STATUS[op.to] ? op.to : 'draft'
      if (!mergeField(p, 'status', to, op.ts)) { landed = false; break }
      mergeField(p, 'assignee', op.assignee ?? p.assignee ?? null, op.ts)
      state.events.push({ id: op.id, panelId: op.panelId, from: op.from, to, actor: op.actor, ts: op.ts })
      break
    }

    case 'comment.add':
      if (state.comments.some((c) => c.id === op.comment.id)) { landed = false; break }
      state.comments.push(op.comment)
      break

    case 'comment.resolve': {
      const c = state.comments.find((x) => x.id === op.commentId)
      if (c) mergeField(c, 'resolved', op.resolved, op.ts)
      break
    }

    case 'board.patch':
      for (const [k, v] of Object.entries(op.fields)) mergeField(state.board, k, v, op.ts)
      break

    case 'ep.add':
      if (!op.ep?.id || state.eps[op.ep.id]) { landed = false; break }
      state.eps[op.ep.id] = { ...op.ep, _ts: {} }
      break

    case 'ep.patch': {
      const ep = state.eps[op.epId]
      if (!ep) { landed = false; break }
      for (const [k, v] of Object.entries(op.fields)) mergeField(ep, k, v, op.ts)
      break
    }

    case 'member.set': {
      const m = op.member
      if (!m?.id) { landed = false; break }
      const self = op.actor === m.id
      if (!self && !canGrantRole(roleOf(op.actor))) { landed = false; break }
      const cur = (state.members[m.id] ??= { id: m.id, _ts: {} })
      for (const k of ['name', 'color', 'job']) if (k in m) mergeField(cur, k, m[k], op.ts)
      if (m.role && (!cur.role || !self)) mergeField(cur, 'role', m.role, op.ts)
      break
    }

    case 'member.role': {
      if (!op.userId || !canGrantRole(roleOf(op.actor))) { landed = false; break }
      const cur = (state.members[op.userId] ??= { id: op.userId, _ts: {} })
      mergeField(cur, 'role', ROLES[op.role] ? op.role : 'reviewer', op.ts)
      break
    }

    case 'board.reset': {
      const keep = state.members
      state = emptyState()
      state.members = keep
      break
    }
  }

  if (landed) deriveNotif(op)
}

function deriveNotif(op) {
  const panelId = op.panelId ?? op.comment?.panelId
  const parentAuthor = op.comment?.parentId
    ? state.comments.find((c) => c.id === op.comment.parentId)?.author
    : null
  const verAuthor = op.kind === 'panel.version.remove'
    ? state.panels[panelId]?.versions?.find((v) => v.vid === op.verId)?.author
    : null
  for (const t of notifFor(op, state.panels[panelId], { people: people(), parentAuthor, verAuthor })) {
    const id = `${op.id}#${t.to}`
    if (state.notifs.some((n) => n.id === id)) continue

    const n = {
      id, to: t.to, kind: t.kind, actor: op.actor, panelId,
      ts: op.ts, body: op.comment?.body, status: op.to,
      read: readIds.has(id) || (op.seed && !op.alert),
    }
    state.notifs.push(n)
    if (state.notifs.length > 80) state.notifs.splice(0, state.notifs.length - 80)
    if (n.to === me.id && !replaying) toast(n)
  }
}

const readKey = () => `sb.read.${me.id}`
let readIds = new Set()
function loadRead() {
  try { readIds = new Set(JSON.parse(localStorage.getItem(readKey()) || '[]')) } catch { readIds = new Set() }
}
function saveRead() {
  localStorage.setItem(readKey(), JSON.stringify([...readIds].slice(-300)))
}

let saveTimer = null
function save() {
  if (net?.mode === 'aws') return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('sb.state', JSON.stringify(state)) } catch {  }
  }, 220)
}

function load() {
  try {
    const raw = localStorage.getItem('sb.state')
    if (raw) {
      const s = scrub(JSON.parse(raw))
      if (!s.chars || !s.notifs) return false
      s.members ||= {}
      s.eps ||= {}
      state = s
      return true
    }
  } catch {  }
  return false
}

const SEED_SCENARIO = `새벽 5시, 텅 빈 도시. 가로등이 하나씩 꺼진다.

제빵사가 반죽을 치는 손. 밀가루가 공기 중에 흩날린다.

"누군가의 아침은 밤에 시작된다."

첫 손님이 문을 밀고 들어온다. 종이 울린다.

컵에서 올라오는 김. 그의 얼굴 클로즈업.`

const SEED_CHARS = [
  {
    id: 'char-1', name: '제빵사 민우', seedNo: 17, refPose: 0,
    brief: '40대 초반, 마른 체형. 밀가루 묻은 남색 앞치마, 걷어올린 소매. 말이 없고 손이 빠르다.',
    poses: [
      ['정면', 'approved', 'u2', 'ai'],
      ['3/4', 'in_review', 'u2', 'ai'],
      ['측면', 'changes_requested', 'u2', 'ai'],
      ['후면', 'in_progress', 'u2', null],
      ['전신', 'draft', null, null],
      ['표정', 'draft', null, null],
    ],
  },
  {
    id: 'char-2', name: '첫 손님 지연', seedNo: 44, refPose: 0,
    brief: '20대 후반. 출근 전 베이지 코트 차림. 매일 같은 창가 자리에 앉는다.',
    poses: [
      ['정면', 'in_review', 'u2', 'ai'],
      ['3/4', 'draft', null, null],
    ],
  },
]

const S1 = '씬 1 · 새벽 거리'
const S2 = '씬 2 · 빵집 안'
const S3 = '씬 3 · 첫 손님'
const S4 = '씬 4 · 창가 자리'
const CUT_PLAN = [
  { scene: S1, secs: 2.5, status: 'approved', assignee: 'u2', art: 'sketch' },
  { scene: S1, secs: 1.5, status: 'in_review', assignee: 'u2', art: 'sketch' },
  { scene: S2, secs: 2, status: 'changes_requested', assignee: 'u2', art: 'ai' },
  { scene: S2, secs: 1.5, status: 'in_progress', assignee: 'u2', art: null },
  { scene: S2, secs: 1, status: 'draft', assignee: null, art: null },
  { scene: S3, secs: 2, status: 'in_review', assignee: 'u2', art: 'ai' },
  { scene: S3, secs: 1.5, status: 'draft', assignee: null, art: null },
  { scene: S4, secs: 1, status: 'draft', assignee: null, art: null },
  { scene: S4, secs: 2, status: 'in_progress', assignee: 'u2', art: 'ai' },
]
const CUT_CAST = { 3: ['char-1'], 4: ['char-1'], 6: ['char-2'], 9: ['char-2'] }

const ring = (cx, cy, rx, ry) =>
  Array.from({ length: 15 }, (_, i) => {
    const t = (i / 14) * Math.PI * 2
    const w = 1 + Math.sin(t * 3) * 0.06
    return [+(cx + Math.cos(t) * rx * w).toFixed(3), +(cy + Math.sin(t) * ry * w).toFixed(3)]
  }).flat()

const seedArt = (id, fallback, ai = true) =>
  SEED_ART[id]
    ? { src: SEED_ART[id].src, ...(ai ? { gen: SEED_ART[id].gen } : {}) }
    : { art: fallback }

function seedOps(opAt = null, tag = 'sd') {
  const T = Math.floor(now() / 864e5) * 864e5
  const base = opAt ?? T
  const ops = []
  let n = 0
  let min = 0
  const add = (actor, o, gap = 3) => {
    min += gap
    ops.push({ ...o, id: `${tag}-${++n}`, ts: opAt ? base + n : T + min * 6e4, actor, seed: true })
    return ops.at(-1)
  }

  add('u1', { kind: 'board.patch', fields: { title: '아침빵집 — 15초 브랜드 필름', scenario: SEED_SCENARIO } })

  let ck = null
  for (const c of SEED_CHARS) {
    ck = orderKeyBetween(ck, null)
    add('u1', {
      kind: 'char.add',
      char: { id: c.id, name: c.name, brief: c.brief, seedNo: c.seedNo, orderKey: ck, refPanelId: null, refN: null },
    })

    let pk = null
    c.poses.forEach(([pose, status, assignee, art], i) => {
      pk = orderKeyBetween(pk, null)
      const id = `${c.id}-p${i + 1}`
      add('u1', {
        kind: 'panel.add',
        panel: {
          id, charId: c.id, pose, orderKey: pk, action: '',
          status: 'draft', assignee: null, versions: [], current: -1, generating: false,
        },
      })
      if (art) {
        add('u2', {
          kind: 'panel.version', panelId: id,
          version: {
            n: 1, source: art === 'ai' ? 'ai' : 'upload', author: 'u2', ts: T + min * 6e4,
            prompt: `${c.name} · ${pose}`,
            ...seedArt(id, { seed: c.seedNo, mode: art, figure: true, pose }, art === 'ai'),
          },
        })
      }
      for (const [actor, from, to, asg, alert] of statusPath(status, assignee)) {
        const op = add(actor, { kind: 'panel.status', panelId: id, from, to, assignee: asg })
        if (alert) op.alert = true
      }
      if (c.refPose === i && art) add('u3', { kind: 'char.patch', charId: c.id, fields: { refPanelId: id, refN: 1 } })
    })
  }

  const cuts = splitScenario(SEED_SCENARIO)
  let key = null
  cuts.forEach((cut, i) => {
    key = orderKeyBetween(key, null)
    const spec = CUT_PLAN[i] || { status: 'draft', assignee: null, art: null }
    const id = `seed-cut-${i + 1}`
    add('u1', {
      kind: 'panel.add',
      panel: {
        id, charId: null, orderKey: key,
        action: cut.action, dialogue: cut.dialogue, camera: cut.camera, cast: CUT_CAST[i + 1] || [],
        scene: spec.scene || '', secs: spec.secs || 0,
        status: 'draft', assignee: null, versions: [], current: -1, generating: false,
      },
    }, 1)
    if (spec.art) {
      add('u2', {
        kind: 'panel.version', panelId: id,
        version: {
          n: 1, source: spec.art === 'ai' ? 'ai' : 'upload', author: 'u2', ts: T + min * 6e4,
          prompt: spec.art === 'ai' ? cut.action : undefined,
          ...seedArt(id, { seed: i + 3, mode: spec.art }, spec.art === 'ai'),
        },
      }, 1)
    }
    for (const [actor, from, to, asg] of statusPath(spec.status, spec.assignee)) {
      add(actor, { kind: 'panel.status', panelId: id, from, to, assignee: asg }, 1)
    }
  })

  const feedback = [
    ['char-1-p3', 'u3', '[구도] 구도가 안 맞습니다. 어깨선이 너무 올라가 보여요.',
      { pin: { x: 0.44, y: 0.36 }, mark: [ring(0.44, 0.36, 0.13, 0.09)] }],
    ['char-1-p2', 'u4', '[배경] 배경이 조금 더 밝았으면 좋겠습니다.', {}],
    ['seed-cut-2', 'u4', '밀가루 날리는 느낌 좋습니다. 이 톤으로 가면 좋겠어요.', {}],
  ]
  feedback.forEach(([panelId, author, body, extra], i) => {
    const op = add(author, {
      kind: 'comment.add',
      comment: {
        id: `${tag}-cmt-${i + 1}`, panelId, author, body,
        ts: T + (min + 3) * 6e4, resolved: false, onVersion: 1, ...extra,
      },
    })
    op.alert = true
  })

  add('u2', {
    kind: 'comment.add',
    comment: {
      id: `${tag}-cmt-r1`, panelId: 'char-1-p3', author: 'u2',
      body: '@박서준 확인했습니다. 어깨선 내려서 다시 올리겠습니다.',
      ts: T + (min + 5) * 6e4, resolved: false, onVersion: 1, parentId: `${tag}-cmt-1`,
    },
  })

  return ops
}

function statusPath(status, assignee) {
  const a = assignee || 'u2'
  switch (status) {
    case 'in_progress': return [['u2', 'draft', 'in_progress', a]]
    case 'in_review': return [['u2', 'draft', 'in_progress', a], ['u2', 'in_progress', 'in_review', a]]
    case 'approved': return [['u2', 'draft', 'in_progress', a], ['u2', 'in_progress', 'in_review', a],
      ['u3', 'in_review', 'approved', a]]
    case 'changes_requested': return [['u2', 'draft', 'in_progress', a], ['u2', 'in_progress', 'in_review', a],
      ['u3', 'in_review', 'changes_requested', a, true]]
    default: return []
  }
}

let cursor = null
let editing = null

function beat() {
  if (picking) return
  net?.sendPresence({ ...me, cursor, editing, at: selectedId, view: viewChar })
}
setInterval(beat, 2000)
const genGone = new Set()
setInterval(() => {
  let changed = false
  for (const [id, p] of peers) if (now() - p.lastSeen > 6000) { peers.delete(id); changed = true }
  for (const p of Object.values(state.panels)) {
    if (typeof p.generating !== 'string' || genBy(p)) genGone.delete(p.id)
    else if (!genGone.has(p.id)) { genGone.add(p.id); changed = true }
  }
  if (changed) { lastPeerSig = peerSig(); renderPeers(); renderCursors(); renderBoard(); renderDetail() }
}, 1500)

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { editing = null; cursor = null }
  else {
    const f = document.activeElement
    if (f?.dataset?.field && selectedId) editing = { panelId: selectedId, field: f.dataset.field }
  }
  beat()
})

function lockedBy(panelId, field) {
  for (const p of peers.values()) {
    if (p.editing && p.editing.panelId === panelId && p.editing.field === field) return p
  }
  return null
}

let booted = false

function registerMe() {
  const m = state.members?.[me.id]
  if (m?.role && m.name === me.name) return
  emit({
    kind: 'member.set',
    member: {
      id: me.id, name: me.name, color: me.color,
      ...(m?.role ? {} : { role: me.role }),
      ...(me.job ? { job: me.job } : {}),
    },
  })
}

function syncMe() {
  const r = state.members?.[me.id]?.role
  if (!r || r === me.role) return
  me = { ...me, role: r }
  if (!booted) return
  announce(`역할이 ${ro(ROLES[r])} 바뀌었습니다. 할 수 있는 일이 달라집니다.`)
  beat()
}

function setView(charId) {
  viewChar = charId
  sessionStorage.setItem('sb.view', charId ?? '')
  selectedId = viewPanels()[0]?.id ?? null
}

function setEp(epId) {
  viewEp = epId
  sessionStorage.setItem('sb.ep', epId ?? '')
  setView(null)
}

function goTo(panelId) {
  const p = state.panels[panelId]
  if (!p) return
  if (!p.charId && (p.epId ?? null) !== viewEp) setEp(p.epId ?? null)
  setView(p.charId ?? null)
  selectedId = panelId
  freshIds.delete(panelId)
  render()
  beat()
  byId('board').querySelector(`[data-id="${panelId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function addChar() {
  const id = uid()
  const keys = charList().map((c) => c.orderKey)
  emit({
    kind: 'char.add',
    char: {
      id, name: `인물 ${charList().length + 1}`, brief: '', seedNo: Math.floor(Math.random() * 900) + 20,
      orderKey: orderKeyForIndex(keys, keys.length), refPanelId: null, refN: null,
    },
  })
  let pk = null
  for (const pose of POSES) {
    pk = orderKeyBetween(pk, null)
    emit({
      kind: 'panel.add',
      panel: {
        id: uid(), charId: id, pose, orderKey: pk,
        action: '', status: 'draft', assignee: null, versions: [], current: -1, generating: false,
      },
    })
  }
  setView(id)
  render()
  byId('nameIn').focus()
  byId('nameIn').select()
}

function addPanel(atIndex) {
  const list = viewPanels()
  const keys = list.map((p) => p.orderKey)
  const id = uid()
  const base = {
    id, charId: viewChar, orderKey: orderKeyForIndex(keys, atIndex ?? keys.length),
    action: '', status: 'draft', assignee: null, versions: [], current: -1, generating: false,
  }
  const used = new Set(list.map((p) => p.pose))
  emit({
    kind: 'panel.add',
    panel: viewChar
      ? { ...base, pose: POSES.find((x) => !used.has(x)) || `구도 ${list.length + 1}` }
      : { ...base, dialogue: '', camera: 'MS', cast: [], ...(viewEp ? { epId: viewEp } : {}) },
  })
  selectedId = id
}

function movePanel(panelId, toIndex) {
  const list = viewPanels().filter((p) => p.id !== panelId)
  const keys = list.map((p) => p.orderKey)
  const clamped = Math.max(0, Math.min(toIndex, keys.length))
  emit({ kind: 'panel.patch', panelId, fields: { orderKey: orderKeyForIndex(keys, clamped) } })
}

function transition(panel, action, note) {
  const check = canTransition(me.role, panel.status, action)
  if (!check.ok) return check
  let assignee = panel.assignee
  if (action === 'request_changes' || action === 'reopen') {
    assignee = handBackTo(state.events, panel.id, panel.assignee)
  }
  if (action === 'submit') assignee = roster().find((u) => u.role === 'director')?.id ?? assignee
  if (action === 'resume') assignee = me.id

  if (note) {
    const extra = { ...pending, parentId: replyTo }
    pending = { pin: null, mark: [] }
    replyTo = null
    addComment(panel, note, extra)
  }
  emit({ kind: 'panel.status', panelId: panel.id, from: panel.status, to: check.to, assignee })
  return check
}

function addComment(panel, body, extra = {}) {
  emit({
    kind: 'comment.add',
    comment: {
      id: uid(), panelId: panel.id, author: me.id, body, ts: now(),
      resolved: false, onVersion: (liveVer(panel)?.i ?? -1) + 1,
      ...(extra.pin ? { pin: extra.pin } : {}),
      ...(extra.mark?.length ? { mark: extra.mark } : {}),
      ...(extra.parentId ? { parentId: extra.parentId } : {}),
    },
  })
}

const cfg = window.SB_CONFIG || {}
const canGen = !!cfg.genUrl

let gpu = { state: 'unknown', text: '생성 서버 확인 중' }
let gpuModels = []
let pickedModel = null
let pickError = ''
const modelOf = (id) => gpuModels.find((m) => m.id === id)
const mins = (s) => Math.max(1, Math.ceil(s / 60))
const charOf = (panel) => (panel.charId ? state.chars[panel.charId] : state.chars[panel.cast?.[0]])

function autoPrompt(panel) {
  const ch = charOf(panel)
  return panel.charId
    ? [ch?.name, panel.pose, ch?.brief, panel.action].filter(Boolean).join(', ').slice(0, 320)
    : [panel.camera, panel.action,
      (panel.cast || []).map((id) => state.chars[id]?.brief).filter(Boolean).join(' / ')]
      .filter(Boolean).join(', ').slice(0, 320)
}

const genOpts = new Map()
const optsFor = (panel) => {
  let o = genOpts.get(panel.id)
  if (!o) genOpts.set(panel.id, (o = { ref: 'none', strength: 0.85, prompt: null }))
  return o
}

const morph = (v) => (v < 0.8 ? '선 그대로' : v < 0.9 ? '구도 유지' : '새로 그리기')

function refChoices(panel) {
  const out = [{ key: 'none', label: '없음' }]
  const anchor = refOf(charOf(panel))
  if (anchor) out.push({ key: 'anchor', label: '기준 이미지', src: anchor.src })
  const cur = liveVer(panel)
  if (cur) out.push({ key: 'current', label: `현재 v${cur.i + 1}${cur.ver.source === 'upload' ? ' (스케치)' : ''}`, src: srcOf(cur.ver) })
  return out
}

async function asInit(src) {
  if (!src) return null
  if (src.startsWith('data:')) return src
  const res = await fetch(src)
  if (!res.ok) throw new Error('참조 이미지를 읽지 못했습니다')
  return downscale(await res.blob(), 400_000)
}

async function askGpu(body, path = '') {
  const res = await fetch(cfg.genUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await idToken()}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(json.detail || (res.status >= 500
      ? `생성 서버가 꺼져 있습니다 (${res.status}) — GPU를 켜면 그림 외의 기능은 그대로 씁니다`
      : `생성 서버 오류 (${res.status})`))
  }
  return json
}

async function generate(panel) {
  if (!canGen) return generateLocal(panel)
  const o = optsFor(panel)
  const ch = charOf(panel)
  const anchor = refOf(ch)
  const choice = refChoices(panel).find((c) => c.key === o.ref) || { key: 'none' }
  const prompt = (o.prompt ?? autoPrompt(panel)).trim()

  emit({ kind: 'panel.patch', panelId: panel.id, fields: { generating: me.id, genAt: now(), genError: null } })
  try {
    const init = choice.key === 'none' ? null : await asInit(choice.src)
    const r = await askGpu({
      prompt,
      kind: panel.charId ? 'pose' : 'cut',
      model: pickedModel,
      seed: ch?.seedNo ?? null,
      init,
      strength: o.strength,
    })
    emit({
      kind: 'panel.version', panelId: panel.id,
      version: {
        n: (panel.versions?.length || 0) + 1,
        src: r.url, source: init ? 'sketch' : 'ai', author: me.id, ts: now(), prompt,
        gen: { model: r.model, seed: r.seed, ms: r.ms, ref: choice.key, strength: init ? o.strength : null },
        refFrom: choice.key === 'anchor' && anchor ? { panelId: anchor.panelId, n: anchor.n, pose: anchor.pose } : null,
      },
    })
  } catch (err) {
    emit({ kind: 'panel.patch', panelId: panel.id, fields: { generating: false, genError: err.message } })
    pollGpu()
  }
}

async function generateLocal(panel) {
  const ch = charOf(panel)
  const prompt = autoPrompt(panel)
  emit({ kind: 'panel.patch', panelId: panel.id, fields: { generating: me.id, genAt: now() } })
  await new Promise((r) => setTimeout(r, 1200))
  emit({
    kind: 'panel.version', panelId: panel.id,
    version: {
      n: (panel.versions?.length || 0) + 1,
      art: { seed: ch?.seedNo ?? now() % 997, mode: 'ai', prompt, figure: !!panel.charId, pose: panel.pose },
      source: 'ai', author: me.id, ts: now(), prompt,
    },
  })
}

let fastPoll = null
async function pollGpu() {
  if (!canGen) return
  try {
    const r = await fetch(`${cfg.genUrl}/health`, { cache: 'no-store' })
    const j = await r.json()
    gpuModels = j.models || []
    if (!pickedModel) pickedModel = j.loading || j.modelId
    gpu = j.error ? { state: 'error', text: '생성 서버 오류', hint: j.error, resident: j.modelId }
      : j.loading ? {
        state: 'warm', text: '모델 올리는 중', resident: j.modelId, loading: j.loading,
        hint: `${modelOf(j.loading)?.label || j.loading} · 약 ${mins(j.wait)}분`,
      }
        : !j.warm ? { state: 'warm', text: '모델 올리는 중', hint: '첫 부팅은 몇 분 걸립니다' }
          : {
            state: j.busy ? 'busy' : 'ok', text: j.busy ? '생성 중' : j.model,
            resident: j.modelId, hint: j.gpu || '',
          }
    clearTimeout(fastPoll)
    if (j.loading) fastPoll = setTimeout(pollGpu, 4000)
  } catch {
    gpu = { state: 'down', text: '생성 서버 연결 안 됨', hint: '인스턴스가 꺼져 있을 수 있습니다' }
  }
  renderGpu()
  renderDetail()
}
if (canGen) setInterval(pollGpu, 20_000)

async function pickModel(id) {
  pickedModel = id
  pickError = ''
  renderGpu()
  renderDetail()
  if (id === gpu.resident) return
  try {
    await askGpu({ model: id }, '/load')
    announce(`${modelOf(id)?.label || id}을 올리는 중입니다.`)
  } catch (err) {
    pickError = err.message
    gpu = { ...gpu, hint: err.message }
    announce(err.message)
  }
  renderGpu()
  pollGpu()
}

async function upload(panel, file) {
  try {
    const src = await downscale(file)
    emit({
      kind: 'panel.version', panelId: panel.id,
      version: { n: (panel.versions?.length || 0) + 1, src, source: 'upload', author: me.id, ts: now(), name: file.name },
    })
    if (canGen) { optsFor(panel).ref = 'current'; renderDetail() }
  } catch (err) {
    alert(err.message)
  }
}

const byId = (id) => document.getElementById(id)
const hhmm = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })

function fmtWhen(ts) {
  const m = Math.max(0, now() - ts) / 6e4
  if (m < 1) return '방금'
  if (m < 60) return `${Math.floor(m)}분 전`
  if (m < 1440) return `${Math.floor(m / 60)}시간 전`
  return `${Math.floor(m / 1440)}일 전`
}

function pinOrder(cmts) {
  const per = new Map()
  const out = new Map()
  for (const c of cmts) {
    if (!c.pin) continue
    const k = c.onVersion ?? 0
    per.set(k, (per.get(k) || 0) + 1)
    out.set(c.id, per.get(k))
  }
  return out
}

function atHtml(body) {
  const names = people().map((p) => esc(p.name)).sort((a, b) => b.length - a.length)
  const text = esc(body)
  if (!names.length) return text
  const re = new RegExp(`@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g')
  return text.replace(re, '<span class="at">@$1</span>')
}

function threadHtml(cmts, p = null) {
  const nums = pinOrder(cmts)
  const gone = (c) => !!p && deadVer(p, p.versions?.[(c.onVersion || 0) - 1])
  const kids = (id) => cmts.filter((c) => c.parentId === id)
  const one = (c, depth) => `
    <li class="cmt" data-cmt="${c.id}" data-resolved="${c.resolved ? 1 : 0}"
        data-depth="${depth}" data-focus="${focusCmt === c.id ? 1 : 0}">
      <div class="cmt__top">
        <span class="dot" style="background:${person(c.author)?.color || '#999'}"></span>
        <span class="cmt__who">${esc(person(c.author)?.name || '알 수 없음')}</span>
        <span class="cmt__when">${hhmm(c.ts)}</span>
        ${nums.has(c.id) ? `<span class="cmt__pin">${nums.get(c.id)}</span>` : ''}
        <span class="cmt__on">v${c.onVersion}에 달림${gone(c) ? ' (지운 그림)' : ''}</span>
      </div>
      ${atHtml(c.body)}
      <div class="cmt__acts">
        <button class="cmt__resolve" data-reply="${c.id}">답글</button>
        <button class="cmt__resolve" data-resolve="${c.id}">${c.resolved ? '다시 열기' : '해결'}</button>
      </div>
      ${kids(c.id).length ? `<ul class="thread thread--sub">${kids(c.id).map((k) => one(k, 1)).join('')}</ul>` : ''}
    </li>`
  const roots = cmts.filter((c) => !c.parentId || !cmts.some((x) => x.id === c.parentId))
  return `<ul class="thread">${roots.map((c) => one(c, 0)).join('')}</ul>`
}

function composerHtml(inputId, cmts = []) {
  const rep = replyTo ? cmts.find((c) => c.id === replyTo) : null
  const marks = pending.mark.length
  return `
    <div class="composer" data-in="${inputId}">
      <div class="tags">
        ${FEEDBACK_TAGS.map((t) => `<button class="tag" data-tag="${t}">${t}</button>`).join('')}
        ${people().filter((u) => u.id !== me.id)
          .map((u) => `<button class="tag tag--at" data-at="${esc(u.name)}">@${esc(u.name)}</button>`).join('')}
      </div>
      ${rep ? `<p class="attach"><b>${esc(person(rep.author)?.name || '')}</b>에게 답글 —
        ${esc(rep.body.slice(0, 24))}${rep.body.length > 24 ? '…' : ''}
        <button class="mini" data-unreply="1">취소</button></p>` : ''}
      ${pending.pin || marks ? `<p class="attach">그림 위 표시 붙음 —
        ${[pending.pin ? '핀 1' : '', marks ? `그리기 ${marks}` : ''].filter(Boolean).join(' · ')}
        <button class="mini" data-unpin="1">지우기</button></p>` : ''}
      <div class="cmt--new">
        <input type="text" id="${inputId}" placeholder="메모를 남기면 담당자에게 알림이 갑니다. @이름으로 부를 수 있습니다.">
        <button class="btn btn--solid" data-say="${inputId}">남기기</button>
      </div>
    </div>`
}

function sayFrom(inputId, panel) {
  const input = byId(inputId)
  const body = input?.value.trim()
  if (!body) return false
  const extra = { ...pending, parentId: replyTo }
  input.value = ''
  pending = { pin: null, mark: [] }
  replyTo = null
  addComment(panel, body, extra)
  return true
}

function insertInto(el, text, tag = false) {
  const input = byId(el.closest('[data-in]').dataset.in)
  if (!input) return
  input.value = tag
    ? `[${text}] ${input.value.replace(/^\[[^\]]*\]\s*/, '')}`
    : `${input.value.replace(/\s*$/, '')} @${text} `.replace(/^\s+/, '')
  input.focus()
}

const dOf = (pts) => {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  let d = ''
  for (let i = 0; i + 1 < pts.length; i += 2) d += `${i ? 'L' : 'M'}${n(pts[i])} ${n(pts[i + 1])}`
  return d
}

function atPoint(frame, e) {
  const r = frame.getBoundingClientRect()
  const clamp = (v) => Math.min(1, Math.max(0, v))
  return {
    x: +clamp((e.clientX - r.left) / r.width).toFixed(3),
    y: +clamp((e.clientY - r.top) / r.height).toFixed(3),
  }
}

let imeEl = null
let imeMissed = false
let imeTimer = null

const composing = (host) => !!imeEl && imeEl === document.activeElement && host.contains(imeEl)

document.addEventListener('compositionstart', (e) => { imeEl = e.target; clearTimeout(imeTimer) })
document.addEventListener('compositionend', () => {
  imeEl = null
  if (!imeMissed) return
  clearTimeout(imeTimer)
  imeTimer = setTimeout(() => { imeMissed = false; render() }, 250)
})

function render() {
  if (viewChar && charList().length && !state.chars[viewChar]) {
    viewChar = charList()[0].id
    selectedId = viewPanels()[0]?.id ?? null
  }
  if (viewEp && !state.eps[viewEp]) { viewEp = null; selectedId = viewPanels()[0]?.id ?? null }
  syncMe()
  renderHeader()
  renderMe()
  renderGpu()
  renderNav()
  renderMine()
  renderTime()
  renderBoard()
  renderDetail()
  renderViewer()
  renderPeers()
  renderBell()
  renderNotifs()
  renderFresh()
  renderHold()
  renderAdmin()
}

function renderHeader() {
  const ch = viewChar ? state.chars[viewChar] : null
  const ep = ch ? null : state.eps[viewEp]
  const many = epList().length > 0
  const list = viewPanels()
  const done = list.filter((p) => p.status === 'approved').length
  const secs = list.reduce((s, p) => s + (Number(p.secs) || 0), 0)
  byId('boardTitle').textContent = ch ? ch.name : (ep?.title || state.board.title)
  byId('boardSub').textContent = ch
    ? `구도 ${list.length} · 승인 ${done}/${list.length} · ${state.board.title}`
    : `${many ? `${epLabel(ep)} · ` : ''}컷 ${list.length} · 승인 ${done}/${list.length}${secs ? ` · ${clock(secs)}` : ''}`

  byId('printHead').textContent = [
    ch ? `${state.board.title} — ${ch.name}`
      : (many ? `${state.board.title} — ${epLabel(ep)}` : state.board.title),
    ch ? `구도 ${list.length}` : `씬 ${sceneGroups(list).filter((g) => g.name).length || 1} · 컷 ${list.length}`,
    secs ? clock(secs) : '',
    new Date().toLocaleDateString('ko-KR'),
  ].filter(Boolean).join('  ·  ')
}

function renderTime() {
  const el = byId('timeline')
  const list = viewPanels()
  const groups = sceneGroups(list)
  const starts = startTimes(list)
  const total = list.reduce((s, p) => s + (Number(p.secs) || 0), 0)
  el.hidden = viewChar !== null || !total
  if (el.hidden) return
  setHtml(el, `
    <div class="tl__lab mono">타임라인 <span class="tl__total">총 ${clock(total)}</span></div>
    <div class="tl__track">
      ${groups.map((g) => `
        <div class="tl__scene" style="flex:${g.secs || 0.5}">
          <div class="tl__cuts">
            ${g.cuts.map((p) => `
              <button class="tl__cut" style="flex:${Number(p.secs) || 0.5}"
                data-tone="${STATUS[p.status].tone}" data-goto="${p.id}"
                data-on="${p.id === selectedId ? 1 : 0}"
                title="${esc(`${labelOf(p)} · ${STATUS[p.status].label} · ${clock(starts[p.id])}–${clock(starts[p.id] + (Number(p.secs) || 0))}`)}">
                <span>${esc(String(cutNo(p)))}</span>
              </button>`).join('')}
          </div>
          <div class="tl__name">${esc(g.name || '씬 없음')} <span>${clock(g.secs)}</span></div>
        </div>`).join('')}
    </div>`)
}

function renderNav() {
  const chars = charList()
  byId('charCount').textContent = chars.length || ''
  setHtml(byId('charNav'), chars.map((c) => {
    const ps = panelsIn(c.id)
    const ok = ps.filter((p) => p.status === 'approved').length
    const ref = refOf(c)
    return `<li><button class="nav__item" data-char="${c.id}" data-active="${viewChar === c.id ? 1 : 0}">
      ${ref ? `<img class="nav__ref" src="${ref.src}" alt="">` : '<span class="nav__ref"></span>'}
      <span class="nav__name">${esc(c.name)}</span>
      <span class="nav__n">${ok}/${ps.length}</span>
    </button></li>`
  }).join(''))

  const eps = epList()
  setHtml(byId('boardNav'), [null, ...eps].map((ep) => {
    const id = ep?.id ?? null
    const cuts = cutsOf(id)
    const ok = cuts.filter((p) => p.status === 'approved').length
    const name = eps.length ? epLabel(ep) : '컷 보드'
    return `<li><button class="nav__item" data-ep="${ep?.id ?? ''}"
      data-active="${viewChar === null && viewEp === id ? 1 : 0}">
      <span class="nav__name">${esc(name)}</span><span class="nav__n">${ok}/${cuts.length}</span>
    </button></li>`
  }).join(''))

  byId('scriptBlock').hidden = viewChar !== null
  byId('charMeta').hidden = viewChar === null
  if (viewChar === null) {
    const el = byId('scenario')
    const ep = state.eps[viewEp]
    if (document.activeElement !== el) el.value = (ep ? ep.scenario : state.board.scenario) || ''
  } else {
    const ch = state.chars[viewChar]
    if (document.activeElement !== byId('nameIn')) byId('nameIn').value = ch?.name || ''
    if (document.activeElement !== byId('briefIn')) byId('briefIn').value = ch?.brief || ''
  }
}

function renderMine() {
  const mine = Object.values(state.panels)
    .filter((p) => p.assignee === me.id && p.status !== 'approved')
    .sort((a, b) => (whereOf(a) + labelOf(a)).localeCompare(whereOf(b) + labelOf(b)))
  byId('mineCount').textContent = mine.length ? mine.length : ''
  setHtml(byId('mine'), mine.length
    ? mine.map((p) => `
        <li><button class="mine__item" data-goto="${p.id}">
          <span class="mine__no">${esc(labelOf(p))}</span>
          <span>${esc(STATUS[p.status].label)}</span>
          <span class="mine__where">${esc(whereOf(p))}</span>
        </button></li>`).join('')
    : '<li class="mine--empty">넘어온 작업이 없습니다.</li>')
}

let adminTab = 'assign'
let adminNeed = 'open'
let adminSay = ''

function openAdmin(on) {
  const dlg = byId('admin')
  if (on && !canSeeAdmin(me.role)) return
  if (on && !dlg.open) dlg.showModal()
  else if (!on && dlg.open) dlg.close()
  byId('adminBtn').setAttribute('aria-expanded', String(on))
  if (on) renderAdmin()
}

function renderAdmin() {
  const dlg = byId('admin')
  if (!dlg.open) return
  const live = document.activeElement
  if (dlg.contains(live) && (live.tagName === 'SELECT' || live.tagName === 'INPUT')) return
  for (const b of dlg.querySelectorAll('[data-tab]')) b.dataset.on = b.dataset.tab === adminTab ? '1' : '0'
  setHtml(byId('admBody'), adminTab === 'assign' ? assignHtml() : teamHtml())
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0)
const heldFor = (secs) => (secs < 60 ? '방금' : `${fmtDur(secs)}째`)
const nameOf = (p) => (p?.charId ? `${whereOf(p)} ${labelOf(p)}` : labelOf(p))

function slipCell(lab, val, { unit = '', tone = '', meter = -1, none = '' } = {}) {
  return `<div class="slip__cell" ${tone ? `data-tone="${tone}"` : ''}>
    <span class="slip__lab">${esc(lab)}</span>
    <span class="slip__val">${none
      ? `<span class="slip__none">${esc(none)}</span>`
      : `${esc(String(val))}${unit ? `<small>${esc(unit)}</small>` : ''}`}</span>
    ${meter >= 0 ? `<span class="slip__meter" aria-hidden="true"><i style="width:${meter}%"></i></span>` : ''}
  </div>`
}

function assignHtml() {
  const can = ACTIONS.assign.roles.includes(me.role)
  const need = NEEDS[adminNeed] || NEEDS.open
  const all = Object.values(state.panels)
  const at = now()
  const t = tally(all)
  const held = stalls(all, state.events, at)
  const stuck = held.find((s) => s.p.status !== 'approved' && s.known)
  const redone = retakes(state.events)
  const first = firstPass(all, state.events)
  const lag = reviewLag(all, state.events)
  const back = flow(state.events).back
  const rows = held.filter((s) => need.hit(s.p))
  const worst = rows[0]?.secs || 0
  const cuts = panelsIn(null)
  const scenes = sceneGroups(cuts)
  const total = Math.max(1, cuts.reduce((n, p) => n + (Number(p.secs) || 0), 0))
  const openOf = (id) => state.comments.filter((c) => c.panelId === id && !c.resolved).length

  return `
    <p class="adm__lead">
      ${t.unassigned
        ? `담당 없는 컷 <b>${t.unassigned}건</b>`
        : '모든 컷에 담당이 있습니다'}
      <span class="adm__sep">·</span>
      ${stuck
        ? `가장 오래 멈춘 컷 <button class="tbl__go" data-goto="${stuck.p.id}">${esc(nameOf(stuck.p))}</button>
           ${esc(STATUS[stuck.p.status].label)} ${esc(heldFor(stuck.secs))}`
        : '멈춰 있는 컷이 없습니다'}
    </p>
    <div class="slip">
      ${slipCell('승인', t.byStatus.approved || 0, {
        unit: `/ ${t.n}컷`, tone: 'approve', meter: pct(t.byStatus.approved || 0, t.n),
      })}
      ${slipCell('승인된 분량', clock(t.secsDone), {
        unit: `/ ${clock(t.secs)}`, meter: pct(t.secsDone, t.secs),
      })}
      ${slipCell('한 번에 통과', first.total ? `${pct(first.clean, first.total)}%` : '', {
        unit: `${first.clean}/${first.total}`, none: first.total ? '' : '기록 없음',
      })}
      ${slipCell('리뷰 → 승인', lag ? fmtDur(lag) : '', { unit: '중간값', none: lag ? '' : '기록 없음' })}
      ${slipCell('되돌린 이동', back, { unit: '회', tone: back ? 'reject' : '' })}
    </div>

    <h2 class="mono h">판 한눈에 <span class="count">${cuts.length}</span></h2>
    ${cuts.length ? `
      <div class="band">
        ${scenes.map((sc) => `
          <div class="band__scene" style="flex:${Math.max(1, sc.secs)}">
            <div class="band__row">
              ${sc.cuts.map((p) => `
                <button class="band__cut" style="flex:${Math.max(1, Number(p.secs) || 1)}"
                  data-goto="${p.id}" data-tone="${STATUS[p.status].tone}"
                  aria-label="${esc(labelOf(p))} ${esc(STATUS[p.status].label)} ${clock(p.secs)} 담당 ${esc(person(p.assignee)?.name || '없음')}"></button>`).join('')}
            </div>
            <div class="band__own" aria-hidden="true">
              ${sc.cuts.map((p) => `<i style="flex:${Math.max(1, Number(p.secs) || 1)}${p.assignee
                ? `;background:${person(p.assignee).color}` : ''}" ${p.assignee ? '' : 'data-none="1"'}></i>`).join('')}
            </div>
            <div class="band__name">${esc(sc.name || '씬 없음')} · ${sc.cuts.length}컷 ${clock(sc.secs)}</div>
          </div>`).join('')}
      </div>
      <p class="adm__note">칸의 너비가 컷 길이입니다(합 ${clock(total)}). 위 3px 선은 단계, 아래 얇은 띠는 담당이고,
        빗금은 담당이 없는 칸입니다. 칸을 누르면 그 컷으로 갑니다.</p>`
      : '<p class="tbl--empty">아직 컷이 없습니다.</p>'}

    <h2 class="mono h" style="margin-top:22px">컷 스트립 <span class="count">${rows.length}</span></h2>
    <p class="adm__why">${can
      ? '담당을 바꾸면 그 사람에게 알림이 갑니다. 지금 접속하지 않은 사람에게도 맡길 수 있습니다.'
      : `${ROLES[me.role] || me.role}는 담당을 지정할 수 없습니다 — ${ACTIONS.assign.roles.map((r) => ROLES[r]).join(' · ')}가 합니다.`}</p>
    <div class="adm__filters">
      ${Object.entries(NEEDS).map(([k, f]) => `
        <button class="adm__tab" data-need="${k}" data-on="${k === adminNeed ? 1 : 0}">
          ${f.label} <b>${all.filter(f.hit).length}</b></button>`).join('')}
    </div>
    ${rows.length ? `
      <table class="tbl">
        <thead><tr>
          <th>컷</th><th>위치</th><th>단계</th><th>담당</th>
          <th>이 상태로</th><th>표시</th><th>마지막 손댐</th>
        </tr></thead>
        <tbody>${rows.map(({ p, secs, known }) => {
          const open = openOf(p.id)
          const vs = (p.versions || []).filter((v) => !deadVer(p, v)).length
          const touched = touchedAt(p)
          return `<tr>
            <td><button class="tbl__go" data-goto="${p.id}">${esc(labelOf(p))}</button></td>
            <td class="tbl__dim">${esc(whereOf(p))}${p.scene ? ` · ${esc(p.scene)}` : ''}</td>
            <td><span class="detail__status" data-tone="${STATUS[p.status].tone}">${esc(STATUS[p.status].label)}</span></td>
            <td><select data-assign="${p.id}" ${can ? '' : 'disabled'} ${p.assignee ? '' : 'data-empty="1"'}
              aria-label="${esc(labelOf(p))} 담당">${assignOpts(p.assignee)}</select></td>
            <td>${known ? `<span class="tbl__wait mono" data-worst="${secs === worst ? 1 : 0}">${esc(heldFor(secs))}
              <i style="width:${pct(secs, worst)}%" aria-hidden="true"></i></span>` : '<span class="tbl__dim">기록 없음</span>'}</td>
            <td>
              ${vs > 1 ? `<span class="tbl__dim">v${vs}</span>` : ''}
              ${redone[p.id] ? `<span class="tbl__mark">재작업 ${redone[p.id]}</span>` : ''}
              ${open ? `<span class="tbl__dim">메모 ${open}</span>` : ''}
            </td>
            <td class="tbl__dim">${touched ? esc(fmtWhen(touched)) : ''}</td>
          </tr>`
        }).join('')}</tbody>
      </table>`
      : '<p class="tbl--empty">이 잣대에 걸리는 컷이 없습니다.</p>'}`
}

function teamHtml() {
  const grant = canGrantRole(me.role)
  const at = now()
  const all = Object.values(state.panels)
  const list = roster()
  const load = workload(all, list.map((u) => u.id))
  list.sort((a, b) => (load[b.id]?.open ?? 0) - (load[a.id]?.open ?? 0) || a.name.localeCompare(b.name))
  const idleCuts = all.filter(NEEDS.unassigned.hit)
  const rule = Math.max(1, ...list.map((u) => load[u.id]?.open || 0), idleCuts.length)
  const moved = actorPace(state.events, at)
  const day = pace(state.events, at)
  const tall = Math.max(1, ...day.cols.map((c) => c.n))
  const f = flow(state.events)
  const most = f.pairs[0]?.n || 1
  const seg = (n, tone) => (n ? `<i data-tone="${tone}" style="width:${pct(n, rule)}%"></i>` : '')

  return `
    ${grant ? `
      <div class="adm__new">
        <span class="mono adm__newlab">팀원 등록</span>
        <input type="text" id="admId" placeholder="아이디" autocapitalize="off" spellcheck="false" autocomplete="off">
        <input type="text" id="admName" placeholder="이름">
        <select id="admRole" aria-label="역할">
          ${Object.entries(ROLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <button class="btn btn--solid" id="admAdd"><span class="mono">명부에 올리기</span></button>
        <p class="adm__why adm__newwhy">${esc(adminSay
          || '계정은 조직이 만듭니다(Cognito). 여기서 정하는 것은 그 사람이 이 보드에서 어떤 역할로 일하는가입니다.')}</p>
      </div>` : ''}

    <h2 class="mono h">사람 <span class="count">${list.length}</span></h2>
    <p class="adm__why">${grant
      ? '역할을 바꾸면 그 사람 화면의 권한이 그 자리에서 바뀝니다 — 다시 로그인하지 않습니다.'
      : `역할을 지정하는 것은 ${ROLES.admin}입니다. 누가 무엇을 들고 있는지는 아래에서 볼 수 있습니다.`}
      띠의 길이는 남은 일의 수이고, 가장 많이 든 사람이 <b>${rule}건</b>입니다.</p>
    <div class="crew">
      ${list.map((u) => {
        const w = load[u.id] || { open: 0, approved: 0, by: {}, cuts: [] }
        const live = u.id === me.id ? { at: selectedId } : peers.get(u.id)
        const spot = live && state.panels[live.at]
        return `<div class="crew__row">
          <div>
            <div class="crew__who">
              <span class="dot crew__dot" style="background:${u.color}"></span>
              <span class="crew__name">${esc(u.name)}${u.id === me.id ? ' (나)' : ''}</span>
            </div>
            <div class="crew__role">
              ${grant ? `<select data-role="${u.id}" aria-label="${esc(u.name)} 역할">
                ${Object.entries(ROLES).map(([k, v]) =>
                  `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}
              </select>` : `<span class="mono">${esc(ROLES[u.role] || u.role)}</span>`}
              <span class="crew__live" data-off="${live ? 0 : 1}">${live
                ? esc(spot ? `${whereOf(spot)} ${labelOf(spot)}` : '접속 중')
                : '접속 안 함'}</span>
            </div>
          </div>
          <div>
            <div class="crew__load" role="img"
              aria-label="남은 일 ${w.open}건, 팀 최대 ${rule}건 기준">
              <!-- 초안도 센다. 맡겼는데 아직 시작 안 한 컷이 숫자에서 빠지면 0건처럼 보인다. -->
              ${seg(w.by.draft || 0, 'idle')}${seg(w.by.in_progress || 0, 'work')}
              ${seg(w.by.in_review || 0, 'wait')}${seg(w.by.changes_requested || 0, 'reject')}
            </div>
            <p class="crew__nums mono">
              <span>남은 일 <b>${w.open}</b></span>
              <span>초안 <b>${w.by.draft || 0}</b></span>
              <span>작업 중 <b>${w.by.in_progress || 0}</b></span>
              <span>리뷰 대기 <b>${w.by.in_review || 0}</b></span>
              <span>수정 요청 <b>${w.by.changes_requested || 0}</b></span>
              <span>승인 <b>${w.approved}</b></span>
              <span>오늘 옮김 <b>${moved[u.id]?.n || 0}</b></span>
            </p>
            ${w.cuts.length ? `<ul class="crew__cuts">
              ${w.cuts.slice(0, 8).map((p) => `
                <li><button data-goto="${p.id}">
                  <span class="mono crew__cut">${esc(labelOf(p))}</span>
                  <span>${esc(STATUS[p.status].label)}</span>
                </button></li>`).join('')}
              ${w.cuts.length > 8 ? `<li class="crew__none">그 외 ${w.cuts.length - 8}건</li>` : ''}
            </ul>` : '<p class="crew__none">맡은 작업이 없습니다.</p>'}
          </div>
        </div>`
      }).join('')}
      ${idleCuts.length ? `
        <div class="crew__row" data-none="1">
          <div class="crew__who">
            <span class="crew__name">담당 없음</span>
          </div>
          <div>
            <div class="crew__load" role="img" aria-label="담당 없는 컷 ${idleCuts.length}건">
              <i data-tone="reject" style="width:${pct(idleCuts.length, rule)}%"></i>
            </div>
            <p class="crew__nums mono"><span>맡을 사람을 기다리는 컷 <b>${idleCuts.length}</b></span></p>
            <ul class="crew__cuts">
              ${idleCuts.slice(0, 8).map((p) => `
                <li><button data-goto="${p.id}">
                  <span class="mono crew__cut">${esc(labelOf(p))}</span>
                  <span>${esc(STATUS[p.status].label)}</span>
                </button></li>`).join('')}
              ${idleCuts.length > 8 ? `<li class="crew__none">그 외 ${idleCuts.length - 8}건</li>` : ''}
            </ul>
          </div>
        </div>` : ''}
    </div>

    <h2 class="mono h" style="margin-top:22px">오늘 움직임 <span class="count">${day.total}</span></h2>
    ${day.cols.length ? `
      <div class="pace">
        ${day.cols.map((c, i) => `
          <div class="pace__col" data-now="${i === day.cols.length - 1 ? 1 : 0}">
            <b>${c.n || ''}</b>
            <i style="height:${pct(c.n, tall)}%" aria-hidden="true"></i>
          </div>`).join('')}
      </div>
      <div class="pace__ax">${day.cols.map((c) => `<span>${new Date(c.h).getHours()}시</span>`).join('')}</div>
      <p class="adm__note">한 칸이 한 시간이고, 숫자는 그 시간에 단계가 바뀐 횟수입니다.
        하루보다 긴 추세는 기록이 없어 그리지 않습니다.</p>`
      : '<p class="adm__note">오늘은 아직 단계가 바뀐 컷이 없습니다.</p>'}

    <h2 class="mono h" style="margin-top:22px">단계 이동 <span class="count">${f.fwd + f.back}</span></h2>
    ${f.pairs.length ? `
      <ul class="ldg">
        ${f.pairs.map((r) => `
          <li data-back="${r.back ? 1 : 0}">
            <span class="ldg__lab">${esc(STATUS[r.from]?.label || r.from)} → ${esc(STATUS[r.to]?.label || r.to)}</span>
            <span class="ldg__n">${r.n}</span>
            <span class="ldg__bar" aria-hidden="true"><i style="width:${pct(r.n, most)}%"></i></span>
          </li>`).join('')}
      </ul>
      <p class="adm__note">붉은 줄은 되돌아간 이동입니다 — ${f.back}회 되돌아갔고 ${f.fwd}회 앞으로 갔습니다.
        누가 옮겼는지는 컷마다 기록에 남습니다.</p>`
      : '<p class="adm__note">아직 단계를 옮긴 기록이 없습니다.</p>'}`
}

function addMember() {
  const id = byId('admId').value.trim()
  const name = byId('admName').value.trim()
  const role = byId('admRole').value
  if (!id || !name) adminSay = '아이디와 이름을 모두 넣어주세요.'
  else if (scrub({ id }).id !== id) adminSay = '아이디에 쓸 수 없는 글자가 있습니다.'
  else {
    emit({ kind: 'member.set', member: { id, name, role, color: tint(id) } })
    adminSay = `${name}(${id}) — ${ro(ROLES[role])} 명부에 올렸습니다.`
    announce(adminSay)
  }
  renderAdmin()
  byId('admId')?.focus()
}

function renderBoard() {
  const board = byId('board')
  const list = viewPanels()
  const starts = startTimes(list)
  const ch = viewChar ? state.chars[viewChar] : null
  board.className = `board${viewChar ? ' board--poses' : ''}`

  if (selectedId && location.hash !== `#cut=${selectedId}`) {
    history.replaceState(null, '', `#cut=${selectedId}`)
  }

  if (!list.length) {
    setHtml(board, viewChar
      ? '<div class="board--empty">구도가 없습니다. 아래 버튼으로 추가하세요.</div>'
      : '<div class="board--empty">컷이 없습니다. 시나리오를 넣고 <b>컷으로 분해</b>를 누르거나 아래 버튼으로 추가하세요.</div>')
  }

  const rows = []
  if (!viewChar && list.some((p) => p.scene)) {
    sceneGroups(list).forEach((g, gi) => {
      rows.push({ key: `scene:${gi}`, scene: g })
      for (const p of g.cuts) rows.push({ key: p.id, panel: p })
    })
  } else {
    for (const p of list) rows.push({ key: p.id, panel: p })
  }

  const keep = new Set(rows.map((r) => r.key))
  for (const node of [...board.children]) {
    if (node.classList.contains('adder')) continue
    if (node.classList.contains('board--empty')) { if (list.length) node.remove(); continue }
    if (!keep.has(node.dataset.id)) node.remove()
  }

  rows.forEach((row, i) => {
    let el = board.querySelector(`[data-id="${row.key}"]`)
    if (!el) {
      el = document.createElement(row.scene ? 'div' : 'article')
      el.dataset.id = row.key
      if (row.panel) {
        el.draggable = true
        el.tabIndex = 0
        el.setAttribute('role', 'button')
      }
    }
    if (board.children[i] !== el) board.insertBefore(el, board.children[i] || null)

    if (row.scene) {
      el.className = 'scene'
      setHtml(el, `<span class="scene__name">${esc(row.scene.name || '씬 없음')}</span>
        <span class="scene__meta mono">${row.scene.cuts.length}컷 · ${clock(row.scene.secs)}</span>`)
      return
    }

    const p = row.panel
    el.className = `cut${p.charId ? ' cut--pose' : ''}`

    const cur = liveVer(p)
    const ver = cur?.ver
    const cmts = state.comments.filter((c) => c.panelId === p.id)
    const open = cmts.filter((c) => !c.resolved).length
    const st = STATUS[p.status]
    const who = person(p.assignee)
    const isRef = ch?.refPanelId === p.id && !!refOf(ch)
    const busyBy = genBy(p)
    const here = [...peers.values()].filter((q) => q.at === p.id)

    el.dataset.selected = p.id === selectedId ? '1' : '0'
    el.dataset.fresh = freshIds.has(p.id) ? '1' : '0'
    el.setAttribute('aria-label', `${labelOf(p)} · ${st.label}${who ? ` · 담당 ${who.name}` : ''}`)
    setHtml(el, `
      <div class="cut__frame">
        ${ver ? `<img src="${srcOf(ver)}" alt="${esc(labelOf(p))} 이미지" loading="lazy">` : '<div class="cut__empty">비어 있음<br>스케치 또는 생성</div>'}
        ${busyBy ? `<div class="cut__gen"><div class="spin"></div>${esc(busyBy.name)} 생성 중</div>` : ''}
        ${isRef ? '<span class="cut__ref">기준</span>' : ''}
        ${ver ? `<button class="cut__zoom" data-open="${p.id}" title="크게 보고 그림 위에 표시">크게 보기</button>` : ''}
        <div class="stamp stamp--${st.tone}">${esc(st.label)}</div>
      </div>
      <div class="cut__bar">
        <span class="cut__no">${esc(labelOf(p))}</span>
        ${p.charId || !p.secs ? ''
          : `<span class="cut__sec" title="시작 ${clock(starts[p.id])} · 길이 ${p.secs}초">${clock(starts[p.id])} · ${p.secs}초</span>`}
        ${p.charId ? '' : `<span class="cut__cam">${esc(p.camera || 'MS')}</span>`}
        ${(p.cast || []).map((id) => `<span class="cut__cam">${esc(state.chars[id]?.name || '')}</span>`).join('')}
        ${ver ? `<span class="cut__ver">v${cur.i + 1}</span>` : ''}
        ${el.dataset.fresh === '1' ? '<span class="cut__new">변경</span>' : ''}
        ${here.length ? `<span class="cut__here">${here.map((q) => `
          <i style="background:${q.color}" title="${esc(q.name)} · ${q.editing?.panelId === p.id ? '이 컷을 편집하는 중' : '이 컷을 보는 중'}">${esc(q.name[0])}</i>`).join('')}</span>` : ''}
      </div>
      <div class="cut__body">
        ${p.action ? `<p class="cut__action">${esc(p.action)}</p>`
          : p.charId || p.dialogue ? '' : '<p class="cut__action" style="color:#B3ABA0">설명 없음</p>'}
        ${p.dialogue ? `<p class="cut__dialogue">${esc(p.dialogue)}</p>` : ''}
      </div>
      <footer class="cut__foot">
        <span class="cut__who">${who ? esc(who.name) : '담당 없음'}</span>
        ${open ? `<span class="cut__cmt" data-unresolved="1">메모 ${open}</span>`
          : cmts.length ? `<span class="cut__cmt">메모 ${cmts.length} 해결</span>` : ''}
      </footer>`)
  })

  let adder = board.querySelector('.adder')
  if (!adder) {
    adder = document.createElement('button')
    adder.className = 'board--empty adder'
    adder.style.cursor = 'pointer'
    adder.style.background = 'transparent'
    adder.addEventListener('click', () => addPanel())
  }
  adder.textContent = viewChar ? '+ 구도 추가' : '+ 컷 추가'
  board.appendChild(adder)
}

function renderPeers() {
  const all = [{ ...me, self: true }, ...[...peers.values()]]
  setHtml(byId('peers'), all.map((p) => {
    const at = p.self ? null : state.panels[p.at]
    const where = at ? ` · ${whereOf(at)} ${labelOf(at)}${p.editing ? ' 편집 중' : ''}` : p.self ? '' : ' · 보드 밖'
    return `<button class="peer" data-me="${p.self ? 1 : 0}" ${at ? `data-jump="${p.at}"` : 'disabled'}
      style="background:${p.color}" title="${esc(p.name)} · ${ROLES[p.role]}${esc(where)}${at ? ' (눌러서 이동)' : ''}">
      ${esc(p.name[0])}<span class="peer__role">${ROLES[p.role]}${esc(where)}</span>
    </button>`
  }).join(''))
  const alone = peers.size === 0
  const off = link === 'down'
  byId('liveFlag').textContent = unsent
    ? `저장 대기 ${unsent}건 — 다시 보내는 중`
    : off ? '연결 끊김 — 재연결 중' : alone ? '나 혼자' : `${peers.size + 1}명 접속`
  byId('liveFlag').className = `mono tape${unsent ? ' tape--warn' : alone || off ? ' tape--off' : ''}`
}

function renderCursors() {
  setHtml(byId('cursors'), [...peers.values()]
    .filter((p) => p.cursor && (p.view ?? null) === (viewChar ?? null))
    .map((p) => `
      <div class="cursor" style="left:${p.cursor.x}px; top:${p.cursor.y}px">
        <svg width="14" height="18" viewBox="0 0 14 18"><path d="M1 1l11 8-5 1 2.5 6-2 1-2.6-6L1 14z" fill="${p.color}" stroke="#1C1A17" stroke-width="1"/></svg>
        <span style="background:${p.color}">${esc(p.name)}</span>
      </div>`).join(''))
}

let planStep = 'form'
let planMsg = ''
let planOut = null
let planSpec = {
  mode: 'new', prompt: '', genre: GENRES[0], tone: TONES[0],
  secs: 30, cuts: 8, newChars: 2, useChars: true, center: null,
}

const hasStory = () => !!(state.board.scenario || '').trim() || Object.values(state.panels).some((p) => !p.charId)
const planBase = () => planSpec.mode === 'new' && !hasStory()

const planCtx = () => {
  const ep = state.eps[viewEp]
  return {
    title: [state.board.title, ep?.title].filter(Boolean).join(' — '),
    scenario: (ep ? ep.scenario : state.board.scenario) || '',
    chars: charList().map((c) => ({ name: c.name, brief: c.brief })),
    centerName: state.chars[planSpec.center]?.name || '',
  }
}

function openPlan(on) {
  const dlg = byId('plan')
  if (on && !canPlan(me.role)) return
  if (on && !dlg.open) dlg.showModal()
  else if (!on && dlg.open) dlg.close()
  byId('planBtn').setAttribute('aria-expanded', String(on))
  if (on) renderPlan()
}

const planOpt = (list, now, label = (v) => v) => list
  .map((v) => `<option value="${v}" ${String(v) === String(now) ? 'selected' : ''}>${esc(label(v))}</option>`).join('')

const PLAN_HINT = {
  new: '예: 새벽에 문 여는 동네 빵집. 첫 손님이 오기까지의 15초.',
  next: '예: 옆 골목에 대형 프랜차이즈가 문을 연다. 단골이 줄어든다.',
  spin: '예: 이 인물이 빵집을 그만두고 떠난 여행에서 벌어지는 일.',
}

function renderPlan() {
  const body = byId('planBody')
  if (planStep === 'busy') {
    setHtml(body, `<div class="plan__wait"><span class="spin"></span><span>${esc(planMsg)}</span></div>`)
    return
  }
  if (planStep === 'review' && planOut) return renderPlanReview(body)

  const chars = charList()
  const off = { next: !hasStory(), spin: !hasStory() || !chars.length }
  setHtml(body, `
    <p class="adm__lead">프롬프트 하나로 이야기·인물·컷을 짭니다.
      <span class="adm__sep">·</span>개요를 먼저 보여드리고, 판에 붙이는 것은 그다음입니다.</p>

    <div class="plan__modes" role="group" aria-label="기획 방식">
      ${MODES.map((m) => `
        <button class="plan__mode" data-mode="${m.id}" data-on="${planSpec.mode === m.id ? 1 : 0}"
          ${off[m.id] ? `disabled title="${m.id === 'spin' && !chars.length ? '인물이 있어야 갈라 나올 수 있습니다' : '이어 붙일 이야기가 판에 없습니다'}"` : ''}>
          <b>${esc(m.label)}</b><span>${esc(m.hint)}</span>
        </button>`).join('')}
    </div>

    <label class="f">
      <span class="f__label"><span class="mono">소재</span></span>
      <textarea rows="4" id="planPrompt" placeholder="${esc(PLAN_HINT[planSpec.mode])}">${esc(planSpec.prompt)}</textarea>
    </label>

    <div class="plan__grid">
      <label class="f"><span class="f__label"><span class="mono">장르</span></span>
        <select id="planGenre">${planOpt(GENRES, planSpec.genre)}</select></label>
      <label class="f"><span class="f__label"><span class="mono">톤</span></span>
        <select id="planTone">${planOpt(TONES, planSpec.tone)}</select></label>
      <label class="f"><span class="f__label"><span class="mono">러닝타임</span></span>
        <select id="planSecs">${planOpt(LENGTHS, planSpec.secs, (v) => (v >= 60 ? `${v / 60}분` : `${v}초`))}</select></label>
      <label class="f"><span class="f__label"><span class="mono">컷 수</span></span>
        <select id="planCuts">${planOpt(CUTCOUNTS, planSpec.cuts, (v) => `${v}컷`)}</select></label>
      <label class="f"><span class="f__label"><span class="mono">새 인물</span></span>
        <select id="planNew">${planOpt([0, 1, 2, 3, 4], planSpec.newChars, (v) => (v ? `${v}명 만들기` : '만들지 않기'))}</select></label>
      ${planSpec.mode === 'spin' && chars.length ? `
        <label class="f"><span class="f__label"><span class="mono">중심 인물</span></span>
          <select id="planCenter">${chars.map((c) => `<option value="${c.id}" ${planSpec.center === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : ''}
    </div>

    ${chars.length ? `<label class="plan__check">
      <input type="checkbox" id="planKeep" ${planSpec.useChars ? 'checked' : ''}>
      지금 판의 인물 ${chars.length}명을 그대로 씁니다</label>` : ''}

    <div class="acts">
      <button class="btn btn--solid" id="planGo">개요 만들기</button>
      <button class="btn btn--line" id="planCancel">취소</button>
    </div>
    ${planMsg ? `<p class="why">${esc(planMsg)}</p>` : ''}
    <p class="adm__note">${net?.plan
      ? '개요는 10초쯤 걸립니다. 만들어진 뒤에 읽어보고 결정하세요.'
      : '로컬 모드입니다 — 모델이 없어 프롬프트를 잘라 뼈대만 만듭니다. 진짜 기획은 배포된 판에서 됩니다.'}</p>`)
}

function renderPlanReview(body) {
  const news = planOut.chars
  const secs = planOut.beats.reduce((s, b) => s + (Number(b.secs) || 0), 0)
  setHtml(body, `
    <p class="adm__lead"><b>${esc(planOut.title || '제목 없음')}</b>
      <span class="adm__sep">·</span>${esc(MODES.find((m) => m.id === planSpec.mode).label)}
      <span class="adm__sep">·</span>비트 ${planOut.beats.length}개 · ${clock(secs)}</p>
    ${planOut.logline ? `<p class="plan__syn"><b>${esc(planOut.logline)}</b></p>` : ''}
    ${planOut.synopsis ? `<p class="plan__syn">${esc(planOut.synopsis)}</p>` : ''}

    ${news.length ? `
      <span class="plan__meta">새로 만들 인물 ${news.length}명 · 각자 구도 ${POSES.length}칸이 함께 깔립니다</span>
      <ul class="plan__chars">
        ${news.map((c) => `<li><b>${esc(c.name)}</b>${esc(c.brief)}</li>`).join('')}
      </ul>` : ''}

    <span class="plan__meta" style="margin-top:12px">흐름</span>
    <ul class="plan__beats">
      ${planOut.beats.map((b, i) => `<li>
        <span class="plan__meta">${i + 1}. ${esc(b.scene || `S${i + 1}`)} · ${clock(b.secs)}${b.cast.length ? ` · ${esc(b.cast.join(', '))}` : ''}</span>
        ${esc(b.action)}</li>`).join('')}
    </ul>

    <div class="acts">
      <button class="btn btn--solid" id="planApply">이대로 컷 ${planSpec.cuts}개 만들기</button>
      <button class="btn btn--line" id="planAgain">개요 다시</button>
      <button class="btn btn--line" id="planBack">옵션 고치기</button>
    </div>
    ${planMsg ? `<p class="why">${esc(planMsg)}</p>` : ''}
    <p class="adm__note">${planBase()
      ? '지금 판(본편)에 제목·이야기와 컷이 붙습니다.'
      : '새 회차로 붙습니다. 지금 있는 컷은 그대로 남습니다.'}
      팀 전원의 화면에 함께 생깁니다.</p>`)
}

async function runPlan(step) {
  planStep = 'busy'
  planMsg = step === 'outline'
    ? '이야기 구조를 짜고 있습니다… 10초쯤 걸립니다.'
    : `비트를 컷 ${planSpec.cuts}개로 펼치고 있습니다… 10초쯤 걸립니다.`
  renderPlan()
  try {
    if (step === 'outline') {
      planOut = await planOutline(net, planSpec, planCtx())
      planStep = 'review'
      planMsg = planOut.local ? '로컬 모드 예시입니다 — 문장을 잘라 만든 뼈대입니다.' : ''
    } else {
      const cuts = await planCuts(net, planSpec, planOut)
      if (!cuts.length) throw new Error('컷을 받지 못했습니다. 다시 시도해 주세요.')
      applyPlan(planOut, cuts)
      planStep = 'form'
      planOut = null
      planMsg = ''
      openPlan(false)
      return
    }
  } catch (err) {
    console.warn('[plan]', err)
    planStep = planOut && step === 'cuts' ? 'review' : 'form'
    planMsg = err?.message || '기획에 실패했습니다. 다시 시도해 주세요.'
  }
  renderPlan()
}

function applyPlan(out, cuts) {
  const ops = []
  const scenario = [out.logline, '', out.synopsis].join('\n').trim()
  let epId = null
  let made = 0

  if (planBase()) {
    ops.push({ kind: 'board.patch', fields: { title: out.title || state.board.title, scenario } })
  } else {
    epId = uid()
    ops.push({
      kind: 'ep.add',
      ep: {
        id: epId,
        epNo: planSpec.mode === 'spin'
          ? epList().length + 2
          : epList().filter((e) => !e.spinoff).length + 2,
        title: out.title, spinoff: planSpec.mode === 'spin',
        fromEp: viewEp || null,
        centerChar: planSpec.mode === 'spin' ? (planSpec.center || null) : null,
        logline: out.logline, synopsis: out.synopsis, scenario,
      },
    })
  }

  const byName = new Map(charList().map((c) => [c.name, c.id]))
  let ck = charList().at(-1)?.orderKey ?? null
  for (const c of out.chars) {
    if (byName.has(c.name)) continue
    const id = uid()
    byName.set(c.name, id)
    made += 1
    ck = orderKeyBetween(ck, null)
    ops.push({
      kind: 'char.add',
      char: {
        id, name: c.name, brief: c.brief, seedNo: Math.floor(Math.random() * 900) + 20,
        orderKey: ck, refPanelId: null, refN: null,
      },
    })
    let pk = null
    for (const pose of POSES) {
      pk = orderKeyBetween(pk, null)
      ops.push({
        kind: 'panel.add',
        panel: {
          id: uid(), charId: id, pose, orderKey: pk,
          action: '', status: 'draft', assignee: null, versions: [], current: -1, generating: false,
        },
      })
    }
  }

  let key = cutsOf(epId).at(-1)?.orderKey ?? null
  for (const c of cuts) {
    key = orderKeyBetween(key, null)
    ops.push({
      kind: 'panel.add',
      panel: {
        id: uid(), charId: null, orderKey: key, ...(epId ? { epId } : {}),
        scene: c.scene, secs: c.secs, action: c.action, dialogue: c.dialogue, camera: c.camera,
        cast: c.cast.map((n) => byName.get(n)).filter(Boolean),
        status: 'draft', assignee: null, versions: [], current: -1, generating: false,
      },
    })
  }

  emitMany(ops)
  if (epId) setEp(epId)
  else setView(null)
  render()
  announce(`${epId ? `${epLabel(state.eps[epId])}에 ` : ''}컷 ${cuts.length}개${made ? `와 인물 ${made}명` : ''}을 만들었습니다.`)
}

const myNotifs = () => state.notifs.filter((n) => n.to === me.id).sort((a, b) => b.ts - a.ts)
const KIND = { comment: '메모', mention: '멘션', reply: '답글', status: '상태', assign: '담당', version: '이미지' }
const notifText = (n) =>
  n.kind === 'assign' ? '이 작업을 맡겼습니다'
  : n.kind === 'status' ? `${STATUS[n.status]?.label || '상태'}(으)로 넘겼습니다`
  : n.kind === 'version' ? '이미지를 지웠습니다'
  : (n.body || '메모를 남겼습니다')

function renderBell() {
  const unread = myNotifs().filter((n) => !n.read)
  const u = unread.filter(isActionable).length
  byId('bell').dataset.unread = u ? '1' : '0'
  byId('bellN').textContent = u
  byId('bell').setAttribute('aria-label',
    u ? `알림 ${u}건 — 확인이 필요합니다` : unread.length ? `알림 ${unread.length}건 — 읽지 않음` : '알림 없음')
}

function renderNotifs() {
  const box = byId('notifs')
  if (box.hidden) return
  const list = myNotifs().slice(0, 20)
  setHtml(box, `
    <div style="display:flex;align-items:center;gap:8px;padding:2px 8px 8px">
      <span class="mono" style="font-size:10px;color:var(--pencil)">받은 알림</span>
      ${list.length ? '<button class="cmt__resolve" data-readall="1" style="margin-left:auto">모두 읽음</button>' : ''}
    </div>
    ${list.length ? list.map((n) => {
      const p = state.panels[n.panelId]
      return `<button class="notif" data-notif="${n.id}" data-read="${n.read ? 1 : 0}">
        <span class="notif__top">
          <span class="dot" style="background:${person(n.actor)?.color || '#999'}"></span>
          <span class="notif__who">${esc(person(n.actor)?.name || '알 수 없음')}</span>
          <span class="notif__kind" data-kind="${n.kind}">${KIND[n.kind] || '알림'}</span>
          <span class="notif__where">${p ? esc(`${whereOf(p)} · ${labelOf(p)}`) : '삭제됨'}</span>
          <span class="notif__when">${fmtWhen(n.ts)}</span>
        </span>
        ${esc(notifText(n))}
      </button>`
    }).join('') : '<div class="notifs__empty">받은 알림이 없습니다.</div>'}`)
}

function toast(n) {
  const host = byId('toasts')
  const p = state.panels[n.panelId]
  const el = document.createElement('div')
  el.className = 'toast'
  setHtml(el, `
    <div class="toast__top">
      <span class="dot" style="background:${person(n.actor)?.color || '#999'}"></span>
      <span class="toast__who">${esc(person(n.actor)?.name || '알 수 없음')}</span>
      <span class="notif__kind" data-kind="${n.kind}">${KIND[n.kind] || '알림'}</span>
      <button class="toast__act" data-goto="${n.panelId}">보기</button>
    </div>
    ${p ? `<div class="mono" style="font-size:9.5px;color:#9A9288;margin-bottom:3px">${esc(`${whereOf(p)} · ${labelOf(p)}`)}</div>` : ''}
    ${esc(notifText(n))}`)
  host.appendChild(el)
  while (host.children.length > 3) host.firstChild.remove()
  setTimeout(() => el.remove(), 7000)
}

function announce(text) {
  const live = byId('sr')
  live.textContent = ''
  setTimeout(() => { live.textContent = text }, 60)
}

const LOST = new Map()

function keepLost(panelId, field, text, by) {
  LOST.set(`${panelId}:${field}`, { text, by, ts: now() })
  const who = person(by)?.name || '누군가'
  announce(`${who}이(가) 같은 칸을 함께 고쳤습니다. 내 문장은 그 칸 아래에 남아 있습니다.`)
}

function lostRow(panelId, field) {
  const key = `${panelId}:${field}`
  const l = LOST.get(key)
  if (!l) return ''
  return `<div class="lost">
    <span class="lost__head">${esc(person(l.by)?.name || '누군가')}의 편집이 이 칸을 덮었습니다 — 내가 쓴 문장:</span>
    <span class="lost__text">${esc(l.text)}</span>
    <span class="lost__acts">
      <button class="cmt__resolve" data-lost="${key}" data-lostdo="restore">내 문장으로 되돌리기</button>
      <button class="cmt__resolve" data-lost="${key}" data-lostdo="drop">무시</button>
    </span>
  </div>`
}

const SEEN_KEY = () =>
  `sb.seen.${new URL(location.href).searchParams.get('board') || 'main'}.${me.id}`
let lastVisit = 0
let freshIds = new Set()

function markVisit() {
  try { localStorage.setItem(SEEN_KEY(), String(now())) } catch {}
}

function loadVisit() {
  try { lastVisit = Number(localStorage.getItem(SEEN_KEY())) || 0 } catch { lastVisit = 0 }
  freshIds = new Set(changedSince(state.panels, lastVisit))
}

function renderFresh() {
  const btn = byId('fresh')
  const n = freshIds.size
  btn.hidden = !n
  btn.textContent = n ? `지난 방문 이후 ${n}컷 변경 →` : ''
  btn.title = n ? `${fmtWhen(lastVisit)} 이후에 바뀐 컷으로 이동합니다. 누르면 표시가 사라집니다.` : ''
}

function renderHold() {
  const btn = byId('hold')
  btn.setAttribute('aria-pressed', paused ? 'true' : 'false')
  byId('holdTxt').textContent = paused ? (held.length ? `새 변경 ${held.length} · 적용` : '멈춤') : '실시간'
}

function openViewer(panelId, focusId = null) {
  const p = state.panels[panelId]
  if (!liveVer(p)) return
  viewing = panelId
  selectedId = panelId
  focusCmt = focusId
  cmpVer = null
  pending = { pin: null, mark: [] }
  replyTo = null
  render()
}

function closeViewer() {
  viewing = null
  focusCmt = null
  pending = { pin: null, mark: [] }
  replyTo = null
  render()
}

function renderViewer() {
  const host = byId('viewer')
  if (composing(host)) { imeMissed = true; return }
  const p = state.panels[viewing]
  if (!p || !liveVer(p)) { host.hidden = true; setHtml(host, ''); viewing = null; return }

  const a = document.activeElement
  const keep = host.contains(a) && a.id ? { id: a.id, start: a.selectionStart, end: a.selectionEnd } : null

  const cur = liveVer(p)
  const ver = cur.ver
  const cmts = state.comments.filter((c) => c.panelId === p.id).sort((x, y) => x.ts - y.ts)
  const onNow = cmts.filter((c) => c.onVersion === cur.i + 1)
  const nums = pinOrder(cmts)
  const st = STATUS[p.status]

  const inkOf = (list) => `
    <svg class="vw__ink" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
      ${list.flatMap((c) => (c.mark || []).map((s) =>
        `<path d="${dOf(s)}" fill="none" stroke="var(--stamp-red)" stroke-width="2"
          stroke-linecap="round" vector-effect="non-scaling-stroke"/>`)).join('')}
      ${pending.mark.map((s) => `<path d="${dOf(s)}" fill="none" stroke="var(--tape)" stroke-width="2"
        stroke-linecap="round" vector-effect="non-scaling-stroke"/>`).join('')}
      <path id="vwPend" d="" fill="none" stroke="var(--tape)" stroke-width="2"
        stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </svg>`

  const pinsOf = (list) => `
    <div class="vw__pins">
      ${list.filter((c) => c.pin).map((c) => `
        <button class="vw__pin" data-cmt="${c.id}" data-resolved="${c.resolved ? 1 : 0}"
          data-focus="${focusCmt === c.id ? 1 : 0}"
          style="left:${c.pin.x * 100}%; top:${c.pin.y * 100}%"
          title="${esc(`${person(c.author)?.name || ''} · ${c.body}`)}">${nums.get(c.id) || '•'}</button>`).join('')}
      ${pending.pin ? `<span class="vw__pin vw__pin--new"
        style="left:${pending.pin.x * 100}%; top:${pending.pin.y * 100}%">＋</span>` : ''}
    </div>`

  const cmp = cmpVer !== null && p.versions[cmpVer] && !deadVer(p, p.versions[cmpVer]) ? p.versions[cmpVer] : null
  const stage = cmp
    ? `<div class="vw__cmp">
         <figure class="vw__frame vw__frame--old">
           <img src="${srcOf(cmp)}" alt="v${cmpVer + 1}">
           <figcaption class="mono">v${cmpVer + 1} · ${esc(person(cmp.author)?.name || '')}</figcaption>
         </figure>
         <figure class="vw__frame" data-ink="1">
           <img src="${srcOf(ver)}" alt="v${cur.i + 1}">
           ${inkOf(onNow)}${pinsOf(onNow)}
           <figcaption class="mono">v${cur.i + 1} · 지금</figcaption>
         </figure>
       </div>`
    : `<div class="vw__frame" data-ink="1">
         <img src="${srcOf(ver)}" alt="${esc(labelOf(p))}">
         ${inkOf(onNow)}${pinsOf(onNow)}
       </div>`

  setHtml(host, `
    <div class="vw">
      <header class="vw__bar">
        <span class="vw__no">${esc(`${whereOf(p)} · ${labelOf(p)}`)}</span>
        <span class="stamp stamp--${st.tone}">${esc(st.label)}</span>
        <span class="vw__tools">
          <button class="chip" data-tool="pin" data-on="${tool === 'pin' ? 1 : 0}">핀</button>
          <button class="chip" data-tool="draw" data-on="${tool === 'draw' ? 1 : 0}">그리기</button>
        </span>
        <span class="vw__tools">
          <span class="mono gen__lab">비교</span>
          <button class="chip" data-cmp="" data-on="${cmpVer === null ? 1 : 0}">끄기</button>
          ${p.versions.map((v, i) => i === cur.i || deadVer(p, v) ? '' : `
            <button class="chip" data-cmp="${i}" data-on="${cmpVer === i ? 1 : 0}">v${i + 1}</button>`).join('')}
        </span>
        <button class="btn btn--line" data-vw="close" style="margin-left:auto">닫기</button>
      </header>
      <div class="vw__body">
        <div class="vw__stage">${stage}</div>
        <aside class="vw__side">
          <h2 class="mono h">메모 ${cmts.length ? `<span class="count">${cmts.length}</span>` : ''}</h2>
          ${cmts.length ? threadHtml(cmts, p) : '<p class="why">아직 메모가 없습니다.</p>'}
          ${composerHtml('vwInput', cmts)}
          <p class="why">${tool === 'pin'
            ? '그림을 클릭하면 그 지점에 메모를 달 수 있습니다.'
            : '그림 위에 드래그하면 선이 그려집니다. 메모를 남길 때 함께 붙습니다.'}</p>
          <p class="why">표시는 그때 보던 버전에 달립니다 — 다른 버전의 핀은 그 버전에서 보입니다.</p>
        </aside>
      </div>
    </div>`)
  host.hidden = false

  if (keep) {
    const el = byId(keep.id)
    if (el) { el.focus(); try { el.setSelectionRange(keep.start, keep.end) } catch {  } }
  }
}

function markRead(id) {
  const n = state.notifs.find((x) => x.id === id)
  if (n && !n.read) { n.read = true; readIds.add(id); saveRead() }
}

function renderDetail() {
  const host = byId('detail')
  if (composing(host)) { imeMissed = true; return }
  const p = state.panels[selectedId]
  if (!p) {
    setHtml(host, '<div class="detail detail--empty">구도나 컷을 선택하면 메모·버전·승인이 여기 나옵니다.</div>')
    return
  }

  const a = document.activeElement
  const keep = host.contains(a) && (a.dataset?.field || a.id)
    ? { sel: a.dataset?.field ? `[data-field="${a.dataset.field}"]` : `#${a.id}`, start: a.selectionStart, end: a.selectionEnd }
    : null

  const ch = p.charId ? state.chars[p.charId] : null
  const st = STATUS[p.status]
  const editable = canEditContent(me.role, p)
  const cmts = state.comments.filter((c) => c.panelId === p.id).sort((x, y) => x.ts - y.ts)
  const logs = state.events.filter((e) => e.panelId === p.id).sort((x, y) => y.ts - x.ts).slice(0, 8)
  const cur = liveVer(p)
  const ver = cur?.ver
  const live = (p.versions || []).filter((v) => !deadVer(p, v))
  const anchor = refOf(ch)
  const busyBy = genBy(p)

  const lockNote = (field) => {
    const l = lockedBy(p.id, field)
    return l ? `<span class="lock" style="background:${l.color}">${esc(l.name)} 편집 중</span>` : ''
  }
  const dis = (field) => (editable ? '' : 'disabled')

  const o = optsFor(p)
  const refs = refChoices(p)
  if (!refs.some((r) => r.key === o.ref)) o.ref = 'none'
  const hint = !canGen ? '' : {
    warm: '모델을 올리는 중입니다. 잠시 뒤 다시 눌러주세요.',
    down: '생성 서버에 연결되지 않습니다. 인스턴스가 켜져 있는지 확인해주세요.',
    error: '생성 서버에 문제가 있습니다.',
  }[gpu.state] || ''

  const picked = modelOf(pickedModel) || modelOf(gpu.resident)
  const modelNote = !picked ? '' : `
    <p class="why">지금 그리는 모델: ${esc(picked.label)} — ${esc(picked.note)}.${
  picked.id === gpu.resident ? ' 위쪽 모델 칩에서 바꿉니다.'
    : ` 아직 올라오지 않았습니다(약 ${mins(picked.wait)}분).`}</p>`

  const genBlock = !canMakeArt(me.role) ? `
    <h2 class="mono h" style="margin-top:22px">이미지</h2>
    <p class="why">그림은 아티스트와 기획이 만듭니다. 필요한 그림이 있으면 아래 메모로 남겨주세요.</p>` : `
    <h2 class="mono h" style="margin-top:22px">이미지 만들기</h2>
    <label class="f">
      <span class="f__label"><span class="mono">생성 지시</span>
        ${o.prompt !== null ? '<button class="mini" data-do="autofill">작업 내용으로 다시 채우기</button>' : ''}</span>
      <textarea rows="3" id="genPrompt" placeholder="어떤 그림이 필요한지 적어주세요. 한국어로 써도 됩니다." ${editable ? '' : 'disabled'}>${esc(o.prompt ?? autoPrompt(p))}</textarea>
    </label>
    <div class="gen__row">
      <span class="mono gen__lab">기반 이미지</span>
      ${refs.map((r) => `<button class="chip" data-ref="${r.key}" data-on="${o.ref === r.key ? 1 : 0}" ${editable ? '' : 'disabled'}>${esc(r.label)}</button>`).join('')}
    </div>
    ${modelNote}
    ${o.ref === 'none' ? '' : picked && picked.strength === false ? `
      <p class="why">${esc(picked.label)}은 기반 이미지를 지우고 다시 그리지 않습니다 — 조건으로 받아서 인물을 그대로 살립니다. 그래서 변형 정도가 없습니다.</p>` : `
      <div class="gen__row">
        <span class="mono gen__lab">변형 정도</span>
        <input type="range" id="genStrength" min="0.75" max="0.95" step="0.1" value="${o.strength}" ${editable ? '' : 'disabled'}>
        <span class="mono gen__val">${morph(o.strength)}</span>
      </div>
      <p class="why">‘선 그대로’는 올린 스케치를 거의 유지하고, ‘새로 그리기’는 구도까지 모델이 다시 잡습니다.</p>`}
    <div class="acts">
      <button class="btn btn--line" data-do="upload" ${editable ? '' : 'disabled'}>스케치 올리기</button>
      <button class="btn btn--solid" data-do="generate" ${editable && !busyBy ? '' : 'disabled'}>
        ${busyBy ? `${esc(busyBy.name)} 생성 중…` : o.ref === 'none' ? 'AI로 생성' : '이 이미지를 기반으로 생성'}
      </button>
    </div>
    ${p.genError ? `<p class="why why--bad">${esc(p.genError)}</p>` : hint ? `<p class="why">${esc(hint)}</p>` : ''}`

  const rmWhy = !ver ? '먼저 이미지가 있어야 합니다'
    : !ver.vid ? '옛 캐시의 버전입니다 — 새로고침하면 지울 수 있습니다'
      : !editable ? (p.status === 'approved' ? '승인된 컷은 먼저 승인을 해제해야 합니다' : `${ROLES[me.role]}는 지울 수 없습니다`)
        : ''

  const actionBtns = Object.keys(ACTIONS).filter((x) => x !== 'assign').map((x) => {
    const c = canTransition(me.role, p.status, x)
    const cls = x === 'approve' ? 'btn--approve' : x === 'request_changes' ? 'btn--reject' : 'btn--line'
    return `<button class="btn ${cls}" data-act="${x}" ${c.ok ? '' : 'disabled'} title="${c.ok ? '' : esc(c.reason)}">${ACTIONS[x].label}</button>`
  }).join('')

  const poseFields = `
    <h2 class="mono h" style="margin-top:20px">기준 이미지</h2>
    <div class="anchor">
      ${anchor ? `<img src="${anchor.src}" alt="">
        <span class="anchor__txt"><b>${esc(anchor.pose || '구도')} v${anchor.n}</b><br>이 인물의 모든 구도 생성이 이 이미지를 참조합니다.</span>`
        : '<span class="anchor__none">아직 기준 이미지가 없습니다. 마음에 드는 버전을 기준으로 잡으면 다음 구도가 같은 인물로 나옵니다.</span>'}
    </div>
    <div class="acts" style="margin-top:8px">
      <button class="btn btn--line" data-do="pin" ${ver ? '' : 'disabled'} title="${ver ? '' : '먼저 이미지가 있어야 합니다'}">이 버전을 기준으로</button>
    </div>

    <label class="f">
      <span class="f__label"><span class="mono">구도</span>${lockNote('pose')}</span>
      <input type="text" data-field="pose" value="${esc(p.pose || '')}" ${dis('pose')}>
    </label>
    ${lostRow(p.id, 'pose')}

    <label class="f">
      <span class="f__label"><span class="mono">작업 지시</span>${lockNote('action')}</span>
      <textarea rows="3" data-field="action" placeholder="이 구도에서 무엇을 보여줄지" ${dis('action')}>${esc(p.action)}</textarea>
    </label>
    ${lostRow(p.id, 'action')}`

  const cutFields = `
    <div class="f--row">
      <label class="f">
        <span class="f__label"><span class="mono">씬</span>${lockNote('scene')}</span>
        <input type="text" data-field="scene" value="${esc(p.scene || '')}" placeholder="씬 1 · 새벽 거리" ${dis('scene')}>
      </label>
      <label class="f f--narrow">
        <span class="f__label"><span class="mono">길이(초)</span>${lockNote('secs')}</span>
        <input type="number" data-field="secs" min="0" step="0.5" value="${p.secs ?? ''}" ${dis('secs')}>
      </label>
    </div>
    ${lostRow(p.id, 'scene')}
    <p class="why">같은 씬 이름을 붙인 이웃한 컷이 한 씬으로 묶입니다. 길이는 타임라인 폭이 됩니다.</p>

    <label class="f">
      <span class="f__label"><span class="mono">등장 인물</span></span>
      <div class="cast">
        ${charList().length
          ? charList().map((c) => `<button class="cast__chip" data-cast="${c.id}" data-on="${(p.cast || []).includes(c.id) ? 1 : 0}" ${editable ? '' : 'disabled'}>${esc(c.name)}</button>`).join('')
          : '<span class="anchor__none">인물을 먼저 만들면 컷에 붙일 수 있습니다.</span>'}
      </div>
    </label>

    <label class="f">
      <span class="f__label"><span class="mono">화면 설명</span>${lockNote('action')}</span>
      <textarea rows="3" data-field="action" ${dis('action')}>${esc(p.action)}</textarea>
    </label>
    ${lostRow(p.id, 'action')}

    <label class="f">
      <span class="f__label"><span class="mono">대사 / 자막</span>${lockNote('dialogue')}</span>
      <textarea rows="2" data-field="dialogue" ${dis('dialogue')}>${esc(p.dialogue || '')}</textarea>
    </label>
    ${lostRow(p.id, 'dialogue')}

    <label class="f">
      <span class="f__label"><span class="mono">카메라</span>${lockNote('camera')}</span>
      <input type="text" data-field="camera" value="${esc(p.camera || '')}" ${dis('camera')}>
    </label>
    ${lostRow(p.id, 'camera')}`

  setHtml(host, `
    <div class="detail">
      <div class="detail__head">
        <span class="detail__no">${esc(ch ? `${ch.name} · ${p.pose || '구도'}` : `CUT ${pad(cutNo(p))}`)}</span>
        <span class="detail__status" data-tone="${st.tone}">${esc(st.label)}</span>
      </div>
      ${editable ? '' : `<p class="why why--why">${p.status === 'approved'
        ? '승인된 컷입니다 — 내용을 고치려면 먼저 승인을 해제해야 합니다.'
        : `${ROLES[me.role]}는 내용을 고칠 수 없습니다. 의견은 아래 메모로 남겨주세요.`}</p>`}

      <label class="f">
        <span class="f__label"><span class="mono">담당</span></span>
        <select data-field="assignee" ${ACTIONS.assign.roles.includes(me.role) ? '' : 'disabled'}>
          ${assignOpts(p.assignee)}
        </select>
      </label>

      ${ch ? poseFields : cutFields}

      ${genBlock}

      <h2 class="mono h" style="margin-top:22px">버전 ${live.length ? `<span class="count">${live.length}</span>` : ''}
        <button class="mini" data-do="viewer" ${ver ? '' : 'disabled'}
          title="${ver ? '' : '먼저 이미지가 있어야 합니다'}">크게 보기 · 핀 메모</button>
        <button class="mini" data-do="rmver" ${rmWhy ? 'disabled' : ''}
          title="${esc(rmWhy || `v${cur.i + 1}을 보드에서 지웁니다`)}">이 버전 지우기</button></h2>
      ${live.length ? `<ul class="vers">${p.versions.map((v, i) => deadVer(p, v) ? '' : `
        <li><button class="ver" data-ver="${i}" data-current="${i === cur?.i ? 1 : 0}">
          <img class="ver__thumb" src="${srcOf(v)}" alt="" loading="lazy">
          <span>v${i + 1} · ${esc(person(v.author)?.name || '알 수 없음')}
            <br><span class="ver__meta">${esc(v.gen ? `${v.gen.model} · seed ${v.gen.seed} · ${(v.gen.ms / 1000).toFixed(1)}초` : v.name || fmtWhen(v.ts))}</span></span>
          <span class="ver__src">${v.source === 'ai' ? 'AI' : v.source === 'sketch' ? 'AI · 스케치' : '업로드'}</span>
        </button></li>`).join('')}</ul>`
      : `<p class="why">${p.versions?.length ? '이미지를 모두 지웠습니다. 다시 만들면 v번호는 이어서 붙습니다.' : '아직 이미지가 없습니다.'}</p>`}

      <h2 class="mono h" style="margin-top:22px">메모 ${cmts.length ? `<span class="count">${cmts.length}</span>` : ''}</h2>
      ${cmts.length ? threadHtml(cmts, p) : ''}
      ${composerHtml('cmtInput', cmts)}
      <p class="why" id="cmtWhy"></p>

      <h2 class="mono h" style="margin-top:22px">기록</h2>
      ${logs.length ? `<ul class="log">${logs.map((e) => `
        <li>${new Date(e.ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
        · <b>${esc(person(e.actor)?.name || '?')}</b> ${esc(STATUS[e.from]?.label || e.from)} → ${esc(STATUS[e.to]?.label || e.to)}</li>`).join('')}</ul>`
      : '<p class="why">아직 기록이 없습니다.</p>'}

      <div class="acts" style="margin-top:22px; border-top:1px solid var(--edge); padding-top:16px">
        ${actionBtns}
      </div>
      <p class="why" id="actWhy"></p>
    </div>`)

  if (keep) {
    const el = host.querySelector(keep.sel)
    if (el && !el.disabled) {
      el.focus()
      try { el.setSelectionRange(keep.start, keep.end) } catch {  }
    }
  }
}

function renderMe() {
  byId('meDot').style.background = me.color
  byId('meName').textContent = me.name
  byId('meRole').textContent = ROLES[me.role] || me.role
  const adm = byId('adminBtn')
  adm.hidden = !canSeeAdmin(me.role)
  if (adm.hidden) openAdmin(false)
  const pl = byId('planBtn')
  pl.hidden = !canPlan(me.role)
  if (pl.hidden) openPlan(false)
}

function renderGpu() {
  const el = byId('gpu')
  el.hidden = !canGen
  if (!canGen) return
  el.dataset.state = gpu.state
  byId('gpuText').textContent = gpu.text
  const may = gpuModels.length > 1 && canMakeArt(me.role)
  el.disabled = !may
  el.title = may ? '생성 모델을 고릅니다' : gpu.hint || ''
  if (!may) toggleGpuMenu(false)
  renderGpuMenu()
}

function renderGpuMenu() {
  const box = byId('gpuMenu')
  if (box.hidden) return
  setHtml(box, `
    <div class="menu__head">
      <b>생성 모델</b>
      <span>GPU 한 장에 한 벌만 올라갑니다</span>
    </div>
    ${gpuModels.map((m) => `<button data-model="${m.id}" data-on="${(pickedModel || gpu.resident) === m.id ? 1 : 0}"
      title="${esc(m.note)}">${esc(m.label)}<span class="mono">${
    m.id === gpu.resident ? '지금 올라옴' : m.id === gpu.loading ? '올리는 중…' : `약 ${mins(m.wait)}분`}</span></button>`).join('')}
    <p class="menu__note">${pickError ? esc(pickError) : '바꾸면 팀 전원의 생성이 그동안 멈춥니다.'}</p>`)
}
byId('gpuMenu').addEventListener('click', (e) => {
  const id = e.target.closest('[data-model]')?.dataset.model
  if (id) pickModel(id)
})

function toggleGpuMenu(open) {
  const box = byId('gpuMenu')
  const show = open === undefined ? box.hidden : !!open
  box.hidden = !show
  byId('gpu').setAttribute('aria-expanded', String(show))
  renderGpuMenu()
}
byId('gpu').addEventListener('click', () => toggleGpuMenu())

function renderMenu() {
  const box = byId('meMenu')
  if (box.hidden) return
  setHtml(box, `
    <div class="menu__head">
      <b>${esc(me.name)}</b>
      <span>${esc([ROLES[me.role] || me.role, me.email].filter(Boolean).join(' · '))}</span>
    </div>
    <button data-menu="tab">다른 계정으로 새 탭 열기</button>
    ${configured ? '' : ROSTER.map((u) => `<button data-who="${u.id}">${esc(u.name)} · ${ROLES[u.role]}로 보기</button>`).join('')}
    <button data-menu="reset" data-danger="1">보드 처음 상태로</button>
    ${configured ? '<button data-menu="logout" data-danger="1">로그아웃</button>' : ''}`)
}

function toggleMenu(open) {
  const box = byId('meMenu')
  box.hidden = open === undefined ? !box.hidden : !open
  byId('meChip').setAttribute('aria-expanded', String(!box.hidden))
  renderMenu()
}
byId('meChip').addEventListener('click', () => toggleMenu())
document.addEventListener('click', (e) => {
  const pop = e.target.closest('.pop')
  if (!byId('meMenu').hidden && !pop?.contains(byId('meMenu'))) toggleMenu(false)
  if (!byId('gpuMenu').hidden && !pop?.contains(byId('gpuMenu'))) toggleGpuMenu(false)
})

byId('meMenu').addEventListener('click', (e) => {
  const who = e.target.closest('[data-who]')?.dataset.who
  const what = e.target.closest('[data-menu]')?.dataset.menu
  if (who) {
    me = person(who)
    sessionStorage.setItem('sb.me', me.id)
    loadRead()
    beat()
  } else if (what === 'tab') {
    const board = new URL(location.href).searchParams.get('board')
    const as = configured ? '' : `?as=${ROSTER[(ROSTER.findIndex((u) => u.id === me.id) + 1) % ROSTER.length].role}`
    window.open(`${location.pathname}${as}${board ? `${as ? '&' : '?'}board=${board}` : ''}`, '_blank')
  } else if (what === 'reset') {
    if (!confirm('보드를 처음 상태로 되돌립니다. 접속한 모든 사람에게 적용됩니다. 계속할까요?')) return
    emit({ kind: 'board.reset' })
    for (const op of seedOps(now() + 1, uid())) push(op)
    pickView()
    save()
  } else if (what === 'logout') {
    net?.sendPresence({ ...me, left: true })
    logout()
    location.reload()
    return
  } else return
  toggleMenu(false)
  render()
})

byId('bell').addEventListener('click', () => {
  const box = byId('notifs')
  box.hidden = !box.hidden
  byId('bell').setAttribute('aria-expanded', String(!box.hidden))
  renderNotifs()
})
document.addEventListener('click', (e) => {
  if (byId('notifs').hidden || e.target.closest('.bellwrap')) return
  byId('notifs').hidden = true
  byId('bell').setAttribute('aria-expanded', 'false')
})
byId('notifs').addEventListener('click', (e) => {
  if (e.target.closest('[data-readall]')) {
    for (const n of myNotifs()) { n.read = true; readIds.add(n.id) }
    saveRead()
    renderBell(); renderNotifs()
    return
  }
  const id = e.target.closest('[data-notif]')?.dataset.notif
  if (!id) return
  const n = state.notifs.find((x) => x.id === id)
  markRead(id)
  byId('notifs').hidden = true
  byId('bell').setAttribute('aria-expanded', 'false')
  if (n) goTo(n.panelId)
  else render()
})
byId('toasts').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-goto]')
  if (!btn) return
  btn.closest('.toast')?.remove()
  goTo(btn.dataset.goto)
})

function navClick(e) {
  const btn = e.target.closest('[data-char],[data-ep]')
  if (!btn) return
  if ('ep' in btn.dataset) setEp(btn.dataset.ep || null)
  else setView(btn.dataset.char || null)
  render()
}
byId('charNav').addEventListener('click', navClick)
byId('boardNav').addEventListener('click', navClick)
byId('newChar').addEventListener('click', addChar)

const laterChar = debounceBy(160)
const patchChar = (field, value) => {
  if (!viewChar) return
  const ch = state.chars[viewChar]
  if (ch) ch[field] = value
  renderHeader()
  const charId = viewChar
  laterChar(`${charId}:${field}`, () => emit({ kind: 'char.patch', charId, fields: { [field]: value } }))
}
byId('nameIn').addEventListener('input', (e) => patchChar('name', e.target.value))
byId('briefIn').addEventListener('input', (e) => patchChar('brief', e.target.value))

let scenTimer = null
byId('scenario').addEventListener('input', (e) => {
  const text = e.target.value
  const epId = viewEp
  const target = epId ? state.eps[epId] : state.board
  if (!target) return
  target.scenario = text
  clearTimeout(scenTimer)
  scenTimer = setTimeout(() => emit(epId
    ? { kind: 'ep.patch', epId, fields: { scenario: text } }
    : { kind: 'board.patch', fields: { scenario: text } }), 200)
})

byId('breakdown').addEventListener('click', () => {
  if (viewChar) return
  const cuts = splitScenario(byId('scenario').value)
  if (!cuts.length) return alert('시나리오를 먼저 넣어주세요.')
  if (cutsOf(viewEp).length && !confirm(`컷 ${cuts.length}개를 뒤에 추가합니다. 계속할까요?`)) return
  let key = cutsOf(viewEp).at(-1)?.orderKey ?? null
  const ops = []
  for (const cut of cuts) {
    key = orderKeyBetween(key, null)
    ops.push({
      kind: 'panel.add',
      panel: {
        id: uid(), charId: null, orderKey: key, ...(viewEp ? { epId: viewEp } : {}),
        action: cut.action, dialogue: cut.dialogue, camera: cut.camera, cast: [],
        status: 'draft', assignee: null, versions: [], current: -1, generating: false,
      },
    })
  }
  emitMany(ops)
})

const board = byId('board')
board.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]')?.dataset.open
  if (open) { openViewer(open); return }
  const card = e.target.closest('.cut')
  if (!card) return
  selectCut(card.dataset.id)
})

function selectCut(id) {
  selectedId = id
  freshIds.delete(id)
  renderBoard(); renderDetail(); renderTime(); renderFresh()
  beat()
}

board.addEventListener('keydown', (e) => {
  const card = e.target.closest?.('.cut')
  if (!card || e.metaKey || e.ctrlKey || e.altKey) return
  const list = viewPanels()
  const i = list.findIndex((p) => p.id === card.dataset.id)
  const go = (n) => {
    const next = list[n]
    if (!next) return
    e.preventDefault()
    selectCut(next.id)
    board.querySelector(`[data-id="${next.id}"]`)?.focus()
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return go(i + 1)
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') return go(i - 1)
  if (e.key === 'Home') return go(0)
  if (e.key === 'End') return go(list.length - 1)
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    selectCut(card.dataset.id)
    openViewer(card.dataset.id)
    return
  }
  const act = { a: 'approve', A: 'approve', r: 'request_changes', R: 'request_changes', s: 'submit', S: 'submit' }[e.key]
  if (!act) return
  e.preventDefault()
  selectCut(card.dataset.id)
  const p = state.panels[card.dataset.id]
  if (act === 'request_changes') {
    byId('cmtInput')?.focus()
    announce('수정 요청에는 이유가 필요합니다. 메모를 적고 수정 요청을 눌러주세요.')
    return
  }
  const r = transition(p, act)
  announce(r.ok ? `${labelOf(p)} · ${ACTIONS[act].label}` : r.reason)
})

byId('peers').addEventListener('click', (e) => {
  const id = e.target.closest('[data-jump]')?.dataset.jump
  if (id) goTo(id)
})

byId('timeline').addEventListener('click', (e) => {
  const id = e.target.closest('[data-goto]')?.dataset.goto
  if (id) goTo(id)
})

let dragId = null
board.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.cut')
  if (!card) return
  dragId = card.dataset.id
  card.dataset.dragging = '1'
  e.dataTransfer.effectAllowed = 'move'
})
board.addEventListener('dragend', () => {
  board.querySelectorAll('.cut').forEach((c) => { c.dataset.dragging = '0'; delete c.dataset.drop })
  dragId = null
})
board.addEventListener('dragover', (e) => {
  if (!dragId) return
  e.preventDefault()
  const card = e.target.closest('.cut')
  board.querySelectorAll('.cut').forEach((c) => delete c.dataset.drop)
  if (!card || card.dataset.id === dragId) return
  const r = card.getBoundingClientRect()
  card.dataset.drop = e.clientX < r.left + r.width / 2 ? 'before' : 'after'
})
board.addEventListener('drop', (e) => {
  if (!dragId) return
  e.preventDefault()
  const card = e.target.closest('.cut')
  const list = viewPanels()
  let to = list.length
  if (card && card.dataset.id !== dragId) {
    const idx = list.findIndex((p) => p.id === card.dataset.id)
    const after = card.dataset.drop === 'after'
    const fromIdx = list.findIndex((p) => p.id === dragId)
    to = idx + (after ? 1 : 0) - (fromIdx < idx ? 1 : 0)
  }
  movePanel(dragId, to)
})

const pane = byId('boardPane')
let cursorTimer = 0
pane.addEventListener('mousemove', (e) => {
  const t = now()
  if (t - cursorTimer < 120) return
  cursorTimer = t
  const r = pane.getBoundingClientRect()
  cursor = { x: Math.round(e.clientX - r.left + pane.scrollLeft), y: Math.round(e.clientY - r.top + pane.scrollTop) }
  beat()
})
pane.addEventListener('mouseleave', () => { cursor = null; beat() })

byId('mine').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-goto]')
  if (btn) goTo(btn.dataset.goto)
})

const detail = byId('detail')
const laterField = debounceBy(140)

detail.addEventListener('input', (e) => {
  const p = state.panels[selectedId]
  if (!p) return
  if (e.target.id === 'genPrompt') { optsFor(p).prompt = e.target.value; return }
  if (e.target.id === 'genStrength') {
    optsFor(p).strength = Number(e.target.value)
    e.target.parentElement.querySelector('.gen__val').textContent = `${Math.round(e.target.value * 100)}%`
    return
  }
  if (!e.target.dataset.field) return
  if (e.target.tagName === 'SELECT') return
  const field = e.target.dataset.field
  const value = e.target.type === 'number' ? Number(e.target.value) || 0 : e.target.value
  p[field] = value
  renderBoard()
  if (field === 'scene' || field === 'secs') { renderTime(); renderHeader() }
  const panelId = p.id
  laterField(`${panelId}:${field}`, () => emit({ kind: 'panel.patch', panelId, fields: { [field]: value } }))
})

detail.addEventListener('change', (e) => {
  const p = state.panels[selectedId]
  if (!p || e.target.dataset.field !== 'assignee') return
  emit({ kind: 'panel.patch', panelId: p.id, fields: { assignee: e.target.value || null } })
})

detail.addEventListener('focusin', (e) => {
  if (!e.target.dataset.field || !selectedId) return
  editing = { panelId: selectedId, field: e.target.dataset.field }
  beat()
})
detail.addEventListener('focusout', (e) => {
  if (!e.target.dataset.field) return
  editing = null
  beat()
})

detail.addEventListener('click', async (e) => {
  const p = state.panels[selectedId]
  if (!p) return

  const act = e.target.closest('[data-act]')?.dataset.act
  const doWhat = e.target.closest('[data-do]')?.dataset.do
  const verIdx = e.target.closest('[data-ver]')?.dataset.ver
  const castId = e.target.closest('[data-cast]')?.dataset.cast
  const refKey = e.target.closest('[data-ref]')?.dataset.ref

  const lostBtn = e.target.closest('[data-lost]')
  if (lostBtn) {
    const { lost, lostdo } = lostBtn.dataset
    const saved = LOST.get(lost)
    LOST.delete(lost)
    if (lostdo === 'restore' && saved) {
      const field = lost.slice(lost.lastIndexOf(':') + 1)
      emit({ kind: 'panel.patch', panelId: p.id, fields: { [field]: saved.text } })
    } else renderDetail()
    return
  }

  if (refKey) { optsFor(p).ref = refKey; renderDetail(); return }
  if (doWhat === 'autofill') { optsFor(p).prompt = null; renderDetail(); return }
  if (doWhat === 'viewer') { openViewer(p.id); return }
  if (memoClick(e, p, 'cmtInput')) return

  if (castId) {
    const on = (p.cast || []).includes(castId)
    const next = on ? p.cast.filter((x) => x !== castId) : [...(p.cast || []), castId]
    emit({ kind: 'panel.patch', panelId: p.id, fields: { cast: next } })
    return
  }

  if (act) {
    if (act === 'request_changes') {
      const input = byId('cmtInput')
      if (!input.value.trim()) {
        byId('actWhy').textContent = '수정 요청에는 이유가 필요합니다. 메모를 먼저 적어주세요.'
        input.focus()
        return
      }
      const note = input.value.trim()
      input.value = ''
      transition(p, act, note)
      return
    }
    const r = transition(p, act)
    if (!r.ok) byId('actWhy').textContent = r.reason
    return
  }

  if (doWhat === 'pin') {
    const cur = liveVer(p)
    if (!p.charId || !cur) return
    emit({ kind: 'char.patch', charId: p.charId, fields: { refPanelId: p.id, refN: cur.i + 1 } })
    return
  }

  if (doWhat === 'rmver') {
    const cur = liveVer(p)
    if (!cur || !cur.ver.vid) return
    if (!canEditContent(me.role, p)) {
      byId('actWhy').textContent = p.status === 'approved'
        ? '승인된 컷입니다 — 이미지를 지우려면 먼저 승인을 해제해야 합니다.'
        : `${ROLES[me.role]}는 이미지를 지울 수 없습니다.`
      return
    }
    const n = cur.i + 1
    const onIt = state.comments.filter((c) => c.panelId === p.id && c.onVersion === n).length
    const isAnchor = p.charId && state.chars[p.charId]?.refPanelId === p.id && (state.chars[p.charId]?.refN ?? 1) === n
    const left = (p.versions || []).filter((v) => !deadVer(p, v)).length - 1
    if (!confirm([
      `v${n}을 보드에서 지웁니다. 되돌릴 수 없습니다.`,
      onIt ? `이 버전에 달린 메모 ${onIt}건은 남지만 가리킬 그림이 없어집니다.` : '',
      isAnchor ? '이 인물의 기준 이미지가 없어집니다 — 다음 구도 생성이 얼굴을 참조하지 못합니다.' : '',
      left ? `남는 버전 ${left}개.` : '남는 버전이 없습니다.',
    ].filter(Boolean).join('\n'))) return
    emit({ kind: 'panel.version.remove', panelId: p.id, verId: cur.ver.vid })
    announce(`v${n}을 지웠습니다.${left ? '' : ' 남은 이미지가 없습니다.'}`)
    requestAnimationFrame(() => {
      (detail.querySelector('.ver[data-current="1"]')
        || detail.querySelector('[data-do="generate"]:not([disabled])')
        || detail.querySelector('[data-do="viewer"]'))?.focus()
    })
    return
  }

  if (doWhat === 'upload') {
    const file = byId('file')
    file.onchange = () => { if (file.files[0]) upload(p, file.files[0]) }
    file.click()
    return
  }

  if (doWhat === 'generate') { generate(p); return }

  if (verIdx !== undefined) {
    emit({ kind: 'panel.patch', panelId: p.id, fields: { current: Number(verIdx) } })
  }
})

function memoClick(e, panel, inputId) {
  const tag = e.target.closest('[data-tag]')
  const at = e.target.closest('[data-at]')
  const say = e.target.closest('[data-say]')?.dataset.say
  const replyId = e.target.closest('[data-reply]')?.dataset.reply
  const resolveId = e.target.closest('[data-resolve]')?.dataset.resolve

  if (tag) { insertInto(tag, tag.dataset.tag, true); return true }
  if (at) { insertInto(at, at.dataset.at); return true }
  if (e.target.closest('[data-unreply]')) { replyTo = null; render(); return true }
  if (e.target.closest('[data-unpin]')) { pending = { pin: null, mark: [] }; render(); return true }
  if (replyId) {
    replyTo = replyId
    render()
    byId(inputId)?.focus()
    return true
  }
  if (resolveId) {
    const c = state.comments.find((x) => x.id === resolveId)
    emit({ kind: 'comment.resolve', commentId: resolveId, resolved: !c.resolved })
    return true
  }
  if (say) {
    if (!sayFrom(say, panel)) {
      const why = byId('cmtWhy')
      if (why) why.textContent = '메모 내용을 적어주세요.'
      byId(say)?.focus()
    }
    return true
  }
  return false
}

const viewer = byId('viewer')

viewer.addEventListener('click', (e) => {
  const p = state.panels[viewing]
  if (!p) return

  if (e.target.closest('[data-vw="close"]')) { closeViewer(); return }
  const t = e.target.closest('[data-tool]')?.dataset.tool
  if (t) { tool = t; renderViewer(); return }
  const cmp = e.target.closest('[data-cmp]')
  if (cmp) { cmpVer = cmp.dataset.cmp === '' ? null : Number(cmp.dataset.cmp); renderViewer(); return }

  if (memoClick(e, p, 'vwInput')) return

  const cmtId = e.target.closest('[data-cmt]')?.dataset.cmt
  if (cmtId) {
    focusCmt = focusCmt === cmtId ? null : cmtId
    renderViewer()
    viewer.querySelector(`.cmt[data-cmt="${cmtId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
})

viewer.addEventListener('pointerdown', (e) => {
  const frame = e.target.closest('[data-ink]')
  if (!frame || !state.panels[viewing]) return
  if (e.target.closest('.vw__pin')) return
  e.preventDefault()

  if (tool === 'pin') {
    pending.pin = atPoint(frame, e)
    renderViewer()
    byId('vwInput')?.focus()
    return
  }

  const stroke = []
  pending.mark.push(stroke)
  const live = frame.querySelector('#vwPend')
  frame.setPointerCapture(e.pointerId)

  const push = (ev) => {
    const { x, y } = atPoint(frame, ev)
    const n = stroke.length
    if (n && Math.hypot(x - stroke[n - 2], y - stroke[n - 1]) < 0.006) return
    stroke.push(x, y)
    if (live) live.setAttribute('d', dOf(stroke))
  }
  push(e)

  const end = () => {
    frame.removeEventListener('pointermove', push)
    frame.removeEventListener('pointerup', end)
    frame.removeEventListener('pointercancel', end)
    if (stroke.length < 4) pending.mark.pop()
    renderViewer()
    byId('vwInput')?.focus()
  }
  frame.addEventListener('pointermove', push)
  frame.addEventListener('pointerup', end)
  frame.addEventListener('pointercancel', end)
})

viewer.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'vwInput') sayFrom('vwInput', state.panels[viewing])
})
byId('detail').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'cmtInput' && state.panels[selectedId]) {
    sayFrom('cmtInput', state.panels[selectedId])
  }
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && viewing) return closeViewer()
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (byId('admin').open || byId('plan').open) return
  if (e.key === '?') { byId('keys').showModal(); return }
  if (e.key === 'i' || e.key === 'I') {
    e.preventDefault()
    const box = byId('notifs')
    if (box.hidden) byId('bell').click()
    box.querySelector('.notif, [data-readall]')?.focus()
    return
  }
  if (e.key === 'g' || e.key === 'G') { byId('board').querySelector('.cut')?.focus(); return }
})

byId('hold').addEventListener('click', () => {
  if (paused) return resume()
  paused = true
  renderHold()
  announce('실시간 갱신을 멈췄습니다. 남의 변경은 모아두고, 다시 누르면 적용합니다.')
})

byId('fresh').addEventListener('click', () => {
  const first = [...freshIds][0]
  if (first) return goTo(first)
  freshIds.clear()
  renderFresh()
})

const admin = byId('admin')
byId('adminBtn').addEventListener('click', () => openAdmin(true))
byId('admClose').addEventListener('click', () => openAdmin(false))
admin.addEventListener('close', () => byId('adminBtn').setAttribute('aria-expanded', 'false'))

admin.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab
  const need = e.target.closest('[data-need]')?.dataset.need
  const go = e.target.closest('[data-goto]')?.dataset.goto
  if (tab) { adminTab = tab; renderAdmin() }
  else if (need) { adminNeed = need; renderAdmin() }
  else if (e.target.closest('#admAdd')) addMember()
  else if (go) { openAdmin(false); goTo(go) }
})

admin.addEventListener('change', (e) => {
  const panelId = e.target.dataset.assign
  const userId = e.target.dataset.role
  if (panelId) emit({ kind: 'panel.patch', panelId, fields: { assignee: e.target.value || null } })
  else if (userId) emit({ kind: 'member.role', userId, role: e.target.value })
})

admin.addEventListener('focusout', () => setTimeout(renderAdmin))

const planDlg = byId('plan')
byId('planBtn').addEventListener('click', () => openPlan(true))
byId('planClose').addEventListener('click', () => openPlan(false))
planDlg.addEventListener('close', () => byId('planBtn').setAttribute('aria-expanded', 'false'))

planDlg.addEventListener('input', (e) => {
  const t = e.target
  if (t.id === 'planPrompt') planSpec.prompt = t.value
  else if (t.id === 'planGenre') planSpec.genre = t.value
  else if (t.id === 'planTone') planSpec.tone = t.value
  else if (t.id === 'planSecs') planSpec.secs = Number(t.value)
  else if (t.id === 'planCuts') planSpec.cuts = Number(t.value)
  else if (t.id === 'planNew') planSpec.newChars = Number(t.value)
  else if (t.id === 'planCenter') planSpec.center = t.value
  else if (t.id === 'planKeep') planSpec.useChars = t.checked
})

planDlg.addEventListener('click', (e) => {
  const mode = e.target.closest('[data-mode]')?.dataset.mode
  if (mode) {
    planSpec.mode = mode
    if (mode === 'spin' && !planSpec.center) planSpec.center = charList()[0]?.id ?? null
    if (mode !== 'new') planSpec.useChars = true
    planMsg = ''
    renderPlan()
    return
  }
  if (e.target.closest('#planCancel')) return openPlan(false)
  if (e.target.closest('#planBack')) { planStep = 'form'; planMsg = ''; renderPlan(); return }
  if (e.target.closest('#planAgain')) return runPlan('outline')
  if (e.target.closest('#planApply')) return runPlan('cuts')
  if (e.target.closest('#planGo')) {
    if (planSpec.prompt.trim().length < 8) {
      planMsg = '소재를 한 줄이라도(8자 이상) 적어주세요. 모델이 지어낼 밑동이 필요합니다.'
      return renderPlan()
    }
    runPlan('outline')
  }
})

byId('print').addEventListener('click', () => window.print())

let picking = false

function pickMe() {
  if (claimed) return Promise.resolve()
  picking = true
  const gate = byId('gate')
  setHtml(gate, `
    <div class="gate__card">
      <div class="gate__eyebrow">아침빵집 — 15초 브랜드 필름</div>
      <h2 class="gate__title">누구로 참여하시겠어요?</h2>
      <p class="gate__sub">역할에 따라 할 수 있는 일이 다릅니다. 같은 보드를 함께 보고, 서로의 작업이 실시간으로 보입니다.</p>
      <div class="gate__list">
        ${ROSTER.map((u) => `
          <button class="gate__who" data-who="${u.id}">
            <span class="gate__dot" style="background:${u.color}"></span>
            <span>
              <span class="gate__name">${u.name}</span><br>
              <span class="gate__role">${ROLES[u.role].toUpperCase()}</span>
            </span>
            <span class="gate__job">${u.job}</span>
          </button>`).join('')}
      </div>
    </div>`)
  gate.hidden = false
  gate.querySelector('[data-who]').focus()
  return new Promise((done) => {
    gate.addEventListener('click', (e) => {
      const id = e.target.closest('[data-who]')?.dataset.who
      if (!id) return
      me = person(id)
      sessionStorage.setItem('sb.me', me.id)
      loadRead()
      renderMe()
      gate.hidden = true
      picking = false
      done()
    })
  })
}

function pickView() {
  const savedView = sessionStorage.getItem('sb.view')
  viewChar = savedView === null ? (charList()[0]?.id ?? null) : (savedView || null)
  if (viewChar && !state.chars[viewChar]) viewChar = charList()[0]?.id ?? null
  viewEp = sessionStorage.getItem('sb.ep') || null
  if (viewEp && !state.eps[viewEp]) viewEp = null
  selectedId = viewPanels().find((p) => p.status === 'changes_requested')?.id ?? viewPanels()[0]?.id ?? null

  const linked = location.hash.startsWith('#cut=') && location.hash.slice(5)
  if (linked && state.panels[linked]) {
    const p = state.panels[linked]
    viewChar = p.charId ?? null
    if (!p.charId) viewEp = p.epId ?? null
    selectedId = linked
  }
}

async function boot() {
  if (configured) {
    picking = true
    let s = session()
    if (s && !(await idToken())) s = null
    me = look(s || await showLogin(byId('gate')))
    picking = false
    renderMe()
    pollGpu()
  }
  loadRead()
  net = await connect({
    onOp: recvOp,
    onPresence: recvPresence,
    onStatus: (s) => {
      clearTimeout(linkTimer)
      if (s === 'down') linkTimer = setTimeout(() => { link = 'down'; renderPeers() }, 5000)
      else { link = 'open'; renderPeers() }
    },
    onPending: (n) => { unsent = n; renderPeers() },
    onResync: resync,
  })
  net.setLatency(latency)

  const ops = await net.fetchOps().catch((e) => {
    console.warn('[boot] 로그를 읽지 못했다', e.message)
    return []
  })
  if (ops) {
    replaying = true
    for (const op of ops) recvOp(op)
    replaying = false
  } else {
    load()
  }
  if (!Object.keys(state.panels).length) for (const op of seedOps()) push(op)

  pickView()
  save()
  loadVisit()
  render()
  if (!configured) {
    await pickMe()
    loadVisit()
    render()
  }
  registerMe()
  booted = true
  beat()
}

boot()

window.addEventListener('beforeunload', () => {
  markVisit()
  net?.sendPresence({ ...me, left: true })
})
