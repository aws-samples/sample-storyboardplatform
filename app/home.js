/*
 * 홈. 네 단계를 순서대로 보여주고 고르게 합니다.
 *
 * 단계 목록을 여기서 따로 적지 않고 nav-tabs.js 의 NAV_TABS 를 그대로 씁니다. 그래야
 * 홈과 각 화면 상단의 탭 바가 어긋나지 않습니다 — 순서를 바꾸거나 단계를 늘릴 때
 * 고칠 곳이 한 곳이면 됩니다. 주소도 navHref 한 곳에서만 정합니다.
 *
 * 로그인은 각 화면과 같은 auth.js 를 씁니다. 토큰이 sessionStorage 나 localStorage 에
 * 담기고 같은 오리진의 다른 화면이 그것을 읽으므로, 여기서 한 번 통과하면 보드나
 * 키비주얼이 다시 묻지 않습니다.
 *
 * SB_CONFIG 가 없는 로컬 모드에서는 로그인 문을 띄우지 않습니다. 그 모드는 Cognito 가
 * 없는 상태로 화면만 보는 용도이고, 보드도 같은 조건에서 로그인을 건너뜁니다
 * (app/board.js 의 boot 이 configured 로 갈라지는 것과 같습니다).
 */
import { NAV_TABS, navHref } from './nav-tabs.js'
import { configured, session, logout } from './auth.js'
import { showLogin, DEMO_USERS } from './login.js'
import { setHtml } from './dom.js'
import { opsClient } from './net.js'
import { entries, group, paintList } from './history.js'
import { emptyPanel } from './onboard.js'
import * as coach from './coach.js'

