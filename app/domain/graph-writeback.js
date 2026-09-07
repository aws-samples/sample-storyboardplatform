/*
 * 분기가 그래프에 되돌려 쓰는 것(역기입)을 검증하고 적용합니다. 모델이 시킨 대로 그냥
 * 쓰지 않고, 어휘에 있는 kind·rel 인지, 지우라는 엣지가 실제로 있는지 먼저 봅니다.
 * 순수 규칙입니다. 저장은 services/graph-store.js 가 합니다.
 */

import { GRAPH_SCHEMA, edgeKey } from './graph-schema.js'
import { findSeeds } from './graph-probes.js'
import { normalizeGraph, validateAgainstCanon, mergeGraphs } from './graph-rules.js'
import { autoConnectOrphans } from './graph-orphans.js'
import { asObj, asList } from '../lib/guards.js'

export function commitGraph(canon, next) {
  const check = validateAgainstCanon(next, canon)
  const base = mergeGraphs(
    { nodes: canon?.nodes || [], edges: (canon?.edges || []).filter((e) => e.asserted !== false) },
    { nodes: next?.nodes || [], edges: (next?.edges || []).filter((e) => e.asserted !== false) },
  )
  return { ...base, edges: [...base.edges, ...deriveEdges(base.nodes, base.edges)], ...check }
}

// ── 씨앗 → 분기 스토리 ────────────────────────────────────────────────────────
// 컨텍스트 팩(씨앗 주변 서브그래프를 텍스트로 편 것) → 분기 프롬프트 → app-walkthrough/data/stories.json
// 모양의 결과. 자유 입력은 같은 자리에 기획자의 방향만 얹는다.

/** 컨텍스트 팩에 넣는 노드 상한. 씨앗 주변만 보면 되니 전체를 넣지 않는다 */
const nodeRef = (store, v) => {
  const raw = String(v ?? '').trim()
  if (store.getNode(raw)) return raw
  return store.getNodes().find((n) => n.name === raw)?.id || ''
}

/** 이 삼항이 그래프에 실제로 있나. 있으면 그 엣지를 준다 (명시인지 파생인지도 함께) */
const findEdge = (store, e) => {
  const s = nodeRef(store, e?.s)
  const o = nodeRef(store, e?.o)
  if (!s || !o) return null
  return store.getEdgesFrom(s).find((x) => x.p === e?.p && x.o === o) || null
}

/** 이 삼항이 그래프에 실제로 있나. remove_edges 검증에 쓴다 */
export const hasEdge = (store, e) => !!findEdge(store, e)

/**
 * 이 프롬프트에 얹을 컨텍스트 팩을 짠다. 예산은 두 상한 중 작은 쪽이다.
 *  - CTX_BUDGET: 자리가 남아도 이만큼만 넣는다. 팩이 길어지면 응답도 길어져 30초를 넘긴다
 *  - bodyRoom: 프롬프트 상한에서 머리말·규칙을 뺀 나머지. 자유 방향이 길면 이쪽이 좁다
 * 예산으로 미리 줄이면 문장 중간이 아니라 줄 단위로 접힌다. withBody 의 가위는 보험이다.
 */
const KIND_OK = new Set(GRAPH_SCHEMA.nodeKinds)
const REL_OK = new Set(GRAPH_SCHEMA.edgeRels)
const DERIVED_ONLY = new Set(GRAPH_SCHEMA.derivedRels)

/**
 * 역기입의 세 목록을 꺼낸다.
 * app-walkthrough/data/stories.json 스키마({nodes, edges, remove_edges})와 지시서 스키마
 * ({add_nodes, add_edges, remove_edges})를 둘 다 받는다.
 */
export function wbParts(writeback) {
  const wb = asObj(writeback)
  return {
    nodes: [...asList(wb.nodes), ...asList(wb.add_nodes)],
    edges: [...asList(wb.edges), ...asList(wb.add_edges)],
    removes: [...asList(wb.remove_edges), ...asList(wb.remove), ...asList(wb.removeEdges)],
  }
}

/** 역기입 노드를 normalizeGraph 가 읽는 {id?, kind, name, props} 로 편다 */
const wbNodeShape = (n) => {
  const src = asObj(n)
  const props = { ...asObj(src.props) }
  const t = Number(src.t ?? props.t)
  if (Number.isFinite(t)) props.t = t
  if (src.desc && !props.desc) props.desc = src.desc
  if (src.claim && !props.claim) props.claim = src.claim
  const out = { kind: src.kind, name: src.name, props }
  if (src.id) out.id = src.id
  return out
}

