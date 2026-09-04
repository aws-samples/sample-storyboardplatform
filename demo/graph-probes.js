
// 씨앗 탐지기 12종.
//
// 그래프에서 "이야기가 될 만한 구조적 결함"을 패턴으로 찾는다. 결함이란 비밀이
// 한쪽에만 있거나, 긴장이 해소되지 않았거나, 사건의 값이 치러지지 않은 자리다.
// 각 탐지기는 GraphStore 하나를 받아 mock/seeds.json 과 같은 모양의 씨앗 배열을
// 돌려준다: {probe, score, title, desc, focus}
//
// 씨앗이 0개인 것도 정상이다. 관계가 얇은 대본에서는 아무것도 안 나온다.

import { josa } from './core.js'

const asList = (v) => (Array.isArray(v) ? v : [])

/**
 * 탐지기 목록. weight 는 스코어 가중치(드라마성이 큰 패턴에 1.2),
 * label 은 UI 태그, hint 는 컨텍스트 팩에 넣는 "이 결함이 왜 이야기인가" 한 줄.
 */
export const PROBES = {
  secret_leverage: {
    weight: 1.2, label: '비밀의 칼자루',
    hint: '아는 사람과 모르는 사람이 갈린 비밀이다. 폭로 시점이 곧 사건이 된다.',
  },
  love_triangle: {
    weight: 1.2, label: '삼각 연정',
    hint: '한 사람을 두고 마음이 겹친다. 셋 중 누구도 물러나지 않으면 반드시 깨진다.',
  },
  unresolved_tension: {
    weight: 1, label: '풀리지 않은 갈등',
    hint: '긴장은 높은데 두 사람이 함께 겪은 사건이 없다. 부딪힐 자리가 아직 안 만들어졌다.',
  },
  chekhov_object: {
    weight: 1, label: '회수되지 않은 복선',
    hint: '등장했는데 아무 일도 일으키지 않은 물건이다. 언젠가는 발사돼야 한다.',
  },
  strangers_shared_past: {
    weight: 1, label: '스쳐간 인연',
    hint: '같은 사건에 있었는데 서로 관계가 없다. 한쪽이 먼저 알아보는 순간이 사건이 된다.',
  },
  severed_bond: {
    weight: 1, label: '갈라선 사제',
    hint: '가르친 관계가 끊어진 채 남아 있다. 화해도 결별도 아직 기록되지 않았다.',
  },
  dangling_consequence: {
    weight: 1, label: '치르지 않은 대가',
    hint: '사건이 있었는데 그 뒤가 그래프에 없다. 아직 아무도 값을 치르지 않았다.',
  },
  contested_goal: {
    weight: 1, label: '같은 것을 원하는 자들',
    hint: '여러 사람이 같은 것을 원한다. 하나뿐이면 나머지는 잃는다.',
  },
  betrayal_potential: {
    weight: 1.2, label: '안에서 갈라지는 충성',
    hint: '섬기는 주인의 적과 이미 얽혀 있다. 어느 쪽을 택해도 배신이 된다.',
  },
  identity_crisis: {
    weight: 1, label: '두 얼굴의 소속',
    hint: '자기가 무엇인지 스스로 감추거나, 서로 적인 곳에 동시에 속해 있다.',
  },
  forbidden_bond: {
    weight: 1.2, label: '금지된 관계',
    hint: '사랑해선 안 될 상대다. 관계를 지키려면 소속이나 계약을 버려야 한다.',
  },
  power_vacuum: {
    weight: 1, label: '빈 자리의 무게',
    hint: '이끄는 자리가 비어 있다. 누가 그 자리를 채우느냐가 다음 갈등이다.',
  },
}

const round2 = (n) => Math.round(n * 100) / 100
const cap2 = (n) => Math.min(2, Math.max(0, round2(n)))
const uniq = (list) => [...new Set(asList(list).filter(Boolean))]

/** 엣지의 긴장도. 없으면 기본값 */
const ten = (e, dflt = 0.5) => {
  const n = Number(e?.props?.tension)
  return Number.isFinite(n) ? n : dflt
}

const nameOf = (store, id) => store.getNode(id)?.name || String(id)
const namesOf = (store, ids) => uniq(ids).map((id) => nameOf(store, id)).join('·')
const kindOf = (store, id) => store.getNode(id)?.kind || ''
const isChar = (store, id) => kindOf(store, id) === 'Character'
const tOf = (store, id) => {
  const n = Number(store.getNode(id)?.props?.t)
  return Number.isFinite(n) ? n : 0
}

