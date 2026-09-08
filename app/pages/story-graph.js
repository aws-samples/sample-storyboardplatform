/*
 * 스토리 디벨롭 화면 · 대본에서 그래프를 뽑고, 씨앗과 분기를 거쳐 다시 대본으로 돌아옵니다.
 *
 * 마크업과 CSS 는 app/story-graph.html 에 있고 여기는 그 화면의 코드입니다. 한때 그
 * 파일의 <script type="module"> 안에 1,660줄이 같이 있었습니다. 다른 세 화면은 처음부터
 * 코드를 파일로 뺐는데(pages/home.js · board.js · key-visual.js) 이 화면만 아니었고,
 * 그래서 화면 코드를 찾을 때 세 번은 파일이 나오고 한 번은 안 나왔습니다.
 */

// 대본 → 그래프 → 씨앗 → 분기 → 대본 → 역기입 → 대본화까지를 한 화면에서 돌린다.
//   그래프  app-walkthrough/data/graph.json 을 읽거나, 대본에서 planGraph 로 뽑는다
//   씨앗    graph-probes.js 의 탐지기 12종 (?seeds=mock 이면 app-walkthrough/data/seeds.json)
//   분기    planBranches / planFreeBranches. Bedrock 이 없으면 로컬 폴백
//   대본    branchToSpec → planBranchOutline → planCuts. 기존 기획 파이프라인 그대로다
//   역기입  applyWriteback. 그래프가 자라고 씨앗이 다시 뽑힌다 (루프의 고리)
//   대본화  planScript. 컷을 드라마·영화·웹드라마 대본 텍스트로 옮긴다
// 조회는 전부 graph-engine.js 의 GraphStore 를 거친다. 배포에서는 같은 저장소가
// Neptune 을 사실로 두고 돈다 (hasGraph). 이 화면이 아는 차이는 save·flush 뿐이다.
import { createGraphStore, loadGraphStore, DEFAULT_PROJECT } from '../services/graph-store.js'
import { findSeeds, PROBES } from '../domain/graph-probes.js'
import { planGraph, planBranches, planFreeBranches, planBranchOutline, planCuts, planScript } from '../services/planner.js'
import { localBranches, branchToSpec } from '../domain/local-fallback.js'
import { scriptToText, scriptBlob, scriptFileName, SCRIPT_FORMATS } from '../domain/script-format.js'
import { applyWriteback, validateWritebackBeforeApply } from '../domain/graph-writeback.js'
import { GENRES, TONES, LENGTHS, CUTCOUNTS } from '../domain/prompts.js'
import { planClient, graphClient, opsClient, runNavigateJob } from '../services/api.js'
import { mountNavigatorChat, readHistory } from '../components/navigator-chat.js'
import { createGraphView, graphDelta, KIND_COLOR, KIND_LABEL } from '../components/graph-canvas.js'
import { edgeKey } from '../domain/graph-schema.js'
import { configured, session, login, setNewPassword, logout } from '../services/auth.js'
import { DEMO_USERS } from '../components/login-form.js'
import { NAV_TABS, navHref, navTabFromSearch, boardFromSearch } from '../domain/routes.js'
import { mountNav } from '../components/nav-tabs.js'
import { mountBrand } from '../components/brand.js'
import { entries, group, markOp } from '../services/activity-log.js'
import { paintList } from '../components/history-list.js'
import { emptyPanel } from '../components/empty-panel.js'
import { guiding } from '../../app-walkthrough/guide.js'
import { developExample } from '../../app-walkthrough/steps/develop.js'
import { wire as wireTour, demoActive, demoAdvance, demoSay, demoTitle } from '../../app-walkthrough/tour.js'
import * as coach from '../components/coachmark.js'
import { pickProject } from '../components/project-picker.js'
import { touch as touchProject } from '../services/projects.js'
import { saveAsset, loadAsset } from '../services/assets.js'
import { allowed, denyReason, isDenied } from '../domain/permissions.js'
import { confirmAsk } from '../components/confirm.js'

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


const $ = (id) => document.getElementById(id)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const params = new URLSearchParams(location.search)
const GRAPH_SRC = params.get('graph') || '/app-walkthrough/data/graph.json'
const SEED_SRC = params.get('seeds') === 'mock' ? 'mock' : 'probes'
const SEEDS_SHOWN = 12

const NET = planClient()
// 그래프 저장소. 배포에서 hasGraph 가 켜져 있을 때만 나온다. 없으면 인메모리로 돈다
const GRAPH_NET = graphClient()

/**
 * 지금 고른 모델. 이 화면의 Bedrock 호출은 모두 이것을 실어 보낸다 (추출·요약·분기·대본).
 * 값은 infra/resolvers/plan.js 의 MODELS 키다. 모르는 값이 가면 리졸버가 기본 모델로 내린다.
 * 로컬 모드(NET 없음)에서는 드롭다운을 잠가 두고, 이 값은 아무 데도 쓰이지 않는다.
 *
 * @returns {string} 'haiku-4.5' | 'sonnet-5' | 'opus-4.8'
 */
const MODEL = () => $('modelSel')?.value || 'sonnet-5'

/*
 * 지금 앉아 있는 역할. 로그인 정보가 없으면 가장 권한이 적은 리뷰어로 봅니다.
 *
 * 없을 때 리뷰어로 떨어지는 것이 중요합니다. 기획으로 떨어뜨리면 로그인 정보를 읽지 못한
 * 김에 화면이 「됩니다」라고 열어 두고, 서버가 그 뒤에 튕깁니다. 막힌 것을 열어 보이는 쪽이
 * 열린 것을 막아 보이는 쪽보다 나쁩니다. pages/key-visual.js 의 myRole 과 같은 규칙입니다.
 */
const myRole = () => session()?.role || 'reviewer'

/** 고른 모델의 짧은 이름. 진행 안내에 적어 무엇으로 돌고 있는지 보이게 한다 */
const modelLabel = () =>
  ($('modelSel')?.selectedOptions?.[0]?.textContent || '').split('·')[0].trim() || '기본 모델'

/**
 * 탐지기별 색. 씨앗 카드 머리의 파스텔 그라디언트(--p1 → --p2)와 글자색(--pi)이다.
 * 12종을 한눈에 갈라 보이게 하는 것이 목적이라 탐지기 목록과 같은 순서로 둔다.
 */
const PROBE_TINT = {
  secret_leverage: ['#EDE3FF', '#F8F3FF', '#6D28D9'],
  love_triangle: ['#FFE1EF', '#FFF2F7', '#BE185D'],
  unresolved_tension: ['#FFE2DB', '#FFF3EF', '#C2410C'],
  chekhov_object: ['#DCEDFF', '#F0F7FF', '#1D4ED8'],
  strangers_shared_past: ['#D7F5F0', '#EEFCFA', '#0F766E'],
  severed_bond: ['#E3E8F7', '#F3F5FC', '#3F4B75'],
  dangling_consequence: ['#FFEFD1', '#FFF9EC', '#A16207'],
  contested_goal: ['#E6F6D7', '#F5FBEC', '#4D7C0F'],
  betrayal_potential: ['#FFDFDF', '#FFF1F1', '#B91C1C'],
  identity_crisis: ['#E5E4FF', '#F3F2FF', '#4338CA'],
  forbidden_bond: ['#FAE1FF', '#FDF2FF', '#A21CAF'],
  power_vacuum: ['#ECE9E1', '#F8F6F1', '#78716C'],
}

/** 탐지기 색을 CSS 변수로. 씨앗 카드와 스토리 머리가 같은 색을 쓴다 */
const tint = (probe) => {
  const [p1, p2, pi] = PROBE_TINT[probe] || ['#EEF0FF', '#F7F8FF', '#4338CA']
  return `--p1:${p1};--p2:${p2};--pi:${pi}`
}

let STORE = null
let SEEDS = []
let STORIES = new Map() // 분기 스토리 캐시. 키는 씨앗 인덱스, 자유 입력은 'free'
let POOL = []           // 로컬 폴백용 목데이터 스토리 묶음
let MOCK_SEEDS = []
let CUR = { seed: -1, branch: 0 }
let VIS = null
let showAllSeeds = false
let EXPAND = null       // 분기 → 대본 흐름의 상태. null 이면 분기 화면을 그린다
let EPISODES = []       // 이 화면에서 만든 회차. 대본화 탭이 여기서 컷을 가져온다
let SCRIPT = { ep: 0, format: 'drama', text: '', busy: false, err: '' }
let NEW_SEEDS = new Set() // 역기입 뒤에 새로 나온 씨앗의 키. 카드에 NEW 뱃지를 붙인다
let NAV = null           // 상단 기능 탭. mountNav 가 만든다
let LAST_DEV_TAB = 'seeds' // 상단 [스토리 디벨롭] 으로 돌아왔을 때 열어 줄 안쪽 탭
/**
 * 가장 최근 역기입 한 번의 변경 요약 (writebackSummary). 네비게이터 챗봇이 질문마다
 * 함께 받아 "방금 뭐가 추가됐어?" 에 답하는 근거다. 현재 스냅샷만으로는 무엇이 새것인지
 * 알 수 없다. 판을 새로 지으면(build) 지난 판의 변경이라 버린다.
 */
let LAST_WRITEBACK = null
let JOURNAL = []         // 지나간 일. op 를 접기 전 원본이라 누가 언제 했는지가 남는다
let HIST_MINE = false    // 「내 것만」
let PLAYING_EXAMPLE = false // 예시 재생 중. 그 사이의 기록에 example 표시를 붙인다

/*
 * 로그 클라이언트. 소켓을 열지 않고 읽기·쓰기만 한다 (net.js 의 opsClient).
 * 이 화면은 실시간 협업 화면이 아니고, 한 번 읽어 목록을 그리면 된다.
 */
const OPS = opsClient()

/*
 * 지금 보고 있는 프로젝트. 주소의 ?board= 이다 (app/nav-tabs.js).
 *
 * Neptune 의 projectId 로도 이것을 그대로 쓴다. 한때 여기가 늘 'default' 였는데,
 * 그러면 프로젝트를 갈아도 그래프는 한 벌이라 A 에서 뽑은 인물이 B 의 판에 그대로
 * 서 있었다. 로그는 보드마다 갈라져 있었으니 목록만 갈라지고 판은 섞이는 셈이었다.
 */
const BOARD = boardFromSearch()

// ── 지나간 일 ────────────────────────────────────────────────────────────────
// 이 화면에서 한 일을 보드와 같은 로그에 남긴다. kind 는 step.mark 하나뿐이고
// (app/history.js) 보드의 applyOp 는 모르는 kind 를 그냥 지나가므로 판을 흔들지 않는다.

/**
 * 한 일 한 줄을 로그에 남긴다.
 *
 * @param {string} what - 완결된 한 줄. "노드 14개를 뽑았습니다"
 * @param {object} [o]
 * @param {string} [o.step] - 'develop' (기본) 또는 'script'
 * @param {string} [o.ref] - 이어서 할 자리. 씨앗 키나 회차 번호
 * @param {string} [o.refKind] - ref 가 무엇인지. 'seed' | 'ep'. 패널이 아니므로 보드로 보내지 않는다
 */
function mark(what, { step = 'develop', ref = null, refKind = null } = {}) {
  const me = session()
  const op = markOp({
    step, actor: me?.id || 'local', what, ref, refKind, example: PLAYING_EXAMPLE,
  })
  JOURNAL.push(op)
  // 기록은 이 화면의 본 일이 아니다. 못 남겨도 화면은 그대로 간다
  try { OPS?.sendOp?.(op)?.catch?.(() => {}) } catch { /* 로컬 모드 */ }
  // 프로젝트 카드의 「마지막 손길」도 같은 문장으로 고친다 (app/projects.js)
  touchProject({ boardId: BOARD, actor: me?.id, what })
  paintHist()
}

/** actor id → {name}. 명부(member.set)에 있는 사람과 데모 계정을 합쳐 쓴다 */
function nameMap(list) {
  const m = new Map(DEMO_USERS.map((u) => [u.id, { name: u.name, role: u.role }]))
  for (const op of list) {
    if (op?.kind === 'member.set' && op.member?.id) m.set(op.member.id, op.member)
  }
  return m
}

function paintHist() {
  const mount = $('hist')
  if (!mount) return
  const me = session()
  const who = nameMap(JOURNAL)
  const list = group(entries(JOURNAL, {
    who: (id) => who.get(id) || null,
    actor: HIST_MINE ? me?.id || 'local' : null,
    limit: 120,
  })).slice(0, 30)
  $('histMine').setAttribute('aria-pressed', String(HIST_MINE))
  say(NOTE) // 갈 수 없는 줄을 눌러 남은 말을 여기서 되돌린다
  paintList(mount, list, {
    showStep: true,
    none: HIST_MINE ? '내가 등록한 것이 아직 없습니다.' : '아직 지나간 일이 없습니다.',
    onPick: pickHist,
  })
}

