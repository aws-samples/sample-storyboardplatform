
// 그래프 판 그리기. 외부 라이브러리 없이 캔버스 하나로 돈다.
//
// 노드는 구체로 그린다 — 왼쪽 위에서 빛이 들어오는 radial gradient, 위쪽의 반사 점,
// 아래의 눌린 그림자. 떠 있는 것처럼 보이는 것이 목적이다. 엣지는 살짝 휜 곡선이고
// 명시는 실선, 파생은 점선이다. 관계 라벨은 모든 엣지 위에 항상 띄운다 (한국어 서술로).
//
// 역기입으로 자란 자리는 markNew 로 표시한다 — 새 노드는 녹색 테두리가 반짝이고
// NEW 뱃지가 붙고, 새 엣지는 굵은 녹색, 끊긴 엣지는 붉은 점선으로 잠깐 남았다 사라진다.
//
// 좌표는 두 겹이다: 배치와 그리기는 월드 좌표에서 하고, 화면에는 {scale, tx, ty} 로
// 옮겨 그린다. 히트 테스트는 반대로 화면 → 월드로 되돌린다.
//
// 배치는 Fruchterman-Reingold 한 판을 미리 돌려 굳힌다 (계속 흔들리는 물리 대신).
// 다시 그릴 때 이미 있던 노드는 지금 자리에서 시작해서, 판이 자라도 모양이 튀지 않는다.

import { edgeKey } from './graph-schema.js'

const TAU = Math.PI * 2

/** 노드 종류별 구체 색. graph-schema.js 의 KINDS 와 같은 열이다 */
export const KIND_COLOR = {
  Character: '#FF6B6B', // 코랄
  Faction: '#FFA94D',   // 탠저린
  Location: '#4ECDC4',  // 민트
  Event: '#FFD93D',     // 골드
  Secret: '#C084FC',    // 퍼플
  Object: '#6CB4EE',    // 스카이블루
}

export const KIND_LABEL = {
  Character: '인물', Faction: '집단', Location: '장소',
  Event: '사건', Secret: '비밀', Object: '사물',
}

/** 종류별 반지름. 인물이 가장 크다 — 이야기의 무게가 인물에 있다 */
const KIND_R = {
  Character: 25, Faction: 21, Location: 20, Event: 20, Secret: 19, Object: 17,
}

const INK = '#2A2F3A'
const DOT = 'rgba(120,130,160,0.20)'
const EDGE_ON = 'rgba(96,108,136,0.62)'
const EDGE_DER = 'rgba(140,150,175,0.50)'

/** 새로 생긴 것을 알리는 녹색. 노드 테두리·NEW 뱃지·새 엣지가 한 색을 쓴다 */
const NEW_GREEN = '#4CAF50'
/** 끊긴 엣지 자리에 잠깐 남는 붉은색 */
const GONE_RED = '#E05252'
/** 새 노드가 반짝이는 시간. 이 뒤에는 정지한 녹색 테두리와 NEW 뱃지만 남는다 */
const PULSE_MS = 9000
/** 반짝임 한 주기 */
const PULSE_CYCLE = 1400
/** 끊긴 엣지 자리가 붉은 점선으로 남아 있는 시간 */
const GHOST_MS = 2600

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// ── 엣지 라벨 ────────────────────────────────────────────────────────────────
/**
 * 술어를 "A ─라벨→ B" 로 읽었을 때 자연스러운 한국어 서술로 옮긴다.
 * 조사는 목적어(B) 쪽에 붙는다 — "홍해인 ─을 은닉함→ 시한부 비밀",
 * "윤은성 ─을 보좌함→ 홍해인" 처럼 화살표를 따라 그대로 읽힌다.
 * 여기 없는 술어는 원본 영문 그대로 보여 준다 — 어휘가 늘어도 라벨이 비지 않는다.
 */
export const EDGE_LABELS_KR = {
  loves: '을 사랑함',
  rival_of: '과 경쟁함',
  child_of: '의 자녀임',
  parent_of: '의 부모임',
  sibling_of: '의 형제임',
  mentor_of: '을 가르침',
  serves: '을 보좌함',
  member_of: '에 소속됨',
  located_in: '에 위치함',
  participated_in: '에 참여함',
  knows: '을 알고 있음',
  conceals: '을 은닉함',
  hidden_from: '에게 숨겨짐',
  owns: '을 소유함',
  caused: '을 초래함',
  wants: '을 원함',
  performs_at: '에서 활동함',
  manages: '을 관리함',
  maintains: '을 유지함',
  has_leverage_over: '의 약점을 쥠',
  drawn_to: '에게 끌림',
  distrusts: '을 불신함',
  protects: '을 보호함',
  targets: '을 겨냥함',
  resolves: '을 해소함',
}

/**
 * 친족은 술어가 하나뿐이고 props.type 에 관계가 담긴다 (graph-schema.js 의 kin_of).
 * 위 표의 parent_of·child_of·sibling_of 는 그래서 술어가 아니라 여기로 이어진다.
 */
const KIN_LABELS_KR = {
  parent: EDGE_LABELS_KR.parent_of,
  child: EDGE_LABELS_KR.child_of,
  sibling: EDGE_LABELS_KR.sibling_of,
  spouse: '의 배우자임',
}

