// 관계 그래프 위에서 도는 두 가지: 규칙과 검증.
//
// 온톨로지 전체(클래스 계층, 범용 추론기)는 여기 없다. 이 세계에서 실제로 값을 하는
// 두 조각만 있다.
//
//   EDGE_KINDS  술어마다 정의역·치역·affect. 역기입 엣지를 받을지 말지 정하는 근거다.
//   RULES       "같은 사람을 사랑하는 둘은 경쟁한다" 같은 드라마 지식. 아무도 타이핑하지
//               않은 관계를 만들어내는 유일한 부분이고, 기획자가 JS를 안 건드리고 늘릴 수 있다.
//
// 역관계·대칭·추이 공리는 별도 기계로 두지 않았다. 필요한 것은 규칙으로 쓰면 되고
// (rival_is_mutual 참고), 그러면 메커니즘이 하나로 유지된다.

export const NODE_KINDS = {
  Character: '행위자',
  Faction: '집단',
  Location: '장소',
  Event: '사건',
  Secret: '명제형 비밀',
  Object: '사물',
}

const C = ['Character']
const CF = ['Character', 'Faction']

// 선언된 술어만 그래프에 들어간다. 생성물이 새 술어를 제안하면 검토 대기로 빠지고,
// 사람이 여기 추가할지 판단한다. 스키마는 자동으로 자라지 않는다.
export const EDGE_KINDS = {
  member_of: { domain: C, range: ['Faction'] },
  mentor_of: { domain: C, range: C },
  manages: { domain: C, range: CF },
  maintains: { domain: CF, range: ['Location'] },
  performs_at: { domain: CF, range: ['Location'] },
  participated_in: { domain: C, range: ['Event'] },
  serves: { domain: C, range: CF },
  loves: { domain: C, range: C, affect: 1 },
  rival_of: { domain: C, range: C, affect: -1 },
  distrusts: { domain: C, range: C, affect: -1 },
  conceals: { domain: C, range: ['Secret'] },
  knows: { domain: C, range: ['Secret'] },
  hidden_from: { domain: ['Secret'], range: C },
  concerns: { domain: ['Secret'], range: ['Character', 'Event'] },
  affects: { domain: ['Event'], range: ['Location', 'Character', 'Faction'] },
  caused: { domain: ['Event'], range: ['Event'] },
  resolves: { domain: ['Event'], range: ['Event'] },
  has_leverage_over: { domain: C, range: C, note: '규칙 결론' },
  implicated_in: { domain: C, range: ['Event'], note: '규칙 결론. 참여가 아니라 연루다' },
}

export const RULES = [
  {
    id: 'rival_is_mutual',
    desc: '경쟁은 한쪽만 성립하지 않는다',
    when: [['?a', 'rival_of', '?b']],
    then: ['?b', 'rival_of', '?a'],
  },
  {
    id: 'rival_by_shared_love',
    desc: '같은 대상을 사랑하는 두 사람은 경쟁 관계가 된다',
    when: [['?a', 'loves', '?c'], ['?b', 'loves', '?c']],
    distinct: [['?a', '?b']],
    then: ['?a', 'rival_of', '?b'],
    props: { tension: 0.6 },
  },
  {
    id: 'rival_by_possession',
    desc: '내가 사랑하는 사람을 소유한 쪽은 나의 경쟁자가 된다',
    when: [['?a', 'loves', '?b'], ['?b', 'serves', '?c']],
    distinct: [['?a', '?c']],
    then: ['?c', 'rival_of', '?a'],
    props: { tension: 0.75 },
  },
  {
    id: 'leverage_by_secret',
    desc: '남이 감추는 비밀을 아는 사람은 그를 쥐고 있다',
    when: [['?a', 'knows', '?s'], ['?b', 'conceals', '?s']],
    distinct: [['?a', '?b']],
    then: ['?a', 'has_leverage_over', '?b'],
    props: { tension: 0.9 },
  },
  {
    id: 'implicated_by_secret',
    desc: '감춘 본성을 가진 인물은 자기 팀이 지키는 장소에 생긴 사건에 연루된다',
    when: [
      ['?s', 'concerns', '?a'],
      ['?a', 'member_of', '?f'],
      ['?f', 'maintains', '?loc'],
      ['?e', 'affects', '?loc'],
    ],
    then: ['?a', 'implicated_in', '?e'],
    props: { tension: 0.85 },
  },
]

const MAX_ROUNDS = 20
const isVar = (t) => typeof t === 'string' && t.charCodeAt(0) === 63
const key = (s, p, o) => `${s} ${p} ${o}`

