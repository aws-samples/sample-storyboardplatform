/*
 * 홈. 왼쪽 메뉴에서 하나를 고르면 그 판만 오른쪽에 펼칩니다.
 *
 * ══ 왜 한 번에 하나만 보여주는가
 *
 * 한동안 이 화면은 세 가지를 위에서 아래로 쌓아 두었습니다. 프로젝트 카드, 네 단계,
 * 지나간 일. 셋 다 필요한 것이었는데 같이 두니 처음 들어온 사람이 어디를 봐야 하는지
 * 고르지 못했습니다. 세 가지가 묻는 질문이 서로 다릅니다. 「새로 시작할까」, 「우리가
 * 뭘 하고 있었나」, 「지금 누가 뭘 하고 있나」. 한 번에 하나만 묻는 편이 낫습니다.
 *
 * 고른 메뉴는 주소에 ?view= 로 남깁니다. 전역 변수에만 두면 새로고침에 첫 판으로
 * 돌아가고, 「이 표 좀 보세요」라며 주소를 보낼 수도 없습니다.
 *
 * ══ 단계 목록과 기록은 여기서 따로 적지 않습니다
 *
 * 단계는 nav-tabs.js 의 NAV_TABS 를 그대로 씁니다. 그래야 홈과 각 화면 상단의 탭 바가
 * 어긋나지 않습니다. 주소도 navHref 한 곳에서만 정합니다. 기록을 줄로 옮기는 것은
 * history.js 가 하고, 홈은 그것을 표로 앉히는 것만 합니다.
 *
 * ══ 로그인
 *
 * 각 화면과 같은 auth.js 를 씁니다. 토큰이 sessionStorage 나 localStorage 에 담기고 같은
 * 오리진의 다른 화면이 그것을 읽으므로, 여기서 한 번 통과하면 보드나 키비주얼이 다시
 * 묻지 않습니다. SB_CONFIG 가 없는 로컬 모드에서는 문을 띄우지 않습니다. 그 모드는
 * Cognito 없이 화면만 보는 용도이고, 보드도 같은 조건에서 로그인을 건너뜁니다
 * (app/board.js 의 boot 이 configured 로 갈라지는 것과 같습니다).
 */
import { NAV_TABS, navHref, newHref, drawerHref } from '../domain/routes.js'
import { configured, session, logout } from '../services/auth.js'
import { showLogin, DEMO_USERS } from '../components/login-form.js'
import { setHtml } from '../lib/dom.js'
import { opsClient, connectorClient } from '../services/api.js'
import { entries, group } from '../services/activity-log.js'
import { paintTable } from '../components/history-list.js'
import { emptyHint } from '../components/empty-panel.js'
import {
  list as listProjects, remove as removeProject, touch as touchProject,
} from '../services/projects.js'
import { paintCards } from '../components/project-picker.js'
import { confirmAsk } from '../components/confirm.js'
import { allowed, denyReason, isDenied, roleName, JOB_ROLES } from '../domain/permissions.js'
import { mountBrand } from '../components/brand.js'
import { wire as wireTour, startDemo, DEMO_BOARD, DEMO_NAME, DEMO_TOTAL } from '../../app-walkthrough/tour.js'
import * as coach from '../components/coachmark.js'

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

const byId = (id) => document.getElementById(id)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* ══ 메뉴 ══════════════════════════════════════════ */

/*
 * 세 갈래. id 가 주소의 ?view= 값이고 sect 가 index.html 의 판입니다.
 *
 * 순서가 「새로 생성 → 프로젝트 → 작업 상황」입니다. 처음 온 사람에게는 첫 줄이 할
 * 일이고, 이미 일하던 사람은 두 번째와 세 번째로 바로 갑니다. 기본으로 어느 판을 펼칠지는
 * 아래 firstView 가 가진 것을 보고 정합니다. 프로젝트가 있으면 그것부터 보여줍니다.
 */
const VIEWS = [
  { id: 'new', sect: 'viewNew', ico: '+', label: '새로 생성' },
  { id: 'projects', sect: 'viewPj', ico: '▤', label: '프로젝트', count: () => projects.length },
  { id: 'activity', sect: 'viewAct', ico: '◔', label: '팀원들의 작업 상황 확인하기', count: () => acts.length },
  // 키를 다루는 판입니다. 관리자에게만 메뉴에 뜨고, 주소로 직접 들어와도 열리지 않습니다.
  // 서버가 한 번 더 막습니다(putConnector 리졸버가 admin 만 통과시킵니다).
  { id: 'conn', sect: 'viewConn', ico: '⚿', label: '모델 커넥터', admin: true, count: () => connN },
]

const amAdmin = () => (configured ? session()?.role : null) === 'admin'
/** 지금 이 사람에게 보여 줄 메뉴 */
const views = () => VIEWS.filter((v) => !v.admin || amAdmin())

const viewParam = () =>
  new URLSearchParams(location.search.replace(/^\?/, '')).get('view')

let view = 'new'

/*
 * 처음 펼칠 판.
 *
 * 주소가 정한 것이 가장 셉니다. 그 다음은 「우리가 뭘 하고 있었나」입니다. 프로젝트가
 * 하나라도 있으면 이 팀은 이미 일을 하고 있고, 그때 첫 화면이 「어디부터 시작할까요」면
 * 매번 한 번씩 메뉴를 눌러 넘겨야 합니다. 아무것도 없으면 새로 만드는 판입니다.
 */
