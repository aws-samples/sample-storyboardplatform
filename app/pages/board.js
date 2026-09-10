
import {
  orderKeyBetween, orderKeyForIndex, byOrderKey, STATUS, ACTIONS, TRANSITIONS, ROLES, POSES,
  FEEDBACK_TAGS, NEEDS, canTransition, canEditContent, splitScenario,
  mergeField, handBackTo, notifFor, sceneGroups, sceneKey, sceneMeta,
  clock, startTimes, scrub, debounceBy, epLabel, lostEdit, isActionable, changedSince,
  workload, liveVer, deadVer, tally, actorPace, ASSET_TYPES, assetJobs,
} from '../domain/panels.js'
import { confirmAsk } from '../components/confirm.js'
import { josa } from '../lib/josa.js'
/*
 * 여기 있던 import 넷이 나갔습니다 — domain/prompts.js 의 고르는 값들(MODES·GENRES·TONES·
 * LENGTHS·CUTCOUNTS), services/planner.js 의 세 부름(planOutline·planCuts·planScript),
 * domain/script-format.js 의 내려받기 넷, 그리고 domain/panels.js 의 splitScript·
 * scenarioFromScript·CUT_MAX 입니다.
 *
 * 이야기를 만들고 대본으로 내리는 일이 이 화면에서 나갔기 때문입니다. 그 일을 하는 화면이
 * 위 탭 바에 있고, 같은 것을 그쪽이 씁니다(pages/story-graph.js). 모듈은 그대로 있습니다.
 *
 * splitScenario 는 남습니다. 예시 판을 세울 때 씁니다(seedBuild).
 */
import { esc, setHtml } from '../lib/dom.js'
import { srcOf, downscale, faceSheet } from '../lib/placeholder-art.js'
import { SEED_ART } from '../lib/seed-art.js'
import { gpuDownHint } from '../lib/gpu-hours.js'
import { connect, connectorClient } from '../services/api.js'
import { canAnimate, videoHealth, runClip, clipHint } from '../services/animate.js'
import { cutPrompt } from '../domain/mcp.js'
import { configured, idToken, session, logout } from '../services/auth.js'
import { showLogin, gateModal } from '../components/login-form.js'
import { NAV_TABS, navHref, boardFromSearch } from '../domain/routes.js'
import { mountNav } from '../components/nav-tabs.js'
import { mountBrand } from '../components/brand.js'
import * as coach from '../components/coachmark.js'
import { emptyHint } from '../components/empty-panel.js'
import { guiding } from '../../app-walkthrough/guide.js'
import { boardExample } from '../../app-walkthrough/steps/board.js'
import { entries, group, toEntry } from '../services/activity-log.js'
import { paintList } from '../components/history-list.js'
import {
  CAPS, permKey, permModel, mayManagePerms, panelHtml as permPanelHtml, watchNope, nope, ASK,
} from '../components/perm.js'
import { pickProject } from '../components/project-picker.js'
import { touch as touchProject } from '../services/projects.js'
import { saveAsset } from '../services/assets.js'
import { allowed, denyReason } from '../domain/permissions.js'
// demoAdvance·demoSay·demoTitle 도 받고 있었지만 이 파일에서 부르는 곳이 없습니다.
// 예시를 옮길 때 같이 갔습니다(app-walkthrough/steps/board.js 가 직접 받습니다)
import { wire as wireTour, demoActive } from '../../app-walkthrough/tour.js'

/*
 * 예시가 쓸 제품 쪽 함수를 넣습니다. app-walkthrough 는 app/ 을 import 할 수 없습니다.
 * 배포에서 app/* 는 버킷 루트로 올라가서 상대 경로가 그쪽으로 닿지 않습니다
 * (app-walkthrough/tour.js 의 머리글).
 */
wireTour({
  navHref,
  label: (id) => NAV_TABS.find((t) => t.id === id)?.label || id,
  touch: touchProject,
})

const ROSTER = [
  { id: 'u1', name: '김하나', role: 'planner', color: '#E3A93C', job: '시나리오를 컷으로 쪼갭니다' },
  { id: 'u2', name: '이도현', role: 'artist', color: '#4FA97A', job: '구도를 그리고 올립니다' },
  { id: 'u3', name: '박서준', role: 'director', color: '#7FB3E8', job: '피드백하고 승인합니다' },
  { id: 'u4', name: '최유진', role: 'reviewer', color: '#D69AC9', job: '메모로 의견을 남깁니다' },
  { id: 'u5', name: '정민아', role: 'admin', color: '#C77B62', job: '팀원을 등록하고 역할을 정합니다' },
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
  // 승인된 컷에서 떼어 낸 인물·배경·소품 그림 (asset.add). 컷 생성의 참조가 됩니다
  assets: {},
  panels: {},
  members: {},
  // 권한 손질. 칸 하나가 한 줄이라 두 사람이 같이 만져도 서로를 덮지 않는다 (perm.set)
  perms: {},
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

// ── 권한 ─────────────────────────────────────────────────────────────────────
/*
 * 표와 그 판은 perm.js 가 들고 있습니다. 감독이 보드 밖(스토리 디벨롭·대본화·키비주얼)
 * 에서도 같은 표를 열어야 해서 옮겼습니다.
 *
 * 여기 남은 것은 그 한 벌을 이 화면의 판(state.perms)과 명부(roleOf·person)에 묶는
 * 얇은 껍데기입니다. 이름을 그대로 두는 이유는 부르는 자리가 스무 곳이 넘기 때문입니다.
 * state 는 op 이 들어올 때마다 갈리므로 판과 「나」를 함수로 넘깁니다.
 */
const PM = permModel({
  perms: () => state.perms,
  roleOf,
  nameOf: (id) => person(id)?.name || id,
  meId: () => me.id,
})

const permCell = (scope, who, cap) => PM.cell(scope, who, cap)
const mayRole = (cap, role) => PM.mayRole(cap, role)
/** 이 사람이 이것을 할 수 있는가. 사람 예외 → 역할 손질 → core.js 기본값 순서 */
const may = (cap, who = me.id) => PM.may(cap, who)
/** 왜 못 하는지 사람 말로. 막힌 자리의 안내와 알림에 그대로 씁니다 */
const whyNot = (cap, who = me.id) => PM.whyNot(cap, who)

/**
 * 컷 상태를 옮길 수 있는가. core.js 의 canTransition 과 답이 같은 모양이되, 역할 검사만
 * 손질을 거칩니다. 상태 검사(승인된 컷을 또 승인 못 한다 같은 것)는 이야기의 규칙이라 그대로 둡니다.
 */
function mayTransition(from, action, who = me.id) {
  if (!ACTIONS[action]) return { ok: false, reason: '알 수 없는 액션' }
  if (!may(action, who)) return { ok: false, reason: whyNot(action, who) }
  const to = TRANSITIONS[action]?.[from]
  if (!to) return { ok: false, reason: `${STATUS[from].label} 상태에서는 할 수 없습니다` }
  return { ok: true, to }
}

/** 컷 내용을 고칠 수 있는가. 승인된 컷은 누구도 못 고칩니다 (core.js 의 canEditContent 와 같은 규칙) */
const mayEdit = (panel, who = me.id) => panel.status !== 'approved' && may('edit', who)
/** 못 고치는 이유 */
const whyNotEdit = (panel, who = me.id) => (panel.status === 'approved'
  ? '승인된 컷입니다. 고치려면 먼저 승인을 해제해야 합니다'
  : whyNot('edit', who))

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

/*
 * 그림 한 장을 화면에 앉힙니다.
 *
 * 커넥터의 영상 모델은 mp4 를 돌려줍니다(infra/connector/index.js 가 img/<uuid>.mp4 로 올립니다).
 * 버전 자체는 그림과 똑같이 src 하나뿐이라 저장·비교·되돌리기는 그대로 돌아갑니다. 다른 것은
 * 태그뿐이므로 여기서 확장자를 보고 갈라 줍니다. 버전에 종류를 따로 적어 두지 않은 이유는
 * 예전에 만든 버전에는 그 칸이 없어서, 있으나 없으나 결국 주소를 봐야 하기 때문입니다.
 *
 * @param {string} src - srcOf(version)
 * @param {string} [attrs] - 그대로 붙일 속성 문자열
 */
// 우리 GPU 는 mp4 로 줍니다. 옛 판에는 MCP 로 붙인 서버가 준 webm·mov 도 남아 있습니다
const isVideoSrc = (src) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(src || '')
/*
 * alt 는 video 의 속성이 아닙니다 — 브라우저도 읽어 주는 기계도 그냥 버립니다. 부르는
 * 쪽은 그림인지 영상인지 모르고 alt 를 넘기므로, 영상일 때 여기서 aria-label 로 옮깁니다
 */
const media = (src, attrs = '') => (isVideoSrc(src)
  ? `<video src="${src}" ${attrs.replace(/\balt=/g, 'aria-label=')} controls loop muted playsinline></video>`
  : `<img src="${src}" ${attrs}>`)

/*
 * 버전 칩의 글자. 'video' 는 우리 GPU 로 만든 영상이고(animate), 'mcp' 는 없어진 영상화
 * 화면이 바깥 서버로 만들던 것입니다. 둘 다 「영상」으로 읽습니다 — 어디서 만들었는지는 이 자리에서
 * 물어보는 것이 아닙니다. 모르는 값과 없는 값은 업로드로 봅니다. 옛 판에는 source 가
 * 아예 없는 버전이 있고, 그때는 사람이 올린 것이었습니다.
 */
const VER_SRC = { ai: 'AI', sketch: 'AI · 스케치', video: '영상', mcp: '영상' }

function refOf(ch) {
  if (!ch?.refPanelId) return null
  const p = state.panels[ch.refPanelId]
  const v = p?.versions?.[(ch.refN ?? 1) - 1]
  return v && !deadVer(p, v) ? { src: srcOf(v), panelId: p.id, pose: p.pose, n: ch.refN ?? 1 } : null
}

/*
 * 이 인물의 얼굴 한 장. 컷이 이것을 기반 이미지로 물려받으면 컷마다 얼굴이 바뀌지 않습니다.
 *
 * 두 곳에서 찾습니다. 먼저 사람이 「이 버전을 기준으로」 잡아 둔 것(refOf)입니다. 그것이
 * 「이 얼굴이 이 인물이다」라고 손으로 정해 둔 한 장입니다. 잡아 두지 않았으면 그 인물의
 * 승인된 구도 중 마지막 것을 씁니다 — 승인도 같은 뜻의 표시이고, 기준 잡기를 잊은 판이
 * 대부분이라 그것까지 봐야 이 기능이 실제로 켜집니다.
 *
 * 승인되지 않은 초안은 쓰지 않습니다. 아무 초안이나 끌어오면 컷마다 다른 얼굴을 물려받아
 * 인물이 흔들리는데, 그것이 이 기능이 없애려는 문제입니다.
 *
 * @returns {?{id, name, src, panelId, pose, n, pinned}} 없으면 null
 */
function faceOf(ch) {
  if (!ch) return null
  const pinned = refOf(ch)
  const hit = pinned || approvedPose(ch)
  // 영상은 기반 이미지가 되지 못합니다(keyVisualOf 와 같은 이유)
  if (!hit || isVideoSrc(hit.src)) return null
  return { ...hit, id: ch.id, name: ch.name, pinned: !!pinned }
}

/* 이 인물의 승인된 구도 중 마지막 한 장. 기준 이미지를 잡아 두지 않았을 때의 대안입니다 */
function approvedPose(ch) {
  const poses = Object.values(state.panels).filter((p) => p.charId === ch.id && p.status === 'approved')
  for (let i = poses.length - 1; i >= 0; i--) {
    const cur = liveVer(poses[i])
    if (cur) return { src: srcOf(cur.ver), panelId: poses[i].id, pose: poses[i].pose, n: cur.i + 1 }
  }
  return null
}

/* 이 컷에 붙여 둔 인물들의 얼굴. 등장 인물 칩에서 고른 순서 그대로입니다 */
const castFaces = (panel) => (panel.cast || []).map((id) => faceOf(state.chars[id])).filter(Boolean)

/*
 * 이 컷이 어디서 왔는지.
 *
 * 키비주얼 화면이 붙인 씬 패널은 스스로 keyVisual: true 를 달고 옵니다
 * (app/key-visual.js 의 opsForBoard). 보드 안에서 만든 것은 origin 에 적습니다.
 * 손으로 「+ 컷 추가」한 것에는 아무 표시도 없습니다. 표시가 없는 것이 기본이라
 * 카드가 배지로 뒤덮이지 않습니다.
 */
const ORIGINS = { keyvisual: '키 비주얼', plan: '기획', script: '대본' }
const originOf = (p) => (p.keyVisual ? 'keyvisual' : (ORIGINS[p.origin] ? p.origin : ''))

/*
 * 그 씬의 키 비주얼 한 장.
 *
 * 키비주얼 화면은 대본의 씬마다 한 장을 그려 보드에 붙입니다. 그 그림은 그 씬의
 * 장소·시간·분위기가 이미 정해진 한 장이므로, 같은 씬의 컷들이 그것을 기반 이미지로
 * 물려받으면 씬 안에서 룩이 흔들리지 않습니다. 그것이 refChoices 의 '씬 키 비주얼'
 * 이고 이 함수가 그 한 장을 찾습니다.
 *
 * 회차로 거르지 않습니다. 키비주얼이 붙이는 패널에는 epId 가 없어서(그 화면의 대본은
 * 보드의 어느 회차 것도 아닙니다) 회차로 걸면 회차를 만든 뒤에는 한 장도 못 찾습니다.
 *
 * @param {string} sceneName - 씬 이름. 번호만 맞으면 같은 씬으로 봅니다 (core.js 의 sceneKey)
 * @param {?string} exceptId - 뺄 패널. 컷이 자기 자신을 자기 기반 이미지로 고르지 않게
 * @returns {?{panel: object, ver: object, n: number}}
 */
function keyVisualIn(sceneName, exceptId = null) {
  const k = sceneKey(sceneName)
  if (!k) return null
  const hits = Object.values(state.panels)
    .filter((p) => p.keyVisual && p.id !== exceptId && sceneKey(p.scene) === k)
    .sort(byOrderKey)
  for (const p of hits) {
    const cur = liveVer(p)
    // 영상은 기반 이미지가 되지 못합니다. 커넥터의 영상 모델이 mp4 를 돌려줍니다
    if (cur && !isVideoSrc(srcOf(cur.ver))) return { panel: p, ver: cur.ver, n: cur.i + 1 }
  }
  return null
}

const keyVisualOf = (panel) =>
  (!panel || panel.charId ? null : keyVisualIn(panel.scene, panel.id))

let net = null
let link = 'open'
let unsent = 0
let linkTimer = 0
let replaying = false
let lastTs = 0

/*
 * 프로젝트 카드의 「마지막 손길」을 고칩니다.
 *
 * 무슨 일이었는지는 history.js 가 이미 한 줄로 옮기는 법을 알고 있으므로 그것을 그대로
 * 씁니다. 카드에 적을 문장을 여기서 또 만들면 목록과 카드가 서로 다른 말을 합니다.
 * 히스토리에 넣지 않는 op(프레즌스·읽음 표시 따위)는 toEntry 가 null 을 주고, 그런
 * 것으로는 카드를 건드리지 않습니다. 「본 일」이 아니라서입니다.
 *
 * 컷 9개를 한 번에 만들면 op 도 9건입니다. 그때마다 쓰면 같은 카드에 아홉 번 쓰는
 * 것이므로, 마지막 것만 조금 늦춰 한 번 보냅니다.
 */
let cardTimer = null
let cardWhat = ''
function touchCard(op) {
  const e = toEntry(op, (id) => person(id))
  if (!e) return
  cardWhat = e.what
  clearTimeout(cardTimer)
  cardTimer = setTimeout(() => {
    touchProject({ boardId: boardFromSearch(), actor: me.id, what: cardWhat })
    /*
     * 리뷰 역할은 에셋을 쓰지 못합니다(infra/resolvers/putAsset.js). 메모를 남기는 것도
     * op 이므로 여기를 지나는데, 막힐 것을 보내고 401 을 받아 로그에 적기만 하는 것은
     * 왕복만 늘립니다. 리뷰가 남긴 메모로 콘티 요약이 바뀔 일도 없습니다.
     *
     * 여기서만 아무 말도 하지 않습니다. 다른 화면들은 못 담았다고 알리는데(키비주얼의
     * noteKeepDenied), 그쪽은 대본·씬처럼 사람이 방금 만든 것이 사라지는 자리입니다.
     * 이쪽에서 못 담는 것은 서랍에 보일 요약 숫자이고, 컷과 메모는 op 로그에 그대로
     * 남습니다. 잃는 것이 없는 일로 안내문을 띄우면 다음 안내문이 안 읽힙니다.
     *
     * 로컬 모드는 막지 않습니다. 그때는 브라우저 저장소에 쓰는 것이라 리졸버를 지나지
     * 않고, 무엇보다 로컬에서는 자리를 돌려 가며 앉히므로(resolveMe) 다섯 명 중 한 명이
     * 리뷰어입니다. 그 자리에 앉은 사람만 콘티가 서랍에 안 보이면 까닭을 알 수 없습니다.
     */
    if (configured && !allowed('putAsset', me.role)) return
    keepConti()
    keepSynopsis()
  }, 600)
}

/*
 * 서랍에 보일 콘티 요약을 담습니다. 컷 자체는 담지 않습니다.
 *
 * 컷은 op 로그가 들고 있고 그것이 이 화면의 사실입니다. 여기 한 벌 더 담으면 두 곳이
 * 어긋날 자리가 생기고, 컷 수십 개를 op 하나 올릴 때마다 통째로 다시 쓰는 셈입니다.
 * 그래서 세어 본 숫자만 담습니다. 서랍은 「무엇이 얼마나 있나」만 보여주면 되고, 컷을
 * 보려면 「열기」로 이 화면에 옵니다.
 *
 * 이것이 없으면 서랍의 콘티 줄은 컷이 가득한 보드에서도 늘 「아직 없습니다」입니다.
 * 서랍은 op 로그를 읽지 않기 때문입니다.
 */
async function keepConti() {
  const cuts = Object.values(state.panels).filter((p) => !p.charId)
  if (!cuts.length) return
  try {
    await saveAsset({
      boardId: boardFromSearch(), kind: 'conti', actor: me.id,
      body: {
        cuts: cuts.length,
        approved: cuts.filter((p) => p.status === 'approved').length,
        eps: epList().length,
      },
    })
  } catch (err) {
    console.warn('[board] 콘티 요약을 담지 못했습니다', err)
  }
}

/*
 * 시나리오를 시놉시스 에셋으로 옮겨 둡니다.
 *
 * 지금 이 글은 op 로그에만 있습니다(board.patch 의 scenario). op 에는 30일 TTL 이 걸려
 * 있어서(infra/resolvers/putOp.js) 한 달 쉰 프로젝트는 시나리오가 사라진 채 컷만 남습니다.
 * 에셋에는 TTL 이 없으니 여기 옮겨 두면 남습니다.
 *
 * 회차를 보고 있으면 그 회차의 글입니다. 프로젝트 하나에 시놉시스 한 칸이라 마지막에
 * 손댄 것이 남습니다. 회차마다 남기려면 sk 에 회차를 넣어야 하는데, 서랍이 여섯 줄을
 * 보여주는 화면이라 지금은 그렇게까지 하지 않습니다.
 */
async function keepSynopsis() {
  const ep = viewEp ? state.eps[viewEp] : null
  const text = ((ep ? ep.scenario : state.board.scenario) || '').trim()
  if (!text) return
  try {
    await saveAsset({
      boardId: boardFromSearch(), kind: 'synopsis', actor: me.id,
      body: {
        title: (ep ? ep.title : state.board.title) || '',
        logline: ep?.logline || '',
        synopsis: text,
      },
    })
  } catch (err) {
    console.warn('[board] 시놉시스를 담지 못했습니다', err)
  }
}

function emit(op) {
  op.id = uid()
  op.ts = now()
  op.actor = me.id
  seenOps.add(op.id)
  applyOp(op)
  net?.sendOp(op)
  touchCard(op)
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
  if (ops.length) touchCard(ops.at(-1))
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

/*
 * 지나간 op 를 그대로 들고 있는다. state 는 「지금 어떤 모양인지」만 남기고 「누가 뭘
 * 했는지」는 버리기 때문이다. 판을 만들 때 op 를 접어 넣는 것이 그 일이다.
 * 히스토리는 접기 전의 것을 봐야 한다. 서버의 로그가 사실이고 이건 그 사본이다.
 */
const journal = []
const JOURNAL_MAX = 600

function applyOp(op) {
  journal.push(op)
  if (journal.length > JOURNAL_MAX) journal.splice(0, journal.length - JOURNAL_MAX)

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

    /*
     * 자산. 인물과 같은 모양의 세 op 입니다. 옛 판에는 assets 칸이 없어서 (state.assets ??= {})
     * 로 받습니다 — 저장된 판을 load 가 되살릴 때도 같은 일을 합니다.
     */
    case 'asset.add':
      state.assets ??= {}
      if (!op.asset?.id || state.assets[op.asset.id]) { landed = false; break }
      state.assets[op.asset.id] = { ...op.asset, _ts: {} }
      break

    case 'asset.patch': {
      const a = state.assets?.[op.assetId]
      if (!a) { landed = false; break }
      for (const [k, v] of Object.entries(op.fields)) mergeField(a, k, v, op.ts)
      break
    }

    case 'asset.remove':
      if (!state.assets?.[op.assetId]) { landed = false; break }
      delete state.assets[op.assetId]
      break

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
      if (!self && !may('grant', op.actor)) { landed = false; break }
      const cur = (state.members[m.id] ??= { id: m.id, _ts: {} })
      for (const k of ['name', 'color', 'job']) if (k in m) mergeField(cur, k, m[k], op.ts)
      if (m.role && (!cur.role || !self)) mergeField(cur, 'role', m.role, op.ts)
      break
    }

    case 'member.role': {
      if (!op.userId || !may('grant', op.actor)) { landed = false; break }
      const cur = (state.members[op.userId] ??= { id: op.userId, _ts: {} })
      mergeField(cur, 'role', ROLES[op.role] ? op.role : 'reviewer', op.ts)
      break
    }

    /*
     * 권한 손질 한 칸. 지우는 것도 { on: null } 로 남깁니다. 줄을 없애 버리면 늦게 도착한
     * 옛 변경이 되살아납니다. 손질할 수 있는 사람인지는 여기서도 봅니다 — 화면만 잠가 두면
     * 다른 창에서 만든 op 가 그냥 들어옵니다.
     */
    case 'perm.set': {
      if (!CAPS[op.cap] || !op.who || !mayManagePerms(roleOf(op.actor))) { landed = false; break }
      const key = permKey(op.scope, op.who, op.cap)
      const cur = state.perms[key]
      if (cur && cur.ts > op.ts) { landed = false; break }
      state.perms[key] = { on: op.on === null || op.on === undefined ? null : !!op.on, ts: op.ts }
      break
    }

    case 'board.reset': {
      const keep = state.members
      // 권한은 판의 내용이 아니라 팀의 약속입니다. 판을 비워도 그대로 둡니다
      const keepPerms = state.perms
      state = emptyState()
      state.members = keep
      state.perms = keepPerms
      // 판을 비웠으므로 그 전의 기록이 가리키는 컷도 없다. 「이어서 하기」가 사라진
      // 자리로 데려가지 않게 사본도 같이 비운다. 이 op 자체는 남는다
      journal.splice(0, journal.length, op)
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

/*
 * 로컬 모드의 판 저장 자리. 프로젝트마다 다릅니다. 한때 'sb.state' 한 칸이었는데,
 * 프로젝트 보드가 생긴 뒤로는 그러면 A 를 열었다가 B 를 열면 A 의 컷이 B 에 그대로
 * 나타납니다. 배포 모드는 이 함수를 타지 않습니다(op 로그가 판입니다).
 */
const stateKey = () => `sb.state.${boardFromSearch()}`

let saveTimer = null
function save() {
  if (net?.mode === 'aws') return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(stateKey(), JSON.stringify(state)) } catch {  }
  }, 220)
}

