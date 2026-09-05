/**
 * 상단 탭 네비게이션. 세 화면이 같은 탭 바를 나눠 쓴다.
 *
 * 스타일까지 이 파일이 들고 있다. 화면마다 테마가 조금씩 달라도 탭 바만은 한 벌로
 * 보여야 해서, 색을 각 화면 변수에 맡기지 않고 여기서 공통 토큰(demo/theme.css 의
 * --sb-*)을 직접 읽는다. 그 파일이 없으면 뒤의 기본값으로 떨어진다.
 *
 * 화면마다 자기가 처리하는 탭(handled)이 다르다.
 *   index.html       board 는 지금 화면, translate 는 준비 중 안내
 *   story-graph.html develop·script 는 지금 화면(안쪽 탭만 갈아탄다), translate 는 안내
 *   key-visual/      keyvisual 이 지금 화면, translate 는 링크로 보드에 맡긴다
 * 나머지 탭은 링크라서 그냥 눌러 이동한다 — 새 탭이 아니라 같은 탭이다.
 */

/*
 * 탭 다섯. desc 는 이름 밑에 붙는 한 줄 설명이다.
 *
 * href 가 있으면 갈 곳이 있는 탭, soon 이면 아직 화면이 없어 "준비 중" 안내만 뜨는 탭이다.
 *
 * 키비주얼의 href 가 다른 것들과 모양이 다른 이유 — 나머지는 같은 폴더의 형제 파일이라
 * './' 로 집지만, 키 비주얼은 배포에서 /key-visual/ 이라는 다른 폴더에 올라간다
 * (infra/lib/storyboard-stack.js 의 WebKeyVisual). 그리고 이 탭 바는 버킷 루트의
 * /index.html 과 /demo/index.html 두 곳에서 다 그려지므로, 상대경로로 쓰면 후자에서
 * /demo/key-visual/ 을 찾아 404 가 된다. 그래서 루트 기준 절대경로로 둔다.
 */
export const NAV_TABS = [
  { id: 'board', label: '스토리보드', desc: '컷 · 그룹 · 콘티 · 승인', href: './index.html' },
  { id: 'develop', label: '스토리 디벨롭', desc: '시놉시스 → 대본', href: './story-graph.html' },
  { id: 'script', label: '대본화', desc: '기존 이야기 → 그래프', href: './story-graph.html?tab=script' },
  { id: 'translate', label: '대본 번역', desc: '원본 유지 번역', soon: true },
  { id: 'keyvisual', label: '키비주얼', desc: '대본 → 씬별 그림', href: '/key-visual/' },
]

export const navTab = (id) => NAV_TABS.find((t) => t.id === id) || null

/*
 * 링크로 그릴 때 쓸 주소.
 *
 * href 가 없는 탭(아직 화면이 없는 것)도 어딘가는 가리켜야 한다. 그 화면을 직접
 * 처리하지 않는 곳에서는 보드로 보내고, 보드가 ?tab= 을 읽어 "준비 중" 안내를 띄운다
 * (demo/app.js 의 openNav). 이 갈래가 없으면 href 가 undefined 인 <a> 가 되어
 * 눌렀을 때 /key-visual/undefined 같은 곳으로 가 404 가 난다.
 *
 * 보드 주소를 루트 기준으로 두는 이유는 키비주얼 href 와 같다 — 이 바가 여러 깊이에서
 * 그려지므로 상대경로면 /demo/ 나 /key-visual/ 안을 뒤진다.
 */
export const navHref = (id) => navTab(id)?.href || `/index.html?tab=${encodeURIComponent(id)}`

/** 아직 화면이 없는 탭. 누르면 "준비 중입니다" 안내를 보여준다 */
export const isSoonTab = (id) => !!navTab(id)?.soon

/**
 * ?tab= 으로 들어온 탭 이름. 모르는 값이면 그 화면의 기본 탭으로 떨어진다.
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
/* 켠 탭에서는 설명도 같이 파랑 쪽으로 당긴다 — 두 줄이 한 덩어리로 읽힌다 */
.navtab[aria-current="page"] .navtab__desc { color: var(--sb-accent, #1a56db); opacity: .75; }

.soonpage[hidden] { display: none !important; }
.soonpage {
  flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px;
  padding: 48px 24px; background: var(--sb-fill, #f8f9fb); text-align: center;
}
.soonpage__eyebrow {
  font-size: 11.5px; letter-spacing: .14em; color: var(--sb-ink-3, #767f8c); text-transform: uppercase;
}
.soonpage__title {
  font-size: 28px; font-weight: 700; letter-spacing: -.02em; color: var(--sb-ink-2, #5b6472);
}
.soonpage__sub { font-size: 13.5px; color: var(--sb-ink-3, #767f8c); }
`

let styled = false
/** 탭 바 스타일을 한 번만 꽂는다 */
function injectCss(doc) {
  if (styled) return
  styled = true
  const el = doc.createElement('style')
  el.id = 'navTabsCss'
  el.textContent = CSS
  doc.head.appendChild(el)
}

/**
 * "준비 중입니다" 안내 한 판. 두 화면이 같은 문구를 쓴다.
 * @param {string} id - 눌린 탭 id
 */
export function soonMarkup(id) {
  const t = navTab(id)
  return `<div class="soonpage__eyebrow">${esc(t ? t.label : '')}</div>
    <div class="soonpage__title">준비 중입니다</div>
    <div class="soonpage__sub">이 기능은 곧 추가됩니다</div>`
}

/**
 * 탭 바를 붙인다.
 * @param {object} o
 * @param {HTMLElement} o.mount - 탭 바가 들어갈 자리
 * @param {string} o.active - 처음 켜 둘 탭 id
 * @param {string[]} o.handled - 이동하지 않고 이 화면에서 처리할 탭 id 들
 * @param {(id: string) => void} o.onSelect - handled 탭을 눌렀을 때
 * @returns {{ setActive: (id: string) => void, active: () => string }}
 */
export function mountNav({ mount, active = 'board', handled = [], onSelect = () => {} }) {
  const doc = mount.ownerDocument
  injectCss(doc)

  const mine = new Set(handled)
  let cur = active

  const nav = doc.createElement('nav')
  nav.className = 'navbar'
  nav.setAttribute('aria-label', '기능 탭')

  const els = new Map()
  for (const t of NAV_TABS) {
    // 이 화면이 처리하는 탭은 버튼, 다른 화면으로 가는 탭은 진짜 링크로 둔다.
    // 링크라야 가운데 클릭·주소 복사가 되고, 이동은 브라우저가 같은 탭에서 한다.
    const el = doc.createElement(mine.has(t.id) ? 'button' : 'a')
    el.className = 'navtab'
    if (el.tagName === 'A') el.href = navHref(t.id)
    else el.type = 'button'
    el.dataset.nav = t.id
    el.innerHTML = `<span class="navtab__label">${esc(t.label)}</span>
      <span class="navtab__desc">${esc(t.desc)}</span>`
    if (mine.has(t.id)) {
      el.onclick = () => { setActive(t.id); onSelect(t.id) }
    }
    els.set(t.id, el)
    nav.appendChild(el)
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