function firstView() {
  const want = viewParam()
  if (views().some((v) => v.id === want)) return want
  return projects.length ? 'projects' : 'new'
}

/**
 * 판 하나를 펼치고 나머지를 접습니다.
 * @param {string} id - VIEWS 의 id
 * @param {boolean} [push] - 주소에도 남깁니다. 처음 그릴 때는 남기지 않습니다
 */
function show(id, push = true) {
  if (!views().some((v) => v.id === id)) id = 'new'
  view = id
  for (const v of VIEWS) byId(v.sect).hidden = v.id !== id
  paintSide()

  syncWelcome()

  if (!push) return
  /*
   * 주소만 갈아 끼웁니다. history.pushState 라서 새로 읽어 오지 않고, 뒤로 가기를 누르면
   * popstate 로 돌아옵니다. 메뉴를 눌러 넘어온 것을 브라우저의 뒤로 가기가 되돌립니다.
   */
  const u = new URL(location.href)
  u.searchParams.set('view', id)
  u.searchParams.delete('demo')
  window.history.pushState({ view: id }, '', u)
}

function paintSide() {
  setHtml(byId('sideList'), views().map((v) => {
    const n = v.count?.()
    return `<li>
      <button class="side__go" type="button" data-view="${esc(v.id)}"
              ${v.id === view ? 'aria-current="page"' : ''}>
        <span class="side__ico" aria-hidden="true">${esc(v.ico)}</span>
        <span>${esc(v.label)}</span>
        ${n ? `<span class="side__n">${n}</span>` : ''}
      </button>
    </li>`
  }).join(''))
  for (const b of byId('sideList').querySelectorAll('[data-view]')) {
    b.onclick = () => {
      /*
       * 메뉴로 들어온 것은 「팀 전체의 작업 상황」입니다. 한 판만 보던 것을 풀어 둡니다.
       * 그대로 두면 왼쪽 메뉴의 숫자(전체 건수)와 표에 보이는 줄 수가 어긋나고, 사람은
       * 자기가 무엇을 걸러 두었는지 기억하지 못합니다.
       */
      if (b.dataset.view === 'activity' && actBoard) { actBoard = null; paintActs() }
      show(b.dataset.view)
    }
  }
}

/* ══ 새로 생성 ═════════════════════════════════════ */

/*
 * 단계 넷. 번호는 NAV_TABS 순서에서 나옵니다. 별도로 적어 두면 어긋납니다.
 *
 * 주소는 navHref 가 아니라 newHref 입니다(?new=1). 이 목록은 「새로 생성」 안에 있으므로
 * 여기서 여는 단계는 늘 새 프로젝트로 시작합니다. 그 화면 앞의 문이 이름 칸 하나만
 * 내고 기존 판의 카드는 내지 않습니다. 이어서 할 판은 「프로젝트」 메뉴에서 엽니다.
 */
function paintSteps() {
  setHtml(byId('steps'), NAV_TABS.map((t, i) => {
    const n = String(i + 1).padStart(2, '0')
    return `<li class="step">
      <a class="step__go" href="${esc(newHref(t.id))}">
        <span class="step__n" aria-hidden="true">${n}</span>
        <span class="step__body">
          <span class="step__label">${esc(t.label)}</span>
          <span class="step__desc">${esc(t.desc)}</span>
        </span>
        <span class="step__arrow" aria-hidden="true">→</span>
      </a>
    </li>`
  }).join(''))
}

/*
 * 예시 프로젝트로 들어가는 버튼.
 *
 * 여기서 하는 일은 「예시 프로젝트」 판을 하나 만들어 두고 첫 화면을 여는 것뿐입니다.
 * 안내 자체는 각 화면이 이미 들고 있고(runExample), 화면을 잇는 것은 demo.js 가 합니다. * 어느 자리를 짚어야 하는지는 그 화면만 알기 때문에 여기로 베껴 오지 않습니다.
 */
function wireDemo() {
  const b = byId('demoGo')
  byId('demoSub').textContent =
    `${DEMO_TOTAL}개 화면을 차례로 열어 눌러야 할 자리를 짚어 드립니다`
  setHtml(byId('demoNote'),
    `예시가 남기는 것은 「${esc(DEMO_NAME)}」 한 판에만 들어갑니다. 우리 팀 프로젝트에는 `
    + '섞이지 않습니다. 예시에서는 그림 생성 모델을 부르지 않고 미리 받아 둔 내용을 '
    + '바로 띄우므로 기다리는 시간이 없습니다.')
  b.onclick = async () => {
    b.disabled = true
    try {
      await startDemo(session()?.id)
    } catch (e) {
      // 카드를 못 붙였어도 예시는 열립니다(startDemo 안에서 갈라집니다). 여기 오는 것은
      // 화면을 여는 것 자체가 막힌 경우이므로 버튼을 되살려 다시 눌러 볼 수 있게 합니다
      console.warn('[home] 예시를 열지 못했습니다', e.message)
      b.disabled = false
    }
  }
}