/** 역기입 엣지에는 note 가 있고 그래프에는 그 자리가 없다. props.cause 로 옮겨 근거를 남긴다 */
const wbEdgeShape = (e, s, p, o) => {
  const props = { ...asObj(e.props) }
  if (e.note && !props.cause) props.cause = String(e.note)
  const out = { s, p, o, asserted: true }
  if (Object.keys(props).length) out.props = props
  return out
}

/**
 * 역기입을 미리 훑어 무엇이 들어가고 무엇이 걸리는지 가른다. store 는 건드리지 않는다.
 * applyWriteback 과 validateWritebackBeforeApply 가 같은 판정을 쓰도록 한 곳에 둔다.
 *
 * errors 는 데이터가 어긋나 넣을 수 없는 것(모르는 kind·술어, 없는 노드, 정본 모순),
 * warnings 는 넣지 않고 넘어가도 되는 것(이미 있는 노드·엣지, 없는 엣지 삭제 시도).
 */
function planWriteback(store, writeback, seed = null) {
  const warnings = []
  const errors = []
  // 사람에게 보여도 되는 알림. warnings 는 대부분 개발자용이라 화면에 그대로 올릴 수 없다
  const notices = []
  if (!store?.getNode) {
    errors.push('그래프 저장소가 없다. 역기입을 적용할 수 없다')
    return { nodes: [], edges: [], removes: [], warnings, errors, notices, conflicts: [] }
  }
  const { nodes: rawNodes, edges: rawEdges, removes: rawRemoves } = wbParts(writeback)

  // 1. 끊을 엣지. 실제로 있는 명시 엣지만 끊는다. 파생은 근거를 지워야 사라진다
  const removes = []
  const cutKeys = new Set()
  for (const e of rawRemoves) {
    const src = asObj(e)
    const label = `${src.s ?? '없음'} ${src.p ?? '?'} ${src.o ?? '없음'}`
    const hit = findEdge(store, src)
    if (!hit) { warnings.push(`역기입 삭제: 그래프에 없는 엣지 (${label}). 건너뛴다`); continue }
    if (hit.asserted === false) {
      warnings.push(`역기입 삭제: 파생 엣지는 직접 삭제할 수 없습니다 (${label}). 건너뛴다`)
      continue
    }
    const key = edgeKey(hit)
    if (cutKeys.has(key)) continue
    cutKeys.add(key)
    removes.push({ s: hit.s, p: hit.p, o: hit.o })
  }

  // 2. 새 노드. normalizeGraph 로 검증하면서 id 까지 미리 정한다 (addNodes 가 하는 것과 같다)
  const okNodes = []
  for (const n of rawNodes) {
    const src = asObj(n)
    const name = String(src.name ?? src.label ?? '').trim()
    const kind = String(src.kind ?? src.type ?? '').trim()
    if (!name) { errors.push('역기입 노드: 이름이 없다. 노드를 버린다'); continue }
    if (!KIND_OK.has(kind)) {
      errors.push(`역기입 노드 "${name}": 모르는 kind "${kind || '없음'}". 노드를 버린다`)
      continue
    }
    okNodes.push(src)
  }
  const g = normalizeGraph({ nodes: okNodes.map(wbNodeShape), edges: [] })
  warnings.push(...g.warnings)

  const nodes = []
  const fresh = new Map() // 이 역기입에서 새로 생기는 노드의 이름·id → 얹힌 뒤의 id
  for (const n of g.nodes) {
    const prev = store.getNode(n.id) || store.getNodes().find((x) => x.name === n.name)
    if (prev) {
      warnings.push(`역기입 노드 "${n.name}": 이미 있는 노드(${prev.id}). 새로 만들지 않는다`)
      fresh.set(n.id, prev.id)
      fresh.set(n.name, prev.id)
      continue
    }
    nodes.push(n)
    fresh.set(n.id, n.id)
    fresh.set(n.name, n.id)
  }

  // 3. 새 엣지. 양끝은 기존 노드거나 이 역기입에서 새로 만드는 노드여야 한다
  const ref = (v) => {
    const raw = String(v ?? '').trim()
    return nodeRef(store, raw) || fresh.get(raw) || ''
  }
  const edges = []
  const addKeys = new Set()
  for (const e of rawEdges) {
    const src = asObj(e)
    const p = String(src.p ?? src.rel ?? src.pred ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    const label = `${src.s ?? '없음'} ${p || '?'} ${src.o ?? '없음'}`
    if (!REL_OK.has(p)) { errors.push(`역기입 엣지: 어휘에 없는 술어 (${label}). 버린다`); continue }
    if (DERIVED_ONLY.has(p)) {
      warnings.push(`역기입 엣지: ${p} 는 파생 전용이라 직접 넣지 않는다 (${label}). 추론이 다시 만든다`)
      continue
    }
    const s = ref(src.s ?? src.from ?? src.subject)
    const o = ref(src.o ?? src.to ?? src.object)
    if (!s || !o) { errors.push(`역기입 엣지: 없는 노드를 가리킨다 (${label}). 버린다`); continue }
    if (s === o) { warnings.push(`역기입 엣지: 자기 자신을 가리킨다 (${label}). 버린다`); continue }
    const key = edgeKey({ s, p, o })
    if (addKeys.has(key)) { warnings.push(`역기입 엣지: 같은 엣지가 두 번 왔다 (${label})`); continue }
    if (!cutKeys.has(key) && store.getEdgesFrom(s).some((x) => x.p === p && x.o === o)) {
      warnings.push(`역기입 엣지: 이미 있는 엣지 (${label}). 넣지 않는다`)
      continue
    }
    addKeys.add(key)
    edges.push(wbEdgeShape(src, s, p, o))
  }

  // 4. 고립 노드. 어떤 엣지에도 닿지 않는 새 노드는 판에 섬으로 뜬다. 거부하지 않고
  //    가장 관련 있는 인물과 이어 준다 (graph-orphans.js 의 머리글)
  const fix = autoConnectOrphans(store, nodes, edges, seed)
  for (const e of fix.edges) { addKeys.add(edgeKey(e)); edges.push(e) }
  warnings.push(...fix.warnings)
  notices.push(...(fix.notices || []))

  // 5. 이미 확립된 그래프와 어긋나지 않는지. 끊기로 한 엣지는 빼고 견준다
  const canon = store.toJSON()
  const check = validateAgainstCanon(
    { nodes, edges },
    { nodes: canon.nodes, edges: canon.edges.filter((e) => !cutKeys.has(edgeKey(e))) },
  )
  for (const c of check.conflicts) (c.level === 'error' ? errors : warnings).push(`역기입 모순: ${c.msg}`)

  return { nodes, edges, removes, warnings, errors, notices, conflicts: check.conflicts }
}

/**
 * 역기입에서 실제로 판에 들어가는 것만 추린 묶음. 화면이 개수 대신 이름을 적을 때
 * 필요한 최소한이다 (graph-ko.js 의 writebackKo).
 *
 * s·o 는 노드 id 다. 이름은 저장소에서 찾는다. 여기서 이름까지 박아 두면 역기입 전후로
 * 이름이 바뀐 노드를 옛 이름으로 부르게 된다.
 */
const wbChanges = (p) => ({ nodes: p.nodes, edges: p.edges, removes: p.removes })

/**
 * 역기입을 적용하기 전에 안전한지 본다. store 는 바뀌지 않는다.
 * 뷰어는 이 결과로 "+ 노드 N · + 엣지 N · − 엣지 N" 미리보기를 띄운다.
 *
 * @param {Object} store - GraphStore
 * @param {Object} writeback - branch.writeback
 * @param {Object} [opts]
 * @param {Object|null} [opts.seed] 이 분기를 만든 씨앗. 고립 노드를 이을 인물을 여기서 먼저 찾는다
 * @returns {{safe: boolean, warnings: Array<string>, notices: Array<string>, conflicts: Array,
 *            changes: {nodes: Array, edges: Array, removes: Array},
 *            preview: {nodesAdded: number, edgesAdded: number, edgesRemoved: number}}}
 *          safe 는 넣을 수 없는 항목이 하나도 없을 때만 true.
 *          edgesAdded 에는 고립 노드를 잇느라 자동으로 만든 엣지도 들어간다.
 *          changes 는 개수가 아니라 무엇이 들어가는지다. 화면은 이것으로 사람의 말을 만든다.
 *          warnings 는 개발자용이고(로그), notices 는 사람에게 보여도 되는 알림이다
 */
export function validateWritebackBeforeApply(store, writeback, opts = {}) {
  const p = planWriteback(store, writeback, opts.seed)
  return {
    safe: p.errors.length === 0,
    warnings: [...p.errors, ...p.warnings],
    notices: p.notices,
    conflicts: p.conflicts,
    changes: wbChanges(p),
    preview: { nodesAdded: p.nodes.length, edgesAdded: p.edges.length, edgesRemoved: p.removes.length },
  }
}

/**
 * 분기의 역기입을 그래프에 적용한다. #1 파이프라인의 apply_writeback 자리다.
 *
 * 끊기 → 노드 → 엣지 순으로 얹는다. 엣지가 새 노드를 가리킬 수 있어서 노드가 먼저다.
 * 파생 엣지는 GraphStore 가 매번 다시 만들기 때문에, 끊은 명시 엣지에서 나왔던
 * 파생도 함께 사라진다 (진우 serves 귀마 를 끊으면 귀마 rival_of 루미 도 사라진다).
 *
 * Neptune 판 저장소를 받아도 이 함수는 동기다. 저장소가 판을 바로 고치고 Neptune
 * 왕복만 뒤로 미룬다. 저장까지 끝났는지 알아야 하는 화면은 뒤이어 store.flush() 를
 * 기다린다 (story-graph.html 의 applyToBoard).
 *
 * 새 노드가 어떤 엣지에도 닿지 않으면(모델이 nodes 만 채운 경우) 판에 섬으로 뜬다.
 * 그런 노드는 autoConnectOrphans 가 기준 인물과 이어 주고 warnings 에 무엇을 이었는지 남긴다.
 *
 * @param {Object} store - GraphStore. 이 함수가 직접 바꾼다
 * @param {Object} writeback - branch.writeback ({nodes, edges, remove_edges} 또는 add_* 스키마)
 * @param {Object} [opts]
 * @param {Object|null} [opts.seed] 이 분기를 만든 씨앗. 고립 노드를 이을 인물을 여기서 먼저 찾는다
 * @returns {{applied: {nodesAdded: number, edgesAdded: number, edgesRemoved: number, derivedLost: number},
 *            warnings: Array<string>, notices: Array<string>,
 *            changes: {nodes: Array, edges: Array, removes: Array},
 *            newSeeds: Array, before: Object, after: Object}}
 *          newSeeds 는 적용 뒤에 다시 돌린 findSeeds 의 결과다.
 *          changes 는 실제로 얹은 것이다. 화면은 개수 대신 이것으로 사람의 말을 만든다
 *          (graph-ko.js 의 writebackKo). warnings 는 개발자용, notices 는 사람용이다
 */
export function applyWriteback(store, writeback, opts = {}) {
  const p = planWriteback(store, writeback, opts.seed)
  if (!store?.addNodes) {
    return {
      applied: { nodesAdded: 0, edgesAdded: 0, edgesRemoved: 0, derivedLost: 0 },
      warnings: [...p.errors, ...p.warnings],
      notices: p.notices,
      changes: wbChanges(p),
      newSeeds: [],
      before: null,
      after: null,
    }
  }
  const warnings = [...p.errors, ...p.warnings]
  const before = store.stats()

  // removeEdges 는 파생까지 합한 감소분을 낸다. 끊은 명시 엣지 수와 갈라서 적는다
  const dropped = p.removes.length ? store.removeEdges(p.removes) : 0
  const addedNodes = p.nodes.length ? store.addNodes(p.nodes) : { added: [], warnings: [] }
  warnings.push(...addedNodes.warnings)
  const addedEdges = p.edges.length ? store.addEdges(p.edges) : { added: [], warnings: [] }
  warnings.push(...addedEdges.warnings)

  return {
    applied: {
      nodesAdded: addedNodes.added.length,
      edgesAdded: addedEdges.added.length,
      edgesRemoved: p.removes.length,
      derivedLost: Math.max(0, dropped - p.removes.length),
    },
    warnings,
    notices: p.notices,
    changes: wbChanges(p),
    newSeeds: findSeeds(store),
    before,
    after: store.stats(),
  }
}

// ── 대본화 ───────────────────────────────────────────────────────────────────
// 보드의 컷을 정식 대본 포맷으로 옮긴다. 스토리 디벨롭과는 따로 도는 기능이다.
// 출력이 JSON 이 아니라 대본 텍스트라서 여기서는 parseJson 을 쓰지 않는다.
// 다만 모델이 대본을 JSON 으로 감싸 보내는 일이 있어 scriptText 로 래핑만 벗긴다.

// 한 번에 대본으로 옮기는 컷 수. 넘으면 묶음으로 나눠 부른다 (planCuts 와 같은 패턴).
// 컷 하나를 15줄 이상으로 펴라고 요구하므로 묶음이 크면 응답이 4000 토큰 상한에서 잘린다
// (10컷 × 15줄이면 6천자가 넘는다). 30초 안에 끝나야 하는 것도 같은 이유로 묶음을 작게 만든다.
/** 한 묶음의 컷 수. 이 값을 올리면 SCRIPT_TOKENS 안에서 컷당 줄 수가 줄어든다 */
