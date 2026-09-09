/*
 * 한 번 더 묻는 창입니다. 되돌리기 어려운 일 앞에 섭니다.
 *
 * ══ 무엇을 고치려고 만들었나
 *
 * 생성 버튼들이 너무 쉬웠습니다. 「스토리 생성」이나 「대본 생성」을 누르면 그 자리에서
 * 모델을 부르기 시작했습니다. 되돌릴 수 없는 것은 아니지만 30초에서 2분이 걸리고, 그
 * 사이 화면은 다른 일을 받지 않습니다. 잘못 눌러도 되는 버튼처럼 생긴 것이 실제로는
 * 기다림을 부르는 버튼이었고, 결과적으로 화면이 「진짜 도구」가 아니라 데모처럼 보였습니다.
 *
 * ══ 왜 confirm() 이 아닌가
 *
 * 브라우저의 confirm 은 한 줄밖에 못 담습니다. 그런데 사람이 한 번 더 생각할 재료는
 * 「무엇을 · 무엇으로 · 얼마나 걸려서」입니다. 「컷 34개를 시나리오 형식 대본으로
 * 옮깁니다. 1~2분 걸립니다」를 읽고 누르는 것과 「계속할까요?」에 누르는 것은 다른
 * 결정입니다. 게다가 confirm 은 창을 꾸밀 수 없어서 세 화면의 다른 톤 사이에서 혼자
 * 운영체제 모양으로 튑니다.
 *
 * ══ 모양을 이 파일이 들고 있습니다
 *
 * nav-tabs.js · history-list.js · project-picker.js 와 같은 방식입니다. 화면마다 CSS 를
 * 베껴 두면 한 곳만 고쳐도 나머지가 어긋납니다. 색은 공통 토큰(components/theme.css 의
 * --sb-*)에서 받고, 두 번째 인자는 그 파일을 못 불러왔을 때의 기본값입니다.
 *
 * ══ 이 모듈은 무엇을 하려는지 모릅니다
 *
 * 문장을 만들지 않습니다. 부르는 쪽이 넘긴 것을 그대로 세웁니다. 「대본」이라는 말이
 * 여기 있으면 다음에 다른 일에 쓸 때 그 말이 남습니다. navigator-chat.js 가 네트워크를
 * 모르는 것과 같은 판단입니다.
 */

const CSS = `
.cfm {
  padding: 0; border: 1px solid var(--sb-line, #e4e7ec); border-radius: var(--sb-r-lg, 10px);
  background: var(--sb-panel, #fff); color: var(--sb-ink, #111318);
  width: min(430px, 100%); box-shadow: var(--sb-sh-lg, 0 12px 34px -10px rgba(17,19,24,.22));
  font-family: var(--sb-sans, sans-serif);
  /*
   * 상하좌우 가운데. 이 한 줄을 여기 적어 두는 것이 중요합니다.
   *
   * 모달 dialog 를 가운데 세우는 것은 브라우저 기본 스타일의 margin:auto 입니다
   * (position:fixed · inset:0 과 짝입니다). 그런데 story-graph.html 과 key-visual.html 은
   * 맨 위에 * { margin: 0 } 을 두고 있어서 그 auto 가 0 으로 덮이고, 창이 왼쪽 위
   * 구석에 붙었습니다. 실제로 그랬습니다.
   *
   * 고치는 자리를 화면 쪽이 아니라 이 파일로 잡았습니다. 화면마다 리셋을 손보면 창을
   * 쓰는 화면이 하나 늘 때마다 같은 것을 또 겪습니다. 창의 모양은 이 파일이 들고 있으니
   * 「가운데 선다」도 여기 있어야 합니다.
   */
  margin: auto;
}
.cfm::backdrop { background: rgba(15, 20, 30, .55); }
.cfm:not([open]) { display: none; }
.cfm__in { padding: 21px; }
.cfm__h { margin: 0 0 8px; font-size: 16px; font-weight: 650; letter-spacing: -.015em; }
.cfm__p { margin: 0 0 14px; font-size: 12.5px; line-height: 1.7; color: var(--sb-ink-2, #5b6472); }
/*
 * 무엇을 하려는지 늘어놓는 자리입니다. 회색 판에 담아 본문과 갈라 둡니다. 여기 있는
 * 것이 사람이 한 번 더 생각할 재료라서, 훑을 때 눈에 먼저 들어와야 합니다.
 */
.cfm__list {
  margin: 0 0 15px; padding: 11px 13px; display: grid; gap: 5px;
  background: var(--sb-fill, #f8f9fb); border: 1px solid var(--sb-line-2, #eef0f4);
  border-radius: var(--sb-r, 6px); font-size: 12.5px; line-height: 1.5;
  color: var(--sb-ink, #111318);
}
.cfm__list b { font-weight: 600; }
.cfm__row { display: flex; gap: 8px; justify-content: flex-end; }
.cfm__no, .cfm__yes, .cfm__alt {
  padding: 9px 14px; font: inherit; font-size: 13px; cursor: pointer;
  border-radius: var(--sb-r, 6px);
}
.cfm__no, .cfm__alt {
  background: var(--sb-panel, #fff); color: var(--sb-ink-2, #5b6472);
  border: 1px solid var(--sb-line, #e4e7ec);
}
.cfm__no:hover, .cfm__alt:hover { background: var(--sb-fill, #f8f9fb); color: var(--sb-ink, #111318); }
/* 세 번째 길. 「예」와 같은 무게로 읽히면 안 되지만 「그만두기」보다는 눈에 들어와야 합니다 */
.cfm__alt { color: var(--sb-ink, #111318); font-weight: 600; margin-right: auto; }
.cfm__yes {
  font-weight: 600; background: var(--sb-accent, #1a56db);
  border: 1px solid var(--sb-accent, #1a56db); color: #fff;
}
.cfm__yes:hover { background: var(--sb-accent-ink, #1543ad); border-color: var(--sb-accent-ink, #1543ad); }
/* 되돌릴 수 없는 일. 지우기가 이것을 씁니다 */
.cfm__yes--no { background: var(--sb-no, #b42318); border-color: var(--sb-no, #b42318); }
.cfm__yes--no:hover { background: #8f1d13; border-color: #8f1d13; }
`