/**
 * 엣지 하나에 얹을 라벨 한 줄.
 *
 * @param {string} p - 술어
 * @param {Object} [props] - 엣지의 props. kin_of 의 type 을 여기서 본다
 * @returns {string} 한국어 서술. 표에 없는 술어는 원본 영문
 */
export const edgeLabel = (p, props) => {
  const key = String(p ?? '')
  if (key === 'kin_of') {
    const kin = KIN_LABELS_KR[String(props?.type ?? '').toLowerCase()]
    if (kin) return kin
  }
  return EDGE_LABELS_KR[key] || key
}

/**
 * 역기입 전후의 판을 견줘 새로 생긴 것과 사라진 것을 가른다. markNew 에 그대로 넣는다.
 * applyWriteback 은 개수만 주기 때문에 (nodesAdded 등) id 는 이렇게 뽑는다.
 *
 * @param {{nodes: Array, edges: Array}} before - 역기입 전 store.toJSON()
 * @param {{nodes: Array, edges: Array}} after - 역기입 뒤 store.toJSON()
 * @returns {{nodes: Array<string>, edges: Array<string>, removed: Array<{s: string, p: string, o: string}>}}
 *          edges 는 edgeKey 문자열, removed 는 끊긴 삼항 (함께 사라진 파생도 들어온다)
 */
export function graphDelta(before, after) {
  const list = (g, k) => (Array.isArray(g?.[k]) ? g[k] : [])
  const hadNode = new Set(list(before, 'nodes').map((n) => n.id))
  const hadEdge = new Set(list(before, 'edges').map(edgeKey))
  const hasEdge = new Set(list(after, 'edges').map(edgeKey))
  return {
    nodes: list(after, 'nodes').map((n) => n.id).filter((id) => !hadNode.has(id)),
    edges: list(after, 'edges').map(edgeKey).filter((k) => !hadEdge.has(k)),
    removed: list(before, 'edges').filter((e) => !hasEdge.has(edgeKey(e)))
      .map((e) => ({ s: e.s, p: e.p, o: e.o, props: e.props })),
  }
}

// ── 색 ───────────────────────────────────────────────────────────────────────
const rgb = (hex) => {
  const h = String(hex || '').replace('#', '')
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(s.padEnd(6, '0').slice(0, 6), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** hex 를 흰색(t>0) 또는 검정(t<0) 쪽으로 섞는다. 구체의 명암을 여기서 만든다 */
const shade = (hex, t) => {
  const c = rgb(hex)
  const to = t > 0 ? 255 : 0
  const k = Math.abs(t)
  const m = (v) => Math.round(v + (to - v) * k)
  return `rgb(${m(c.r)},${m(c.g)},${m(c.b)})`
}

const alpha = (hex, a) => {
  const c = rgb(hex)
  return `rgba(${c.r},${c.g},${c.b},${a})`
}

// ── 배치 ─────────────────────────────────────────────────────────────────────
/**
 * 힘 기반 배치 한 판. 붙어 있는 노드는 당기고, 모든 노드끼리는 밀고,
 * 판 전체는 가운데로 살짝 모은다. 온도를 식혀 가며 굳힌다.
 */
function layout(nodes, links, w, h, iterations) {
  const n = nodes.length
  if (n < 2) {
    if (n === 1) { nodes[0].x = w / 2; nodes[0].y = h / 2 }
    return
  }
  const k = Math.sqrt((w * h) / n) * 0.62
  // 자리가 없는 노드는 황금각 나선에 놓는다 — 난수를 안 써서 다시 그려도 같은 모양이다
  let seq = 0
  for (const nd of nodes) {
    if (Number.isFinite(nd.x) && Number.isFinite(nd.y)) continue
    const a = seq * 2.39996
    const rad = k * 0.55 * Math.sqrt(seq + 1)
    nd.x = w / 2 + Math.cos(a) * rad
    nd.y = h / 2 + Math.sin(a) * rad
    seq++
  }

  let temp = Math.max(w, h) * 0.08
  for (let it = 0; it < iterations; it++) {
    for (const nd of nodes) { nd.dx = 0; nd.dy = 0 }
    for (let i = 0; i < n; i++) {
      const a = nodes[i]
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j]
        let ex = a.x - b.x
        let ey = a.y - b.y
        let d = Math.hypot(ex, ey)
        if (d < 0.01) { ex = (i % 7) - 3 + 0.5; ey = (j % 5) - 2 + 0.5; d = Math.hypot(ex, ey) }
        const f = (k * k) / d
        const ux = (ex / d) * f
        const uy = (ey / d) * f
        a.dx += ux; a.dy += uy
        b.dx -= ux; b.dy -= uy
      }
    }
    for (const [a, b] of links) {
      const ex = a.x - b.x
      const ey = a.y - b.y
      const d = Math.max(0.01, Math.hypot(ex, ey))
      const f = (d * d) / k
      const ux = (ex / d) * f
      const uy = (ey / d) * f
      a.dx -= ux; a.dy -= uy
      b.dx += ux; b.dy += uy
    }
    for (const nd of nodes) {
      nd.dx += (w / 2 - nd.x) * 0.018 * k * 0.1
      nd.dy += (h / 2 - nd.y) * 0.018 * k * 0.1
      const d = Math.max(0.01, Math.hypot(nd.dx, nd.dy))
      const step = Math.min(d, temp)
      nd.x += (nd.dx / d) * step
      nd.y += (nd.dy / d) * step
    }
    temp *= 0.972
  }
}

