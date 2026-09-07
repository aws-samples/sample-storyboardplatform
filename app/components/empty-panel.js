/*
 * 빈 화면 안내 · 「처음 오셨나요?」 판 하나.
 *
 * 각 화면은 처음에 비어 있습니다. 비어 있을 때 두 갈래를 보여줍니다. 예시를 보거나,
 * 직접 시작하거나. 비어 있지 않으면 이 판을 부르지 않고 화면이 자기 목록을 그립니다.
 *
 * 예시가 아니라 제품입니다. 「직접 시작하기」를 누른 사람도 이 판을 지나므로 예시를
 * 한 줄도 읽지 않는 사람에게도 뜹니다. 그래서 app-walkthrough 가 아니라 여기 있습니다.
 * 예시 길잡이는 app-walkthrough/guide.js 입니다. 한 파일에 같이 있었는데, 그때는
 * app-walkthrough 를 지우면 빈 화면이 안내 없이 비어 버렸습니다.
 *
 * 붙이는 것은 부르는 쪽이 합니다. 화면마다 들어갈 자리가 다르고, 어떤 화면은 이걸
 * 카드 안에 넣습니다.
 */

const CSS = `
/* ── 빈 화면 안내 ─────────────────────────────── */
.onb {
  display: grid; gap: 14px; justify-items: start; max-width: 520px;
  padding: 22px; border: 1px solid var(--sb-line, #e4e7ec);
  border-radius: var(--sb-r-lg, 10px); background: var(--sb-panel, #fff);
  font-family: var(--sb-sans, sans-serif); color: var(--sb-ink, #111318);
}
.onb__eyebrow {
  font: 500 10.5px/1 var(--sb-mono, monospace); letter-spacing: .14em;
  color: var(--sb-accent, #1a56db); text-transform: uppercase;
}
.onb__head { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -.02em; line-height: 1.35; }
.onb__lines { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; }
.onb__lines li { font-size: 13px; line-height: 1.6; color: var(--sb-ink-2, #5b6472); }
.onb__row { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
.onb__go, .onb__own {
  font: inherit; font-size: 13.5px; font-weight: 600; padding: 9px 15px;
  border-radius: var(--sb-r, 6px); border: 1px solid transparent; cursor: pointer;
}
.onb__go { background: var(--sb-accent, #1a56db); color: #fff; }
.onb__go:hover { background: var(--sb-accent-ink, #1543ad); }
.onb__own {
  background: var(--sb-panel, #fff); color: var(--sb-ink, #111318);
  border-color: var(--sb-line, #e4e7ec);
}
.onb__own:hover { background: var(--sb-fill, #f8f9fb); }
.onb__warn {
  margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--sb-ink-3, #767f8c);
}
`

let styled = false
function injectCss(doc) {
  if (styled) return
  styled = true
  const el = doc.createElement('style')
  el.id = 'emptyPanelCss'
  el.textContent = CSS
  doc.head.appendChild(el)
}

const mk = (t, c, x) => {
  const n = document.createElement(t)
  if (c) n.className = c
  if (x != null) n.textContent = x
  return n
}

/**
 * 빈 화면 안내 한 판을 만듭니다. 붙이는 것은 부르는 쪽이 합니다.
 *
 * @param {object} o
 * @param {string} o.head - 큰 줄. 기본은 「처음 오셨나요?」
 * @param {string} o.eyebrow - 위의 작은 줄. 어느 단계인지
 * @param {string[]} o.lines - 설명 줄들
 * @param {() => void} o.onExample - 「예시 보기」
 * @param {() => void} o.onOwn - 「직접 시작하기」. 없으면 그 버튼을 안 만든다
 * @param {string} o.exampleLabel
 * @param {string} o.ownLabel
 * @param {string} o.warn - 버튼 아래의 작은 주의. 예시가 서버에 남는 화면에서 쓴다
 * @returns {HTMLElement}
 */
export function emptyPanel({
  head = '처음 오셨나요?', eyebrow = '', lines = [],
  onExample, onOwn, exampleLabel = '예시 보기', ownLabel = '직접 시작하기', warn = '',
} = {}) {
  injectCss(document)
  const box = mk('div', 'onb')
  if (eyebrow) box.append(mk('div', 'onb__eyebrow', eyebrow))
  const h = mk('h2', 'onb__head', head)
  box.append(h)
  if (lines.length) {
    const ul = mk('ul', 'onb__lines')
    for (const l of lines) ul.append(mk('li', null, l))
    box.append(ul)
  }
  const row = mk('div', 'onb__row')
  if (onExample) {
    const b = mk('button', 'onb__go', exampleLabel)
    b.type = 'button'
    b.dataset.coach = 'example'
    b.onclick = () => onExample()
    row.append(b)
  }
  if (onOwn) {
    const b = mk('button', 'onb__own', ownLabel)
    b.type = 'button'
    b.onclick = () => onOwn()
    row.append(b)
  }
  if (row.childElementCount) box.append(row)
  if (warn) box.append(mk('p', 'onb__warn', warn))
  return box
}
