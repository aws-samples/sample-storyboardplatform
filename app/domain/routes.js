/*
 * 화면들의 주소표입니다. 어느 탭이 어떤 파일로 가는지, 주소의 ?board= · ?new= · ?tab=
 * 을 어떻게 읽는지만 정합니다. 순수 데이터라서 DOM 을 만들지 않습니다. 탭 바를 그리는
 * 것은 components/nav-tabs.js 입니다.
 *
 * href 는 절대경로(/board.html)입니다. 화면들이 서로 다른 깊이에 있어도 같은 곳을
 * 가리켜야 안전합니다. 한때 키 비주얼만 자기 폴더에 따로 있어서 상대경로가 그 폴더
 * 안쪽으로 풀려 403 이 났습니다. 실제로 그랬습니다.
 *
 * 그리고 디렉터리가 아니라 파일 이름입니다. CloudFront 의 defaultRootObject 는
 * 루트 '/' 에만 적용되고 하위 디렉터리에는 적용되지 않아서, 디렉터리로 끝나는 주소는
 * 403 이 납니다. 이것도 실제로 그랬습니다.
 */

export const NAV_TABS = [
  { id: 'develop', label: '스토리 디벨롭', desc: '시놉시스 → 대본', href: '/story-graph.html' },
  { id: 'script', label: '대본화', desc: '기존 이야기 → 그래프', href: '/story-graph.html?tab=script' },
  { id: 'keyvisual', label: '키비주얼', desc: '대본 → 씬별 그림', href: '/key-visual.html' },
  /*
   * 마지막 단계입니다. 영상은 여기 안에 있습니다 — 컷의 그림을 승인하면 그 자리에 「영상으로
   * 생성」이 열립니다(pages/board.js 의 animate).
   *
   * 한때 '영상화'라는 다섯째 탭이었습니다. 그 화면은 보드의 컷을 다시 읽어 목록으로 늘어놓고
   * 만든 영상을 다시 op 로 보드에 붙였습니다 — 같은 컷을 두 화면이 각자 그리는 셈이라, 어느
   * 컷이 승인됐는지도 누가 담당인지도 그쪽에서는 보이지 않았습니다. 컷을 보고 있는 자리에서
   * 누르는 일이므로 탭을 없애고 보드 안으로 넣었습니다.
   */
  { id: 'board', label: '스토리보드', desc: '컷 · 그룹 · 콘티 · 승인 · 영상', href: '/board.html' },
  /*
   * 자산관리. 승인된 컷에서 뽑힌 인물·배경·소품과 직접 올린 그림이 모이는 곳이고, 그것들을
   * 여러 장 골라 실사 스틸을 만드는 곳입니다(pages/assets.js). 스토리보드 안에 칸으로
   * 두었던 것을 화면으로 뺐습니다 — 자산은 컷 하나의 것이 아니라 프로젝트의 것입니다.
   */
  { id: 'assets', label: '자산관리', desc: '인물 · 배경 · 소품 → 실사 스틸', href: '/assets.html' },
]

export const navTab = (id) => NAV_TABS.find((t) => t.id === id) || null

/*
 * 링크로 그릴 때 쓸 주소.
 *
 * 지금은 모든 탭에 href 가 있어 이 함수는 그것을 그대로 돌려줍니다. 모르는 id 가
 * 들어오면 홈으로 보냅니다. 이 갈래가 없으면 href 가 undefined 인 <a> 가 되어
 * 눌렀을 때 /undefined 같은 곳으로 가 404 가 납니다. 실제로 그랬습니다.
 *
 * boardId 를 주면 ?board= 로 달아 줍니다. 고른 프로젝트가 화면을 옮겨도 따라가야 하기
 * 때문입니다. net.js 는 이미 그 값을 읽고 있었는데(opsClient·awsTransport), 정작
 * 링크가 그것을 들고 가지 않아서 탭 한 번 누르면 기본 보드로 떨어졌습니다.
 *
 * 기본 보드도 생략하지 않고 답니다. 프로젝트 보드(app/projects.js)가 「주소에 board 가
 * 없으면 아직 고르지 않은 것」으로 보고 문을 세우기 때문입니다. 생략하면 기본 보드를
 * 고른 사람이 탭을 누를 때마다 그 문을 다시 만납니다.
 *
 * @param {string} id - NAV_TABS 의 id
 * @param {string} [boardId] - 고른 프로젝트. 없으면 붙이지 않습니다(=아직 고르지 않음)
 */
