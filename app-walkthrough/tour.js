/*
 * 예시 프로젝트 · 네 단계를 잇달아 밟는 한 번의 안내.
 *
 * ══ 왜 화면마다 있던 예시를 잇는가
 *
 * 예시는 원래 화면마다 따로 있었습니다. 스토리보드에 하나, 키비주얼에 하나, 디벨롭에
 * 하나. 각 화면만 보면 맞는 구성이었는데, 처음 온 사람에게는 그것이 「이 앱은 무엇을
 * 하는가」를 알려주지 못했습니다. 대본이 그래프가 되고, 그 그래프에서 씬이 나오고,
 * 씬마다 그림이 붙고, 그 그림이 컷으로 보드에 얹히는 것이 이 앱입니다. 그런데 예시를
 * 한 화면에서만 보면 그 화면의 안쪽 순서만 배우고 화면 사이의 순서는 못 배웁니다.
 * 게다가 예시를 세 번 따로 눌러야 했고, 세 번 다 눌러 보는 사람은 거의 없습니다.
 *
 * 그래서 이 파일이 네 단계를 하나로 잇습니다. 새로 만든 것은 잇는 일뿐입니다. 각
 * 단계의 안내는 그 화면이 이미 들고 있던 것을 그대로 씁니다(각 화면의 runExample).
 * 안내를 여기로 옮겨 오지 않은 이유는, 어느 자리를 짚어야 하는지는 그 화면만 알기
 * 때문입니다. 여기로 베껴 오면 화면이 바뀔 때마다 두 곳이 어긋납니다.
 *
 * ══ 어떻게 잇는가
 *
 * 주소에 ?demo=1 을 답니다. 화면은 그것을 보고 자기 예시를 스스로 시작하고, 다 끝나면
 * demoAdvance 로 다음 화면을 엽니다. 상태를 들고 있는 곳이 주소뿐이라서,
 * localStorage 도 전역 변수도 아니라서, 중간에 새로고침을 해도 그 자리에서 이어지고,
 * 주소를 남에게 보내면 그 사람도 같은 자리를 봅니다.
 *
 * 예시가 남기는 것은 「예시 프로젝트」 한 판에만 들어갑니다(DEMO_BOARD). 예시 내용은
 * 서버에 남고 같은 보드를 보는 사람에게도 보이므로(board.js 의 push → net.sendOp),
 * 남의 프로젝트에 예시 컷이 섞이면 그것을 지우는 일이 남의 일이 됩니다.
 *
 * ══ 이 폴더는 app/ 을 import 하지 않습니다
 *
 * 그러고 싶어도 못 합니다. 배포에서 app/* 는 버킷 루트로 올라가고 이 폴더는
 * /app-walkthrough/ 로 올라갑니다. 그래서 상대 경로로 app 폴더를 거슬러 올라가면
 * 디스크에서는 맞고 배포에서는 없는 자리를 찾아 404 입니다. 저장소에서 돌던 것이
 * 배포에서만 깨지는, 가장 늦게 발견되는 종류의 고장입니다.
 *
 * 그래서 필요한 것을 화면이 넣어 줍니다(wire). 화면은 이 폴더를 import 할 수 있습니다
 * (app/pages/x.js 에서 '../../app-walkthrough/' 는 두 배치에서 같은 자리입니다).
 * 방향이 한쪽뿐이라 이 폴더를 지우면 예시만 사라지고 제품은 그대로 돕니다.
 */

/*
 * 화면이 넣어 주는 것. 제품 쪽 함수 둘입니다.
 *   navHref(id, boardId) → 그 화면의 주소      (app/components/nav-tabs.js)
 *   label(id)            → 그 화면의 이름      (app/components/nav-tabs.js 의 NAV_TABS)
 *   touch({...})         → 프로젝트 목록에 한 줄  (app/services/projects.js)
 *
 * 넣지 않고 부르면 그 자리에서 던집니다. 조용히 아무 일도 안 하는 것보다 낫습니다.
 * 예시가 안 도는 것을 예시를 만드는 사람이 바로 알아야 합니다.
 */
let host = null

/**
 * 예시가 쓸 제품 쪽 함수를 넣습니다. 각 화면이 예시를 시작하기 전에 한 번 부릅니다.
 * @param {object} o
 * @param {(id: string, boardId: string) => string} o.navHref
 * @param {(id: string) => string} o.label
 * @param {(o: object) => Promise<any>} o.touch
 */
export function wire(o) {
  host = o
}

const need = (k) => {
  if (!host?.[k]) throw new Error(`app-walkthrough/tour.js: wire({${k}}) 를 먼저 불러야 합니다`)
  return host[k]
}

const navHref = (id, boardId) => need('navHref')(id, boardId)
const touchProject = (o) => need('touch')(o)

/**
 * 예시가 사는 보드. 프로젝트 보드의 「둘러보기」가 여는 것과 같은 판입니다
 * (nav-tabs.js 의 DEFAULT_BOARD). 이름 없는 기본 판이 곧 예시 판입니다.
 */
export const DEMO_BOARD = 'demo'

/** 프로젝트 목록에 이 이름으로 뜹니다 */
export const DEMO_NAME = '예시 프로젝트'