/*
 * 예시를 끝까지 본 사람이 돌아온 자리 (?demo=done). 안내가 끝났다는 것을 말해 주지
 * 않으면 마지막 화면에서 그냥 튕겨 나온 것처럼 읽힙니다.
 */
function paintDone() {
  const p = new URLSearchParams(location.search.replace(/^\?/, ''))
  if (p.get('demo') !== 'done') return
  const bar = byId('doneBar')
  bar.hidden = false
  byId('doneText').textContent =
    `예시를 다 보셨습니다. 방금 밟은 자리는 「${DEMO_NAME}」에 남아 있습니다. `
    + '프로젝트 메뉴에서 다시 열어 볼 수 있습니다.'
  byId('doneX').onclick = () => { bar.hidden = true }
}

/* ══ 프로젝트 ══════════════════════════════════════ */

/*
 * 각 화면 앞에 서는 문(projects.pickProject)과 같은 목록·같은 모양입니다. 다른 것은
 * 여기서는 문이 아니라 목록이라는 것뿐입니다.
 *
 * 카드를 누르면 프로젝트 서랍으로 갑니다(app/project.html). 전에는 곧장 스토리보드로
 * 보냈는데, 그러면 대본과 시놉시스만 들고 일하는 사람이 카드를 누를 때마다 자기 작업이
 * 없는 컷 화면에 도착했습니다. 게다가 프로젝트가 무엇을 들고 있는지는 어느 화면에서도
 * 보이지 않았습니다. 서랍이 그것을 먼저 펴 보이고, 거기서 원하는 에셋의 화면으로
 * 갑니다. 그때 ?board= 가 따라갑니다(drawerHref · navHref).
 */
let projects = []

async function loadProjects() {
  projects = await listProjects().catch((e) => {
    console.warn('[home] 프로젝트를 읽지 못했습니다', e.message)
    return []
  })
  paintProjects()
  paintSide()
}

function paintProjects() {
  byId('pjN').textContent = projects.length ? `${projects.length}개` : ''
  const who = nameMap(rawOps)
  paintCards(byId('pjList'), projects, {
    who: (id) => who.get(id) || null,
    onPick: (p) => { location.href = drawerHref(p.boardId) },
    menu: cardMenu,
    none: '아직 만든 프로젝트가 없습니다. 「새로 생성」에서 한 단계를 고르면 이름을 붙여 첫 판을 엽니다.',
  })
  setHtml(byId('pjNote'), projects.length
    ? '카드를 누르면 그 프로젝트의 보드가 열립니다. 주소에 프로젝트가 담기므로 '
      + '상단 탭으로 다른 단계로 넘어가도 같은 판을 봅니다. '
      + '카드 오른쪽 위의 「⋮」로 그 판의 작업 기록을 보거나 판을 지울 수 있습니다.'
    : '')
}

/* ══ 카드의 「⋮」 메뉴 ═════════════════════════════ */

/*
 * 나는 지금 무엇으로 앉아 있나. 로컬 모드에는 역할이라는 것이 없습니다.
 *
 * 로컬 모드(configured 가 거짓)에서는 막지 않습니다. 로그인이 없어서 역할이 없고,
 * 지워지는 것도 이 브라우저의 저장소뿐입니다. project.js 가 같은 판단을 합니다.
 */
const myRole = () => session()?.role || 'reviewer'
const mayDelete = () => !configured || allowed('deleteProject', myRole())

/**
 * 카드 하나의 메뉴에 세울 줄들.
 *
 * 세 줄입니다. 열기 · 작업 기록 보기 · 프로젝트 삭제.
 *
 * 전에는 지우기가 카드를 눌러 서랍(project.html)까지 들어가야 나왔습니다. 지우려고
 * 들어간 사람이 서랍의 여섯 줄을 지나 맨 아래까지 내려가야 했고, 그래서 「이 판을
 * 없애고 싶다」가 화면에서 보이지 않는 일이 되었습니다. 목록에서 바로 닿게 둡니다.
 *
 * 지우기는 감독만 됩니다. 흐리게 두고 왜 막혔는지를 title 로 답니다 — 숨기면 사람은
 * 기능이 없는 줄로 알고 찾아다니고, 감독에게 부탁할 일이라는 것도 모릅니다
 * (project.js 의 paintDanger 와 같은 판단입니다).
 */
const cardMenu = (p) => [
  { label: '열기', on: () => { location.href = drawerHref(p.boardId) } },
  { label: '작업 기록 보기', on: () => showActsFor(p.boardId) },
  {
    label: '프로젝트 삭제',
    danger: true,
    disabled: !mayDelete(),
    why: denyReason('deleteProject', myRole())
      || `삭제는 ${JOB_ROLES.deleteProject.map(roleName).join('·')}만 할 수 있습니다.`,
    on: () => askDelete(p),
  },
]

/**
 * 이 판을 지웁니다. 묻고, 지우고, 목록을 다시 그립니다.
 *
 * 무엇을 잃는지는 여기서 세지 못합니다. 홈은 에셋을 읽지 않고(services/assets.js 를
 * 부르는 것은 서랍입니다) op 로그만 들고 있습니다. 세지 못하는 것을 「에셋 0개」로
 * 적으면 거짓이 되므로, 셀 수 있는 것만 적습니다 — 이 표에 들어온 기록의 줄 수입니다.
 * 정확한 셈은 지운 뒤에 서버가 돌려줍니다.
 */