/**
 * 씨앗 하나를 만든다. focus 는 실제로 있는 노드 id 만 남긴다.
 * 스코어는 raw × 가중치를 0~2 로 자른 값이다.
 */
const mk = (store, probe, raw, title, desc, focus) => ({
  probe,
  score: cap2(raw * (PROBES[probe]?.weight ?? 1)),
  title,
  desc,
  focus: uniq(focus).filter((id) => !!store.getNode(id)).slice(0, 6),
})

/** 같은 탐지기 안에서 초점이 같은 씨앗은 하나만 남기고, 점수 높은 것부터 자른다 */
const trim = (seeds, limit) => {
  const seen = new Set()
  const out = []
  for (const s of [...seeds].sort((a, b) => b.score - a.score)) {
    const key = [...s.focus].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= limit) break
  }
  return out
}

/** 이 노드가 참여한 Event id 집합 */
const eventsOf = (store, id) => new Set(store.getEdgesFrom(id)
  .filter((e) => e.p === 'participated_in')
  .map((e) => e.o)
  .filter((o) => kindOf(store, o) === 'Event'))

/** 두 사람이 함께 있었던 사건이 있나 */
const sharedEvent = (store, a, b) => {
  const mine = eventsOf(store, a)
  for (const id of eventsOf(store, b)) if (mine.has(id)) return id
  return null
}

/** 두 노드 사이에 방향 상관없이 엣지가 하나라도 있나 */
const linked = (store, a, b) => store.getEdgesBetween(a, b).length > 0

/** 이 노드와 rival_of 로 걸린 상대들. rival_of 는 대칭이라 양방향을 본다 */
const rivalsOf = (store, id) => store.getEdgesByPredicate('rival_of')
  .filter((e) => e.s === id || e.o === id)
  .map((e) => ({ id: e.s === id ? e.o : e.s, edge: e }))

/** 이 인물을 지키거나 이 인물이 매인 쪽 — 금지된 관계·배신 판정의 기준점 */
const guardiansOf = (store, id) => uniq([
  ...store.getEdgesFrom(id).filter((e) => e.p === 'serves' || e.p === 'mentor_of').map((e) => e.o),
  ...store.getEdgesTo(id).filter((e) => e.p === 'mentor_of').map((e) => e.s),
])

/** 긴장이 가장 센 이웃 인물. 씨앗의 focus 를 넓힐 때 쓴다 */
const hotNeighbor = (store, id, skip = new Set()) => {
  const cand = [...store.getEdgesFrom(id), ...store.getEdgesTo(id)]
    .map((e) => ({ other: e.s === id ? e.o : e.s, t: ten(e, 0) }))
    .filter((x) => !skip.has(x.other) && isChar(store, x.other))
    .sort((a, b) => b.t - a.t)
  return cand[0]?.other || null
}

/**
 * 1. 당사자에게만 숨겨진 비밀. 아는 쪽이 감춘 쪽의 목을 쥔다.
 * @param {Object} store - GraphStore
 * @returns {Array<Object>} 씨앗 배열
 */
export function probeSecretLeverage(store) {
  const out = []
  for (const s of store.getNodes({ kind: 'Secret' })) {
    const inbound = store.getEdgesTo(s.id)
    const holders = uniq(inbound.filter((e) => e.p === 'conceals').map((e) => e.s))
    const knowers = uniq(inbound.filter((e) => e.p === 'knows').map((e) => e.s))
      .filter((id) => !holders.includes(id))
    const hidden = uniq(store.getEdgesFrom(s.id).filter((e) => e.p === 'hidden_from').map((e) => e.o))
    if (!knowers.length || (!hidden.length && !holders.length)) continue

    const raw = 0.6 + 0.15 * Math.min(4, knowers.length) + 0.1 * Math.min(4, hidden.length)
    const title = hidden.length
      ? `${namesOf(store, hidden)}만 모르는 것: ${s.name}`
      : `${namesOf(store, knowers)}가 쥐고 있는 것: ${s.name}`
    const claim = String(s.props?.claim || '').trim()
    const desc = [
      knowers.length ? `${namesOf(store, knowers)}${josa(namesOf(store, knowers), '은', '는')} 알고` : null,
      hidden.length ? `${namesOf(store, hidden)}${josa(namesOf(store, hidden), '은', '는')} 모른다` : null,
      claim ? `— "${claim}"` : null,
    ].filter(Boolean).join(', ').replace(', —', ' —')
    out.push(mk(store, 'secret_leverage', raw, title, desc, [...holders, ...knowers, s.id]))
  }
  return trim(out, 6)
}