/**
 * 목록에서 한 줄을 골라 이어서 하는 자리.
 *
 * 갈 수 있는 것만 간다. 이 화면이 아는 것은 씨앗과 회차다. 패널 id (보드나 키비주얼이
 * 남긴 것) 를 여기서 열 방법은 없으므로 그때는 보드로 보낸다.
 */
function pickHist(e) {
  if (e.refKind === 'ep') {
    const i = Number(e.ref)
    if (Number.isFinite(i) && EPISODES[i]) {
      SCRIPT = { ...SCRIPT, ep: i, text: '', err: '' }
      openTab('script')
      return
    }
    // 새로고침하면 회차는 남지 않는다. 없는 것을 여는 대신 그 사실을 말한다
    return say('그 회차는 이 화면에 남아 있지 않습니다. 씨앗에서 다시 펼쳐 주세요.')
  }
  if (e.refKind === 'seed') {
    const i = SEEDS.findIndex((s) => seedKey(s) === e.ref)
    if (i < 0) return say('그 씨앗은 지금 판에 없습니다. 그래프가 바뀌었을 수 있습니다.')
    pickSeed(i)
    return
  }
  if (e.refKind === 'panel') { location.href = `/board.html#cut=${encodeURIComponent(e.ref)}` }
}

/** 지나간 일 목록 아래의 기본 한 줄 */
const NOTE = '줄을 누르면 그 자리에서 이어서 합니다. 회차는 대본화 탭이 열립니다.'

/** 그 한 줄을 바꾼다. 갈 수 없는 곳을 눌렀을 때 이유를 여기 남긴다 */
function say(msg) {
  const note = document.querySelector('#panel-hist .hist-note')
  if (note) note.textContent = msg
}

// ── 데이터 읽기 ───────────────────────────────────────────────────────────────
async function loadJson(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return res.json()
}

// 목데이터 셋. graph 는 ?graph= 로 갈아끼울 수 있고, seeds/stories 는 로컬 폴백용이다.
// 없어도 화면은 돌아간다. 탐지기가 씨앗을 만들고, 분기는 임시 분기로 채운다.
async function loadMock() {
  const graph = await loadJson(GRAPH_SRC)
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error(`${GRAPH_SRC}: nodes/edges 배열이 없습니다`)
  }
  let seeds = []
  let stories = []
  try {
    ;[seeds, stories] = await Promise.all([loadJson('/app-walkthrough/data/seeds.json'), loadJson('/app-walkthrough/data/stories.json')])
    if (!Array.isArray(seeds) || !Array.isArray(stories)) throw new Error('seeds.json / stories.json: 배열이 아닙니다')
    if (seeds.length !== stories.length) throw new Error(`씨앗 ${seeds.length}개인데 스토리 ${stories.length}개입니다`)
  } catch (err) {
    console.warn('[story-graph] 목 씨앗·스토리를 읽지 못했다. 탐지기와 임시 분기로 돈다', err.message)
    seeds = []
    stories = []
  }
  return { graph, seeds, stories }
}

/**
 * 그래프 JSON 으로 저장소를 만든다. Neptune 모드면 판을 그대로 저장소에 밀어 넣는다
 *. 새 대본을 뽑았거나 목데이터로 되돌렸다면 그것이 이제 사실이다.
 */
function newStore(graph) {
  const store = createGraphStore(graph, { net: GRAPH_NET, projectId: BOARD })
  store.save?.() // 인메모리 판에는 없다. 저장이 끝났는지는 flush 로 본다
  return store
}

/** 저장소 하나를 판에 올린다. 목데이터든 추출 결과든 Neptune 이든 여기 한 곳을 지난다 */
function build(store, { keepSeeds = null } = {}) {
  STORE = store
  SEEDS = keepSeeds || findSeeds(STORE)
  LAST_WRITEBACK = null // 지난 판에서 붙인 것이다. 새 판에는 해당하지 않는다
  STORIES = new Map()
  CUR = { seed: -1, branch: 0 }
  showAllSeeds = false
  NEW_SEEDS = new Set()
  EXPAND = null
  EPISODES = []
  SCRIPT = { ep: 0, format: SCRIPT.format, text: '', busy: false, err: '' }
  renderStats()
  syncWelcome() // renderNetwork 보다 먼저다. 판 가운데 안내를 띄울지가 이 결과에 달렸다
  renderNetwork()
  renderSeeds()
  renderScriptPanel()
  renderFreeOnly(SEEDS.length
    ? '씨앗을 골라 스토리를 생성합니다. 방향이 이미 있다면 아래에 바로 적어도 됩니다.'
    : '탐지된 씨앗이 없습니다. 방향을 직접 주면 그래프 전체를 컨텍스트로 분기를 만듭니다.')
}

// ── 그래프 그리기 ─────────────────────────────────────────────────────────────
function renderStats() {
  const s = STORE ? STORE.stats() : { nodes: 0, assertedEdges: 0, derivedEdges: 0 }
  $('s-nodes').textContent = s.nodes
  $('s-asserted').textContent = s.assertedEdges
  $('s-derived').textContent = s.derivedEdges
  $('s-seeds').textContent = SEEDS.length
}

/** 범례. 구체 색과 엣지 모양을 graph-view.js 의 표에서 그대로 가져온다 */
function renderLegend() {
  $('legend').innerHTML = Object.keys(KIND_COLOR).map((k) =>
    `<span><i style="--c:${KIND_COLOR[k]}"></i>${esc(KIND_LABEL[k] || k)}</span>`).join('')
    + '<span><i class="line"></i>명시</span><span><i class="dash"></i>추론</span>'
}

/** 대본 카드와 범례가 가리는 자리. 판은 이만큼 비켜 앉는다 */
const insets = () => ({ l: $('inputCard').hidden ? 24 : 428, t: 24, r: 24, b: 78 })

function renderNetwork() {
  const g = STORE.toJSON()
  const msg = $('canvasMsg')
  /*
   * 판 가운데의 안내. 비어 있고 「처음 오셨나요?」 판이 없을 때만 띄운다. 둘 다 띄우면
   * 같은 말이 두 번 겹치고, 안내 판이 이 글자 위에 앉는다. 예시를 다 보고 판을 지운
   * 뒤처럼 안내 판이 없는 경우에 이 줄이 남는다.
   */
  if (!g.nodes.length && $('onbSlot')?.hidden !== false) {
    msg.hidden = false
    msg.innerHTML = '그래프가 비어 있습니다.<br>왼쪽 카드에 대본을 넣고 <b>그래프 추출</b>을 누르거나,<br>'
      + '<b>예시 대본으로 보기</b>로 흐름을 둘러보세요.'
  } else {
    msg.hidden = true
  }
  // 판은 한 번만 만들고 계속 쓴다. 노드를 옮겨 둔 자리도 그대로 이어진다
  if (!VIS) {
    $('network').innerHTML = '' // 로드 실패 안내가 남아 있을 수 있다
    VIS = createGraphView($('network'), { onPick: (id) => (id ? showNode(id) : hideNode()) })
  }
  VIS.setInsets(insets())
  VIS.render(g)
}

function highlight(ids) {
  if (!VIS) return
  const live = ids.filter((id) => STORE.getNode(id))
  if (!live.length) return
  VIS.focus(live)
}

function showNode(id) {
  const n = STORE.getNode(id)
  if (!n) return
  const props = Object.entries(n.props || {})
    .map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join('')
  const line = (e, dir) => {
    const other = dir === 'out' ? e.o : e.s
    const arrow = dir === 'out' ? '→' : '←'
    const t = e.props?.tension === undefined ? '' : ` (긴장 ${e.props.tension})`
    return `<div class="edge-line${e.asserted ? '' : ' der'}">${arrow} <b>${esc(e.p)}</b> `
      + `${esc(STORE.getNode(other)?.name || other)}${t}${e.asserted ? '' : ' · 추론'}</div>`
  }
  const out = STORE.getEdgesFrom(id).map((e) => line(e, 'out')).join('')
  const inc = STORE.getEdgesTo(id).map((e) => line(e, 'in')).join('')
  $('nodeBody').innerHTML = `
    <div class="kv">
      <span class="k">이름</span><span class="v">${esc(n.name)}</span>
      <span class="k">kind</span><span class="v">${esc(n.kind)}</span>
      <span class="k">id</span><span class="v">${esc(n.id)}</span>
      ${props}
    </div>
    ${out || inc ? '<div class="sec-label">엣지</div>' : '<div class="hint">붙어 있는 엣지가 없습니다.</div>'}
    ${out}${inc}`
  $('nodeCard').hidden = false
}

const hideNode = () => { $('nodeCard').hidden = true }

// ── 씨앗 ─────────────────────────────────────────────────────────────────────
const probeLabel = (id) => PROBES[id]?.label || id

/**
 * 씨앗 하나를 알아보는 키. 탐지기 + 초점 노드다 (graph-probes.js 의 trim 이 쓰는 것과 같다).
 * 역기입 전후로 이 키를 견줘 새로 나온 씨앗을 가른다. 씨앗에는 id 가 없다.
 */
const seedKey = (s) => `${s.probe}|${[...(s.focus || [])].sort().join(',')}`

function renderSeeds() {
  const list = $('seedsList')
  if (!SEEDS.length) {
    list.innerHTML = `<div class="placeholder">탐지된 씨앗이 없습니다.<br>
      대본에 인물 간 갈등이나 비밀을 더 넣으면 더 풍부한 스토리 씨앗을 찾습니다.<br>
      씨앗 없이 <b>스토리</b> 탭의 자유 입력으로 바로 분기를 만들 수도 있습니다.</div>`
    return
  }
  const shown = showAllSeeds ? SEEDS : SEEDS.slice(0, SEEDS_SHOWN)
  const cards = shown.map((s, i) => {
    const fresh = NEW_SEEDS.has(seedKey(s))
    return `
    <div class="seed-card ${i === CUR.seed ? 'on' : ''}${fresh ? ' is-new' : ''}" style="${tint(s.probe)}">
      ${fresh ? '<div class="seed-new-tag">역기입 후 새로 발견</div>' : ''}
      <div class="seed-head">
        <span class="probe-tag">${esc(probeLabel(s.probe))}</span>
        ${fresh ? '<span class="new-badge">NEW</span>' : ''}
        <span class="seed-score">▲${Number(s.score).toFixed(2)}</span>
      </div>
      <div class="seed-body">
        <div class="seed-title" data-focus="${i}">${esc(s.title)}</div>
        <div class="seed-rationale">${esc(s.desc)}</div>
        <div class="seed-focus">초점: ${esc((s.focus || []).map((id) => STORE.getNode(id)?.name || id).join(', '))}</div>
        <button class="btn btn--wide" data-seed="${i}">스토리 생성</button>
      </div>
    </div>`
  }).join('')
  // 새 씨앗이 잘린 자리 뒤에 있을 수 있다. 몇 개가 숨어 있는지 버튼에 적어 준다
  const hiddenNew = SEEDS.slice(shown.length).filter((s) => NEW_SEEDS.has(seedKey(s))).length
  const more = SEEDS.length > shown.length
    ? `<button class="btn btn--line btn--wide" id="moreSeeds">더 보기 (+${SEEDS.length - shown.length}${
      hiddenNew ? `, NEW ${hiddenNew}개` : ''})</button>`
    : ''
  list.innerHTML = cards + more
  list.querySelectorAll('[data-seed]').forEach((b) => {
    b.onclick = () => pickSeed(Number(b.dataset.seed))
  })
  list.querySelectorAll('[data-focus]').forEach((el) => {
    el.onclick = () => highlight(SEEDS[Number(el.dataset.focus)].focus || [])
  })
  if (more) $('moreSeeds').onclick = () => { showAllSeeds = true; renderSeeds() }
}

/**
 * 사이드바 안쪽 탭. 상단 기능 탭과는 별개지만 서로를 비추게 해 둡니다. * 안쪽 [대본화] 는 상단 [대본화], 씨앗·스토리는 상단 [스토리 디벨롭] 입니다.
 */
