/*
 * 온보딩 코치마크 — key-visual-mockup.drawio 의 「온보딩 코치마크」 탭 구현.
 *
 * 네 장 모두 지금 화면에 실제로 있는 것만 가리킨다. 없는 것을 가리키면 그 장은 건너뛴다.
 *
 * 여기에 쓰지 않는 말 세 개: 빠르다 · 무한히 확장된다 · 제작 기간이 줄어든다.
 * 화면에서 8장이 몇 분 걸리고 한 장은 실패하고 한 대가 순서대로 그린다.
 * 화면과 다른 말을 적으면 코치마크가 먼저 신뢰를 잃는다.
 */

const KEY = 'sb.kv.coach.v1'
const $ = (s, r = document) => r.querySelector(s)

export const CARDS = [
  {
    n: 1, step: 1,
    head: '대본은 이 계정 안에 머문다',
    body: '여기 붙인 대본은 우리 계정 안에서만 읽힙니다.\n그림 설명을 쓰는 모델도, 그림을 그리는 모델도\n같은 계정 안에 있습니다.',
    spot: ['script'],
    next: '다음', skip: '건너뛰기',
  },
  {
    n: 2, step: 3,
    head: '만드는 동안만 장비가 켜진다',
    body: '그래픽 장비는 업무 시간에만 켜져 있습니다.\n첫 장이 조금 늦는 것은 그때 모델을 올리기\n때문입니다. 밤과 주말에는 내려가 있습니다.',
    spot: ['rig', 'queue'],
    next: '다음', skip: '건너뛰기',
  },
  {
    n: 3, step: 3,
    head: '생성 권한은 서버에서 확인한다',
    body: '검수자에게 버튼을 숨기지 않습니다.\n요청이 도착하면 서버가 역할을 보고 거절합니다.\n화면을 우회해도 결과는 같습니다.',
    spot: ['perm', 'whoami'],
    next: '다음', skip: '건너뛰기',
  },
  {
    n: 4, step: 3,
    head: '직접 들 것만 직접 든다',
    body: '문장을 다루는 모델은 맡기고,\n그림 모델만 우리가 띄웁니다.\n두 종류가 같이 도는데 관리하는 것은 하나입니다.',
    spot: ['tab2', 'rig'],
    tags: [{ on: 'tab2', text: '문장 모델 · 맡긴다' }, { on: 'rig', text: '그림 모델 · 우리가 띄운다' }],
    next: '시작하기', skip: '다시 보지 않기',
  },
]

let live = null

function unlit() {
  for (const n of live?.lit || []) n.classList.remove('coach-lit')
  if (live) live.lit = []
}

export function seen() {
  try { return localStorage.getItem(KEY) === 'done' } catch { return false }
}
function remember() {
  try { localStorage.setItem(KEY, 'done') } catch {}
}

/**
 * @param {object} h  { goStep(n), atStep() } — 코치마크가 앵커가 있는 단계로 화면을 옮길 때 쓴다
 */
export function start(h) {
  if (live) return
  live = { i: 0, h }
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
  const back = live.back
  live = null
  if (record) remember()
  back?.focus?.()
}

function step(d) {
  if (!live) return
  const i = live.i + d
  if (i < 0) return
  if (i >= CARDS.length) { stop(true); return }
  live.i = i
  show()
}

function show() {
  const c = CARDS[live.i]
  if (live.h?.atStep?.() !== c.step) live.h?.goStep?.(c.step)
  // 화면이 다시 그려진 뒤에 좌표를 잰다
  requestAnimationFrame(() => draw())
}

/** 앵커가 하나도 없으면 그 장은 조용히 넘긴다. 빈 구멍을 가리키지 않는다. */
function targets(c) {
  return c.spot.map((k) => $(`[data-coach="${k}"]`)).filter(Boolean)
}

function draw() {
  if (!live) return
  const c = CARDS[live.i]
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
  top.append(mk('span', null, '스토리보드 · 키 비주얼'))
  top.append(mk('span', 'coach__n', `${c.n} / ${CARDS.length}`))
  b.append(top)

  const h = mk('h2', 'coach__h', c.head)
  h.id = 'coachHead'
  b.append(h)

  for (const line of c.body.split('\n')) b.append(mk('p', 'coach__p', line))

  const dots = mk('div', 'coach__dots')
  CARDS.forEach((_, i) => {
    const d = mk('i', 'dot' + (i === live.i ? ' dot--on' : ''))
    dots.append(d)
  })
  b.append(dots)

  const row = mk('div', 'coach__row')
  const skip = mk('button', 'coach__skip', c.skip)
  skip.type = 'button'
  skip.onclick = () => stop(true)
  const next = mk('button', 'coach__next', c.next)
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
