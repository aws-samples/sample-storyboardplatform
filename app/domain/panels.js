/*
 * 스토리보드 판 자체의 규칙입니다. 누가 무엇을 할 수 있는지(ROLES·TRANSITIONS),
 * 판을 어떤 순서로 놓는지(orderKey), 진행이 어떻게 보이는지(tally·pace) 입니다.
 * DOM 도 네트워크도 건드리지 않습니다.
 */

import { clip, asList, secsOf } from '../lib/guards.js'
import { josa } from '../lib/josa.js'


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

/** 씬 머리줄 세 가지. 번호가 없으면 나온 순서로 매긴다 */
const SCENE_HEADS = [
  // S#3. 카페 / 밤 · S3 카페 - 밤 · 씬 3. 카페
  [/^(?:s#|s|scene|씬)\s*#?\s*(\d+)\s*[.)]?\s*(.*)$/i, (m) => ({ no: Number(m[1]), rest: m[2] })],
  // INT. 카페 - NIGHT · EXT. 골목 - DAY · I/E. 차 안
  [/^(?:int|ext|i\/e|int\.?\/ext)\.?\s*[-–—]?\s*(.*)$/i, (m) => ({ no: 0, rest: m[1] })],
  // [씬 3 - 빵집]
  [/^\[\s*(?:씬|scene|s)?\s*(\d+)?\s*[-–—]?\s*([^\]]*)\]$/i, (m) => ({ no: Number(m[1]) || 0, rest: m[2] })],
]

/** 씬이 아니고 컷도 아닌 줄. 형식 표시라서 버린다 */
const SCRIPT_NOISE = /^(?:fade\s*(?:in|out|to)|cut\s*to|dissolve|smash\s*cut|암전|페이드)\b/i
/** 등장인물 목록 줄. 이름 줄(NAME_LINE)보다 먼저 봐야 한다 */
const SCRIPT_ROSTER = /^(?:등장인물|등장|인물|cast)\s*[:：]\s*(.*)$/i
/** 가온: 대사 — 이름에 문장부호가 없어야 한다. 「그는 말했다: …」 를 대사로 읽지 않으려고 */
const NAME_LINE = /^([^:：.!?…]{1,16})[:：]\s*(.+)$/
/** (가온, 노을) 한 줄 — webdrama 가 씬 머리줄 다음에 붙이는 등장 표시 */
const PARENS_ONLY = /^\(([^)]+)\)$/

/**
 * 컷 수 상한. 대본 한 편을 붙였을 때 컷이 끝없이 늘지 않게 끊는다.
 *
 * 산문 쪽(splitScenario)의 기본값 12 보다 큰 이유는 정형 대본은 한 편이 통째로 들어오기
 * 때문이다. 화면이 산문에도 이 값을 넘겨 쓴다 — 같은 판에 들어가는 컷의 상한이 붙여 넣은
 * 글의 모양에 따라 달라질 이유가 없다(board.js 의 breakdown).
 */
export const CUT_MAX = 48

/*
 * 컷 길이 어림. 한국어 대사는 초당 5자쯤 읽힌다. 지문만 있는 컷은 2초로 둔다
 * (아래 secsOf 의 기본값과 같은 값). 어디까지나 어림이라 컷마다 손으로 고치게 둔다.
 */
const CHARS_PER_SEC = 5
const guessSecs = (dialogue) => (dialogue
  ? Math.min(12, Math.max(1.5, Math.round((dialogue.length / CHARS_PER_SEC) * 2) / 2))
  : 2)

const pad2 = (n) => String(n).padStart(2, '0')
/** 이름 뒤의 지시를 뗀다. 「가온 (놀라며)」 → 「가온」 */
const bareName = (s) => String(s).replace(/[(（][^)）]*[)）]/g, '').trim()
const nameList = (s) => String(s).split(/[,，·/]/).map(bareName).filter(Boolean).slice(0, 8)

/** 씬 하나에 허용하는 글자 수. 넘으면 문장 경계에서 끊는다 */
const SCENE_CHARS = 150
/** 시나리오 전체 글자 수 상한. 시나리오 칸은 읽고 고치는 자리라 길면 쓸모가 없다 */
const SCENARIO_CHARS = 1500

