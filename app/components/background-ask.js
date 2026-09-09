/*
 * 스토리의 공통 배경을 물어보는 창입니다.
 *
 * 물음을 만들고 답을 배경으로 엮는 규칙은 domain/story-background.js 에 있습니다.
 * 이 파일은 그 물음을 세우고 사람이 넣은 것을 돌려주기만 합니다. 무엇을 물어야 하는지도
 * 모르고 그 답을 어디에 저장하는지도 모릅니다. confirm.js 와 같은 판단입니다.
 *
 * ══ 왜 confirmAsk 로는 안 되나
 *
 * 그쪽은 「예 / 아니오」입니다. 여기는 글을 여러 칸 받아야 하고, 「저장할까요」까지 같은
 * 창에서 물어야 합니다. 창을 두 번 세우면 답을 다 넣은 사람이 창이 닫히는 것을 보고
 * 「저장이 됐나」를 한 번 의심합니다.
 *
 * ══ 답하지 않아도 됩니다
 *
 * 빈 칸을 막지 않습니다. 사람이 아직 안 정한 것을 억지로 채우게 하면 아무 말이나 넣게
 * 되고, 그 아무 말이 스무 장의 그림에 다 들어갑니다. 하나도 안 채우고 그냥 넘어가는
 * 길도 둡니다 — 그러면 배경 없이 예전처럼 돕니다.
 */

const CSS = `
.bga {
  padding: 0; border: 1px solid var(--sb-line, #e4e7ec); border-radius: var(--sb-r-lg, 10px);
  background: var(--sb-panel, #fff); color: var(--sb-ink, #111318);
  width: min(560px, 100%); box-shadow: var(--sb-sh-lg, 0 12px 34px -10px rgba(17,19,24,.22));
  font-family: var(--sb-sans, sans-serif);
  /* confirm.js 의 .cfm 과 같은 이유입니다. 화면들의 * { margin: 0 } 이 dialog 의
     기본 margin:auto 를 덮어서, 이 한 줄이 없으면 창이 왼쪽 위 구석에 붙습니다 */
  margin: auto;
  max-height: min(88vh, 720px); display: flex; flex-direction: column;
}
.bga::backdrop { background: rgba(15, 20, 30, .55); }
.bga:not([open]) { display: none; }
.bga__in { padding: 21px; overflow: auto; }
.bga__h { margin: 0 0 8px; font-size: 16px; font-weight: 650; letter-spacing: -.015em; }
.bga__p { margin: 0 0 16px; font-size: 12.5px; line-height: 1.7; color: var(--sb-ink-2, #5b6472); }
/* 모델이 만든 물음인지 우리가 준비한 물음인지 말해 둡니다. 답의 무게가 다릅니다 */
.bga__from {
  margin: -8px 0 16px; font-size: 11.5px; line-height: 1.6; color: var(--sb-ink-3, #8b93a1);
}
.bga__q { margin: 0 0 15px; }
.bga__ask { display: block; font-size: 13px; font-weight: 600; margin: 0 0 3px; }
.bga__why { display: block; font-size: 11.5px; line-height: 1.6; color: var(--sb-ink-3, #8b93a1); margin: 0 0 6px; }
.bga__q input, .bga__note textarea {
  width: 100%; box-sizing: border-box; padding: 9px 11px; font: inherit; font-size: 13px;
  color: var(--sb-ink, #111318); background: var(--sb-panel, #fff);
  border: 1px solid var(--sb-line, #e4e7ec); border-radius: var(--sb-r, 6px);
}
.bga__q input:focus, .bga__note textarea:focus {
  outline: none; border-color: var(--sb-accent, #1a56db);
  box-shadow: 0 0 0 3px rgba(26, 86, 219, .12);
}
.bga__note { margin: 0 0 16px; }
.bga__note textarea { resize: vertical; min-height: 56px; line-height: 1.6; }
/*
 * 「이 프로젝트에 저장」. 창의 다른 칸과 갈라 둡니다. 위의 것들은 이번 생성에만 쓰는
 * 답이고 이것은 다음에도 남는다는 결정이라, 무게가 다른 것을 자리로 보여줍니다.
 */
.bga__keep {
  margin: 0 0 15px; padding: 11px 13px; display: flex; gap: 9px; align-items: flex-start;
  background: var(--sb-fill, #f8f9fb); border: 1px solid var(--sb-line-2, #eef0f4);
  border-radius: var(--sb-r, 6px);
}
.bga__keep input { margin: 2px 0 0; flex: none; }
.bga__keep span { font-size: 12.5px; line-height: 1.6; }
.bga__keep b { display: block; font-weight: 600; margin-bottom: 2px; }
.bga__keep em { font-style: normal; color: var(--sb-ink-3, #8b93a1); }
.bga__row { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
.bga__skip { margin-right: auto; }
.bga__no, .bga__yes, .bga__skip {
  padding: 9px 14px; font: inherit; font-size: 13px; cursor: pointer;
  border-radius: var(--sb-r, 6px);
}
.bga__no, .bga__skip {
  background: var(--sb-panel, #fff); color: var(--sb-ink-2, #5b6472);
  border: 1px solid var(--sb-line, #e4e7ec);
}
.bga__skip { border-color: transparent; padding-left: 0; }
.bga__no:hover, .bga__skip:hover { color: var(--sb-ink, #111318); }
.bga__yes {
  font-weight: 600; background: var(--sb-accent, #1a56db);
  border: 1px solid var(--sb-accent, #1a56db); color: #fff;
}
.bga__yes:hover { background: var(--sb-accent-ink, #1543ad); border-color: var(--sb-accent-ink, #1543ad); }
`

