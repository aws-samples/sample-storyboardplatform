/**
 * 상단 탭 네비게이션. 세 화면이 같은 탭 바를 나눠 씁니다.
 *
 * 스타일까지 이 파일이 들고 있습니다. 화면마다 테마가 조금씩 달라도 탭 바만은 한 벌로
 * 보여야 해서, 색을 각 화면 변수에 맡기지 않고 여기서 공통 토큰(app/theme.css 의
 * --sb-*)을 직접 읽습니다. 그 파일이 없으면 뒤의 기본값으로 떨어집니다.
 *
 * 화면마다 자기가 처리하는 탭(handled)이 다릅니다.
 *   board.html       board 가 지금 화면입니다
 *   story-graph.html develop·script 가 지금 화면입니다(안쪽 탭만 갈아탑니다)
 *   key-visual.html  keyvisual 이 지금 화면입니다
 * 나머지 탭은 링크라서 그냥 눌러 이동합니다. 새 탭이 아니라 같은 탭입니다.
 *
 * 홈(/)이 생긴 뒤로 이 바는 얇은 모양(compact)이 기본입니다. 네 단계를 설명까지
 * 붙여 보여주는 일은 홈이 맡고, 각 화면의 이 바는 "지금 어디에 있고 어디로 갈 수
 * 있는지"만 알려주면 됩니다. 설명 줄은 title 로 옮겨 두었습니다. 지우지 않은 이유는
 * 탭 이름만으로는 '스토리 디벨롭'과 '대본화'가 잘 구별되지 않기 때문입니다.
 */

/*
 * 탭 넷. desc 는 이름 밑에 붙는 한 줄 설명입니다.
 *
 * 네 탭 모두 갈 곳이 있습니다. 한때 '대본 번역'이 화면 없이 "준비 중" 안내만 띄우는
 * 다섯 번째 탭으로 있었는데, 없는 기능을 목록에 올려 두면 읽는 사람이 그것까지 이 앱의
 * 일부로 세게 됩니다. 그래서 탭과 안내 판을 함께 걷어냈습니다. 단계를 다시 늘릴 때는
 * 화면이 생긴 뒤에 이 배열에 한 줄 더하면 됩니다.
 *
 * 순서는 이야기가 만들어지는 순서입니다. 시놉시스에서 시작해 대본이 되고,
 * 그림이 나오고, 마지막에 그것들이 보드에 얹힙니다. 그래서 디벨롭이 맨 앞이고
 * 스토리보드가 맨 뒤입니다. 보드가 가장 오래된 화면이라 처음에는 맨 앞에 있었는데,
 * 만들어진 순서와 쓰는 순서가 달라 사용자가 거꾸로 읽게 됐습니다.
 *
 * href 는 모두 루트 기준 절대경로이고 파일 이름까지 적습니다. 네 화면이 한 폴더
 * (app/)에 나란히 있으므로 지금은 상대경로로도 풀립니다만, 절대경로로 두는 편이
 * 안전합니다. 한때 키 비주얼만 자기 폴더에 따로 있어서 상대경로가 그 폴더 안쪽
 * (…/story-graph.html)으로 풀려 403 이 났습니다. 실제로 그랬습니다.
 *
 * 그리고 디렉터리가 아니라 파일 이름입니다. CloudFront 의 defaultRootObject 는
 * 루트 '/' 에만 적용되고 하위 디렉터리에는 적용되지 않아서, 디렉터리로 끝나는 주소는
 * 403 이 납니다. 이것도 실제로 그랬습니다. 로컬 개발 서버도 배포와 같게
 * 403 을 돌려줍니다(infra/scripts/serve-local.mjs).
 */
export const NAV_TABS = [
  { id: 'develop', label: '스토리 디벨롭', desc: '시놉시스 → 대본', href: '/story-graph.html' },
  { id: 'script', label: '대본화', desc: '기존 이야기 → 그래프', href: '/story-graph.html?tab=script' },
  { id: 'keyvisual', label: '키비주얼', desc: '대본 → 씬별 그림', href: '/key-visual.html' },
  { id: 'board', label: '스토리보드', desc: '컷 · 그룹 · 콘티 · 승인', href: '/board.html' },
]

export const navTab = (id) => NAV_TABS.find((t) => t.id === id) || null

/*
 * 링크로 그릴 때 쓸 주소.
 *
 * 지금은 네 탭 모두 href 가 있어 이 함수는 그것을 그대로 돌려줍니다. 모르는 id 가
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

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/*
 * 색은 공통 토큰(--sb-*)에서 받는다. 두 번째 인자는 그 파일이 없을 때의 기본값이라
 * theme.css 를 못 불러도 탭 바는 읽을 수 있는 모양으로 남는다.
 */
