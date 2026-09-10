
import {
  orderKeyBetween, orderKeyForIndex, byOrderKey, STATUS, ACTIONS, TRANSITIONS, ROLES, POSES,
  FEEDBACK_TAGS, NEEDS, canTransition, canEditContent, splitScenario, splitScript,
  scenarioFromScript, mergeField, handBackTo, notifFor, sceneGroups, sceneKey, sceneMeta,
  clock, startTimes, scrub, debounceBy, epLabel, lostEdit, isActionable, changedSince,
  workload, liveVer, deadVer, tally, actorPace, CUT_MAX, ASSET_TYPES, REF_TYPES, assetJobs,
} from '../domain/panels.js'
import { confirmAsk } from '../components/confirm.js'
import { josa } from '../lib/josa.js'
import { MODES, GENRES, TONES, LENGTHS, CUTCOUNTS } from '../domain/prompts.js'
import { planOutline, planCuts, planScript } from '../services/planner.js'
import { SCRIPT_FORMATS, scriptBlob, scriptFileName, scriptToText } from '../domain/script-format.js'
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
import { wire as wireTour, demoActive, demoAdvance, demoSay, demoTitle } from '../../app-walkthrough/tour.js'

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

  mark('시나리오를 넣습니다', '기획자 김하나가 15초 브랜드 필름 한 편을 엽니다')
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

  mark('시나리오를 컷으로 나눕니다', '빈 줄이 컷 경계입니다. 씬으로 묶여 시간이 매겨집니다')
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
/** 컷의 참조로 내밀 수 있는 자산. 스틸(자산들로 만든 결과물)은 빼고, 그림이 있는 것만 */
const refAssets = () => assetList().filter((a) => REF_TYPES.includes(a.type) && assetSrc(a))
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

/**
 * 컷의 지금 그림을 그대로 자산으로 둡니다. extractAssets 와 달리 GPU 로 다시 그리지
 * 않고, 승인도 기다리지 않습니다 — 사람이 「이 그림이 인물/배경/소품이다」를 골라 넣는
 * 자리입니다. 같은 컷·같은 종류를 다시 누르면 그 자산의 그림을 갈아 끼웁니다(asset.patch).
 *
 * @param {object} panel
 * @param {'char'|'bg'|'prop'} type
 */
function keepAsAsset(panel, type) {
  if (!REF_TYPES.includes(type)) return
  if (!mayExtract()) { notice(denyReason('extract', roleOf(me.id))); return }
  const src = stillOf(panel)
  if (!src) { notice('먼저 이미지가 있어야 합니다'); return }
  const firstCast = (panel.cast || []).map((id) => state.chars[id]).find(Boolean)
  const name = type === 'char' ? (firstCast?.name || labelOf(panel))
    : type === 'bg' ? (sceneMeta(panel.scene || '').where || labelOf(panel))
    : labelOf(panel)
  const fromN = (liveVer(panel)?.i ?? 0) + 1
  const charId = type === 'char' ? (firstCast?.id ?? null) : null
  const prev = assetsFrom(panel.id).find((a) => a.type === type && a.source === 'keep')
  if (prev) {
    emit({ kind: 'asset.patch', assetId: prev.id, fields: { src, fromN, name, charId, ts: now() } })
  } else {
    emit({
      kind: 'asset.add',
      asset: { id: uid(), type, name, charId, src, fromPanelId: panel.id, fromN, author: me.id, ts: now(), source: 'keep' },
    })
  }
  announce(`${labelOf(panel)} · ${ASSET_TYPES[type]} 자산으로 자산관리에 넣었습니다.`)
  renderDetail()
}

/** 참조로 고르는 자산 칩 한 장. 자산의 이름·삭제는 자산관리 화면(pages/assets.js)에서 합니다 */
function assetCard(a, { pick = false } = {}) {
  const type = esc(ASSET_TYPES[a.type] || a.type || '')
  return `<button type="button" class="asset asset--pick" data-asset="${a.id}" data-on="${pick ? 1 : 0}"
    aria-pressed="${pick ? 'true' : 'false'}" title="${type} · ${esc(a.name || '')}${pick ? ' · 참조에서 뺍니다' : ' · 참조에 넣습니다'}">
    <img src="${assetSrc(a)}" alt="" loading="lazy"><span class="asset__cap"><b class="mono">${type}</b>${esc(a.name || '')}</span></button>`
}

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
  renderMine()
  renderHist()
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

  byId('scriptBlock').hidden = viewChar !== null
  byId('charMeta').hidden = viewChar === null
  if (viewChar === null) {
    const el = byId('scenario')
    const ep = state.eps[viewEp]
    if (document.activeElement !== el) el.value = (ep ? ep.scenario : state.board.scenario) || ''
    renderBreakdown()
  } else {
    const ch = state.chars[viewChar]
    if (document.activeElement !== byId('nameIn')) byId('nameIn').value = ch?.name || ''
    if (document.activeElement !== byId('briefIn')) byId('briefIn').value = ch?.brief || ''
  }
}

/*
 * 시나리오 칸 아래 안내를 살려 둔다.
 *
 * 붙여 넣은 것이 정형 대본이면 씬·컷·인물 수를 눌러 보기 전에 미리 보여준다. 눌러서
 * 컷이 쏟아진 다음에 「대본으로 읽었습니다」 라고 알려 주면 이미 늦다. 안 알아봤으면
 * 예전 문구 그대로 두고 빈 줄로 쪼갠다고 말한다 (core.js 의 splitScript).
 */