/** 문장 경계에서 자른다. 자를 자리가 없으면 그냥 끊고 줄임표를 붙인다 */
function clipAt(text, max) {
  const s = String(text || '').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return stop > max * 0.4 ? cut.slice(0, stop + 1) : `${cut.trim()}…`
}

/*
 * 씬 이름 두 개가 같은 씬을 가리키는지 견주는 열쇠.
 *
 * 씬 이름은 두 군데서 온다. 키비주얼 화면은 대본 슬러그를 읽어 "S01 카페 · 밤" 으로
 * 붙이고(app/key-visual.js 의 opsForBoard), 보드에서 손으로 적은 컷은 "씬 1 · 새벽 거리"
 * 다. 글자로 견주면 이 둘은 남남이지만 사람이 보면 같은 첫 씬이다. 그래서 번호가
 * 읽히면 번호만 본다. 번호가 없으면 이름을 통째로 본다.
 */
export function sceneKey(name) {
  const t = String(name || '').trim().replace(/\s+/g, ' ')
  const m = t.match(/^(?:s|scene|씬)\s*#?\s*0*(\d+)/i)
  return m ? `s${Number(m[1])}` : t.toLowerCase()
}

/**
 * 씬 이름을 번호와 나머지로 가른다. 카드와 씬 머리줄에서 번호를 굵게 세우려고 쓴다.
 *
 *   "S01 카페 · 밤"      → {no: 'S01', where: '카페 · 밤'}
 *   "씬 1 · 새벽 거리"    → {no: '씬 1', where: '새벽 거리'}
 *   "골목"               → {no: '',     where: '골목'}
 */
export function sceneMeta(name) {
  const t = String(name || '').trim().replace(/\s+/g, ' ')
  const m = t.match(/^((?:s|scene|씬)\s*#?\s*\d+)\.?\s*[·\-–]?\s*(.*)$/i)
  return m ? { no: m[1], where: m[2].trim() } : { no: '', where: t }
}

/**
 * 정형 대본을 컷으로 나눈다.
 *
 * 씬 이름은 키비주얼 화면이 붙이는 모양(`S01 카페 · 밤`)으로 맞춘다. 그래야 붙여 넣은
 * 대본의 컷과 키비주얼이 그린 씬 그림이 같은 씬으로 묶인다 (아래 sceneKey).
 *
 * 컷 경계는 대사다. 대사 앞에 쌓인 지문은 그 대사 컷의 지문이 된다. 대사가 없는 씬은
 * 씬 하나가 컷 하나다. 우리 대본화 프롬프트가 「한 동작을 한 줄로」 쓰게 하므로 줄마다
 * 컷을 세우면 되돌려 붙일 때 컷이 열 배로 늘어난다.
 *
 * @param {string} text - 붙여 넣은 대본
 * @returns {?{cuts: Array<{scene, action, dialogue, camera, cast: string[], secs: number}>,
 *   names: string[]}} 대본으로 보이지 않으면 null
 */
export function splitScript(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')

  const head = (raw) => {
    const t = raw.trim()
    if (!t || SCRIPT_NOISE.test(t)) return null
    for (const [re, take] of SCENE_HEADS) {
      const m = t.match(re)
      // 「INT.」 계열은 뒤에 장소가 있어야 씬으로 본다. 「Intro」 같은 낱말을 막는다
      if (m && take(m).rest.trim()) return take(m)
    }
    return null
  }

  const cuts = []
  const names = new Set()
  let scene = null
  let sceneNo = 0
  let roster = []
  let pending = []

  const flush = (dialogue = '', who = null) => {
    const action = pending.join(' ').trim()
    pending = []
    // 첫 씬 머리줄 앞의 것은 제목이나 표지다. 컷이 아니다
    if (!scene) return
    if (!action && !dialogue) return
    if (cuts.length >= CUT_MAX) return
    const cast = who ? [who] : roster.slice()
    cuts.push({
      scene: scene || '',
      action,
      dialogue,
      camera: CAMERA_HINTS.find(([re]) => re.test(`${action} ${dialogue}`))?.[1] || (dialogue ? 'MS' : 'WS'),
      cast,
      secs: guessSecs(dialogue),
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const t = raw.trim()
    if (!t) continue

    const h = head(raw)
    if (h) {
      flush()
      sceneNo = h.no || sceneNo + 1
      // 장소와 시간을 가른다. 「카페 / 밤」 「카페 - NIGHT」 「카페 · 밤」 모두 같게 본다
      const [place, ...rest] = h.rest.split(/\s*[/·|]\s*|\s+[-–—]\s+/)
      const time = rest.join(' ').trim()
      scene = `S${pad2(sceneNo)} ${place.trim()}${time ? ` · ${time}` : ''}`.trim()
      roster = []
      continue
    }
    if (SCRIPT_NOISE.test(t)) continue

    const rost = t.match(SCRIPT_ROSTER) || (pending.length === 0 && t.match(PARENS_ONLY))
    if (rost) {
      roster = nameList(rost[1])
      for (const n of roster) names.add(n)
      continue
    }

    const said = t.match(NAME_LINE)
    if (said) {
      const who = bareName(said[1])
      if (who) names.add(who)
      flush(said[2].trim(), who || null)
      continue
    }

    /*
     * film 의 대사: 이름만 한 줄에 있고 그 아래 들여쓴 줄이 대사다. 이름 줄은 짧고
     * 문장부호로 끝나지 않는다. localScript 가 내는 모양이라 되돌려 붙이는 길이 열린다.
     */
    const next = lines[i + 1]
    if (/^\s{2,}\S/.test(raw) && next && /^\s{2,}\S/.test(next)
      && t.length <= 24 && !/[.!?…,]$/.test(t)) {
      const who = bareName(t)
      if (who) names.add(who)
      const say = []
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) say.push(lines[++i].trim())
      flush(say.join(' '), who || null)
      continue
    }

    pending.push(t)
  }
  flush()

  // 씬 머리줄이 하나도 없었으면 대본이 아니다. 산문으로 되돌려 준다
  if (!scene || !cuts.length) return null
  return { cuts, names: [...names] }
}

/**
 * 대본을 시나리오 산문으로 줄인다.
 *
 * @param {string} text - 대본 원문
 * @param {object} [opts]
 * @param {number} [opts.max=1500] 전체 글자 수 상한
 * @returns {string} 씬마다 한 문단인 시나리오. 대본으로 안 읽히면 빈 문자열
 */
export function scenarioFromScript(text, opts = {}) {
  const got = splitScript(text)
  if (!got) return ''
  const max = Number(opts.max) > 0 ? Number(opts.max) : SCENARIO_CHARS

  // 씬 번호가 같은 컷을 한 문단으로 모은다 (sceneKey)
  const scenes = []
  for (const cut of got.cuts) {
    const key = sceneKey(cut.scene)
    const last = scenes.at(-1)
    if (last && last.key === key) {
      if (cut.action) last.action.push(cut.action)
      if (cut.dialogue) last.said.push({ who: cut.cast[0] || '', line: cut.dialogue })
      continue
    }
    scenes.push({
      key,
      name: cut.scene,
      action: cut.action ? [cut.action] : [],
      said: cut.dialogue ? [{ who: cut.cast[0] || '', line: cut.dialogue }] : [],
    })
  }

  const out = []
  let used = 0
  for (const s of scenes) {
    const say = s.said[0]
    const body = clipAt([
      s.action.join(' '),
      // 씬의 뜻을 쥐고 있는 대사 한 줄만 남긴다. 여럿이면 첫 줄이 씬을 여는 말이다
      say ? `${say.who ? `${say.who}${josa(say.who, '이', '가')} ` : ''}「${clipAt(say.line, 40)}」라고 말한다.` : '',
    ].filter(Boolean).join(' '), SCENE_CHARS)
    const para = `${s.name}\n${body || '(지문 없음)'}`
    // 상한을 넘기면 거기서 멈춘다. 반쪽 문단을 남기지 않는다
    if (used + para.length > max) break
    out.push(para)
    used += para.length + 2
  }
  return out.join('\n\n')
}

/**
 * 산문을 컷으로 쪼갠다. 빈 줄이 경계고, 한 문단 안에서도 문장 끝에서 갈라진다.
 *
 * @param {string} text
 * @param {number} [max] - 컷 수 상한. 기본 12 는 기획 결과를 컷으로 옮길 때의 값이다
 *   (local-fallback.js). 사람이 붙여 넣은 것을 쪼갤 때는 화면이 CUT_MAX 를 넘겨 준다 —
 *   상한에 걸려 잘린 것을 사람에게 말해 주려면 부르는 쪽이 상한을 알아야 한다.
 */
export function splitScenario(text, max = 12) {
  const blocks = String(text || '')
    .split(/\n[ \t]*\n|(?<=[.!?…])[ \t]+(?=[가-힣A-Z"'“])/)
    .map((s) => s.trim())
    .filter(Boolean)

  const isDialogue = (line) => /^["'“]|^[가-힣A-Za-z ]{1,10}\s*:/.test(line)

  return blocks.slice(0, max).map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    const dialogue = lines.filter(isDialogue).join(' ')
    const action = lines.filter((l) => !isDialogue(l)).join(' ')
    const camera = CAMERA_HINTS.find(([re]) => re.test(block))?.[1] || 'MS'
    return { action: action || (dialogue ? '' : block), dialogue, camera }
  })
}

export const CAMERAS = ['WS', 'MS', 'CU', 'ECU', 'MCU', 'OTS', 'POV',
  'TWO SHOT', 'INSERT', 'TRACKING', 'PAN', 'TILT', 'LOW ANGLE', 'HIGH ANGLE']

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

/*
 * src 에 들어올 수 있는 것은 세 가지뿐입니다. 이 사이트 안의 경로, 브라우저가 만든
 * data:image, 그리고 바깥 영상 파일 하나입니다.
 *
 * 셋째 것은 영상 생성 서버가 돌려주는 주소입니다(우리 GPU 의 /gen/animate, 그리고 없어진
 * 영상화 화면이 MCP 로 붙였던 바깥 서버). 앞의 둘만
 * 허용하던 때에는 그 주소가 판에 닿는 순간 빈 칸이 되어 컷에 깨진 그림이 남았습니다.
 * 그래서 딱 그 모양만 더 받습니다 — https 이고, 물음표 앞이 영상 파일 확장자여야 합니다.
 * http 도, 바깥 이미지도, javascript: 도 여전히 받지 않습니다. 판은 여러 사람이 같이
 * 보는 곳이라, 아무 주소나 실리면 op 를 넣은 사람이 남의 브라우저로 아무 데나 부릅니다.
 *
 * 이 주소는 대개 서명이 붙어 있어 시간이 지나면 만료됩니다. 오래된 컷의 영상이 안
 * 열리는 것은 그래서이고, 고치려면 그때 다시 만들어야 합니다.
 */
/*
 * 그 셋째 갈래를 따로 둡니다. 주소를 파내는 쪽(domain/mcp.js 의 videoFrom)도 같은 자로
 * 재야 하기 때문입니다. 두 곳이 다르면 저기서 통과한 주소가 여기서 빈 칸이 되고, 화면은
 * 「만들었습니다」라고 말해 놓고 컷에는 아무것도 남지 않습니다. 실제로 그랬습니다.
 */
const VID_SRC = 'https://[\\w.-]{1,120}/[\\w./%~-]{1,300}\\.(?:mp4|webm|mov|m4v)(?:\\?[\\w=&.%~+/-]{0,400})?'
const VID_RE = new RegExp(`^(?:${VID_SRC})$`)

/** 판이 받아 주는 바깥 영상 주소인지. 주소를 판에 넣기 전에 이것으로 걸러 주십시오 */
export const isVideoSrc = (s) => VID_RE.test(String(s || ''))

const RE = {
  id: /^[A-Za-z0-9._:#-]{1,64}$/,
  color: /^#[0-9A-Fa-f]{3,8}$/,
  src: new RegExp('^(?:\\/[\\w./-]{1,200}'
    + '|data:image\\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]{1,4000000}'
    + `|${VID_SRC})$`),
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

