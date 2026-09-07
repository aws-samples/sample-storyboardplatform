/*
 * 스토리 디벨롭 화면 · 대본에서 그래프를 뽑고, 씨앗과 분기를 거쳐 다시 대본으로 돌아옵니다.
 *
 * 마크업과 CSS 는 app/story-graph.html 에 있고 여기는 그 화면의 코드입니다. 한때 그
 * 파일의 <script type="module"> 안에 1,660줄이 같이 있었습니다. 다른 세 화면은 처음부터
 * 코드를 파일로 뺐는데(screens/home.js · board.js · key-visual.js) 이 화면만 아니었고,
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
import { createGraphStore, loadGraphStore } from '../story/graph-engine.js'
import { findSeeds, PROBES } from '../story/graph-probes.js'
import {
  planGraph, planBranches, planFreeBranches, localBranches, scriptToText,
  branchToSpec, planBranchOutline, planCuts,
  applyWriteback, validateWritebackBeforeApply,
  planScript, scriptBlob, scriptFileName, SCRIPT_FORMATS,
  GENRES, TONES, LENGTHS, CUTCOUNTS,
} from '../story/story.js'
import { planClient, graphClient, opsClient } from '../platform/net.js'
import { createGraphView, graphDelta, KIND_COLOR, KIND_LABEL } from '../story/graph-view.js'
import { configured, session, login, setNewPassword, logout } from '../platform/auth.js'
import { DEMO_USERS } from '../platform/login.js'
import { NAV_TABS, navHref, mountNav, navTabFromSearch, boardFromSearch } from '../chrome/nav-tabs.js'
import { entries, group, markOp, paintList } from '../chrome/history.js'
import { emptyPanel } from '../chrome/empty-panel.js'
import { guide as guideExample, guiding } from '../../app-walkthrough/guide.js'
import { wire as wireTour, demoActive, demoAdvance, demoSay, demoTitle } from '../../app-walkthrough/tour.js'
import * as coach from '../chrome/coach.js'
import { pickProject, touch as touchProject } from '../chrome/projects.js'

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
  if (name === 'script') renderScriptPanel()
  if (name === 'hist') paintHist()
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

/**
 * 판에 붙이기. 여기서 역기입이 확정되고 그래프가 자란다.
 * 씨앗 인덱스가 바뀌므로 분기 캐시는 버린다.
 */