const openTab = (name) => {
  document.querySelectorAll('.tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name))
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`))
  if (name !== 'script') LAST_DEV_TAB = name
  NAV?.setActive(name === 'script' ? 'script' : 'develop')
  if (name === 'script') { renderScriptPanel(); restoreScript() }
  if (name === 'hist') paintHist()
}

/*
 * 전에 담아 둔 대본을 다시 걸어 줍니다. 한 번만 읽습니다.
 *
 * 이 화면은 대본을 만들 때마다 에셋에 담는데(keepScript), 새로고침하면 SCRIPT.text 가
 * 빈 문자열로 돌아가서 「대본 생성」을 다시 눌러야 했습니다. 같은 대본을 두 번 만드는
 * 셈이고 배포에서는 Bedrock 을 한 번 더 부르는 셈입니다.
 *
 * 화면에 이미 대본이 있으면 건드리지 않습니다. 방금 만든 것이 담아 둔 것보다 새롭고,
 * 사람이 보고 있는 것을 뒤에서 갈아 끼우면 안 됩니다.
 */
let scriptRestored = false
async function restoreScript() {
  if (scriptRestored || SCRIPT.text) return
  scriptRestored = true
  const kept = await loadAsset(BOARD, 'script')
  // 그 사이에 사람이 대본을 만들었을 수 있습니다. 그때는 그쪽이 새것입니다
  if (!kept || SCRIPT.text) return
  SCRIPT.text = kept
  renderScriptPanel()
}

/** 지금 보고 있는 스토리의 캐시 키. 씨앗을 안 골랐으면 자유 입력 자리다 */
const curKey = () => (CUR.seed >= 0 ? String(CUR.seed) : 'free')

/**
 * 씨앗 하나를 골라 분기를 만듭니다.
 *
 * @param {number} i - 씨앗 번호
 * @param {boolean} [local] - true 면 Bedrock 을 부르지 않고 미리 받아 둔 목데이터(POOL)로만
 *   분기를 세웁니다. 예시 안내가 이 길로 옵니다. 안내 중에 10~30초짜리 왕복을 끼워 넣으면
 *   배우는 시간이 아니라 기다리는 시간이 됩니다.
 */
async function pickSeed(i, local = false) {
  CUR = { seed: i, branch: 0 }
  EXPAND = null
  renderSeeds()
  openTab('story')
  highlight(SEEDS[i].focus || [])
  if (STORIES.has(String(i))) return renderStory()
  /*
   * 여기서 한 번 더 묻습니다. 씨앗 카드의 「스토리 생성」은 누르는 순간 모델 왕복이
   * 시작되고 그 사이 이 패널이 다른 일을 받지 않습니다. 카드가 열두 장 깔린 화면에서
   * 옆 씨앗을 보려다 누르는 자리라 특히 그렇습니다.
   *
   * 씨앗을 고르는 것 자체는 막지 않았습니다. 위에서 이미 카드가 켜지고 초점 노드가
   * 판에서 빛납니다 — 무엇을 생성하려는지 보고 나서 결정하는 편이 맞습니다.
   *
   * 예시 안내(local)는 묻지 않습니다. 그 길은 POOL 의 목데이터로만 서고 모델을 부르지
   * 않습니다. 기다릴 것이 없는 자리에서 창을 세우면 배우던 흐름만 끊깁니다.
   */
  if (!local) {
    const ok = await confirmAsk({
      title: '스토리를 생성하시겠습니까?',
      body: NET
        ? '고른 씨앗에서 분기 여러 개를 만듭니다. 만드는 동안 이 패널은 기다립니다.'
        : '로컬 모드입니다. 미리 받아 둔 이야기 묶음에서 분기를 세웁니다.',
      list: [
        `씨앗 「${SEEDS[i].title}」`,
        ...(NET ? [`모델 ${modelLabel()} · 10~30초쯤 걸립니다`] : ['모델을 부르지 않습니다']),
      ],
      yes: '생성합니다',
    })
    /*
     * 그만두었습니다. 씨앗은 고른 채로 둡니다 — 판의 초점이 이미 그 씨앗을 가리키고
     * 있고, 그것을 되돌리면 무엇을 보다가 그만두었는지 사라집니다.
     *
     * 다만 패널은 비워 둡니다. 여기에는 아직 아무것도 없는데(STORIES 에 이 씨앗이 없음)
     * 화면을 그대로 두면 먼저 보던 다른 씨앗의 분기가 남아, 그것이 이 씨앗의 것으로
     * 보입니다.
     */
    if (!ok) return renderFreeOnly(`「${SEEDS[i].title}」를 고른 채로 두었습니다. `
      + '카드의 「스토리 생성」을 다시 누르시거나, 아래에 방향을 직접 적어도 됩니다.')
  }
  await generate((onTry) => (local
    ? localBranches(SEEDS[i], STORE, POOL)
    : planBranches(NET, SEEDS[i], STORE, { pool: POOL, onTry, model: MODEL() })),
  String(i), '분기를 만들고 있습니다')
  // 씨앗 자체에는 id 가 없다. seedKey 로 가리킨다. 이어서 하려면 그 씨앗을 다시 찾아야 한다
  const got = STORIES.get(String(i))
  if (got?.branches?.length) {
    mark(`씨앗 「${SEEDS[i].title}」에서 분기 ${got.branches.length}개를 만들었습니다`,
      { ref: seedKey(SEEDS[i]), refKind: 'seed' })
  }
}

/** 로딩 줄 하나. 같은 자리 글자만 바꿔서 진행을 보여준다 */
const busyLine = (text) => {
  $('storyPanel').innerHTML =
    `<div class="busy"><span class="spin"></span>${esc(text)}...${NET ? '' : ' (로컬 모드)'}</div>`
}

/**
 * 분기 생성 한 번. 성공하면 캐시에 넣고 그린다. 실패하면 재시도 버튼을 남긴다.
 * run 은 (몇 번째, 전체) 를 받는 진행 콜백을 넘겨받는다. 응답을 못 읽어 다시 물을 때
 * 화면이 멈춘 것처럼 보이지 않게 같은 로딩 줄의 글자를 바꾼다.
 */
async function generate(run, key, msg) {
  busyLine(msg)
  const onTry = (i, total) => busyLine(i <= 1 ? msg : `다시 시도 중 (${i}/${total})`)
  try {
    STORIES.set(key, await run(onTry))
    renderStory()
  } catch (err) {
    console.warn('[story-graph] 분기 생성 실패', err)
    $('storyPanel').innerHTML = `<div class="story-content">
      <div class="err">${esc(err.message || '서버 연결에 실패했습니다.')}</div>
      <div class="hint">다시 시도하거나, 아래 자유 입력으로 방향을 주고 새로 만들 수 있습니다.</div>
      <div class="card__row"><button class="btn" id="retryGen">다시 시도</button></div>
      ${freeBox()}</div>`
    $('retryGen').onclick = () => generate(run, key, msg)
    bindFree()
  }
}

// ── 스토리 · 분기 ────────────────────────────────────────────────────────────
const beatText = (b) => {
  if (typeof b === 'string') return b
  const head = b.scene ? `${b.scene} · ` : ''
  const tail = [b.secs ? `${b.secs}초` : null, (b.cast || []).join(', ') || null].filter(Boolean).join(' · ')
  return `${head}${b.action || ''}${tail ? ` (${tail})` : ''}`
}

const wbCount = (b) => ({
  n: b.writeback.nodes.length,
  e: b.writeback.edges.length,
  x: b.writeback.remove_edges.length,
})

function warnBlock(warnings) {
  if (!warnings?.length) return ''
  return `<details class="warns"><summary>검증 경고 ${warnings.length}건</summary>
    <ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>`
}

function freeBox() {
  return `<div class="free-box" data-coach="free">
      <h4>혹은 직접 입력</h4>
      <textarea id="freeIn" rows="3" spellcheck="false"
        placeholder="원하는 스토리 방향을 적습니다. 예: 미라가 먼저 비밀을 알아내고, 루미를 감싸는 쪽으로."></textarea>
      <div class="card__row"><button class="btn btn--line btn--wide" id="freeBtn">이 방향으로 다시 생성</button></div>
      <div class="hint">탐지기가 제안한 분기가 마음에 들지 않을 때 방향을 직접 줍니다.
        씨앗을 고르지 않아도 동작합니다.</div>
    </div>`
}

/** 아직 고른 씨앗이 없을 때의 스토리 패널. 자유 입력은 씨앗이 0개여도 쓸 수 있어야 한다 */
function renderFreeOnly(msg) {
  $('storyPanel').innerHTML = `<div class="story-content">
    <div class="placeholder">${esc(msg)}</div>
    ${freeBox()}</div>`
  bindFree()
}

function bindFree() {
  const btn = $('freeBtn')
  if (!btn) return
  btn.onclick = () => {
    const text = $('freeIn').value.trim()
    if (text.length < 4) { $('freeIn').focus(); return }
    // 씨앗을 골랐으면 그 씨앗의 분기를 방향대로 다시 만들고, 안 골랐으면 자유 입력 자리에 넣는다
    const seed = CUR.seed >= 0 ? SEEDS[CUR.seed] : null
    CUR = { ...CUR, branch: 0 }
    EXPAND = null
    generate((onTry) => planFreeBranches(NET, text, seed, STORE, { pool: POOL, onTry, model: MODEL() }), curKey(),
      '기획자의 방향으로 다시 만들고 있습니다')
  }
}

function renderStory() {
  if (EXPAND) return renderExpand()
  const st = STORIES.get(curKey())
  if (!st) {
    renderFreeOnly('씨앗을 골라 스토리를 생성합니다. 방향이 이미 있다면 아래에 바로 적어도 됩니다.')
    return
  }
  const seed = CUR.seed >= 0 ? SEEDS[CUR.seed] : null
  if (!st.branches.length) {
    $('storyPanel').innerHTML = `<div class="story-content">
      <div class="err">쓸 수 있는 분기를 받지 못했습니다. 다시 생성해 주세요.</div>
      ${warnBlock(st.warnings)}${freeBox()}</div>`
    bindFree()
    return
  }
  const bi = Math.min(CUR.branch, st.branches.length - 1)
  const b = st.branches[bi]

  const chips = st.branches.map((x, n) => `
    <button class="branch-chip ${n === bi ? 'on' : ''}" data-branch="${n}">
      <span class="bid">${esc(x.id)}</span>${esc(x.label)}
    </button>`).join('')

  const beats = b.beats.map((t, n) => `
    <div class="beat"><span class="no">${n + 1}</span><span>${esc(beatText(t))}</span></div>`).join('')

  const outcome = Object.entries(b.outcome).map(([k, v]) => `
    <div class="outcome"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')
    || '<div class="hint">이 분기의 결과가 비어 있습니다.</div>'

  const wbNodes = b.writeback.nodes.map((n) => `
    <div class="item"><span class="nt">${esc(n.kind)}</span> ${esc(n.name)}
      ${n.t === undefined ? '' : `<span class="p">t=${esc(n.t)}</span>`}
      ${n.desc ? `<div class="p">${esc(n.desc)}</div>` : ''}</div>`).join('')
  const wbEdge = (e, cut) => `
    <div class="item${cut ? ' cut' : ''}"><span class="nt">edge</span>
      ${esc(e.s)} <b>${esc(e.p)}</b> ${esc(e.o)}${e.note ? ` <span class="p">(${esc(e.note)})</span>` : ''}</div>`
  const wbEdges = b.writeback.edges.map((e) => wbEdge(e, false)).join('')
  const wbCuts = b.writeback.remove_edges.map((e) => wbEdge(e, true)).join('')
  const c = wbCount(b)

  const keys = [...new Set(st.branches.flatMap((x) => Object.keys(x.outcome)))]
  const cmp = `
    <table class="cmp">
      <tr><th></th>${st.branches.map((x) => `<th>${esc(x.id)}. ${esc(x.label)}</th>`).join('')}</tr>
      ${keys.map((k) => `<tr><th>${esc(k)}</th>${st.branches.map((x, n) =>
        `<td class="${n === bi ? 'on' : ''}">${esc(x.outcome[k] || '-')}</td>`).join('')}</tr>`).join('')}
      <tr><th>역기입</th>${st.branches.map((x, n) => {
        const q = wbCount(x)
        return `<td class="${n === bi ? 'on' : ''}">+${q.n}노드 +${q.e}엣지 −${q.x}</td>`
      }).join('')}</tr>
    </table>`

  $('storyPanel').innerHTML = `
    <div class="story-content">
      ${seed ? `<div class="seed-info" style="${tint(seed.probe)}">
        <span class="probe-tag">${esc(probeLabel(seed.probe))}</span>
        <span class="seed-score">▲${Number(seed.score).toFixed(2)}</span>
        <span>초점: ${esc((seed.focus || []).map((id) => STORE.getNode(id)?.name || id).join(', '))}</span>
      </div>` : '<div class="seed-info">씨앗 없이 기획자의 방향으로 만든 분기입니다.</div>'}
      ${st.local ? '<div class="warn">로컬 모드 결과입니다. Bedrock 에 연결하면 같은 자리에 생성 결과가 들어옵니다.</div>' : ''}
      <h1>${esc(st.title || '제목 없음')}</h1>
      <div class="logline">${esc(st.logline)}</div>
      ${st.pivot.title || st.pivot.body ? `<div class="pivot-box">
        <div class="ttl">${esc(st.pivot.title)}</div>
        <div class="bd">${esc(st.pivot.body)}</div></div>` : ''}

      <div class="sec-label">분기 ${st.branches.length}개</div>
      <div class="branch-chips">${chips}</div>

      <div class="branch-head">${esc(b.id)}. ${esc(b.label)}</div>
      ${b.tone ? `<div class="branch-tone">${esc(b.tone)}</div>` : ''}
      <div class="branch-premise">${esc(b.premise)}</div>

      <div class="sec-label">비트</div>
      <div class="beats">${beats || '<div class="hint">비트가 없습니다.</div>'}</div>

      <div class="sec-label">이 분기의 결과</div>
      ${outcome}

      <div class="sec-label">그래프 역기입</div>
      <div class="wb-sum">+ 노드 <b>${c.n}</b> · + 엣지 <b>${c.e}</b> · − 엣지 <i>${c.x}</i></div>
      <div class="wb-box">${wbNodes}${wbEdges}${wbCuts || ''}</div>
      <div class="card__row"><button class="btn btn--wide" id="expandBtn">이 분기로 대본 생성</button></div>
      <div class="hint" id="expandNote">이 분기를 개요 → 컷으로 펼치고, 판에 붙일 때 위 역기입을 그래프에 적용합니다.</div>

      <div class="sec-label">분기 비교</div>
      ${cmp}
      ${warnBlock(st.warnings)}
      ${freeBox()}
    </div>`

  document.querySelectorAll('[data-branch]').forEach((el) => {
    el.onclick = () => { CUR.branch = Number(el.dataset.branch); renderStory() }
  })
  $('expandBtn').onclick = () => expandToScript(seed, st, b)
  bindFree()
}

// ── 고른 분기 → 대본 ─────────────────────────────────────────────────────────
// 새 생성 경로를 만들지 않는다. 기존 기획 파이프라인을 그대로 지난다:
//   branchToSpec → planBranchOutline (개요) → planCuts (컷 확장) → 판에 붙이기
// 판에 붙이는 자리에서 applyWriteback 으로 그래프가 자라고 씨앗이 다시 뽑힌다.

const STEPS = [
  { id: 'options', label: '옵션' },
  { id: 'outline', label: '개요' },
  { id: 'cuts', label: '컷' },
  { id: 'done', label: '판에 붙이기' },
]

const OPT_DEFAULT = { mode: 'next', genre: GENRES[0], tone: TONES[0], secs: 60, cuts: CUTCOUNTS[1] }

const sel = (id, list, now, label = (v) => v) => `<select id="${id}">${list.map((v) =>
  `<option value="${esc(v)}" ${String(v) === String(now) ? 'selected' : ''}>${esc(label(v))}</option>`).join('')}</select>`

const secsLabel = (v) => (v >= 60 ? `${v / 60}분` : `${v}초`)

/** 컷 하나를 목록 한 줄로. 컷 확장 결과와 대본화 탭이 같은 모양을 쓴다 */
const cutRow = (raw, n) => {
  const c = raw || {}
  const cast = (c.cast || []).filter(Boolean)
  return `<div class="cut-row">
    <div class="hd"><span class="no">${n + 1}</span><span>${esc(c.scene || `S${n + 1}`)}</span>
      ${c.camera ? `<span>${esc(c.camera)}</span>` : ''}<span>${Number(c.secs) || 0}초</span>
      ${cast.length ? `<span>${esc(cast.join(', '))}</span>` : ''}</div>
    ${c.action ? `<div class="ac">${esc(c.action)}</div>` : ''}
    ${c.dialogue ? `<div class="dl">“${esc(c.dialogue)}”</div>` : ''}
  </div>`
}

/**
 * 이 화면의 기획 컨텍스트. app.js 의 planCtx() 자리다.
 * 보드가 없으니 스토리와 그래프의 인물에서 만든다.
 */
function expandCtx(x) {
  const chars = (STORE ? STORE.getNodes({ kind: 'Character' }) : []).map((n) => ({
    name: n.name,
    brief: [n.props?.role, n.props?.desc].filter(Boolean).join(' · ') || '설명 없음',
  }))
  const focus = (x.seed?.focus || []).map((id) => STORE?.getNode(id)).find((n) => n?.kind === 'Character')
  return {
    title: x.story?.title || '',
    scenario: [x.story?.logline, x.story?.pivot?.body].filter(Boolean).join('\n'),
    chars,
    centerName: focus?.name || chars[0]?.name || '',
    model: MODEL(),
  }
}

/** "이 분기로 대본 생성" 을 누른 자리. 역기입을 미리 점검해 두고 옵션부터 묻는다 */
function expandToScript(seed, story, branch) {
  EXPAND = {
    seed, story, branch,
    step: 'options', busy: '', err: '',
    opts: { ...OPT_DEFAULT },
    check: validateWritebackBeforeApply(STORE, branch.writeback),
    spec: null, outline: null, cuts: null, applied: null, epIndex: null,
  }
  renderExpand()
}

/** 역기입 미리보기. 옵션 단계와 컷 단계에서 같은 것을 보여 준다 */
function wbPreview(x) {
  const p = x.check.preview
  const bad = x.check.warnings
  return `<div class="wb-sum">역기입 미리보기 · + 노드 <b>${p.nodesAdded}</b> · + 엣지 <b>${p.edgesAdded}</b>
      · − 엣지 <i>${p.edgesRemoved}</i></div>
    ${x.check.safe ? '' : '<div class="warn">넣을 수 없는 항목이 있습니다. 그 항목만 빼고 적용합니다.</div>'}
    ${bad.length ? `<details class="warns"><summary>역기입 점검 ${bad.length}건</summary>
      <ul>${bad.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}`
}

function renderExpand() {
  const x = EXPAND
  if (!x) return renderStory()
  const at = STEPS.findIndex((s) => s.id === x.step)
  const head = `
    <div class="seed-info">
      <span class="probe-tag">${esc(x.branch.id)}. ${esc(x.branch.label)}</span>
      <span>${esc(x.story.title || '분기에서 대본 만들기')}</span>
    </div>
    <div class="step-bar">${STEPS.map((s, i) =>
      `<div class="step ${i === at ? 'on' : i < at ? 'done' : ''}">${esc(s.label)}</div>`).join('')}</div>`

  if (x.busy) {
    $('storyPanel').innerHTML = `<div class="story-content">${head}
      <div class="busy"><span class="spin"></span>${x.busy === 'outline'
        ? '분기를 개요로 짜고 있습니다… 10초쯤 걸립니다.'
        : `비트를 컷 ${x.spec.cuts}개로 펼치고 있습니다… 10초쯤 걸립니다.`}${NET ? '' : ' (로컬 모드)'}</div></div>`
    return
  }

  const err = x.err ? `<div class="err">${esc(x.err)}</div>` : ''
  const body = { options: expandOptions, outline: expandOutline, cuts: expandCuts, done: expandDone }[x.step](x)
  $('storyPanel').innerHTML = `<div class="story-content">${head}${err}${body}</div>`
  bindExpand()
}

const expandOptions = (x) => `
  <div class="sec-label">이 분기로 대본 만들기</div>
  ${wbPreview(x)}
  <div class="opt-grid">
    <label class="wide">형식${sel('exMode', ['next', 'spin'], x.opts.mode,
      (v) => (v === 'next' ? '새 회차 · 인물과 앞 사건을 이어서' : '스핀오프 · 한 인물을 주인공으로 갈라'))}</label>
    <label>장르${sel('exGenre', GENRES, x.opts.genre)}</label>
    <label>톤${sel('exTone', TONES, x.opts.tone)}</label>
    <label>러닝타임${sel('exSecs', LENGTHS, x.opts.secs, secsLabel)}</label>
    <label>씬 수${sel('exCuts', CUTCOUNTS, x.opts.cuts, (v) => `${v}컷`)}</label>
  </div>
  <div class="card__row">
    <button class="btn btn--wide" id="exGo">생성</button>
    <button class="btn btn--line" id="exBack">분기로</button>
  </div>
  <div class="hint">개요를 먼저 보여드립니다. 판에 붙이는 것과 역기입은 그다음입니다.</div>`

const expandOutline = (x) => {
  const o = x.outline
  const secs = o.beats.reduce((s, b) => s + (Number(b.secs) || 0), 0)
  return `
    ${o.local ? '<div class="warn">로컬 모드 개요입니다. 분기의 비트를 그대로 세운 뼈대입니다.</div>' : ''}
    <h1>${esc(o.title || '제목 없음')}</h1>
    <div class="logline">${esc(o.logline)}</div>
    ${o.synopsis ? `<div class="branch-premise">${esc(o.synopsis)}</div>` : ''}
    ${o.chars.length ? `<div class="sec-label">새로 만들 인물 ${o.chars.length}명</div>
      ${o.chars.map((c) => `<div class="beat"><span class="no">＋</span><span><b>${esc(c.name)}</b> ${esc(c.brief)}</span></div>`).join('')}` : ''}
    <div class="sec-label">비트 ${o.beats.length}개 · ${Math.round(secs)}초</div>
    ${o.beats.map((b, n) => `<div class="beat"><span class="no">${n + 1}</span>
      <span>${esc(b.scene || `S${n + 1}`)} · ${esc(b.action)}${b.cast.length ? ` (${esc(b.cast.join(', '))})` : ''}</span></div>`).join('')}
    <div class="card__row">
      <button class="btn btn--wide" id="exCuts">이 개요로 컷 ${x.spec.cuts}개 만들기</button>
    </div>
    <div class="card__row">
      <button class="btn btn--line" id="exAgain">개요 다시</button>
      <button class="btn btn--line" id="exOpts">옵션 고치기</button>
      <button class="btn btn--line" id="exBack">분기로</button>
    </div>`
}

const expandCuts = (x) => {
  const secs = x.cuts.reduce((s, c) => s + (Number(c.secs) || 0), 0)
  return `
    <h1>${esc(x.outline.title || '제목 없음')}</h1>
    <div class="logline">${x.opts.mode === 'spin' ? '스핀오프' : '새 회차'} · 컷 ${x.cuts.length}개 · ${Math.round(secs)}초</div>
    ${wbPreview(x)}
    <div class="card__row">
      <button class="btn btn--wide" id="exApply">판에 붙이고 역기입 적용</button>
    </div>
    <div class="card__row">
      <button class="btn btn--line" id="exExport">대본으로 내보내기</button>
      <button class="btn btn--line" id="exRecut">컷 다시</button>
      <button class="btn btn--line" id="exBack">분기로</button>
    </div>
    <div class="hint">판에 붙이면 위 역기입이 그래프에 적용되고 씨앗을 다시 뽑습니다.
      대본으로 내보내기만 하면 그래프는 그대로 둡니다.</div>
    <div class="sec-label">컷 ${x.cuts.length}개</div>
    ${x.cuts.map(cutRow).join('')}`
}

const expandDone = (x) => {
  const a = x.applied.applied
  const n = x.applied.newSeeds.length
  return `
    <div class="ok">${esc(x.outline.title || '새 회차')} 를 판에 붙였습니다. 컷 ${x.cuts.length}개.</div>
    <div class="sec-label">그래프에 적용한 역기입</div>
    <div class="wb-sum">+ 노드 <b>${a.nodesAdded}</b> · + 엣지 <b>${a.edgesAdded}</b> · − 엣지 <i>${a.edgesRemoved}</i>
      ${a.derivedLost ? ` · 함께 사라진 추론 <i>${a.derivedLost}</i>` : ''}</div>
    <div class="ok">${n ? `새 회차 씨앗 ${n}개를 발견했습니다.` : '이번에는 새 씨앗이 나오지 않았습니다.'}</div>
    ${x.applied.warnings.length ? `<details class="warns"><summary>적용 기록 ${x.applied.warnings.length}건</summary>
      <ul>${x.applied.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
    <div class="card__row">
      <button class="btn btn--wide" id="exSeeds">씨앗 ${n}개 보기</button>
      <button class="btn btn--line" id="exScript">대본화</button>
    </div>
    <div class="card__row"><button class="btn btn--line btn--wide" id="exClose">닫기</button></div>
    <div class="hint">새로 생긴 노드·엣지는 판에서 녹색으로 표시했습니다. 끊긴 엣지 자리는 붉은 점선으로 잠깐 남습니다.<br>
      씨앗을 다시 고르면 자란 그래프에서 다음 회차가 갈라집니다.</div>`
}

function bindExpand() {
  const x = EXPAND
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn }
  const num = (id, dflt) => Number($(id)?.value) || dflt

  on('exGo', () => {
    x.opts = {
      mode: $('exMode').value === 'spin' ? 'spin' : 'next',
      genre: $('exGenre').value,
      tone: $('exTone').value,
      secs: num('exSecs', OPT_DEFAULT.secs),
      cuts: num('exCuts', OPT_DEFAULT.cuts),
    }
    runOutline()
  })
  on('exAgain', runOutline)
  on('exCuts', runCuts)
  on('exRecut', runCuts)
  on('exOpts', () => { x.step = 'options'; x.err = ''; renderExpand() })
  on('exApply', applyToBoard)
  on('exExport', () => { stashEpisode(); openTab('script') })
  on('exSeeds', () => openTab('seeds'))
  on('exScript', () => openTab('script'))
  on('exBack', () => { EXPAND = null; renderStory() })
  on('exClose', () => {
    EXPAND = null
    renderFreeOnly('역기입을 적용했습니다. 씨앗 탭에서 자란 그래프의 다음 씨앗을 고르세요.')
  })
}

async function runOutline() {
  const x = EXPAND
  x.spec = branchToSpec(x.branch, x.opts)
  x.busy = 'outline'
  x.err = ''
  renderExpand()
  try {
    x.outline = await planBranchOutline(NET, x.branch, x.spec, expandCtx(x))
    x.step = 'outline'
  } catch (err) {
    console.warn('[story-graph] 개요 생성 실패', err)
    x.err = `${err.message || '서버 연결에 실패했습니다.'} 다시 시도해 주세요.`
    x.step = 'options'
  } finally {
    x.busy = ''
    renderExpand()
  }
}

async function runCuts() {
  const x = EXPAND
  x.busy = 'cuts'
  x.err = ''
  renderExpand()
  try {
    const cuts = await planCuts(NET, x.spec, x.outline, { model: MODEL() })
    if (!cuts.length) throw new Error('컷을 받지 못했습니다.')
    x.cuts = cuts
    x.step = 'cuts'
    mark(`분기 「${x.branch.label}」를 컷 ${cuts.length}개로 펼쳤습니다`,
      { ref: x.seed ? seedKey(x.seed) : null, refKind: x.seed ? 'seed' : null })
  } catch (err) {
    console.warn('[story-graph] 컷 확장 실패', err)
    x.err = `${err.message || '서버 연결에 실패했습니다.'} 다시 시도해 주세요.`
    x.step = 'outline'
  } finally {
    x.busy = ''
    renderExpand()
  }
}

/** 만든 회차를 대본화 탭이 읽을 자리에 넣는다. 컷을 다시 만들면 같은 자리를 덮는다 */
function stashEpisode() {
  const x = EXPAND
  const ep = {
    title: x.outline.title || x.story.title || `${x.branch.id}. ${x.branch.label}`,
    logline: x.outline.logline,
    branch: `${x.branch.id}. ${x.branch.label}`,
    mode: x.opts.mode,
    chars: x.outline.chars,
    cuts: x.cuts,
  }
  const fresh = x.epIndex === null
  if (fresh) { EPISODES.push(ep); x.epIndex = EPISODES.length - 1 }
  else EPISODES[x.epIndex] = ep
  SCRIPT = { ...SCRIPT, ep: x.epIndex, text: '', err: '' }
  // 회차 번호로 가리킨다. 새로고침하면 사라지므로 pickHist 가 그 경우를 따로 말한다
  mark(`회차 「${ep.title}」${fresh ? '를 만들었습니다' : '의 컷을 다시 만들었습니다'}`,
    { ref: String(x.epIndex), refKind: 'ep' })
  return x.epIndex
}

/** 역기입 요약에 적는 목록의 상한. 페이로드를 부풀리지 않고 개수는 따로 적어 둔다 */
const WB_LIST_MAX = 40

/**
 * 역기입 한 번의 변경 요약. 네비게이터 챗봇이 받아 가는 값이다 (LAST_WRITEBACK).
 *
 * 이름이 아니라 id 로 적는다. Lambda 가 그래프 노드 표에서 id → 이름 표를 이미
 * 만들어 두고 있어 거기서 풀리고, 페이로드도 작다. 목록은 WB_LIST_MAX 에서 자르고
 * 전체 개수는 counts 에 남긴다 (자른 것을 전부라고 답하지 않게).
 *
 * @param {{nodes: Array, edges: Array}} before - 역기입 전 판
 * @param {{nodes: Array, edges: Array}} after - 역기입 뒤 판
 * @param {string} branch - 어느 분기의 역기입인가
 * @returns {Object} graphData.recentWriteback 에 실리는 값
 */
function writebackSummary(before, after, branch) {
  const hadNode = new Set(before.nodes.map((n) => n.id))
  const hadEdge = new Set(before.edges.map(edgeKey))
  const hasEdge = new Set(after.edges.map(edgeKey))
  // 파생 엣지는 규칙이 다시 만든 것이라 갈라 적는다. 작가가 직접 넣은 것이 아니다
  const triple = (e) => (e.asserted ? { s: e.s, p: e.p, o: e.o } : { s: e.s, p: e.p, o: e.o, derived: true })
  const nodes = after.nodes.filter((n) => !hadNode.has(n.id)).map((n) => n.id)
  const added = after.edges.filter((e) => !hadEdge.has(edgeKey(e)))
  const removed = before.edges.filter((e) => !hasEdge.has(edgeKey(e)))
  return {
    at: new Date().toISOString(),
    branch,
    addedNodes: nodes.slice(0, WB_LIST_MAX),
    addedEdges: added.slice(0, WB_LIST_MAX).map(triple),
    removedEdges: removed.slice(0, WB_LIST_MAX).map(triple),
    counts: { addedNodes: nodes.length, addedEdges: added.length, removedEdges: removed.length },
  }
}

/**
 * 판에 붙이기. 여기서 역기입이 확정되고 그래프가 자란다.
 * 씨앗 인덱스가 바뀌므로 분기 캐시는 버린다.
 */
async function applyToBoard() {
  const x = EXPAND
  /*
   * 한 번 더 묻습니다. 씨앗의 「스토리 생성」과 같은 창이지만 묻는 이유가 다릅니다.
   *
   * 생성 쪽은 기다림이 이유였습니다(모델 왕복 10~30초). 여기는 기다림이 아니라
   * 되돌리기가 이유입니다. 역기입은 이야기 자체를 바꿉니다 — 노드와 엣지가 붙고,
   * 무엇보다 엣지가 끊깁니다. 끊긴 엣지를 되돌리는 길은 이 화면에 없습니다.
   *
   * 그리고 이 판은 혼자 보는 것이 아닙니다. 같은 보드를 공유하는 사람 모두의
   * 그래프가 함께 바뀝니다. 내 화면에서 누른 한 번이 남의 화면에서 이야기가 달라진
   * 것으로 나타나므로, 그 앞에는 창이 서는 편이 맞습니다.
   *
   * 확인을 지나는 자리를 exApply 버튼이 아니라 이 함수 안에 둡니다. 판을 바꾸는 것은
   * 이 함수이고, 나중에 다른 곳에서 이 함수를 부르면 그 길에는 창이 없게 됩니다.
   */
  const p = x.check.preview
  const ok = await confirmAsk({
    title: '그래프에 역기입하시겠습니까?',
    body: '이 회차를 판에 붙이고, 위 미리보기의 역기입을 그래프에 적용합니다. '
      + '이야기 자체가 바뀌고 이 보드를 함께 보는 사람 모두에게 그대로 보입니다. '
      + '되돌릴 수 없습니다.',
    list: [
      `분기 「${x.branch.label}」 · 컷 ${x.cuts.length}개`,
      `노드 ${p.nodesAdded}개 · 엣지 ${p.edgesAdded}개가 붙습니다`,
      // 끊기는 것을 따로 한 줄로 세웁니다. 붙는 것과 나란히 적으면 눈에 걸리지 않습니다
      ...(p.edgesRemoved ? [`엣지 ${p.edgesRemoved}개가 끊깁니다. 되돌릴 수 없습니다`] : []),
      ...(x.check.safe ? [] : ['넣을 수 없는 항목이 있어 그 항목만 빼고 적용합니다']),
      ...(x.check.warnings.length ? [`역기입 점검 ${x.check.warnings.length}건이 있습니다`] : []),
    ],
    yes: '역기입합니다',
    // 되돌릴 자리가 없는 일입니다. 지우기와 같은 색으로 세웁니다
    danger: true,
  })
  /*
   * 그만두었습니다. 컷 단계를 그대로 둡니다. 컷은 모델을 불러 만든 것이라 화면을
   * 되돌리면 다시 1~2분을 기다려야 합니다. 「대본으로 내보내기」로 빠지는 길도
   * 이 단계에 있으므로, 여기 머무는 것이 그만둔 사람이 다음에 할 일에 가깝습니다.
   */
  if (!ok) return

  stashEpisode()
  // 무엇이 새로 생겼는지는 개수(applied)만으로는 알 수 없다. 전후 판을 견줘 id 를 뽑는다
  const before = STORE.toJSON()
  const seedsBefore = new Set(SEEDS.map(seedKey))
  x.applied = applyWriteback(STORE, x.branch.writeback)
  const after = STORE.toJSON()
  x.delta = graphDelta(before, after)
  // 챗봇이 볼 변경 요약. 역기입을 또 하면 마지막 것만 남는다
  LAST_WRITEBACK = writebackSummary(before, after, `${x.branch.id}. ${x.branch.label}`)
  x.step = 'done'
  SEEDS = x.applied.newSeeds
  NEW_SEEDS = new Set(SEEDS.map(seedKey).filter((k) => !seedsBefore.has(k)))
  STORIES = new Map()
  CUR = { seed: -1, branch: 0 }
  showAllSeeds = false
  renderStats()
  renderNetwork()
  // 판을 다시 그린 다음이어야 표시가 남는다 (render 가 표시를 지운다)
  VIS?.markNew(x.delta)
  renderSeeds()
  renderExpand()
  const a = x.applied.applied
  mark(`역기입으로 노드 ${a.nodesAdded}개 · 엣지 ${a.edgesAdded}개가 붙고 ${a.edgesRemoved}개가 끊겼습니다`)

  // Neptune 모드에서는 여기서야 저장이 끝난다. 판은 이미 자랐으니 화면은 건드리지
  // 않고, 저장이 어긋난 것만 적용 기록에 덧붙여 다시 그린다
  const { failures } = (await STORE.flush?.()) || { failures: [] }
  if (failures.length) {
    x.applied.warnings.push(...failures)
    renderExpand()
  }
}

// ── 대본화 ───────────────────────────────────────────────────────────────────
// 보드의 컷을 정식 대본 텍스트로 옮긴다. 스토리 디벨롭과는 따로 도는 기능이다.

function renderScriptPanel() {
  const box = $('scriptPanel')
  if (!box) return
  if (!EPISODES.length) {
    /*
     * 컷이 없습니다. 그래도 전에 담아 둔 대본이 있으면 그것을 보여줍니다.
     *
     * 컷은 저장되지 않아서 새로고침하면 EPISODES 가 빕니다. 대본은 에셋에 남아 있는데
     * (restoreScript 가 걸어 줍니다) 여기서 그냥 「컷이 없습니다」로 덮으면 담아 둔
     * 대본을 볼 자리가 없어집니다. 저장한 보람이 사라지는 자리가 바로 여기였습니다.
     */
    box.innerHTML = SCRIPT.text ? `<div class="story-content">
      <div class="sec-label">대본</div>
      <pre class="script">${esc(SCRIPT.text)}</pre>
      <div class="card__row">
        <button class="btn btn--line" id="scCopy">복사</button>
        <button class="btn btn--line" id="scDown">다운로드</button>
      </div>
      <div class="hint" id="scNote">이 프로젝트에 담아 둔 대본입니다.
        컷은 남지 않아서 다시 만들려면 씨앗 → 분기를 지나야 합니다.</div>
    </div>` : `<div class="placeholder">컷이 없습니다. 먼저 스토리를 생성해 주세요.<br>
      씨앗 → 분기 → <b>이 분기로 대본 생성</b> 을 지나면 여기에 컷이 들어옵니다.</div>`
    if ($('scCopy')) $('scCopy').onclick = () => copyScript(SCRIPT.text)
    if ($('scDown')) $('scDown').onclick = () => downloadScript(SCRIPT.text, scriptFileName('대본'))
    return
  }
  const i = Math.min(Math.max(0, SCRIPT.ep), EPISODES.length - 1)
  const ep = EPISODES[i]
  const secs = ep.cuts.reduce((s, c) => s + (Number(c.secs) || 0), 0)
  const chips = EPISODES.length > 1
    ? `<div class="ep-chips">${EPISODES.map((e, n) => `<button class="branch-chip ${n === i ? 'on' : ''}"
        data-ep="${n}">${esc(e.title || `회차 ${n + 1}`)}</button>`).join('')}</div>`
    : ''

  box.innerHTML = `<div class="story-content">
    ${chips}
    <h1>${esc(ep.title || '제목 없음')}</h1>
    <div class="logline">${esc(ep.branch)} · 컷 ${ep.cuts.length}개 · ${Math.round(secs)}초</div>
    <div class="opt-grid"><label class="wide">대본 형식${sel('scFormat', Object.keys(SCRIPT_FORMATS),
      SCRIPT.format, (v) => SCRIPT_FORMATS[v].label)}</label></div>
    <div class="card__row"><button class="btn btn--wide" id="scGo" ${SCRIPT.busy ? 'disabled' : ''}>대본 생성</button></div>
    ${SCRIPT.busy ? `<div class="busy"><span class="spin"></span>대본으로 옮기고 있습니다${NET ? '' : ' (로컬 모드)'}</div>` : ''}
    ${SCRIPT.err ? `<div class="err">${esc(SCRIPT.err)}</div>` : ''}
    ${SCRIPT.text ? `
      <div class="sec-label">대본</div>
      <pre class="script">${esc(SCRIPT.text)}</pre>
      <div class="card__row">
        <button class="btn btn--line" id="scCopy">복사</button>
        <button class="btn btn--line" id="scDown">다운로드</button>
      </div>
      <div class="hint" id="scNote">${esc(scriptFileName(ep.title))} 으로 내려받습니다 (UTF-8 BOM).</div>` : ''}
    <div class="sec-label">컷 ${ep.cuts.length}개</div>
    ${ep.cuts.map(cutRow).join('')}
  </div>`

  box.querySelectorAll('[data-ep]').forEach((el) => {
    el.onclick = () => { SCRIPT = { ...SCRIPT, ep: Number(el.dataset.ep), text: '', err: '' }; renderScriptPanel() }
  })
  const fmt = $('scFormat')
  if (fmt) fmt.onchange = () => { SCRIPT.format = fmt.value }
  $('scGo').onclick = runScript
  if ($('scCopy')) $('scCopy').onclick = () => copyScript(SCRIPT.text)
  if ($('scDown')) $('scDown').onclick = () => downloadScript(SCRIPT.text, scriptFileName(ep.title))
}

async function runScript() {
  const ep = EPISODES[Math.min(Math.max(0, SCRIPT.ep), EPISODES.length - 1)]
  if (!ep?.cuts?.length) {
    SCRIPT = { ...SCRIPT, err: '컷이 없습니다. 먼저 스토리를 생성해 주세요.' }
    renderScriptPanel()
    return
  }
  // 권한을 먼저 봅니다. 대본화는 컷을 묶음으로 나눠 여러 번 보내므로(planScript 의
  // SCRIPT_BATCH), 막힐 것을 보내면 거부만 여러 번 받습니다
  if (NET && configured) {
    const no = denyReason('plan', myRole())
    if (no) {
      SCRIPT = { ...SCRIPT, err: no }
      renderScriptPanel()
      return
    }
  }
  /*
   * 한 번 더 묻습니다. 형식 드롭다운 바로 아래에 버튼이 있어서, 형식을 고르다가 그대로
   * 눌러 버리는 자리입니다. 대본은 컷을 SCRIPT_BATCH 개씩 나눠 여러 번 보내므로 컷이
   * 많으면 가장 오래 걸리는 생성이고, 이미 만들어 둔 대본이 있으면 그것을 덮습니다.
   *
   * 그래서 무엇을 · 몇 개를 · 어느 형식으로 옮기는지 세어서 보여줍니다. 사람이 한 번 더
   * 생각할 재료가 「계속할까요?」가 아니라 그 셈이라는 것이 components/confirm.js 의
   * 요점입니다.
   */
  const fmt = SCRIPT_FORMATS[SCRIPT.format]?.label || SCRIPT.format
  const ok = await confirmAsk({
    title: '이대로 대본을 생성하시겠습니까?',
    body: SCRIPT.text
      ? '화면에 있는 대본을 새로 만든 것으로 덮습니다. 먼저 「복사」나 「다운로드」로 챙겨 두셔도 됩니다.'
      : '컷을 순서대로 읽어 대본 텍스트로 옮깁니다. 만드는 동안 이 탭은 기다립니다.',
    list: [
      `「${ep.title || '제목 없음'}」`,
      `컷 ${ep.cuts.length}개 → ${fmt} 대본`,
      ...(NET ? [`모델 ${modelLabel()} · 컷이 많으면 1~2분 걸립니다`] : ['로컬 모드 · 모델을 부르지 않습니다']),
    ],
    yes: '생성합니다',
  })
  if (!ok) return

  SCRIPT = { ...SCRIPT, busy: true, err: '', text: '' }
  renderScriptPanel()
  try {
    SCRIPT.text = await planScript(NET, ep.cuts, {
      format: SCRIPT.format, title: ep.title, chars: ep.chars, model: MODEL(),
    })
    mark(`「${ep.title}」를 ${SCRIPT_FORMATS[SCRIPT.format]?.label || SCRIPT.format} 대본으로 옮겼습니다`,
      { step: 'script', ref: String(SCRIPT.ep), refKind: 'ep' })
    /*
     * 대본을 프로젝트에 넣어 둡니다. 전에는 이 값이 SCRIPT.text 라는 전역 변수에만
     * 있었습니다. 그래서 새로고침 한 번에 사라졌고, 키비주얼로 옮기려면 사람이 「복사」를
     * 눌러 그 화면의 대본 칸에 붙여야 했습니다. 이제 키비주얼이 같은 자리를 읽습니다.
     *
     * 실패해도 대본은 화면에 그대로 있습니다(SCRIPT.text). 그래서 화면을 멈추지 않고
     * 못 담았다는 것만 적습니다. 복사와 다운로드 버튼도 그대로라 사람이 손으로 건질
     * 길이 남아 있습니다.
     */
    await keepScript(SCRIPT.text)
  } catch (err) {
    console.warn('[story-graph] 대본화 실패', err)
    // 권한 때문이면 「다시 시도해 주세요」를 붙이지 않습니다. 역할은 다시 눌러서 바뀌지 않습니다
    SCRIPT.err = isDenied(err)
      ? (denyReason('plan', myRole()) || err.message)
      : `${err.message || '서버 연결에 실패했습니다.'} 다시 시도해 주세요.`
  } finally {
    SCRIPT.busy = false
    renderScriptPanel()
  }
}

/**
 * 대본을 이 프로젝트의 에셋으로 담습니다. 실패는 삼키고 적어만 둡니다.
 *
 * saveAsset 은 못 담으면 던집니다(너무 길거나, 저장소가 꽉 찼거나, 리뷰 역할이거나).
 * 그것을 여기서 받아 안내문으로 바꿉니다. 대본 자체는 화면에 남아 있으므로 작업이
 * 사라지는 것은 아니고, 「담겼다」고 조용히 넘어가지만 않으면 됩니다.
 */
async function keepScript(text) {
  if (!text?.trim()) return
  const note = $('scNote')
  const say = (msg) => {
    if (!note) return
    note.className = 'warn'
    note.textContent = msg
  }
  /*
   * 리뷰 역할은 에셋을 쓰지 못합니다(infra/resolvers/putAsset.js). 보내지 않고 여기서
   * 말합니다. 전에는 조용히 돌아섰는데, 담기지 않은 것을 담긴 것처럼 두면 새로고침
   * 뒤에야 알게 됩니다. 대본은 화면에 그대로 있고 복사·다운로드도 그대로라서, 지금
   * 받아 두면 잃지 않습니다 — 그 길을 같이 알려 줍니다.
   */
  if (configured && !allowed('putAsset', myRole())) {
    say(`${denyReason('putAsset', myRole())} `
      + '대본은 화면에 그대로 있습니다. 아래 「다운로드」로 받아 두세요.')
    return
  }
  try {
    await saveAsset({ boardId: BOARD, kind: 'script', body: text, actor: session()?.id })
  } catch (err) {
    console.warn('[story-graph] 대본을 담지 못했습니다', err)
    // 서버가 권한으로 튕겼습니다(위를 지나온 뒤 역할이 바뀐 경우). 영어 오류를 그대로
    // 띄우지 않습니다
    say(isDenied(err)
      ? `${denyReason('putAsset', myRole()) || '대본을 담을 권한이 없습니다.'} `
        + '아래 「다운로드」로 받아 두세요.'
      : `대본을 프로젝트에 담지 못했습니다. ${err.message} `
        + '아래 「다운로드」로 받아 두시는 것이 안전합니다.')
  }
}

async function copyScript(text) {
  const note = $('scNote')
  try {
    await navigator.clipboard.writeText(text)
    if (note) { note.className = 'ok'; note.textContent = '대본을 클립보드에 복사했습니다.' }
  } catch (err) {
    console.warn('[story-graph] 복사 실패', err)
    if (note) { note.className = 'warn'; note.textContent = '복사가 막혔습니다. 대본을 직접 선택해 복사해 주세요.' }
  }
}

/** 대본 텍스트를 .txt 로 내려받는다. BOM 을 붙여 한글이 깨지지 않게 한다 */
function downloadScript(text, filename) {
  const url = URL.createObjectURL(scriptBlob(text))
  const a = document.createElement('a')
  a.href = url
  a.download = filename || '대본.txt'
  a.click()
  URL.revokeObjectURL(url)
}

// ── 대본에서 그래프 뽑기 ──────────────────────────────────────────────────────
async function extract() {
  const raw = $('scriptIn').value
  const text = scriptToText(raw, $('scriptIn').dataset.name || '')
  const hint = $('inputHint')
  if (text.trim().length < 8) {
    hint.className = 'err'
    hint.textContent = '대본이 너무 짧습니다. 8자 이상 넣어주세요.'
    return
  }
  if (!NET) {
    hint.className = 'err'
    hint.textContent = '그래프 추출에는 Bedrock 연결이 필요합니다. 목데이터로는 아래 흐름을 그대로 볼 수 있습니다.'
    return
  }
  /*
   * 권한을 여기서 먼저 본다. 서버(infra/resolvers/plan.js)가 기획·감독만 받으므로
   * 아티스트·리뷰어·관리자는 조각을 열두 개 보내도 열두 번 다 거부된다. 그 왕복을 하지
   * 않고, 무엇이 안 되고 누구면 되는지 바로 적는다.
   *
   * 이것만으로 끝나지 않는다. 역할은 관리자가 바꿀 수 있고 열어 둔 탭은 그대로 남으므로,
   * 아래 catch 가 서버의 거부도 같은 말로 받는다.
   */
  const why = denyReason('plan', myRole())
  if (configured && why) {
    hint.className = 'err'
    hint.textContent = why
    return
  }
  $('extractBtn').disabled = true
  hint.className = 'hint'
  hint.innerHTML = `<span class="spin"></span> ${esc(modelLabel())} 로 그래프를 뽑고 있습니다.`
    + ' 대본이 길면 먼저 요약한 뒤 읽습니다.'
  try {
    // 새 대본은 빈 판에서 뽑는다. 지금 그래프를 canon 으로 주면 남의 작품 id 를 물려받는다
    const g = await planGraph(NET, text, { model: MODEL() })
    build(newStore(g))
    // 노드 수는 아래 mark 와 hint 가 이미 말합니다. 머리의 배지는 없앴습니다
    mark(`대본에서 노드 ${g.nodes.length}개 · 씨앗 ${SEEDS.length}개를 뽑았습니다`)
    const bad = [...(g.warnings || []), ...(g.conflicts || []).map((c) => `${c.level}: ${c.msg}`)]
    hint.className = bad.length ? 'warn' : 'hint'
    hint.innerHTML = bad.length
      ? `추출했습니다. 걸린 것 ${bad.length}건:<br>${bad.slice(0, 6).map(esc).join('<br>')}`
      : `추출했습니다. 노드 ${g.nodes.length} · 씨앗 ${SEEDS.length}개.`
  } catch (err) {
    console.warn('[story-graph] 추출 실패', err)
    hint.className = 'err'
    /*
     * 권한 때문이면 「잠시 뒤 다시」를 붙이지 않는다. 역할은 기다려서 바뀌지 않으므로
     * 그 한 줄이 사람을 같은 버튼으로 계속 돌려보낸다. 대신 무엇이 안 되고 누구면 되는지
     * 적는다(domain/permissions.js).
     */
    hint.innerHTML = isDenied(err)
      ? esc(denyReason('plan', myRole()) || err.message)
      : `${esc(err.message || '서버 연결에 실패했습니다.')}<br>잠시 뒤 그래프 추출을 다시 눌러 주세요.`
  } finally {
    $('extractBtn').disabled = false
  }
}

// ── 온보딩 ───────────────────────────────────────────────────────────────────
/*
 * 이 화면은 처음에 비어 있다. 예전에는 start() 가 목데이터를 알아서 얹었고, 그래서
 * 처음 온 사람은 자기가 만든 것도 아닌 케데헌 그래프 앞에 앉았다. 무엇이 예시이고
 * 무엇이 자기 것인지 가를 수 없었다. 이제 두 갈래를 먼저 묻는다.
 *
 *   예시 보기      loadMock 을 재생기에 태워 차근차근 얹는다 (아래 runExample)
 *   직접 시작하기  대본 칸에 커서를 두고 코치마크를 연다
 */
function paintWelcome() {
  const slot = $('onbSlot')
  if (!slot) return
  slot.textContent = ''
  slot.append(emptyPanel({
    eyebrow: '스토리 디벨롭',
    head: '처음 오셨나요?',
    lines: [
      '판이 비어 있습니다. 대본이나 시놉시스를 넣으면 인물·장소·사건이 그래프가 됩니다.',
      '그 그래프에서 탐지기 12종이 이야기 씨앗을 찾고, 씨앗 하나가 분기 → 개요 → 컷 → 대본으로 펼쳐집니다.',
      '어떻게 도는지 먼저 보시려면 예시를 눌러 보세요. 케데헌 그래프로 그 순서를 한 단계씩 밟습니다.',
    ],
    exampleLabel: '예시 보기',
    onExample: () => runExample(),
    ownLabel: '직접 시작하기',
    /*
     * 직접 시작하는 사람에게는 안내를 열지 않습니다. 이미 쓰기로 정한 사람에게 막을
     * 덮어 넉 장을 넘기게 하면 안내가 아니라 걸림돌입니다. 커서만 대본 칸에 둡니다.
     * 거절을 기억해 두는 이유는 coach.skip 에 적어 두었습니다. 다시 보고 싶으면
     * 헤더의 「안내 다시 보기」가 있습니다.
     */
    onOwn: () => { coach.skip(COACH_KEY); $('scriptIn')?.focus() },
    warn: NET
      ? '직접 하실 때의 추출과 생성은 Bedrock 을 부릅니다. 한 번에 10~30초씩 걸리고, 여기 남는 기록은 같은 보드를 보는 사람에게도 보입니다. '
        + '예시는 미리 받아 둔 데이터만 쓰므로 기다리지 않습니다.'
      : '로컬 모드입니다. 직접 하는 추출은 Bedrock 이 필요해 막혀 있습니다. 예시는 미리 받아 둔 데이터만 쓰므로 그대로 볼 수 있습니다.',
  }))
  slot.hidden = false
  slot.classList.toggle('onbslot--wide', !!$('inputCard').hidden)
}

/**
 * 판에 노드가 있으면 안내를 걷습니다. build 와 예시 안내가 같은 자리를 지납니다.
 *
 * 예시 프로젝트로 들어온 것이면(?demo=1) 이 판을 아예 띄우지 않습니다. 홈의 파란 버튼을
 * 누른 사람은 「예시를 보겠다」를 이미 말한 사람인데, 여기서 「처음 오셨나요? … 예시를
 * 눌러 보세요」를 다시 내밀면 같은 것을 두 번 묻는 셈입니다. build 가 runExample 보다
 * 먼저 지나므로, 여기서 막지 않으면 한 프레임 깜빡이고 사라집니다.
 */
function syncWelcome() {
  const slot = $('onbSlot')
  if (!slot) return
  const empty = !STORE || !STORE.stats().nodes
  if (empty && !guiding() && !demoActive()) paintWelcome()
  else slot.hidden = true
}

/*
 * 예시 안내를 시작합니다. 안내 자체는 app-walkthrough 에 있습니다. 그쪽은 이 파일을
 * import 할 수 없어서(../../app-walkthrough/tour.js 의 머리글) 쓸 것을 여기서 넣습니다.
 *
 * STORE · SEEDS · STORIES 는 예시가 도는 사이에 바뀝니다(그래프를 얹고 씨앗을 뽑는 것이
 * 예시가 하는 일입니다). 그래서 값이 아니라 읽는 함수를 넘깁니다.
 */
function runExample() {
  const slot = $('onbSlot')
  if (slot) slot.hidden = true
  return developExample({
    $, NET, modelLabel,
    store: () => STORE, stories: () => STORIES, seeds: () => SEEDS,
    boot, mark, openTab, pickSeed,
    playing: (on) => { PLAYING_EXAMPLE = on },
    /*
     * 예시를 마치면 끝입니다. 예전에는 여기서 코치마크를 이어 열었습니다. 예시가 이미
     * 화면을 짚어 가며 다 보여준 뒤라, 끝났다고 생각한 사람에게 막이 한 번 더 덮였습니다.
     *
     * 코치마크 자체는 남아 있습니다. 예시를 보지 않고 온 사람에게는 열리고, 다시 보려면
     * 헤더의 「안내 다시 보기」입니다. 봤다고 적어 두는 이유는 coach.skip 에 있습니다.
     */
    afterDone: () => { coach.skip(COACH_KEY); syncWelcome(); paintHist() },
  })
}

/*
 * 코치마크. 가리키는 것은 이 화면에 실제로 있는 것뿐이다. 앵커가 없는 장은
 * coach.js 가 조용히 건너뛴다. 그래서 판이 비어 있어도 같은 카드 묶음을 쓴다.
 */
const DEV_CARDS = [
  {
    head: '대본이 먼저입니다',
    body: '여기에 시놉시스나 대본을 넣습니다. .txt · .fdx 파일을 카드에 끌어다 놓아도 됩니다.\n'
      + '넣은 대본은 그래프를 뽑는 데만 쓰이고, 이 계정의 Bedrock 안에서 처리됩니다.',
    spot: ['input'],
  },
  {
    head: '그래프는 사실만 담습니다',
    body: '인물 · 장소 · 사건과 그 사이의 관계가 노드와 엣지가 됩니다.\n'
      + '실선은 대본에 적힌 것, 점선은 규칙이 미뤄 낸 것입니다. 두 개를 갈라 두는 이유는 '
      + '미뤄 낸 것이 틀릴 수 있기 때문입니다.',
    spot: ['stats'],
  },
  {
    head: '씨앗 → 분기 → 컷 → 대본',
    body: '옆 탭이 그 순서입니다. 씨앗을 고르면 스토리 탭에 분기가 서고, '
      + '분기를 펼치면 개요와 컷이 나오고, 대본화 탭이 그것을 대본 텍스트로 옮깁니다.\n'
      + '컷을 판에 붙이면 그래프가 자라고 씨앗이 다시 뽑힙니다. 그게 이 화면의 고리입니다.',
    spot: ['tabs'],
    step: 'seeds',
  },
  {
    head: '누가 뭘 했는지 남습니다',
    body: '이 화면에서 한 일이 보드와 같은 기록에 쌓입니다. 그래서 홈에서도, 키비주얼에서도 같이 보입니다.\n'
      + '줄을 누르면 그 자리에서 이어서 합니다. 「내 것만」으로 내가 등록한 것만 볼 수 있습니다.',
    spot: ['histbox'],
    step: 'hist',
    next: '시작하기', skip: '다시 보지 않기',
  },
]

const COACH_KEY = 'sb.dev.coach.v1'

/** 지금 열려 있는 안쪽 탭. 코치마크가 앵커를 화면에 올리려고 이걸 본다 */
const atTab = () => document.querySelector('.tabs .tab.active')?.dataset.tab || 'seeds'

function openCoach() {
  // 예시 안내 중에는 막을 덮지 않습니다. 짚은 자리를 사람이 실제로 눌러야 합니다
  if (guiding()) return
  // 안내가 탭을 옮겨 놓고 끝난다. 열려 있던 탭으로 되돌려 준다
  const was = atTab()
  coach.start({
    cards: DEV_CARDS, key: COACH_KEY, title: '스토리 디벨롭',
    /*
     * 안 열린 탭 속의 앵커는 화면에 없는 것과 같다. 판이 display:none 이라 좌표가
     * 0 이고, 막 위로 올려도 보이지 않는다. 그래서 그 장의 탭을 대신 열어 준다.
     * 키비주얼이 단계를 옮기는 자리와 같은 손잡이다 (coach.js 의 host).
     */
    host: { atStep: atTab, goStep: (t) => openTab(t) },
    onDone: () => { if (atTab() !== was) openTab(was) },
  })
}

// ── 세계관 네비게이터 챗봇 ────────────────────────────────────────────────────
// 떠 있는 버튼 하나로 열리는 카드다. 화면 구조(왼쪽 카드 · 판 · 오른쪽 패널)는 건드리지 않는다.
// 마운트는 한 번만 한다. 판을 다시 지어도(build) 챗봇은 그대로 있고, 질문이 올 때
// STORE 를 그때 읽는다. 그래서 목데이터로 되돌리거나 새 대본을 추출해도 최신 그래프를 본다.
function mountChat() {
  mountNavigatorChat(document.body, {
    onSend: async (question) => {
      if (!STORE || !STORE.stats().nodes) {
        return '현재 그래프가 비어있습니다. 먼저 시놉시스를 넣어 그래프를 추출하세요.'
      }
      if (!NET) {
        return '지금은 로컬 모드입니다. 네비게이터는 Bedrock 연결이 필요합니다. 배포된 화면에서 물어봐 주세요.'
      }
      /*
       * 권한은 보내기 전에 여기서 봅니다. 챗봇은 로그인도 서버도 모르는 부품이라
       * (components/navigator-chat.js) 문장을 만들 수 있는 곳이 이 자리뿐입니다.
       * retry:false 를 달아 「잠시 뒤 다시 물어봐 주세요」 가 붙지 않게 합니다 —
       * 역할은 기다려서 바뀌지 않습니다.
       */
      const why = denyReason('navigate', myRole())
      if (why) throw Object.assign(new Error(why), { retry: false })
      try {
        // 히스토리는 navigator-ui.js 가 sessionStorage 에 적어 둔 것을 그대로 읽는다.
        // 이번 질문은 아직 들어 있지 않다. Lambda 가 마지막 user 메시지로 따로 붙인다
        return await runNavigateJob(NET, {
          projectId: STORE.projectId || DEFAULT_PROJECT,
          question,
          // 스냅샷에 최근 역기입의 변경 요약을 얹어 보낸다. 역기입을 한 적이 없으면
          // null 이고, 그때는 Lambda 가 스냅샷만으로 답한다
          graphData: { ...STORE.toJSON(), recentWriteback: LAST_WRITEBACK },
          conversationHistory: readHistory(),
          model: MODEL(),
        })
      } catch (err) {
        // 위의 미리 보기를 지나왔는데도 서버가 권한으로 튕겼습니다. 관리자가 방금 역할을
        // 바꿨거나 열어 둔 탭이 오래된 것입니다. 서버 문장을 우리 말로 바꿔 답합니다
        if (!isDenied(err)) throw err
        throw Object.assign(new Error(denyReason('navigate', myRole())
          || '세계관 네비게이터를 쓸 권한이 없습니다.'), { retry: false })
      }
    },
  })
}

// ── 시동 ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tabs .tab').forEach((t) => { t.onclick = () => openTab(t.dataset.tab) })

// 상단 기능 탭. 스토리보드와 키비주얼은 링크로 나가고(/board.html · /key-visual.html),
// 디벨롭·대본화는 이 화면에서 받습니다. keyvisual 을 handled 에 넣으면 버튼이 되어
// 눌러도 이동하지 않으므로 넣지 않습니다.
// ?tab=script 로 들어오면 안쪽 [대본화] 가 처음부터 열려 있습니다.
{
  /*
   * 이 화면이 받지 못하는 탭 이름으로 들어오면 기본 탭으로 떨어뜨립니다.
   * ?tab=board 나 ?tab=keyvisual 은 각자 자기 화면이 따로 있으므로 여기서 열 수 없습니다. * 그대로 두면 어느 판도 켜지지 않아 빈 화면이 됩니다.
   */
  const asked = navTabFromSearch(location.search, 'develop')
  const first = asked === 'board' || asked === 'keyvisual' ? 'develop' : asked
  NAV = mountNav({
    mount: $('navMount'),
    active: first,
    handled: ['develop', 'script'],
    onSelect: (id) => openTab(id === 'script' ? 'script' : LAST_DEV_TAB),
  })
  if (first === 'script') openTab('script')
}
$('nodeClose').onclick = hideNode
$('extractBtn').onclick = extract
$('inputToggle').onclick = () => {
  const card = $('inputCard')
  card.hidden = !card.hidden
  $('inputToggle').textContent = card.hidden ? '대본 입력 펼치기' : '대본 입력 접기'
  VIS?.setInsets(insets()) // 카드가 접히면 판이 그 자리까지 쓴다
  $('onbSlot').classList.toggle('onbslot--wide', card.hidden) // 안내도 그 자리까지 당긴다
}

const drop = $('inputCard')
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drop') })
drop.addEventListener('dragleave', () => drop.classList.remove('drop'))
drop.addEventListener('drop', async (e) => {
  e.preventDefault()
  drop.classList.remove('drop')
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  if (!/\.(txt|fdx|md|fountain)$/i.test(file.name)) {
    $('inputHint').className = 'err'
    $('inputHint').textContent = '.txt 또는 .fdx 파일만 읽습니다.'
    return
  }
  $('scriptIn').value = await file.text()
  $('scriptIn').dataset.name = file.name
  $('inputHint').className = 'hint'
  $('inputHint').textContent = `${file.name} 을 읽었습니다. 그래프 추출을 눌러주세요.`
})

/*
 * 머리의 왼쪽. 네 화면이 같은 것을 씁니다. 누르면 홈입니다.
 *
 * 예전에는 여기에 배지 둘이 있었습니다. 「Bedrock · Neptune 연결」 과 「graph: …」 입니다.
 * 둘 다 이 화면을 만드는 사람에게는 쓸모가 있었지만 쓰는 사람이 할 일과는 상관이 없어서,
 * 머리에서 뺐습니다. 값 자체는 버리지 않고 콘솔에 한 줄로 남깁니다. 어느 쪽에 붙었는지
 * 봐야 하는 일이 실제로 있습니다(로컬 모드에서 mock 씨앗을 보고 있는 줄 모르는 자리).
 */
mountBrand('#brandMount')
console.info('[story-graph] %s · graph: %s%s',
  NET ? (GRAPH_NET ? 'Bedrock · Neptune 연결' : 'Bedrock 연결') : '로컬 모드 (mock)',
  GRAPH_SRC, SEED_SRC === 'mock' ? ' · seeds: mock' : '')

// 로컬 모드에서는 고를 것이 없다. 생성이 전부 로컬 폴백으로 돌아 모델을 쓰지 않는다
if (!NET) {
  $('modelSel').disabled = true
  $('modelHint').textContent = '로컬 모드에서는 모델을 쓰지 않습니다. Bedrock 에 연결하면 여기서 고릅니다.'
}

function fail(err) {
  // 안내를 넣으려면 판 자리를 비워야 합니다. 캔버스를 걷어내고 VIS 를 다시 만들게 합니다
  if (VIS) { VIS.destroy(); VIS = null }
  $('network').innerHTML = `<div class="load-error">예시 데이터를 불러오지 못했습니다: ${esc(err.message)}<br>
    파일 경로가 아니라 HTTP 로 열어야 합니다. 예: node infra/scripts/serve-local.mjs<br>
    <button class="btn" id="retryLoad" style="margin-top:10px">다시 시도</button></div>`
  $('seedsList').innerHTML = '<div class="placeholder">데이터 로드 실패</div>'
  $('retryLoad').onclick = boot
}

/**
 * 목데이터로 판을 채운다. Neptune 모드면 이것이 그대로 저장돼 사실이 된다.
 * 목데이터를 되돌리는 버튼도 이 길을 지난다.
 */
async function boot() {
  try {
    const d = await loadMock()
    MOCK_SEEDS = d.seeds
    POOL = d.seeds.map((s, i) => ({ ...d.stories[i], probe: s.probe, focus: s.focus }))
    build(newStore(d.graph), { keepSeeds: SEED_SRC === 'mock' ? d.seeds : null })
  } catch (err) {
    fail(err)
  }
}

/**
 * 첫 로드.
 *
 * Neptune 에 남아 있는 그래프가 있으면 그것으로 시작한다. 새로고침해도 지난번에
 * 자란 판이 그대로 나온다. 저장된 것이 없으면 **비운 채로** 시작한다.
 *
 * 예전에는 여기서 목데이터를 얹었다. 그러면 처음 온 사람이 자기가 만들지 않은 케데헌
 * 그래프 앞에 앉게 되고, 무엇이 예시이고 무엇이 자기 것인지 가를 수 없었다. 이제
 * 빈 판에 「처음 오셨나요?」를 띄우고, 목데이터는 그 판의 [예시 보기] 가 부른다.
 */
async function start() {
  let stored = null
  try {
    stored = await loadGraphStore({ net: GRAPH_NET, projectId: BOARD })
  } catch (err) {
    console.warn('[story-graph] Neptune 에서 그래프를 읽지 못했다. 빈 판으로 시작한다', err)
  }

  // 목 씨앗·스토리는 로컬 폴백용이라 어느 쪽으로 시작하든 미리 읽어 둔다
  try {
    const d = await loadMock()
    MOCK_SEEDS = d.seeds
    POOL = d.seeds.map((s, i) => ({ ...d.stories[i], probe: s.probe, focus: s.focus }))
  } catch (err) {
    console.warn('[story-graph] 목 씨앗·스토리를 읽지 못했다. 임시 분기로 돈다', err.message)
  }

  if (!stored || !stored.stats().nodes) {
    // 빈 저장소로 판을 세운다. STORE 가 null 이면 renderNetwork·renderSeeds 가 터진다
    build(createGraphStore({ nodes: [], edges: [] }, { projectId: BOARD }))
    return
  }
  build(stored)
}

/**
 * 지나간 일을 읽어 온다. 화면을 세운 뒤에 부른다. 로그를 못 읽어도 화면은 돌아야 한다.
 * 목록은 최근 30줄만 그리므로 다 들고 있을 이유가 없어 뒤쪽 300건만 남긴다.
 */
async function loadHistory() {
  const past = await OPS?.fetchOps?.().catch((err) => {
    console.warn('[story-graph] 기록을 읽지 못했다', err.message)
    return null
  })
  if (past?.length) JOURNAL.unshift(...past.slice(-300))
  paintHist()
}

// ── 로그인 문 ────────────────────────────────────────────────────────────────
// 이 화면을 새 탭에서 바로 열면 sessionStorage 에 sb.auth 가 없어서 plan·graph 호출이
// 401 로 떨어진다. 그래서 Cognito 가 설정돼 있고 토큰이 없을 때는 판을 시동하지 않고
// 문을 먼저 세운다. 로그인 로직은 auth.js 를, 데모 계정 목록은 login.js 를 그대로 쓴다.
// 성공하면 sb.auth 가 저장된 상태에서 새로고침해 처음부터 다시 돈다.

const DEMO_PW = window.SB_CONFIG?.demoPw || ''
const gate = $('gate')
const gateSay = (msg) => { const el = $('lgWhy'); if (el) el.textContent = msg || '' }

function gateBusy(on) {
  const b = $('lgGo')
  if (!b) return
  b.disabled = on
  gate.querySelectorAll('[data-demo]').forEach((x) => { x.disabled = on })
  b.textContent = on ? '확인 중…' : '로그인'
  if (on) gateSay('')
}

/** 로그인 폼. 데모 계정을 누르면 아이디를 채우고, demoPw 가 있으면 바로 들어간다 */
function showGate() {
  gate.hidden = false
  gate.innerHTML = `
    <form class="gate__card" id="lgForm" autocomplete="on">
      <div class="gate__eyebrow">Story Graph</div>
      <h2 class="gate__title">로그인</h2>
      <p class="gate__sub">이 화면은 Bedrock·Neptune 을 직접 부릅니다. 등록된 팀원만 들어올 수 있습니다.</p>
      <span class="lf__label">데모 계정 · 눌러서 바로 들어가기</span>
      <div class="gate__list">
        ${DEMO_USERS.map((u) => `
          <button class="gate__who" type="button" data-demo="${esc(u.id)}">
            <span class="gate__dot" style="background:${esc(u.color)}"></span>
            <span><span class="gate__name">${esc(u.name)}</span><br>
              <span class="gate__role">${esc(u.role)} · ${esc(u.id)}</span></span>
            <span class="gate__job">${esc(u.job)}</span>
          </button>`).join('')}
      </div>
      <div class="lf__or">직접 입력</div>
      <label class="lf">
        <span class="lf__label">이메일 또는 아이디</span>
        <input type="text" id="lgId" name="username" autocomplete="username"
          autocapitalize="off" spellcheck="false" required>
      </label>
      <label class="lf">
        <span class="lf__label">비밀번호</span>
        <input type="password" id="lgPw" name="password" autocomplete="current-password" required>
      </label>
      <label class="lf lf--check"><input type="checkbox" id="lgKeep">
        <span>이 브라우저에 로그인 유지</span></label>
      <button class="btn btn--wide" id="lgGo" type="submit">로그인</button>
      <p class="lf__why" id="lgWhy" role="alert" aria-live="polite"></p>
      <p class="lf__note">${DEMO_PW
        ? '데모 계정을 누르면 바로 들어갑니다.'
        : '데모 계정을 누르면 아이디가 채워집니다. 비밀번호는 관리자에게 받은 값을 넣어주세요.'}</p>
    </form>`
  $('lgId').focus()

  $('lgForm').addEventListener('click', (e) => {
    const id = e.target.closest('[data-demo]')?.dataset.demo
    if (!id) return
    $('lgId').value = id
    if (!DEMO_PW) return $('lgPw').focus()
    $('lgPw').value = DEMO_PW
    $('lgForm').requestSubmit()
  })

  $('lgForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const id = $('lgId').value.trim()
    const pw = $('lgPw').value
    if (!id || !pw) return gateSay('아이디와 비밀번호를 입력해주세요.')
    gateBusy(true)
    try {
      const r = await login(id, pw, $('lgKeep').checked)
      if (r.challenge) return askNewPassword(r.need)
      location.reload()
    } catch (err) {
      gateSay(err.message)
      $('lgPw').select()
    } finally {
      gateBusy(false)
    }
  })
}

