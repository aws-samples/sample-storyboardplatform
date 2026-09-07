/*
 * 「S 여름 스튜디오」 한 자리. 네 화면이 같은 것을 씁니다.
 *
 * 예전에는 화면마다 자기 이름을 머리에 걸었습니다. 홈은 「여름 스튜디오」, 키 비주얼은
 * 「스토리보드 · 키 비주얼」, 스토리 그래프는 「Story Graph」 에 배지 둘(모드 · graph:)이
 * 붙었습니다. 그래서 같은 서비스인데 화면을 옮길 때마다 다른 제품처럼 보였고, 홈으로
 * 돌아가는 길도 화면마다 달랐습니다(있기도 하고 없기도 했습니다).
 *
 * 이제 머리의 왼쪽은 어디서나 이것 하나입니다. 누르면 홈입니다. 지금 어느 화면인지는
 * 바로 아래 탭 바(nav-tabs.js)가 이미 켠 탭으로 말하고 있어서, 머리에서 한 번 더 말할
 * 필요가 없었습니다.
 *
 * 스타일까지 이 파일이 들고 있습니다. 화면 넷의 테마가 조금씩 달라서(story-graph 는
 * 자기 변수를 씁니다) 색을 각 화면에 맡기면 브랜드만 화면마다 다른 색이 됩니다.
 * 공통 토큰(theme.css 의 --sb-*)을 직접 읽고, 그 파일이 없으면 뒤의 기본값으로 떨어집니다.
 */

const CSS = `
.sbbrand {
  display: inline-flex; align-items: center; gap: 8px; flex: none;
  padding: 3px 5px 3px 3px; margin-left: -3px; border: 0; border-radius: 7px;
  background: none; font: inherit; color: var(--sb-ink, #111318);
  text-decoration: none; cursor: pointer; -webkit-appearance: none;
}
.sbbrand:hover { background: var(--sb-fill, #f8f9fb); }
.sbbrand:focus-visible { outline: 2px solid var(--sb-accent, #1a56db); outline-offset: 1px; }
.sbbrand__mark {
  width: 22px; height: 22px; border-radius: 5px; flex: none;
  background: var(--sb-accent, #1a56db); color: #fff;
  display: grid; place-items: center;
  font-size: 11px; font-weight: 700; line-height: 1; letter-spacing: 0;
}
.sbbrand__name {
  font-size: 13.5px; font-weight: 600; letter-spacing: -.01em; white-space: nowrap;
}
`

let cssDone = false
function injectCss(doc) {
  if (cssDone) return
  cssDone = true
  const tag = doc.createElement('style')
  tag.textContent = CSS
  doc.head.append(tag)
}

/** 화면 머리에 걸리는 이름. 한 곳에서 고칩니다 */
export const BRAND_NAME = '여름 스튜디오'

/** 이름의 첫 글자를 딴 표식 */
export const BRAND_MARK = 'S'

/**
 * 브랜드 하나를 만듭니다. 홈에서는 링크가 아니라 글씨입니다. 이미 홈이라서 누를 곳이
 * 없는데 누를 수 있게 보이면, 눌러 보고 아무 일도 안 일어난 것으로 읽힙니다.
 *
 * @param {object} [o]
 * @param {boolean} [o.home] - 지금 화면이 홈인지. true 면 누를 수 없는 글씨가 됩니다
 * @param {Document} [o.doc] - 넣을 문서. 검사에서 갈아 끼웁니다
 * @returns {HTMLElement} <a> 또는 <span>
 */
export function brand({ home = false, doc = document } = {}) {
  injectCss(doc)
  const el = doc.createElement(home ? 'span' : 'a')
  el.className = 'sbbrand'
  if (!home) {
    el.href = '/'
    el.title = '홈으로'
  }

  const mark = doc.createElement('span')
  mark.className = 'sbbrand__mark'
  mark.textContent = BRAND_MARK
  // 표식은 이름의 첫 글자라서 읽어 주면 「에스 여름 스튜디오」가 됩니다
  mark.setAttribute('aria-hidden', 'true')

  const name = doc.createElement('span')
  name.className = 'sbbrand__name'
  name.textContent = BRAND_NAME

  el.append(mark, name)
  return el
}

/**
 * 자리에 브랜드를 걸어 줍니다. 자리가 없으면 아무 일도 하지 않습니다. 화면마다 머리의
 * 모양이 달라서, 있는 자리에만 넣고 없는 화면은 그대로 둡니다.
 *
 * @param {string|Element} at - 자리. 선택자 또는 요소
 * @param {object} [o] - brand() 에 그대로 넘깁니다
 * @returns {HTMLElement|null} 넣은 것. 자리가 없으면 null
 */
export function mountBrand(at, o = {}) {
  const doc = o.doc || document
  const host = typeof at === 'string' ? doc.querySelector(at) : at
  if (!host) return null
  const el = brand({ ...o, doc })
  host.replaceChildren(el)
  return el
}