let styled = false
function injectCss(doc) {
  if (styled) return
  styled = true
  const el = doc.createElement('style')
  el.id = 'backgroundAskCss'
  el.textContent = CSS
  doc.head.appendChild(el)
}

/**
 * 배경을 묻고, 사람이 넣은 것을 돌려줍니다.
 *
 * 세 가지로 끝납니다.
 *   { questions, keep }  답을 받았습니다. keep 이 참이면 프로젝트에 저장하라는 뜻입니다
 *   { skipped: true }    배경 없이 그냥 진행하겠다고 했습니다
 *   null                 그만뒀습니다(그만두기 · Esc · 바깥 누르기)
 *
 * 「그만두기」와 「배경 없이 진행」을 가르는 것이 요점입니다. 앞은 생성 자체를 멈추라는
 * 뜻이고 뒤는 생성은 하되 배경만 빼라는 뜻입니다. 창이 닫히는 애매한 길은 모두 「그만두기」
 * 입니다 — 애매한 자리를 하려는 쪽으로 해석하지 않습니다(confirm.js 와 같은 규칙).
 *
 * @param {object} o
 * @param {Array} o.questions - domain/story-background.js 가 준 물음들
 * @param {boolean} [o.byAi] - 모델이 만든 물음인가. 창이 그렇다고 말해 줍니다
 * @param {string} [o.note] - 덧붙임 칸의 처음 값. 고칠 때 씁니다
 * @param {boolean} [o.keep] - 「저장」의 처음 상태. 이미 저장된 것을 고칠 때는 참입니다
 * @param {boolean} [o.canKeep] - 저장할 권한이 있나. 없으면 그 칸을 세우지 않습니다
 * @param {string} [o.yes] - 「예」 쪽 버튼의 말
 * @param {boolean} [o.canSkip] - 「배경 없이 진행」 길을 둘까. 고칠 때는 없습니다
 * @param {Document} [o.doc]
 * @returns {Promise<{questions: Array, keep: boolean}|{skipped: true}|null>}
 */