function renderBreakdown() {
  const hint = byId('breakdownHint')
  const btn = byId('breakdown')
  if (!hint || !btn) return
  const got = splitScript(byId('scenario').value)
  btn.textContent = got ? '대본을 컷으로' : '컷으로 분해'
  if (!got) {
    setHtml(hint, `빈 줄을 기준으로 컷을 나눕니다. 나눈 뒤 컷마다 화면 설명·대사·카메라를 고칠 수 있습니다.
      이야기부터 만들려면 위의 <b>이야기 기획</b>을 씁니다.
      <b>정형 대본</b>(S#·INT./EXT.·「이름: 대사」)을 붙이면 씬과 대사까지 알아서 갈라 붙입니다.`)
    hint.dataset.script = '0'
    return
  }
  const scenes = new Set(got.cuts.map((c) => c.scene)).size
  const fresh = got.names.filter((n) => !charList().some((c) => c.name === n))
  setHtml(hint, `<b>정형 대본으로 읽었습니다.</b>
    씬 ${scenes}개 · 컷 ${got.cuts.length}개 · 인물 ${got.names.length}명${
      fresh.length ? ` (새로 만들 사람 ${fresh.length}명)` : ''}
    <br>씬 이름·지문·대사·등장인물·컷 길이를 갈라 붙입니다.
    씬 이름은 <b>키비주얼</b> 화면과 같은 모양으로 맞추므로, 그 씬 그림이 곧바로 컷의 기반이 됩니다.`)
  hint.dataset.script = '1'
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
      : '컷이 없습니다. 왼쪽에 시나리오를 넣고 「컷으로 분해」를 누르시거나,',
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
 * 코치마크 넉 장. 지금 화면에 실제로 있는 것만 가리킨다. 앵커가 없는 장은 coach.js 가
 * 조용히 건너뛴다. 그래서 비어 있을 때 열면 시나리오 칸과 탭만 나오고, 예시를 본
 * 뒤에 열면 컷과 상세까지 넉 장이 다 나온다.
 */
const BOARD_CARDS = [
  {
    head: '왼쪽에서 이야기가 들어옵니다',
    body: '시나리오를 붙이고 컷으로 분해합니다.\n빈 줄이 컷 경계입니다.\n이야기부터 만들려면 위의 이야기 기획을 씁니다.',
    spot: ['scenario'],
  },
  {
    head: '가운데가 보드입니다',
    body: '컷은 씬으로 묶이고 순서대로 시간이 매겨집니다.\n끌어서 순서를 바꿀 수 있습니다.',
    spot: ['board'],
  },
  {
    head: '오른쪽에서 한 컷을 다룹니다',
    body: '고른 컷의 그림·대사·카메라·상태가 여기 있습니다.\n그림 위를 눌러 그 자리에 의견을 남길 수도 있습니다.',
    spot: ['detail'],
  },
  {
    head: '넘어온 일과 지나간 일',
    body: '내게 배정된 것은 왼쪽 아래 「내 작업」에 모입니다.\n누가 무엇을 했는지는 그 아래 「지나간 일」에 남습니다.',
    spot: ['mine', 'histbox'],
    next: '시작하기', skip: '다시 보지 않기',
  },
]

const COACH_KEY = 'sb.board.coach.v1'

function openCoach() {
  // 예시 안내 중에는 막을 덮지 않습니다. 짚은 자리를 사람이 실제로 눌러야 합니다
  if (guiding()) return
  coach.start({ cards: BOARD_CARDS, key: COACH_KEY, title: '스토리보드', onDone: render })
}

/* ══ 지나간 일 ═════════════════════════════════════ */

let histMine = false

/**
 * 히스토리. 「내 것만」으로 좁히면 이 화면에서 내가 등록한 목록이 되고, 줄을 누르면
 * 그 컷으로 갑니다. 이어서 하는 자리입니다.
 */
function renderHist() {
  const box = byId('hist')
  if (!box) return
  const list = group(entries(journal, {
    who: (id) => person(id),
    actor: histMine ? me.id : null,
    limit: 40,
  }))
  byId('histMine').setAttribute('aria-pressed', String(histMine))
  paintList(box, list, {
    showStep: true,
    none: histMine ? '내가 등록한 것이 아직 없습니다.' : '아직 지나간 일이 없습니다.',
    onPick: (e) => {
      // 패널을 가리키는 줄만 컷으로 간다. 회차나 인물 id 를 패널로 찾으면 늘 없다
      if (e.refKind && e.refKind !== 'panel') { announce('그 줄은 이어서 갈 컷이 없습니다.'); return }
      const p = state.panels[e.ref]
      if (!p) { announce('그 컷은 지금 보드에 없습니다.'); return }
      viewChar = p.charId ?? null
      if (!p.charId) viewEp = p.epId ?? null
      selectedId = e.ref
      save()
      render()
      byId('detail')?.scrollIntoView({ block: 'nearest' })
    },
  })
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
        : '<div class="board--empty">컷이 없습니다. 시나리오를 넣고 <b>컷으로 분해</b>를 누르거나 아래 버튼으로 추가하세요.</div>')
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
    title: [state.board.title, ep?.title].filter(Boolean).join(' · '),
    scenario: (ep ? ep.scenario : state.board.scenario) || '',
    chars: charList().map((c) => ({ name: c.name, brief: c.brief })),
    centerName: state.chars[planSpec.center]?.name || '',
  }
}