export function navHref(id, boardId) {
  const base = navTab(id)?.href || '/'
  if (!boardId) return base
  // '대본화' 처럼 이미 ?tab= 이 붙은 주소가 있어 & 인지 ? 인지 갈라 봅니다
  return `${base}${base.includes('?') ? '&' : '?'}board=${encodeURIComponent(boardId)}`
}

/**
 * 「새로 생성」으로 들어가는 주소. 프로젝트를 새로 하나 만들며 시작한다는 뜻입니다.
 *
 * 홈의 단계 목록이 이것을 씁니다. 그냥 navHref 로 보내면 그 화면 앞의 문이 「어느
 * 프로젝트를 여시겠습니까?」를 띄우고 이미 있는 판의 카드까지 같이 내밀었습니다. * 「새로 생성」을 누른 사람에게 기존 판을 열라고 권하는 셈이고, 그 판을 열면 이어서
 * 할 화면인데 「처음 오셨나요?」가 뜨는 자리도 생겼습니다. 그래서 새로 만드는 길과
 * 이어서 하는 길을 주소에서 갈라 둡니다(app/projects.js 의 pickProject).
 *
 * @param {string} id - NAV_TABS 의 id
 */
export function newHref(id) {
  const base = navTab(id)?.href || '/'
  return `${base}${base.includes('?') ? '&' : '?'}new=1`
}

/**
 * 「새로 생성」으로 들어온 것인지. 그때 문은 이름 칸 하나만 냅니다.
 * @param {string} [search] - location.search. 테스트에서 넣어 봅니다
 */
export function wantsNew(search = typeof location === 'undefined' ? '' : location.search) {
  return new URLSearchParams(String(search || '').replace(/^\?/, '')).get('new') === '1'
}

/**
 * 프로젝트를 고르지 않았을 때의 보드. net.js 의 opsClient·awsTransport 가 쓰는
 * 기본값과 같습니다. 두 곳이 다르면 주소에 board 가 없을 때 서로 다른 로그를 봅니다.
 */
export const DEFAULT_BOARD = 'demo'

/**
 * 프로젝트 서랍(app/project.html)으로 가는 주소.
 *
 * NAV_TABS 에 넣지 않았습니다. 그 표는 「일하는 화면」이고 탭 바를 그리는 재료입니다
 * (components/nav-tabs.js). 서랍을 거기 넣으면 모든 화면의 탭 바에 탭이 하나 더 생기는데,
 * 서랍은 작업하는 곳이 아니라 한 프로젝트를 들여다보는 곳입니다.
 *
 * boardId 가 없으면 그냥 /project.html 입니다. 서랍은 그때 기본 보드로 떨어지지 않고
 * 「어느 프로젝트인지 모른다」고 말합니다(pages/project.js 가 boardParam 을 쓰는 이유).
 *
 * @param {string} [boardId]
 */
export function drawerHref(boardId) {
  return boardId ? `/project.html?board=${encodeURIComponent(boardId)}` : '/project.html'
}

/**
 * 주소에 적힌 프로젝트. 없으면 null 입니다. 「아직 고르지 않았다」와 「기본 보드를
 * 골랐다」를 가려야 하는 자리(프로젝트 보드의 문, 탭 링크)가 이것을 씁니다.
 * @param {string} [search] - location.search. 테스트에서 넣어 봅니다
 */
export function boardParam(search = typeof location === 'undefined' ? '' : location.search) {
  return new URLSearchParams(String(search || '').replace(/^\?/, '')).get('board') || null
}