/** 임시 비밀번호로 들어온 첫 로그인. auth.js 의 setNewPassword 를 그대로 쓴다 */
function askNewPassword(need) {
  gate.innerHTML = `
    <form class="gate__card" id="pwForm">
      <div class="gate__eyebrow">첫 로그인</div>
      <h2 class="gate__title">새 비밀번호를 정해주세요</h2>
      <p class="gate__sub">임시 비밀번호는 이번 한 번만 쓰입니다. 8자 이상, 영문과 숫자를 섞어주세요.</p>
      ${need?.includes('name') ? `<label class="lf"><span class="lf__label">이름</span>
        <input type="text" id="pwName" required></label>` : ''}
      <label class="lf"><span class="lf__label">새 비밀번호</span>
        <input type="password" id="pwNew" autocomplete="new-password" required></label>
      <label class="lf"><span class="lf__label">한 번 더</span>
        <input type="password" id="pwAgain" autocomplete="new-password" required></label>
      <button class="btn btn--wide" type="submit">설정하고 들어가기</button>
      <p class="lf__why" id="lgWhy" role="alert" aria-live="polite"></p>
    </form>`
  $('pwNew').focus()
  $('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const pw = $('pwNew').value
    if (pw.length < 8) return gateSay('8자 이상으로 정해주세요.')
    if (pw !== $('pwAgain').value) return gateSay('두 비밀번호가 다릅니다.')
    try {
      await setNewPassword(pw, $('pwName') ? { name: $('pwName').value.trim() } : {})
      location.reload()
    } catch (err) {
      gateSay(err.message)
    }
  })
}