async function askDelete(p) {
  const name = p.name || p.boardId
  const logs = acts.filter((e) => e.boardId === p.boardId).length
  const ok = await confirmAsk({
    title: '이 프로젝트를 지우시겠습니까?',
    body: `「${name}」를 지웁니다. 대본·시놉시스·씬·키비주얼·콘티와 보드의 컷·댓글이 `
      + '모두 함께 사라집니다. 되돌릴 수 없습니다.',
    list: [
      `프로젝트 「${name}」`,
      ...(logs ? [`이 표에 들어온 작업 기록 ${logs}건`] : []),
      '스토리보드의 컷과 댓글 전부',
    ],
    yes: '지웁니다',
    danger: true,
  })
  if (!ok) return

  const note = byId('pjNote')
  note.textContent = `「${name}」를 지우는 중입니다.`
  try {
    const r = await removeProject(p.boardId)
    const bits = [
      r.ops ? `기록 ${r.ops.toLocaleString('ko-KR')}줄` : '',
      r.assets ? `에셋 ${r.assets}개` : '',
    ].filter(Boolean).join(' · ')
    if (r.left) {
      /*
       * 다 못 지웠습니다. 카드는 서버가 일부러 남겨 두었으므로(deleteProject.js) 다시
       * 지울 수 있습니다. 「지웠습니다」로 덮지 않는 것이 요점입니다. 목록은 그대로
       * 다시 읽습니다 — 카드가 남아 있어야 다시 누를 자리가 있습니다.
       */
      await loadProjects()
      note.textContent = `${bits ? `${bits}을 지웠지만 ` : ''}`
        + `${r.left.toLocaleString('ko-KR')}줄이 남았습니다. 한 번에 지울 수 있는 양을 넘었습니다. `
        + '카드의 「⋮」에서 다시 지워 주세요. 남은 것부터 이어서 지웁니다.'
      return
    }
    /*
     * 표에서도 그 판의 줄을 걷어냅니다. 로그를 다시 읽지 않는 이유는 방금 지운 판을
     * 읽으러 가는 셈이 되기 때문입니다. 지운 판의 기록이 「팀원들의 작업 상황」에
     * 그대로 남아 있으면 「열기」가 없는 판으로 데려갑니다.
     */
    acts = acts.filter((e) => e.boardId !== p.boardId)
    if (actBoard === p.boardId) actBoard = null
    await loadProjects()
    paintActs()
    byId('pjNote').textContent = `「${name}」를 지웠습니다.${bits ? ` ${bits}이 사라졌습니다.` : ''}`
  } catch (err) {
    console.warn('[home] 프로젝트를 지우지 못했습니다', err)
    /*
     * 권한 때문이면 「다시 시도해 주세요」를 붙이지 않습니다. 역할은 다시 눌러서 바뀌지
     * 않습니다. 메뉴에서 미리 막았는데도 여기 오는 경우가 있습니다 — 탭을 열어 둔 사이에
     * 관리자가 역할을 바꾸면 서버의 거부가 유일한 신호입니다.
     */
    note.textContent = isDenied(err)
      ? (denyReason('deleteProject', myRole()) || '프로젝트를 지울 권한이 없습니다.')
      : `「${name}」를 지우지 못했습니다. ${err.message} 다시 시도해 주세요.`
  }
}

/* ══ 팀원들의 작업 상황 ════════════════════════════ */

/*
 * 표에는 「어느 프로젝트에서 · 누가 · 무슨 일을」이 들어갑니다. 그런데 op 로그는
 * pk=BOARD#<boardId> 로 판마다 흩어져 있어서(infra/resolvers/putOp.js) 한 번 읽으면
 * 한 판의 일만 옵니다. 여러 판을 한 표에 모으려면 판마다 한 번씩 읽어야 합니다.
 *
 * 그래서 프로젝트 목록을 먼저 받고(pk='PROJECTS' 한 자리라 한 번에 옵니다) 그 판들의
 * 로그를 나란히 읽습니다. 읽는 판의 수를 FANOUT 으로 묶어 둡니다. 프로젝트가 마흔
 * 개인 팀에서 마흔 번을 읽으면 홈이 뜨는 데 몇 초가 걸립니다. 최근에 손댄 순으로
 * 앞에서부터 읽고, 자른 것이 있으면 표 밑에 몇 개를 못 읽었는지 적습니다. 조용히
 * 자르면 「이게 전부」로 읽힙니다.
 *
 * 판별 GSI 를 하나 세워 한 번에 읽는 길도 있습니다. 지금은 세우지 않았습니다. * 홈이 한 번 읽어 그리면 끝이고, 카드 열 장 남짓의 팀에서는 이 편이 훨씬 단순합니다.
 * 판이 수십 개로 늘면 그때 GSI 를 두고 이 함수만 갈아 끼우면 됩니다.
 */
const FANOUT = 12

