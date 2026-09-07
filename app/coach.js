/*
 * 온보딩 코치마크 — 막을 덮고 가리킬 것만 위로 올려 설명하는 층.
 *
 * 원래 키 비주얼 화면 전용이었고 카드 내용이 이 파일에 박혀 있었습니다. 네 화면이 다
 * 쓰게 되면서 app/ 공용으로 옮기고 카드는 화면이 넘겨주는 것으로 바꿨습니다. 엔진은
 * 좌표·막·말풍선·키보드만 맡습니다.
 *
 * 어느 화면에서든 지켜야 하는 것 — 카드는 지금 화면에 실제로 있는 것만 가리킵니다.
 * 앵커가 없으면 그 장은 조용히 건너뜁니다. 빈 구멍을 가리키면 코치마크가 먼저 신뢰를
 * 잃습니다. 같은 이유로 여기에 쓰지 않는 말이 있습니다 — 빠르다 · 무한히 확장된다 ·
 * 제작 기간이 줄어든다. 화면에서는 8장이 몇 분 걸리고 한 장은 실패합니다.
 *
 * CSS 도 이 파일이 넣습니다(nav-tabs.js 와 같은 방식). 화면마다 40줄씩 베껴 두면
 * 한 곳만 고쳐도 나머지가 어긋납니다.
 */

const $ = (s, r = document) => r.querySelector(s)

/*
 * 막 위의 층. 여기서 쓰는 색은 공통 토큰(app/theme.css)에서 받고, 두 번째 인자는
 * 그 파일이 없을 때의 기본값이다.
 */
const CSS = `
body.coaching { overflow: hidden; }
.coach { position: fixed; inset: 0; z-index: 90; }
.coach__veil { position: absolute; inset: 0; background: rgba(15, 20, 30, .52); }
/* 가리킬 것만 막 위로 올린다. 막에 구멍을 겹쳐 뚫으면 겹친 자리가 두 번 어두워진다. */
.coach-lit {
  position: relative; z-index: 95; background: var(--sb-panel, #fff);
  box-shadow: 0 0 0 3px var(--sb-accent, #1a56db), 0 8px 26px rgba(15, 20, 30, .28);
}
/*
 * 올린 요소의 모서리를 그림자가 따라가게 둔다. background 를 덮어썼기 때문에 원래
 * 규칙의 border-radius 가 이기지 못하는 경우가 있어 자주 가리키는 것들만 적어 둔다.
 */
.card.coach-lit, .cut.coach-lit, .pane.coach-lit, .step.coach-lit { border-radius: var(--sb-r-lg, 10px); }
.tab.coach-lit, .tag.coach-lit, .navtab.coach-lit, .btn.coach-lit { border-radius: var(--sb-r, 6px); }
.coach__tag {
  position: absolute; z-index: 96; font: 600 11px/1 var(--sb-sans, sans-serif); color: #fff;
  background: var(--sb-accent, #1a56db); padding: 5px 9px; border-radius: 4px;
  white-space: nowrap; pointer-events: none;
}
.coach__b {
  position: absolute; z-index: 97; background: var(--sb-panel, #fff);
  border-radius: var(--sb-r-lg, 10px); padding: 16px;
  box-shadow: 0 12px 34px rgba(15, 20, 30, .3); display: grid; gap: 9px;
  font-family: var(--sb-sans, sans-serif); color: var(--sb-ink, #111318);
}
.coach__crumb {
  display: flex; align-items: baseline; gap: 8px; font-size: 11px; color: var(--sb-ink-3, #767f8c);
}
.coach__n {
  margin-left: auto; font: 500 11px var(--sb-mono, monospace); color: var(--sb-accent, #1a56db);
}
.coach__h { font-size: 16px; font-weight: 700; letter-spacing: -.02em; line-height: 1.35; margin: 0; }
.coach__p { font-size: 13px; color: var(--sb-ink-2, #5b6472); line-height: 1.6; margin: 0; }
.coach__p + .coach__p { margin-top: -6px; }
.coach__dots { display: flex; gap: 5px; margin-top: 2px; }
.coach__dots .dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--sb-line, #e4e7ec); font-style: normal;
}
.coach__dots .dot--on { background: var(--sb-accent, #1a56db); width: 16px; border-radius: 3px; }
.coach__row { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
.coach__skip {
  font: inherit; font-size: 12.5px; color: var(--sb-ink-3, #767f8c);
  background: none; border: 0; cursor: pointer; padding: 0;
}
.coach__skip:hover { color: var(--sb-ink-2, #5b6472); text-decoration: underline; }
.coach__next {
  margin-left: auto; background: var(--sb-accent, #1a56db); color: #fff; padding: 8px 16px;
  border: 0; border-radius: var(--sb-r, 6px); font: inherit; font-weight: 600; font-size: 13px;
  cursor: pointer;
}
.coach__next:hover { background: var(--sb-accent-ink, #1543ad); }
`

