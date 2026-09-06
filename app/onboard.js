/*
 * 온보딩 — 빈 화면 안내와 예시 길잡이.
 *
 * 두 가지를 맡습니다.
 *
 *   1) 빈 화면 안내(emptyPanel). 각 화면은 처음에 비어 있습니다. 비어 있을 때
 *      「처음 오셨나요?」와 두 갈래를 보여줍니다 — 예시를 보거나, 직접 시작하거나.
 *      비어 있지 않으면 이 판을 부르지 않고 화면이 자기 목록을 그립니다.
 *
 *   2) 예시 길잡이(guide). 화면을 어둡게 덮고, 지금 봐야 하는 것만 그 막 위로 올리고,
 *      눌러야 하는 자리에 동그라미와 마우스 표시를 얹습니다. 그 자리를 누르면 내용이
 *      채워지고 다음으로 갑니다.
 *
 * 예전에는 타이머로 알아서 넘어가는 재생기였습니다. 화면이 저 혼자 움직이니 읽는 속도를
 * 사람이 정할 수 없었고, 다 본 뒤에도 어디를 눌러 그렇게 되었는지는 배우지 못했습니다.
 * 그래서 손이 직접 그 자리를 지나가게 바꿨습니다 — 예시를 마친 사람은 이미 그 버튼을
 * 눌러 본 사람입니다. 이 파일에 타이머가 없는 것이 그 결과입니다.
 *
 * 그 다음에 고친 것이 지금 이 모양입니다. 한동안은 화면 아래에 검은 띠를 두고 거기
 * 「이 단계 실행」·「예시 끝내기」 버튼을 뒀습니다. 그러면 짚어 준 자리 대신 띠의 버튼을
 * 누르며 끝까지 가게 됩니다 — 배우라고 만든 자리를 건너뛰는 길을 우리가 같이 놓아 준
 * 셈이었습니다. 게다가 막이 없어서 눈이 갈 곳이 화면 전체였습니다. 지금은 코치마크와
 * 같은 방식으로 막을 덮고(coach.js), 누를 자리 하나만 남깁니다. 그만두는 길은 말풍선
 * 모서리의 ×(그리고 Esc) 하나로 남겨 둡니다 — 막에 갇히는 화면을 만들 수는 없습니다.
 *
 * 단계가 부르는 일은 미리 받아 둔 예시 데이터(app-walkthrough/data/)로만 채웁니다.
 * 예시에서 Bedrock 이나 생성 서버를 부르지 않습니다 — 한 번에 10~30초씩 걸리는 왕복을
 * 안내 중에 끼워 넣으면 배우는 시간이 아니라 기다리는 시간이 됩니다. 실제 모델은 예시를
 * 마친 뒤 직접 누를 때 돕니다.
 *
 * 되돌리기가 없다는 사실은 말풍선에 적어 둡니다 — 예시 내용은 서버에 남고 같은 보드를
 * 보는 사람에게도 보입니다(app/board.js 의 push 가 net.sendOp 를 부릅니다). 그것을 모른
 * 채 누르게 두지 않습니다. 네 화면을 잇는 예시는 그래서 「예시 프로젝트」 한 판에만
 * 씁니다(app/demo.js).
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

/* ── 길잡이: 막 · 누를 자리 · 말풍선 ──────────── */
/*
 * 코치마크(coach.js)와 같은 층 구조입니다. 다른 점은 하나 — 코치마크의 막은 어디를
 * 눌러도 다음 장으로 넘어가지만, 여기서는 짚어 준 자리만 눌러야 넘어갑니다. 그래서
 * 막에 클릭을 붙이지 않고, 짚은 자리를 막 위로 올려 그 자리만 손에 닿게 둡니다.
 *
 * z-index 는 코치마크와 겹치지 않게 한 칸 위(100~106)를 씁니다. 둘이 같이 뜨는 일은
 * 없지만(각 화면의 openCoach 가 guiding() 을 보고 물러납니다), 겹쳤을 때 안내가
 * 막 아래에 깔려 아무것도 못 누르는 화면이 되는 것이 가장 나쁩니다.
 */