/** 들어와 있으면 누구로 들어와 있는지 띠에 남긴다. 로그아웃은 토큰만 버리고 새로고침 */
function showWho() {
  const me = session()
  if (!me) return
  $('whoAmI').hidden = false
  $('whoAmI').textContent = `${me.name} · ${me.role}`
  $('logoutBtn').hidden = false
  $('logoutBtn').onclick = () => { logout(); location.reload() }
}

// 목데이터는 이제 예시 재생기가 얹는다. 버튼 하나로 그냥 얹으면 무엇이 예시인지
// 모른 채 판이 채워지고, 그게 지금까지의 문제였다
$('mockBtn').onclick = runExample
$('histMine').onclick = () => { HIST_MINE = !HIST_MINE; paintHist() }
$('coachBtn').onclick = openCoach
renderLegend()
if (configured && !session()) {
  // 토큰이 없다. 판을 시동하지 않고 문만 세운다 (호출이 401 로 떨어지지 않게)
  showGate()
} else {
  showWho()
  /*
   * 판을 세우기 전에 프로젝트 보드를 먼저 세운다. 주소에 ?board= 가 있으면 아무것도
   * 뜨지 않고 바로 start() 로 간다.
   *
   * 고르면 그 주소로 화면을 다시 여는 것이라 이 약속은 해결되지 않는다. Neptune 을
   * 읽지도, 목데이터를 미리 읽지도 않는다. 어느 프로젝트인지 모르는 채로 그래프를
   * 세우면 고른 뒤에 그것을 다 물려야 한다.
   */
  pickProject({
    step: navTabFromSearch(location.search, 'develop') === 'script' ? 'script' : 'develop',
    actor: session()?.id,
    who: (id) => nameMap(JOURNAL).get(id) || null,
  }).then(() => start()).then(() => {
    loadHistory()
    /*
     * 챗봇을 여기서 붙인다. 로그인 문이나 프로젝트 고르는 판이 서 있는 동안에는
     * 붙이지 않는다. 떠 있는 버튼이 그 위로 올라온다 (navigator-ui.js 의 z-index 가
     * projects.js 의 판보다 높다). 고르는 판이 닫히고 start() 가 지난 뒤가 그 자리다.
     */
    mountChat()
    /*
     * 예시 프로젝트가 이 화면으로 데려온 것이면(?demo=1) 바로 예시를 시작한다.
     * 키비주얼·보드도 같은 자리에서 같은 일을 한다(app/demo.js).
     *
     * 이 갈래가 없어서 홈의 파란 버튼이 먹지 않았다. 여기까지는 잘 왔는데 화면이
     * 「처음 오셨나요?」 판을 띄우고 서 버렸고, 예시를 보려면 그 판의 [예시 보기] 를
     * 한 번 더 눌러야 했다. 파란 버튼을 누른 사람에게는 아무 일도 안 일어난 것으로
     * 읽힌다. 실제로 그랬다.
     */
    if (demoActive()) { runExample(); return }
    /*
     * 판이 비어 있으면 코치마크를 열지 않는다. 그때는 화면에 「처음 오셨나요?」 판이
     * 있고 그 판이 두 갈래를 이미 말해 준다. 막을 덮어 그것을 가릴 이유가 없다.
     * 예시를 보거나 직접 시작하면 그 뒤에 열린다.
     */
    if (!coach.seen(COACH_KEY) && STORE?.stats().nodes) openCoach()
  })
}