/** 표에 그린 줄들 */
let acts = []
/** 사람 이름을 찾는 데 쓰는 원본 op. 명부(member.set)가 여기 들어 있습니다 */
let rawOps = []
/** 못 읽고 자른 판의 수 */
let dropped = 0
let mine = false
/*
 * 한 판만 보고 있으면 그 boardId. 카드의 「작업 기록 보기」가 이것을 세웁니다.
 *
 * 표를 따로 두지 않고 같은 표를 걸러 씁니다. 그래야 「이 판만」과 「내 것만」이 함께
 * 걸리고, 줄의 「열기」가 가는 곳도 한 곳에서만 정해집니다(pickHref). 판마다 표를 새로
 * 만들면 그 두 가지를 두 번 적어 두게 됩니다.
 */
let actBoard = null

/** actor id → { name }. 명부(member.set)에 있는 사람과 데모 계정을 합쳐 씁니다 */
function nameMap(list) {
  const m = new Map(DEMO_USERS.map((u) => [u.id, { name: u.name, role: u.role }]))
  for (const op of list) {
    if (op?.kind === 'member.set' && op.member?.id) m.set(op.member.id, op.member)
  }
  return m
}

/**
 * 판들의 로그를 읽어 한 표에 쓸 줄로 만듭니다.
 *
 * 판 하나가 실패해도 나머지는 그립니다. 한 판의 로그를 못 읽었다고 팀 전체의 작업
 * 상황을 안 보여줄 이유가 없습니다.
 */
async function loadActs() {
  // 예시 판도 목록에 없더라도 읽습니다. 예시를 본 사람의 첫 기록이 거기 있습니다
  const boards = [...projects.map((p) => p.boardId)]
  if (!boards.includes(DEMO_BOARD)) boards.push(DEMO_BOARD)
  const take = boards.slice(0, FANOUT)
  dropped = boards.length - take.length

  const named = new Map(projects.map((p) => [p.boardId, p.name || p.boardId]))
  named.set(DEMO_BOARD, named.get(DEMO_BOARD) || DEMO_NAME)

  const got = await Promise.all(take.map(async (boardId) => {
    const client = opsClient(boardId)
    if (!client) return { boardId, ops: [] }
    const ops = await client.fetchOps().catch((e) => {
      console.warn(`[home] ${boardId} 기록을 읽지 못했습니다`, e.message)
      return []
    })
    return { boardId, ops }
  }))

  rawOps = got.flatMap((g) => g.ops)
  const who = nameMap(rawOps)

  /*
   * 판마다 따로 줄로 옮긴 뒤 합칩니다. 한꺼번에 옮기면 어느 판의 일인지가 사라집니다. * op 자체에는 boardId 가 없습니다(pk 에만 있습니다). 덩어리로 묶는 것도 판 안에서만
   * 합니다. 다른 판의 일이 「외 3건」으로 한 줄에 뭉치면 표의 프로젝트 칸이 거짓이 됩니다.
   */
  acts = got
    .flatMap((g) => group(entries(g.ops, { who: (id) => who.get(id) || null, limit: 200 }))
      .map((e) => ({ ...e, boardId: g.boardId, pjName: named.get(g.boardId) || g.boardId })))
    .sort((a, b) => b.ts - a.ts)

  paintActs()
  paintSide()
}

function paintActs() {
  const s = configured ? session() : null
  /*
   * 두 가지를 걸러 냅니다. 어느 판인지(actBoard)와 누가 했는지(mine)입니다. 판을 먼저
   * 거르는 이유는 그것이 사람이 고른 「보고 있는 자리」이고, 「내 것만」은 그 안에서
   * 다시 좁히는 것이기 때문입니다.
   */
  const inBoard = actBoard ? acts.filter((e) => e.boardId === actBoard) : acts
  const list = (mine && s ? inBoard.filter((e) => e.actor === s.id) : inBoard).slice(0, 60)
  // 이 판의 이름. 카드가 지워졌으면 표의 줄에 적힌 것을 씁니다
  const pjName = actBoard
    ? (projects.find((p) => p.boardId === actBoard)?.name
      || inBoard[0]?.pjName || actBoard)
    : ''

  byId('actN').textContent = inBoard.length ? `${inBoard.length}건` : ''
  byId('actMine').setAttribute('aria-pressed', String(mine))
  byId('actMine').hidden = !s
  /*
   * 한 판만 보고 있다는 것과 그것을 푸는 길을 같이 세웁니다. 이 표는 원래 여러 판을
   * 모아 보는 자리라서, 걸러진 것을 말해 주지 않으면 나머지 판의 일이 사라진 것으로
   * 읽힙니다. 조용히 자르지 않는 것은 위의 dropped 와 같은 판단입니다.
   */
  const one = byId('actOnly')
  one.hidden = !actBoard
  if (actBoard) byId('actOnlyName').textContent = pjName

  paintTable(byId('act'), list, {
    caption: inBoard.length
      ? (actBoard ? `「${pjName}」에서 한 일입니다. 최근 것이 위에 옵니다.` : '최근에 한 일이 위에 옵니다.')
      : '',
    none: actBoard
      ? (mine ? `「${pjName}」에서 내가 한 것이 아직 없습니다.`
        : `「${pjName}」에는 아직 기록이 없습니다. 이 판에서 무언가를 하면 여기에 쌓입니다.`)
      : (mine ? '내가 한 것이 아직 없습니다.'
        : '아직 지나간 일이 없습니다. 「새로 생성」에서 한 단계를 열어 보십시오.'),
    onPick: (e) => { location.href = pickHref(e) },
  })

  // 기록이 하나라도 들어오면 처음 안내 판은 접힙니다
  syncWelcome()

  setHtml(byId('actNote'), acts.length
    ? '「열기」는 그 일이 있던 자리로 갑니다. 컷이면 보드에서 그 컷이 열립니다. '
      + '네 화면이 같은 기록을 보므로 여기 없는 일은 어디에도 없습니다.'
      + (dropped ? ` 프로젝트 ${dropped}개는 이 표에 넣지 않았습니다. 최근에 손댄 ${FANOUT}개까지만 읽습니다.` : '')
    : '')
}