function bind(b, term, val) {
  if (!isVar(term)) return term === val
  if (b[term] === undefined) {
    b[term] = val
    return true
  }
  return b[term] === val
}

// 패턴 목록을 엣지 집합에 조인한다. 변수는 ?로 시작하고, 나머지는 상수로 취급한다.
function solve(patterns, edges) {
  let rows = [{}]
  for (const [ps, pp, po] of patterns) {
    const next = []
    for (const row of rows) {
      for (const e of edges) {
        const b = { ...row }
        if (bind(b, ps, e.s) && bind(b, pp, e.p) && bind(b, po, e.o)) next.push(b)
      }
    }
    rows = next
    if (!rows.length) break
  }
  return rows
}

// 규칙을 고정점까지 적용한다. 결론이 다른 규칙의 입력이 되므로 라운드를 돈다.
// 어휘가 유한하고 중복을 걸러내므로 멈춘다. MAX_ROUNDS는 규칙을 잘못 쓴 경우의 안전장치다.
export function apply(nodes, edges) {
  const all = edges.map((e) => ({ ...e, asserted: true }))
  const seen = new Set(all.map((e) => key(e.s, e.p, e.o)))
  const fired = {}
  for (const r of RULES) fired[r.id] = 0

  let rounds = 0
  for (;;) {
    if (++rounds > MAX_ROUNDS) throw new Error(`규칙이 ${MAX_ROUNDS}라운드에 수렴하지 않았다`)
    const added = []
    for (const r of RULES) {
      for (const b of solve(r.when, all)) {
        if (r.distinct && r.distinct.some(([x, y]) => b[x] === b[y])) continue
        const s = isVar(r.then[0]) ? b[r.then[0]] : r.then[0]
        const p = isVar(r.then[1]) ? b[r.then[1]] : r.then[1]
        const o = isVar(r.then[2]) ? b[r.then[2]] : r.then[2]
        const k = key(s, p, o)
        if (seen.has(k)) continue
        seen.add(k)
        added.push({ s, p, o, asserted: false, derived_by: r.id, props: { ...(r.props || {}) } })
        fired[r.id]++
      }
    }
    if (!added.length) break
    all.push(...added)
  }
  return { edges: all, fired, rounds: rounds - 1 }
}

// 엣지가 스키마에 맞는지. 역기입 게이트가 쓰는 함수다.
// 반환하는 code는 세 가지: 술어 미선언, 노드 미해결, 정의역·치역 위반.
export function validate(nodes, edges) {
  const kindOf = new Map()
  for (const n of nodes) {
    kindOf.set(n.id, n.kind)
    kindOf.set(n.name, n.kind)
  }
  const out = []
  for (const e of edges) {
    const spec = EDGE_KINDS[e.p]
    if (!spec) {
      out.push({ edge: e, code: 'undeclared_predicate', detail: e.p })
      continue
    }
    const sk = kindOf.get(e.s)
    const ok = kindOf.get(e.o)
    if (sk === undefined || ok === undefined) {
      out.push({ edge: e, code: 'unresolved_node', detail: sk === undefined ? e.s : e.o })
      continue
    }
    if (!spec.domain.includes(sk)) {
      out.push({ edge: e, code: 'domain', detail: `${e.p}의 정의역은 ${spec.domain.join('|')}인데 ${sk}` })
    } else if (!spec.range.includes(ok)) {
      out.push({ edge: e, code: 'range', detail: `${e.p}의 치역은 ${spec.range.join('|')}인데 ${ok}` })
    }
  }
  return out
}

// 한 분기의 역기입을 게이트에 통과시킨다. 분기가 새로 만드는 노드는 이미 있는 것으로 간주한다.
export function checkWriteback(nodes, writeback) {
  const merged = nodes.concat((writeback.nodes || []).map((n) => ({ id: n.name, name: n.name, kind: n.kind })))
  const problems = validate(merged, writeback.edges)
  return { total: writeback.edges.length, problems, passed: writeback.edges.length - problems.length }
}

// ── 탐지기 ────────────────────────────────────────────────────────────────
// 그래프의 구조적 공백을 찾는다. 점수는 논리가 아니라 정책이다: 무엇이 참인지가 아니라
// 무엇이 이야기로 급한지를 말한다. 그래서 규칙과 분리되어 있고, 가중치는 조정 대상이다.

