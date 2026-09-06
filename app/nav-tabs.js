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
 * 나머지 탭은 링크라서 그냥 눌러 이동합니다 — 새 탭이 아니라 같은 탭입니다.
 *
 * 홈(/)이 생긴 뒤로 이 바는 얇은 모양(compact)이 기본입니다. 네 단계를 설명까지
 * 붙여 보여주는 일은 홈이 맡고, 각 화면의 이 바는 "지금 어디에 있고 어디로 갈 수
 * 있는지"만 알려주면 됩니다. 설명 줄은 title 로 옮겨 두었습니다 — 지우지 않은 이유는
 * 탭 이름만으로는 '스토리 디벨롭'과 '대본화'가 잘 구별되지 않기 때문입니다.
 */

/*
 * 탭 넷. desc 는 이름 밑에 붙는 한 줄 설명입니다.
 *
 * 네 탭 모두 갈 곳이 있습니다. 한때 '대본 번역'이 화면 없이 "준비 중" 안내만 띄우는
 * 다섯 번째 탭으로 있었는데, 없는 기능을 목록에 올려 두면 읽는 사람이 그것까지 이 앱의
 * 일부로 세게 됩니다. 그래서 탭과 안내 판을 함께 걷어냈습니다 — 단계를 다시 늘릴 때는
 * 화면이 생긴 뒤에 이 배열에 한 줄 더하면 됩니다.
 *
 * 순서는 이야기가 만들어지는 순서입니다. 시놉시스에서 시작해 대본이 되고,
 * 그림이 나오고, 마지막에 그것들이 보드에 얹힙니다. 그래서 디벨롭이 맨 앞이고
 * 스토리보드가 맨 뒤입니다 — 보드가 가장 오래된 화면이라 처음에는 맨 앞에 있었는데,
 * 만들어진 순서와 쓰는 순서가 달라 사용자가 거꾸로 읽게 됐습니다.
 *
 * href 는 모두 루트 기준 절대경로이고 파일 이름까지 적습니다. 네 화면이 한 폴더
 * (app/)에 나란히 있으므로 지금은 상대경로로도 풀립니다만, 절대경로로 두는 편이
 * 안전합니다. 한때 키 비주얼만 자기 폴더에 따로 있어서 상대경로가 그 폴더 안쪽
 * (…/story-graph.html)으로 풀려 403 이 났습니다. 실제로 그랬습니다.
 *
 * 그리고 디렉터리가 아니라 파일 이름입니다. CloudFront 의 defaultRootObject 는
 * 루트 '/' 에만 적용되고 하위 디렉터리에는 적용되지 않아서, 디렉터리로 끝나는 주소는
 * 403 이 납니다 — 이것도 실제로 그랬습니다. 로컬 개발 서버도 배포와 같게
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
 * 들어오면 홈으로 보냅니다 — 이 갈래가 없으면 href 가 undefined 인 <a> 가 되어
 * 눌렀을 때 /undefined 같은 곳으로 가 404 가 납니다. 실제로 그랬습니다.
 */
export const navHref = (id) => navTab(id)?.href || '/'

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
/* 켠 탭에서는 설명도 같이 파랑 쪽으로 당깁니다 — 두 줄이 한 덩어리로 읽힙니다 */
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
 * @returns {{ setActive: (id: string) => void, active: () => string }}
 */
export function mountNav({
  mount, active = 'develop', handled = [], onSelect = () => {},
  slim = true, home = true,
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
    if (el.tagName === 'A') el.href = navHref(t.id)
    else el.type = 'button'
    el.dataset.nav = t.id
    // 얇은 모양에서는 설명 줄이 감춰지므로 title 로도 남겨 둡니다
    el.title = `${t.label} — ${t.desc}`
    el.innerHTML = `<span class="navtab__label">${esc(t.label)}</span>
      <span class="navtab__desc">${esc(t.desc)}</span>`
    if (mine.has(t.id)) {
      el.onclick = () => { setActive(t.id); onSelect(t.id) }
    }
    els.set(t.id, el)
    nav.appendChild(el)
  }

  if (home) {
    const h = doc.createElement('a')
    h.className = 'navhome'
    h.href = '/'
    h.dataset.navHome = '1'
    h.title = '홈 — 전체 단계'
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