/**
 * 한 판의 작업 기록만 펼칩니다. 카드의 「⋮ → 작업 기록 보기」가 부릅니다.
 *
 * 새로 읽지 않습니다. 이 표에 쓸 줄은 홈이 뜰 때 이미 판마다 읽어 두었고(loadActs),
 * 각 줄에 boardId 가 붙어 있습니다. 여기서 다시 읽으면 같은 것을 두 번 읽는 셈이고
 * 배포에서는 AppSync 왕복이 한 번 더 붙습니다.
 *
 * 아직 못 읽었으면(FANOUT 밖으로 밀린 판이거나 로그를 읽는 중) 그 사실을 표의 빈 줄이
 * 말합니다. 여기서 기다리게 하지 않는 이유는 사람이 고른 것이 「이 판을 보겠다」이고,
 * 그 화면은 기록이 없어도 성립하기 때문입니다.
 */
function showActsFor(boardId) {
  actBoard = boardId
  show('activity')
  paintActs()
}

/**
 * 이어서 하러 갈 곳. 어느 판의 일인지를 주소에 같이 담습니다.
 *
 * refKind 가 panel 인 줄만 보드의 그 컷으로 보냅니다. app/board.js 의 pickView 가
 * #cut= 을 읽어 그 패널이 보이는 뷰로 맞춰 줍니다. 회차나 인물처럼 패널이 아닌 ref 를
 * 그 자리에 넣으면 보드가 없는 패널을 찾다가 아무 일도 안 하고, 누른 사람은 엉뚱한
 * 화면에 도착합니다. 그런 줄은 그 단계의 첫 화면으로만 보냅니다.
 *
 * ?board= 는 늘 답니다. 빼면 그 화면이 「아직 프로젝트를 고르지 않았다」로 보고 문을
 * 다시 세웁니다(app/projects.js 의 pickProject).
 */
function pickHref(e) {
  const base = navHref(e.ref && e.refKind === 'panel' ? 'board' : e.step, e.boardId)
  return e.ref && e.refKind === 'panel' ? `${base}#cut=${encodeURIComponent(e.ref)}` : base
}

/* ══ 모델 커넥터 ═══════════════════════════════════ */

/*
 * 관리자가 API 키를 넣는 자리입니다. 넣으면 서버가 그 제공자를 한 번 찔러 보고,
 * 통과한 것만 SSM SecureString 에 담습니다. 담긴 키는 여기로 다시 내려오지 않습니다.
 * 목록에 오는 것은 「붙어 있다 / 언제 넣었다 / 어떤 모델을 쓸 수 있다」뿐입니다.
 *
 * 타이핑 중인 키를 connDraft 에 들고 있는 이유는 다시 그릴 때마다 칸이 비어 버리기
 * 때문입니다. 저장이 끝나면 바로 지웁니다.
 */
let conns = []
let connN = 0
const connDraft = {}
const connSay = {}

async function loadConns() {
  const c = amAdmin() && connectorClient()
  if (!c) return
  try {
    const got = await c.list()
    conns = got?.providers || []
    connN = conns.filter((p) => p.configured).length
  } catch (e) {
    console.warn('[home] 커넥터를 읽지 못했습니다', e.message)
    setHtml(byId('connNote'), `커넥터 목록을 읽지 못했습니다: ${esc(e.message)}`)
  }
  paintConns()
  paintSide()
}

function connRow(p) {
  const say = connSay[p.id]
  return `<div class="conn" data-p="${esc(p.id)}">
    <h2 class="sect__h">${esc(p.label)}
      <span class="sect__n">${p.configured ? '붙어 있음' : '아직 없음'}</span>
    </h2>
    <p class="view__note">${esc(p.hint)}${p.gate ? ` · ${esc(p.gate)}` : ''}</p>
    <div class="conn__row">
      <input type="password" autocomplete="off" spellcheck="false" data-key="${esc(p.id)}"
             placeholder="${p.configured ? '새 키로 갈아 끼우기' : 'API 키를 붙여 넣으세요'}"
             value="${esc(connDraft[p.id] || '')}">
      <button class="btn btn--solid" type="button" data-save="${esc(p.id)}"><span class="mono">확인하고 저장</span></button>
      ${p.configured ? `<button class="btn btn--line" type="button" data-drop="${esc(p.id)}"><span class="mono">지우기</span></button>` : ''}
    </div>
    ${p.configured && p.at ? `<p class="view__note">${esc(p.at.slice(0, 16).replace('T', ' '))} 에 넣었습니다.</p>` : ''}
    ${p.models.length
    ? `<p class="view__note">쓸 수 있는 모델: ${p.models.map((m) => esc(m.label)).join(' · ')}</p>`
    : p.configured ? '<p class="view__note">이 키로 고를 모델은 없습니다. 위에 적은 용도로만 씁니다.</p>' : ''}
    ${say ? `<p class="view__note" data-bad="${say.bad ? 1 : 0}">${esc(say.text)}</p>` : ''}
  </div>`
}