let styled = false
function injectCss(doc) {
  if (styled) return
  styled = true
  const el = doc.createElement('style')
  el.id = 'confirmCss'
  el.textContent = CSS
  doc.head.appendChild(el)
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * 한 번 더 묻고, 사람이 고른 것을 돌려줍니다.
 *
 * 창이 닫히는 모든 길이 false 입니다. 「그만두기」·Esc·바깥 누르기가 다 같습니다.
 * 「예」만 true 입니다. 애매한 자리를 하려는 쪽으로 해석하지 않는 것이 요점입니다.
 *
 * @param {object} o
 * @param {string} o.title - 물음. 「스토리를 생성하시겠습니까?」
 * @param {string} [o.body] - 한 문단. 왜 묻는지, 무엇이 뒤따르는지
 * @param {string[]} [o.list] - 무엇을 하려는지 늘어놓는 줄들. HTML 이 아니라 글자입니다
 * @param {string} [o.yes] - 「예」 쪽 버튼의 말. 기본은 '계속합니다'
 * @param {string} [o.no] - 「아니오」 쪽. 기본은 '그만두기'
 * @param {string} [o.alt] - 세 번째 길의 말. 주지 않으면 그 버튼을 안 만듭니다.
 *   길이 둘이 아닌 자리가 있습니다 — 「뒤에 덧붙이기 / 갈아치우기 / 그만두기」가 그렇습니다.
 *   덧붙이기만 물으면 잘못 나눈 사람은 그만두는 것 말고 할 수 있는 것이 없습니다.
 * @param {boolean} [o.danger] - 되돌릴 수 없는 일이면 참. 「예」가 붉어집니다
 * @param {Document} [o.doc]
 * @returns {Promise<boolean|'yes'|'alt'>} 「예」면 참(alt 를 준 자리에서는 'yes'),
 *   세 번째 길이면 'alt', 닫힌 모든 길은 거짓입니다. 둘 다 참이라 if 로 갈라도 됩니다
 */
export function confirmAsk({
  title, body = '', list = [], yes = '계속합니다', no = '그만두기', alt = '',
  danger = false, doc = document,
} = {}) {
  injectCss(doc)
  const dlg = doc.createElement('dialog')
  dlg.className = 'cfm'
  dlg.innerHTML = `<div class="cfm__in">
    <h2 class="cfm__h">${esc(title)}</h2>
    ${body ? `<p class="cfm__p">${esc(body)}</p>` : ''}
    ${list.length ? `<div class="cfm__list">${list.map((l) => `<div>${esc(l)}</div>`).join('')}</div>` : ''}
    <div class="cfm__row">
      ${alt ? `<button class="cfm__alt" type="button">${esc(alt)}</button>` : ''}
      <button class="cfm__no" type="button">${esc(no)}</button>
      <button class="cfm__yes${danger ? ' cfm__yes--no' : ''}" type="button">${esc(yes)}</button>
    </div>
  </div>`
  doc.body.appendChild(dlg)

  return new Promise((resolve) => {
    let answered = false
    const shut = (ok) => {
      if (answered) return
      answered = true
      // close 가 다시 이 함수를 부르므로 답을 먼저 잠가 둡니다
      try { dlg.close() } catch { /* 이미 닫힌 창 */ }
      dlg.remove()
      resolve(ok)
    }
    dlg.querySelector('.cfm__no').onclick = () => shut(false)
    dlg.querySelector('.cfm__yes').onclick = () => shut(alt ? 'yes' : true)
    if (alt) dlg.querySelector('.cfm__alt').onclick = () => shut('alt')
    // Esc. dialog 가 스스로 닫는 길이고, 그때도 「아니오」입니다
    dlg.addEventListener('close', () => shut(false))
    /*
     * 창 바깥을 누르면 닫습니다. dialog 자신이 배경까지 차지하므로 target 이 dlg 이면
     * 바깥입니다. 안쪽(.cfm__in)을 누른 것은 여기 걸리지 않습니다.
     */
    dlg.addEventListener('click', (e) => { if (e.target === dlg) shut(false) })

    if (dlg.showModal) dlg.showModal()
    else shut(true) // dialog 를 모르는 브라우저. 막지 않습니다 — 묻는 것이 본 일이 아닙니다
    // 「예」에 초점을 두지 않습니다. 엔터를 눌러 온 사람이 그대로 진행하지 않게 합니다
    dlg.querySelector('.cfm__no').focus()
  })
}