const CSS = `
.navbar {
  display: flex; align-items: stretch; gap: 4px; flex: 0 0 auto;
  background: var(--sb-panel, #fff); border-bottom: 1px solid var(--sb-line, #e4e7ec);
  padding: 0 14px; overflow-x: auto; scrollbar-width: none;
}
.navbar::-webkit-scrollbar { height: 0; }
.navtab {
  display: block; padding: 11px 16px; margin-bottom: -1px;
  background: none; border: 0; border-bottom: 2px solid transparent;
  font: inherit; text-align: left; text-decoration: none; white-space: nowrap;
  color: var(--sb-ink-3, #767f8c); cursor: pointer;
  transition: color .14s, border-color .14s, background .14s;
}
.navtab:hover { color: var(--sb-ink, #111318); background: var(--sb-fill, #f8f9fb); }
.navtab[aria-current="page"] {
  color: var(--sb-accent, #1a56db); border-bottom-color: var(--sb-accent, #1a56db);
  background: var(--sb-accent-soft, #eef2ff);
}
.navtab__label {
  display: block; font-size: 14px; font-weight: 600; line-height: 1.35; letter-spacing: -.01em;
}
.navtab__desc { display: block; font-size: 11.5px; line-height: 1.35; color: var(--sb-ink-3, #767f8c); }
/* 켠 탭에서는 설명도 같이 파랑 쪽으로 당깁니다. 두 줄이 한 덩어리로 읽힙니다 */
.navtab[aria-current="page"] .navtab__desc { color: var(--sb-accent, #1a56db); opacity: .75; }

/*
 * 얇은 모양. 홈이 다섯 단계를 다 보여주므로 각 화면에서는 이 바가 자리를 덜 차지하는
 * 편이 낫습니다. 설명 줄을 감추고 높이를 약 46px 에서 약 34px 로 줄입니다. 두 줄짜리
 * 규칙을 그대로 두고 desc 만 감추는 방식이라, 넓은 모양이 필요해지면 이 클래스만
 * 떼면 됩니다.
 */
.navbar--slim { gap: 0; padding: 0 10px; }
.navbar--slim .navtab { padding: 8px 12px; }
.navbar--slim .navtab__label { font-size: 13px; font-weight: 500; }
.navbar--slim .navtab[aria-current="page"] .navtab__label { font-weight: 600; }
.navbar--slim .navtab__desc { display: none; }

/*
 * 홈으로 돌아가는 길. 탭이 아니라서 aria-current 를 받지 않고, 오른쪽 끝으로 밀어
 * 다섯 단계와 섞이지 않게 둡니다.
 */
.navhome {
  display: flex; align-items: center; gap: 5px; margin-left: auto; padding: 0 12px;
  color: var(--sb-ink-3, #767f8c); text-decoration: none; white-space: nowrap;
  font-size: 12.5px; border-left: 1px solid var(--sb-line, #e4e7ec);
}
.navhome:hover { color: var(--sb-accent, #1a56db); }

/*
 * 권한 관리. 홈과 같은 오른쪽 묶음입니다. perm.js 가 아니라 여기 두는 이유는, 그
 * 파일은 눌러야 불려 오는데 단추는 처음부터 보여야 하기 때문입니다.
 */
.navperm {
  display: flex; align-items: center; margin-left: auto; padding: 0 12px;
  background: none; border: 0; border-left: 1px solid var(--sb-line, #e4e7ec);
  font: inherit; font-size: 12.5px; white-space: nowrap; cursor: pointer;
  color: var(--sb-ink-3, #767f8c);
}
.navperm:hover { color: var(--sb-accent, #1a56db); }
/* 권한 단추가 오른쪽 자리를 잡았으니 뒤따르는 것들은 그 옆에 붙습니다 */
.navperm ~ .navhome, .navperm ~ .navarch { margin-left: 0; }

/*
 * 아키텍처. 오른쪽 묶음의 맨 앞이고 작게 둡니다. 일하는 단추가 아니라 설명이라서,
 * 눈에 먼저 들어오면 다섯 번째 작업 단계로 읽힙니다.
 */
.navarch {
  display: flex; align-items: center; gap: 4px; margin-left: auto; padding: 0 10px;
  background: none; border: 0; border-left: 1px solid var(--sb-line, #e4e7ec);
  font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer;
  color: var(--sb-ink-3, #767f8c); opacity: .8;
}
.navarch:hover { color: var(--sb-accent, #1a56db); opacity: 1; }
.navarch ~ .navperm, .navarch ~ .navhome { margin-left: 0; }
`

let styled = false
/** 탭 바 스타일을 한 번만 꽂습니다 */
function injectCss(doc) {
  if (styled) return
  styled = true
  const el = doc.createElement('style')
  el.id = 'navTabsCss'
  el.textContent = CSS
  doc.head.appendChild(el)
}

/**
 * 탭 바를 붙입니다.
 * @param {object} o
 * @param {HTMLElement} o.mount - 탭 바가 들어갈 자리
 * @param {string} o.active - 처음 켜 둘 탭 id
 * @param {string[]} o.handled - 이동하지 않고 이 화면에서 처리할 탭 id 들
 * @param {(id: string) => void} o.onSelect - handled 탭을 눌렀을 때
 * @param {boolean} o.slim - 얇은 모양. 홈이 단계를 다 보여주므로 기본이 true 입니다
 * @param {boolean} o.home - 오른쪽 끝에 홈으로 가는 길을 둡니다
 * @param {string} o.board - 고른 프로젝트. 다른 화면으로 가는 링크에 ?board= 로 달립니다.
 *        기본값은 주소에서 읽습니다. 화면마다 따로 챙기지 않아도 프로젝트가 따라갑니다
 * @param {boolean} o.arch - 오른쪽 끝에 「아키텍처」를 둡니다
 * @param {boolean} o.perm - 오른쪽 끝에 「권한 관리」를 둡니다
 * @param {() => void} o.onPerm - 그것을 눌렀을 때. 없으면 perm.js 의 창을 띄웁니다.
 *        보드는 자기 관리 화면 안에 같은 판을 들고 있어서 이것을 넘깁니다
 * @returns {{ setActive: (id: string) => void, active: () => string }}
 */
