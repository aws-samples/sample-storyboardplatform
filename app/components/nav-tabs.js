/**
 * 상단 탭 네비게이션. 세 화면이 같은 탭 바를 나눠 씁니다.
 *
 * 스타일까지 이 파일이 들고 있습니다. 화면마다 테마가 조금씩 달라도 탭 바만은 한 벌로
 * 보여야 해서, 색을 각 화면 변수에 맡기지 않고 여기서 공통 토큰(theme.css 의 --sb-*)을
 * 직접 읽습니다. 그 파일이 없으면 뒤의 기본값으로 떨어집니다.
 *
 * 화면마다 자기가 처리하는 탭(handled)이 다릅니다.
 *   board.html       board 가 지금 화면입니다
 *   story-graph.html develop·script 가 지금 화면입니다(안쪽 탭만 갈아탑니다)
 *   key-visual.html  keyvisual 이 지금 화면입니다
 * 나머지 탭은 링크라서 그냥 눌러 이동합니다. 새 탭이 아니라 같은 탭입니다.
 *
 * 홈(/)이 생긴 뒤로 이 바는 얇은 모양(compact)이 기본입니다. 네 단계를 설명까지
 * 붙여 보여주는 일은 홈이 맡고, 각 화면의 이 바는 "지금 어디에 있고 어디로 갈 수
 * 있는지"만 알려주면 됩니다.
 *
 * 어느 탭이 어디로 가는지는 domain/routes.js 가 정합니다.
 */

import { NAV_TABS, navTab, navHref, boardParam } from '../domain/routes.js'

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