/**
 * 2. 한 사람을 두고 마음이 겹치는 삼각. 공유형·연쇄형·연쇄추론형 세 가지를 본다.
 * @param {Object} store - GraphStore
 * @returns {Array<Object>} 씨앗 배열
 */
export function probeLoveTriangle(store) {
  const out = []
  const affection = [...store.getEdgesByPredicate('loves'), ...store.getEdgesByPredicate('drawn_to')]

  // 공유형: 같은 사람을 둘 이상이 마음에 둔다
  const suitors = new Map()
  for (const e of affection) {
    const cur = suitors.get(e.o) || new Map()
    if (!cur.has(e.s) || ten(cur.get(e.s)) < ten(e)) cur.set(e.s, e)
    suitors.set(e.o, cur)
  }
  for (const [target, byWho] of suitors) {
    const list = [...byWho.entries()]
    if (list.length < 2) continue
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, ea] = list[i]
        const [b, eb] = list[j]
        const raw = 0.85 + 0.5 * Math.max(ten(ea), ten(eb))
        out.push(mk(store, 'love_triangle', raw,
          `${nameOf(store, target)}${josa(nameOf(store, target), '을', '를')} 축으로 한 삼각: ${nameOf(store, a)} · ${nameOf(store, b)}`,
          `${nameOf(store, a)}→${nameOf(store, target)}←${nameOf(store, b)}. 같은 자리를 둘이 겹쳐 잡는다`,
          [target, a, b]))
      }
    }
  }

  // 연쇄형: A→B→C 로 마음이 한 방향으로만 흐른다
  for (const first of affection) {
    for (const second of affection) {
      if (second.s !== first.o || second.o === first.s) continue
      const raw = 0.8 + 0.5 * Math.max(ten(first), ten(second))
      out.push(mk(store, 'love_triangle', raw,
        `${nameOf(store, first.o)}${josa(nameOf(store, first.o), '을', '를')} 축으로 한 삼각: ${nameOf(store, first.s)} · ${nameOf(store, second.o)}`,
        `${nameOf(store, first.s)}→${nameOf(store, first.o)}→${nameOf(store, second.o)}. 마음이 한 방향으로만 흐른다`,
        [first.o, first.s, second.o]))
    }
  }

  // 추론형: love_chain 규칙이 만든 rival_of. 가운데 인물(props.via)을 두고 둘이 맞선다
  for (const e of store.getEdgesByPredicate('rival_of')) {
    const via = e.props?.via
    if (e.props?.derived_by !== 'love_chain' || !via || !store.getNode(via)) continue
    out.push(mk(store, 'love_triangle', 0.85 + 0.5 * ten(e),
      `${nameOf(store, via)}${josa(nameOf(store, via), '을', '를')} 축으로 한 삼각: ${nameOf(store, e.s)} · ${nameOf(store, e.o)}`,
      `${nameOf(store, e.s)}↔${nameOf(store, e.o)}가 ${nameOf(store, via)}${josa(nameOf(store, via), '을', '를')} 두고 겹친다. 연정과 소유가 같은 자리를 잡는다`,
      [via, e.s, e.o]))
  }

  return trim(out, 6)
}

/**
 * 3. 긴장은 센데 두 사람이 함께 겪은 사건이 없는 관계.
 * 파생 엣지는 보지 않는다. 추론으로 만든 긴장까지 세면 같은 갈등이 여러 번 잡힌다.
 * @param {Object} store - GraphStore
 * @returns {Array<Object>} 씨앗 배열
 */
export function probeUnresolvedTension(store) {
  const out = []
  for (const e of store.getEdges({ asserted: true })) {
    const t = ten(e, 0)
    if (t < 0.6) continue
    if (!isChar(store, e.s) || !isChar(store, e.o)) continue
    if (sharedEvent(store, e.s, e.o)) continue
    out.push(mk(store, 'unresolved_tension', 0.35 + 0.65 * t,
      `해소되지 않은 긴장: ${nameOf(store, e.s)} ↔ ${nameOf(store, e.o)}`,
      `${nameOf(store, e.s)} ${e.p} ${nameOf(store, e.o)} (긴장 ${t}). 두 사람이 함께 있었던 사건이 없다`,
      [e.s, e.o]))
  }
  return trim(out, 6)
}