/*
 * 밟는 순서. NAV_TABS 순서와 같습니다. 이야기가 만들어지는 순서입니다.
 *
 * 'script'(대본화)가 빠져 있습니다. 디벨롭과 같은 화면의 안쪽 탭이고, 그 화면의 예시가
 * 이미 씨앗에서 분기까지 밟은 뒤 대본화 탭을 가리키며 끝납니다. 같은 화면을 두 번
 * 열어 같은 안내를 다시 보여 줄 이유가 없습니다. 네 단계가 있다는 것은 홈의 단계
 * 목록이 말하고, 여기서는 걷는 길만 정합니다.
 */
export const DEMO_STEPS = ['develop', 'keyvisual', 'board']

/** 몇 걸음짜리인지. 말풍선과 안내 문구에 적습니다 */
export const DEMO_TOTAL = DEMO_STEPS.length

const params = (search) =>
  new URLSearchParams(String(search ?? (typeof location === 'undefined' ? '' : location.search)).replace(/^\?/, ''))

/**
 * 지금 예시 프로젝트 안내를 밟고 있는지.
 * @param {string} [search] - location.search. 테스트에서 넣어 봅니다
 */
export function demoActive(search) {
  return params(search).get('demo') === '1'
}

/**
 * 지금 몇 번째 걸음인지. 1부터입니다. 밟고 있지 않으면 0 입니다.
 * @param {string} step - NAV_TABS 의 id. 지금 화면입니다
 */
export function demoAt(step, search) {
  if (!demoActive(search)) return 0
  const i = DEMO_STEPS.indexOf(step)
  return i < 0 ? 0 : i + 1
}

/** 예시 안내의 주소 한 개. 프로젝트와 안내 표시를 함께 답니다 */
const hrefFor = (step) => {
  const base = navHref(step, DEMO_BOARD)
  return `${base}${base.includes('?') ? '&' : '?'}demo=1`
}

/**
 * 예시 안내를 시작합니다. 홈의 파란 버튼이 부릅니다.
 *
 * 목록에 카드가 뜨도록 이름을 먼저 박아 둡니다. 실패해도 그냥 갑니다. 카드가 못 붙은
 * 것이 예시를 막을 이유는 아니고, 카드는 목록에 보이는 한 줄입니다(projects.touch).
 *
 * @param {string} [actor] - 카드에 적을 사람
 */
export async function startDemo(actor) {
  await touchProject({
    boardId: DEMO_BOARD, actor, name: DEMO_NAME, what: '예시 안내를 시작했습니다',
  })
  location.href = hrefFor(DEMO_STEPS[0])
}

/**
 * 이 단계의 예시가 끝났습니다. 다음 화면을 열거나, 마지막이면 홈으로 돌아갑니다.
 *
 * 홈으로 돌아갈 때 ?demo=done 을 답니다. 홈이 그것을 보고 「다 보셨습니다」를
 * 띄웁니다. 안내가 어디서 끝났는지 사람이 알아야 하고, 마지막 화면에 그냥 남겨 두면
 * 예시가 끝난 것인지 멈춘 것인지 알 수 없습니다.
 *
 * @param {string} step - 지금 화면의 NAV_TABS id
 * @returns {boolean} 예시 안내 중이 아니었으면 false. 부르는 쪽이 원래 하던 일을 합니다
 */
export function demoAdvance(step) {
  if (!demoActive()) return false
  const i = DEMO_STEPS.indexOf(step)
  const next = i < 0 ? null : DEMO_STEPS[i + 1]
  location.href = next ? hrefFor(next) : `/?demo=done&board=${encodeURIComponent(DEMO_BOARD)}`
  return true
}

/**
 * 예시 안내를 그만두고 이 화면에 그대로 머무릅니다.
 *
 * 주소에서 demo 만 떼고 같은 자리를 다시 엽니다. 떼지 않으면 새로고침 한 번에 안내가
 * 또 시작되고, 그만둔 사람이 그만둘 수 없습니다.
 *
 * @param {string} step
 */
export function demoQuit(step) {
  if (!demoActive()) return false
  location.href = navHref(step, DEMO_BOARD)
  return true
}

/**
 * 안내 말풍선 왼쪽 위에 적을 이름. 예시 프로젝트를 밟는 중이면 몇 번째 걸음인지를
 * 앞에 답니다. 「처음 오셨나요?」 판을 예시 중에는 띄우지 않으므로(같은 것을 두 번
 * 묻지 않으려고), 몇 걸음짜리 길인지 알려 주는 자리가 말풍선뿐입니다.
 *
 * @param {string} step - NAV_TABS 의 id
 * @param {string} label - 이 화면의 이름
 */
export function demoTitle(step, label) {
  const n = demoAt(step)
  return n ? `예시 프로젝트 ${n}/${DEMO_TOTAL} · ${label}` : label
}

/** 이 단계가 몇 번째이고 다음이 무엇인지. 안내 문구에 적습니다 */
export function demoSay(step) {
  const n = demoAt(step)
  if (!n) return ''
  const next = DEMO_STEPS[n]
  const label = need('label')
  return next
    ? `예시 프로젝트 ${n}/${DEMO_TOTAL}. 이 단계를 마치면 「${label(next)}」로 넘어갑니다.`
    : `예시 프로젝트 ${n}/${DEMO_TOTAL}. 마지막 단계입니다. 마치면 홈으로 돌아갑니다.`
}
