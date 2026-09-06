/*
 * 온보딩 — 빈 화면 안내와 「예시 보기」 길잡이.
 *
 * 두 가지를 맡습니다.
 *
 *   1) 빈 화면 안내(emptyPanel). 각 화면은 처음에 비어 있습니다. 비어 있을 때
 *      「처음 오셨나요?」와 두 갈래를 보여줍니다 — 예시를 보거나, 직접 시작하거나.
 *      비어 있지 않으면 이 판을 부르지 않고 화면이 자기 목록을 그립니다.
 *
 *   2) 예시 길잡이(guide). 누를 자리를 짚어 주고, 사람이 그 자리를 누르면 그 단계가
 *      실행됩니다. 눌러야 다음으로 갑니다.
 *
 * 예전에는 이것이 타이머로 알아서 넘어가는 재생기였습니다. 그 방식에는 두 가지 문제가
 * 있었습니다. 화면이 저 혼자 움직이니 사람은 읽는 속도를 자기가 정할 수 없었고, 다 본
 * 뒤에도 어디를 눌러 그렇게 되었는지는 배우지 못했습니다. 지금은 손이 직접 그 자리를
 * 지나갑니다 — 예시를 마친 사람은 이미 그 버튼을 눌러 본 사람입니다.
 *
 * 그래서 이 파일에는 타이머가 없습니다. 기다리는 시간도, 「잠시 멈춤」도 없습니다 —
 * 멈춰 있는 것이 기본이고 사람이 누를 때만 움직이므로 멈출 것이 없습니다. 움직임을
 * 줄이겠다고 한 사람에게 따로 맞출 것도 없어집니다.
 *
 * 단계가 부르는 일은 미리 받아 둔 예시 데이터(app-walkthrough/data/)로만 채웁니다.
 * 예시에서 Bedrock 이나 생성 서버를 부르지 않습니다 — 한 번에 10~30초씩 걸리는 왕복을
 * 안내 중에 끼워 넣으면 배우는 시간이 아니라 기다리는 시간이 됩니다. 실제 모델은 예시를
 * 마친 뒤 직접 누를 때 돕니다.
 *
 * 되돌리기가 없다는 사실은 말풍선에 적어 둡니다 — 예시 내용은 서버에 남고 같은 보드를
 * 보는 사람에게도 보입니다(app/board.js 의 push 가 net.sendOp 를 부릅니다). 그것을 모른
 * 채 누르게 두지 않습니다.
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

/* ── 길잡이 띠 ────────────────────────────────── */
/* 코치마크 막(z-index 90~97)보다 위에 둔다. 안내 중에 코치마크가 뜨더라도
   끝내는 버튼에는 늘 닿을 수 있어야 한다. */