/**
 * 4. 등장했지만 아무 일도 일으키지 않은 사물. 체호프의 총.
 * @param {Object} store - GraphStore
 * @returns {Array<Object>} 씨앗 배열
 */
export function probeChekovObject(store) {
  const out = []
  for (const o of store.getNodes({ kind: 'Object' })) {
    const from = store.getEdgesFrom(o.id)
    const to = store.getEdgesTo(o.id)
    if (from.some((e) => e.p === 'caused' || e.p === 'enabled')) continue
    if (to.some((e) => e.p === 'uses')) continue
    const holders = uniq(to.map((e) => e.s))
    const raw = 0.5 + 0.1 * Math.min(3, holders.length)
    out.push(mk(store, 'chekhov_object', raw,
      `회수되지 않은 사물: ${o.name}`,
      holders.length
        ? `${namesOf(store, holders)}${josa(namesOf(store, holders), '과', '와')} 얽혀 있는데 이 물건이 일으킨 사건이 없다`
        : '아직 아무 관계도 붙지 않았다. 놓여만 있는 물건이다',
      [o.id, ...holders]))
  }
  return trim(out, 6)
}

/**
 * 5. 같은 사건에 있었는데 서로 아무 관계가 없는 두 사람.
 * @param {Object} store - GraphStore
 * @returns {Array<Object>} 씨앗 배열
 */
export function probeStrangersSharedPast(store) {
  const out = []
  for (const ev of store.getNodes({ kind: 'Event' })) {
    const cast = uniq(store.getEdgesTo(ev.id)
      .filter((e) => e.p === 'participated_in')
      .map((e) => e.s)
      .filter((id) => isChar(store, id)))
    for (let i = 0; i < cast.length; i++) {
      for (let j = i + 1; j < cast.length; j++) {
        const [a, b] = [cast[i], cast[j]]
        if (linked(store, a, b)) continue
        const past = tOf(store, ev.id) < 0
        out.push(mk(store, 'strangers_shared_past', 0.5 + (past ? 0.15 : 0.05) + 0.1 * Math.min(3, cast.length - 2),
          `같은 자리에 있었지만 남인 둘: ${nameOf(store, a)} · ${nameOf(store, b)}`,
          `${ev.name}에 함께 있었는데 두 사람 사이에 관계 엣지가 없다`,
          [a, b, ev.id]))
      }
    }
  }
  return trim(out, 6)
}

/**
 * 6. 끊어진 채 남아 있는 사제 관계. 화해도 결별도 기록되지 않은 것만.
 * @param {Object} store - GraphStore
 * @returns {Array<Object>} 씨앗 배열
 */
export function probeSeveredBond(store) {
  const out = []
  for (const e of store.getEdgesByPredicate('mentor_of')) {
    const t = ten(e, 0)
    const status = String(e.props?.status || e.props?.state || '')
    const backlash = store.getEdgesBetween(e.s, e.o)
      .filter((x) => x.p === 'distrusts' || x.p === 'estranged_from')
    const broken = t >= 0.7 || status === 'broken' || backlash.length > 0
    if (!broken) continue
    if (sharedEvent(store, e.s, e.o)) continue
    const why = status === 'broken' ? 'props.status 가 broken 이다'
      : backlash.length ? `${backlash[0].p} 엣지가 함께 서 있다`
        : `긴장 ${t}`
    out.push(mk(store, 'severed_bond', 0.55 + 0.45 * Math.max(t, backlash.length ? 0.7 : 0),
      `끊어진 사제: ${nameOf(store, e.s)} → ${nameOf(store, e.o)}`,
      `${why}. 화해도 결별도 사건으로 기록되지 않았다`,
      [e.s, e.o]))
  }
  return trim(out, 6)
}

/** 사건의 뒤끝. 이 중 하나라도 나가면 값이 치러진 것으로 본다 */
const CONSEQUENCE = new Set(['caused', 'enabled', 'resolves'])

/**
 * 7. 결과가 기록되지 않은 사건. 나가는 caused·enabled·resolves 가 하나도 없는 Event.
 * @param {Object} store - GraphStore
 * @returns {Array<Object>} 씨앗 배열
 */