function paintConns() {
  setHtml(byId('connList'), conns.map(connRow).join(''))
  setHtml(byId('connNote'), conns.length
    ? '키를 저장하면 아티스트와 기획의 스토리보드 화면에 그 모델이 바로 뜹니다. '
      + 'GPU 를 켜 두지 않아도 커넥터 모델은 동작합니다.'
    : '')
}

byId('connList').addEventListener('input', (e) => {
  const id = e.target.dataset.key
  if (id) connDraft[id] = e.target.value
})

byId('connList').addEventListener('click', async (e) => {
  const save = e.target.closest('[data-save]')?.dataset.save
  const drop = e.target.closest('[data-drop]')?.dataset.drop
  const c = connectorClient()
  if (!c || (!save && !drop)) return

  const id = save || drop
  const busy = (on) => { for (const b of byId('connList').querySelectorAll('button')) b.disabled = on }
  busy(true)
  try {
    if (save) {
      const key = (connDraft[id] || '').trim()
      if (!key) throw new Error('키를 붙여 넣어 주세요')
      const r = await c.put({ provider: id, key })
      connDraft[id] = ''
      connSay[id] = { text: `${r.note} · 저장했습니다 (${r.tail})` }
    } else {
      if (!confirm(`${id} 키를 지웁니다. 그 모델은 목록에서 사라집니다.`)) { busy(false); return }
      await c.remove(id)
      connSay[id] = { text: '지웠습니다' }
    }
  } catch (err) {
    // 검증에 실패하면 저장되지 않았습니다. 실패한 사유를 그대로 보여줍니다
    connSay[id] = { text: err.message, bad: true }
  }
  busy(false)
  await loadConns()
})

/* ══ 사람 ══════════════════════════════════════════ */

function paintMe() {
  const s = configured ? session() : null
  const box = byId('meBox')
  if (!s) { box.hidden = true; return }
  box.hidden = false
  byId('meWho').textContent = `${s.name} · ${s.id}`
}

/* ══ 온보딩 ════════════════════════════════════════ */

/*
 * 처음 안내 판은 「새로 생성」에서, 그리고 아직 아무 기록도 없을 때만 보여줍니다.
 * 아직 시작하지 않은 사람에게 하는 말이라 프로젝트 목록이나 표 밑에 붙을 자리가
 * 아니고, 이미 일이 쌓인 팀에게는 할 말이 아닙니다.
 */
function syncWelcome() {
  byId('onbSlot').hidden = !(view === 'new' && !acts.length)
}

/*
 * 여기는 안내가 가장 짧아도 되는 자리입니다.
 *
 * 이 화면에는 이미 네 단계가 카드로 늘어서 있고, 예시로 전체를 보는 파란 단추도 그
 * 아래에 큰 글씨로 있습니다(#demoGo). 그런데도 「처음 오셨나요?」 판이 그 밑에 또 떠서
 * 같은 두 가지를 다시 말하고 있었습니다 — 네 단계 중 아무 데서나 시작하라는 말과, 아래
 * 파란 단추를 누르라는 말입니다. 바로 위에 있는 것을 가리키는 안내였습니다.
 *
 * 그래서 메뉴를 짚어 주는 길 하나만 남깁니다. 예시는 파란 단추가 이미 자기 자리에서
 * 훨씬 크게 말합니다.
 */
function paintWelcome() {
  const slot = byId('onbSlot')
  slot.textContent = ''
  slot.append(emptyHint({
    text: '처음이시면 메뉴를 한 번 짚어 드립니다.',
    exampleLabel: '메뉴 훑어보기',
    onExample: () => openCoach(),
  }))
}

/*
 * 코치마크. 홈에 가리킬 것은 왼쪽 메뉴와 지금 펼친 판입니다.
 *
 * 한 배열에 다 담고 view 로 갈라 씁니다. 판마다 배열을 따로 두지 않은 이유는, 화면에
 * 뜨는 글을 훑는 검사가 이 배열 하나를 읽기 때문입니다. 흩어 두면 어느 한 벌이 검사
 * 밖으로 빠져나가고, 빠진 줄은 아무도 모르는 채로 남습니다.
 *
 * view 가 없는 카드(첫 장)는 어느 판에서든 나옵니다. 접혀 있는 판의 앵커를 가리키면
 * coach.js 가 그 장을 조용히 건너뛰므로 사고는 나지 않지만, 사람은 「왜 아무것도 안
 * 짚나」를 봅니다. 그래서 지금 펼친 판의 카드만 골라 넘깁니다.
 */