.onbbar {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
  z-index: 99; display: grid; grid-template-columns: auto 1fr auto auto; gap: 12px;
  align-items: center; width: min(620px, calc(100vw - 32px));
  padding: 11px 14px; border-radius: var(--sb-r-lg, 10px);
  background: var(--sb-ink, #111318); color: #fff;
  box-shadow: 0 14px 38px rgba(15, 20, 30, .34);
  font-family: var(--sb-sans, sans-serif);
}
.onbbar__n {
  font: 500 11px/1 var(--sb-mono, monospace); color: #fff; opacity: .62;
  white-space: nowrap;
}
.onbbar__say { min-width: 0; font-size: 13px; line-height: 1.45; }
.onbbar__say b { font-weight: 600; }
.onbbar__say small { display: block; font-size: 11px; opacity: .6; margin-top: 1px; }
.onbbar__btn {
  font: inherit; font-size: 12.5px; padding: 6px 11px; border-radius: var(--sb-r, 6px);
  border: 1px solid rgba(255, 255, 255, .28); background: none; color: #fff;
  cursor: pointer; white-space: nowrap;
}
.onbbar__btn:hover:not(:disabled) { background: rgba(255, 255, 255, .14); }
.onbbar__btn:disabled { opacity: .45; cursor: default; }
.onbbar__btn--go { background: #fff; color: var(--sb-ink, #111318); border-color: #fff; font-weight: 600; }
.onbbar__rail {
  position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
  border-radius: 0 0 var(--sb-r-lg, 10px) var(--sb-r-lg, 10px); overflow: hidden;
  background: rgba(255, 255, 255, .16);
}
/* 진행 눈금이 재는 것은 시간이 아니라 몇 번째 단계인지다 — 기다림이 없어졌으므로 */
.onbbar__fill { height: 100%; width: 0; background: var(--sb-accent, #1a56db); transition: width .18s linear; }
@media (prefers-reduced-motion: reduce) { .onbbar__fill { transition: none; } }

/* ── 누를 자리 ────────────────────────────────── */
/*
 * 코치마크(.coach-lit)와 달리 막을 덮지 않는다. 여기서는 사람이 그 자리를 실제로
 * 눌러야 하므로 화면 전체를 어둡게 하지 않고 그 자리에만 테를 두른다.
 * 테는 box-shadow 로 그린다 — outline 이나 border 는 자리를 밀어 화면이 흔들린다.
 */
.onb-spot {
  position: relative; z-index: 2;
  box-shadow: 0 0 0 3px var(--sb-accent, #1a56db), 0 0 0 9px rgba(26, 86, 219, .18);
  border-radius: var(--sb-r, 6px);
  animation: onbPulse 1.6s ease-in-out infinite;
}
@keyframes onbPulse {
  50% { box-shadow: 0 0 0 3px var(--sb-accent, #1a56db), 0 0 0 14px rgba(26, 86, 219, .06); }
}
@media (prefers-reduced-motion: reduce) { .onb-spot { animation: none; } }
`

let styled = false
function injectCss(doc) {
  if (styled) return
  styled = true
  const el = doc.createElement('style')
  el.id = 'onboardCss'
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
 * 빈 화면 안내 한 판을 만듭니다. 붙이는 것은 부르는 쪽이 합니다 — 화면마다 들어갈
 * 자리가 다르고, 어떤 화면은 이걸 카드 안에 넣습니다.
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

/* ══ 예시 길잡이 ═══════════════════════════════════ */

let live = null

/** 지금 예시가 돌고 있는지. 화면이 다시 그려질 때 띠를 덮어쓰지 않게 보는 데 씁니다 */
export const guiding = () => !!live

/** 지금 몇 번째 단계인지. 0부터입니다. 돌지 않으면 -1 입니다 */
export const guideAt = () => (live ? live.i : -1)

/*
 * 선택자 하나를 찾습니다. 못 찾으면 null 입니다.
 *
 * try 로 감싸는 이유 — 아래 spotOf 가 이름을 먼저 data-coach 선택자에 끼워 봅니다.
 * 그 이름이 이미 선택자면(예: '[data-seed="0"]') `[data-coach="[data-seed="0"]"]` 이라는
 * 잘못된 선택자가 되고, querySelector 는 그때 null 을 주지 않고 던집니다. 던지면
 * showStep 에서 안내가 그 자리에 서 버립니다.
 */
function q(sel) {
  try { return document.querySelector(sel) } catch { return null }
}

/** 짚을 자리를 찾습니다. data-coach 이름이거나 CSS 선택자입니다 */
function spotOf(step) {
  if (!step?.spot) return null
  return q(`[data-coach="${step.spot}"]`) || q(step.spot)
}

function unspot() {
  live?.lit?.classList.remove('onb-spot')
  if (live) live.lit = null
}

function paintBar() {
  if (!live) return
  const s = live.steps[live.i]
  live.n.textContent = `${live.i + 1} / ${live.steps.length}`
  live.say.textContent = ''
  live.say.append(mk('b', null, s?.say || ''))
  if (s?.sub) live.say.append(mk('small', null, s.sub))
  live.go.textContent = s?.go || (live.lit ? '이 단계 실행' : '다음')
  live.go.disabled = !!live.busy
  live.fill.style.width = `${Math.round((live.i / live.steps.length) * 100)}%`
}

/**
 * 한 단계를 화면에 올립니다. 실행하지는 않습니다 — 누를 자리를 짚고 기다립니다.
 *
 * 자리를 못 찾으면 테만 없이 그대로 갑니다. 없는 자리를 짚느니 띠의 버튼으로 넘기게
 * 두는 편이 낫습니다 — 빈 곳에 테를 두르면 안내가 먼저 신뢰를 잃습니다.
 */
function showStep() {
  if (!live) return
  unspot()
  const s = live.steps[live.i]
  const el = spotOf(s)
  if (el) {
    live.lit = el
    el.classList.add('onb-spot')
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  } else if (s?.spot) {
    console.warn('[onboard] 짚을 자리를 못 찾았습니다 —', s.spot)
  }
  paintBar()
}

/**
 * 지금 단계를 실행하고 다음으로 넘깁니다. 짚은 자리를 눌러도, 띠의 버튼을 눌러도
 * 여기 한 곳을 지납니다.
 *
 * run 이 비동기인 동안 버튼을 잠급니다. 안 잠그면 두 번 눌러 같은 단계가 두 번 돕니다.
 */
async function fire() {
  if (!live || live.busy) return
  const s = live.steps[live.i]
  live.busy = true
  paintBar()
  try {
    await s?.run?.()
  } catch (e) {
    console.warn('[onboard] 예시 단계에서 걸렸습니다', e)
  }
  if (!live) return
  live.busy = false
  if (live.i >= live.steps.length - 1) { stop(); return }
  live.i += 1
  showStep()
}

/**
 * 예시를 클릭에 맞춰 안내합니다. 타이머가 없습니다 — 사람이 누를 때만 넘어갑니다.
 *
 * 각 단계는 { say, sub?, spot?, go?, run? } 입니다.
 *   say   띠에 적히는 한 줄. 지금 무엇을 하는지
 *   sub   그 아래 작은 줄
 *   spot  누를 자리. data-coach 이름이거나 CSS 선택자. 없으면 띠의 버튼으로만 넘어갑니다
 *   go    띠 버튼의 글자. 기본은 자리가 있으면 「이 단계 실행」, 없으면 「다음」
 *   run   실제로 화면을 바꾸는 함수. 동기·비동기 둘 다 됩니다
 *
 * 짚은 자리를 누르면 그 자리의 원래 동작은 막고 run 을 대신 실행합니다. 예시가 실수로
 * 진짜 모델 호출에 닿지 않게 하려는 것입니다 — 무슨 일이 일어나는지는 run 한 곳만
 * 읽으면 됩니다. 자리에 커서를 두어야 하는 단계(대본 칸 같은 것)는 run 에서 focus 를
 * 부릅니다.
 *
 * @param {object} o
 * @param {Array} o.steps
 * @param {() => void} o.onDone - 다 돌았거나 그만둔 뒤. 끝내기로 끝나도 부릅니다
 * @returns {{stop: () => void}|null} 이미 돌고 있으면 null
 */
export function guide({ steps = [], onDone } = {}) {
  if (live) return null
  if (!steps.length) { onDone?.(); return null }
  injectCss(document)

  const bar = mk('div', 'onbbar')
  bar.setAttribute('role', 'status')
  bar.setAttribute('aria-live', 'polite')
  const n = mk('span', 'onbbar__n')
  const say = mk('div', 'onbbar__say')
  const go = mk('button', 'onbbar__btn', '다음')
  go.type = 'button'
  const end = mk('button', 'onbbar__btn onbbar__btn--go', '예시 끝내기')
  end.type = 'button'
  const rail = mk('div', 'onbbar__rail')
  const fill = mk('div', 'onbbar__fill')
  rail.append(fill)
  bar.append(n, say, go, end, rail)
  document.body.append(bar)

  live = { i: 0, steps, bar, n, say, go, fill, lit: null, busy: false, onDone }
  go.onclick = () => fire()
  end.onclick = () => stop()

  /*
   * 짚은 자리의 클릭을 document 의 캡처 단계에서 받습니다. 캡처는 target 보다 먼저
   * 지나가므로 여기서 멈추면 그 자리의 원래 핸들러가 돌지 않습니다.
   * 띠 안에서 난 클릭은 이 길을 타지 않습니다 — 위의 onclick 이 따로 받습니다.
   */
  live.onClick = (e) => {
    if (!live?.lit || live.bar.contains(e.target)) return
    if (!live.lit.contains(e.target) && live.lit !== e.target) return
    e.preventDefault()
    e.stopPropagation()
    fire()
  }
  // 키보드로 짚은 자리에 닿은 사람도 같은 길을 씁니다. 띠의 버튼이 또 하나의 길입니다
  live.onKey = (e) => {
    if (!live?.lit || e.key !== 'Enter') return
    if (!live.lit.contains(e.target) && live.lit !== e.target) return
    e.preventDefault()
    e.stopPropagation()
    fire()
  }
  addEventListener('click', live.onClick, true)
  addEventListener('keydown', live.onKey, true)

  showStep()
  return { stop }
}

/** 안내를 끝냅니다. 끝까지 가도, 중간에 끝내도 여기 한 곳을 지납니다 */
export function stop() {
  if (!live) return
  unspot()
  removeEventListener('click', live.onClick, true)
  removeEventListener('keydown', live.onKey, true)
  live.bar.remove()
  const { onDone } = live
  live = null
  onDone?.()
}