/**
 * 지금 보고 있는 프로젝트. 주소의 ?board= 이고, 없으면 설정의 기본 보드입니다.
 * 실제로 로그를 읽고 쓰는 자리가 이것을 씁니다. net.js 의 기본값과 같아야 합니다.
 * @param {string} [search] - location.search
 */
export function boardFromSearch(search = typeof location === 'undefined' ? '' : location.search) {
  const cfg = typeof window === 'undefined' ? null : window.SB_CONFIG
  return boardParam(search) || cfg?.boardId || DEFAULT_BOARD
}

/**
 * ?tab= 으로 들어온 탭 이름. 모르는 값이면 그 화면의 기본 탭으로 떨어집니다.
 * @param {string} search - location.search
 * @param {string} fallback - 기본 탭 id
 */
export function navTabFromSearch(search, fallback = 'board') {
  const want = new URLSearchParams(String(search || '').replace(/^\?/, '')).get('tab')
  return navTab(want) ? want : fallback
}

/*
 * ══ 서랍의 「열기」가 무엇을 열라고 말하는 길 (?open=<kind>)
 *
 * 서랍(pages/project.js)은 담긴 에셋을 한 줄씩 보여주고 줄마다 「열기」를 답니다. 그런데
 * 그 링크가 navHref(kind.step, board) 뿐이었습니다. 화면 이름만 있고 「무엇을」이 없어서,
 * 「관계 그래프 열기」와 「시놉시스 열기」가 똑같이 스토리 디벨롭의 첫 화면으로 갔습니다.
 * 그 화면은 자기 판이 비어 있으면 「처음 오셨나요?」를 세우므로, 방금 서랍에서 그래프가
 * 있는 것을 보고 누른 사람이 「판이 비어 있습니다」를 만났습니다.
 *
 * 그래서 열 것을 주소에 적습니다. 받는 화면은 그 값을 보고 담아 둔 에셋을 펼칩니다
 * (pages/story-graph.js 의 openAsset). ?tab= 과 따로 두는 이유는 둘이 다른 것을 말한다는
 * 것입니다 — tab 은 화면의 어느 칸을 볼지이고, open 은 어느 에셋을 실어 올지입니다.
 *
 * 모르는 값은 무시합니다. 종류를 지운 뒤에 남은 링크나 사람이 손으로 고친 주소로 화면이
 * 멈추지 않아야 합니다. 그때는 그 화면의 평소 첫 모습입니다.
 */

/**
 * 에셋 하나를 펼치며 그 화면을 여는 주소.
 *
 * @param {string} step - NAV_TABS 의 id. 그 에셋을 만드는 화면입니다(domain/assets.js 의 step)
 * @param {string} [boardId]
 * @param {string} [kind] - ASSET_KINDS 의 key. 없으면 navHref 와 같습니다
 */
export function openHref(step, boardId, kind) {
  const base = navHref(step, boardId)
  if (!kind) return base
  return `${base}${base.includes('?') ? '&' : '?'}open=${encodeURIComponent(kind)}`
}

/**
 * 주소가 펼치라고 말하는 에셋. 없거나 모르는 값이면 null 입니다.
 *
 * 종류를 아는 곳은 domain/assets.js 이고 이 파일은 그것을 import 하지 않습니다. 주소를
 * 읽는 일과 에셋의 표는 서로 모르는 편이 맞고, 무엇보다 이 파일을 읽는 화면 전부가
 * 에셋 표까지 딸려 받게 됩니다. 그래서 아는 이름의 목록을 부르는 쪽이 넘깁니다.
 *
 * @param {string} [search] - location.search
 * @param {string[]} [known] - 받아 줄 key 목록. 주지 않으면 모양만 봅니다
 */
export function openFromSearch(search = typeof location === 'undefined' ? '' : location.search, known = null) {
  const want = new URLSearchParams(String(search || '').replace(/^\?/, '')).get('open')
  if (!want) return null
  if (known) return known.includes(want) ? want : null
  // 목록을 안 주면 모양만 봅니다. 종류 key 는 모두 소문자 낱말입니다
  return /^[a-z]+$/.test(want) ? want : null
}
