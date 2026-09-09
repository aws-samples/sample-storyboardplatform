/*
 * 빈 화면 안내 한 줄.
 *
 * ══ 크게 떠 있던 판을 걷어낸 이유
 *
 * 예전에는 이 파일이 「처음 오셨나요?」 라는 큰 판을 만들었습니다. 제목 한 줄, 설명 석
 * 줄, 큰 버튼 둘, 주의 한 단락이 520px 폭의 카드에 들어 있었습니다. 화면이 비어 있을
 * 때마다 떴으니 프로젝트를 새로 만들면 네 화면에서 네 번 떴습니다.
 *
 * 그 판이 화면을 가렸습니다. 스토리 디벨롭에서는 대본 입력 카드 오른쪽에 앉아 판의
 * 절반을 덮었고, 키비주얼과 보드에서는 목록이 들어올 자리를 차지했습니다. 무엇보다
 * 읽을 것이 많았습니다. 처음 온 사람에게 필요한 것은 「여기서 무엇을 하나」 한 줄과
 * 예시를 눌러 볼 자리 하나인데, 그것을 여덟 줄로 말하고 있었습니다.
 *
 * 그래서 한 줄로 줄입니다. 설명 한 마디와 작은 버튼입니다. 자세한 것은 그 화면이 이미
 * 자기 자리에서 말합니다 — 대본 카드의 hint, 보드의 빈 칸 안내, 코치마크입니다.
 *
 * 예시가 아니라 제품입니다. 예시를 한 줄도 읽지 않는 사람에게도 뜨므로
 * app-walkthrough 가 아니라 여기 있습니다. 예시 길잡이는 app-walkthrough/guide.js 입니다.
 *
 * 붙이는 것은 부르는 쪽이 합니다. 화면마다 들어갈 자리가 다릅니다.
 */

const CSS = `
/* ── 빈 화면 안내 한 줄 ───────────────────────────── */
.ehint {
  display: flex; flex-wrap: wrap; align-items: center; gap: 7px 10px;
  font-family: var(--sb-sans, sans-serif); font-size: 13px; line-height: 1.6;
  color: var(--sb-ink-3, #767f8c); text-align: left;
}
.ehint__text { margin: 0 }
.ehint__go, .ehint__own {
  font: inherit; font-size: 12.5px; font-weight: 600; padding: 5px 11px;
  border-radius: var(--sb-r, 6px); cursor: pointer; white-space: nowrap;
  border: 1px solid var(--sb-line, #e4e7ec); background: var(--sb-panel, #fff);
  color: var(--sb-ink-2, #5b6472);
}
/* 예시가 앞이라 강조를 조금 얹습니다. 그래도 테두리 버튼입니다 — 파란 판이 되면 다시 큽니다 */
.ehint__go { color: var(--sb-accent, #1a56db); border-color: var(--sb-accent-line, #c7d2fe) }
.ehint__go:hover { background: var(--sb-accent-soft, #eef2ff) }
.ehint__own:hover { background: var(--sb-fill, #f8f9fb); color: var(--sb-ink, #111318) }
/* 주의는 줄을 따로 씁니다. 버튼 옆에 붙으면 버튼을 누르기 전에 읽히지 않습니다 */
.ehint__note {
  flex-basis: 100%; margin: 0; font-size: 11px; line-height: 1.6;
  color: var(--sb-ink-3, #767f8c);
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
 * 빈 화면 안내 한 줄을 만듭니다. 붙이는 것은 부르는 쪽이 합니다.
 *
 * @param {object} o
 * @param {string} o.text - 설명 한 마디. 한 줄로 읽히는 길이로 씁니다
 * @param {() => void} o.onExample - 「예시로 보기」. 없으면 그 버튼을 안 만든다
 * @param {() => void} o.onOwn - 두 번째 버튼. 없으면 안 만든다
 * @param {string} o.exampleLabel
 * @param {string} o.ownLabel
 * @param {string} o.note - 아래에 붙는 작은 주의. 예시가 서버에 남는 화면에서 씁니다
 * @returns {HTMLElement}
 */
export function emptyHint({
  text = '', onExample, onOwn, exampleLabel = '예시로 보기', ownLabel = '', note = '',
} = {}) {
  injectCss(document)
  const box = mk('div', 'ehint')
  if (text) box.append(mk('p', 'ehint__text', text))
  if (onExample) {
    const b = mk('button', 'ehint__go', exampleLabel)
    b.type = 'button'
    /*
     * 코치마크가 이 버튼을 짚습니다. 이 표시가 빠지면 앵커를 못 찾아 그 장이 조용히
     * 건너뛰어집니다 — 눈에 보이지 않는 고장이라 검사가 이것을 봅니다.
     */
    b.dataset.coach = 'example'
    b.onclick = () => onExample()
    box.append(b)
  }
  if (onOwn && ownLabel) {
    const b = mk('button', 'ehint__own', ownLabel)
    b.type = 'button'
    b.onclick = () => onOwn()
    box.append(b)
  }
  if (note) box.append(mk('p', 'ehint__note', note))
  return box
}