const HOME_CARDS = [
  {
    head: '메뉴에서 하나를 고릅니다',
    body: '한 화면에 다 쌓아 두지 않고 고른 것만 펼칩니다.\n'
      + '새로 만들 때는 「새로 생성」, 우리 팀이 하던 판은 「프로젝트」,\n'
      + '누가 무엇을 하고 있는지는 「팀원들의 작업 상황 확인하기」입니다.',
    spot: ['side'],
  },
  {
    view: 'new',
    head: '순서대로 네 단계',
    body: '시놉시스에서 시작해 대본이 되고, 그림이 나오고, 마지막에 보드에 얹힙니다.\n'
      + '순서대로 가도 되고 필요한 단계만 골라도 됩니다.\n각 화면 위쪽 탭으로도 서로 오갈 수 있습니다.',
    spot: ['steps'],
  },
  {
    view: 'new',
    head: '한 번에 다 보시려면',
    body: '이 버튼이 네 단계를 이어서 짚어 줍니다. 화면을 어둡게 덮고 눌러야 하는 자리만 남깁니다.\n'
      + '예시에서는 생성 모델을 부르지 않아 기다리는 시간이 없습니다.\n'
      + '남는 것은 「예시 프로젝트」 한 판에만 들어갑니다.',
    spot: ['demo'],
    next: '시작하기', skip: '다시 보지 않기',
  },
  {
    view: 'projects',
    head: '우리 팀이 하던 것',
    body: '프로젝트마다 판이 따로 있습니다. 대본도, 씬별 그림도, 컷도 그 안에 담깁니다.\n'
      + '카드를 누르면 그 판의 보드가 열리고, 상단 탭으로 넘어가도 같은 판을 봅니다.\n'
      + '카드 오른쪽 위의 「⋮」에 열기 · 작업 기록 보기 · 프로젝트 삭제가 있습니다.\n'
      + '지우기는 감독만 됩니다. 되돌릴 자리가 없는 일이라 그렇습니다.',
    spot: ['projects'],
    next: '알겠습니다', skip: '다시 보지 않기',
  },
  {
    view: 'activity',
    head: '어느 판에서 · 누가 · 무슨 일을',
    body: '네 화면이 같은 기록을 씁니다.\n줄의 「열기」를 누르면 그 일이 있던 자리로 갑니다. 이어서 하는 곳입니다.\n'
      + '「내 것만」으로 내가 한 것만 볼 수 있습니다.',
    spot: ['actbox'],
    next: '알겠습니다', skip: '다시 보지 않기',
  },
]

const COACH_KEY = 'sb.home.coach.v2'

function openCoach() {
  const cards = HOME_CARDS.filter((c) => !c.view || c.view === view)
  coach.start({ cards, key: COACH_KEY, title: '홈' })
}

/* ══ 시작 ══════════════════════════════════════════ */

async function boot() {
  // 여기는 홈이라 누를 곳이 없습니다. 누를 수 있게 보이면 눌러 보고 아무 일도 안 일어납니다
  mountBrand('#brandMount', { home: true })
  paintSteps()
  wireDemo()
  paintDone()
  paintWelcome()

  setHtml(byId('sideFoot'), configured
    ? '메뉴를 눌러 그 자리만 펼칩니다.'
    : '로컬 모드입니다. 로그인 없이 화면만 봅니다. 실시간 협업과 그림 생성은 배포에서 동작합니다.')

  byId('meOut').onclick = () => { logout(); location.reload() }
  byId('actMine').onclick = () => { mine = !mine; paintActs() }
  byId('actOnlyX').onclick = () => { actBoard = null; paintActs() }
  // 뒤로 가기로 돌아온 메뉴를 다시 펼칩니다. 주소만 바뀌고 화면이 그대로면 안 됩니다
  window.addEventListener('popstate', () => show(viewParam() || 'new', false))

  if (!configured) {
    /*
     * 로컬 모드에는 읽을 로그가 없습니다(opsClient 가 null). 보드는 로컬에서도
     * BroadcastChannel 로 돌지만 그것은 지금 열어 둔 탭 사이의 이야기이고, 여기서
     * 보여줄 「지나간 일」이 아닙니다. 프로젝트 카드는 브라우저 저장소에서 옵니다.
     */
    await loadProjects()
    await loadActs()
    show(firstView(), false)
    return
  }

  // 이미 로그인돼 있으면 문을 띄우지 않습니다. 아니면 여기서 받습니다
  if (!session()) await showLogin(byId('gate'))
  paintMe()
  // 관리자에게만 있는 판입니다. 메뉴의 숫자(붙어 있는 커넥터 수)도 여기서 채워집니다
  await loadConns()

  /*
   * 프로젝트를 먼저 읽습니다. 어느 판의 로그를 읽어야 하는지가 그 목록에서 나옵니다.
   * 카드에 적히는 사람 이름은 로그의 명부에서 오므로 로그를 읽은 뒤에 한 번 더 그립니다.
   */
  await loadProjects()
  show(firstView(), false)
  await loadActs()
  paintProjects()

  // 처음 온 사람에게는 안내 판이 이미 떠 있습니다. 기록이 있는 사람에게만 짚어 줍니다
  if (!coach.seen(COACH_KEY) && acts.length) openCoach()
}

boot()