/**
 * 캔버스 그래프 판 하나.
 *
 * @param {HTMLElement} host - 캔버스를 채울 자리
 * @param {Object} [opts]
 * @param {Function} [opts.onPick] 노드를 눌렀을 때 id, 빈 자리를 눌렀을 때 null
 * @returns {{render: Function, focus: Function, destroy: Function}}
 */
export function createGraphView(host, opts = {}) {
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none'
  host.appendChild(canvas)
  const ctx = canvas.getContext('2d')

  let nodes = []            // {id, kind, name, x, y, r, hot}
  let edges = []            // {a, b, p, props, key, label, asserted, bow}
  const byId = new Map()
  const pos = new Map()     // 지난 판의 자리. 다시 그릴 때 모양을 이어 준다
  let view = { s: 1, tx: 0, ty: 0 }
  let insets = { l: 0, t: 0, r: 0, b: 0 } // 판 위에 얹힌 카드가 가리는 자리
  let hoverNode = null
  let hoverEdge = null
  let selected = new Set()
  let drag = null           // {node|null, sx, sy, ox, oy, moved}
  let anim = null           // 화면 옮기기 애니메이션
  let raf = 0
  let dead = false
  // 역기입으로 새로 생긴 자리. t0 은 반짝임의 시작이고 0 이면 반짝임이 끝난 것이다
  let marks = { nodes: new Set(), edges: new Set(), t0: 0 }
  let ghosts = []           // 끊긴 엣지 자리 {a, b, p, bow, t0}
  let tick = 0              // 이번 프레임의 시각. 반짝임·페이드아웃이 이것을 본다
  const textW = new Map()   // 라벨 폭 캐시. 프레임마다 measureText 하지 않는다

  const size = () => ({
    w: canvas.clientWidth || host.clientWidth || 800,
    h: canvas.clientHeight || host.clientHeight || 600,
  })

  let dirty = true
  const kick = () => { dirty = true }

  // ── 좌표 ───────────────────────────────────────────────────────────────────
  const toWorld = (px, py) => ({ x: (px - view.tx) / view.s, y: (py - view.ty) / view.s })

  const bounds = (list) => {
    const b = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity }
    for (const nd of list) {
      b.x1 = Math.min(b.x1, nd.x - nd.r)
      b.y1 = Math.min(b.y1, nd.y - nd.r)
      b.x2 = Math.max(b.x2, nd.x + nd.r)
      b.y2 = Math.max(b.y2, nd.y + nd.r)
    }
    return b
  }

  /**
   * 주어진 노드들이 다 보이는 화면을 만든다. animate 면 320ms 동안 옮긴다.
   * 판 위에 얹힌 카드·범례가 가리는 만큼(insets)은 처음부터 빼고 자리를 잡는다.
   */
  function fit(list, { animate = false, maxScale = 1.35, pad = 70 } = {}) {
    if (!list.length) return
    const { w, h } = size()
    const vw = Math.max(120, w - insets.l - insets.r)
    const vh = Math.max(120, h - insets.t - insets.b)
    const b = bounds(list)
    const bw = Math.max(1, b.x2 - b.x1)
    const bh = Math.max(1, b.y2 - b.y1)
    const s = clamp(Math.min((vw - pad) / bw, (vh - pad) / bh), 0.25, maxScale)
    const to = {
      s,
      tx: insets.l + vw / 2 - ((b.x1 + b.x2) / 2) * s,
      ty: insets.t + vh / 2 - ((b.y1 + b.y2) / 2) * s,
    }
    if (!animate) { view = to; anim = null; kick(); return }
    anim = { from: { ...view }, to, t0: performance.now(), ms: 320 }
    kick()
  }

  // ── 엣지 모양 ──────────────────────────────────────────────────────────────
  /** 곡선의 제어점. 같은 쌍에 엣지가 여럿이면 서로 다르게 휜다 */
  const ctrl = (e) => {
    const mx = (e.a.x + e.b.x) / 2
    const my = (e.a.y + e.b.y) / 2
    const dx = e.b.x - e.a.x
    const dy = e.b.y - e.a.y
    const len = Math.max(1, Math.hypot(dx, dy))
    return { x: mx + (-dy / len) * len * e.bow, y: my + (dx / len) * len * e.bow }
  }

  /** 구체에 파묻히지 않게 양 끝을 반지름만큼 물려서 자른다 */
  const endpoints = (e, c) => {
    const trim = (from, to, r) => {
      const dx = to.x - from.x
      const dy = to.y - from.y
      const d = Math.max(0.01, Math.hypot(dx, dy))
      return { x: from.x + (dx / d) * (r + 3), y: from.y + (dy / d) * (r + 3) }
    }
    return { p1: trim(e.a, c, e.a.r), p2: trim(e.b, c, e.b.r) }
  }

  const qpoint = (p1, c, p2, t) => {
    const u = 1 - t
    return {
      x: u * u * p1.x + 2 * u * t * c.x + t * t * p2.x,
      y: u * u * p1.y + 2 * u * t * c.y + t * t * p2.y,
    }
  }

  // ── 그리기 ─────────────────────────────────────────────────────────────────
  function paintBackground(w, h) {
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, '#FDFDFB')
    g.addColorStop(1, '#F4F2EE')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)

    // 미세한 도트 패턴. 화면이 아니라 월드에 붙어 있어서 움직이면 같이 흐른다 → 깊이감
    const gap = 30 * view.s
    if (gap < 9) return
    const ox = view.tx % gap
    const oy = view.ty % gap
    const r = clamp(1.1 * view.s, 0.7, 1.8)
    ctx.fillStyle = DOT
    for (let y = oy - gap; y < h + gap; y += gap) {
      for (let x = ox - gap; x < w + gap; x += gap) {
        ctx.beginPath()
        ctx.arc(x, y, r, 0, TAU)
        ctx.fill()
      }
    }
  }

  function paintEdge(e) {
    const on = e === hoverEdge
    const fresh = marks.edges.has(e.key)
    const c = ctrl(e)
    const { p1, p2 } = endpoints(e, c)
    // 새로 생긴 엣지는 굵은 녹색이다. 얹은 것보다 이 표시가 앞선다
    const tone = fresh ? NEW_GREEN : (on ? '#6B7BE0' : (e.asserted ? EDGE_ON : EDGE_DER))
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.quadraticCurveTo(c.x, c.y, p2.x, p2.y)
    ctx.setLineDash(e.asserted ? [] : [5, 5])
    ctx.lineWidth = fresh ? (on ? 3.8 : 3.2) : (on ? 2.6 : (e.asserted ? 1.7 : 1.3))
    ctx.strokeStyle = tone
    ctx.lineCap = 'round'
    ctx.stroke()

    // 화살촉. 방향(주어 → 목적어)이 관계를 읽는 데 필요하다
    const tip = qpoint(p1, c, p2, 1)
    const back = qpoint(p1, c, p2, 0.9)
    const a = Math.atan2(tip.y - back.y, tip.x - back.x)
    const len = fresh ? 10 : (on ? 9 : 7)
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(tip.x, tip.y)
    ctx.lineTo(tip.x - Math.cos(a - 0.42) * len, tip.y - Math.sin(a - 0.42) * len)
    ctx.lineTo(tip.x - Math.cos(a + 0.42) * len, tip.y - Math.sin(a + 0.42) * len)
    ctx.closePath()
    ctx.fillStyle = tone
    ctx.fill()
    ctx.restore()
  }

  /**
   * 끊긴 엣지 자리. 붉은 점선으로 잠깐 남았다 페이드아웃한다 —
   * 역기입에서 무엇이 사라졌는지 판에서 눈으로 확인할 자리다.
   */
  function paintGhost(g) {
    const t = clamp((tick - g.t0) / GHOST_MS, 0, 1)
    const c = ctrl(g)
    const { p1, p2 } = endpoints(g, c)
    ctx.save()
    ctx.globalAlpha = 1 - t * t
    ctx.beginPath()
    ctx.moveTo(p1.x, p1.y)
    ctx.quadraticCurveTo(c.x, c.y, p2.x, p2.y)
    ctx.setLineDash([6, 6])
    ctx.lineWidth = 2.2
    ctx.strokeStyle = GONE_RED
    ctx.lineCap = 'round'
    ctx.stroke()
    ctx.restore()
  }

  // ── 엣지 라벨 ──────────────────────────────────────────────────────────────
  // 모든 엣지 위에 관계 라벨을 항상 띄운다. 월드가 아니라 화면 좌표로 그려서
  // 확대해도 글자 크기가 그대로다. 겹치면 곡선의 법선 방향으로 한 칸씩 밀어 자리를 찾는다.

  const LBL_FONT = '600 11.5px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif'
  const LBL_FONT_ON = '700 12.5px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif'
  /** 알약 높이와 좌우 여백 */
  const LBL_H = 19
  const LBL_PAD = 9
  /** 선 위에 글자가 찔리지 않게 기본으로 띄우는 만큼 */
  const LBL_OFF = 11
  /** 겹쳤을 때 한 번에 더 밀어 보는 만큼 */
  const LBL_STEP = 15
  /** 법선 방향으로 밀어 볼 자리. 부호가 어느 쪽인지다. 다 겹치면 첫 자리에 그대로 그린다 */
  const LBL_TRIES = [0, 1, -1, 2, -2, 3, -3, 4, -4]
  /** 곡선 위에서 미끄러뜨려 볼 자리. 가운데를 먼저 본다 */
  const LBL_SLIDE = [0.5, 0.38, 0.62, 0.28, 0.72]
  /** 노드 이름의 폰트. 라벨이 이름을 피할 때도 이 폭을 본다 */
  const NAME_FONT = '600 15px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif'
  const NAME_FONT_ON = '700 16px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif'

  /** 폰트+글자를 키로 폭을 캐싱한다. 재는 김에 ctx.font 도 맞춰 둔다 */
  const measure = (text, font) => {
    ctx.font = font
    const k = `${font}|${text}`
    let w = textW.get(k)
    if (w === undefined) { w = ctx.measureText(text).width; textW.set(k, w) }
    return w
  }

  const overlaps = (a, b) => a.x1 < b.x2 + 2 && b.x1 < a.x2 + 2 && a.y1 < b.y2 + 2 && b.y1 < a.y2 + 2

  /**
   * 라벨 하나의 자리를 잡는다. 곡선의 가운데에서 시작해, 이미 놓인 알약이나 노드와
   * 겹치면 법선 방향으로 밀고 곡선 위에서 미끄러뜨려 첫 빈자리를 고른다.
   */
  function placeLabel(e, placed) {
    const c = ctrl(e)
    const { p1, p2 } = endpoints(e, c)
    // 곡선의 법선. 휜 쪽(bow) 바깥으로 띄운다 — 같은 쌍의 엣지끼리 라벨이 갈라 앉는다
    const side = e.bow < 0 ? -1 : 1

    const on = e === hoverEdge
    const font = on ? LBL_FONT_ON : LBL_FONT
    // 파생이라는 꼬리는 얹었을 때만 붙인다 — 평소에는 점선과 회색 글씨가 그 말을 한다
    const text = on && !e.asserted ? `${e.label} · 추론` : e.label
    const w = measure(text, font) + LBL_PAD * 2
    const h = on ? LBL_H + 3 : LBL_H

    let first = null
    for (const k of LBL_TRIES) {
      const off = (LBL_OFF + Math.abs(k) * LBL_STEP) * (k < 0 ? -1 : 1)
      for (const t of LBL_SLIDE) {
        const m = qpoint(p1, c, p2, t)
        const a = qpoint(p1, c, p2, t - 0.08)
        const b = qpoint(p1, c, p2, t + 0.08)
        const d = Math.max(0.01, Math.hypot(b.x - a.x, b.y - a.y))
        const x = m.x * view.s + view.tx + (-(b.y - a.y) / d) * side * off
        const y = m.y * view.s + view.ty + ((b.x - a.x) / d) * side * off
        const spot = {
          e, text, font, x, y, w, h,
          box: { x1: x - w / 2, y1: y - h / 2, x2: x + w / 2, y2: y + h / 2 },
        }
        first = first || spot
        if (!placed.some((q) => overlaps(q, spot.box))) return spot
      }
    }
    return first
  }

  /**
   * 라벨이 피해야 하는 자리 — 구체와 노드 이름. 이름은 알약 위에 그려지기 때문에
   * 여기서 미리 비켜 두지 않으면 글자가 겹쳐 읽히지 않는다.
   */
  function nodeObstacles() {
    const out = []
    for (const nd of nodes) {
      const r = nd.r * (1 + 0.1 * nd.hot) * view.s
      const x = nd.x * view.s + view.tx
      const y = nd.y * view.s + view.ty
      out.push({ x1: x - r, y1: y - r, x2: x + r, y2: y + r })
      const big = nd.hot > 0.5 || selected.has(nd.id)
      const half = measure(nd.name, big ? NAME_FONT_ON : NAME_FONT) / 2
      const ly = y + r + 17
      out.push({ x1: x - half, y1: ly - 9, x2: x + half, y2: ly + 9 })
    }
    return out
  }

  function paintPill(s) {
    const e = s.e
    const on = e === hoverEdge
    const fresh = marks.edges.has(e.key)
    ctx.save()
    ctx.beginPath()
    const r = s.h / 2
    if (ctx.roundRect) ctx.roundRect(s.x - s.w / 2, s.y - s.h / 2, s.w, s.h, r)
    else ctx.rect(s.x - s.w / 2, s.y - s.h / 2, s.w, s.h)
    ctx.fillStyle = on ? 'rgba(255,255,255,0.97)' : 'rgba(255,255,255,0.86)'
    if (on) {
      ctx.shadowColor = 'rgba(30,40,70,0.18)'
      ctx.shadowBlur = 10
      ctx.shadowOffsetY = 2
    }
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.lineWidth = 1
    ctx.strokeStyle = fresh ? alpha(NEW_GREEN, 0.8)
      : (on ? 'rgba(107,123,224,0.55)' : (e.asserted ? 'rgba(150,158,180,0.42)' : 'rgba(160,168,190,0.34)'))
    ctx.stroke()
    ctx.font = s.font
    ctx.fillStyle = fresh ? '#2E7D32' : (on ? '#4453B8' : (e.asserted ? '#3B4457' : '#7A8296'))
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(s.text, s.x, s.y + 0.5)
    ctx.restore()
  }

  /**
   * 모든 엣지의 라벨을 그린다. 얹은 엣지의 자리를 먼저 잡아 다른 라벨이 비켜 가게 하고,
   * 그리는 것은 거꾸로 돌아 얹은 라벨이 맨 위에 오게 한다.
   *
   * @param {number} w - 화면 너비. 밖으로 나간 라벨은 그리지 않는다
   * @param {number} h - 화면 높이
   * @returns {Object|null} 얹은 엣지의 알약. 노드 이름 위에 한 번 더 그릴 자리다
   */
  function paintEdgeLabels(w, h) {
    const order = hoverEdge ? [hoverEdge, ...edges.filter((e) => e !== hoverEdge)] : edges
    const placed = nodeObstacles()
    const spots = []
    for (const e of order) {
      const s = placeLabel(e, placed)
      // 판 밖으로 나간 라벨은 자리도 차지하지 않는다
      if (s.x < -s.w || s.y < -s.h || s.x > w + s.w || s.y > h + s.h) continue
      placed.push(s.box)
      spots.push(s)
    }
    for (let i = spots.length - 1; i >= 0; i--) paintPill(spots[i])
    return hoverEdge && spots[0]?.e === hoverEdge ? spots[0] : null
  }

  function paintNode(nd) {
    const base = KIND_COLOR[nd.kind] || KIND_COLOR.Character
    const r = nd.r * (1 + 0.1 * nd.hot)   // 얹으면 살짝 커진다
    const x = nd.x
    const y = nd.y

    // 바닥 그림자 — 눌린 타원. 이것이 "떠 있다" 를 만든다
    ctx.save()
    ctx.translate(x, y + r * 0.95)
    ctx.scale(1, 0.3)
    const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.25)
    sg.addColorStop(0, `rgba(28,36,58,${0.26 + 0.08 * nd.hot})`)
    sg.addColorStop(1, 'rgba(28,36,58,0)')
    ctx.fillStyle = sg
    ctx.beginPath()
    ctx.arc(0, 0, r * 1.25, 0, TAU)
    ctx.fill()
    ctx.restore()

    // 새로 생긴 노드는 녹색 테두리를 두른다. 처음 얼마간은 링이 퍼져 나가며 반짝인다
    if (marks.nodes.has(nd.id)) {
      ctx.beginPath()
      ctx.arc(x, y, r + 5, 0, TAU)
      ctx.lineWidth = 2.5
      ctx.strokeStyle = alpha(NEW_GREEN, 0.9)
      ctx.stroke()
      if (marks.t0 && tick - marks.t0 < PULSE_MS) {
        const t = ((tick - marks.t0) % PULSE_CYCLE) / PULSE_CYCLE
        ctx.beginPath()
        ctx.arc(x, y, r + 5 + t * 14, 0, TAU)
        ctx.lineWidth = 3 * (1 - t)
        ctx.strokeStyle = alpha(NEW_GREEN, 0.55 * (1 - t))
        ctx.stroke()
      }
    }

    // 고른 노드는 바깥에 링을 두른다
    if (selected.has(nd.id)) {
      ctx.beginPath()
      ctx.arc(x, y, r + 7, 0, TAU)
      ctx.lineWidth = 3
      ctx.strokeStyle = alpha(base, 0.5)
      ctx.stroke()
    }

    // 구체 본체 — 빛은 왼쪽 위에서 든다
    const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.45, r * 0.05, x, y, r * 1.12)
    g.addColorStop(0, shade(base, 0.62))
    g.addColorStop(0.42, base)
    g.addColorStop(1, shade(base, -0.34))
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.fillStyle = g
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = shade(base, -0.2)
    ctx.stroke()

    // 빛 반사 점
    const hx = x - r * 0.34
    const hy = y - r * 0.4
    const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * 0.34)
    hg.addColorStop(0, 'rgba(255,255,255,0.95)')
    hg.addColorStop(0.55, 'rgba(255,255,255,0.32)')
    hg.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.beginPath()
    ctx.arc(hx, hy, r * 0.34, 0, TAU)
    ctx.fillStyle = hg
    ctx.fill()
  }

  /** 노드 이름. 이것도 화면 좌표다 — 흰 테두리를 깔아 판 위에서 또렷하게 읽힌다 */
  function paintLabel(nd) {
    const r = nd.r * (1 + 0.1 * nd.hot)
    ctx.save()
    const x = nd.x * view.s + view.tx
    const y = nd.y * view.s + view.ty + (r * view.s) + 17
    const big = nd.hot > 0.5 || selected.has(nd.id)
    ctx.font = big ? NAME_FONT_ON : NAME_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 4
    ctx.strokeStyle = 'rgba(255,255,255,0.92)'
    ctx.strokeText(nd.name, x, y)
    ctx.fillStyle = big ? '#111827' : INK
    ctx.fillText(nd.name, x, y)
    ctx.restore()
  }

  /** 새 노드의 NEW 뱃지. 구체의 오른쪽 위에 붙는다 (화면 좌표라 크기가 그대로다) */
  function paintNewBadge(nd) {
    const r = nd.r * (1 + 0.1 * nd.hot) * view.s
    const x = nd.x * view.s + view.tx + r * 0.74 + 5
    const y = nd.y * view.s + view.ty - r * 0.74 - 5
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, 12, 0, TAU)
    ctx.fillStyle = NEW_GREEN
    ctx.shadowColor = 'rgba(20,60,30,0.3)'
    ctx.shadowBlur = 6
    ctx.shadowOffsetY = 1
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.stroke()
    ctx.font = '800 8.5px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif'
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('NEW', x, y + 0.5)
    ctx.restore()
  }

  function paint() {
    tick = performance.now()
    const { w, h } = size()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    paintBackground(w, h)

    ctx.save()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.translate(view.tx, view.ty)
    ctx.scale(view.s, view.s)
    for (const g of ghosts) paintGhost(g)
    for (const e of edges) if (e !== hoverEdge) paintEdge(e)
    if (hoverEdge) paintEdge(hoverEdge)
    for (const nd of nodes) if (nd !== hoverNode) paintNode(nd)
    if (hoverNode) paintNode(hoverNode)
    ctx.restore()

    // 라벨은 화면 좌표로 그린다 — 확대해도 글자 크기가 그대로 읽힌다.
    // 엣지 라벨 → 노드 이름 순이다. 노드 이름이 알약에 가려지지 않게 나중에 그린다
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const hoverPill = paintEdgeLabels(w, h)
    for (const nd of nodes) if (nd !== hoverNode) paintLabel(nd)
    if (hoverNode) paintLabel(hoverNode)
    // 얹은 엣지의 라벨만 이름 위로 올린다 — 지금 읽으려는 것이 그것이다
    if (hoverPill && !hoverNode) paintPill(hoverPill)
    for (const nd of nodes) if (marks.nodes.has(nd.id)) paintNewBadge(nd)
  }

  // ── 프레임 ─────────────────────────────────────────────────────────────────
  function frame() {
    if (dead) return
    raf = requestAnimationFrame(frame)
    let busy = false

    if (anim) {
      const t = clamp((performance.now() - anim.t0) / anim.ms, 0, 1)
      const e = 1 - (1 - t) ** 3
      view = {
        s: anim.from.s + (anim.to.s - anim.from.s) * e,
        tx: anim.from.tx + (anim.to.tx - anim.from.tx) * e,
        ty: anim.from.ty + (anim.to.ty - anim.from.ty) * e,
      }
      if (t >= 1) anim = null
      busy = true
    }
    for (const nd of nodes) {
      const want = nd === hoverNode ? 1 : 0
      if (Math.abs(nd.hot - want) > 0.01) {
        nd.hot += (want - nd.hot) * 0.22
        busy = true
      } else if (nd.hot !== want) {
        nd.hot = want
        busy = true
      }
    }

    // 반짝임과 끊긴 자리의 페이드아웃. 둘 다 끝나면 프레임은 다시 잠든다
    const now = performance.now()
    if (ghosts.length) {
      const alive = ghosts.filter((g) => now - g.t0 < GHOST_MS)
      if (alive.length !== ghosts.length) { ghosts = alive; dirty = true }
      busy = true
    }
    if (marks.t0) {
      if (now - marks.t0 < PULSE_MS) busy = true
      // 반짝임이 끝났다 — 정지한 녹색 테두리로 한 번 더 그려 두고 멈춘다
      else { marks.t0 = 0; dirty = true }
    }
    if (!dirty && !busy) return
    dirty = false
    paint()
  }

  // ── 히트 테스트 ────────────────────────────────────────────────────────────
  function nodeAt(px, py) {
    const p = toWorld(px, py)
    for (let i = nodes.length - 1; i >= 0; i--) {
      const nd = nodes[i]
      if (Math.hypot(nd.x - p.x, nd.y - p.y) <= nd.r + 5) return nd
    }
    return null
  }

  function edgeAt(px, py) {
    const p = toWorld(px, py)
    const near = 7 / view.s
    for (const e of edges) {
      const c = ctrl(e)
      const { p1, p2 } = endpoints(e, c)
      for (let t = 0; t <= 1.0001; t += 1 / 14) {
        const q = qpoint(p1, c, p2, t)
        if (Math.hypot(q.x - p.x, q.y - p.y) <= near) return e
      }
    }
    return null
  }

  // ── 입력 ───────────────────────────────────────────────────────────────────
  const at = (ev) => {
    const b = canvas.getBoundingClientRect()
    return { x: ev.clientX - b.left, y: ev.clientY - b.top }
  }

  const onMove = (ev) => {
    const m = at(ev)
    if (drag) {
      drag.moved = drag.moved || Math.hypot(m.x - drag.sx, m.y - drag.sy) > 3
      if (drag.node) {
        const p = toWorld(m.x, m.y)
        drag.node.x = p.x - drag.ox
        drag.node.y = p.y - drag.oy
        pos.set(drag.node.id, { x: drag.node.x, y: drag.node.y })
      } else {
        view.tx = drag.ox + (m.x - drag.sx)
        view.ty = drag.oy + (m.y - drag.sy)
      }
      kick()
      return
    }
    const nd = nodeAt(m.x, m.y)
    const eg = nd ? null : edgeAt(m.x, m.y)
    if (nd !== hoverNode || eg !== hoverEdge) {
      hoverNode = nd
      hoverEdge = eg
      canvas.style.cursor = nd ? 'pointer' : (eg ? 'help' : 'grab')
      kick()
    }
  }

  const onDown = (ev) => {
    const m = at(ev)
    const nd = nodeAt(m.x, m.y)
    // ox/oy 는 잡은 자리와의 차이다. 노드를 잡았으면 월드 좌표, 빈 자리면 화면 이동값
    if (nd) {
      const p = toWorld(m.x, m.y)
      drag = { node: nd, sx: m.x, sy: m.y, ox: p.x - nd.x, oy: p.y - nd.y, moved: false }
    } else {
      drag = { node: null, sx: m.x, sy: m.y, ox: view.tx, oy: view.ty, moved: false }
    }
    anim = null
    canvas.style.cursor = 'grabbing'
    canvas.setPointerCapture?.(ev.pointerId)
  }

  const onUp = (ev) => {
    if (!drag) return
    const { node, moved } = drag
    drag = null
    canvas.style.cursor = node ? 'pointer' : 'grab'
    if (!moved) {
      if (node) { selected = new Set([node.id]); opts.onPick?.(node.id) }
      else { selected = new Set(); opts.onPick?.(null) }
      kick()
    }
    canvas.releasePointerCapture?.(ev.pointerId)
  }

  const onWheel = (ev) => {
    ev.preventDefault()
    const m = at(ev)
    const before = toWorld(m.x, m.y)
    view.s = clamp(view.s * (ev.deltaY < 0 ? 1.12 : 1 / 1.12), 0.2, 3)
    view.tx = m.x - before.x * view.s
    view.ty = m.y - before.y * view.s
    anim = null
    kick()
  }

  const onLeave = () => {
    if (hoverNode || hoverEdge) { hoverNode = null; hoverEdge = null; kick() }
  }

  const onDouble = () => fit(nodes, { animate: true })

  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('dblclick', onDouble)

  const ro = new ResizeObserver(() => kick())
  ro.observe(host)

  raf = requestAnimationFrame(frame)

  // ── 바깥에서 쓰는 것 ───────────────────────────────────────────────────────
  return {
    /**
     * 판을 갈아 끼운다. 이미 있던 노드는 지금 자리에서 다시 배치해 모양을 잇는다.
     * @param {{nodes: Array, edges: Array}} g - GraphStore.toJSON() 결과
     */
    render(g) {
      const { w, h } = size()
      const known = nodes.length > 0
      byId.clear()
      nodes = (g.nodes || []).map((n) => {
        const old = pos.get(n.id)
        const nd = {
          id: n.id,
          kind: n.kind,
          name: n.name || n.id,
          r: KIND_R[n.kind] || 19,
          x: old?.x,
          y: old?.y,
          hot: 0,
        }
        byId.set(n.id, nd)
        return nd
      })
      const links = []
      edges = []
      const seen = new Map()
      for (const e of g.edges || []) {
        const a = byId.get(e.s)
        const b = byId.get(e.o)
        if (!a || !b || a === b) continue
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
        const n = seen.get(key) || 0
        seen.set(key, n + 1)
        edges.push({
          a, b, p: e.p, props: e.props, asserted: !!e.asserted,
          key: edgeKey(e),
          label: edgeLabel(e.p, e.props),
          // 같은 쌍의 엣지는 번갈아 반대로 휘어 겹치지 않는다
          bow: (0.09 + 0.075 * Math.floor(n / 2)) * (n % 2 ? -1 : 1),
        })
        links.push([a, b])
      }
      layout(nodes, links, w, h, nodes.length > 140 ? 150 : 320)
      for (const nd of nodes) pos.set(nd.id, { x: nd.x, y: nd.y })
      selected = new Set()
      hoverNode = null
      hoverEdge = null
      // 판을 갈아 끼우면 새로 생긴 표시는 지운다. 필요하면 render 다음에 markNew 를 부른다
      marks = { nodes: new Set(), edges: new Set(), t0: 0 }
      ghosts = []
      fit(nodes, { animate: known })
      kick()
    },

    /**
     * 얹힌 카드가 가리는 자리를 알려 준다. 자리를 잡을 때 그만큼 비켜 앉는다.
     * @param {{l?: number, t?: number, r?: number, b?: number}} o - 화면 픽셀
     */
    setInsets(o = {}) {
      insets = { l: o.l || 0, t: o.t || 0, r: o.r || 0, b: o.b || 0 }
      if (nodes.length) fit(nodes, { animate: true })
    },

    /**
     * 역기입으로 자란 자리를 판에 표시한다. graphDelta 의 결과를 그대로 받는다.
     * render 다음에 부른다 — 판을 갈아 끼울 때 표시가 지워지기 때문이다.
     *
     * @param {{nodes?: Array<string>, edges?: Array<string>, removed?: Array<{s: string, o: string, p: string}>}} delta
     */
    markNew(delta = {}) {
      const t0 = performance.now()
      marks = {
        nodes: new Set((delta.nodes || []).filter((id) => byId.has(id))),
        edges: new Set(delta.edges || []),
        t0,
      }
      // 끊긴 자리는 양끝 노드가 아직 판에 있을 때만 남긴다
      ghosts = (delta.removed || []).map((e) => {
        const a = byId.get(e.s)
        const b = byId.get(e.o)
        return a && b && a !== b ? { a, b, p: e.p, bow: 0.09, t0 } : null
      }).filter(Boolean)
      kick()
    },

    /** 새로 생긴 표시를 지운다 */
    clearNew() {
      marks = { nodes: new Set(), edges: new Set(), t0: 0 }
      ghosts = []
      kick()
    },

    /** 씨앗의 초점 노드로 시선을 옮긴다. 고른 표시(링)도 여기서 켜진다 */
    focus(ids) {
      const list = (ids || []).map((id) => byId.get(id)).filter(Boolean)
      if (!list.length) return
      selected = new Set(list.map((nd) => nd.id))
      fit(list, { animate: true, maxScale: 1.1, pad: 220 })
    },

    destroy() {
      dead = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDouble)
      canvas.remove()
    },
  }
}