async function applyToBoard() {
  const x = EXPAND
  stashEpisode()
  // 무엇이 새로 생겼는지는 개수(applied)만으로는 알 수 없다. 전후 판을 견줘 id 를 뽑는다
  const before = STORE.toJSON()
  const seedsBefore = new Set(SEEDS.map(seedKey))
  x.applied = applyWriteback(STORE, x.branch.writeback)
  x.delta = graphDelta(before, STORE.toJSON())
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
    box.innerHTML = `<div class="placeholder">컷이 없습니다. 먼저 스토리를 생성해 주세요.<br>
      씨앗 → 분기 → <b>이 분기로 대본 생성</b> 을 지나면 여기에 컷이 들어옵니다.</div>`
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
  SCRIPT = { ...SCRIPT, busy: true, err: '', text: '' }
  renderScriptPanel()
  try {
    SCRIPT.text = await planScript(NET, ep.cuts, {
      format: SCRIPT.format, title: ep.title, chars: ep.chars, model: MODEL(),
    })
    mark(`「${ep.title}」를 ${SCRIPT_FORMATS[SCRIPT.format]?.label || SCRIPT.format} 대본으로 옮겼습니다`,
      { step: 'script', ref: String(SCRIPT.ep), refKind: 'ep' })
  } catch (err) {
    console.warn('[story-graph] 대본화 실패', err)
    SCRIPT.err = `${err.message || '서버 연결에 실패했습니다.'} 다시 시도해 주세요.`
  } finally {
    SCRIPT.busy = false
    renderScriptPanel()
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
  $('extractBtn').disabled = true
  hint.className = 'hint'
  hint.innerHTML = `<span class="spin"></span> ${esc(modelLabel())} 로 그래프를 뽑고 있습니다.`
    + ' 대본이 길면 먼저 요약한 뒤 읽습니다.'
  try {
    // 새 대본은 빈 판에서 뽑는다. 지금 그래프를 canon 으로 주면 남의 작품 id 를 물려받는다
    const g = await planGraph(NET, text, { model: MODEL() })
    build(newStore(g))
    $('srcBadge').textContent = `graph: 대본 추출 (노드 ${g.nodes.length})`
    mark(`대본에서 노드 ${g.nodes.length}개 · 씨앗 ${SEEDS.length}개를 뽑았습니다`)
    const bad = [...(g.warnings || []), ...(g.conflicts || []).map((c) => `${c.level}: ${c.msg}`)]
    hint.className = bad.length ? 'warn' : 'hint'
    hint.innerHTML = bad.length
      ? `추출했습니다. 걸린 것 ${bad.length}건:<br>${bad.slice(0, 6).map(esc).join('<br>')}`
      : `추출했습니다. 노드 ${g.nodes.length} · 씨앗 ${SEEDS.length}개.`
  } catch (err) {
    console.warn('[story-graph] 추출 실패', err)
    hint.className = 'err'
    hint.innerHTML = `${esc(err.message || '서버 연결에 실패했습니다.')}<br>잠시 뒤 그래프 추출을 다시 눌러 주세요.`
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

/**
 * 예시 안내. 목데이터를 한 번에 쏟지 않고 사람이 손으로 할 순서를 그대로 밟게 합니다. * 대본을 넣고, 그래프를 얹고, 씨앗을 보고, 첫 씨앗의 분기를 만듭니다. 단계마다 누를
 * 자리를 짚어 주고 그 자리를 눌러야 넘어갑니다. 다 본 사람은 이미 그 버튼들을 눌러
 * 본 사람입니다.
 *
 * 어느 단계도 Bedrock 을 부르지 않습니다. 그래프는 미리 뽑아 둔 것(boot 이 읽는
 * app-walkthrough/data/)을 얹고, 분기는 pickSeed(0, true) 로 목데이터(POOL)에서
 * 세웁니다. 예전에는 여기서 planBranches 가 돌아 한 단계에 10~30초가 걸렸는데,
 * 안내 중의 그 시간은 배우는 시간이 아니라 기다리는 시간입니다.
 *
 * 분기까지만 갑니다. 개요·컷·대본은 그 뒤에 직접 누르게 둡니다.
 */
function runExample() {
  const slot = $('onbSlot')
  if (slot) slot.hidden = true
  PLAYING_EXAMPLE = true
  let synopsis = ''

  const steps = [
    {
      say: '예시 시놉시스를 넣습니다',
      sub: '케이팝 데몬 헌터스. 세 사람이 노래로 결계를 붙잡고 있는 이야기입니다',
      spot: '#scriptIn', see: 'input',
      run: async () => {
        try {
          const res = await fetch('/app-walkthrough/data/kdh-synopsis.txt', { cache: 'no-store' })
          synopsis = res.ok ? await res.text() : ''
        } catch { synopsis = '' }
        if (synopsis) {
          $('scriptIn').value = synopsis
          $('inputHint').className = 'hint'
          $('inputHint').textContent = '예시 시놉시스를 넣었습니다. 직접 할 때는 여기에 붙여 넣습니다.'
        }
      },
    },
    {
      say: '대본에서 그래프를 뽑습니다',
      sub: NET
        ? '직접 하실 때는 이 버튼이 Bedrock 으로 이 일을 합니다. 예시는 미리 뽑아 둔 결과를 얹으므로 기다리지 않습니다'
        : '로컬 모드에서는 추출이 막혀 있어 미리 뽑아 둔 결과를 얹습니다',
      spot: 'extract', see: 'input',
      /*
       * 미리 뽑아 둔 그래프를 얹는 것이라 실제로는 즉시 끝납니다. 그래도 3초를 기다립니다. * 직접 할 때 이 버튼은 Bedrock 을 부르고 대본이 길면 먼저 요약까지 합니다. 예시가
       * 즉시 끝나는 것으로 보여 주면 직접 하는 사람이 그 기다림을 고장으로 읽습니다.
       */
      wait: 3000, waitSay: `${modelLabel()} 로 그래프를 뽑고 있습니다`,
      /*
       * 여기서 값을 팝니다. 이 버튼이 문장 모델을 부르는 자리이고, 그 모델을 우리가
       * 띄우지 않는다는 것이 이 화면 구조의 절반입니다(나머지 절반은 키비주얼의 그림
       * 모델입니다). 파란 안내와 색을 갈라 적습니다. onboard.js 머리글의 note.
       */
      note: {
        head: '문장 모델은 부르기만 합니다',
        body: '대본에서 그래프를 뽑는 것은 *Amazon Bedrock* 이 합니다. 서버도 GPU도 띄우지 않고 '
          + '부른 만큼만 냅니다.',
      },
      run: async () => {
        await boot()
        if (STORE) mark(`예시 그래프를 얹었습니다. 노드 ${STORE.stats().nodes}개`)
      },
      /*
       * 3초를 기다리게 해 놓고 바로 다음 설명으로 넘어가면 그 3초가 만든 그래프가 막에
       * 덮입니다. 여기서 한 걸음 서서 그래프와 숫자 판을 같이 밝힙니다.
       *
       * 씨앗 판도 같이 엽니다. 그래프는 그 자체가 결과가 아니고 씨앗이 나오는 바탕입니다.
       * 그래프만 밝히면 「그림이 예쁘게 나왔다」로 끝나고, 다음 단계가 씨앗을 꺼낼 때
       * 그것이 어디서 나온 것인지가 끊깁니다.
       */
      done: {
        say: '그래프와 씨앗이 만들어졌습니다',
        sub: '인물 · 장소 · 사건이 노드가 되고 그 사이의 관계가 엣지가 됩니다. '
          + '「명시 엣지」는 대본에 적혀 있던 것이고 「추론」은 그것에서 따라 나온 것입니다. '
          + '오른쪽 씨앗은 그 그래프를 탐지기 12종이 읽어 찾아낸 이야기거리입니다',
        see: ['stats', '#network', 'tabs', '#seedsList'],
        got: () => {
          const st = STORE?.stats()
          return st
            ? `노드 ${st.nodes}개 · 명시 엣지 ${st.assertedEdges}개 · 추론 ${st.derivedEdges}개 · 씨앗 ${SEEDS.length}개`
            : ''
        },
        note: {
          head: '그래프로 두는 이유',
          body: '대본을 글로 두면 「미라가 무엇을 숨겼는지」를 사람이 다시 읽어야 압니다. '
            + '그래프로 두면 *탐지기가 그것을 찾습니다* · 회차가 쌓일수록 이 판이 자라고, '
            + '자란 판에서 다음 이야기가 나옵니다.',
        },
      },
    },
    {
      say: '탐지기 12종이 이야기 씨앗을 찾습니다',
      sub: '숨긴 비밀 · 삼각관계 · 체호프의 총 … 인물 사이에 걸린 것을 그래프에서 읽어 냅니다',
      spot: 'tabs', see: 'stats',
      run: () => { openTab('seeds') },
    },
    {
      say: '씨앗 하나에서 분기를 만듭니다',
      sub: '직접 하실 때는 이 버튼이 모델을 부릅니다. 예시는 미리 받아 둔 분기를 그 자리에 세웁니다',
      spot: '[data-seed="0"]', see: 'tabs',
      wait: 3000, waitSay: '분기 세 개를 만들고 있습니다',
      run: () => (SEEDS.length ? pickSeed(0, true) : null),
      /*
       * 기다려서 나온 스토리를 밝힙니다. 판(#storyPanel)까지 같이 냅니다. 탭만 밝히면
       * 「탭이 하나 켜졌다」로 보이고, 정작 3초가 만든 분기 · 비트 · 역기입 미리보기는
       * 막 아래에 그대로 남습니다.
       */
      done: {
        say: '스토리가 만들어졌습니다',
        sub: '한 씨앗에서 갈 수 있는 길 셋입니다. 분기마다 비트와 「이 분기의 결과」가 붙고, '
          + '아래 역기입 미리보기가 이 이야기를 판에 붙일 때 그래프가 어떻게 자라는지 미리 셉니다. '
          + '하나를 골라 [이 분기로 대본 생성] 을 누르면 개요 → 컷 → 대본으로 이어집니다',
        see: ['tabs', '#storyPanel'],
        got: () => {
          const n = STORIES.get('0')?.branches?.length || 0
          return n ? `분기 ${n}개 · 비트와 역기입까지` : '스토리 탭에 들어왔습니다'
        },
        note: {
          head: '고르는 일은 사람이 합니다',
          body: '모델은 길을 *셋 내놓기만* 합니다. 어느 길로 갈지, 무엇을 판에 붙일지는 기획자가 '
            + '고릅니다. 붙이기 전에 역기입을 미리 보여 주는 것이 그래서입니다.',
        },
      },
    },
    /*
     * 자유 입력을 짚습니다. 탐지기가 찾아 준 씨앗만으로 도는 화면으로 읽히면 기획자가
     * 「내 생각을 넣을 자리」를 못 찾습니다. 이 칸이 그 자리입니다. 예시는 방향 한 줄을
     * 넣어 보이는 것까지만 하고 생성은 하지 않습니다(그것이 모델을 부르는 자리입니다).
     */
    {
      say: '기획자가 방향을 직접 줄 수도 있습니다',
      sub: '탐지기가 제안한 분기가 마음에 들지 않을 때 이 칸에 원하는 방향을 적습니다. 씨앗을 고르지 않아도 됩니다',
      spot: 'free', see: 'tabs',
      tag: '이 칸을 누르십시오', do: '표시된 칸을 눌러 예시 방향을 넣습니다',
      run: () => {
        const box = $('freeIn')
        if (!box) return
        box.value = '미라가 먼저 비밀을 알아내고, 루미를 감싸는 쪽으로.'
        box.scrollIntoView({ block: 'nearest' })
      },
    },
    /*
     * 끝은 말풍선의 버튼 하나로 냅니다. 예전에는 「지나간 일」을 짚고 그것을 누르게 했는데,
     * 짚어 준 자리를 누르는 것과 예시를 끝내는 것이 같은 동작이 되어 무엇이 끝나는지가
     * 흐렸습니다. 나가는 일은 나가는 버튼으로 합니다. 지나간 일은 see 로 열어 둡니다. * 예시가 남긴 기록이 어디에 쌓이는지는 보여 주고 싶습니다.
     */
    {
      say: demoActive() ? '스토리 디벨롭을 다 보셨습니다' : '여기까지가 예시입니다',
      sub: demoActive()
        ? demoSay('develop')
        : '분기를 골라 [이 분기로 대본 생성] 을 누르면 개요 → 컷 → 대본으로 이어집니다. 이제 직접 해 보세요',
      see: 'histbox',
      go: demoActive() ? '다음 메뉴 예시로 넘어가기' : '예시 마치기',
      leaves: demoActive(),
    },
  ]

  guideExample({
    steps, title: demoTitle('develop', '스토리 디벨롭'),
    onDone: () => {
      PLAYING_EXAMPLE = false
      syncWelcome()
      paintHist()
      // 예시 프로젝트를 밟고 있으면 다음 화면(키비주얼)으로 넘어간다 (demo.js)
      if (demoAdvance('develop')) return
      openCoach()
    },
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

$('modeBadge').textContent = NET
  ? (GRAPH_NET ? 'Bedrock · Neptune 연결' : 'Bedrock 연결')
  : '로컬 모드 (mock)'
$('modeBadge').className = NET ? 'badge badge--live' : 'badge'
$('srcBadge').textContent = `graph: ${GRAPH_SRC}${SEED_SRC === 'mock' ? ' · seeds: mock' : ''}`

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
    $('srcBadge').textContent = `graph: ${GRAPH_SRC} (예시)`
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
    $('srcBadge').textContent = 'graph: 비어 있음'
    return
  }
  build(stored)
  $('srcBadge').textContent = `graph: Neptune (노드 ${stored.stats().nodes})`
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