export function probeDanglingConsequence(store) {
  const out = []
  for (const ev of store.getNodes({ kind: 'Event' })) {
    if (store.getEdgesFrom(ev.id).some((e) => CONSEQUENCE.has(e.p))) continue
    const cast = uniq(store.getEdgesTo(ev.id).filter((e) => e.p === 'participated_in').map((e) => e.s))
    const t = tOf(store, ev.id)
    const raw = 0.7 + (t >= 0 ? 0.35 : 0.2) + 0.1 * Math.min(3, cast.length)
    const skip = new Set([ev.id, ...cast])
    const around = cast.map((id) => hotNeighbor(store, id, skip)).filter(Boolean)
    out.push(mk(store, 'dangling_consequence', raw,
      t < 0
        ? `${-t}년째 값이 치러지지 않은 사건: ${ev.name}`
        : `결과가 기록되지 않은 사건: ${ev.name} (t=${t})`,
      `t=${t}. 이 사건에서 나가는 결과 엣지가 하나도 없다`,
      [ev.id, ...cast, ...around]))
  }
  return trim(out, 8)
}

/** 목표를 적어 두는 props 키 후보 */
const WANT_KEYS = ['want', 'goal', 'desire', 'wants']

/**
 * 8. 여러 사람이 같은 것을 원한다. props 의 목표가 같거나, 같은 대상을 노리거나 쓴다.
 * @param {Object} store - GraphStore
 * @returns {Array<Object>} 씨앗 배열
 */
export function probeContestedGoal(store) {
  const out = []
  const add = (who, label, focus, raw) => {
    if (who.length < 2) return
    out.push(mk(store, 'contested_goal', raw,
      `같은 것을 원하는 ${who.length}명: ${label}`,
      `${namesOf(store, who)}${josa(namesOf(store, who), '이', '가')} 같은 것을 놓고 겹친다. 하나뿐이면 나머지는 잃는다`,
      [...who, ...focus]))
  }

  // props 에 적힌 목표가 글자까지 같은 경우
  const byWant = new Map()
  for (const c of store.getNodes({ kind: 'Character' })) {
    for (const k of WANT_KEYS) {
      const v = String(c.props?.[k] ?? '').replace(/\s+/g, ' ').trim()
      if (v.length < 2) continue
      const key = v.toLowerCase()
      byWant.set(key, { label: v, who: [...(byWant.get(key)?.who || []), c.id] })
      break
    }
  }
  for (const { label, who } of byWant.values()) add(uniq(who), label, [], 0.6 + 0.15 * Math.min(3, who.length))

  // 같은 대상을 노리거나 같은 물건을 쓴다
  for (const p of ['targets', 'uses']) {
    const byTarget = new Map()
    for (const e of store.getEdgesByPredicate(p)) {
      if (!isChar(store, e.s)) continue
      byTarget.set(e.o, uniq([...(byTarget.get(e.o) || []), e.s]))
    }
    for (const [target, who] of byTarget) {
      add(who, nameOf(store, target), [target], 0.6 + 0.15 * Math.min(3, who.length))
    }
  }
  return trim(out, 6)
}

/** 배신의 실마리가 되는 관계. 섬기는 자가 적과 이런 걸로 얽혀 있으면 위험하다 */
const BOND = { knows: '아는 사이', loves: '연정', drawn_to: '끌림', member_of: '같은 소속', kin_of: '친족', protects: '보호', remembers: '기억', serves: '이중 계약' }

/**
 * 9. 섬기는 주인의 적과 이미 얽혀 있는 내부자.
 * @param {Object} store - GraphStore
 * @returns {Array<Object>} 씨앗 배열
 */
export function probeBetrayalPotential(store) {
  const out = []
  for (const sv of store.getEdgesByPredicate('serves')) {
    for (const { id: foe, edge: rival } of rivalsOf(store, sv.o)) {
      if (foe === sv.s) continue
      const bonds = store.getEdgesBetween(sv.s, foe).filter((e) => BOND[e.p])
      if (!bonds.length) continue
      const bond = bonds.sort((a, b) => ten(b) - ten(a))[0]
      const raw = 0.65 + 0.35 * Math.max(ten(sv), ten(bond), ten(rival, 0))
      out.push(mk(store, 'betrayal_potential', raw,
        `안에서 갈라지는 충성: ${nameOf(store, sv.s)}`,
        `${nameOf(store, sv.s)}${josa(nameOf(store, sv.s), '은', '는')} ${nameOf(store, sv.o)}${josa(nameOf(store, sv.o), '을', '를')} 섬기는데, 그 적인 ${nameOf(store, foe)}${josa(nameOf(store, foe), '과', '와')} 이미 얽혀 있다 — ${BOND[bond.p]}`,
        [sv.s, sv.o, foe]))
    }
  }
  return trim(out, 6)
}