let styled = false
function injectCss(doc) {
  if (styled) return
  styled = true
  const el = doc.createElement('style')
  el.id = 'coachCss'
  el.textContent = CSS
  doc.head.appendChild(el)
}

let live = null

function unlit() {
  for (const n of live?.lit || []) n.classList.remove('coach-lit')
  if (live) live.lit = []
}

/*
 * 화면마다 따로 기억한다. 키비주얼을 다 본 사람이 보드에서도 안 보게 되면 안 된다 —
 * 설명하는 내용이 다르다. 예전 키(sb.kv.coach.v1)를 키비주얼이 그대로 쓰므로 이미 본
 * 사람은 다시 보지 않는다.
 */
export function seen(key) {
  try { return localStorage.getItem(key) === 'done' } catch { return false }
}
function remember(key) {
  try { localStorage.setItem(key, 'done') } catch {}
}

/**
 * 열지 않고 「봤다」로 둡니다.
 *
 * 「직접 시작하기」를 누른 사람에게 씁니다. 그 사람은 이미 쓰기로 정한 사람인데 막을
 * 덮어 넉 장을 넘기게 하면 안내가 아니라 걸림돌입니다. 그런데 표시를 안 남기면 다음에
 * 그 화면을 열 때(그때는 판에 내용이 있으므로) 코치마크가 스스로 열립니다 — 한 번
 * 거절한 것을 다시 내미는 셈입니다. 그래서 거절도 기억합니다.
 *
 * 다시 보고 싶은 사람의 길은 남아 있습니다 — 헤더의 「안내 다시 보기」입니다.
 *
 * @param {string} key - seen 이 읽는 것과 같은 키
 */
export function skip(key) {
  if (key) remember(key)
}

/**
 * 코치마크를 시작한다.
 * @param {object} o
 * @param {Array} o.cards - 카드들. { head, body, spot[], tags?, next, skip, step? }
 * @param {string} o.key - localStorage 키. 화면마다 다르게 준다
 * @param {string} o.title - 말풍선 왼쪽 위에 붙는 화면 이름
 * @param {object} o.host - { goStep(n), atStep() }. 앵커가 다른 단계에 있을 때 화면을 옮긴다
 * @param {() => void} o.onDone - 다 보거나 건너뛴 뒤
 */
export function start({ cards, key, title = '스토리보드', host, onDone } = {}) {
  if (live) return
  if (!cards?.length) { onDone?.(); return }
  injectCss(document)
  live = { i: 0, h: host, cards, key, title, onDone, back: document.activeElement }
  const root = document.createElement('div')
  root.className = 'coach'
  root.id = 'coach'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-labelledby', 'coachHead')
  document.body.append(root)
  document.body.classList.add('coaching')
  live.root = root
  live.onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); stop(true) }
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); step(1) }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
  }
  live.onSize = () => draw()
  addEventListener('keydown', live.onKey)
  addEventListener('resize', live.onSize)
  addEventListener('scroll', live.onSize, true)
  show()
}

export function stop(record) {
  if (!live) return
  unlit()
  removeEventListener('keydown', live.onKey)
  removeEventListener('resize', live.onSize)
  removeEventListener('scroll', live.onSize, true)
  live.root.remove()
  document.body.classList.remove('coaching')
  const { back, key, onDone } = live
  live = null
  if (record && key) remember(key)
  back?.focus?.()
  onDone?.()
}

function step(d) {
  if (!live) return
  const i = live.i + d
  if (i < 0) return
  if (i >= live.cards.length) { stop(true); return }
  live.i = i
  show()
}

function show() {
  const c = live.cards[live.i]
  // step 을 쓰는 화면(키비주얼)에서만 단계를 옮긴다. 나머지는 단계 개념이 없다
  if (c.step != null && live.h?.atStep?.() !== c.step) live.h?.goStep?.(c.step)
  /*
   * 안쪽에서 스크롤되는 판(보드의 세 기둥) 안에 앵커가 있으면 화면 밖일 수 있다.
   * 잰 좌표가 화면 밖이면 막 위로 올려도 보이지 않는다 — 재기 전에 끌어온다.
   * body 는 coaching 동안 overflow:hidden 이라 창 전체가 흔들리지는 않는다.
   */
  for (const n of targets(c)) n.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  // 화면이 다시 그려진 뒤에 좌표를 잰다
  requestAnimationFrame(() => draw())
}