export function mountNav({
  mount, active = 'develop', handled = [], onSelect = () => {},
  slim = true, home = true, board = boardParam(), arch = true, perm = true, onPerm = null,
}) {
  const doc = mount.ownerDocument
  injectCss(doc)

  const mine = new Set(handled)
  let cur = active

  const nav = doc.createElement('nav')
  nav.className = slim ? 'navbar navbar--slim' : 'navbar'
  nav.setAttribute('aria-label', '기능 탭')

  const els = new Map()
  for (const t of NAV_TABS) {
    // 이 화면이 처리하는 탭은 버튼, 다른 화면으로 가는 탭은 진짜 링크로 둡니다.
    // 링크라야 가운데 클릭·주소 복사가 되고, 이동은 브라우저가 같은 탭에서 합니다.
    const el = doc.createElement(mine.has(t.id) ? 'button' : 'a')
    el.className = 'navtab'
    if (el.tagName === 'A') el.href = navHref(t.id, board)
    else el.type = 'button'
    el.dataset.nav = t.id
    // 얇은 모양에서는 설명 줄이 감춰지므로 title 로도 남겨 둡니다
    el.title = `${t.label} · ${t.desc}`
    el.innerHTML = `<span class="navtab__label">${esc(t.label)}</span>
      <span class="navtab__desc">${esc(t.desc)}</span>`
    if (mine.has(t.id)) {
      el.onclick = () => { setActive(t.id); onSelect(t.id) }
    }
    els.set(t.id, el)
    nav.appendChild(el)
  }

  /*
   * 권한 관리. 탭이 아니라 오른쪽 끝의 단추입니다.
   *
   * 감독이 어느 화면에서 일하다가도 권한을 보고 고칠 수 있어야 해서 네 화면 모두에
   * 답니다. 탭 바가 네 화면의 공통 부품이므로 여기 한 곳에 달면 넷이 함께 얻습니다.
   *
   * 역할을 보고 감추지 않습니다. 이 바는 로그인이 끝나기 전에 붙는 화면도 있어서
   * 그때 역할을 물으면 아직 없습니다. 대신 판 자체가 감독·관리자가 아니면 읽기 전용
   * 으로 열립니다. 권한이 왜 막혔는지는 막힌 사람도 봐야 하는 것이기도 합니다.
   *
   * perm.js 는 눌렀을 때 불러옵니다. 보드 밖의 세 화면은 열지 않으면 쓰지 않는
   * 파일이라 처음 그리는 길에 얹지 않습니다.
   */
  /*
   * 아키텍처. 「이게 어디서 도는 겁니까」의 답을 화면 안에 둡니다.
   *
   * 탭이 아니라 오른쪽 끝의 작은 단추입니다. 네 단계와 나란히 두면 다섯 번째 작업
   * 단계로 읽히는데, 이것은 일이 아니라 설명입니다. arch.js 도 눌렀을 때 불러옵니다.
   */
  if (arch) {
    const a = doc.createElement('button')
    a.type = 'button'
    a.className = 'navarch'
    a.dataset.navArch = '1'
    a.title = '아키텍처 · 이 데모가 무엇으로 도는지'
    a.innerHTML = '<span aria-hidden="true">⌗</span><span>아키텍처</span>'
    a.onclick = () => import('./arch.js').then((m) => m.openArch())
    nav.appendChild(a)
  }

  if (perm) {
    const p = doc.createElement('button')
    p.type = 'button'
    p.className = 'navperm'
    p.dataset.navPerm = '1'
    p.title = '권한 관리 · 역할과 사람마다 무엇을 할 수 있는지'
    p.textContent = '권한 관리'
    p.onclick = () => (onPerm
      ? onPerm()
      : import('./perm.js').then((m) => m.openPerm({ board: board || undefined })))
    nav.appendChild(p)
  }

  if (home) {
    const h = doc.createElement('a')
    h.className = 'navhome'
    h.href = '/'
    h.dataset.navHome = '1'
    h.title = '홈 · 전체 단계'
    h.innerHTML = '<span aria-hidden="true">←</span><span>홈</span>'
    nav.appendChild(h)
  }

  function setActive(id) {
    if (!navTab(id)) return
    cur = id
    for (const [tid, el] of els) {
      if (tid === id) el.setAttribute('aria-current', 'page')
      else el.removeAttribute('aria-current')
    }
  }

  mount.appendChild(nav)
  setActive(active)
  return { setActive, active: () => cur }
}