/**
 * 10. 정체성 갈등. 서로 적인 곳에 동시에 속했거나, 자기에 관한 비밀을 자기가 감춘다.
 * @param {Object} store - GraphStore
 * @returns {Array<Object>} 씨앗 배열
 */
export function probeIdentityCrisis(store) {
  const out = []
  for (const c of store.getNodes({ kind: 'Character' })) {
    // 상충하는 소속
    const groups = uniq(store.getEdgesFrom(c.id).filter((e) => e.p === 'member_of').map((e) => e.o))
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const rival = store.getEdgesBetween(groups[i], groups[j]).find((e) => e.p === 'rival_of')
        if (!rival) continue
        out.push(mk(store, 'identity_crisis', 0.7 + 0.3 * ten(rival),
          `두 곳에 동시에 속한 인물: ${c.name}`,
          `${nameOf(store, groups[i])}${josa(nameOf(store, groups[i]), '과', '와')} ${nameOf(store, groups[j])}${josa(nameOf(store, groups[j]), '은', '는')} 서로 적인데 ${c.name}${josa(c.name, '은', '는')} 양쪽 다 이름이 올라 있다`,
          [c.id, groups[i], groups[j]]))
      }
    }

    // 자기에 관한 비밀을 자기가 감춘다
    for (const e of store.getEdgesFrom(c.id)) {
      if (e.p !== 'conceals') continue
      const secret = store.getNode(e.o)
      if (!secret) continue
      const claim = String(secret.props?.claim || '')
      const aboutMe = claim.includes(c.name)
        || store.getEdgesFrom(secret.id).some((x) => x.p === 'concerns' && x.o === c.id)
      if (!aboutMe) continue
      const hidden = store.getEdgesFrom(secret.id).filter((x) => x.p === 'hidden_from').length
      out.push(mk(store, 'identity_crisis', 0.65 + 0.1 * Math.min(2, hidden),
        `자기를 숨기는 인물: ${c.name}`,
        `${claim ? `"${claim}" — ` : ''}자기에 관한 것을 자기가 감추고 있다`,
        [c.id, secret.id]))
    }
  }
  return trim(out, 6)
}

/**
 * 11. 사랑해선 안 될 상대. 소속이 적이거나, 매인 쪽이 상대와 적이다.
 * @param {Object} store - GraphStore
 * @returns {Array<Object>} 씨앗 배열
 */
export function probeForbiddenBond(store) {
  const out = []
  for (const lv of store.getEdgesByPredicate('loves')) {
    const mine = uniq(store.getEdgesFrom(lv.s).filter((e) => e.p === 'member_of').map((e) => e.o))
    const yours = uniq(store.getEdgesFrom(lv.o).filter((e) => e.p === 'member_of').map((e) => e.o))
    for (const f1 of mine) {
      for (const f2 of yours) {
        if (f1 === f2) continue
        const rival = store.getEdgesBetween(f1, f2).find((e) => e.p === 'rival_of')
        if (!rival) continue
        out.push(mk(store, 'forbidden_bond', 0.7 + 0.35 * ten(rival),
          `사랑해선 안 될 상대: ${nameOf(store, lv.s)} → ${nameOf(store, lv.o)}`,
          `${nameOf(store, f1)}${josa(nameOf(store, f1), '과', '와')} ${nameOf(store, f2)}${josa(nameOf(store, f2), '이', '가')} 서로 적이다. 관계를 지키려면 소속을 버려야 한다`,
          [lv.s, lv.o, f1, f2]))
      }
    }
    for (const keeper of guardiansOf(store, lv.s)) {
      if (keeper === lv.o) continue
      const rival = store.getEdgesBetween(keeper, lv.o).find((e) => e.p === 'rival_of')
      if (!rival) continue
      out.push(mk(store, 'forbidden_bond', 0.7 + 0.35 * ten(rival),
        `사랑해선 안 될 상대: ${nameOf(store, lv.s)} → ${nameOf(store, lv.o)}`,
        `${nameOf(store, lv.s)}${josa(nameOf(store, lv.s), '이', '가')} 매여 있는 ${nameOf(store, keeper)}${josa(nameOf(store, keeper), '과', '와')} ${nameOf(store, lv.o)}${josa(nameOf(store, lv.o), '은', '는')} 적이다. 계약과 마음이 같이 설 수 없다`,
        [lv.s, lv.o, keeper]))
    }
  }
  return trim(out, 6)
}