const BASE = { love_triangle: 0.75, secret_leverage: 0.6, dangling_consequence: 0.55 }
const W_FOCUS = 0.08
const W_TENSION = 0.4
const W_DERIVED = 0.12

function score(probe, focus, matched, extra = 0) {
  const tension = matched.reduce((m, e) => Math.max(m, e.props?.tension || 0), 0)
  const derived = matched.some((e) => !e.asserted)
  const parts = {
    base: BASE[probe],
    focus: W_FOCUS * focus.length,
    tension: W_TENSION * tension,
    derived: derived ? W_DERIVED : 0,
    extra,
  }
  const total = Object.values(parts).reduce((a, b) => a + b, 0)
  return { parts, total: Math.round(total * 100) / 100 }
}

const sid = (probe, anchors) => `${probe}:${[...anchors].sort().join('+')}`

export function probes(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const nm = (id) => byId.get(id)?.name || id
  const out = []

  // 1. 삼각: 한 인물에게 서로 다른 두 곳에서 감정 엣지가 들어온다. affect는 EDGE_KINDS 선언에서 읽는다.
  const incoming = new Map()
  for (const e of edges) {
    if (!EDGE_KINDS[e.p]?.affect) continue
    if (!incoming.has(e.o)) incoming.set(e.o, [])
    incoming.get(e.o).push(e)
  }
  for (const [target, list] of incoming) {
    const sources = [...new Set(list.map((e) => e.s))]
    if (sources.length < 2) continue
    const matched = list.filter((e, i) => list.findIndex((x) => x.s === e.s) === i)
    const focus = [target, ...sources]
    out.push({
      id: sid('love_triangle', focus),
      probe: 'love_triangle',
      focus,
      matched,
      title: `${nm(target)}를 축으로 한 삼각: ${sources.map(nm).join(' · ')}`,
      desc: matched
        .map((e) => `${nm(e.s)} ${e.p}${e.asserted ? '' : ` (${e.derived_by} 규칙)`}`)
        .join(', '),
      ...score('love_triangle', focus, matched),
    })
  }

  // 2. 비밀에 의한 우위: 감추는 사람이 있고, 아는 사람이 따로 있고, 모르는 사람이 있다.
  for (const s of nodes.filter((n) => n.kind === 'Secret')) {
    const concealers = edges.filter((e) => e.p === 'conceals' && e.o === s.id).map((e) => e.s)
    const knowers = edges.filter((e) => e.p === 'knows' && e.o === s.id).map((e) => e.s)
    const hiddenFrom = edges.filter((e) => e.p === 'hidden_from' && e.s === s.id).map((e) => e.o)
    const outsiders = knowers.filter((k) => !concealers.includes(k))
    if (!outsiders.length || !hiddenFrom.length) continue
    const leverage = edges.filter((e) => e.p === 'has_leverage_over' && concealers.includes(e.o))
    const focus = [...concealers, ...outsiders, s.id]
    out.push({
      id: sid('secret_leverage', [s.id]),
      probe: 'secret_leverage',
      focus,
      matched: leverage,
      title: `${hiddenFrom.map(nm).join('와 ')}만 모르는 것: ${s.name}`,
      desc: `${outsiders.map(nm).join('과 ')}는 알고, ${hiddenFrom.map(nm).join('와 ')}는 모른다`,
      ...score('secret_leverage', focus, leverage, 0.06 * hiddenFrom.length),
    })
  }

  // 3. 미회수 결과: 결과 엣지가 나가지 않는 사건. 최근일수록 급하다.
  for (const ev of nodes.filter((n) => n.kind === 'Event')) {
    if (edges.some((e) => e.s === ev.id && (e.p === 'caused' || e.p === 'resolves'))) continue
    const linked = edges.filter((e) => e.o === ev.id || e.s === ev.id)
    const focus = [ev.id, ...new Set(linked.map((e) => (e.s === ev.id ? e.o : e.s)))]
    const t = ev.props?.t ?? 0
    out.push({
      id: sid('dangling_consequence', [ev.id]),
      probe: 'dangling_consequence',
      focus,
      matched: linked,
      title: `결과가 기록되지 않은 사건: ${ev.name}${t ? ` (t=${t})` : ' (t=0)'}`,
      desc: `${ev.props?.desc ? ev.props.desc + '. ' : ''}이 사건에서 나가는 caused 엣지가 없다`,
      ...score('dangling_consequence', focus, linked, 0.3 * (1 - Math.min(1, Math.abs(t) / 400))),
    })
  }

  return out.sort((a, b) => b.total - a.total)
}