export function askBackground({
  questions = [], byAi = false, note = '', keep = true, canKeep = true,
  yes = '이 배경으로 생성합니다', canSkip = true, doc = document,
} = {}) {
  injectCss(doc)
  const qs = questions.map((q) => ({ ...q }))

  const dlg = doc.createElement('dialog')
  dlg.className = 'bga'

  const box = doc.createElement('div')
  box.className = 'bga__in'

  const h = doc.createElement('h2')
  h.className = 'bga__h'
  h.textContent = '이 이야기의 배경을 알려주세요'
  box.appendChild(h)

  const p = doc.createElement('p')
  p.className = 'bga__p'
  p.textContent = '그림은 한 장씩 따로 그려져서, 대본에 없는 것은 씬마다 다르게 나옵니다. '
    + '여기 답하신 것이 모든 씬의 프롬프트에 똑같이 들어갑니다. 빈 칸은 그냥 두셔도 됩니다.'
  box.appendChild(p)

  const from = doc.createElement('p')
  from.className = 'bga__from'
  from.textContent = byAi
    ? '이 물음들은 방금 대본을 읽고 만든 것입니다.'
    : '대본을 읽을 문장 모델이 없어서, 어느 대본에나 필요한 것만 물어봅니다.'
  box.appendChild(from)

  // 물음 칸들. 값은 각 물음 객체의 answer 에 바로 씁니다
  for (const q of qs) {
    const wrap = doc.createElement('label')
    wrap.className = 'bga__q'
    const ask = doc.createElement('b')
    ask.className = 'bga__ask'
    ask.textContent = q.ask
    wrap.appendChild(ask)
    if (q.why) {
      const why = doc.createElement('span')
      why.className = 'bga__why'
      why.textContent = q.why
      wrap.appendChild(why)
    }
    const inp = doc.createElement('input')
    inp.type = 'text'
    inp.value = q.answer || ''
    inp.placeholder = q.hint || ''
    inp.maxLength = 120
    inp.oninput = () => { q.answer = inp.value }
    wrap.appendChild(inp)
    box.appendChild(wrap)
  }

  const nWrap = doc.createElement('label')
  nWrap.className = 'bga__note'
  const nAsk = doc.createElement('b')
  nAsk.className = 'bga__ask'
  nAsk.textContent = '더 넣을 것이 있으면 적어주세요'
  nWrap.appendChild(nAsk)
  const nWhy = doc.createElement('span')
  nWhy.className = 'bga__why'
  nWhy.textContent = '위의 물음에 없던 것을 여기 적습니다. 이 줄도 모든 씬에 함께 들어갑니다.'
  nWrap.appendChild(nWhy)
  const nIn = doc.createElement('textarea')
  nIn.value = note
  nIn.rows = 2
  nIn.maxLength = 240
  nIn.placeholder = '소녀는 늘 노란 우비를 입고 있습니다'
  nWrap.appendChild(nIn)
  box.appendChild(nWrap)

  /*
   * 저장할지 묻는 칸. 권한이 없으면 아예 세우지 않습니다.
   *
   * 세워 두고 눌러도 안 되게 하면 「눌렀는데 저장이 안 됐다」가 됩니다. 못 하는 일을
   * 보여주지 않고, 대신 왜 없는지를 한 줄로 적어 둡니다. 이 화면의 다른 자리들이 권한을
   * 다루는 방식과 같습니다(pages/key-visual.js 의 noteKeepDenied).
   */
  let keepBox = null
  if (canKeep) {
    const kWrap = doc.createElement('label')
    kWrap.className = 'bga__keep'
    keepBox = doc.createElement('input')
    keepBox.type = 'checkbox'
    keepBox.checked = keep
    kWrap.appendChild(keepBox)
    const kTxt = doc.createElement('span')
    const kB = doc.createElement('b')
    kB.textContent = '이 프로젝트에 저장합니다'
    kTxt.appendChild(kB)
    const kEm = doc.createElement('em')
    kEm.textContent = '다음에 이 프로젝트를 열 때도 그대로 있습니다. '
      + '프로젝트 서랍의 「공통 배경」에서 언제든 고치거나 지울 수 있습니다.'
    kTxt.appendChild(kEm)
    kWrap.appendChild(kTxt)
    box.appendChild(kWrap)
  }

  const row = doc.createElement('div')
  row.className = 'bga__row'
  let skipBtn = null
  if (canSkip) {
    skipBtn = doc.createElement('button')
    skipBtn.type = 'button'
    skipBtn.className = 'bga__skip'
    skipBtn.textContent = '배경 없이 진행'
    row.appendChild(skipBtn)
  }
  const noBtn = doc.createElement('button')
  noBtn.type = 'button'
  noBtn.className = 'bga__no'
  noBtn.textContent = '그만두기'
  row.appendChild(noBtn)
  const yesBtn = doc.createElement('button')
  yesBtn.type = 'button'
  yesBtn.className = 'bga__yes'
  yesBtn.textContent = yes
  row.appendChild(yesBtn)
  box.appendChild(row)

  dlg.appendChild(box)
  doc.body.appendChild(dlg)

  return new Promise((resolve) => {
    let answered = false
    const shut = (out) => {
      if (answered) return
      answered = true
      // close 가 다시 이 함수를 부르므로 답을 먼저 잠가 둡니다
      try { dlg.close() } catch { /* 이미 닫힌 창 */ }
      dlg.remove()
      resolve(out)
    }
    // 답은 칸의 oninput 이 이미 q.answer 에 넣어 두었습니다
    yesBtn.onclick = () => shut({ questions: qs, note: nIn.value, keep: !!keepBox?.checked })
    if (skipBtn) skipBtn.onclick = () => shut({ skipped: true })
    noBtn.onclick = () => shut(null)
    dlg.addEventListener('close', () => shut(null))
    dlg.addEventListener('click', (e) => { if (e.target === dlg) shut(null) })

    if (dlg.showModal) dlg.showModal()
    // dialog 를 모르는 브라우저. 막지 않습니다 — 묻는 것이 본 일이 아닙니다
    else shut({ skipped: true })
    // 첫 칸에 초점을 둡니다. 답하러 열린 창이라 바로 쓸 수 있어야 합니다
    const first = box.querySelector('input[type="text"]')
    if (first) first.focus()
    else noBtn.focus()
  })
}