/**
 * 12. 권력 공백. 이끄는 자가 위기 사건에 들어가 있거나, 이끄는 자가 아예 없는 집단.
 * @param {Object} store - GraphStore
 * @returns {Array<Object>} 씨앗 배열
 */
export function probePowerVacuum(store) {
  const out = []
  const leaders = uniq([
    ...store.getEdgesByPredicate('manages').map((e) => e.s),
    ...store.getEdgesByPredicate('mentor_of').map((e) => e.s),
  ])
  for (const id of leaders) {
    for (const e of store.getEdgesFrom(id)) {
      if (e.p !== 'participated_in' || ten(e, 0) < 0.8) continue
      const led = uniq([
        ...store.getEdgesFrom(id).filter((x) => x.p === 'manages' || x.p === 'mentor_of').map((x) => x.o),
      ])
      out.push(mk(store, 'power_vacuum', 0.6 + 0.35 * ten(e, 0),
        `이끄는 자가 흔들린다: ${nameOf(store, id)}`,
        `${nameOf(store, e.o)}에 긴장 ${ten(e, 0)} 으로 걸려 있다. ${namesOf(store, led) || '아래'}${josa(namesOf(store, led) || '아래', '을', '를')} 이끌 사람이 비게 된다`,
        [id, e.o, ...led]))
    }
  }

  // 소속은 있는데 이끄는 엣지가 없는 집단
  const groups = uniq([
    ...store.getNodes({ kind: 'Faction' }).map((n) => n.id),
    ...store.getEdgesByPredicate('member_of').map((e) => e.o),
  ])
  for (const gid of groups) {
    const inbound = store.getEdgesTo(gid)
    if (inbound.some((e) => e.p === 'manages')) continue
    const members = uniq(inbound.filter((e) => e.p === 'member_of').map((e) => e.s))
    if (!members.length) continue
    out.push(mk(store, 'power_vacuum', 0.55 + 0.1 * Math.min(3, members.length),
      `이끄는 사람이 없는 집단: ${nameOf(store, gid)}`,
      `${namesOf(store, members)}${josa(namesOf(store, members), '이', '가')} 속해 있는데 manages 엣지가 없다. 자리가 비어 있다`,
      [gid, ...members]))
  }
  return trim(out, 6)
}

const ALL = [
  probeSecretLeverage, probeLoveTriangle, probeUnresolvedTension, probeChekovObject,
  probeStrangersSharedPast, probeSeveredBond, probeDanglingConsequence, probeContestedGoal,
  probeBetrayalPotential, probeIdentityCrisis, probeForbiddenBond, probePowerVacuum,
]

/**
 * 탐지기 12종을 전부 돌리고 스코어 내림차순으로 준다.
 * 아무것도 못 찾으면 빈 배열이다. 관계가 얇은 대본에서는 정상적으로 일어난다.
 *
 * @param {Object} store - GraphStore
 * @param {Object} [opts]
 * @param {number} [opts.limit=40] 전체 상한. 긴 대본에서 씨앗이 수십 개 나올 때 자른다
 * @returns {Array<Object>} mock/seeds.json 과 같은 모양의 씨앗 배열
 */
export function findSeeds(store, { limit = 40 } = {}) {
  if (!store || typeof store.getNodes !== 'function') return []
  const all = []
  for (const probe of ALL) {
    try {
      all.push(...asList(probe(store)))
    } catch (err) {
      // 탐지기 하나가 이상한 데이터에 걸려 죽어도 나머지는 돌아야 한다
      console.warn('[probes] 탐지기 실패 — 건너뛴다', probe.name, err?.message)
    }
  }
  all.sort((a, b) => b.score - a.score || a.probe.localeCompare(b.probe) || a.title.localeCompare(b.title))
  return all.slice(0, Math.max(0, limit))
}