/** 앵커가 하나도 없으면 그 장은 조용히 넘긴다. 빈 구멍을 가리키지 않는다. */
function targets(c) {
  return c.spot.map((k) => $(`[data-coach="${k}"]`)).filter(Boolean)
}

function draw() {
  if (!live) return
  const c = live.cards[live.i]
  const hits = targets(c)
  if (!hits.length) { step(1); return }

  const root = live.root
  root.textContent = ''

  // 막에 구멍을 뚫지 않고, 가리킬 것을 막 위로 올린다.
  // 사각형을 여러 개 겹치면 겹친 곳만 두 번 어두워진다.
  unlit()
  live.lit = hits
  for (const n of hits) n.classList.add('coach-lit')

  const boxes = hits.map((n) => {
    const r = n.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })

  const veil = document.createElement('div')
  veil.className = 'coach__veil'
  veil.onclick = () => step(1)
  root.append(veil)

  for (const t of c.tags || []) {
    const n = $(`[data-coach="${t.on}"]`)
    if (!n) continue
    const r = n.getBoundingClientRect()
    const tag = document.createElement('span')
    tag.className = 'coach__tag'
    tag.textContent = t.text
    tag.style.cssText = `left:${r.left}px;top:${Math.max(6, r.top - 30)}px`
    root.append(tag)
  }

  root.append(bubble(c, boxes))

  const first = root.querySelector('.coach__b button')
  first?.focus()
}

function bubble(c, boxes) {
  const b = document.createElement('div')
  b.className = 'coach__b'

  const top = document.createElement('div')
  top.className = 'coach__crumb'
  top.append(mk('span', null, live.title))
  // 번호는 카드가 들고 있지 않다 — 앵커가 없어 건너뛴 장이 있어도 순서가 어긋나지 않게
  top.append(mk('span', 'coach__n', `${live.i + 1} / ${live.cards.length}`))
  b.append(top)

  const h = mk('h2', 'coach__h', c.head)
  h.id = 'coachHead'
  b.append(h)

  for (const line of c.body.split('\n')) b.append(mk('p', 'coach__p', line))

  const dots = mk('div', 'coach__dots')
  live.cards.forEach((_, i) => {
    const d = mk('i', 'dot' + (i === live.i ? ' dot--on' : ''))
    dots.append(d)
  })
  b.append(dots)

  const row = mk('div', 'coach__row')
  const last = live.i === live.cards.length - 1
  const skip = mk('button', 'coach__skip', c.skip || '건너뛰기')
  skip.type = 'button'
  skip.onclick = () => stop(true)
  const next = mk('button', 'coach__next', c.next || (last ? '시작하기' : '다음'))
  next.type = 'button'
  next.onclick = () => step(1)
  row.append(skip, next)
  b.append(row)

  // 뚫린 구멍을 덮지 않는 자리로 보낸다
  const span = boxes.reduce((a, x) => ({
    top: Math.min(a.top, x.y), bottom: Math.max(a.bottom, x.y + x.h),
    left: Math.min(a.left, x.x), right: Math.max(a.right, x.x + x.w),
  }), { top: 1e9, bottom: -1e9, left: 1e9, right: -1e9 })

  const W = 330, H = 250, gap = 14
  const roomR = innerWidth - span.right - gap
  const roomL = span.left - gap
  const roomB = innerHeight - span.bottom - gap

  let x, y
  if (roomR >= W) { x = span.right + gap; y = span.top }
  else if (roomL >= W) { x = span.left - gap - W; y = span.top }
  else if (roomB >= H) { x = span.left; y = span.bottom + gap }
  else { x = innerWidth - W - gap; y = innerHeight - H - gap }

  b.style.cssText =
    `left:${Math.max(gap, Math.min(x, innerWidth - W - gap))}px;` +
    `top:${Math.max(gap, Math.min(y, innerHeight - H - gap))}px;width:${W}px`
  return b
}

function mk(t, c, x) {
  const n = document.createElement(t)
  if (c) n.className = c
  if (x != null) n.textContent = x
  return n
}
