/*
 * 온보딩 — 빈 화면 안내와 「예시 보기」 재생기.
 *
 * 두 가지를 맡습니다.
 *
 *   1) 빈 화면 안내(emptyPanel). 각 화면은 처음에 비어 있습니다. 비어 있을 때
 *      「처음 오셨나요?」와 두 갈래를 보여줍니다 — 예시를 보거나, 직접 시작하거나.
 *      비어 있지 않으면 이 판을 부르지 않고 화면이 자기 목록을 그립니다.
 *
 *   2) 예시 재생기(play). 대본과 내용을 한 번에 쏟아 넣지 않고 단계를 하나씩
 *      실행하면서 지금 무엇을 하는 중인지 아래 띠에 적습니다. 사람이 손으로 할
 *      순서를 그대로 밟기 때문에, 다 본 뒤에 직접 할 때 같은 자리를 누르게 됩니다.
 *
 * 재생 중에는 멈추거나 건너뛸 수 있습니다. 멈출 수 없는 자동 재생은 안내가 아니라
 * 방해입니다. 그리고 되돌리기가 없다는 사실을 띠에 적어 둡니다 — 예시 내용은 서버에
 * 남고 같은 보드를 보는 사람에게도 보입니다(demo/app.js 의 push 가 net.sendOp 를
 * 부릅니다). 그것을 모른 채 누르게 두지 않습니다.
 *
 * 움직임을 줄이겠다고 한 사람에게는 기다리는 시간을 짧게 잡습니다. 단계를 건너뛰지는
 * 않습니다 — 그러면 무엇이 일어났는지 볼 수 없습니다.
 */

const REDUCED = (() => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
})()

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

/* ── 재생 띠 ──────────────────────────────────── */
/* 코치마크 막(z-index 90~97)보다 위에 둔다. 재생 중에 코치마크가 뜨더라도
   멈추는 버튼에는 늘 닿을 수 있어야 한다. */
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
.onbbar__btn:hover { background: rgba(255, 255, 255, .14); }
.onbbar__btn--go { background: #fff; color: var(--sb-ink, #111318); border-color: #fff; font-weight: 600; }
.onbbar__rail {
  position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
  border-radius: 0 0 var(--sb-r-lg, 10px) var(--sb-r-lg, 10px); overflow: hidden;
  background: rgba(255, 255, 255, .16);
}
.onbbar__fill { height: 100%; width: 0; background: var(--sb-accent, #1a56db); transition: width .18s linear; }
@media (prefers-reduced-motion: reduce) { .onbbar__fill { transition: none; } }
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

/* ══ 예시 재생기 ═══════════════════════════════════ */

let live = null

/** 지금 예시가 돌고 있는지. 화면이 다시 그려질 때 띠를 덮어쓰지 않게 보는 데 쓴다 */
export const playing = () => !!live

/*
 * 기다린다. 멈춰 두면 남은 시간이 줄지 않는다.
 *
 * 재는 방식이 setTimeout(ms) 한 번이 아니라 60ms 씩 쪼갠 것인 이유는 「잠시 멈춤」
 * 때문입니다. 한 번에 걸어 두면 멈춰도 그 타이머는 그대로 흘러갑니다.
 *
 * 그만두면 바로 깨어나야 하는데, stop() 이 타이머를 지우고 나면 beat 가 다시 돌지
 * 않아 이 약속이 영구히 매달립니다 — 그래서 깨우는 손잡이(wake)를 live 에 걸어 둡니다.
 */
function tick(ms) {
  return new Promise((res) => {
    let left = REDUCED ? Math.min(ms, 360) : ms
    let last = performance.now()
    live.wake = res
    const beat = () => {
      const t = performance.now()
      if (!live || live.stopped) return res()
      if (!live.paused) left -= t - last
      last = t
      if (left <= 0) return res()
      live.timer = setTimeout(beat, 60)
    }
    live.timer = setTimeout(beat, 60)
  })
}

function paintBar() {
  if (!live) return
  const s = live.steps[live.i]
  live.n.textContent = `${live.i + 1} / ${live.steps.length}`
  live.say.textContent = ''
  live.say.append(mk('b', null, s?.say || ''))
  if (s?.sub) live.say.append(mk('small', null, s.sub))
  live.pause.textContent = live.paused ? '이어서' : '잠시 멈춤'
  live.pause.setAttribute('aria-pressed', String(live.paused))
  live.fill.style.width = `${Math.round(((live.i + 1) / live.steps.length) * 100)}%`
}

/**
 * 예시를 단계별로 재생합니다.
 *
 * 각 단계는 { say, sub?, ms?, run? } 입니다. run 은 화면을 실제로 바꾸는 함수이고
 * (동기·비동기 둘 다) say 는 지금 무엇을 하는 중인지 띠에 적는 한 줄입니다.
 *
 * @param {object} o
 * @param {Array} o.steps
 * @param {string} o.warn - 띠 왼쪽 아래에 남길 한 줄. 되돌릴 수 없다는 사실 같은 것
 * @param {() => void} o.onDone - 다 돌았거나 그만둔 뒤. 건너뛰기로 끝나도 부른다
 * @returns {{stop: () => void}|null} 이미 돌고 있으면 null
 */
export function play({ steps = [], onDone } = {}) {
  if (live) return null
  if (!steps.length) { onDone?.(); return null }
  injectCss(document)

  const bar = mk('div', 'onbbar')
  bar.setAttribute('role', 'status')
  bar.setAttribute('aria-live', 'polite')
  const n = mk('span', 'onbbar__n')
  const say = mk('div', 'onbbar__say')
  const pause = mk('button', 'onbbar__btn', '잠시 멈춤')
  pause.type = 'button'
  const skip = mk('button', 'onbbar__btn onbbar__btn--go', '예시 끝내기')
  skip.type = 'button'
  const rail = mk('div', 'onbbar__rail')
  const fill = mk('div', 'onbbar__fill')
  rail.append(fill)
  bar.append(n, say, pause, skip, rail)
  document.body.append(bar)

  live = {
    i: 0, steps, bar, n, say, pause, fill,
    paused: false, stopped: false, timer: null, wake: null, onDone,
  }
  pause.onclick = () => { live.paused = !live.paused; paintBar() }
  skip.onclick = () => stop()

  ;(async () => {
    for (let i = 0; i < steps.length; i++) {
      if (!live || live.stopped) break
      live.i = i
      paintBar()
      try {
        await steps[i].run?.()
      } catch (e) {
        console.warn('[onboard] 예시 단계에서 걸렸다', e)
      }
      if (!live || live.stopped) break
      await tick(steps[i].ms ?? 1700)
    }
    stop()
  })()

  return { stop }
}

/** 재생을 끝낸다. 끝까지 돌아도, 건너뛰어도 여기 한 곳을 지난다 */
export function stop() {
  if (!live) return
  clearTimeout(live.timer)
  live.stopped = true
  live.bar.remove()
  const { onDone, wake } = live
  live = null
  wake?.()      // 기다리던 tick 을 깨워 돌던 for 문이 빠져나가게 한다
  onDone?.()
}