body.onbguiding { overflow: hidden; }
.onbg { position: fixed; inset: 0; z-index: 100; font-family: var(--sb-sans, sans-serif); }
.onbg__veil { position: absolute; inset: 0; background: rgba(15, 20, 30, .62); }

/*
 * 지금 봐야 하는 것. 막 위로 올리기만 하고 테는 두르지 않습니다 — 테는 「눌러야 하는
 * 자리」의 표시로 아껴 둡니다(.onb-spot). 배경을 칠하는 이유는 반투명한 판이 막 위에
 * 올라오면 뒤의 어두운 막이 비쳐 글씨가 읽히지 않기 때문입니다.
 */
.onb-see { position: relative; z-index: 103; background: var(--sb-panel, #fff); border-radius: var(--sb-r-lg, 10px); }

/*
 * 눌러야 하는 자리. 막 위로 올리고 파란 테를 둘러 숨을 쉬게 합니다.
 * 테는 box-shadow 로 그립니다 — outline 이나 border 는 자리를 밀어 화면이 흔들립니다.
 */
.onb-spot {
  position: relative; z-index: 104; cursor: pointer;
  box-shadow: 0 0 0 3px var(--sb-accent, #1a56db), 0 0 0 9px rgba(26, 86, 219, .22);
  border-radius: var(--sb-r, 6px);
  animation: onbPulse 1.7s ease-in-out infinite;
}
@keyframes onbPulse {
  50% { box-shadow: 0 0 0 3px var(--sb-accent, #1a56db), 0 0 0 15px rgba(26, 86, 219, .07); }
}

/*
 * 누를 곳을 가리키는 동그라미와 마우스 표시. 둘 다 pointer-events:none 입니다 —
 * 정작 눌러야 하는 자리를 자기가 덮어 버리면 안 됩니다.
 *
 * 동그라미는 자리의 중앙에 놓고, 마우스 표시는 그 오른쪽 아래에 둡니다. 커서가 실제로
 * 그 방향에서 다가오기 때문에 그렇게 두는 편이 「여기를 누르라」로 읽힙니다.
 */
.onbg__ring {
  position: absolute; z-index: 105; pointer-events: none;
  width: 46px; height: 46px; margin: -23px 0 0 -23px; border-radius: 50%;
  border: 2px solid var(--sb-accent, #1a56db); background: rgba(26, 86, 219, .14);
  animation: onbRing 1.7s ease-out infinite;
}
@keyframes onbRing {
  0% { transform: scale(.68); opacity: .95; }
  70% { transform: scale(1.32); opacity: .12; }
  100% { transform: scale(1.32); opacity: 0; }
}
.onbg__hand {
  position: absolute; z-index: 106; pointer-events: none;
  font-size: 24px; line-height: 1; filter: drop-shadow(0 3px 7px rgba(15, 20, 30, .5));
  animation: onbHand 1.7s ease-in-out infinite;
}
@keyframes onbHand {
  0%, 100% { transform: translate(0, 0); }
  50% { transform: translate(-4px, -4px); }
}
@media (prefers-reduced-motion: reduce) {
  .onb-spot, .onbg__ring, .onbg__hand { animation: none; }
  .onbg__ring { opacity: .5; transform: scale(1); }
}

/*
 * 말풍선. 코치마크의 것과 같은 모양이라 두 안내가 한 화면의 두 방식으로 읽힙니다.
 * 다른 점은 「다음」 버튼이 없다는 것입니다 — 넘어가는 길은 짚어 준 자리뿐입니다.
 */
.onbg__b {
  position: absolute; z-index: 106; width: 330px; padding: 16px;
  background: var(--sb-panel, #fff); border-radius: var(--sb-r-lg, 10px);
  box-shadow: 0 12px 34px rgba(15, 20, 30, .34); display: grid; gap: 9px;
  color: var(--sb-ink, #111318);
}
.onbg__crumb { display: flex; align-items: baseline; gap: 8px; font-size: 11px; color: var(--sb-ink-3, #767f8c); }
.onbg__n { margin-left: auto; font: 500 11px var(--sb-mono, monospace); color: var(--sb-accent, #1a56db); }
.onbg__h { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -.02em; line-height: 1.35; }
.onbg__p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--sb-ink-2, #5b6472); }
.onbg__do {
  display: flex; align-items: center; gap: 7px; margin-top: 2px;
  font-size: 12.5px; font-weight: 600; color: var(--sb-accent, #1a56db);
}
.onbg__do::before { content: '◉'; font-size: 11px; }
/* 짚을 자리를 못 찾은 단계에서만 나옵니다. 그때는 이 버튼이 유일한 길입니다 */
.onbg__next {
  justify-self: start; margin-top: 3px; padding: 8px 16px; font: inherit; font-size: 13px;
  font-weight: 600; color: #fff; background: var(--sb-accent, #1a56db);
  border: 0; border-radius: var(--sb-r, 6px); cursor: pointer;
}
.onbg__next:hover { background: var(--sb-accent-ink, #1543ad); }
.onbg__x {
  position: absolute; top: 9px; right: 9px; width: 24px; height: 24px; padding: 0;
  display: grid; place-items: center; font: inherit; font-size: 15px;
  color: var(--sb-ink-3, #767f8c); background: none; border: 0; border-radius: 5px; cursor: pointer;
}
.onbg__x:hover { background: var(--sb-fill, #f8f9fb); color: var(--sb-ink, #111318); }
.onbg__dots { display: flex; gap: 5px; margin-top: 1px; }
.onbg__dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--sb-line, #e4e7ec); font-style: normal; }
.onbg__dots i.on { width: 16px; border-radius: 3px; background: var(--sb-accent, #1a56db); }
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

/** 이름 하나를 자리로. data-coach 이름이거나 CSS 선택자입니다 */
const one = (name) => (name ? q(`[data-coach="${name}"]`) || q(name) : null)

/** 짚을 자리(누를 곳) */
const spotOf = (step) => one(step?.spot)

/**
 * 막 위로 올려 보여 줄 자리들. see 를 따로 주지 않으면 누를 자리만 올립니다.
 *
 * 두 가지를 가르는 이유는, 누를 곳이 작은 버튼이고 봐야 할 것은 그 결과가 들어갈 넓은
 * 판인 경우가 흔하기 때문입니다 — 버튼만 올리면 「무엇이 채워졌는지」가 막에 묻힙니다.
 */
function seesOf(step) {
  const names = Array.isArray(step?.see) ? step.see : step?.see ? [step.see] : []
  return names.map(one).filter(Boolean)
}

function unspot() {
  if (!live) return
  live.lit?.classList.remove('onb-spot')
  for (const n of live.seen || []) n.classList.remove('onb-see')
  live.lit = null
  live.seen = []
}

/**
 * 한 단계를 화면에 올립니다. 실행하지는 않습니다 — 누를 자리를 짚고 기다립니다.
 *
 * 자리를 못 찾으면 말풍선에 「다음」 버튼을 내어 그것으로 넘기게 합니다. 없는 자리에
 * 테를 두르면 안내가 먼저 신뢰를 잃고, 막까지 덮은 상태에서 누를 곳이 하나도 없으면
 * 그 화면은 갇힙니다.
 */
function showStep() {
  if (!live) return
  unspot()
  const s = live.steps[live.i]
  const el = spotOf(s)
  if (el) {
    live.lit = el
    el.classList.add('onb-spot')
  } else if (s?.spot) {
    console.warn('[onboard] 짚을 자리를 못 찾았습니다 —', s.spot)
  }
  live.seen = seesOf(s)
  for (const n of live.seen) n.classList.add('onb-see')
  // 안쪽에서 스크롤되는 판 속에 있으면 화면 밖일 수 있습니다. 좌표를 재기 전에 끌어옵니다
  for (const n of [el, ...live.seen]) n?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  // 화면이 다시 그려진 뒤에 좌표를 잽니다 — coach.js 의 show 와 같은 이유입니다
  requestAnimationFrame(() => draw())
}

/** 막·동그라미·마우스 표시·말풍선을 지금 좌표에 맞춰 다시 그립니다 */
function draw() {
  if (!live) return
  const s = live.steps[live.i]
  const root = live.root
  root.textContent = ''

  const veil = mk('div', 'onbg__veil')
  root.append(veil)

  const boxes = []
  if (live.lit) {
    const r = live.lit.getBoundingClientRect()
    boxes.push(r)
    /*
     * 동그라미와 마우스 표시. 자리가 화면 밖으로 밀렸으면(스크롤이 안 되는 판 안에
     * 있는 경우) 얹지 않습니다 — 허공에 손가락을 띄우는 것보다 없는 편이 낫습니다.
     */
    if (r.width && r.height && r.bottom > 0 && r.top < innerHeight) {
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const ring = mk('span', 'onbg__ring')
      ring.style.cssText = `left:${cx}px;top:${cy}px`
      ring.setAttribute('aria-hidden', 'true')
      const hand = mk('span', 'onbg__hand', '🖱')
      hand.style.cssText = `left:${cx + 13}px;top:${cy + 8}px`
      hand.setAttribute('aria-hidden', 'true')
      root.append(ring, hand)
    }
  }
  for (const n of live.seen) boxes.push(n.getBoundingClientRect())

  root.append(bubble(s, boxes))
}

/** 말풍선 한 장. 넘어가는 길은 짚은 자리이고, 자리가 없을 때만 「다음」이 나옵니다 */
function bubble(s, boxes) {
  const b = mk('div', 'onbg__b')
  b.setAttribute('role', 'dialog')
  b.setAttribute('aria-modal', 'true')

  const top = mk('div', 'onbg__crumb')
  top.append(mk('span', null, live.title))
  top.append(mk('span', 'onbg__n', `${live.i + 1} / ${live.steps.length}`))
  b.append(top)

  const x = mk('button', 'onbg__x', '×')
  x.type = 'button'
  x.title = '예시를 그만 봅니다'
  x.setAttribute('aria-label', '예시 그만두기')
  x.onclick = () => stop()
  b.append(x)

  const h = mk('h2', 'onbg__h', s?.say || '')
  b.append(h)
  if (s?.sub) b.append(mk('p', 'onbg__p', s.sub))

  // 짚은 자리가 있으면 「어디를 누르라」를 적고, 없으면 버튼을 내어 줍니다
  if (live.lit) {
    b.append(mk('div', 'onbg__do', s?.do || '표시된 곳을 눌러 주십시오'))
  } else {
    const go = mk('button', 'onbg__next', s?.go || '다음')
    go.type = 'button'
    go.onclick = () => fire()
    go.disabled = !!live.busy
    b.append(go)
  }

  const dots = mk('div', 'onbg__dots')
  live.steps.forEach((_, i) => dots.append(mk('i', i === live.i ? 'on' : null)))
  dots.setAttribute('aria-hidden', 'true')
  b.append(dots)

  // 막 위로 올린 것을 덮지 않는 자리로 보냅니다 (coach.js 의 bubble 과 같은 셈)
  const span = boxes.reduce((a, r) => ({
    top: Math.min(a.top, r.top), bottom: Math.max(a.bottom, r.bottom),
    left: Math.min(a.left, r.left), right: Math.max(a.right, r.right),
  }), { top: 1e9, bottom: -1e9, left: 1e9, right: -1e9 })

  const W = 330, H = 240, gap = 14
  let x0, y0
  if (!boxes.length) {
    x0 = (innerWidth - W) / 2
    y0 = (innerHeight - H) / 2
  } else if (innerWidth - span.right - gap >= W) { x0 = span.right + gap; y0 = span.top }
  else if (span.left - gap >= W) { x0 = span.left - gap - W; y0 = span.top }
  else if (innerHeight - span.bottom - gap >= H) { x0 = span.left; y0 = span.bottom + gap }
  else { x0 = innerWidth - W - gap; y0 = innerHeight - H - gap }

  b.style.left = `${Math.max(gap, Math.min(x0, innerWidth - W - gap))}px`
  b.style.top = `${Math.max(gap, Math.min(y0, innerHeight - H - gap))}px`
  return b
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
 * 화면을 막으로 덮고, 지금 봐야 하는 것과 눌러야 하는 자리만 그 위로 올립니다. 그
 * 자리에는 동그라미와 마우스 표시가 얹혀서 어디를 눌러야 하는지 한눈에 보입니다.
 * 누르면 그 자리의 원래 동작은 막고 run 이 대신 돌아 내용이 채워집니다.
 *
 * 각 단계는 { say, sub?, spot?, see?, do?, go?, run? } 입니다.
 *   say   말풍선의 큰 줄. 지금 무엇을 하는지
 *   sub   그 아래 설명 줄
 *   spot  누를 자리. data-coach 이름이거나 CSS 선택자
 *   see   같이 막 위로 올려 보여 줄 자리들. 누를 곳과 결과가 들어갈 판이 다를 때 씁니다
 *   do    「표시된 곳을 눌러 주십시오」 대신 적을 한 줄
 *   go    자리를 못 찾았을 때만 나오는 버튼의 글자. 기본은 「다음」
 *   run   실제로 화면을 바꾸는 함수. 동기·비동기 둘 다 됩니다
 *
 * 원래 동작을 막는 것은 예시가 실수로 진짜 모델 호출에 닿지 않게 하려는 것입니다 —
 * 무슨 일이 일어나는지는 run 한 곳만 읽으면 됩니다. 자리에 커서를 두어야 하는
 * 단계(대본 칸 같은 것)는 run 에서 focus 를 부릅니다.
 *
 * 그만두는 길은 말풍선의 × 와 Esc 입니다. 막을 덮는 화면에 나가는 길이 없으면
 * 그것은 안내가 아니라 갇힌 화면입니다.
 *
 * @param {object} o
 * @param {Array} o.steps
 * @param {string} [o.title] - 말풍선 왼쪽 위에 붙는 이름
 * @param {() => void} o.onDone - 다 돌았거나 그만둔 뒤. 중간에 그만둬도 부릅니다
 * @returns {{stop: () => void}|null} 이미 돌고 있으면 null
 */
export function guide({ steps = [], title = '예시', onDone } = {}) {
  if (live) return null
  if (!steps.length) { onDone?.(); return null }
  injectCss(document)

  const root = mk('div', 'onbg')
  root.id = 'onbGuide'
  document.body.append(root)
  document.body.classList.add('onbguiding')

  live = { i: 0, steps, root, title, lit: null, seen: [], busy: false, onDone }

  /*
   * 짚은 자리의 클릭을 document 의 캡처 단계에서 받습니다. 캡처는 target 보다 먼저
   * 지나가므로 여기서 멈추면 그 자리의 원래 핸들러가 돌지 않습니다.
   * 말풍선 안에서 난 클릭은 이 길을 타지 않습니다 — 그쪽은 자기 onclick 이 받습니다.
   */
  live.onClick = (e) => {
    if (!live || live.root.contains(e.target)) return
    if (!live.lit) return
    if (!live.lit.contains(e.target) && live.lit !== e.target) return
    e.preventDefault()
    e.stopPropagation()
    fire()
  }
  // 키보드로 짚은 자리에 닿은 사람도 같은 길을 씁니다
  live.onKey = (e) => {
    if (!live) return
    if (e.key === 'Escape') { e.preventDefault(); stop(); return }
    if (!live.lit || e.key !== 'Enter') return
    if (!live.lit.contains(e.target) && live.lit !== e.target) return
    e.preventDefault()
    e.stopPropagation()
    fire()
  }
  // 창이 바뀌거나 안쪽 판이 움직이면 잰 좌표가 어긋납니다. 다시 잽니다
  live.onSize = () => draw()
  addEventListener('click', live.onClick, true)
  addEventListener('keydown', live.onKey, true)
  addEventListener('resize', live.onSize)
  addEventListener('scroll', live.onSize, true)

  showStep()
  return { stop }
}

/** 안내를 끝냅니다. 끝까지 가도, 중간에 그만둬도 여기 한 곳을 지납니다 */
export function stop() {
  if (!live) return
  unspot()
  removeEventListener('click', live.onClick, true)
  removeEventListener('keydown', live.onKey, true)
  removeEventListener('resize', live.onSize)
  removeEventListener('scroll', live.onSize, true)
  live.root.remove()
  document.body.classList.remove('onbguiding')
  const { onDone } = live
  live = null
  onDone?.()
}