const byId = (id) => document.getElementById(id)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* 단계 넷. 번호는 NAV_TABS 순서에서 나옵니다 — 별도로 적어 두면 어긋납니다 */
function paintSteps() {
  setHtml(byId('steps'), NAV_TABS.map((t, i) => {
    const n = String(i + 1).padStart(2, '0')
    return `<li class="step">
      <a class="step__go" href="${esc(navHref(t.id))}">
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

function paintMe() {
  const s = configured ? session() : null
  const box = byId('meBox')
  if (!s) { box.hidden = true; return }
  box.hidden = false
  byId('meWho').textContent = `${s.name} · ${s.id}`
}

/* ══ 지나간 일 ═════════════════════════════════════ */

/*
 * 홈이 활동 기록을 따로 쌓지 않습니다. 보드의 op 로그 한 곳을 읽습니다 — 그래서
 * 어제 다른 사람이 키비주얼에서 한 일도 여기서 보입니다. 옮기는 일은 history.js 가
 * 하고 홈은 읽어서 그리는 것만 합니다.
 *
 * 소켓을 열지 않습니다(net.js 의 opsClient). 홈은 한 번 읽어 그리면 끝이고, 실시간으로
 * 바뀌어야 할 것이 없습니다.
 */
let ops = []
let mine = false

/** actor id → { name }. 명부(member.set)에 있는 사람과 데모 계정을 합쳐 씁니다 */
function nameMap(list) {
  const m = new Map(DEMO_USERS.map((u) => [u.id, { name: u.name, role: u.role }]))
  for (const op of list) {
    if (op?.kind === 'member.set' && op.member?.id) m.set(op.member.id, op.member)
  }
  return m
}

function paintAct() {
  const box = byId('actBox')
  const s = configured ? session() : null
  const who = nameMap(ops)
  const all = entries(ops, { who: (id) => who.get(id) || null, limit: 200 })
  const list = group(mine && s ? all.filter((e) => e.actor === s.id) : all).slice(0, 25)

  // 기록이 하나도 없으면 목록 자리를 비워 두고 처음 안내만 보여줍니다
  const empty = !all.length
  box.hidden = empty
  byId('onbSlot').hidden = !empty
  if (empty) return

  byId('actN').textContent = `${all.length}건`
  byId('actMine').setAttribute('aria-pressed', String(mine))
  byId('actMine').hidden = !s
  paintList(byId('act'), list, {
    showStep: true,
    none: mine ? '내가 한 것이 아직 없습니다.' : '아직 지나간 일이 없습니다.',
    onPick: (e) => { location.href = pickHref(e) },
  })
  setHtml(byId('actNote'),
    '줄을 누르면 그 단계로 갑니다 — 컷은 보드에서 그 컷이 열립니다. '
    + '다섯 화면이 같은 기록을 보므로 여기 없는 일은 어디에도 없습니다.')
}

/**
 * 이어서 하러 갈 곳.
 *
 * refKind 가 panel 인 줄만 보드의 그 컷으로 보냅니다 — app/board.js 의 pickView 가
 * #cut= 을 읽어 그 패널이 보이는 뷰로 맞춰 줍니다. 회차나 인물처럼 패널이 아닌 ref 를
 * 그 자리에 넣으면 보드가 없는 패널을 찾다가 아무 일도 안 하고, 누른 사람은 엉뚱한
 * 화면에 도착합니다. 그런 줄은 그 단계의 첫 화면으로만 보냅니다.
 */
function pickHref(e) {
  if (e.ref && e.refKind === 'panel') return `/board.html#cut=${encodeURIComponent(e.ref)}`
  return navHref(e.step)
}

/* ══ 온보딩 ════════════════════════════════════════ */

function paintWelcome() {
  const slot = byId('onbSlot')
  slot.textContent = ''
  slot.append(emptyPanel({
    eyebrow: '처음',
    head: '처음 오셨나요?',
    lines: [
      '아직 아무 기록도 없습니다. 다섯 단계 중 어디서 시작해도 됩니다.',
      '각 화면에는 「예시 보기」가 있습니다 — 누르면 그 단계가 어떻게 돌아가는지 차례로 보여줍니다.',
      '누가 무엇을 했는지는 여기 이 자리에 쌓입니다.',
    ],
    exampleLabel: '스토리보드 예시부터 보기',
    onExample: () => { location.href = '/board.html' },
    ownLabel: '단계 훑어보기',
    onOwn: () => openCoach(),
  }))
}

/*
 * 코치마크 두 장. 홈에는 가리킬 것이 둘뿐입니다 — 단계 목록과 지나간 일입니다.
 * 기록이 없으면 두 번째 장의 앵커가 화면에 없고, coach.js 가 그 장을 조용히 건너뜁니다.
 */
const HOME_CARDS = [
  {
    head: '순서대로 다섯 단계',
    body: '시놉시스에서 시작해 대본이 되고, 그림이 나오고, 마지막에 보드에 얹힙니다.\n순서대로 가도 되고 필요한 단계만 골라도 됩니다.\n각 화면 위쪽 탭으로도 서로 오갈 수 있습니다.',
    spot: ['steps'],
  },
  {
    head: '누가 뭘 했는지 여기 모입니다',
    body: '다섯 화면이 같은 기록을 씁니다.\n줄을 누르면 그 단계의 그 자리로 갑니다 — 이어서 하는 곳입니다.\n「내 것만」으로 내가 등록한 것만 볼 수 있습니다.',
    spot: ['actbox'],
    next: '시작하기', skip: '다시 보지 않기',
  },
]

const COACH_KEY = 'sb.home.coach.v1'

function openCoach() {
  coach.start({ cards: HOME_CARDS, key: COACH_KEY, title: '홈' })
}

async function boot() {
  byId('env').textContent = configured ? '배포' : '로컬'
  paintSteps()

  byId('foot').innerHTML = configured
    ? '단계를 눌러 들어갑니다. 상단 탭으로도 서로 오갈 수 있습니다.'
    : '로컬 모드입니다 — 로그인 없이 화면만 봅니다. 실시간 협업과 그림 생성은 배포에서 동작합니다.'

  byId('meOut').onclick = () => { logout(); location.reload() }
  byId('actMine').onclick = () => { mine = !mine; paintAct() }
  paintWelcome()

  if (!configured) {
    /*
     * 로컬 모드에는 읽을 로그가 없습니다(opsClient 가 null). 보드는 로컬에서도
     * BroadcastChannel 로 돌지만 그것은 지금 열어 둔 탭 사이의 이야기이고, 여기서
     * 보여줄 「지나간 일」이 아닙니다. 그래서 처음 안내만 띄웁니다.
     */
    paintAct()
    return
  }

  // 이미 로그인돼 있으면 문을 띄우지 않습니다. 아니면 여기서 받습니다
  if (!session()) await showLogin(byId('gate'))
  paintMe()

  const client = opsClient()
  ops = await client?.fetchOps?.().catch((e) => {
    console.warn('[home] 기록을 읽지 못했다', e.message)
    return []
  }) || []
  paintAct()

  // 처음 온 사람에게는 판이 이미 떠 있습니다. 기록이 있는 사람에게만 짚어 줍니다
  if (!coach.seen(COACH_KEY) && ops.length) openCoach()
}

boot()