function load() {
  try {
    const raw = localStorage.getItem(stateKey())
    if (raw) {
      const s = scrub(JSON.parse(raw))
      if (!s.chars || !s.notifs) return false
      s.members ||= {}
      s.eps ||= {}
      s.assets ||= {}
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

/**
 * 예시 데이터 한 벌. 예전에는 보드가 비어 있으면 이걸 조용히 밀어 넣었지만, 지금은
 * 「예시 보기」를 눌렀을 때만 들어갑니다 (seedScript 가 나눠서 넣습니다).
 *
 * @returns {Array} op 들. 모두 seed:true 라 히스토리에서 「예시」로 갈라 보입니다
 */
function seedOps(opAt = null, tag = 'sd') {
  return seedBuild(opAt, tag).ops
}

/*
 * 예시를 만드는 곳. ops 와 함께 「여기서부터 무엇을 하는 중인지」 표시(marks)를 냅니다.
 * 표시가 있어야 재생기가 한 번에 쏟아 넣지 않고 단계로 나눠 넣을 수 있습니다.
 */
function seedBuild(opAt = null, tag = 'sd') {
  const T = Math.floor(now() / 864e5) * 864e5
  const base = opAt ?? T
  const ops = []
  const marks = []
  let n = 0
  let min = 0
  const add = (actor, o, gap = 3) => {
    min += gap
    ops.push({ ...o, id: `${tag}-${++n}`, ts: opAt ? base + n : T + min * 6e4, actor, seed: true })
    return ops.at(-1)
  }
  /** 여기서부터 한 덩어리. say 는 재생 중 아래 띠에 적히는 한 줄이다 */
  const mark = (say, sub) => marks.push({ at: ops.length, say, sub })

  /*
   * 「시나리오를 넣습니다」였습니다. 그 일을 하는 칸이 이 화면에서 나갔으므로(위 탭 바의
   * 스토리 디벨롭이 합니다) 「넘어온 것을 엽니다」로 고칩니다. op 는 그대로입니다 —
   * 판에 시나리오 값이 실려 오는 것은 여전히 사실이고, 다만 실은 곳이 여기가 아닙니다.
   */
  mark('스토리 디벨롭에서 넘어온 이야기입니다', '기획자 김하나가 15초 브랜드 필름 한 편을 엽니다')
  add('u1', { kind: 'board.patch', fields: { title: '아침빵집 · 15초 브랜드 필름', scenario: SEED_SCENARIO } })

  mark('인물과 구도를 만듭니다', '인물마다 정면·3/4·측면… 구도가 따로 관리됩니다')
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

  mark('이야기가 컷으로 나뉘어 올라옵니다', '컷은 씬으로 묶이고 순서대로 시간이 매겨집니다')
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

  mark('감독과 리뷰어가 의견을 남깁니다', '그림 위의 점과 동그라미가 그 의견이 가리키는 자리입니다')
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

  return { ops, marks }
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
  const check = mayTransition(panel.status, action)
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
  /*
   * 승인은 「이 그림으로 간다」는 결정입니다. 그 자리에서 그림 속 인물·배경·소품을 자산으로
   * 떼어 둡니다(extractAssets). 기다리지 않습니다 — 상태는 이미 바뀌었고, 뽑기는 GPU 가
   * 몇 십 초를 쓰는 뒷일입니다. 진행과 결과는 컷 상세의 「자산」칸이 보여줍니다.
   */
  if (action === 'approve') extractAssets(state.panels[panel.id], { auto: true })
  /*
   * 됐다는 말을 한 줄 띄웁니다. 세 부르는 자리(단추·키보드·메모와 함께)가 다 여기를 지나므로
   * 이 자리에 두면 한 곳입니다.
   *
   * 예전에는 성공에 아무 말이 없었습니다. 카드의 상태 칩 색만 바뀌는데 그 카드가 화면 밖일
   * 수도 있고, 색만 봐서는 눌린 것인지 원래 그랬던 것인지 모릅니다. 누구에게 넘어갔는지도
   * 같이 말합니다 — 이 판의 일은 대개 「다음 사람에게 넘기는 것」이라서 그것이 결과입니다.
   */
  const to = person(assignee)
  notice(`${labelOf(panel)} · ${ACTIONS[action].label}${
    to && to.id !== me.id ? ` · ${to.name}에게 넘어갔습니다` : ''}`, 'ok')
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
let gpuRef = null   // 서버가 참조 생성에 쓰라는 모델(/health 의 ref). 9B 가 있으면 9B, 없으면 4B
/*
 * 커넥터로 붙은 밖의 모델. 관리자가 홈의 「모델 커넥터」에서 API 키를 넣으면 여기 들어옵니다.
 * GPU 목록과 한 배열에 섞지 않는 이유는 /health 폴링입니다. 그쪽은 응답마다 gpuModels 를
 * 통째로 갈아 끼우고, GPU 가 꺼져 있으면 빈 목록이 옵니다. 커넥터 모델은 GPU 와 무관하게
 * 남아 있어야 하므로 따로 들고 있다가 고를 때만 합칩니다.
 */
let connModels = []
let pickedModel = null
let pickError = ''
const allModels = () => [...gpuModels, ...connModels]
const modelOf = (id) => allModels().find((m) => m.id === id)
const isConn = (id) => connModels.some((m) => m.id === id)
const mins = (s) => Math.max(1, Math.ceil(s / 60))
const charOf = (panel) => (panel.charId ? state.chars[panel.charId] : state.chars[panel.cast?.[0]])

function autoPrompt(panel) {
  const ch = charOf(panel)
  return panel.charId
    ? [ch?.name, panel.pose, ch?.brief, panel.action].filter(Boolean).join(', ').slice(0, 320)
    // 씬 이름의 장소·시간을 같이 넣습니다. 키비주얼이 대본 슬러그에서 읽어 온 것이라
    // ("S03 카페 · 밤") 컷마다 손으로 다시 적지 않아도 배경이 같은 자리에서 나옵니다.
    // 인물은 이름과 설명을 함께 넣습니다. 얼굴을 기반 이미지로 물려줄 때 그 그림 속
    // 누가 누구인지 모델이 알아야 두 사람이 섞이지 않습니다
    : [panel.camera, sceneMeta(panel.scene).where, panel.action,
      (panel.cast || []).map((id) => state.chars[id]).filter(Boolean)
        .map((c) => [c.name, c.brief].filter(Boolean).join(' - ')).join(' / ')]
      .filter(Boolean).join(', ').slice(0, 320)
}

const genOpts = new Map()
const optsFor = (panel) => {
  let o = genOpts.get(panel.id)
  /*
   * 기반 이미지를 미리 집어 둡니다. 매번 손으로 고르게 하면 아무도 고르지 않습니다.
   *
   * 순서는 인물 → 씬 키 비주얼입니다. 컷에 붙여 둔 인물의 얼굴이 있으면 그것을 먼저
   * 잡습니다. 여러 컷을 지나며 같은 얼굴로 남는 것이 콘티에서 가장 먼저 깨지는 것이고,
   * 씬의 장소·시간은 지시문에도 이미 적혀 나갑니다(autoPrompt 가 씬 이름에서 읽습니다).
   * 인물이 없는 컷(풍경·소품)은 그대로 씬 키 비주얼을 물려받습니다.
   *
   * 변형 정도는 '새로 그리기'로 둡니다. 얼굴이든 씬이든 물려받을 것은 룩이지 구도가
   * 아닙니다. 구도까지 물려받으면 여덟 컷이 다 같은 그림이 됩니다.
   */
  if (!o) genOpts.set(panel.id, (o = { ref: null, assets: null, strength: autoRef(panel) === 'none' ? 0.85 : 0.95, prompt: null }))
  return o
}

/*
 * 아무것도 고르지 않았을 때의 참조 자산. 컷에 붙인 인물의 자산과, 같은 씬의 다른 컷에서
 * 뽑은 배경입니다. 소품은 넣지 않습니다 — 이 컷에 그 물건이 나오는지는 사람만 압니다.
 * autoRef 와 같은 이유로 값으로 박아 두지 않고 쓸 때마다 다시 셉니다.
 */
function autoAssets(panel) {
  if (panel.charId) return []
  const out = []
  for (const id of panel.cast || []) {
    const a = assetList().filter((x) => x.type === 'char' && x.charId === id && assetSrc(x)).at(-1)
    if (a) out.push(a.id)
  }
  const k = sceneKey(panel.scene)
  if (k) {
    const bg = assetList().filter((x) => x.type === 'bg' && assetSrc(x) && x.fromPanelId !== panel.id
      && sceneKey(state.panels[x.fromPanelId]?.scene) === k).at(-1)
    if (bg) out.push(bg.id)
  }
  return out
}

/** 이 컷이 참조로 보낼 자산 id. 지워진 자산은 뺍니다 */
const assetIdsOf = (panel) => (optsFor(panel).assets ?? autoAssets(panel)).filter((id) => assetSrc(state.assets?.[id]))

/*
 * 아무것도 고르지 않았을 때의 기반 이미지. ref 를 null 로 두고 쓸 때마다 다시 셈합니다.
 * 값으로 박아 두면 컷을 열어 본 뒤에 인물을 붙인 사람은 기본값을 못 받습니다 — 그때는
 * 이미 기본값이 정해져 버렸기 때문입니다. 사람이 칩을 누르면 그때 실제 값이 들어갑니다.
 */
function autoRef(panel) {
  const faces = panel.charId ? [] : castFaces(panel)
  if (faces.length > 1) return 'cast'
  if (faces.length) return `char:${faces[0].id}`
  return keyVisualOf(panel) ? 'keyvisual' : 'none'
}

/** 지금 이 컷의 기반 이미지 키. 고른 것이 없으면 기본값입니다 */
/*
 * 고른 기반 이미지. 자산이 들어가는 컷은 기본 기반 이미지를 잡지 않습니다 — 인물 자산이
 * 얼굴을 대신하는데 얼굴 칩까지 자동으로 잡으면 같은 사람이 두 번 들어갑니다
 */
const refKeyOf = (panel) => optsFor(panel).ref ?? (assetIdsOf(panel).length ? 'none' : autoRef(panel))

const morph = (v) => (v < 0.8 ? '선 그대로' : v < 0.9 ? '구도 유지' : '새로 그리기')

/*
 * 이 컷·구도가 무엇을 기반 이미지로 쓸 수 있는지.
 *
 * 구도(인물 패널)는 그 인물의 기준 이미지 하나입니다. 컷은 붙여 둔 인물마다 한 칩씩
 * 나오고, 둘 이상이면 얼굴을 한 장으로 붙인 칩이 하나 더 나옵니다(art.js 의 faceSheet). 생성 서버가
 * 기반 이미지를 한 장만 받기 때문입니다(infra/gpu/server.py 의 Req.init).
 *
 * from 은 어느 패널의 몇 번째 버전에서 왔는지입니다. 버전에 적어 두면 나중에 이 얼굴이
 * 어디서 왔는지 되짚을 수 있습니다.
 */
function refChoices(panel) {
  const out = [{ key: 'none', label: '없음' }]
  const anchor = panel.charId ? refOf(charOf(panel)) : null
  if (anchor) out.push({ key: 'anchor', label: '기준 이미지', src: anchor.src, from: anchor })
  const faces = panel.charId ? [] : castFaces(panel)
  for (const f of faces) {
    out.push({
      key: `char:${f.id}`, label: `${f.name} 얼굴`, src: f.src, from: f, face: true,
      hint: f.pinned ? '기준으로 잡아 둔 이미지입니다' : `승인된 구도입니다 (${f.pose || '구도'} v${f.n})`,
    })
  }
  if (faces.length > 1) {
    out.push({
      key: 'cast', label: `인물 ${faces.length}명 함께`, srcs: faces.map((f) => f.src), faces, face: true,
      hint: '얼굴을 한 장에 붙여 함께 참조합니다',
    })
  }
  const kv = keyVisualOf(panel)
  if (kv) out.push({ key: 'keyvisual', label: `씬 키 비주얼${kv.n > 1 ? ` v${kv.n}` : ''}`, src: srcOf(kv.ver) })
  /*
   * 「영상으로 생성」을 누른 컷은 이 칸의 current 가 mp4 입니다. 그것을 기반 이미지로 내밀면
   * asInit 이 읽다 죽고 「이미지를 읽을 수 없습니다」만 남습니다 — 그림이 깨진 것처럼
   * 읽히지만 실은 영상을 고른 것입니다. 위의 faceOf·keyVisualIn 과 같이 걸러 둡니다
   */
  const cur = liveVer(panel)
  if (cur && !isVideoSrc(srcOf(cur.ver))) {
    out.push({
      key: 'current', label: `현재 v${cur.i + 1}${cur.ver.source === 'upload' ? ' (스케치)' : ''}`,
      src: srcOf(cur.ver), sketch: cur.ver.source === 'upload',
    })
  }
  return out
}

/*
 * 고른 기반 이미지가 무엇인가. 서버는 그림을 init 한 칸으로만 받아서 스케치와 얼굴과
 * 키비주얼을 구별하지 못합니다(server.py 의 build). 말해 주지 않으면 얼굴에게도
 * 「같은 구도와 카메라를 유지하라」가 붙어, 컷이 바뀌어도 그 얼굴 사진이 그대로 나옵니다.
 */
function refKindOf(choice) {
  if (choice.key === 'cast') return 'cast'
  if (choice.face || choice.key === 'anchor') return 'face'
  if (choice.sketch) return 'sketch'
  return 'image'
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
    /*
     * 502 는 CloudFront 가 GPU 를 못 만난 것이니 「꺼져 있습니다」가 맞습니다.
     * 504 는 만났지만 60초 안에 답을 못 받은 것입니다 — 앞사람 그림이 도는 중이면 이렇게
     * 됩니다. 이때 「꺼져 있습니다」라고 하면 사람은 켜러 갑니다(이미 켜져 있습니다).
     * 500 은 서버가 살아서 답한 것입니다.
     */
    const err = new Error(json.detail || (res.status === 502
      ? `생성 서버가 꺼져 있습니다 (502). GPU를 켜면 그림 외의 기능은 그대로 씁니다`
      : res.status === 504
        ? '생성 서버가 60초 안에 답하지 못했습니다 (504). 앞사람 그림이 도는 중일 수 있습니다.'
          + ' 잠시 뒤 다시 눌러주세요'
        : res.status >= 500
          ? `그림을 만들다 서버에서 끊겼습니다 (${res.status}). 잠시 뒤 다시 눌러주세요`
          : `생성 서버 오류 (${res.status})`))
    // 503 은 「지금은 안 되지만 곧 된다」는 뜻입니다. 부른 쪽이 기다릴지 말지 고르게 합니다
    err.status = res.status
    throw err
  }
  return json
}

/*
 * 그림 모델과 영상 모델은 GPU 한 대를 나눠 씁니다. 「영상으로 생성」을 쓴 뒤 여기서 그림을
 * 만들면, 서버가 그림 모델을 다시 올리는 동안 503 을 줍니다(server.py 의 /gen).
 * 그때 사람이 1~2분 뒤 다시 누르게 하지 않고, 준비되는 것을 보고 우리가 다시 넣습니다.
 *
 * 기계가 꺼져 있으면 health 자체가 안 됩니다. 그때는 기다리지 않고 돌아섭니다 —
 * 부른 쪽이 원래의 503 사유를 그대로 보여줍니다.
 * @returns {Promise<boolean>} 다시 넣어 볼 만해졌는지
 */
async function genHealth() {
  try {
    return await (await fetch(`${cfg.genUrl}/health`, { cache: 'no-store' })).json()
  } catch {
    return null
  }
}

/*
 * 503 을 받았을 때 기다려 볼 만한지. 기계가 꺼져 있거나(=health 자체가 안 됨), 이 모델의
 * 사유가 이미 나와 있거나, 영상 일감이 GPU 를 쥐고 있으면 기다려도 오지 않습니다.
 *
 * 영상 일감이 있을 때 그림 모델은 올라오기 시작조차 안 합니다(server.py 의 vid_pending 이
 * /gen 과 /gen/load 를 함께 막습니다). 그래서 「준비되면 자동으로 다시 만듭니다」를 적기
 * 전에 이것을 먼저 봅니다 — 안 그러면 다른 사람 화면에도 「만드는 중」이 떴다가, 우리는
 * 기다리지도 않고 바로 사유로 바뀝니다.
 */
function worthWait(j, want) {
  if (!j || j.video?.busy) return false
  // 사유가 다른 모델의 것이면 이 기다림과 상관이 없습니다(server.py 의 errorModel)
  if (j.error && (!j.errorModel || j.errorModel === want)) return false
  return true
}

async function waitModel(want) {
  for (let i = 0; i < 36; i++) {
    const j = await genHealth()
    if (!worthWait(j, want)) return false
    if (j.warm && !j.loading && j.modelId === want) return true
    await new Promise((r) => setTimeout(r, 5000))
  }
  return false
}

/*
 * 커넥터로 한 장 만듭니다. askGpu 와 돌려주는 모양이 같습니다({url, model, seed, ms}).
 * 다른 점은 길입니다 — GPU 의 /gen 대신 AppSync 를 지나 Lambda 가 밖의 제공자를 부릅니다.
 * 그래서 GPU 가 꺼져 있어도 됩니다.
 */
const conn = connectorClient()

async function loadConnModels() {
  if (!conn) return
  try {
    const got = await conn.list()
    connModels = (got?.providers || []).flatMap((p) => p.models || [])
  } catch (err) {
    // 커넥터를 못 읽어도 GPU 모델은 그대로 씁니다
    console.warn('[board] 커넥터 목록을 읽지 못했습니다', err.message)
  }
  renderGpu()
  renderDetail()
}

async function generate(panel, again = false) {
  if (!canGen && !isConn(pickedModel)) return generateLocal(panel)
  const o = optsFor(panel)
  const ch = charOf(panel)
  const choice = refChoices(panel).find((c) => c.key === refKeyOf(panel)) || { key: 'none' }
  const prompt = (o.prompt ?? autoPrompt(panel)).trim()

  emit({ kind: 'panel.patch', panelId: panel.id, fields: { generating: me.id, genAt: now(), genError: null } })
  try {
    // 얼굴 여럿을 고른 컷은 여기서 한 장으로 붙입니다. 그 밖은 고른 그림 하나입니다
    const src = choice.srcs ? await faceSheet(choice.srcs) : choice.src
    const init = choice.key === 'none' ? null : await asInit(src)
    /*
     * 참조 자산. 고른 것이 있으면 그 그림들이 앞에 가고 기반 이미지는 뒤에 한 장 붙습니다
     * (server.py 의 refs_of). 자산이 있을 때의 앞말은 「자산들로 새 구도」(ASSETS)입니다.
     */
    const assetIds = assetIdsOf(panel)
    const refs = assetIds.length ? await Promise.all(assetIds.map((id) => asInit(assetSrc(state.assets[id])))) : null
    const body = {
      prompt,
      kind: panel.charId ? 'pose' : 'cut',
      model: modelFor(!!(init || refs)),
      seed: ch?.seedNo ?? null,
      init,
      refs,
      refKind: refs ? 'assets' : init ? refKindOf(choice) : null,
      strength: o.strength,
    }
    const r = isConn(pickedModel) ? await conn.gen(body) : await askGpu(body)
    emit({
      kind: 'panel.version', panelId: panel.id,
      version: {
        n: (panel.versions?.length || 0) + 1,
        src: r.url, source: init ? 'sketch' : 'ai', author: me.id, ts: now(), prompt,
        gen: { model: r.model, seed: r.seed, ms: r.ms, ref: refs ? 'assets' : choice.key, strength: init ? o.strength : null },
        refFrom: choice.from ? { panelId: choice.from.panelId, n: choice.from.n, pose: choice.from.pose } : null,
        ...(refs ? { assets: assetIds } : {}),
      },
    })
  } catch (err) {
    // 모델을 올리는 중이라 503 이면, 사유를 적어 두고 준비될 때까지 기다린 뒤 한 번만 다시.
    // 영상 일감 때문의 503 이면 기다리지 않습니다(worthWait) — 사유를 그대로 보여줍니다
    const want = modelFor(refKeyOf(panel) !== 'none' || assetIdsOf(panel).length > 0)
    if (err.status === 503 && !again && !isConn(want)
        && worthWait(await genHealth(), want)) {
      emit({
        kind: 'panel.patch', panelId: panel.id,
        fields: { generating: me.id, genAt: now(), genError: `${err.message} 준비되면 자동으로 다시 만듭니다.` },
      })
      pollGpu()
      if (await waitModel(want)) return generate(panel, true)
    }
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

/* ── 컷을 영상으로 ───────────────────────────────────────────────────────────── */

/*
 * 승인된 컷 한 장을 짧은 영상으로 만듭니다(services/animate.js → server.py 의 /gen/animate).
 *
 * 예전에는 이 일이 「영상화」라는 별 화면이었습니다. 그 화면은 보드의 컷을 다시 읽어
 * 목록으로 늘어놓고, 만든 영상을 다시 op 로 보드에 붙였습니다 — 같은 컷을 두 화면이 각자
 * 그리는 셈이라, 어느 컷이 승인됐고 누가 담당인지가 그쪽에서는 보이지 않았습니다. 이제
 * 컷을 보고 있는 자리에서 바로 누릅니다.
 *
 * 승인된 컷만입니다. 영상은 그림 한 장을 첫 프레임으로 늘리는 일이라, 아직 고칠 그림으로
 * 만들면 그 시간(30초~4분)과 GPU 자리를 버립니다. 감독의 승인이 「이 그림으로 간다」는
 * 표시이므로 그것을 문으로 씁니다.
 *
 * 결과는 그 컷의 다음 버전으로 붙습니다(source: 'video'). 판에 새 칸을 만들지 않아서
 * 히스토리·버전 칩·뷰어가 이미 그것을 압니다(activity-log.js · VER_SRC · media).
 */

/* 만드는 동안의 진행 한 줄. 판에 남길 것이 아니라 누른 사람 화면만의 것입니다 */
const clipWork = new Map()

/*
 * /health 의 영상 칸(server.py 의 VSECS·VQ·EST). 길이·화질은 서버가 실측해서 정해 둔 것만
 * 고를 수 있습니다 — 서버가 안 받는 값을 화면이 내밀면 400 이 옵니다. 아직 못 물어봤을
 * 때만 아래 기본값을 씁니다.
 */
let vinfo = null
const clipSecs = () => (vinfo?.secs?.length ? vinfo.secs : [2, 3, 5])
const clipQual = () => (vinfo?.quality?.length ? vinfo.quality
  : [{ id: 'fast', label: '빠르게 · 832×480' }, { id: 'fine', label: '곱게 · 1280×704' }])
/* 고른 길이와 화질. 컷마다 따로 둘 만한 것이 아니라 이 사람의 손버릇입니다 */
const clipOpts = { secs: 3, quality: 'fast' }

/** 얼마나 걸릴지. 초당 걸리는 시간(est)은 서버만 아는 값입니다 */
function clipEta() {
  const q = clipQual().find((x) => x.id === clipOpts.quality)
  return q?.est ? Math.round(q.est * clipOpts.secs) : 0
}

/**
 * 이 컷의 첫 프레임이 될 그림. 이미 영상을 붙인 컷은 그 앞의 그림을 씁니다 — 영상을
 * 다시 영상으로 넣으면 서버가 읽다 죽습니다.
 */
function stillOf(panel) {
  const cur = liveVer(panel)
  if (cur && !isVideoSrc(srcOf(cur.ver))) return srcOf(cur.ver)
  const live = (panel.versions || []).filter((v) => !deadVer(panel, v))
  for (let i = live.length - 1; i >= 0; i--) {
    const src = srcOf(live[i])
    if (src && !isVideoSrc(src)) return src
  }
  return null
}

/** 이 컷을 영상으로 만들 수 있는지. 못 하면 그 이유 한 줄입니다 */
function whyNotClip(panel) {
  if (!canAnimate()) return '이 배포에는 생성 서버가 없습니다'
  if (panel.charId) return '인물 구도는 영상으로 만들지 않습니다. 컷에서 누르세요'
  if (panel.status !== 'approved') {
    return `${STATUS[panel.status].label} 상태입니다. 감독이 이미지를 승인하면 영상으로 만들 수 있습니다`
  }
  if (!stillOf(panel)) return '먼저 이미지가 있어야 합니다'
  if (clipWork.has(panel.id)) return '이미 영상을 만들고 있습니다'
  if (genBy(panel)) return '이 컷을 만들고 있습니다. 끝나면 눌러주세요'
  return ''
}

/*
 * 503 을 받은 뒤 기다립니다. 사유는 둘입니다 — 영상 모델을 올리는 중이거나 다른 컷을
 * 만드는 중입니다. 둘 다 조금 뒤에는 되므로 사람이 같은 단추를 다시 누르게 하지 않습니다.
 * 기계가 꺼져 있으면 /health 가 아예 안 되니 그때는 그 자리에서 돌아섭니다 — 부른 쪽이
 * 원래의 사유를 그대로 보여줍니다(없어진 영상화 화면의 waitWarm 과 같은 규칙입니다).
 */
async function waitVideo(tick) {
  for (let i = 0; i < 60; i++) {
    const h = await videoHealth().catch(() => null)
    if (!h) return false
    if (h.video) vinfo = h.video
    // 영상 모델을 올리다 엎어졌으면 아무도 다시 올리지 않습니다. 기다려도 오지 않습니다
    if (h.error && (!h.errorModel || h.errorModel === h.video?.id)) { tick(`생성 서버: ${h.error}`); return false }
    if (h.video?.id && h.modelId === h.video.id && !h.video.busy) return true
    tick(h.video?.busy
      ? '다른 컷을 만들고 있습니다. 자리가 나면 이어서 넣습니다…'
      : `영상 모델을 올립니다${h.wait ? ` · 약 ${Math.round(h.wait)}초 남음` : ''}…`)
    await new Promise((r) => setTimeout(r, 5000))
  }
  return false
}

async function animate(panel) {
  const why = whyNotClip(panel)
  if (why) { notice(why); return }

  const tick = (t) => { clipWork.set(panel.id, t); renderDetail() }
  tick('보냅니다…')
  /*
   * 그림 생성과 같은 칸(generating)을 씁니다. 영상 모델이 올라오면 그림 모델은 내려가서
   * (server.py 의 _unload) 그 동안 이 GPU 로는 그림도 못 만듭니다. 같은 칸에 적어 두면
   * 남의 화면에서도 「○○ 생성 중」으로 보여 두 사람이 같은 GPU 를 동시에 부르지 않습니다.
   */
  emit({ kind: 'panel.patch', panelId: panel.id, fields: { generating: me.id, genAt: now(), genError: null } })

  const t0 = performance.now()
  const prompt = cutPrompt(panel)
  const body = { still: stillOf(panel), prompt, secs: clipOpts.secs, quality: clipOpts.quality }
  try {
    let out
    try {
      out = await runClip(body, { onTick: (s) => tick(clipHint(s)) })
    } catch (err) {
      if (err.status !== 503) throw err
      tick(err.message)
      if (!await waitVideo(tick)) throw err
      out = await runClip(body, { onTick: (s) => tick(clipHint(s)) })
    }
    clipWork.delete(panel.id)
    emit({
      kind: 'panel.version', panelId: panel.id,
      version: {
        n: (panel.versions?.length || 0) + 1,
        src: out.url, source: 'video', author: me.id, ts: now(), prompt,
        gen: {
          model: vinfo?.id || 'wan', seed: out.seed ?? null,
          ms: out.ms ?? Math.round(performance.now() - t0), ref: 'gpu', strength: null,
        },
      },
    })
    announce(`${labelOf(panel)} · 영상이 나왔습니다.`)
  } catch (err) {
    clipWork.delete(panel.id)
    emit({ kind: 'panel.patch', panelId: panel.id, fields: { generating: false, genError: err.message } })
  }
}

/* ══ 자산 — 승인된 컷에서 인물·배경·소품을 떼어 둡니다 ═══════════════════════════════
 *
 * 무엇을 뽑는지는 domain/panels.js 의 assetJobs 가 정하고, 어떻게 그리는지는 server.py 의
 * ISOLATE 가 정합니다. 여기는 그 둘을 이어 부르고 결과를 op(asset.add)로 남기는 자리입니다.
 */

const assetWork = new Map()   // panelId → 진행 한 줄. 이 브라우저에서 뽑는 것만 압니다
const assetList = () => Object.values(state.assets || {}).sort((a, b) => (a.ts || 0) - (b.ts || 0))
/*
 * 「컷의 참조로 내밀 수 있는 자산」을 세던 refAssets 가 나갔습니다. 그 목록을 칩으로 늘어놓고
 * 켜고 끄는 줄이 컷 판에 있었는데, 무엇을 참조할지는 autoAssets 가 잡습니다(renderDetail 의
 * assetIds). 자산을 골라 하나로 합치는 일은 자산관리 화면의 것입니다.
 */
const assetsFrom = (panelId) => assetList().filter((a) => a.fromPanelId === panelId)
const mayExtract = () => allowed('extract', roleOf(me.id))
/** 참조로 쓸 수 있는 그림. 영상은 참조가 못 됩니다(faceOf 와 같은 이유) */
const assetSrc = (a) => (a?.src && !isVideoSrc(a.src) ? a.src : null)

/** 이 컷에서 자산을 뽑을 수 있는지. 못 하면 그 이유 한 줄입니다 */
function whyNotExtract(panel) {
  if (!canGen) return '이 배포에는 생성 서버가 없습니다'
  if (panel.charId) return '인물 구도에서는 뽑지 않습니다. 인물은 기준 이미지가 그 역할입니다'
  if (panel.status !== 'approved') {
    return `${STATUS[panel.status].label} 상태입니다. 감독이 승인하면 그 그림에서 뽑습니다`
  }
  if (!stillOf(panel)) return '먼저 이미지가 있어야 합니다'
  if (!mayExtract()) return denyReason('extract', roleOf(me.id))
  if (assetWork.has(panel.id)) return '이미 뽑고 있습니다'
  if (genBy(panel)) return '이 컷을 만들고 있습니다. 끝나면 눌러주세요'
  return ''
}

/*
 * 그림을 조건으로 받는 모델. 자산 뽑기는 「이 그림 속 이것만」이라 참조를 조건으로 받아야
 * 합니다. img2img 갈래(chroma·sd3)는 그림을 지우고 다시 그려서 다른 사람이 나옵니다.
 * 화면이 고른 모델과 상관없이 이것으로 뽑습니다. 목록에 없으면 서버 기본(klein)에 맡깁니다.
 */
const keepModelId = () => (gpuRef && gpuModels.some((m) => m.id === gpuRef) ? gpuRef
  : gpuModels.find((m) => m.strength === false && m.init !== false)?.id ?? null)

/*
 * 이 요청을 실제로 그릴 모델. 고른 모델이 그림을 받지 않으면(Krea 2 Turbo — /health 의
 * init:false) 참조가 있는 요청은 조건으로 받는 모델(klein)로 보냅니다. 그렇지 않으면 참조를
 * 골라 놓고도 글만 보고 그린 그림이 나와, 참조가 고장난 것처럼 보입니다.
 */
function modelFor(hasRef) {
  const m = modelOf(pickedModel)
  if (hasRef && m && m.init === false && !isConn(m.id)) return keepModelId() ?? pickedModel
  return pickedModel
}

/** 503 이면 모델이 올라올 때까지 한 번 기다린 뒤 다시 보냅니다. 그 밖은 그대로 던집니다 */
async function askGpuPatient(body, tick) {
  try {
    return await askGpu(body)
  } catch (err) {
    if (err.status !== 503 || !worthWait(await genHealth(), body.model)) throw err
    tick(`${err.message} 준비되면 이어서 뽑습니다.`)
    pollGpu()
    if (!await waitModel(body.model)) throw err
    return askGpu(body)
  }
}

/**
 * 승인된 컷 한 장에서 인물(출연자마다)·배경·상품을 따로 그려 자산으로 둡니다.
 *
 * 같은 컷에서 같은 것을 다시 뽑으면 그 자산의 그림을 갈아 끼웁니다(asset.patch). 자산이
 * 두 배로 늘지 않고, 그것을 참조로 고른 컷도 다음 생성부터 새 그림을 받습니다.
 *
 * @param {object} panel
 * @param {{auto?: boolean}} [o] - auto 는 승인 직후 자동으로 온 것. 못 할 때 말없이 돌아갑니다
 */
async function extractAssets(panel, { auto = false } = {}) {
  const why = whyNotExtract(panel)
  if (why) { if (!auto) notice(why); return }
  const jobs = assetJobs(panel, state.chars)
  const tick = (t) => { assetWork.set(panel.id, t); renderDetail() }
  tick('승인된 그림을 읽습니다…')
  // 그림 생성과 같은 칸(generating)입니다. 남의 화면에 「○○ 생성 중」으로 보여 같은 GPU 를 겹쳐 부르지 않습니다
  emit({ kind: 'panel.patch', panelId: panel.id, fields: { generating: me.id, genAt: now(), genError: null } })
  const fromN = (liveVer(panel)?.i ?? 0) + 1
  const model = keepModelId()
  const failed = []
  let made = 0
  try {
    const init = await asInit(stillOf(panel))
    for (const [i, j] of jobs.entries()) {
      tick(`${ASSET_TYPES[j.type]} · ${j.name} (${i + 1}/${jobs.length})…`)
      try {
        const r = await askGpuPatient(
          { prompt: j.prompt, kind: j.kind, model, refs: [init], refKind: j.refKind, strength: 0.95 }, tick)
        const gen = { model: r.model, seed: r.seed ?? null, ms: r.ms ?? null }
        const prev = assetsFrom(panel.id).find((a) => a.type === j.type && (a.charId ?? null) === (j.charId ?? null))
        if (prev) {
          emit({ kind: 'asset.patch', assetId: prev.id, fields: { src: r.url, fromN, gen, ts: now() } })
        } else {
          emit({
            kind: 'asset.add',
            asset: {
              id: uid(), type: j.type, name: j.name, charId: j.charId ?? null, src: r.url,
              fromPanelId: panel.id, fromN, author: me.id, ts: now(), gen,
            },
          })
        }
        made += 1
      } catch (err) {
        failed.push(`${j.name}: ${err.message}`)
        // 서버가 꺼졌거나 권한이 없으면 나머지도 같은 사유입니다. 셋을 다 기다리게 하지 않습니다
        if ([502, 503, 401, 403].includes(err.status)) break
      }
    }
  } catch (err) {
    failed.push(err.message)
  }
  assetWork.delete(panel.id)
  emit({
    kind: 'panel.patch', panelId: panel.id,
    fields: { generating: false, genError: failed.length ? `자산 뽑기 · ${failed[0]}` : null },
  })
  if (made) announce(`${labelOf(panel)} · 자산 ${made}개를 자산관리에 넣었습니다.`)
  if (failed.length) notice(`${labelOf(panel)} · 자산 ${failed.length}개를 못 뽑았습니다. ${failed[0]}`)
}

/*
 * 자산 칩 한 장을 그리던 assetCard 가 나갔습니다. 컷의 참조 자산 줄에서만 쓰던 것이고
 * (위 refAssets), 그 줄이 없어졌습니다. 자산을 눈으로 보고 고르는 화면은 자산관리입니다.
 */

let fastPoll = null
async function pollGpu() {
  if (!canGen) return
  try {
    const r = await fetch(`${cfg.genUrl}/health`, { cache: 'no-store' })
    const j = await r.json()
    /*
     * 영상 모델(wan)은 「영상으로 생성」의 것입니다. 같은 GPU 에 올라오기 때문에 /health
     * 목록에 섞여 오지만, 그림을 그리는 데 쓸 수는 없습니다 — server.py 의 pick() 도 그림
     * 모델로 되돌립니다. 걸러 두지 않으면 영상을 한 번 만든 뒤 이 화면이 「지금 그리는
     * 모델: 컷을 영상으로」라고 말하고, 503 뒤의 자동 대기가 영원히 오지 않는 wan 을
     * 기다립니다. 대신 그 칸은 vinfo 로 따로 받습니다 — 길이·화질 목록이 거기 있습니다.
     */
    gpuModels = (j.models || []).filter((m) => !m.video)
    gpuRef = j.ref || null
    vinfo = j.video || null
    /*
     * 영상 모델이 올라와 있으면 이 화면에는 「올라온 그림 모델이 없다」와 같습니다. 그대로
     * 두면 단추가 「Wan2.2 TI2V 5B」라고 말하고, 모델 칩 어디에도 「지금 올라옴」이 없습니다.
     */
    const resident = gpuModels.some((m) => m.id === j.modelId) ? j.modelId : null
    /*
     * 처음 고르는 모델. 올라온 것이 있으면 그것을 쓰고, 없으면 서버가 말하는 기본 모델
     * (j.default)입니다. 목록의 첫 줄로 되돌리면 영상화를 다녀온 뒤 기본과 다른 모델이
     * 올라가고, 사람은 고른 적도 없는 모델을 1분 넘게 기다립니다.
     */
    if (!pickedModel) {
      pickedModel = [j.loading, resident, j.default].find((id) => gpuModels.some((m) => m.id === id))
        || gpuModels[0]?.id || null
    }
    /*
     * 영상 모델을 올리다 엎어진 사유는 이 화면의 것이 아닙니다. 그대로 읽으면 그림은
     * 멀쩡한데 「생성 서버 오류」로 보입니다(server.py 의 errorModel)
     */
    const err = j.error && (!j.errorModel || gpuModels.some((m) => m.id === j.errorModel)) ? j.error : null
    gpu = err ? { state: 'error', text: '생성 서버 오류', hint: err, resident }
      : j.loading ? {
        state: 'warm', text: '모델 올리는 중', resident, loading: j.loading,
        hint: `${modelOf(j.loading)?.label || j.loading} · 약 ${mins(j.wait)}분`,
      }
        : !j.warm ? { state: 'warm', text: '모델 올리는 중', hint: '첫 부팅은 몇 분 걸립니다' }
          : {
            state: j.busy ? 'busy' : 'ok',
            text: j.busy ? '생성 중' : resident ? j.model : modelOf(pickedModel)?.label || j.model,
            resident,
            hint: resident ? j.gpu || ''
              : '지금은 영상 모델이 올라와 있습니다. 만들기를 누르면 그림 모델을 올립니다.',
          }
    clearTimeout(fastPoll)
    if (j.loading) fastPoll = setTimeout(pollGpu, 4000)
  } catch {
    // 업무 시간 밖이면 꺼져 있는 것이 정상입니다. 시간표와 다음에 켜지는 때를 적습니다
    gpu = { state: 'down', text: '생성 서버 연결 안 됨', hint: gpuDownHint() }
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
  // 커넥터 모델은 올릴 것이 없습니다. GPU 에 /load 를 보내면 모르는 모델이라고 400 이 옵니다
  if (id === gpu.resident || isConn(id)) return
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
      ${rep ? `<p class="attach"><b>${esc(person(rep.author)?.name || '')}</b>에게 답글:
        ${esc(rep.body.slice(0, 24))}${rep.body.length > 24 ? '…' : ''}
        <button class="mini" data-unreply="1">취소</button></p>` : ''}
      ${pending.pin || marks ? `<p class="attach">그림 위 표시 붙음:
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
    ch ? `${state.board.title} · ${ch.name}`
      : (many ? `${state.board.title} · ${epLabel(ep)}` : state.board.title),
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

  /*
   * 인물을 골랐을 때만 그 아래 설정 칸을 폅니다. 컷 보드를 보는 중에는 고칠 인물이
   * 없습니다.
   *
   * 컷이 하나도 없으면 스토리보드 칸에 「어디서 만들어 오는지」를 적습니다. 예전에는 이
   * 기둥에 「시나리오를 컷으로」 단추가 있어서 빈 목록도 다음 할 일을 가리켰습니다. 그
   * 단추가 나갔으므로 그 말을 글로 남깁니다 — 빈 목록만 두면 화면이 고장난 것으로 보입니다.
   */
  byId('boardWhy').hidden = cutsOf(viewEp).length > 0
  byId('charMeta').hidden = viewChar === null
  if (viewChar !== null) {
    const ch = state.chars[viewChar]
    if (document.activeElement !== byId('nameIn')) byId('nameIn').value = ch?.name || ''
    if (document.activeElement !== byId('briefIn')) byId('briefIn').value = ch?.brief || ''
  }
}



/*
 * 「내 작업」은 왼쪽 기둥에서 뺐습니다.
 *
 * 내게 넘어온 것을 알려 주는 자리가 둘이었습니다 — 이 목록과 머리 띠의 알림입니다. 담당이
 * 바뀌면 알림이 한 줄 오고(notifFor 의 assign), 그 줄을 누르면 그 컷으로 갑니다. 목록이
 * 하는 일과 같은데 목록은 기둥의 아래쪽에 있어서, 컷을 고치는 동안에는 눈에 들어오지도
 * 않았습니다. 셈은 알림 배지가 대신합니다.
 *
 * 상태가 approved 가 아닌 내 담당을 세는 계산 자체는 관리 창의 「기여도」 장에 있습니다
 * (creditHtml 의 workload). 거기서는 나뿐 아니라 팀 전체를 같은 표로 봅니다.
 */

// ── 관리 ─────────────────────────────────────────────────────────────────────
/*
 * 세 장입니다. 「로그」는 이 판에서 무슨 일이 있었는지, 「기여도」는 누가 얼마나 했는지,
 * 「권한」은 누가 무엇을 할 수 있는지입니다.
 *
 * 예전에는 업무 배정판(지표 다섯 칸 + 판 한눈에 + 컷 스트립)과 팀 현황(사람별 막대 +
 * 시간별 막대 + 단계 이동 순위)이 두 장에 얹혀 있었습니다. 한 화면에서 여섯 가지를
 * 보여주니 정작 감독이 묻는 「누가 무엇을 했나」가 어디 있는지 찾기 어려웠습니다.
 * 배정은 컷을 열면 그 자리에서 하는 편이 빠르고(담당 고르기), 지표는 판 위쪽의 진행
 * 줄이 이미 말해 줍니다. 그래서 이 화면은 사람과 기록만 봅니다.
 *
 * 권한 판은 perm.js 가 그립니다. 같은 판이 다른 세 화면에서는 창으로 열립니다.
 */
let adminTab = 'log'
let adminWho = null
let adminSay = ''
let permTab = 'role'
let permWho = null

/**
 * @param {boolean} on
 * @param {string} [tab] - 열면서 갈아탈 장. 탭 바의 「권한 관리」가 'perm' 을 넘깁니다
 */
function openAdmin(on, tab) {
  const dlg = byId('admin')
  if (tab) adminTab = tab
  // 로그와 기여도는 관리 권한이 있어야 봅니다. 권한 판은 막힌 사람도 봐야 합니다 —
  // 무엇이 왜 막혔는지 읽는 화면이 그것이기 때문입니다(고치기는 감독·관리자만)
  if (on && adminTab !== 'perm' && !may('admin')) { notice(`${whyNot('admin')}. ${ASK}.`); return }
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
  for (const b of dlg.querySelectorAll('[data-tab]')) {
    b.dataset.on = b.dataset.tab === adminTab ? '1' : '0'
    // 관리 권한이 없으면 로그·기여도는 잠깁니다. 감추지 않는 이유는 눌러 보고 이유를
    // 들을 수 있어야 하기 때문입니다(perm.js 의 watchNope)
    const blocked = b.dataset.tab !== 'perm' && !may('admin')
    if (blocked) {
      b.setAttribute('aria-disabled', 'true')
      b.dataset.nope = whyNot('admin')
    } else {
      b.removeAttribute('aria-disabled')
      delete b.dataset.nope
    }
  }
  setHtml(byId('admBody'), adminTab === 'log' ? logHtml() : adminTab === 'credit' ? creditHtml() : permHtml())
  if (adminTab === 'log') paintAdminLog()
}

/** 로그 한 장. 누가 무엇을 했는지 시간 순으로, 사람으로 좁혀 볼 수 있습니다 */
function logHtml() {
  const list = roster()
  const n = (id) => journal.filter((op) => op.actor === id).length
  return `
    <p class="adm__lead">이 판에서 일어난 일을 최근 것부터 봅니다. 줄을 누르면 그 컷으로 갑니다.
      <span class="adm__sep">·</span>기록 ${journal.length}건</p>
    <div class="adm__filters">
      <button class="adm__tab" data-who="" data-on="${adminWho ? 0 : 1}">모두 <b>${journal.length}</b></button>
      ${list.map((u) => `
        <button class="adm__tab" data-who="${u.id}" data-on="${adminWho === u.id ? 1 : 0}">
          ${esc(u.name)} <b>${n(u.id)}</b></button>`).join('')}
    </div>
    <div id="admLog"></div>
    <p class="adm__note">이 화면이 켜져 있는 동안 들어온 것과 열 때 받아 온 것까지 최근 ${JOURNAL_MAX}건을 들고 있습니다.
      컷 하나의 기록은 그 컷을 열면 아래쪽에 따로 있습니다.</p>`
}

function paintAdminLog() {
  paintList(byId('admLog'), group(entries(journal, {
    who: (id) => person(id),
    actor: adminWho,
    limit: 60,
  })), {
    showStep: true,
    none: adminWho ? `${person(adminWho)?.name || adminWho}가 한 일이 아직 없습니다.` : '아직 기록이 없습니다.',
    onPick: (e) => {
      if (e.refKind && e.refKind !== 'panel') { announce('그 줄은 이어서 갈 컷이 없습니다.'); return }
      const p = state.panels[e.ref]
      if (!p) { announce('그 컷은 지금 보드에 없습니다.'); return }
      viewChar = p.charId ?? null
      if (!p.charId) viewEp = p.epId ?? null
      selectedId = e.ref
      openAdmin(false)
      save()
      render()
      byId('detail')?.scrollIntoView({ block: 'nearest' })
    },
  })
}

/**
 * 기여도 한 장. 사람마다 얼마나 들고 있고 얼마를 끝냈는지입니다.
 *
 * 「많이 손댄 사람」이 아니라 「끝낸 것과 들고 있는 것」을 셉니다. 손댄 횟수는 같이
 * 보여주되 뒤에 둡니다. 앞에 두면 그 수를 늘리려고 컷을 여러 번 저장하게 됩니다.
 */
function creditHtml() {
  const at = now()
  const all = Object.values(state.panels)
  const list = roster()
  const load = workload(all, list.map((u) => u.id))
  const moved = actorPace(state.events, at)
  const touch = (id) => journal.filter((op) => op.actor === id).length
  list.sort((a, b) => (load[b.id]?.approved ?? 0) - (load[a.id]?.approved ?? 0)
    || (load[b.id]?.open ?? 0) - (load[a.id]?.open ?? 0)
    || a.name.localeCompare(b.name))
  const t = tally(all)
  const idle = all.filter(NEEDS.unassigned.hit)
  const rule = Math.max(1, ...list.map((u) => (load[u.id]?.open || 0) + (load[u.id]?.approved || 0)))

  return `
    <p class="adm__lead">
      컷 <b>${t.n}개</b> 중 승인 <b>${t.byStatus.approved || 0}개</b>
      <span class="adm__sep">·</span>
      ${idle.length ? `담당 없는 컷 <b>${idle.length}건</b>` : '모든 컷에 담당이 있습니다'}
    </p>
    <table class="tbl">
      <thead><tr>
        <th>사람</th><th>역할</th><th>맡은 몫</th>
        <th>승인</th><th>남은 일</th><th>오늘 옮김</th><th>손댄 횟수</th>
      </tr></thead>
      <tbody>${list.map((u) => {
        const w = load[u.id] || { open: 0, approved: 0, by: {}, cuts: [] }
        const mine = w.open + w.approved
        return `<tr>
          <td><span class="dot crew__dot" style="background:${u.color}"></span>
            ${esc(u.name)}${u.id === me.id ? ' (나)' : ''}</td>
          <td class="tbl__dim">${esc(ROLES[u.role] || u.role)}</td>
          <td><span class="tbl__wait mono" data-worst="0">${mine}컷
            <i style="width:${pct(mine, rule)}%" aria-hidden="true"></i></span></td>
          <td><b>${w.approved}</b></td>
          <td>${w.open ? `${w.open} <span class="tbl__dim">(작업 ${w.by.in_progress || 0} · 리뷰 ${w.by.in_review || 0} · 수정 ${w.by.changes_requested || 0})</span>` : '0'}</td>
          <td>${moved[u.id]?.n || 0}</td>
          <td class="tbl__dim">${touch(u.id)}</td>
        </tr>`
      }).join('')}</tbody>
    </table>
    <p class="adm__note">「맡은 몫」의 띠는 팀에서 가장 많이 든 사람(${rule}컷) 기준입니다.
      「손댄 횟수」는 이 화면이 들고 있는 최근 기록 안에서 센 것이라 판이 오래되면 실제보다 적게 보입니다.</p>

    ${idle.length ? `
      <h2 class="mono h" style="margin-top:22px">담당 없는 컷 <span class="count">${idle.length}</span></h2>
      <ul class="crew__cuts">
        ${idle.slice(0, 12).map((p) => `
          <li><button data-goto="${p.id}">
            <span class="mono crew__cut">${esc(labelOf(p))}</span>
            <span>${esc(whereOf(p))} · ${esc(STATUS[p.status].label)}</span>
          </button></li>`).join('')}
        ${idle.length > 12 ? `<li class="crew__none">그 외 ${idle.length - 12}건</li>` : ''}
      </ul>
      <p class="adm__note">컷을 열어 「담당」에서 사람을 고르면 그 사람에게 알림이 갑니다.</p>` : ''}`
}

/**
 * 권한 한 장. 표와 그 판은 perm.js 가 그리고, 팀원 등록과 역할 바꾸기는 여기 있습니다.
 * 셋이 한자리에 있는 이유는 세 가지가 같은 질문의 답이기 때문입니다 — 누가 무엇을 하는가.
 */
function permHtml() {
  const edit = mayManagePerms(me.role)
  const grant = may('grant')
  const team = roster()
  if (!permWho || !team.some((u) => u.id === permWho)) permWho = me.id
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

    <h2 class="mono h">사람과 역할 <span class="count">${team.length}</span></h2>
    <p class="adm__why">${grant
      ? '역할을 바꾸면 그 사람 화면의 권한이 그 자리에서 바뀝니다. 다시 로그인하지 않습니다.'
      : `역할을 지정하는 것은 ${ROLES.admin}입니다.`}</p>
    <table class="tbl">
      <thead><tr><th>사람</th><th>역할</th><th>맡은 컷</th></tr></thead>
      <tbody>${team.map((u) => {
        const mine = Object.values(state.panels).filter((p) => p.assignee === u.id).length
        return `<tr>
          <td><span class="dot crew__dot" style="background:${u.color}"></span>
            ${esc(u.name)}${u.id === me.id ? ' (나)' : ''}</td>
          <td>${grant ? `<select data-role="${u.id}" aria-label="${esc(u.name)} 역할">
            ${Object.entries(ROLES).map(([k, v]) =>
              `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>` : `<span class="mono">${esc(ROLES[u.role] || u.role)}</span>`}</td>
          <td class="tbl__dim">${mine}컷</td>
        </tr>`
      }).join('')}</tbody>
    </table>

    <h2 class="mono h" style="margin-top:22px">할 수 있는 일</h2>
    ${permPanelHtml(PM, { tab: permTab, who: permWho, edit, team })}`
}

/**
 * 칸 하나를 뒤집습니다. 뒤집은 값이 기본값과 같아지면 손질을 지웁니다 — 표에 손댄
 * 표시만 남으면 나중에 무엇이 기본값과 다른지 알 수 없습니다(perm.js 의 toggle).
 */
function togglePerm(scope, who, cap) {
  if (!mayManagePerms(me.role)) { notice(`권한 관리는 ${ROLES.director}·${ROLES.admin}의 일입니다. ${ASK}.`); return }
  const op = PM.toggle(scope, who, cap)
  if (!op) return
  emit(op)
  const label = scope === 'user' ? person(who)?.name || who : ROLES[who] || who
  const on = scope === 'user' ? may(cap, who) : mayRole(cap, who)
  announce(`${label}의 「${CAPS[cap].label}」${josa(CAPS[cap].label, '을', '를')} `
    + `${on ? '허용' : '막음'}으로 두었습니다.`)
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0)

function addMember() {
  const id = byId('admId').value.trim()
  const name = byId('admName').value.trim()
  const role = byId('admRole').value
  if (!id || !name) adminSay = '아이디와 이름을 모두 넣어주세요.'
  else if (scrub({ id }).id !== id) adminSay = '아이디에 쓸 수 없는 글자가 있습니다.'
  else {
    emit({ kind: 'member.set', member: { id, name, role, color: tint(id) } })
    adminSay = `${name}(${id}). ${ro(ROLES[role])} 명부에 올렸습니다.`
    announce(adminSay)
  }
  renderAdmin()
  byId('admId')?.focus()
}

/* ══ 온보딩 ════════════════════════════════════════ */

/**
 * 비어 있을 때의 한 줄. 무엇을 하면 되는지와 예시로 가는 길입니다.
 *
 * 예시 데이터는 서버에 남고 같은 보드를 보는 사람에게도 보입니다. push() 가
 * net.sendOp 을 부르기 때문입니다. 그 사실만은 아래에 적어 둡니다 — 눌러 보고 나서
 * 알게 되면 되돌릴 곳을 따로 찾아야 합니다. 되돌리는 곳은 관리 화면의 보드 비우기입니다.
 *
 * 예전에는 여기에 「처음 오셨나요?」 판이 떴습니다. 제목과 설명 석 줄과 큰 버튼 둘이 든
 * 카드가 컷이 들어올 자리를 차지했고, 정작 「무엇을 하면 되는지」는 이 화면이 평소에
 * 쓰는 빈 칸 안내(아래 board--empty)와 겹쳐 있었습니다. 그래서 그 안내에 예시로 가는
 * 길만 한 줄로 붙입니다.
 *
 * @param {boolean} viewChar - 지금 구도 판을 보고 있는지. 빈 칸의 말이 갈립니다
 */
function welcomePanel(viewChar) {
  return emptyHint({
    text: viewChar
      ? '구도가 없습니다. 아래 버튼으로 추가하시거나,'
      // 「왼쪽에 시나리오를 넣고 컷으로 분해」였습니다. 그 칸과 단추가 나갔습니다
      : '컷이 없습니다. 위의 「스토리 디벨롭」에서 이야기를 컷으로 나누시거나,',
    exampleLabel: '예시로 보기',
    onExample: () => runExample(),
    note: '예시 내용은 이 보드에 실제로 저장되고 같은 보드를 보는 사람에게도 보입니다. '
      + '지우려면 관리 화면의 보드 비우기를 씁니다.',
  })
}

/*
 * 예시 안내를 시작합니다. 안내 자체는 app-walkthrough 에 있습니다. 그쪽은 이 파일을
 * import 할 수 없어서(../../app-walkthrough/tour.js 의 머리글) 쓸 것을 여기서 넣습니다.
 *
 * seedBuild 는 여기 남아 있습니다. 관리 화면의 「보드 비우기」도 같은 것을 쓰므로
 * 예시만 쓰는 것이 아닙니다.
 */
function runExample() {
  return boardExample({
    seedBuild, push, render, pickView,
    /*
     * 예시를 마칠 때 화면을 컷 보드로 돌려놓습니다. 예시가 인물 구도를 짚고 지나가므로
     * 그대로 두면 인물 판에서 끝납니다. 마지막 말은 「이제 컷을 눌러…」입니다.
     *
     * 왼쪽 기둥도 되돌립니다. 예시가 아래쪽 자리를 짚으며 굴려 놓아서 「스토리보드」
     * 목록이 화면 밖에 있습니다. 다시 그린 뒤에 되돌려야 높이가 정해져 있습니다.
     */
    showCuts: () => {
      setView(null)
      render()
      const col = byId('boardNav')?.closest('.pane--script')
      if (col) col.scrollTop = 0
    },
    // 인물 구도도 같은 panels 에 삽니다(charId 가 붙습니다). 컷만 셉니다
    cuts: () => Object.values(state.panels).filter((p) => !p.charId).length,
    selected: () => selectedId,
    /*
     * 예시를 마치면 끝입니다. 예전에는 여기서 코치마크 넉 장을 이어 열었습니다. 예시가
     * 이미 화면을 짚어 가며 다 보여준 뒤라, 끝났다고 생각한 사람에게 막이 한 번 더
     * 덮였습니다. 봤다고 적어 두는 이유는 coach.skip 에 있습니다.
     */
    afterDone: () => { coach.skip(COACH_KEY); render() },
  })
}

/*
 * 코치마크 넉 장. 지금 화면에 실제로 있는 것만 가리킵니다. 앵커가 없는 장은 coach.js 가
 * 조용히 건너뜁니다. 그래서 비어 있을 때 열면 왼쪽 기둥과 머리 띠만 나오고, 예시를 본
 * 뒤에 열면 컷과 상세까지 넉 장이 다 나옵니다.
 *
 * spot 은 CSS 선택자가 아니라 data-coach 이름입니다. components/coachmark.js 의 targets 가
 * `[data-coach="…"]` 로만 찾습니다 — app-walkthrough/guide.js 쪽은 선택자로도 찾아 주지만
 * 여기는 아닙니다. 이름을 안 맞추면 그 장이 소리 없이 사라져서 알아채기 어렵습니다.
 */
const BOARD_CARDS = [
  {
    /*
     * 「이야기 기획」·「시나리오를 컷으로」 두 단추를 짚던 장입니다. 둘 다 화면에서
     * 나갔으므로 이 장은 이제 왼쪽 기둥이 무엇으로 갈려 있는지만 말합니다.
     */
    head: '왼쪽은 「무엇을 볼지」입니다',
    body: '위 칸은 스토리보드, 아래 칸은 인물입니다.\n둘은 아예 다른 것이라 고르면 오른쪽도 딴 것이 뜹니다.\n컷은 위 탭 바의 「스토리 디벨롭」에서 나눠 옵니다.',
    spot: ['side-board', 'side-char'],
  },
  {
    head: '가운데가 보드입니다',
    body: '컷은 씬으로 묶이고 순서대로 시간이 매겨집니다.\n끌어서 순서를 바꿀 수 있습니다.',
    spot: ['board'],
  },
  {
    head: '오른쪽에서 한 컷을 다룹니다',
    body: '테를 두른 장이 여기서 하는 일입니다 — 이 컷을 그립니다.\n무엇으로 그리는지는 단추 아래 한 줄이 말해 줍니다.\n아래 버전·메모·기록은 그 결과를 보는 자리이고, 승인은 맨 아래 띠에 늘 붙어 있습니다.',
    spot: ['detail'],
  },
  {
    /*
     * 「내 작업」과 「지나간 일」을 짚던 장입니다. 둘 다 왼쪽 기둥에서 뺐으므로 그것들이
     * 지금 어디 있는지를 말합니다 — 없앤 것이 아니라 옮긴 것입니다.
     */
    head: '넘어온 일과 지나간 일',
    body: '내게 배정된 것은 머리 띠의 「알림」으로 옵니다.\n누가 무엇을 했는지는 「관리」의 로그 장에 남습니다.',
    spot: ['bell', 'admin'],
    next: '시작하기', skip: '다시 보지 않기',
  },
]

const COACH_KEY = 'sb.board.coach.v1'

function openCoach() {
  // 예시 안내 중에는 막을 덮지 않습니다. 짚은 자리를 사람이 실제로 눌러야 합니다
  if (guiding()) return
  coach.start({ cards: BOARD_CARDS, key: COACH_KEY, title: '스토리보드', onDone: render })
}

/*
 * 「지나간 일」도 왼쪽 기둥에서 뺐습니다. 관리 창의 「로그」 장이 같은 목록입니다
 * (logHtml · paintAdminLog).
 *
 * 두 곳이 같은 journal 을 같은 부품으로 그렸습니다(activity-log.js 의 entries·group +
 * components/history-list.js). 다른 것은 폭과 「내 것만」 토글뿐이었고, 창 쪽은 사람마다
 * 골라 볼 수 있어서 더 넓게 봅니다. 288px 기둥에서 40줄을 굴려 읽는 것이 이 기둥을
 * 복잡하게 만든 가장 큰 덩이였습니다.
 *
 * 줄을 눌러 그 컷으로 가는 길도 창 쪽에 있습니다 — paintAdminLog 의 onPick 이 창을 닫고
 * 그 컷을 엽니다. 여기 있던 것과 같은 동작입니다.
 */

function renderBoard() {
  const board = byId('board')
  const list = viewPanels()
  const starts = startTimes(list)
  const ch = viewChar ? state.chars[viewChar] : null
  board.className = `board${viewChar ? ' board--poses' : ''}`

  if (selectedId && location.hash !== `#cut=${selectedId}`) {
    history.replaceState(null, '', `#cut=${selectedId}`)
  }

  /*
   * 보드가 통째로 비어 있는 것과, 인물 하나에 구도가 없는 것은 다른 상황이다.
   * 앞쪽에만 예시로 가는 길을 한 줄 붙인다. 뒤쪽은 이미 판이 있고 한 칸이 빈 것이라
   * 여기서 예시를 권하면 하던 일을 밀어내는 셈이다.
   *
   * 아래 keep 루프가 board--empty 를 list 가 찼을 때 지우므로 이 줄도 같은 클래스를
   * 달고 있어야 예시가 들어오는 순간 알아서 사라진다.
   */
  // 예시 프로젝트로 들어온 것이면 이 줄을 띄우지 않는다. 같은 것을 두 번 묻는 셈이고,
  // render 가 runExample 보다 먼저 지나 한 프레임 깜빡인다
  const blank = !Object.keys(state.panels).length && !Object.keys(state.chars).length && !demoActive()
  if (!list.length) {
    if (blank) {
      if (!board.querySelector('.onbslot')) {
        setHtml(board, '')
        const slot = document.createElement('div')
        slot.className = 'board--empty onbslot'
        slot.append(welcomePanel(!!viewChar))
        board.append(slot)
      }
    } else {
      setHtml(board, viewChar
        ? '<div class="board--empty">구도가 없습니다. 아래 버튼으로 추가하세요.</div>'
        : '<div class="board--empty">컷이 없습니다. 위의 <b>스토리 디벨롭</b>에서 이야기를 컷으로 나누거나 아래 버튼으로 추가하세요.</div>')
    }
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
    if (node.classList.contains('board--empty')) {
      // 예시가 들어오면 「처음 오셨나요?」 판은 스스로 물러난다
      if (list.length || !blank) node.remove()
      continue
    }
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

    /*
     * 씬 머리줄. 이름·컷수·길이 옆에 그 씬의 키 비주얼을 한 장 세웁니다. 키비주얼
     * 화면에서 그린 씬 그림이 보드에서 그 씬의 기준 그림이 되는 자리입니다. 눌러서
     * 크게 볼 수 있게 컷의 「크게 보기」와 같은 data-open 계약을 씁니다.
     */
    if (row.scene) {
      const m = sceneMeta(row.scene.name)
      const kv = keyVisualIn(row.scene.name)
      el.className = 'scene'
      setHtml(el, `
        ${kv ? `<button class="scene__kv" data-open="${kv.panel.id}"
          title="이 씬의 키 비주얼 · 눌러서 크게 보기"><img src="${srcOf(kv.ver)}" alt="" loading="lazy"></button>` : ''}
        <span class="scene__name">${esc(m.no || m.where || '씬 없음')}</span>
        ${m.no && m.where ? `<span class="scene__where mono">${esc(m.where)}</span>` : ''}
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
    const from = originOf(p)
    const here = [...peers.values()].filter((q) => q.at === p.id)

    el.dataset.selected = p.id === selectedId ? '1' : '0'
    el.dataset.fresh = freshIds.has(p.id) ? '1' : '0'
    el.setAttribute('aria-label', `${labelOf(p)} · ${st.label}${who ? ` · 담당 ${who.name}` : ''}`)
    /*
     * 이 카드에서 영상이 돌고 있으면 속을 다시 만들지 않는다. setHtml 은 <video> 를 새 것으로
     * 갈아치우고 새 것은 0초에서 멈춘 상태다 — 재생을 누른 사람에게는 눌러도 아무 일도
     * 일어나지 않는 것으로 보인다. 남이 접속하거나 컷을 하나 고를 때마다 여기를 지난다.
     * 겉의 표시(선택·변경·이름표)는 바로 위에서 이미 새로 붙였으므로 어긋나지 않는다.
     */
    if ([...el.querySelectorAll('video')].some((v) => !v.paused && !v.ended)) return
    setHtml(el, `
      <div class="cut__frame">
        ${ver ? media(srcOf(ver), `alt="${esc(labelOf(p))} 이미지" loading="lazy"`) : '<div class="cut__empty">비어 있음<br>스케치 또는 생성</div>'}
        ${busyBy ? `<div class="cut__gen"><div class="spin"></div>${esc(busyBy.name)} 생성 중</div>` : ''}
        ${isRef ? '<span class="cut__ref">기준</span>' : ''}
        ${ver ? `<button class="cut__zoom" data-open="${p.id}" title="크게 보고 그림 위에 표시">크게 보기</button>` : ''}
        <div class="stamp stamp--${st.tone}">${esc(st.label)}</div>
      </div>
      <div class="cut__bar">
        <span class="cut__no">${esc(labelOf(p))}</span>
        ${from ? `<span class="cut__from" data-from="${from}">${esc(ORIGINS[from])}</span>` : ''}
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
          : p.charId || p.dialogue ? '' : '<p class="cut__action" style="color:var(--pencil-2)">설명 없음</p>'}
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
    ? `저장 대기 ${unsent}건 · 다시 보내는 중`
    : off ? '연결 끊김 · 재연결 중' : alone ? '나 혼자' : `${peers.size + 1}명 접속`
  byId('liveFlag').className = `mono tape${unsent ? ' tape--warn' : alone || off ? ' tape--off' : ''}`
}

function renderCursors() {
  setHtml(byId('cursors'), [...peers.values()]
    .filter((p) => p.cursor && (p.view ?? null) === (viewChar ?? null))
    .map((p) => `
      <div class="cursor" style="left:${p.cursor.x}px; top:${p.cursor.y}px">
        <svg width="14" height="18" viewBox="0 0 14 18"><path d="M1 1l11 8-5 1 2.5 6-2 1-2.6-6L1 14z" fill="${p.color}" stroke="var(--ink)" stroke-width="1"/></svg>
        <span style="background:${p.color}">${esc(p.name)}</span>
      </div>`).join(''))
}

/*
 * ══ 여기 있던 것: 이야기 기획 · 컷을 대본으로 · 시나리오를 컷으로 · 대본 불러오기
 *
 * 네 창과 그 뒤의 판 약 560줄이 이 자리에 있었습니다. 다 지웠습니다. 넷 다 「이야기를
 * 만드는 일」이고, 그 일을 하는 화면이 위 탭 바에 따로 있습니다(components/nav-tabs.js).
 *
 *   이야기 기획 · 시나리오를 컷으로 → 스토리 디벨롭 (story-graph.html)
 *   컷을 대본으로 · 대본 불러오기   → 대본화 (story-graph.html?tab=script)
 *
 * 보드는 만들어진 컷을 그리고 승인하는 곳입니다. 같은 일을 두 자리에서 할 수 있게 두면
 * 어느 쪽이 진짜인지 아무도 모릅니다. 게다가 이 창들은 보드의 판을 직접 갈아 치웠으므로
 * (applyPlan 이 panel.add 를 쏟아 넣었습니다), 탭에서 이야기를 다듬던 사람과 여기서 창을
 * 연 사람의 결과가 서로를 덮었습니다.
 *
 * 판의 시나리오 값(state.board.scenario · ep.scenario)은 그대로입니다. op 로 들어오면
 * 받고 예시도 그것을 넣습니다(seedBuild). 보드가 그것을 그릴 칸만 없앴습니다.
 */

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
    u ? `알림 ${u}건. 확인이 필요합니다` : unread.length ? `알림 ${unread.length}건. 읽지 않음` : '알림 없음')
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
    ${p ? `<div class="mono" style="font-size:9.5px;color:var(--pencil-2);margin-bottom:3px">${esc(`${whereOf(p)} · ${labelOf(p)}`)}</div>` : ''}
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

/**
 * 눈에 보이는 한 줄. 위의 toast 는 「누가 무엇을 했다」는 알림이고, 이것은 「지금 이건
 * 안 됩니다」입니다.
 *
 * 권한 때문에 막힌 자리를 눌렀을 때가 이것을 쓰는 자리입니다. 예전에는 막힌 버튼을
 * disabled 로만 두어서, 누른 사람은 아무 일도 안 일어나는 화면만 봤습니다. 고장인지
 * 권한인지 알 수 없다는 말이 거기서 나왔습니다. announce 도 같이 불러 소리로 읽는
 * 사람에게도 같은 말이 가게 합니다.
 *
 * @param {string} text - 왜 안 되는지
 * @param {string} [tone] - 'warn' 이면 붉은 띠
 */
function notice(text, tone = 'warn') {
  const host = byId('toasts')
  if (!host) return
  const el = document.createElement('div')
  el.className = 'toast'
  el.dataset.tone = tone
  el.textContent = text
  host.appendChild(el)
  while (host.children.length > 3) host.firstChild.remove()
  setTimeout(() => el.remove(), 6500)
  announce(text)
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
    <span class="lost__head">${esc(person(l.by)?.name || '누군가')}의 편집이 이 칸을 덮었습니다. 내가 쓴 문장:</span>
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
           ${media(srcOf(cmp), `alt="v${cmpVer + 1}"`)}
           <figcaption class="mono">v${cmpVer + 1} · ${esc(person(cmp.author)?.name || '')}</figcaption>
         </figure>
         <figure class="vw__frame" data-ink="1">
           ${media(srcOf(ver), `alt="v${cur.i + 1}"`)}
           ${inkOf(onNow)}${pinsOf(onNow)}
           <figcaption class="mono">v${cur.i + 1} · 지금</figcaption>
         </figure>
       </div>`
    : `<div class="vw__frame" data-ink="1">
         ${media(srcOf(ver), `alt="${esc(labelOf(p))}"`)}
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
          <p class="why">표시는 그때 보던 버전에 달립니다. 다른 버전의 핀은 그 버전에서 보입니다.</p>
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

/*
 * ── 오른쪽 판을 접는 자리 ─────────────────────────────────────────────────────
 *
 * 이 판에 여덟 덩이가 세로로 쌓여 있었습니다. 담당 · 컷 내용 · 이미지 만들기 · 자산 · 버전 ·
 * 메모 · 기록, 그리고 바닥의 승인 띠입니다. 컷 하나에서 실제로 하는 일은 그중 하나인데
 * 나머지 일곱이 다 펼쳐져 있어서, 승인하려고 열어도 「이미지 만들기」의 칩 스무 개와 안내
 * 다섯 줄을 지나야 했습니다. 세로 길이가 화면의 세 배였습니다.
 *
 * 어느 줄도 지우지 않았습니다. 각각 실제로 쓰는 사람이 있고(아티스트는 생성 칸, 감독은
 * 메모와 승인) 지웠으면 그 사람의 일이 없어집니다. 대신 「지금 이 컷에서 할 일」만 펴 두고
 * 나머지는 제목만 남겨 접습니다.
 *
 * 접는 것으로는 부족했습니다. 접힌 덩이 여섯이 다 같은 실선 위에 같은 무게로 서 있어서,
 * 제목만 읽으면 「내용」·「이미지 만들기」·「버전」·「메모」·「기록」이 나란한 목록이었습니다.
 * 이 판을 처음 여는 사람에게는 무엇을 하러 온 자리인지가 그 목록 안에서 사라집니다.
 *
 * 그래서 「하는 일」과 「보는 것」을 모양으로 갈랐습니다. 하는 일만 종이 한 장으로 세우고
 * (board.html 의 .sec--step 과 .do) 나머지는 그대로 접힌 줄입니다. 인물 구도는 그 장이 둘이라
 * 번호를 달고(section 의 step), 컷은 하나라 접지 않는 .do 한 장입니다. 자세한 것은
 * renderDetail 안 setHtml 위의 머리글에 있습니다.
 *
 * <details> 를 씁니다. 처음 상태를 우리가 정하고 여닫는 것은 브라우저가 합니다.
 *
 * 접힌 상태는 판(op 로그)에 남기지 않습니다. 컷마다 보고 싶은 것이 다르고, 같은 컷을 둘이
 * 열어 두었을 때 남이 접은 칸이 내 화면에서 접히면 그것이 고장으로 읽힙니다. 대신 화면이
 * 살아 있는 동안은 사람이 손으로 여닫은 것을 기억합니다(secOpen). renderDetail 이 남의
 * 편집 하나에도 다시 도는데, 그때 펴 둔 칸이 닫히면 글을 쓰던 칸이 눈앞에서 사라집니다.
 *
 * 기본값이 아니라 「사람이 정한 것」을 담습니다. Set 이 아니라 Map 인 이유가 그것입니다 —
 * 처음부터 펴 두는 칸(구도의 기준 이미지)을 사람이 접었으면 그 접은 것도 기억해야 합니다.
 */
const secOpen = new Map()

/**
 * 접히는 한 덩이.
 *
 * @param {string} key - 기억할 이름. 사람이 여닫은 것을 secOpen 에 이 이름으로 남깁니다
 * @param {string} title - 제목 줄
 * @param {string} body - 안의 내용
 * @param {object} [o]
 * @param {boolean} [o.open] - 처음 상태. 지금 할 일인 덩이만 참입니다
 * @param {number} [o.count] - 제목 옆의 숫자(메모 3, 버전 2). 접혀 있어도 몇 개인지는 보입니다
 * @param {string} [o.lead] - 제목 옆의 한 줄. 접힌 채로 「안에 무엇이 있는지」를 말합니다
 * @param {number} [o.step] - 「할 일」인 덩이의 번호(구도의 1 기준 이미지 · 2 구도 그리기).
 *   주면 종이 한 장으로 세우고 제목 앞에 그 번호가 붙습니다(board.html 의 .sec--step). 보는
 *   덩이에는 주지 않습니다 — 다 같은 무게로 쌓이면 어느 것이 할 일인지가 목록 안에서
 *   사라집니다. 컷은 할 일이 하나라 이 덩이를 쓰지 않습니다(renderDetail 의 .do)
 */
function section(key, title, body, { open = false, count = 0, lead = '', step = 0 } = {}) {
  const on = secOpen.has(key) ? secOpen.get(key) : open
  return `
    <details class="sec${step ? ' sec--step' : ''}" data-sec="${esc(key)}"${on ? ' open' : ''}>
      <summary class="sec__sum">
        <span class="mono sec__t"${step ? ` data-step="${step}"` : ''}>${esc(title)}</span>
        ${count ? `<span class="count">${count}</span>` : ''}
        ${lead ? `<span class="sec__lead">${esc(lead)}</span>` : ''}
      </summary>
      <div class="sec__body">${body}</div>
    </details>`
}

/**
 * 「이 칸이 무엇인지」를 담는 접히는 줄.
 *
 * 이 판의 안내문(.why)이 열 줄을 넘었습니다. 하나씩은 다 필요한 말인데 — 기반 이미지가
 * 무엇인지, 모델이 얼굴을 살리는지, 영상이 왜 승인 뒤인지 — 처음 한 번 읽으면 되는 말이라
 * 늘 펴 두면 정작 누를 단추가 그 아래로 밀립니다. 한 줄로 접어 두고 궁금할 때 폅니다.
 *
 * 비어 있으면 아무것도 내지 않습니다. 빈 「자세히」를 눌러 보게 하면 안 됩니다.
 */
function tipBox(key, rows) {
  const body = rows.filter(Boolean).join('')
  if (!body.trim()) return ''
  return `
    <details class="tip" data-sec="${esc(key)}"${secOpen.get(key) ? ' open' : ''}>
      <summary class="tip__sum">이 칸이 무엇인지</summary>
      <div class="tip__body">${body}</div>
    </details>`
}

/**
 * 접힌 칸을 펴고 다시 그립니다.
 *
 * 밖에서 그 안의 칸에 초점을 주려는 때에 씁니다 — 컷에서 r 을 눌러 수정 요청으로 가면
 * 메모 칸에 초점이 가야 하는데, 그 칸이 접혀 있으면 focus 가 조용히 아무 일도 하지
 * 않습니다(닫힌 details 안은 화면에 없습니다). 이유를 말해 놓고 쓸 곳이 없는 셈입니다.
 *
 * @param {string} key - section 의 key
 */
function openSec(key) {
  if (secOpen.get(key) === true) return
  secOpen.set(key, true)
  renderDetail()
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
  const editable = mayEdit(p)
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
  /*
   * 못 고치는 칸. disabled 가 아니라 readonly + data-nope 로 둡니다.
   *
   * disabled 는 클릭 이벤트조차 나오지 않아서, 누른 사람은 아무 반응도 없는 화면만 봅니다.
   * 고장인지 권한인지 구별이 안 된다는 말이 거기서 나왔습니다. readonly 는 고치는 것만
   * 막고 클릭은 그대로 올려 보내므로, 문서 하나가 그것을 잡아 왜 막혔는지 한 줄을 띄웁니다
   * (perm.js 의 watchNope).
   *
   * 권한 때문에 막힌 자리에만 씁니다. 상태 때문에 막힌 자리(아직 이미지가 없다, 남이
   * 생성 중이다)는 그대로 disabled 입니다. 그쪽은 기다리면 풀리고, 감독에게 부탁할 일도
   * 아닙니다.
   */
  const noEdit = nope(whyNotEdit(p))
  const dis = () => (editable ? '' : `readonly ${noEdit}`)

  const o = optsFor(p)
  const refs = refChoices(p)
  // 고른 그림이 사라졌으면(인물을 떼거나 버전을 지웠으면) 다시 기본값으로 돌립니다
  if (o.ref !== null && !refs.some((r) => r.key === o.ref)) o.ref = null
  const refKey = refKeyOf(p)
  const pickedRef = refs.find((r) => r.key === refKey)
  /*
   * 참조 자산. 이 컷이 보낼 것과, 이 컷에서 뽑아 둔 것입니다.
   *
   * 고를 수 있는 전부를 담던 assetPool 이 나갔습니다. 컷마다 자산 칩을 죽 늘어놓고 켜고 끄는
   * 줄이 있었는데, autoAssets 가 붙여 둔 인물의 자산과 같은 씬의 배경을 이미 잡아 줍니다 —
   * 켜고 끌 일이 드문 줄이 판의 절반을 먹고 있었습니다. 자산을 고르는 일은 자산관리
   * 화면에서 합니다(pages/assets.js 의 참조 고르기).
   */
  const assetIds = assetIdsOf(p)
  const assetMine = p.charId ? [] : assetsFrom(p.id)
  const extracting = assetWork.get(p.id)
  const extractWhy = whyNotExtract(p)
  const picked = modelOf(pickedModel) || modelOf(gpu.resident)
  // 커넥터 모델을 고른 사람에게 GPU 상태를 알릴 이유가 없습니다. 그 길을 지나지 않습니다
  const connPick = !!picked && isConn(picked.id)
  const hint = !canGen || connPick ? '' : {
    warm: '모델을 올리는 중입니다. 잠시 뒤 다시 눌러주세요.',
    // 시간표 밖에서 꺼진 것과 시간표 안에서 닿지 않는 것을 가려서 적습니다
    down: gpuDownHint(),
    error: '생성 서버에 문제가 있습니다.',
  }[gpu.state] || ''

  /*
   * 인물 얼굴을 물려받는 자리의 안내.
   *
   * 컷에 인물을 붙였는데 그 인물에게 참조할 얼굴이 없으면(기준도 승인도 없으면) 왜 칩이
   * 안 나오는지 말해 줍니다. 그 말이 없으면 기능이 고장난 것으로 보입니다.
   *
   * 모델도 같이 봅니다. Chroma·SD 계열은 기반 이미지를 지우고 다시 그리는 방식이라
   * (server.py 의 args_for 가 img2img 로 넘깁니다) 얼굴이 그대로 남지 않습니다. 얼굴을
   * 조건으로 받는 모델이 목록에 있으면 그것을 가리킵니다.
   */
  // 참조 자산이 들어가는 컷에는 「얼굴이 없다」를 말하지 않습니다 — 인물 자산이 그 얼굴입니다
  const noFace = !p.charId && (p.cast || []).length > 0 && !refs.some((r) => r.face) && !assetIds.length
  const keepModel = allModels().find((m) => m.strength === false)
  /*
   * 얼굴 이야기는 둘로 갈라 둡니다. 둘 다 컷의 것입니다 — noFace 가 !p.charId 를 봅니다.
   *
   * 앞은 「지금 없다」입니다. 붙여 둔 인물의 얼굴이 없어서 그 얼굴이 안 들어가는 것이라,
   * 접어 두면 화면이 고장난 것으로 보입니다. 그대로 세웁니다(cutGen).
   *
   * 뒤는 「지금 무엇을 참조한다」입니다. 한 번 읽으면 되는 말이라 접히는 칸으로 보냅니다
   * (tipBox).
   */
  const faceMiss = noFace ? `
    <p class="why">붙여 둔 인물에게 참조할 얼굴이 아직 없습니다. 인물 화면에서 마음에 드는 버전을
      「이 버전을 기준으로」 잡거나 구도를 승인하면, 그 얼굴을 물려받아 그립니다.</p>` : ''
  const faceNote = noFace || !pickedRef?.face ? '' : `
    <p class="why">${pickedRef.faces
    ? `${esc(pickedRef.faces.map((f) => f.name).join(' · '))}의 얼굴을 한 장으로 붙여 참조합니다. 누가 누구인지는 위 지시문의 이름이 말해 줍니다.`
    : `${esc(pickedRef.from?.name || '')}의 승인된 얼굴을 참조합니다. 컷이 바뀌어도 같은 인물로 나옵니다.`}${
  picked?.strength === true
    ? ` 다만 ${esc(picked.label)}은 기반 이미지를 지우고 다시 그립니다 — 얼굴을 그대로 살리려면 ${
      keepModel ? `위쪽 모델 칩에서 ${esc(keepModel.label)}을 고르세요.` : '얼굴을 조건으로 받는 모델이 필요합니다.'}`
    : ''}</p>`

  const modelNote = !picked ? '' : `
    <p class="why">지금 그리는 모델: ${esc(picked.label)} · ${esc(picked.note)}.${
  connPick ? ' 커넥터로 붙은 밖의 모델입니다. GPU 를 켜 두지 않아도 됩니다.'
    : picked.id === gpu.resident ? ' 위쪽 모델 칩에서 바꿉니다.'
      : ` 아직 올라오지 않았습니다(약 ${mins(picked.wait)}분).`}</p>`

  /*
   * 영상 단추와 그 옆의 길이·화질. 그림 단추 바로 옆에 둡니다 — 「이 그림으로 간다」가
   * 정해진 다음에 오는 일이라, 그것을 위해 다른 화면으로 보낼 이유가 없습니다.
   *
   * 승인 전에도 단추는 있고 누르면 이유가 뜹니다(위 actionBtns 와 같은 규칙입니다).
   * 지워 버리면 「영상은 어디서 만드나」가 되고, disabled 로 두면 왜 막혔는지 마우스를
   * 올려 본 사람만 압니다.
   *
   * 인물 구도에는 내지 않습니다. 구도는 얼굴을 정하려고 그리는 그림이고, 영상으로 만들
   * 것은 컷입니다. 생성 서버가 없는 배포에서도 내지 않습니다 — 누를 곳이 없습니다.
   */
  const clipping = clipWork.get(p.id)
  const clipWhy = whyNotClip(p)
  const noClip = p.charId || !canAnimate()
  const clipBtn = noClip ? '' : `
      <button class="btn btn--line" data-do="animate" ${clipWhy ? `aria-disabled="true" title="${esc(clipWhy)}"` : ''}>
        ${clipping ? '영상 만드는 중…' : '영상으로 생성'}
      </button>`
  const eta = clipEta()
  /*
   * 길이·화질은 실제로 누를 수 있을 때만 냅니다. 승인은 됐어도 그림이 없으면 첫 프레임이
   * 없어서 단추는 막혀 있는데(whyNotClip), 고를 것이 먼저 보이면 「고르면 된다」로 읽힙니다.
   */
  const clipRow = noClip ? '' : p.status !== 'approved' ? `
    <p class="why">영상은 승인된 이미지로만 만듭니다 — 아직 고칠 그림으로 만들면 그 시간과 GPU
      자리를 버립니다. 감독이 이 컷을 승인하면 「영상으로 생성」이 열립니다.</p>` : !stillOf(p) ? `
    <p class="why">승인은 됐지만 이 컷에 그림이 없습니다. 영상은 승인된 이미지를 첫 프레임으로
      씁니다 — 먼저 위의 「이 컷 그리기」로 그림을 한 장 만드세요.</p>` : `
    <div class="gen__row">
      <span class="mono gen__lab">영상</span>
      <select id="clipSecs" aria-label="영상 길이">${clipSecs().map((s) => `
        <option value="${s}"${clipOpts.secs === s ? ' selected' : ''}>${s}초</option>`).join('')}</select>
      <select id="clipQuality" aria-label="영상 화질">${clipQual().map((q) => `
        <option value="${esc(q.id)}"${clipOpts.quality === q.id ? ' selected' : ''}>${esc(q.label)}</option>`).join('')}</select>
      ${eta ? `<span class="mono gen__val">약 ${eta < 60 ? `${eta}초` : `${mins(eta)}분`}</span>` : ''}
    </div>
    <p class="why">승인된 이미지가 첫 프레임입니다. 움직임은 이 컷의 작업 지시·대사·카메라에서
      만들어 보냅니다. 나온 영상은 이 컷의 다음 버전으로 붙습니다.</p>`

  /*
   * 자산 한 줄. 자산 자체는 「자산관리」 화면의 것이라 여기서는 이 컷에서 무엇이 뽑혔는지와
   * 그 화면으로 가는 길만 둡니다. 승인 전에는 「승인하면 뽑힌다」만 말합니다. 생성 칸
   * (genBody)과 달리 감독에게도 보입니다 — 승인을 누르는 사람이 감독이라 뽑는 진행도 그
   * 화면에 뜹니다.
   *
   * 접지 않습니다. 한 줄이고, 「승인하면 자산이 된다」는 것이 이 판에서 승인을 누르는 사람이
   * 알아야 할 결과입니다. 접힌 제목 뒤에 두면 그 한 줄을 볼 이유가 없어집니다.
   */
  const assetsHref = navHref('assets', boardFromSearch())
  const assetLine = p.charId || !canGen ? '' : extracting ? `
    <p class="why why--busy">${esc(extracting)}</p>` : p.status !== 'approved' ? `
    <p class="why">감독이 이 컷을 승인하면 그 그림에서 인물·배경·소품을 따로 그려
      <a href="${esc(assetsHref)}">자산관리</a>에 넣습니다.</p>` : `
    <p class="why">${assetMine.length
    ? `이 컷에서 뽑은 자산 ${assetMine.length}개가 <a href="${esc(assetsHref)}">자산관리</a>에 있습니다.`
    : `승인은 됐지만 뽑은 자산이 없습니다.${extractWhy ? ` ${esc(extractWhy)}.` : ''}`}
      ${extractWhy ? '' : `<button type="button" class="mini" data-do="extract">${assetMine.length ? '다시 뽑기' : '자산으로 뽑기'}</button>`}</p>`

  /*
   * 기반 이미지를 얼마나 살릴지. 모델이 그것을 어떻게 쓰는지에 따라 칸 자체가 없어집니다.
   * 그 「왜 없는지」는 아래 tipBox 로 접습니다 — 없는 칸의 설명이 있는 칸보다 길면 안 됩니다.
   *
   * 슬라이더였습니다. 0.75~0.95 를 0.1 씩 밟는 range 였는데, 실제로 갈 수 있는 자리가 셋이고
   * (morph 가 그 셋을 이름으로 부릅니다) 그 이름은 옆의 작은 글씨로만 보였습니다. 끌어야
   * 값이 보이는 셋 중 하나 고르기입니다. 위의 기반 이미지 줄과 같은 칩으로 바꿉니다 —
   * 고를 것이 이름으로 다 보이고, 지금 무엇인지도 색으로 보입니다.
   */
  const MORPHS = [0.75, 0.85, 0.95]
  const morphRow = refKey === 'none' && !assetIds.length ? ''
    : picked?.init === false || (connPick && picked.strength !== true) || picked?.strength === false ? '' : `
      <div class="gen__row">
        <span class="mono gen__lab">기반을 얼마나 살릴지</span>
        ${MORPHS.map((v) => `<button class="chip" data-morph="${v}" data-on="${
  Math.abs(o.strength - v) < 0.01 ? 1 : 0}" ${editable ? '' : noEdit}>${esc(morph(v))}</button>`).join('')}
      </div>`

  const morphWhy = refKey === 'none' && !assetIds.length ? '' : picked?.init === false ? `
      <p class="why">${esc(picked.label)}은 기반 이미지를 받지 않습니다. ${connPick || !keepModelId()
    ? '지시문만 보고 새로 그립니다.'
    : `참조를 고른 이 컷은 ${esc(modelOf(keepModelId())?.label || '')}이 그립니다 — 그 모델이 그림을 조건으로 받습니다.`}</p>`
    : connPick && picked.strength !== true ? `
      <p class="why">${esc(picked.label)}은 기반 이미지를 참고해서 그립니다. 변형 정도를 받는 칸은 이 모델에 없습니다.</p>`
      : picked && picked.strength === false ? `
      <p class="why">${esc(picked.label)}은 기반 이미지를 지우고 다시 그리지 않습니다. 조건으로 받아서 인물을 그대로 살립니다. 그래서 변형 정도가 없습니다.</p>` : `
      <p class="why">‘${esc(morph(0.75))}’는 올린 스케치를 거의 그대로 두고, ‘${esc(morph(0.95))}’는
        구도까지 모델이 다시 잡습니다. 얼굴만 물려받고 구도는 이 컷의 것으로 하려면 ‘${esc(morph(0.95))}’입니다.</p>`

  /*
   * ══ 그림 만들기
   *
   * 인물 구도(ch)와 컷이 여기서 갈립니다.
   *
   * 구도는 그대로 고르는 칸이 있는 덩이입니다. 여섯 벌을 차례로 돌리며 기준 이미지를 잡는
   * 자리라 고를 것이 실제로 여럿입니다 — 무엇을 참조하고 얼마나 살릴지가 그 일의 내용입니다.
   *
   * 컷은 단추 둘만 남깁니다. 여기 입력 칸이 여섯, 칩 줄이 셋, 안내가 여덟 줄 있었는데 컷
   * 하나를 그리려고 여는 사람이 실제로 고칠 것은 거의 없었습니다 — 기반 이미지도 참조
   * 자산도 알아서 잡히고(autoRef·autoAssets), 지시문도 컷의 화면 설명에서 저절로
   * 만들어집니다(autoPrompt). 고를 것이 다 기본값으로 맞는데 고르는 칸만 화면을 덮고
   * 있었던 셈입니다. 그래서 칸을 내리고 「그린다」만 남깁니다.
   *
   * 무엇으로 그리는지는 단추 아래 한 줄로 말합니다. 고치는 자리가 아니라 확인하는 자리라
   * 글이면 됩니다.
   */
  const genBody = !may('art') ? `
    <p class="why">${esc(whyNot('art'))}. 필요한 그림이 있으면 아래 메모로 남겨주세요.</p>` : `
    <label class="f">
      <span class="f__label"><span class="mono">생성 지시</span>
        ${o.prompt !== null ? '<button class="mini" data-do="autofill">작업 내용으로 다시 채우기</button>' : ''}</span>
      <textarea rows="3" id="genPrompt" placeholder="어떤 그림이 필요한지 적어주세요. 한국어로 써도 됩니다." ${dis()}>${esc(o.prompt ?? autoPrompt(p))}</textarea>
    </label>
    <div class="gen__row">
      <span class="mono gen__lab">기반 이미지</span>
      ${refs.map((r) => `<button class="chip" data-ref="${r.key}" data-on="${refKey === r.key ? 1 : 0}" title="${esc(r.hint || '')}" ${editable ? '' : noEdit}>${esc(r.label)}</button>`).join('')}
    </div>
    ${/* 고른 기반 이미지를 눈으로 확인시켜 줍니다. 이름만 있으면 무엇을 물려받는지 모릅니다 */ ''}
    ${pickedRef?.srcs ? `<div class="gen__ref gen__ref--many">${pickedRef.srcs.map((s) => media(s, 'alt="" loading="lazy"')).join('')}</div>`
    : pickedRef?.src ? `<div class="gen__ref">${media(pickedRef.src, 'alt="" loading="lazy"')}</div>` : ''}
    ${morphRow}
    ${/* 얼굴 안내(faceMiss·faceNote)는 컷의 것입니다. 아래 cutGen 에 있습니다 */ ''}
    <div class="acts">
      <button class="btn btn--line" data-do="upload" ${editable ? '' : noEdit}>스케치 올리기</button>
      <button class="btn btn--solid" data-do="generate" ${!editable ? noEdit : busyBy ? 'disabled' : ''}>
        ${busyBy ? `${esc(busyBy.name)} 생성 중…` : ver ? '다시 그리기' : '이 구도 그리기'}
      </button>
    </div>
    ${p.genError ? `<p class="why why--bad">${esc(p.genError)}</p>` : hint ? `<p class="why">${esc(hint)}</p>` : ''}
    ${tipBox('gen.tip', [modelNote, morphWhy])}`

  /*
   * ══ 컷의 그림 단추 둘 — 「그린다」와 「영상으로 만든다」
   *
   * 이름을 상황에 따라 바꿉니다. 「AI로 생성」이었는데 무엇 한 장인지가 빠져서 위 탭의
   * 키비주얼과 같은 층으로 읽혔습니다 — 그쪽은 씬 하나를 그리는 일이고 이것은 컷 하나를
   * 그리는 일입니다. 실은 그 씬 그림을 기반으로 물려받아 이 컷의 구도를 잡는 것이라
   * (autoRef 의 keyvisual) 겹치는 것이 아니라 이어지는 것입니다.
   *
   * 그림이 없으면 「이 컷 그리기」, 있으면 「다시 그리기」입니다. 누를 때마다 버전이 하나
   * 붙기 때문에 두 번째부터는 실제로 다시 그리는 일이고, 첫 장에 「다시」는 틀린 말입니다.
   */
  const cutGen = !may('art') ? `
    <p class="why">${esc(whyNot('art'))}. 필요한 그림이 있으면 아래 메모로 남겨주세요.</p>` : `
    <div class="acts" style="margin-top:0">
      <button class="btn btn--solid" data-do="generate" ${!editable ? noEdit : busyBy ? 'disabled' : ''}>
        ${busyBy ? `${esc(busyBy.name)} 생성 중…` : ver ? '다시 그리기' : '이 컷 그리기'}
      </button>
      ${clipBtn}
    </div>
    ${/*
      * 무엇으로 그리는지 한 줄. 고르는 칸이 없어졌으므로 이 줄이 그 자리를 대신합니다 —
      * 누르기 전에 이 컷이 무슨 얼굴·무슨 씬을 물려받는지 알아야 엉뚱한 그림을 받지 않습니다.
      */''}
    <p class="why">${busyBy ? `${esc(busyBy.name)}이 이 컷을 그리고 있습니다.`
    : `${esc(genWith)} 그립니다.${ver ? ` 나온 것은 v${live.length + 1}으로 붙습니다.` : ''}`}</p>
    ${clipping ? `<p class="why why--busy">${esc(clipping)}</p>` : ''}
    ${/* 얼굴이 없는 것은 접지 않습니다. 누르기 전에 알아야 할 일이라 단추 바로 아래입니다 */''}
    ${faceMiss}
    ${p.genError ? `<p class="why why--bad">${esc(p.genError)}</p>` : hint ? `<p class="why">${esc(hint)}</p>` : ''}
    ${clipRow}
    ${/* 컷에도 스케치를 올릴 수 있어야 합니다. 손으로 그린 콘티가 그대로 이 컷의 버전이 됩니다 */''}
    <p class="why">직접 그린 그림이 있으면
      <button type="button" class="mini" data-do="upload" ${editable ? '' : noEdit}>스케치 올리기</button></p>
    ${tipBox('cut.tip', [faceNote, modelNote])}`

  /*
   * 접힌 채로 「지금 무엇으로 그리는지」를 한 줄로 말합니다. 이 덩이를 접으면 모델 이름과
   * 참조가 안 보이는데, 그것을 모르고 「생성」을 누르면 엉뚱한 얼굴이 나옵니다.
   *
   * 인물 구도에만 씁니다. 컷은 이 덩이가 없어졌고(cutGen) 같은 말을 단추 아래 문장으로
   * 합니다(genWith).
   */
  const genLead = !may('art') ? '만들 권한이 없습니다'
    : busyBy ? `${busyBy.name} 생성 중`
      : [refKey === 'none' ? '' : pickedRef?.label || '',
        picked?.label || ''].filter(Boolean).join(' · ') || '지시문만으로 그립니다'

  /*
   * 컷을 무엇으로 그리는지. 위 genLead 와 같은 것을 문장으로 말합니다.
   *
   * 고르는 칸이 다 나갔으므로 이 한 줄이 그 자리입니다. 이름만 나열하면(「기승전 얼굴 ·
   * 씬 키 비주얼 · klein」) 그것이 무엇인지 모르는 사람에게는 낱말 셋일 뿐이라, 무엇을
   * 어디서 가져오는지를 말로 풉니다. 자산·얼굴·씬 그림이 다 없으면 지시문만 갑니다.
   */
  const genWith = (() => {
    const bits = []
    if (assetIds.length) bits.push(`자산 ${assetIds.length}장`)
    if (refKey !== 'none' && pickedRef) {
      bits.push(pickedRef.face ? `${pickedRef.from?.name || pickedRef.label}의 얼굴`
        : refKey === 'keyvisual' ? `${sceneMeta(p.scene).no || '이 씬'}의 키 비주얼`
          : pickedRef.label)
    }
    const from = bits.length ? `${bits.join('과 ')}${josa(bits.at(-1), '을', '를')} 물려받아` : ''
    return `이 컷의 화면 설명${from ? `으로, ${from}` : '으로'}${picked ? ` ${picked.label}이` : ''}`
  })()

  const rmWhy = !ver ? '먼저 이미지가 있어야 합니다'
    : !ver.vid ? '옛 캐시의 버전입니다. 새로고침하면 지울 수 있습니다'
      : !editable ? whyNotEdit(p)
        : ''

  /*
   * 막힌 단추는 둘 다 눌러 볼 수 있게 둡니다. 누르면 왜 안 되는지 한 줄이 뜹니다.
   *
   * 예전에는 권한 막힘만 그랬고(data-nope → watchNope), 상태 막힘은 disabled 였습니다.
   * disabled 는 초점조차 못 받아서 이유가 마우스 hover 의 title 로만 남습니다. 터치·키보드·
   * 스크린리더에는 아무 말도 못 하는 셈입니다. 같은 판 안에서 두 규칙이 엇갈릴 이유가 없어
   * 상태 막힘도 aria-disabled 로 바꿨습니다.
   *
   * data-nope 를 달지 않는 이유: 그쪽은 「감독에게 요청하세요」가 따라붙습니다. 상태 때문에
   * 막힌 것은 부탁할 일이 아니라 앞 단계가 끝나면 저절로 풀리는 것입니다. 그래서 이유만
   * 싣고, 누르면 아래 data-act 처리가 mayTransition 을 다시 보고 그 이유를 띄웁니다.
   */
  const actionBtns = Object.keys(ACTIONS).filter((x) => x !== 'assign').map((x) => {
    const c = mayTransition(p.status, x)
    const cls = x === 'approve' ? 'btn--approve' : x === 'request_changes' ? 'btn--reject' : 'btn--line'
    const off = may(x) ? `aria-disabled="true" title="${esc(c.reason || '')}"` : nope(whyNot(x))
    return `<button class="btn ${cls}" data-act="${x}" ${c.ok ? '' : off}>${ACTIONS[x].label}</button>`
  }).join('')

  const poseFields = `
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
      <input type="text" data-field="pose" value="${esc(p.pose || '')}" ${dis()}>
    </label>
    ${lostRow(p.id, 'pose')}

    <label class="f">
      <span class="f__label"><span class="mono">작업 지시</span>${lockNote('action')}</span>
      <textarea rows="3" data-field="action" placeholder="이 구도에서 무엇을 보여줄지" ${dis()}>${esc(p.action)}</textarea>
    </label>
    ${lostRow(p.id, 'action')}`

  /*
   * ══ 여기 있던 것: 「컷 내용 적기」 칸 여섯 (cutFields · cutLead)
   *
   * 화면 설명·대사·등장 인물·씬·카메라·초를 이 판에서 고치는 칸이었습니다. 접힌 제목에
   * 화면 설명의 앞머리를 붙이는 한 줄(cutLead)도 같이 있었습니다.
   *
   * 컷의 내용은 이 화면에서 만들어지는 것이 아닙니다. 스토리 디벨롭이 대본을 나눠 컷으로
   * 보내고(pages/story-graph.js), 키비주얼이 씬 그림을 붙일 때 씬·카메라·인물을 같이
   * 실어 옵니다(pages/key-visual.js 의 opsForBoard). 그것을 여기서 또 고칠 수 있게 두면
   * 같은 값을 두 화면이 각자 쥐게 되고, 어느 쪽이 「진짜」인지 아무도 모릅니다 — 왼쪽
   * 기둥의 세 단추를 없앤 것과 같은 이유입니다.
   *
   * 보드가 하는 일은 그렇게 온 컷을 그림으로 만들고 승인하는 것입니다. 그래서 이 판에
   * 남는 것은 담당 · 그림 만들기 · 버전 · 메모 · 기록 · 승인입니다.
   *
   * 값은 그대로 살아 있고 컷 카드가 보여 줍니다(renderBoard 의 .cut__bar·.cut__body) —
   * 씬·카메라·초·인물·화면 설명·대사가 다 거기 적힙니다. 못 보는 것이 아니라 여기서
   * 고치지 않는 것입니다. 고칠 일이 있으면 스토리 디벨롭에서 고쳐 다시 내립니다.
   *
   * panel.patch 처리는 그대로 둡니다(reducer). 남이 그 값을 바꾸면 이 화면도 따라갑니다.
   */

  /*
   * 버전 덩이의 두 단추. 덩이 안 맨 위에 섭니다.
   *
   * 제목 줄(summary)에는 넣지 않습니다. 그 줄을 누르는 일이 여닫는 일이라, 안에 단추를
   * 두면 「크게 보기」를 누른 것이 덩이를 접는 일이 됩니다.
   *
   * 접으면 이 둘도 같이 접힙니다. 「크게 보기」가 그래도 되는 것은 컷 카드에 같은 것이
   * 하나 더 있기 때문입니다(renderBoard 의 .cut__zoom). 접힌 판에서 그림을 크게 보고
   * 싶으면 오른쪽 판을 펴는 대신 왼쪽 컷 위의 그것을 누릅니다.
   */
  const verBtns = `
    <button class="mini" data-do="viewer" ${ver ? '' : 'disabled'}
      title="${ver ? '' : '먼저 이미지가 있어야 합니다'}">크게 보기 · 핀 메모</button>
    <button class="mini" data-do="rmver" ${rmWhy ? 'disabled' : ''}
      title="${esc(rmWhy || `v${cur.i + 1}을 보드에서 지웁니다`)}">이 버전 지우기</button>`

  const verBody = live.length ? `<ul class="vers">${p.versions.map((v, i) => deadVer(p, v) ? '' : `
    <li><button class="ver" data-ver="${i}" data-current="${i === cur?.i ? 1 : 0}">
      ${media(srcOf(v), 'class="ver__thumb" alt="" loading="lazy"')}
      <span>v${i + 1} · ${esc(person(v.author)?.name || '알 수 없음')}
        <br><span class="ver__meta">${esc(v.gen ? `${v.gen.model} · seed ${v.gen.seed} · ${(v.gen.ms / 1000).toFixed(1)}초` : v.name || fmtWhen(v.ts))}</span></span>
      <span class="ver__src">${VER_SRC[v.source] || '업로드'}</span>
    </button></li>`).join('')}</ul>`
    : `<p class="why">${p.versions?.length ? '이미지를 모두 지웠습니다. 다시 만들면 v번호는 이어서 붙습니다.' : '아직 이미지가 없습니다.'}</p>`

  const logBody = logs.length ? `<ul class="log">${logs.map((e) => `
    <li>${new Date(e.ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
    · <b>${esc(person(e.actor)?.name || '?')}</b> ${esc(STATUS[e.from]?.label || e.from)} → ${esc(STATUS[e.to]?.label || e.to)}</li>`).join('')}</ul>`
    : '<p class="why">아직 기록이 없습니다.</p>'

  /*
   * 새 메모가 있으면 메모 덩이를 펴 둡니다. 「내가 이 판을 마지막으로 본 뒤에 남이 달고
   * 아직 안 닫힌 것」이 기준입니다(lastVisit · loadVisit). 남이 남긴 말이 접힌 제목 뒤에
   * 숨으면, 그 말을 보라고 담당을 넘긴 사람 쪽에서는 아무 반응이 없는 것으로 보입니다.
   */
  const cmtFresh = cmts.some((c) => !c.resolved && c.author !== me.id && c.ts > lastVisit)

  setHtml(host, `
    <div class="detail">
      <div class="detail__head">
        <span class="detail__no">${esc(ch ? `${ch.name} · ${p.pose || '구도'}` : `CUT ${pad(cutNo(p))}`)}</span>
        <span class="detail__status" data-tone="${st.tone}">${esc(st.label)}</span>
        ${/*
          * 컷을 지우는 자리. 여기 있는 이유는 지우는 것이 이 컷에 대한 일이고, 아래 바닥
          * 띠는 다음 사람에게 넘기는 일이라서다. 승인 옆에 두면 잘못 누른다.
          *
          * 인물 구도에는 달지 않는다. 구도는 정해진 여섯 벌(POSES)이라 하나를 지우면 다시
          * 만들 자리가 없다. 컷은 분해가 다시 만들어 준다.
          */''}
        ${ch ? '' : `<button class="mini" data-do="rmcut"
          ${editable ? '' : `aria-disabled="true" title="${esc(whyNotEdit(p))}"`}>이 컷 지우기</button>`}
      </div>
      ${editable ? '' : `<p class="why why--why">${esc(whyNotEdit(p))}.${
  p.status === 'approved' ? '' : ' 의견은 아래 메모로 남겨주세요.'}</p>`}

      ${/*
        * 담당. 접지 않습니다. 한 줄이고, 「이 컷이 지금 누구 손에 있는가」는 무엇을 하든
        * 먼저 봐야 하는 것입니다.
        *
        * select 은 readonly 를 받지 않습니다. 잠근 채 두고 data-nope 는 감싼 칸에 답니다
        */ ''}
      <label class="f f--tight" ${may('assign') ? '' : nope(whyNot('assign'))}>
        <span class="f__label"><span class="mono">담당</span></span>
        <select data-field="assignee" ${may('assign') ? '' : 'disabled'}>
          ${assignOpts(p.assignee)}
        </select>
      </label>

      ${/*
        * ══ 여기서 하는 일, 그리고 그 결과를 보는 자리 넷
        *
        * 덩이 여섯이 다 같은 실선 위에 같은 무게로 쌓여 있었습니다. 제목만 읽으면 「내용」·
        * 「이미지 만들기」·「버전」·「메모」·「기록」이 다 나란한 목록이라, 이 판을 처음 여는
        * 사람에게는 무엇을 하러 온 자리인지가 보이지 않았습니다.
        *
        * 그래서 「하는 일」과 「보는 것」을 모양으로 갈랐습니다. 하는 일은 종이 한 장으로
        * 세우고, 결과를 보거나 넘기는 자리(버전·메모·기록·바닥 띠)는 실선 위의 접힌 줄로
        * 둡니다.
        *
        * 하는 일이 컷과 인물 구도에서 다릅니다.
        *
        *   인물 구도  1. 기준 이미지  2. 구도 그리기 — 둘이고 순서가 있어 번호를 답니다.
        *              여섯 벌을 차례로 돌리는 자리라 기준 이미지가 먼저입니다(open: 1 만).
        *   컷        하나입니다. 그리고, 승인되면 영상으로 만듭니다. 컷의 내용은 스토리
        *              디벨롭과 키비주얼에서 와서 여기서 고치지 않으므로(위 「여기 있던 것」
        *              머리글) 적는 칸이 없습니다. 하나뿐인 일에 「1.」을 붙이면 뒤에 2 가
        *              있는 것으로 읽혀서 번호도 접는 줄도 없이 그냥 펴 둡니다(.do).
        *
        * 나머지 넷을 처음 펴 두는 것:
        *   버전 그림이 둘 이상일 때만. 하나뿐이면 고를 것이 없습니다
        *   메모 안 읽은 것이 있을 때만
        *   기록 늘 접습니다. 지난 일이라 지금 하는 일에 필요한 것이 아닙니다
        */ ''}
      ${ch ? `
        ${section('pose', '기준 이미지', poseFields, { step: 1, open: true, lead: '이 인물의 얼굴을 정합니다' })}
        ${section('gen', '구도 그리기', genBody, { step: 2, open: false, lead: genLead })}`
    : `<div class="do">${cutGen}</div>`}
      ${/*
        * 자산 한 줄은 덩이 밖입니다. 감싸 두는 이유는 이것이 없으면 아래 덩이의 윗선에
        * 붙어서 「버전」에 딸린 말처럼 읽히기 때문입니다.
        */ ''}
      ${assetLine ? `<div class="sec__note">${assetLine}</div>` : ''}

      ${section('ver', '버전', `
        ${/* 목록보다 위입니다. 지금 보는 버전에 대고 하는 일이라 고를 것보다 먼저 옵니다 */ ''}
        <div class="sec__aside">${verBtns}</div>
        ${verBody}`, {
    open: live.length > 1, count: live.length,
    lead: live.length ? `v${(cur?.i ?? 0) + 1} 보는 중` : '아직 없습니다',
  })}

      ${section('cmt', '메모', `
        ${cmts.length ? threadHtml(cmts, p) : ''}
        ${composerHtml('cmtInput', cmts)}
        <p class="why" id="cmtWhy"></p>`, {
    open: cmtFresh, count: cmts.length,
    lead: cmts.length ? (cmtFresh ? '새 메모가 있습니다' : '') : '아직 없습니다',
  })}

      ${section('log', '기록', logBody, { count: logs.length })}

      ${/* 바닥에 붙는 띠입니다. 스크롤과 무관하게 늘 보입니다 (board.html 의 .detail__foot) */ ''}
      <div class="detail__foot">
        <div class="acts" style="margin-top:0">${actionBtns}</div>
        <p class="why" id="actWhy"></p>
      </div>
    </div>`)

  if (keep) {
    const el = host.querySelector(keep.sel)
    if (el && !el.disabled) {
      el.focus()
      try { el.setSelectionRange(keep.start, keep.end) } catch {  }
    }
  }
}

/**
 * 권한이 없는 단추를 잠급니다. 감추지 않는 이유가 이 화면을 고친 이유입니다 —
 * 감추면 「그런 기능이 없다」로 읽히고, 눌러도 아무 일이 없으면 「고장」으로 읽힙니다.
 * 잠근 채로 두고 누르면 왜 안 되는지 말해 줍니다(perm.js 의 watchNope).
 */
function lock(el, cap, close) {
  if (!el) return
  const ok = may(cap)
  el.hidden = false
  if (ok) {
    el.removeAttribute('aria-disabled')
    delete el.dataset.nope
  } else {
    el.setAttribute('aria-disabled', 'true')
    el.dataset.nope = whyNot(cap)
    close?.()
  }
}

function renderMe() {
  byId('meDot').style.background = me.color
  byId('meName').textContent = me.name
  byId('meRole').textContent = ROLES[me.role] || me.role
  lock(byId('adminBtn'), 'admin', () => { if (adminTab !== 'perm') openAdmin(false) })
  /*
   * 'plan' 권한으로 잠그던 단추 넷이 여기 있었습니다 — 이야기 기획 · 시나리오를 컷으로 ·
   * 컷을 대본으로 · 대본 불러오기입니다. 넷 다 화면에서 나갔습니다(위 탭 바의 스토리
   * 디벨롭·대본화가 그 일을 합니다).
   *
   * 'plan' 권한 자체는 그대로 둡니다. 그 화면들이 같은 것을 봅니다(services/perm.js).
   * 여기서 잠글 단추만 없습니다.
   */
}

function renderGpu() {
  const el = byId('gpu')
  el.hidden = !canGen && !connModels.length
  if (el.hidden) return
  el.dataset.state = isConn(pickedModel) ? 'ok' : gpu.state
  byId('gpuText').textContent = isConn(pickedModel) ? modelOf(pickedModel).label : gpu.text
  const pickable = allModels().length > 1 && may('art')
  // 켜고 끄는 사람(기획·아티스트·감독·관리자)도 메뉴를 엽니다. 모델 목록은 그림 만드는 사람에게만 보입니다
  const powerable = canGen && !!conn && allowed('power', roleOf(me.id))
  el.disabled = !pickable && !powerable
  el.title = pickable ? '생성 모델을 고릅니다' : powerable ? 'GPU 를 켜고 끕니다' : may('art') ? gpu.hint || '' : whyNot('art')
  if (el.disabled) toggleGpuMenu(false)
  renderGpuMenu()
}

/*
 * GPU 켜고 끄기. 저녁 시간표로 꺼지던 것을 사람이 정합니다 — 꺼진 GPU 앞에서 데모가 멈추고 다시 올리는
 * 몇 분이 기다림이었습니다. 끄는 것도 사람이 합니다(시간당 약 2달러). 커넥터 Lambda 가 EC2 를 부릅니다.
 */
let powerBusy = ''
async function gpuPower(action) {
  if (!conn || powerBusy) return
  powerBusy = action === 'on' ? 'GPU 를 켭니다… 모델까지 약 3~4분' : 'GPU 를 끕니다…'
  renderGpuMenu()
  try {
    const r = await conn.power(action)
    announce(action === 'on'
      ? `GPU 를 켰습니다 (${r.state}). 모델이 올라오면 이 칩이 초록으로 바뀝니다 — 약 3~4분.`
      : `GPU 를 끕니다 (${r.state}). 다시 켤 때까지 그림은 만들 수 없습니다.`)
    pollGpu()
  } catch (err) {
    if (action === 'on' && /꺼지는 중/.test(err.message)) {
      // 아직 꺼지는 중이면 20초 뒤 저절로 다시 켭니다
      notice('GPU 가 아직 꺼지는 중입니다. 끝나면 저절로 켭니다.', 'ok')
      setTimeout(() => gpuPower('on'), 20_000)
    } else notice(`GPU 를 ${action === 'on' ? '켜지' : '끄지'} 못했습니다 · ${err.message}`)
  }
  powerBusy = ''
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
    ${!may('art') ? '' : allModels().map((m) => `<button data-model="${m.id}" data-on="${(pickedModel || gpu.resident) === m.id ? 1 : 0}"
      title="${esc(m.note)}${isConn(m.id) ? '' : m.init === false ? ' · 이미지 입력 없음' : ' · 참조 이미지 입력 가능'}">${esc(m.label)}${
    isConn(m.id) ? '' : `<em class="menu__tag">${m.init === false ? '글만' : '이미지 입력'}</em>`}<span class="mono">${
    isConn(m.id) ? (m.kind === 'video' ? '커넥터 · 영상' : '커넥터')
      : m.id === gpu.resident ? '지금 올라옴'
        : m.id === gpu.loading ? '올리는 중…' : `약 ${mins(m.wait)}분`}</span></button>`).join('')}
    <p class="menu__note">${pickError ? esc(pickError)
    : (() => {
      // 고른 모델이 이미지를 받는지 여기서 말합니다 — 참조·기반 이미지 칸이 왜 있고 없는지의 근거입니다
      const p = modelOf(pickedModel || gpu.resident)
      if (p && !isConn(p.id) && p.init === false) return `${esc(p.label)}은 글만 보고 그립니다. 기반 이미지·참조 자산을 고른 컷은 ${esc(modelOf(keepModelId())?.label || 'klein')}이 대신 그립니다.`
      if (p && !isConn(p.id)) return `${esc(p.label)}은 기반 이미지와 참조 자산(여러 장)을 입력으로 받습니다. 아래 컷 상세의 「기반 이미지」·「참조 자산」에서 넣습니다.`
      return 'GPU 모델을 바꾸면 팀 전원의 생성이 그동안 멈춥니다. 커넥터 모델은 기다리지 않고 바로 씁니다.'
    })()}</p>
    ${canGen && conn && allowed('power', roleOf(me.id)) ? `
    <div class="menu__head"><b>GPU</b><span>${esc(gpu.text)}</span></div>
    ${/*
      * 끄는 줄의 이름과 설명을 가릅니다. 「GPU 끄기」만 빨강이고 뒤의 잔글씨는 회색입니다
      * (board.html 의 .menu button[data-power]). 한 색이었을 때는 둘이 한 문장으로 읽혀서
      * 어디까지 누르는 이름인지 몰랐습니다. ⚠ 는 표시라 읽는 기계에는 감춥니다 — 그 말은
      * 눌렀을 때 뜨는 확인 창이 온전히 합니다(아래 confirmAsk).
      */''}
    ${powerBusy ? `<p class="menu__note">${esc(powerBusy)}</p>`
    : gpu.state === 'down' ? '<button data-power="on">GPU 켜기 <span class="mono">약 3~4분</span></button>'
      : `<button data-power="off" data-danger="1">GPU 끄기
        <span class="warn" aria-hidden="true">⚠</span>
        <span class="mono">팀 전원의 생성이 멈춥니다</span></button>`}
    <p class="menu__note">시간표로 끄지 않습니다. 켜 둔 GPU 는 시간당 약 2달러라 일이 끝나면 끕니다. 아침 9시에는 저절로 켜집니다.</p>` : ''}`)
}
byId('gpuMenu').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-model]')?.dataset.model
  if (id) { pickModel(id); return }
  const power = e.target.closest('[data-power]')?.dataset.power
  if (power === 'on') gpuPower('on')
  if (power === 'off') {
    const ok = await confirmAsk({
      title: 'GPU 를 끕니다',
      body: '팀 전원의 그림·영상 생성이 멈춥니다. 다시 켜면 모델이 올라오기까지 약 3~4분 걸립니다.',
      list: [`지금 올라온 모델: ${gpu.text}`, '아침 9시에는 저절로 다시 켜집니다'],
      yes: 'GPU 를 끕니다', danger: true,
    })
    if (ok) gpuPower('off')
  }
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
    ${configured ? '' : ROSTER.map((u) => `<button data-who="${u.id}">${esc(u.name)} · ${ROLES[u.role]}${josa(ROLES[u.role], '으로', '로')} 보기</button>`).join('')}
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
    bye = true
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

/*
 * 시나리오 칸의 input 처리와 「컷으로 분해」 처리 약 130줄이 여기 있었습니다. 칸과 단추가
 * 화면에서 나갔으므로 같이 나갔습니다(위 「여기 있던 것」 머리글).
 *
 * 컷을 만드는 길은 이제 셋입니다. 스토리 디벨롭 탭에서 나눠 오는 것, 키비주얼 화면에서
 * 씬 그림을 보드에 붙이는 것(pages/key-visual.js 의 panel.add), 그리고 가운데 판 맨 뒤의
 * 「+ 컷 추가」입니다.
 */

const board = byId('board')
board.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]')?.dataset.open
  if (open) { openViewer(open); return }
  const card = e.target.closest('.cut')
  if (!card) return
  /*
   * 영상 위(재생·음소거·진행 띠)를 누른 것은 카드를 고르는 뜻이 아니다. 고르면 renderBoard
   * 가 카드 속을 다시 만들면서 <video> 를 갈아치워 방금 누른 재생이 그 자리에서 죽는다.
   * 이미 고른 카드를 또 누르는 것도 마찬가지로 다시 그릴 일이 아니다.
   */
  if (e.target.closest('video')) return
  if (card.dataset.id === selectedId) return
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
    // 메모 덩이가 접혀 있으면 그 안의 칸은 화면에 없어서 focus 가 조용히 안 듭니다
    openSec('cmt')
    byId('cmtInput')?.focus()
    announce('수정 요청에는 이유가 필요합니다. 메모를 적고 수정 요청을 눌러주세요.')
    return
  }
  // 성공한 말은 transition 이 스스로 띄웁니다(notice → announce). 여기서는 막힌 것만 말합니다
  const r = transition(p, act)
  if (!r.ok) notice(r.reason)
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

const detail = byId('detail')
const laterField = debounceBy(140)

/*
 * 사람이 접거나 편 것을 기억합니다. toggle 은 details 자기 자신에서 나고 위로 올라오지
 * 않으므로(버블링을 안 합니다) 캡처로 받습니다.
 *
 * 다시 그리지 않습니다. 브라우저가 이미 여닫아 놓았고, 여기서 renderDetail 을 부르면 방금
 * 편 칸의 애니메이션이 끊기고 초점도 튑니다. 다음번 그림에서 이 값이 쓰입니다(section).
 */
detail.addEventListener('toggle', (e) => {
  const key = e.target.dataset?.sec
  if (key) secOpen.set(key, e.target.open)
}, true)

detail.addEventListener('input', (e) => {
  const p = state.panels[selectedId]
  if (!p) return
  if (e.target.id === 'genPrompt') { optsFor(p).prompt = e.target.value; return }
  // #genStrength 슬라이더를 받던 자리입니다. 칩 셋으로 바뀌어 아래 click 이 받습니다(data-morph)
  if (!e.target.dataset.field) return
  if (e.target.tagName === 'SELECT') return
  /*
   * 남은 글 칸은 인물 구도의 둘입니다 — 구도 이름과 작업 지시. 숫자 칸(초)과 씬 칸을
   * 함께 받던 자리인데, 컷의 내용을 여기서 고치지 않게 되면서 같이 나갔습니다
   * (renderDetail 의 「여기 있던 것」 머리글). 그래서 Number 로 바꾸는 갈래와, 씬·초가
   * 바뀌면 시간표와 머리 띠를 다시 그리던 줄도 없습니다.
   */
  const field = e.target.dataset.field
  const value = e.target.value
  p[field] = value
  renderBoard()
  const panelId = p.id
  laterField(`${panelId}:${field}`, () => emit({ kind: 'panel.patch', panelId, fields: { [field]: value } }))
})

detail.addEventListener('change', (e) => {
  const p = state.panels[selectedId]
  if (!p) return
  /*
   * 영상 길이·화질은 판에 남기지 않습니다. 컷의 성질이 아니라 지금 한 번 만들 때의 선택이고,
   * 다시 그리면 또 고를 것입니다. 걸리는 시간 줄만 다시 그립니다.
   */
  if (e.target.id === 'clipSecs') { clipOpts.secs = Number(e.target.value); renderDetail(); return }
  if (e.target.id === 'clipQuality') { clipOpts.quality = e.target.value; renderDetail(); return }
  /*
   * 카메라 select 을 받던 갈래가 여기 있었습니다. 컷의 카메라를 이 판에서 고르지 않게
   * 되면서 나갔습니다(renderDetail 의 「여기 있던 것」 머리글). 남은 select 은 담당뿐입니다.
   */
  const field = e.target.dataset.field
  if (field !== 'assignee') return
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
  const refKey = e.target.closest('[data-ref]')?.dataset.ref
  const morphPick = e.target.closest('[data-morph]')?.dataset.morph

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
  /*
   * 기반을 얼마나 살릴지. 슬라이더였던 것을 칩 셋으로 바꿨습니다(위 morphRow).
   *
   * 판에 남기지 않습니다. genOpts 는 「지금 한 번 그릴 때의 선택」이고 컷의 성질이
   * 아닙니다 — 남이 그리는 것까지 이 값이 따라가면 안 됩니다.
   */
  if (morphPick) {
    if (!mayEdit(p)) { notice(whyNotEdit(p)); return }
    optsFor(p).strength = Number(morphPick)
    renderDetail()
    return
  }
  /*
   * 참조 자산을 켜고 끄던 갈래가 여기 있었습니다(data-asset). 칩 줄이 없어져서 나갔습니다.
   * 무엇을 참조하는지는 autoAssets 가 잡고 단추 아래 한 줄이 말해 줍니다(genWith).
   * optsFor 의 assets 칸은 그대로 둡니다 — 읽는 쪽(assetIdsOf)이 여전히 봅니다.
   */
  if (doWhat === 'extract') { extractAssets(p); return }
  if (doWhat === 'autofill') { optsFor(p).prompt = null; renderDetail(); return }
  if (doWhat === 'viewer') { openViewer(p.id); return }
  if (memoClick(e, p, 'cmtInput')) return

  /*
   * 컷에 인물을 붙이고 떼던 갈래가 여기 있었습니다(data-cast). 등장 인물은 대본이 정하고
   * 스토리 디벨롭이 실어 옵니다 — 여기서 고치지 않습니다. 붙은 인물의 얼굴을 기반 이미지로
   * 잡는 일은 그대로 돕니다(autoRef).
   */

  if (act) {
    // 막힌 단추도 눌립니다(위 actionBtns). 왜 안 되는지 먼저 말해 줍니다. 수정 요청의
    // 「메모를 먼저 적어주세요」보다 이것이 앞입니다 — 메모를 적어도 안 될 자리니까
    const c = mayTransition(p.status, act)
    if (!c.ok) {
      byId('actWhy').textContent = c.reason
      notice(c.reason)
      return
    }
    if (act === 'request_changes') {
      const input = byId('cmtInput')
      if (!input.value.trim()) {
        /*
         * 접힌 메모 덩이를 먼저 폅니다. 닫힌 details 안은 화면에 없어서 focus 가 조용히
         * 아무 일도 하지 않습니다 — 「메모를 먼저 적어주세요」를 읽고도 적을 칸이 어디인지
         * 안 보이는 셈입니다.
         *
         * 펴면 renderDetail 이 돌아 판이 새로 그려집니다. 그래서 이유와 초점은 그 뒤에
         * 답니다. 순서가 뒤면 방금 넣은 글이 다시 그리는 것에 지워집니다.
         */
        openSec('cmt')
        byId('actWhy').textContent = '수정 요청에는 이유가 필요합니다. 메모를 먼저 적어주세요.'
        byId('cmtInput')?.focus()
        return
      }
      const note = input.value.trim()
      input.value = ''
      transition(p, act, note)
      return
    }
    transition(p, act)
    return
  }

  /*
   * 컷 하나를 지웁니다.
   *
   * 예전에는 지우는 길이 관리 화면의 「보드 비우기」뿐이었습니다. 그래서 분해가 컷을 하나
   * 더 만들었거나 시나리오를 두 번 넣었을 때, 그 하나를 빼려면 보드를 통째로 버려야
   * 했습니다. 사람들은 대신 그 컷을 비워 두고 넘어갔고, 빈 컷이 판에 남았습니다.
   *
   * 「이 버전 지우기」와 달리 confirmAsk 를 씁니다. 잃는 것이 여러 줄입니다 — 메모와
   * 이미지가 컷에 딸려 갑니다. 브라우저 confirm 은 그것을 한 줄로만 말합니다.
   */
  if (doWhat === 'rmcut') {
    if (!mayEdit(p)) { notice(whyNotEdit(p)); return }
    const memos = state.comments.filter((c) => c.panelId === p.id).length
    const vers = (p.versions || []).filter((v) => !deadVer(p, v)).length
    const ok = await confirmAsk({
      title: '이 컷을 보드에서 지웁니다',
      body: '되돌릴 수 없습니다. 같은 보드를 열고 있는 사람에게서도 사라집니다.',
      list: [
        /* 「CUT 03을」이라고 붙이지 않습니다. 숫자 뒤의 조사는 읽는 소리에 따라 갈립니다 */
        `지울 컷: ${labelOf(p)}`,
        '뒤 컷들의 번호가 하나씩 당겨집니다',
        ...(vers ? [`이미지 ${vers}장이 함께 사라집니다`] : []),
        ...(memos ? [`이 컷에 달린 메모 ${memos}건이 함께 사라집니다`] : []),
      ],
      yes: '컷을 지웁니다',
      danger: true,
    })
    if (!ok) return
    const gone = labelOf(p)
    /*
     * 다음 컷으로 옮겨 앉습니다. 없으면 앞 컷입니다.
     *
     * 판(reducer)은 지운 컷이 골라져 있었으면 고른 것을 비웁니다 — 없는 것을 가리키고
     * 있을 수는 없으니 맞습니다. 그런데 그러면 오른쪽 판이 「구도나 컷을 선택하면…」 로
     * 돌아갑니다. 컷 하나를 지우는 사람은 대개 지우고 다음 컷을 보려는 것이라, 지운 자리
     * 뒤에 앉혀 둡니다. 마지막 컷을 지웠으면 앞으로 갑니다.
     */
    const line = cutsOf(p.epId ?? null)
    const at = line.findIndex((x) => x.id === p.id)
    const near = line[at + 1] || line[at - 1] || null
    emit({ kind: 'panel.remove', panelId: p.id })
    if (near) { selectedId = near.id; render() }
    notice(`${gone} · 컷을 지웠습니다`, 'ok')
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
    if (!mayEdit(p)) {
      byId('actWhy').textContent = `${whyNotEdit(p)}.`
      return
    }
    const n = cur.i + 1
    const onIt = state.comments.filter((c) => c.panelId === p.id && c.onVersion === n).length
    const isAnchor = p.charId && state.chars[p.charId]?.refPanelId === p.id && (state.chars[p.charId]?.refN ?? 1) === n
    const left = (p.versions || []).filter((v) => !deadVer(p, v)).length - 1
    if (!confirm([
      `v${n}을 보드에서 지웁니다. 되돌릴 수 없습니다.`,
      onIt ? `이 버전에 달린 메모 ${onIt}건은 남지만 가리킬 그림이 없어집니다.` : '',
      isAnchor ? '이 인물의 기준 이미지가 없어집니다. 다음 구도 생성이 얼굴을 참조하지 못합니다.' : '',
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

  if (doWhat === 'animate') { animate(p); return }

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
  // 「이야기 기획」 창(#plan)도 같이 보던 자리입니다. 그 창이 화면에서 나갔습니다
  if (byId('admin').open) return
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
  const who = e.target.closest('[data-who]')?.dataset.who
  const ptab = e.target.closest('[data-ptab]')?.dataset.ptab
  const cell = e.target.closest('.pm__cell')
  const go = e.target.closest('[data-goto]')?.dataset.goto
  if (tab) { adminTab = tab; renderAdmin() }
  else if (who !== undefined) { adminWho = who || null; renderAdmin() }
  else if (ptab) { permTab = ptab; renderAdmin() }
  else if (cell) togglePerm(cell.dataset.pscope, cell.dataset.pwho, cell.dataset.pcap)
  else if (e.target.closest('[data-preset]')) resetPerms()
  else if (e.target.closest('#admAdd')) addMember()
  else if (go) { openAdmin(false); goTo(go) }
})

/** 손질한 칸을 모두 기본값으로. 한 판이 통째로 도로 core.js 의 값이 됩니다 */
function resetPerms() {
  const cells = PM.changed()
  if (!cells.length || !mayManagePerms(me.role)) return
  if (!confirm(`손질한 ${cells.length}칸을 모두 기본값으로 돌립니다. 계속할까요?`)) return
  emitMany(cells.map(([key]) => {
    const [scope, who, cap] = key.split(':')
    return { kind: 'perm.set', scope, who, cap, on: null }
  }))
  announce(`권한 ${cells.length}칸을 기본값으로 돌렸습니다.`)
}

admin.addEventListener('change', (e) => {
  const userId = e.target.dataset.role
  if (userId) emit({ kind: 'member.role', userId, role: e.target.value })
  else if (e.target.dataset.puser) {
    permWho = e.target.value
    // 고른 사람의 표로 갈아타려면 다시 그려야 하는데, 고르던 select 가 아직 잡고
    // 있으면 renderAdmin 이 물러섭니다(고르는 중에 닫히지 않게 하는 규칙). 놓아 줍니다
    e.target.blur()
    renderAdmin()
  }
})

admin.addEventListener('focusout', () => setTimeout(renderAdmin))

byId('print').addEventListener('click', () => window.print())

// ── 상단 기능 탭 ─────────────────────────────────────────────────────────────
// 스토리보드는 이 화면이고, 스토리 디벨롭·대본화는 story-graph.html, 키비주얼은
// key-visual.html 로 넘어갑니다(모두 링크). 그래서 handled 에는 board 하나만 남습니다.
// keyvisual 을 여기 넣으면 버튼이 되어 눌러도 이동하지 않습니다.
//
// 「권한 관리」는 이 화면에서는 perm.js 의 창을 띄우지 않습니다. 같은 판이 관리 화면의
// 세 번째 장으로 이미 들어 있고, 이 화면은 판(state.perms)을 직접 들고 있어 로그를
// 다시 읽을 이유가 없습니다.
//
// utilMount: 아키텍처 · 권한 관리 · 홈은 탭 바가 아니라 머리 띠(.slate__tools) 오른쪽에
// 붙습니다. 탭 바 안에서는 잔글씨로 흐려져 있어 셋 다 눈에 걸리지 않았습니다.
mountNav({
  mount: byId('navMount'),
  active: 'board',
  handled: ['board'],
  onPerm: () => openAdmin(true, 'perm'),
  utilMount: byId('utilMount'),
})
// 머리의 왼쪽. 네 화면이 같은 것을 씁니다. 누르면 홈입니다
mountBrand('#brandMount')

// 권한 때문에 막힌 자리를 누르면 이유와 「감독에게 요청하세요」를 띄웁니다
watchNope(notice)

let picking = false

/*
 * 표가 저절로 죽는 경우가 있습니다 — 새로 고침 표 만료, 관리자가 계정을 껐음. 그때
 * auth.js 가 이 알림을 보냅니다. 듣지 않으면 이름도 단추도 그대로 살아 있는 채 저장만
 * 조용히 멈추고, 사람은 자기가 그린 컷이 남에게 안 보이는 것을 나중에 압니다.
 *
 * 다시 들어오면 새로 고칩니다. 표가 바뀌었으니 소켓도 로그도 다시 받아야 합니다.
 * 메뉴에서 직접 나가는 길은 바로 그 자리에서 새로 고치므로 여기서 문을 열지 않습니다.
 */
let bye = false
addEventListener('sb:logout', () => {
  if (bye || !configured) return
  bye = true
  notice('로그인이 만료되었습니다. 다시 로그인해 주세요.')
  showLogin(byId('gate')).then(() => location.reload())
})

function pickMe() {
  if (claimed) return Promise.resolve()
  picking = true
  const gate = byId('gate')
  setHtml(gate, `
    <div class="gate__card">
      <div class="gate__eyebrow">아침빵집 · 15초 브랜드 필름</div>
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
  // 이 문도 화면을 덮습니다. 로그인 문과 같은 자리·같은 규칙으로 둡니다(gateModal)
  gateModal(gate, true, '누구로 볼지 고르기')
  gate.querySelector('[data-who]').focus()
  return new Promise((done) => {
    gate.addEventListener('click', (e) => {
      const id = e.target.closest('[data-who]')?.dataset.who
      if (!id) return
      me = person(id)
      sessionStorage.setItem('sb.me', me.id)
      loadRead()
      renderMe()
      gateModal(gate, false)
      picking = false
      done()
    })
  })
}

function isSafeObjectKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

function pickView() {
  const savedView = sessionStorage.getItem('sb.view')
  viewChar = savedView === null ? (charList()[0]?.id ?? null) : (savedView || null)
  if (viewChar && !state.chars[viewChar]) viewChar = charList()[0]?.id ?? null
  viewEp = sessionStorage.getItem('sb.ep') || null
  if (viewEp && !state.eps[viewEp]) viewEp = null
  selectedId = viewPanels().find((p) => p.status === 'changes_requested')?.id ?? viewPanels()[0]?.id ?? null

  const linked = location.hash.startsWith('#cut=') && location.hash.slice(5)
  if (linked && isSafeObjectKey(linked) && state.panels[linked]) {
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
    // 커넥터 목록은 한 번만 읽습니다. 키를 넣고 지우는 것은 홈에서 하고, 여기서는 고를
    // 목록만 필요합니다. 방금 붙인 모델은 새로고침하면 뜹니다
    loadConnModels()
  }

  /*
   * 작업판 앞에 프로젝트 보드를 세웁니다. 주소에 ?board= 가 있으면(카드를 눌러 왔거나
   * 링크를 받았으면) 아무것도 뜨지 않고 그대로 지나갑니다.
   *
   * 고르면 그 주소로 화면을 다시 여는 것이라, 여기서 await 이 끝나지 않습니다. * 아래의 net.connect 도 로그 재생도 시작하지 않습니다. 일부러입니다. 어느 보드인지
   * 모르는 채로 소켓을 열고 판을 세우면, 고른 뒤에 그것을 다 물려야 합니다.
   */
  await pickProject({ step: 'board', actor: me?.id, who: (id) => person(id) })

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
  /*
   * 예전에는 여기서 보드가 비어 있으면 예시 데이터를 조용히 밀어 넣었다. 그러면 처음
   * 들어온 사람이 자기가 만들지도 않은 빵집 프로젝트를 보게 되고, 그것이 예시인지
   * 남이 만든 것인지 알 방법이 없었다. 이제 비어 있으면 비어 있는 대로 두고,
   * renderBoard 가 「처음 오셨나요?」를 띄운다. 예시는 눌러서 넣는 것이다.
   */
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

  /*
   * 처음 온 사람에게 코치마크를 연다. 단, 보드가 비어 있으면 열지 않는다. 그때는
   * 화면에 「처음 오셨나요?」 판이 있고, 그 판이 두 갈래를 이미 말해 준다. 막을 덮어
   * 그 판을 가릴 이유가 없다. 예시를 보거나 직접 시작하면 그 뒤에 코치마크가 열린다.
   */
  if (demoActive()) {
    /*
     * 예시 프로젝트가 이 화면으로 데려온 것이다. 사람이 「예시 보기」를 한 번 더 누를
     * 이유가 없으므로 바로 시작한다. 판에 이미 컷이 있어도 시작한다. 앞의 단계에서
     * 넘어온 길이고, 예시는 예시 판에만 쌓인다(demo.js 의 DEMO_BOARD).
     */
    runExample()
    return
  }

  if (!coach.seen(COACH_KEY) && Object.keys(state.panels).length) openCoach()
}

boot()

window.addEventListener('beforeunload', (e) => {
  markVisit()
  net?.sendPresence({ ...me, left: true })
  /*
   * 아직 못 보낸 op 가 있으면 붙잡습니다. 대기줄은 메모리에만 있어서(services/net.js 의
   * outbox) 창을 닫으면 방금 그린 컷이 남에게도 다음 접속에도 남지 않고 사라집니다.
   * 「저장 대기 n건」 띠가 이미 떠 있지만, 그 띠를 못 보고 닫는 사람이 잃는 것이 큽니다.
   *
   * 문구는 브라우저가 정합니다. 크롬은 우리 글을 무시하고 자기 문장을 띄웁니다.
   */
  if (unsent > 0) { e.preventDefault(); e.returnValue = '' }
})