function openPlan(on) {
  const dlg = byId('plan')
  if (on && !may('plan')) return
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
      : '로컬 모드입니다. 모델이 없어 프롬프트를 잘라 뼈대만 만듭니다. 진짜 기획은 배포된 판에서 됩니다.'}</p>`)
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
      planMsg = planOut.local ? '로컬 모드 예시입니다. 문장을 잘라 만든 뼈대입니다.' : ''
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
        id: uid(), charId: null, orderKey: key, ...(epId ? { epId } : {}), origin: 'plan',
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
  /*
   * 만든 것을 말로 알립니다. 인물을 같이 만들었으면 끝나는 말이 '명'이고 아니면 '개'라서
   * 붙는 조사가 달라집니다. 그래서 josa 로 고릅니다.
   *
   * 부탁한 컷 수보다 적게 나오면 그 말도 같이 합니다. 모델이 비트를 덜 펼쳐 오는 일이
   * 있는데, 예전에는 아무 말 없이 적은 수만 놓고 끝나서 사람이 세어 보고서야 알았습니다.
   */
  const what = `컷 ${cuts.length}개${made ? `와 인물 ${made}명` : ''}`
  const short = cuts.length < planSpec.cuts
    ? ` 부탁한 ${planSpec.cuts}개보다 ${planSpec.cuts - cuts.length}개 적습니다. 모자란 만큼은 컷을 손으로 더하거나 다시 만들어 보세요.`
    : ''
  announce(`${epId ? `${epLabel(state.eps[epId])}에 ` : ''}${what}${josa(what, '을', '를')} 만들었습니다.${short}`)
  if (short) notice(`컷 ${cuts.length}개만 나왔습니다.${short}`, 'warn')
}

// ── 컷을 대본으로 ────────────────────────────────────────────────────────────
/*
 * 대본화는 story.js 의 planScript 가 들고 있습니다. 지금까지 그 함수를 부르는 곳은
 * story-graph.html 하나였고, 그 화면은 자기 메모리에 들고 있는 컷만 봅니다. 그래서
 * 보드에서 손으로 고친 컷이나 「이야기 기획」으로 만든 컷은 대본이 될 길이 없었습니다.
 * 이 자리가 그 길입니다.
 *
 * 보드는 컷을 넘기고 형식을 고르고 결과를 보여주기만 합니다. 대본을 쓰는 규칙(분량·
 * 지문·대사·씬 전환)은 story.js 에 그대로 둡니다. 대본화 화면과 같은 엔진이 돌아야
 * 두 화면의 대본이 같은 물건이 됩니다.
 */
let scriptStep = 'form'
let scriptMsg = ''
let scriptOut = ''
let scriptFmt = 'drama'

/*
 * 대본화에 넘길 컷. 지금 보고 있는 회차의 컷만 봅니다.
 *
 * cast 를 인물 id 에서 이름으로 바꿉니다. 보드는 id 로 들고 있고 planScript 는 이름을
 * 읽습니다(story.js 의 scriptFormatPrompt 가 cast.join 을 그대로 프롬프트에 넣습니다).
 * 안 바꾸면 대본에 "등장: char-1" 이 박힙니다.
 *
 * 키비주얼 화면이 붙인 씬 패널은 epId 가 없어서 본편 컷으로 함께 옵니다. 그림이 이미
 * 있는 씬이 대본에서도 한 씬으로 잡히는 것이 맞습니다.
 */
const scriptCuts = () => cutsOf(viewEp).map((p) => ({
  /*
   * 씬 이름에서 번호를 뗀다. 대본 형식이 자기 번호를 다시 붙이기 때문에 그냥 넘기면
   * 「S#1. S01 빵집 · 새벽」 처럼 번호가 두 번 나온다. 씬 묶음은 컷 순서로 정해지니
   * 번호를 떼도 잃는 것이 없다 (core.js 의 sceneMeta).
   */
  scene: sceneMeta(p.scene).where || p.scene,
  action: p.action, dialogue: p.dialogue, camera: p.camera, secs: p.secs,
  cast: (p.cast || []).map((id) => state.chars[id]?.name).filter(Boolean),
}))

function openScript(on) {
  const dlg = byId('script')
  if (on && !may('plan')) return
  if (on && !dlg.open) dlg.showModal()
  else if (!on && dlg.open) dlg.close()
  byId('scriptBtn').setAttribute('aria-expanded', String(on))
  if (on) renderScript()
}

function renderScript() {
  const body = byId('scriptBody')
  const cuts = scriptCuts()
  const secs = cuts.reduce((s, c) => s + (Number(c.secs) || 0), 0)
  const said = cuts.filter((c) => (c.dialogue || '').trim()).length
  const ep = state.eps[viewEp]

  setHtml(body, `
    <p class="adm__lead"><b>${esc(ep ? epLabel(ep) : (state.board.title || '본편'))}</b>
      <span class="adm__sep">·</span>컷 ${cuts.length}개 · ${clock(secs)}
      <span class="adm__sep">·</span>대사 있는 컷 ${said}개</p>

    ${cuts.length ? `
      <div class="plan__grid">
        <label class="f"><span class="f__label"><span class="mono">대본 형식</span></span>
          <select id="scFormat">${planOpt(Object.keys(SCRIPT_FORMATS), scriptFmt,
            (v) => SCRIPT_FORMATS[v].label)}</select></label>
      </div>
      <div class="acts">
        <button class="btn btn--solid" id="scGo" ${scriptStep === 'busy' ? 'disabled' : ''}>${
          scriptOut ? '대본 다시 만들기' : '대본 만들기'}</button>
        <button class="btn btn--line" id="scCancel">닫기</button>
      </div>` : `
      <p class="why">이 회차에 컷이 없습니다. 왼쪽 시나리오를 <b>컷으로 분해</b>하거나
        <b>이야기 기획</b>으로 컷을 먼저 만들어 주세요.</p>`}

    ${scriptStep === 'busy'
      ? `<div class="plan__wait"><span class="spin"></span><span>${esc(scriptMsg)}</span></div>`
      : (scriptMsg ? `<p class="why">${esc(scriptMsg)}</p>` : '')}

    ${scriptOut ? `
      <pre class="sc__text" id="scText">${esc(scriptOut)}</pre>
      <div class="acts">
        <button class="btn btn--line" id="scCopy">복사</button>
        <button class="btn btn--line" id="scDown">다운로드</button>
      </div>
      ${/* 복사를 권하는 이유: 디벨롭 화면의 대본 칸이 이 텍스트를 그대로 받습니다 */ ''}
      <p class="adm__note" id="scNote">${esc(scriptFileName(planCtx().title))} 으로 내려받습니다
        (UTF-8 BOM). 복사해서 <b>스토리 디벨롭</b> 화면의 대본 칸에 붙이면 이 컷들로
        관계 그래프를 뽑을 수 있습니다.</p>` : `
      <p class="adm__note">${net?.plan
        ? '컷의 지문·대사·카메라를 정식 대본 형식으로 폅니다. 컷 수에 따라 20초쯤 걸립니다.'
        : '로컬 모드입니다. 모델이 없어 형식만 갖춘 뼈대가 나옵니다. 진짜 대본은 배포된 판에서 나옵니다.'}</p>`}`)
}

async function runScriptOut() {
  const cuts = scriptCuts()
  if (!cuts.length) return
  scriptStep = 'busy'
  scriptMsg = `컷 ${cuts.length}개를 대본으로 옮기고 있습니다… 20초쯤 걸립니다.`
  scriptOut = ''
  renderScript()
  try {
    // 제목과 인물은 기획이 쓰는 것과 같은 것을 씁니다. 두 기능이 같은 판을 봅니다
    const ctx = planCtx()
    scriptOut = await planScript(net, cuts, { format: scriptFmt, title: ctx.title, chars: ctx.chars })
    scriptMsg = net?.plan ? '' : '로컬 모드 뼈대입니다. 형식만 맞춰 조합한 것입니다.'
    // 「웹드라마」는 받침이 없어 「로」입니다. 형식이 셋이라 하나만 어긋나도 늘 보입니다
    announce(`컷 ${cuts.length}개를 ${SCRIPT_FORMATS[scriptFmt].label}`
      + `${josa(SCRIPT_FORMATS[scriptFmt].label, '으로', '로')} 옮겼습니다.`)
  } catch (err) {
    console.warn('[board] 대본화 실패', err)
    scriptMsg = err?.message || '대본을 받지 못했습니다. 다시 시도해 주세요.'
  }
  scriptStep = 'form'
  renderScript()
}

/* 뽑은 대본을 클립보드로. 안내 줄을 그 자리에서 바꿔 눌린 것이 보이게 합니다 */
async function copyScript() {
  const note = byId('scNote')
  try {
    await navigator.clipboard.writeText(scriptOut)
    if (note) note.textContent = '대본을 클립보드에 복사했습니다. 스토리 디벨롭 화면의 대본 칸에 붙여 넣으세요.'
  } catch (err) {
    console.warn('[board] 복사 실패', err)
    if (note) note.textContent = '복사가 막혔습니다. 대본을 직접 선택해 복사해 주세요.'
  }
}

/* .txt 로 내려받습니다. BOM 은 scriptBlob 이 붙입니다 (BOM 없는 UTF-8 을 깨뜨리는 편집기가 있습니다) */
function downScript() {
  const url = URL.createObjectURL(scriptBlob(scriptOut))
  const a = document.createElement('a')
  a.href = url
  a.download = scriptFileName(planCtx().title)
  a.click()
  URL.revokeObjectURL(url)
}

// ── 대본을 시나리오로 불러오기 ───────────────────────────────────────────────
/*
 * 대본화 화면(story-graph.html?tab=script)은 만든 대본을 어디에도 저장하지 않습니다.
 * 화면 안 변수에 들고 있다가 「복사」·「다운로드」로 사람 손에 넘깁니다. 로그에 남는 것은
 * 「대본으로 옮겼습니다」 한 줄이고 본문은 없습니다. 그래서 보드가 대본을 받는 길은 둘입니다.
 * 내려받은 파일을 고르는 것과, 복사한 것을 붙여 넣는 것입니다. 이 창이 그 둘을 받습니다.
 *
 * 받은 대본은 그대로 시나리오 칸에 넣지 않습니다. 시나리오 칸은 「무엇이 보이는가」를 씬
 * 순서대로 적는 짧은 글을 위한 자리라서, 대본 한 편을 통째로 넣으면 읽을 수도 고칠 수도
 * 없습니다. Bedrock 이 붙어 있으면 모델에 줄이게 하고, 없으면 core.js 의
 * scenarioFromScript 가 뼈대를 만듭니다. 어느 쪽이든 넣기 전에 창에서 손으로 고칠 수 있고,
 * 넣은 뒤에도 시나리오 칸에서 그대로 고칠 수 있습니다.
 */
let impRaw = ''
let impName = ''
let impOut = ''
let impBusy = false
let impMsg = ''

/** 한 번에 모델에 넘기는 대본 길이 상한. 넘으면 앞부분만 줄인다 */
const IMPORT_CHARS = 12000

/*
 * 요약 지시. 나오는 모양을 scenarioFromScript 와 같게 맞춥니다. 그래야 모델이 있든
 * 없든 시나리오 칸에 들어오는 글의 모양이 같고, 「컷으로 분해」가 씬을 알아봅니다.
 */
const scenarioPrompt = (text) => [
  '아래 대본을 스토리보드 시나리오로 줄여라.',
  '',
  '규칙',
  '- 씬 머리줄을 대본에 나온 순서대로 남긴다. 「S01 장소 · 시간」 모양으로 한 줄에 쓴다.',
  '- 씬마다 한 문단. 화면에 보이는 것만 두세 문장으로 적는다. 문단 사이는 빈 줄로 나눈다.',
  '- 대사는 씬을 여는 한 줄만 「」 로 감아 남긴다. 「이름: 대사」 모양은 쓰지 않는다.',
  '- 대본에 없는 사건·인물을 만들지 않는다.',
  '- 전체 1500자 이내. 머리말·설명·코드펜스 없이 시나리오만 출력한다. 한국어로 쓴다.',
  '',
  '대본:',
  text.slice(0, IMPORT_CHARS),
].join('\n')

function openImport(on) {
  const dlg = byId('imp')
  if (on && !may('plan')) return
  if (on && !dlg.open) dlg.showModal()
  else if (!on && dlg.open) dlg.close()
  byId('importBtn').setAttribute('aria-expanded', String(on))
  if (on) renderImport()
}

/*
 * 붙여 넣은 대본이 어떻게 읽혔는지 한 줄로 말해 준다. 창을 다시 그리지 않고 이 줄만
 * 갈아 끼운다 (아래 input 처리). 타이핑 중에 창을 다시 그리면 커서가 앞으로 튄다.
 */
function impMetaHtml() {
  if (!impRaw) return '아직 대본이 없습니다.'
  const got = splitScript(impRaw)
  return `${impName ? `${esc(impName)} · ` : ''}${impRaw.length.toLocaleString('ko-KR')}자${
    got ? ` · 씬 ${new Set(got.cuts.map((c) => c.scene)).size}개 · 인물 ${got.names.length}명`
      : ' · 대본 형식으로는 안 읽힙니다'}${
    impRaw.length > IMPORT_CHARS ? ` · 앞 ${IMPORT_CHARS.toLocaleString('ko-KR')}자만 씁니다` : ''}`
}

function renderImport() {
  const box = byId('impBody')
  if (!box) return
  setHtml(box, `
    <label class="adm__row"><span class="mono">대본화에서 내려받은 파일</span>
      <input type="file" id="impFile" accept=".txt,.md,.fountain,.fdx" ${impBusy ? 'disabled' : ''}></label>
    <p class="hint">대본화 화면의 <b>다운로드</b>로 받은 <span class="mono">*_대본.txt</span> 를 고르거나,
      <b>복사</b>한 것을 아래에 붙여 넣습니다.</p>
    <textarea id="impRaw" class="imp__raw" spellcheck="false" placeholder="대본 붙여넣기"
      ${impBusy ? 'disabled' : ''}>${esc(impRaw)}</textarea>
    <p class="plan__meta" id="impMeta">${impMetaHtml()}</p>
    <div class="adm__row">
      <button class="btn btn--solid" id="impGo" ${impBusy || !impRaw.trim() ? 'disabled' : ''}>
        <span class="mono">시나리오로 요약</span></button>
      <button class="btn btn--line" id="impCancel"><span class="mono">닫기</span></button>
    </div>
    ${impBusy ? '<div class="adm__note"><span class="spin"></span> 대본을 시나리오로 줄이고 있습니다… 20초쯤 걸립니다.</div>' : ''}
    ${impMsg ? `<div class="adm__note">${esc(impMsg)}</div>` : ''}
    ${impOut ? `
      <h3 class="mono h" style="margin-top:14px">시나리오 (넣기 전에 고칠 수 있습니다)</h3>
      <textarea id="impOut" class="imp__out" spellcheck="false">${esc(impOut)}</textarea>
      <div class="adm__row">
        <button class="btn btn--solid" id="impPut"><span class="mono">시나리오 칸에 넣기</span></button>
        <span class="plan__meta">${impOut.length.toLocaleString('ko-KR')}자 · ${
          impOut.split(/\n{2,}/).filter((s) => s.trim()).length}문단</span>
      </div>` : ''}`)
}

/** 고른 파일을 읽는다. .fdx(Final Draft)는 story.js 의 scriptToText 가 평문으로 바꾼다 */
async function readScriptFile(file) {
  if (!file) return
  try {
    impRaw = scriptToText(await file.text(), file.name)
    impName = file.name
    impOut = ''
    impMsg = impRaw.trim() ? '' : '파일에서 글자를 찾지 못했습니다.'
  } catch (err) {
    console.warn('[board] 대본 파일 읽기 실패', err)
    impMsg = '파일을 읽지 못했습니다. 텍스트로 붙여 넣어 주세요.'
  }
  renderImport()
}

async function summarizeScript() {
  const text = impRaw.trim()
  if (!text) return
  // 모델이 없으면 로컬 뼈대로 간다. 그 경우 대본으로 읽히지 않으면 줄일 수가 없다
  if (!net?.plan) {
    impOut = scenarioFromScript(text)
    impMsg = impOut
      ? '로컬 모드 뼈대입니다. 씬 머리줄과 지문만 남기고 대사를 한 줄로 줄였습니다.'
      : '대본 형식(S#·INT./EXT.·「이름: 대사」)으로 읽히지 않아 줄일 수 없습니다. 직접 시나리오를 쓰거나 대본 형식으로 붙여 주세요.'
    renderImport()
    return
  }
  impBusy = true
  impMsg = ''
  impOut = ''
  renderImport()
  try {
    const res = await net.plan({ prompt: scenarioPrompt(text), maxTokens: 2000, think: false })
    impOut = String(res?.text ?? '').trim()
    if (!impOut) throw new Error('빈 응답')
    if (res?.stop === 'max_tokens') impMsg = '응답 상한에서 잘렸습니다. 뒷부분은 직접 이어 써 주세요.'
    announce('대본을 시나리오로 줄였습니다.')
  } catch (err) {
    console.warn('[board] 시나리오 요약 실패', err)
    // 모델이 안 되어도 손을 놓지 않는다. 로컬 뼈대라도 내놓는다
    impOut = scenarioFromScript(text)
    impMsg = impOut
      ? '모델을 부르지 못해 로컬 뼈대로 줄였습니다. 필요하면 고쳐 쓰세요.'
      : (err?.message || '요약에 실패했습니다. 다시 시도해 주세요.')
  }
  impBusy = false
  renderImport()
}

/*
 * 시나리오 칸에 넣는다. 지금 보고 있는 회차의 시나리오다 (없으면 판 전체).
 * 이미 쓴 것이 있으면 덮어쓰기 전에 물어본다. 되돌리기는 없다.
 */
function putScenario() {
  const el = byId('impOut')
  const text = (el ? el.value : impOut).trim()
  if (!text) return
  const cur = byId('scenario').value.trim()
  if (cur && !confirm('시나리오 칸에 이미 쓴 글이 있습니다. 이 시나리오로 바꿀까요?')) return
  byId('scenario').value = text
  const ep = viewEp
  if (ep) { state.eps[ep].scenario = text; emit({ kind: 'ep.patch', epId: ep, fields: { scenario: text } }) }
  else { state.board.scenario = text; emit({ kind: 'board.patch', fields: { scenario: text } }) }
  renderBreakdown()
  openImport(false)
  announce('시나리오 칸에 넣었습니다. 이어서 컷으로 분해할 수 있습니다.')
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
  /*
   * 그림 만들기는 「내용 편집」이 아니라 「이미지 만들기」권한입니다. 예전에는 생성 단추까지
   * editable 로 잠가서, 권한 관리에서 「이미지 만들기」를 허용해도 「내용 편집」이 막힌
   * 사람에게는 단추가 그대로 잠겨 있었습니다. 승인된 컷은 둘 다 잠깁니다(이야기의 규칙).
   */
  const artOk = p.status !== 'approved' && may('art')
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
  const noArt = nope(p.status === 'approved' ? whyNotEdit(p) : whyNot('art'))
  const dis = () => (editable ? '' : `readonly ${noEdit}`)

  const o = optsFor(p)
  const refs = refChoices(p)
  // 고른 그림이 사라졌으면(인물을 떼거나 버전을 지웠으면) 다시 기본값으로 돌립니다
  if (o.ref !== null && !refs.some((r) => r.key === o.ref)) o.ref = null
  const refKey = refKeyOf(p)
  const pickedRef = refs.find((r) => r.key === refKey)
  // 참조 자산. 고른 것(없으면 autoAssets)과 고를 수 있는 전부, 그리고 이 컷에서 뽑은 것
  const assetIds = assetIdsOf(p)
  const assetOn = new Set(assetIds)
  const assetPool = p.charId ? [] : refAssets()
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
  const faceNote = noFace ? `
    <p class="why">붙여 둔 인물에게 참조할 얼굴이 아직 없습니다. 인물 화면에서 마음에 드는 버전을
      「이 버전을 기준으로」 잡거나 구도를 승인하면, 그 얼굴이 여기 칩으로 올라옵니다.</p>`
    : !pickedRef?.face ? '' : `
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
      씁니다 — 먼저 「AI로 생성」으로 그림을 한 장 만드세요.</p>` : `
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
   * (genBlock)과 달리 감독에게도 보입니다 — 승인을 누르는 사람이 감독이라 뽑는 진행도 그
   * 화면에 뜹니다.
   */
  const assetsHref = navHref('assets', boardFromSearch())
  /*
   * 이 그림을 그대로 자산으로. 뽑기(GPU 로 다시 그림)와 달리 승인·서버가 없어도 됩니다.
   * 종류 세 개가 곧 단추입니다 — 고르고 저장하는 두 걸음을 한 번에 합칩니다.
   */
  const keptOf = (t) => assetsFrom(p.id).some((a) => a.type === t && a.source === 'keep')
  const keepLine = p.charId || !stillOf(p) || !mayExtract() ? '' : `
    <p class="why">이 그림을 그대로 <a href="${esc(assetsHref)}">자산관리</a>에 넣기:
      ${REF_TYPES.map((t) => `<button type="button" class="mini" data-do="keep:${t}"
        title="${keptOf(t) ? '이미 넣은 자산의 그림을 이 그림으로 바꿉니다' : `${ASSET_TYPES[t]} 자산으로 저장`}">${ASSET_TYPES[t]}${keptOf(t) ? ' ✓' : ''}</button>`).join('')}</p>`
  const assetLine = keepLine + (p.charId || !canGen ? '' : extracting ? `
    <p class="why why--busy">${esc(extracting)}</p>` : p.status !== 'approved' ? `
    <p class="why">감독이 이 컷을 승인하면 그 그림에서 인물·배경·소품을 따로 그려
      <a href="${esc(assetsHref)}">자산관리</a>에 넣습니다.</p>` : `
    <p class="why">${assetMine.length
    ? `이 컷에서 뽑은 자산 ${assetMine.length}개가 <a href="${esc(assetsHref)}">자산관리</a>에 있습니다.`
    : `승인은 됐지만 뽑은 자산이 없습니다.${extractWhy ? ` ${esc(extractWhy)}.` : ''}`}
      ${extractWhy ? '' : `<button type="button" class="mini" data-do="extract">${assetMine.length ? '다시 뽑기' : '자산으로 뽑기'}</button>`}</p>`)

  const genBlock = !may('art') ? `
    <h2 class="mono h" style="margin-top:22px">이미지</h2>
    <p class="why">${esc(whyNot('art'))}. 필요한 그림이 있으면 아래 메모로 남겨주세요.</p>` : `
    <h2 class="mono h" style="margin-top:22px">이미지 만들기</h2>
    <label class="f">
      <span class="f__label"><span class="mono">생성 지시</span>
        ${o.prompt !== null ? '<button class="mini" data-do="autofill">작업 내용으로 다시 채우기</button>' : ''}</span>
      <textarea rows="3" id="genPrompt" placeholder="어떤 그림이 필요한지 적어주세요. 한국어로 써도 됩니다." ${artOk ? '' : `readonly ${noArt}`}>${esc(o.prompt ?? autoPrompt(p))}</textarea>
    </label>
    <div class="gen__row">
      <span class="mono gen__lab">기반 이미지</span>
      ${refs.map((r) => `<button class="chip" data-ref="${r.key}" data-on="${refKey === r.key ? 1 : 0}" title="${esc(r.hint || '')}" ${artOk ? '' : noArt}>${esc(r.label)}</button>`).join('')}
    </div>
    ${/* 고른 기반 이미지를 눈으로 확인시켜 줍니다. 이름만 있으면 무엇을 물려받는지 모릅니다 */ ''}
    ${pickedRef?.srcs ? `<div class="gen__ref gen__ref--many">${pickedRef.srcs.map((s) => media(s, 'alt="" loading="lazy"')).join('')}</div>`
    : pickedRef?.src ? `<div class="gen__ref">${media(pickedRef.src, 'alt="" loading="lazy"')}</div>` : ''}
    ${/*
      * 참조 자산. 여러 장을 고릅니다 — 인물 둘과 배경과 상품이 각각 한 장씩 서버로 갑니다
      * (klein 은 그림 목록을 조건으로 받습니다). 자산이 하나도 없는 판에는 줄을 내지 않습니다.
      */ ''}
    ${assetPool.length ? `
    <div class="gen__row gen__row--top">
      <span class="mono gen__lab">참조 자산</span>
      <div class="alib alib--pick" ${artOk ? '' : noArt}>${assetPool.map((a) => assetCard(a, { pick: assetOn.has(a.id) })).join('')}</div>
    </div>
    <p class="why">${assetIds.length
      ? `자산 ${assetIds.length}장을 참조로 보냅니다. 인물은 그 얼굴로, 배경은 그 장소로, 소품은 그 물건 그대로 새 구도를 그립니다.${
        refKey === 'none' ? '' : ' 위에서 고른 기반 이미지도 뒤에 한 장 더 붙습니다.'}`
      : '컷에 붙인 인물의 자산과 같은 씬의 배경은 저절로 들어갑니다. 소품은 그 물건이 나오는 컷에서 직접 고르세요.'}</p>` : ''}
    ${faceNote}
    ${refKey === 'keyvisual' ? `
      <p class="why">${esc(sceneMeta(p.scene).no || '이 씬')}의 키 비주얼을 기반으로 잡아 두었습니다.
        키비주얼 화면에서 그 씬 하나를 보고 그린 그림이라, 장소와 빛이 같은 씬의 다른 컷과 어긋나지 않습니다.</p>` : ''}
    ${modelNote}
    ${refKey === 'none' && !assetIds.length ? '' : picked?.init === false ? `
      <p class="why">${esc(picked.label)}은 기반 이미지를 받지 않습니다. ${connPick || !keepModelId()
        ? '지시문만 보고 새로 그립니다.'
        : `참조를 고른 이 컷은 ${esc(modelOf(keepModelId())?.label || '')}이 그립니다 — 그 모델이 그림을 조건으로 받습니다.`}</p>`
    : connPick && picked.strength !== true ? `
      <p class="why">${esc(picked.label)}은 기반 이미지를 참고해서 그립니다. 변형 정도를 받는 칸은 이 모델에 없습니다.</p>`
      : picked && picked.strength === false ? `
      <p class="why">${esc(picked.label)}은 기반 이미지를 지우고 다시 그리지 않습니다. 조건으로 받아서 인물을 그대로 살립니다. 그래서 변형 정도가 없습니다.</p>` : `
      ${/* 슬라이더는 readonly 를 받지 않습니다. 잠근 채 두고 data-nope 는 감싼 줄에 답니다 */ ''}
      <div class="gen__row" ${artOk ? '' : noArt}>
        <span class="mono gen__lab">변형 정도</span>
        <input type="range" id="genStrength" min="0.75" max="0.95" step="0.1" value="${o.strength}" ${artOk ? '' : 'disabled'}>
        <span class="mono gen__val">${morph(o.strength)}</span>
      </div>
      <p class="why">‘선 그대로’는 올린 스케치를 거의 유지하고, ‘새로 그리기’는 구도까지 모델이 다시 잡습니다.</p>`}
    <div class="acts">
      <button class="btn btn--line" data-do="upload" ${artOk ? '' : noArt}>스케치 올리기</button>
      <button class="btn btn--solid" data-do="generate" ${!artOk ? noArt : busyBy ? 'disabled' : ''}>
        ${busyBy ? `${esc(busyBy.name)} 생성 중…` : assetIds.length ? `자산 ${assetIds.length}장으로 생성`
    : refKey === 'none' ? 'AI로 생성'
      : pickedRef?.face ? '이 인물로 생성' : '이 이미지를 기반으로 생성'}
      </button>
      ${clipBtn}
    </div>
    ${clipping ? `<p class="why">${esc(clipping)}</p>` : ''}
    ${p.genError ? `<p class="why why--bad">${esc(p.genError)}</p>` : hint ? `<p class="why">${esc(hint)}</p>` : ''}
    ${clipRow}`

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
      <input type="text" data-field="pose" value="${esc(p.pose || '')}" ${dis()}>
    </label>
    ${lostRow(p.id, 'pose')}

    <label class="f">
      <span class="f__label"><span class="mono">작업 지시</span>${lockNote('action')}</span>
      <textarea rows="3" data-field="action" placeholder="이 구도에서 무엇을 보여줄지" ${dis()}>${esc(p.action)}</textarea>
    </label>
    ${lostRow(p.id, 'action')}`

  const cutFields = `
    <div class="f--row">
      <label class="f">
        <span class="f__label"><span class="mono">씬</span>${lockNote('scene')}</span>
        <input type="text" data-field="scene" value="${esc(p.scene || '')}" placeholder="씬 1 · 새벽 거리" ${dis()}>
      </label>
      <label class="f f--narrow">
        <span class="f__label"><span class="mono">길이(초)</span>${lockNote('secs')}</span>
        <input type="number" data-field="secs" min="0" step="0.5" value="${p.secs ?? ''}" ${dis()}>
      </label>
    </div>
    ${lostRow(p.id, 'scene')}
    <p class="why">같은 씬 이름을 붙인 이웃한 컷이 한 씬으로 묶입니다. 길이는 타임라인 폭이 됩니다.</p>

    <label class="f">
      <span class="f__label"><span class="mono">등장 인물</span></span>
      <div class="cast">
        ${charList().length
          ? charList().map((c) => `<button class="cast__chip" data-cast="${c.id}" data-on="${(p.cast || []).includes(c.id) ? 1 : 0}" ${editable ? '' : noEdit}>${esc(c.name)}</button>`).join('')
          : '<span class="anchor__none">인물을 먼저 만들면 컷에 붙일 수 있습니다.</span>'}
      </div>
    </label>

    <label class="f">
      <span class="f__label"><span class="mono">화면 설명</span>${lockNote('action')}</span>
      <textarea rows="3" data-field="action" ${dis()}>${esc(p.action)}</textarea>
    </label>
    ${lostRow(p.id, 'action')}

    <label class="f">
      <span class="f__label"><span class="mono">대사 / 자막</span>${lockNote('dialogue')}</span>
      <textarea rows="2" data-field="dialogue" ${dis()}>${esc(p.dialogue || '')}</textarea>
    </label>
    ${lostRow(p.id, 'dialogue')}

    <label class="f">
      <span class="f__label"><span class="mono">카메라</span>${lockNote('camera')}</span>
      <input type="text" data-field="camera" value="${esc(p.camera || '')}" ${dis()}>
    </label>
    ${lostRow(p.id, 'camera')}`

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

      ${/* select 은 readonly 를 받지 않습니다. 잠근 채 두고 data-nope 는 감싼 칸에 답니다 */ ''}
      <label class="f" ${may('assign') ? '' : nope(whyNot('assign'))}>
        <span class="f__label"><span class="mono">담당</span></span>
        <select data-field="assignee" ${may('assign') ? '' : 'disabled'}>
          ${assignOpts(p.assignee)}
        </select>
      </label>

      ${ch ? poseFields : cutFields}

      ${genBlock}
      ${assetLine}

      <h2 class="mono h" style="margin-top:22px">버전 ${live.length ? `<span class="count">${live.length}</span>` : ''}
        <button class="mini" data-do="viewer" ${ver ? '' : 'disabled'}
          title="${ver ? '' : '먼저 이미지가 있어야 합니다'}">크게 보기 · 핀 메모</button>
        <button class="mini" data-do="rmver" ${rmWhy ? 'disabled' : ''}
          title="${esc(rmWhy || `v${cur.i + 1}을 보드에서 지웁니다`)}">이 버전 지우기</button></h2>
      ${live.length ? `<ul class="vers">${p.versions.map((v, i) => deadVer(p, v) ? '' : `
        <li><button class="ver" data-ver="${i}" data-current="${i === cur?.i ? 1 : 0}">
          ${media(srcOf(v), 'class="ver__thumb" alt="" loading="lazy"')}
          <span>v${i + 1} · ${esc(person(v.author)?.name || '알 수 없음')}
            <br><span class="ver__meta">${esc(v.gen ? `${v.gen.model} · seed ${v.gen.seed} · ${(v.gen.ms / 1000).toFixed(1)}초` : v.name || fmtWhen(v.ts))}</span></span>
          <span class="ver__src">${VER_SRC[v.source] || '업로드'}</span>
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
  lock(byId('planBtn'), 'plan', () => openPlan(false))
  // 관계 그래프 화면(story-graph.html)은 따로 뜨는 페이지다. 기획 권한과 같이 다룬다.
  // 이 판을 들고 가야 그 화면이 같은 프로젝트를 연다(?board=)
  const gr = byId('graphBtn')
  gr.href = navHref('develop', boardFromSearch())
  lock(gr, 'plan')
  // 대본화도 모델을 부른다. 기획과 같은 권한으로 묶는다
  lock(byId('scriptBtn'), 'plan', () => openScript(false))
  // 대본 불러오기도 요약에 모델을 쓴다. 같은 권한으로 묶는다
  lock(byId('importBtn'), 'plan', () => openImport(false))
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
    ${powerBusy ? `<p class="menu__note">${esc(powerBusy)}</p>`
    : gpu.state === 'down' ? '<button data-power="on">GPU 켜기 <span class="mono">약 3~4분</span></button>'
      : '<button data-power="off" data-danger="1">GPU 끄기 <span class="mono">팀 전원의 생성이 멈춥니다</span></button>'}
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
byId('histMine').addEventListener('click', () => { histMine = !histMine; renderHist() })

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
  // 붙여 넣는 순간 대본으로 알아봤는지 보여준다. 파싱은 줄 훑기라 타이핑마다 돌려도 된다
  renderBreakdown()
  clearTimeout(scenTimer)
  scenTimer = setTimeout(() => emit(epId
    ? { kind: 'ep.patch', epId, fields: { scenario: text } }
    : { kind: 'board.patch', fields: { scenario: text } }), 200)
})

/*
 * 컷으로 분해.
 *
 * 붙여 넣은 것이 정형 대본이면 대본으로 읽는다 (core.js 의 splitScript). 그러면 씬 이름·
 * 지문·대사·등장인물·컷 길이가 다 갈라져 나오고, 대본에 있던 사람은 인물 카드까지 함께
 * 생긴다 — 「이야기 기획」이 하는 것과 같다. 대본으로 안 읽히면 예전처럼 빈 줄로 쪼갠다.
 *
 * 산문 쪽 컷 모양은 건드리지 않는다. scene·secs·origin 은 대본 쪽에만 붙인다. 산문에는
 * 씬이라는 것이 없으니 빈 값을 박아 넣으면 씬 묶음(sceneGroups)에 없던 칸이 생긴다.
 *
 * 묻는 창이 세 갈래인 이유. 예전에는 「뒤에 추가합니다. 계속할까요?」 하나였다. 잘못
 * 나눈 사람이 다시 누르면 컷이 3개에서 6개로 늘기만 하고 되돌릴 자리가 없었다. 그리고
 * 산문은 12개에서 조용히 잘렸다 — 문단 30개를 붙여도 컷 12개가 나오고 아무 말이 없었다.
 * 지금은 몇 개가 되고 몇 개가 빠지는지 먼저 보여주고, 덧붙일지 갈아치울지 고르게 한다.
 */
byId('breakdown').addEventListener('click', async () => {
  if (viewChar) return
  const text = byId('scenario').value
  const script = splitScript(text)
  // 산문도 대본과 같은 상한을 쓴다. 자르기 전의 수를 여기서 세는 이유는 「몇 개 중 몇 개」를
  // 사람에게 말해 주려면 부르는 쪽이 상한을 들고 있어야 하기 때문이다
  const all = script ? script.cuts : splitScenario(text, Infinity)
  const cuts = all.slice(0, CUT_MAX)
  const dropped = all.length - cuts.length
  if (!cuts.length) return notice('시나리오를 먼저 넣어주세요.')

  // 대본에 있는데 판에 없는 사람. 이 사람들의 인물 카드를 함께 만든다
  const byName = new Map(charList().map((c) => [c.name, c.id]))
  const fresh = (script?.names || []).filter((n) => !byName.has(n))

  const had = cutsOf(viewEp)
  let wipe = false
  if (had.length || dropped) {
    const ans = await confirmAsk({
      title: script ? '대본을 컷으로 옮깁니다' : '시나리오를 컷으로 나눕니다',
      body: had.length ? '이미 있는 컷 뒤에 붙일지, 그것을 지우고 갈아치울지 고릅니다.' : '',
      list: [
        `새 컷 ${cuts.length}개${fresh.length ? ` · 새 인물 ${fresh.length}명` : ''}`,
        ...(dropped ? [`상한 ${CUT_MAX}개를 넘은 ${dropped}개는 컷이 되지 않습니다`] : []),
        ...(had.length ? [`이 회차에 이미 있는 컷 ${had.length}개`] : []),
      ],
      yes: had.length ? '뒤에 덧붙이기' : '컷으로 나누기',
      alt: had.length ? `있는 컷 ${had.length}개를 지우고 갈아치우기` : '',
    })
    if (!ans) return
    wipe = ans === 'alt'
  }

  const ops = []
  // 갈아치우기. 컷에 달린 메모도 함께 사라진다(panel.remove 리듀서). 인물 구도는 컷이
  // 아니라서 건드리지 않는다
  if (wipe) for (const p of had) ops.push({ kind: 'panel.remove', panelId: p.id })
  let ck = charList().at(-1)?.orderKey ?? null
  for (const name of fresh) {
    const id = uid()
    byName.set(name, id)
    ck = orderKeyBetween(ck, null)
    // brief 는 비워 둔다. 대본은 사람의 생김새를 말해 주지 않는다. 인물 화면에서 채운다
    ops.push({
      kind: 'char.add',
      char: {
        id, name, brief: '', seedNo: Math.floor(Math.random() * 900) + 20,
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

  let key = wipe ? null : cutsOf(viewEp).at(-1)?.orderKey ?? null
  let firstNew = null
  for (const cut of cuts) {
    key = orderKeyBetween(key, null)
    const cutId = uid()
    firstNew ??= cutId
    ops.push({
      kind: 'panel.add',
      panel: {
        id: cutId, charId: null, orderKey: key, ...(viewEp ? { epId: viewEp } : {}),
        ...(script ? { origin: 'script', scene: cut.scene, secs: cut.secs } : {}),
        action: cut.action, dialogue: cut.dialogue, camera: cut.camera,
        cast: script ? (cut.cast || []).map((n) => byName.get(n)).filter(Boolean) : [],
        status: 'draft', assignee: null, versions: [], current: -1, generating: false,
      },
    })
  }
  /*
   * 만든 첫 컷을 골라 둔다. 예전에는 아무것도 골라지지 않아서, 컷이 쏟아진 뒤에도 오른쪽
   * 판(폭의 4분의 1)이 「구도나 컷을 선택하면…」 한 줄로 비어 있었다. 다음에 할 일이
   * 그 판에서 컷을 고치는 것이라 첫 컷을 열어 두는 것이 그 자리의 답이다.
   *
   * emitMany 보다 먼저 적는다. 그것이 op 를 판에 넣고 다시 그리므로, 그때 이미 골라져
   * 있어야 한 번에 그려진다
   */
  if (firstNew) selectedId = firstNew
  emitMany(ops)
  // 「개」에는 받침이 없고 「명」에는 있다. 붙는 조사가 갈리므로 josa 로 고른다
  const made = `컷 ${cuts.length}개${fresh.length ? `와 인물 ${fresh.length}명` : ''}`
  notice(`${script ? '대본을' : '시나리오를'} ${made}${josa(made, '으로', '로')} ${
    wipe ? '갈아치웠습니다' : '나눴습니다'}${
    dropped ? ` · ${dropped}개는 상한을 넘어 빠졌습니다` : ''}`, 'ok')
})

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
  if (!p) return
  /*
   * 영상 길이·화질은 판에 남기지 않습니다. 컷의 성질이 아니라 지금 한 번 만들 때의 선택이고,
   * 다시 그리면 또 고를 것입니다. 걸리는 시간 줄만 다시 그립니다.
   */
  if (e.target.id === 'clipSecs') { clipOpts.secs = Number(e.target.value); renderDetail(); return }
  if (e.target.id === 'clipQuality') { clipOpts.quality = e.target.value; renderDetail(); return }
  if (e.target.dataset.field !== 'assignee') return
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
  const assetId = e.target.closest('[data-asset]')?.dataset.asset

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
   * 참조 자산을 켜고 끕니다. 처음 누르는 순간 autoAssets 의 값이 실제 값으로 굳습니다 —
   * 그 뒤로 인물을 붙여도 저절로 늘지 않습니다. 사람이 손댄 목록은 사람의 것입니다.
   */
  if (assetId) {
    if (!mayEdit(p)) { notice(whyNotEdit(p)); return }
    const cur = assetIdsOf(p)
    optsFor(p).assets = cur.includes(assetId) ? cur.filter((x) => x !== assetId) : [...cur, assetId]
    renderDetail()
    return
  }
  if (doWhat === 'extract') { extractAssets(p); return }
  if (doWhat?.startsWith('keep:')) { keepAsAsset(p, doWhat.slice(5)); return }
  if (doWhat === 'autofill') { optsFor(p).prompt = null; renderDetail(); return }
  if (doWhat === 'viewer') { openViewer(p.id); return }
  if (memoClick(e, p, 'cmtInput')) return

  if (castId) {
    const on = (p.cast || []).includes(castId)
    const next = on ? p.cast.filter((x) => x !== castId) : [...(p.cast || []), castId]
    // 인물을 붙이면 그 얼굴이 기본 기반 이미지가 됩니다(autoRef). 그때 변형 정도는
    // '새로 그리기'여야 합니다. 얼굴만 물려받고 구도는 이 컷의 것이어야 하니까
    const o = optsFor(p)
    if (o.ref === null && !on) o.strength = 0.95
    emit({ kind: 'panel.patch', panelId: p.id, fields: { cast: next } })
    return
  }

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
        byId('actWhy').textContent = '수정 요청에는 이유가 필요합니다. 메모를 먼저 적어주세요.'
        input.focus()
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

const scriptDlg = byId('script')
byId('scriptBtn').addEventListener('click', () => openScript(true))
byId('scriptClose').addEventListener('click', () => openScript(false))
scriptDlg.addEventListener('close', () => byId('scriptBtn').setAttribute('aria-expanded', 'false'))
// 형식만 바꿀 때는 다시 그리지 않는다. 셀렉트는 브라우저가 이미 바꿔 놨다
scriptDlg.addEventListener('input', (e) => { if (e.target.id === 'scFormat') scriptFmt = e.target.value })
scriptDlg.addEventListener('click', (e) => {
  if (e.target.closest('#scCancel')) return openScript(false)
  if (e.target.closest('#scGo')) return runScriptOut()
  if (e.target.closest('#scCopy')) return copyScript()
  if (e.target.closest('#scDown')) return downScript()
})

const impDlg = byId('imp')
byId('importBtn').addEventListener('click', () => openImport(true))
byId('impClose').addEventListener('click', () => openImport(false))
impDlg.addEventListener('close', () => byId('importBtn').setAttribute('aria-expanded', 'false'))
/*
 * 붙여 넣는 칸은 다시 그리지 않고 값만 받아 둔다. 글자마다 다시 그리면 커서가 앞으로
 * 튄다. 대신 문단 수·씬 수를 세는 줄은 요약을 누를 때 새로 그린다.
 */
impDlg.addEventListener('input', (e) => {
  if (e.target.id === 'impRaw') {
    impRaw = e.target.value
    impName = ''
    setHtml(byId('impMeta'), impMetaHtml())
    // 붙여 넣기 전에는 요약할 것이 없어 잠가 두었다. 글이 들어왔으니 푼다
    byId('impGo').disabled = impBusy || !impRaw.trim()
  }
  if (e.target.id === 'impOut') impOut = e.target.value
})
impDlg.addEventListener('change', (e) => {
  if (e.target.id === 'impFile') readScriptFile(e.target.files?.[0])
})
impDlg.addEventListener('click', (e) => {
  if (e.target.closest('#impCancel')) return openImport(false)
  if (e.target.closest('#impGo')) return summarizeScript()
  if (e.target.closest('#impPut')) return putScenario()
})

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
