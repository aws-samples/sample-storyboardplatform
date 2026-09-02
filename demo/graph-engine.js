
// 관계 그래프 엔진. 판은 브라우저에 두고, 사실은 Neptune 에 남긴다.
//
// 그래프를 브라우저 메모리에 색인해 두고 씨앗 탐지기가 쓰는 조회를 제공한다.
// 바깥에서 보이는 것은 createGraphStore 와 store 의 메서드 이름·인자·반환 모양뿐이다.
//
// 두 가지 모드가 있고, 고르는 것은 net.js 의 graphClient() 를 넘겨 주는지다
// (story.js 가 net 을 인자로 받는 것과 같은 방식이다. 이 파일은 통신을 모른다).
//   인메모리  net 이 없을 때. 로컬·테스트. 그래프가 이 파일 안에서만 산다
//   Neptune   net 이 있을 때. 조회는 그대로 색인에서 답하고, 바뀐 것만 뒤에서 흘려보낸다
// 어느 쪽이든 조회와 변경은 전부 동기다 — 탐지기 한 바퀴가 수백 번을 물어보므로
// 그때마다 왕복하면 화면이 멈춘다. 저장이 끝났는지는 flush() 로 확인한다.

import { deriveEdges, edgeKey } from './graph-schema.js'
import { normalizeGraph } from './core.js'

const asList = (v) => (Array.isArray(v) ? v : [])
const asProps = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {})

/** 입력에서 파생으로 들어온 엣지인가. asserted:false 이거나 derived 태그가 붙은 것 */
const isDerived = (e) => e?.asserted === false || !!e?.derived

/** removeEdges 인자를 키로 만든다. "s|p|o" 문자열과 {s,p,o} 객체를 모두 받는다 */
const keyOf = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? edgeKey(v) : '')

/** removeEdges 인자를 삼항으로 되돌린다. Neptune 판이 지울 엣지를 가리킬 때 쓴다 */
const tripleOf = (v) => {
  const [s, p, o] = keyOf(v).split('|')
  return s && p && o ? { s, p, o } : null
}

const push = (map, k, v) => {
  const cur = map.get(k)
  if (cur) cur.push(v)
  else map.set(k, [v])
}

class GraphStore {
  constructor(nodes, edges, warnings) {
    this.load(nodes, edges, warnings)
  }

  /**
   * 노드·엣지를 사실로 앉히고 색인을 세운다. 처음 만들 때와, Neptune 판에서
   * 저장소를 다시 읽어올 때가 같은 길을 지난다.
   */
  load(nodes, edges, warnings) {
    /** @type {Array} 노드. 들어온 순서를 유지한다 */
    this.nodes = nodes
    /** @type {Array<string>} 정규화가 남긴 경고. UI 에 그대로 띄운다 */
    this.warnings = warnings
    // 명시 엣지만 사실로 들고, 파생 엣지는 deriveEdges 로 매번 다시 만든다.
    // 그래서 addEdges/removeEdges 뒤에도 파생이 어긋나지 않는다.
    this.asserted = edges.filter((e) => !isDerived(e))
    // 입력에 이미 들어 있던 파생 엣지 중, 규칙이 스스로 만들지 못하는 것만 남겨 둔다.
    // 규칙이 만들 수 있는 것을 여기 두면 근거가 된 명시 엣지를 지운 뒤에도 살아남는다
    const byRule = new Set(deriveEdges(nodes, this.asserted).map(edgeKey))
    this.given = edges.filter((e) => isDerived(e) && !byRule.has(edgeKey(e)))
    // 지운 엣지. 규칙이 되살리지 못하게 막는다
    this.suppressed = new Set()
    this.rebuild()
  }

  /** 파생 엣지를 다시 만들고 색인을 세운다. 엣지·노드가 바뀔 때마다 부른다 */
  rebuild() {
    const seen = new Set(this.asserted.map(edgeKey))
    const derived = []
    const take = (e) => {
      const k = edgeKey(e)
      if (seen.has(k) || this.suppressed.has(k)) return
      seen.add(k)
      derived.push(e)
    }
    for (const e of deriveEdges(this.nodes, this.asserted)) take(e)
    for (const e of this.given) take(e)
    this.derived = derived
    this.index()
  }

  index() {
    this.nodeById = new Map()
    this.nodesByKind = new Map()
    this.edgesBySource = new Map()
    this.edgesByTarget = new Map()
    this.edgesByPredicate = new Map()
    for (const n of this.nodes) {
      this.nodeById.set(n.id, n)
      push(this.nodesByKind, n.kind, n)
    }
    this.edges = [...this.asserted, ...this.derived]
    for (const e of this.edges) {
      push(this.edgesBySource, e.s, e)
      push(this.edgesByTarget, e.o, e)
      push(this.edgesByPredicate, e.p, e)
    }
  }

  /**
   * 노드 하나를 id 로 찾는다.
   * @param {string} id
   * @returns {Object|null} 없으면 null
   */
  getNode(id) {
    return this.nodeById.get(String(id ?? '')) ?? null
  }

  /**
   * 노드를 가져온다.
   * @param {Object} [filter]
   * @param {string|Array<string>} [filter.kind] 이 kind 만 (없으면 전부)
   * @returns {Array} 노드 배열
   */
  getNodes(filter = {}) {
    const kind = filter?.kind
    if (kind === undefined || kind === null) return [...this.nodes]
    const kinds = Array.isArray(kind) ? kind : [kind]
    return kinds.flatMap((k) => this.nodesByKind.get(k) || [])
  }

  /**
   * 이 노드에서 나가는 엣지.
   * @param {string} nodeId
   * @returns {Array} 엣지 배열
   */
  getEdgesFrom(nodeId) {
    return [...(this.edgesBySource.get(String(nodeId ?? '')) || [])]
  }

  /**
   * 이 노드로 들어오는 엣지.
   * @param {string} nodeId
   * @returns {Array} 엣지 배열
   */
  getEdgesTo(nodeId) {
    return [...(this.edgesByTarget.get(String(nodeId ?? '')) || [])]
  }

  /**
   * 두 노드 사이의 엣지. 방향은 가리지 않는다.
   * @param {string} nodeId1
   * @param {string} nodeId2
   * @returns {Array} 엣지 배열
   */
  getEdgesBetween(nodeId1, nodeId2) {
    const a = String(nodeId1 ?? '')
    const b = String(nodeId2 ?? '')
    if (!a || !b) return []
    return [
      ...(this.edgesBySource.get(a) || []).filter((e) => e.o === b),
      ...(this.edgesBySource.get(b) || []).filter((e) => e.o === a),
    ]
  }

  /**
   * 엣지 전체를 가져온다.
   * @param {Object} [filter]
   * @param {boolean} [filter.asserted] true 면 명시 엣지만, false 면 추론 엣지만
   * @returns {Array} 엣지 배열
   */
  getEdges(filter = {}) {
    if (filter?.asserted === true) return [...this.asserted]
    if (filter?.asserted === false) return [...this.derived]
    return [...this.edges]
  }

  /**
   * 술어로 엣지를 고른다.
   * @param {string} predicate
   * @returns {Array} 엣지 배열
   */
  getEdgesByPredicate(predicate) {
    return [...(this.edgesByPredicate.get(String(predicate ?? '')) || [])]
  }

  /**
   * N-hop 이웃 노드. 방향은 가리지 않고, 자기 자신은 빼고 준다.
   * @param {string} nodeId
   * @param {Object} [opts]
   * @param {number} [opts.depth=1] 몇 다리까지 갈지
   * @returns {Array} 노드 배열. 가까운 것부터
   */
  getNeighbors(nodeId, { depth = 1 } = {}) {
    const start = String(nodeId ?? '')
    if (!this.nodeById.has(start)) return []
    const seen = new Set([start])
    const out = []
    let front = [start]
    for (let d = 0; d < Math.max(0, depth); d++) {
      const next = []
      for (const id of front) {
        const around = [
          ...(this.edgesBySource.get(id) || []).map((e) => e.o),
          ...(this.edgesByTarget.get(id) || []).map((e) => e.s),
        ]
        for (const other of around) {
          if (seen.has(other)) continue
          seen.add(other)
          const node = this.nodeById.get(other)
          if (!node) continue
          out.push(node)
          next.push(other)
        }
      }
      if (!next.length) break
      front = next
    }
    return out
  }

  /**
   * 주어진 노드들과 그 사이 엣지만 잘라낸다. 컨텍스트 팩을 만들 때 쓴다.
   * @param {Array<string>} nodeIds
   * @returns {{nodes: Array, edges: Array}} 없는 id 는 조용히 버린다
   */
  getSubgraph(nodeIds) {
    const want = new Set(asList(nodeIds).map((id) => String(id)))
    const nodes = this.nodes.filter((n) => want.has(n.id))
    const has = new Set(nodes.map((n) => n.id))
    return { nodes, edges: this.edges.filter((e) => has.has(e.s) && has.has(e.o)) }
  }

  /**
   * 노드를 얹는다. 역기입 때 쓴다. 검증은 normalizeGraph 를 그대로 쓴다.
   * 같은 id 가 이미 있으면 props 만 합치고 이름·kind 는 기존 것을 지킨다.
   * @param {Array} nodes - [{id, kind, name, props}]
   * @returns {{added: Array, warnings: Array<string>}} added 는 실제로 새로 들어간 노드
   */
  addNodes(nodes) {
    const g = normalizeGraph({ nodes: asList(nodes), edges: [] })
    const added = []
    for (const n of g.nodes) {
      const prev = this.nodeById.get(n.id)
      if (prev) {
        prev.props = { ...asProps(n.props), ...asProps(prev.props) }
        g.warnings.push(`${n.name}: 이미 있는 id "${n.id}" — props 만 합쳤다`)
        continue
      }
      this.nodes.push(n)
      this.nodeById.set(n.id, n)
      added.push(n)
    }
    this.warnings.push(...g.warnings)
    this.rebuild()
    return { added, warnings: g.warnings }
  }

  /**
   * 엣지를 얹는다. s·o 를 이름으로 줘도 노드 id 로 옮겨 준다(normalizeGraph).
   * 같은 삼항이 이미 있으면 넣지 않는다.
   * @param {Array} edges - [{s, p, o, props}]
   * @returns {{added: Array, warnings: Array<string>}}
   */
  addEdges(edges) {
    const g = normalizeGraph({ nodes: this.nodes, edges: asList(edges) })
    const have = new Set(this.edges.map(edgeKey))
    const added = []
    for (const e of g.edges) {
      const k = edgeKey(e)
      if (have.has(k)) { g.warnings.push(`${k}: 이미 있는 엣지 — 넣지 않는다`); continue }
      have.add(k)
      this.suppressed.delete(k)
      if (isDerived(e)) this.given.push(e)
      else this.asserted.push(e)
      added.push(e)
    }
    this.warnings.push(...g.warnings)
    this.rebuild()
    return { added, warnings: g.warnings }
  }

  /**
   * 엣지를 지운다. 지운 것은 추론 규칙이 되살리지 못하게 막아 둔다.
   * @param {Array<string|Object>} edgeIds - "s|p|o" 문자열이나 {s, p, o} 객체
   * @returns {number} 실제로 지운 개수
   */
  removeEdges(edgeIds) {
    const kill = new Set(asList(edgeIds).map(keyOf).filter(Boolean))
    if (!kill.size) return 0
    const before = this.asserted.length + this.given.length + this.derived.length
    this.asserted = this.asserted.filter((e) => !kill.has(edgeKey(e)))
    this.given = this.given.filter((e) => !kill.has(edgeKey(e)))
    for (const k of kill) this.suppressed.add(k)
    this.rebuild()
    return before - (this.asserted.length + this.given.length + this.derived.length)
  }

  /**
   * 전체 그래프를 mock/graph.json 모양으로 내보낸다. 명시 엣지가 먼저 온다.
   * @returns {{nodes: Array, edges: Array}}
   */
  toJSON() {
    return {
      nodes: this.nodes.map((n) => ({ ...n, props: asProps(n.props) })),
      edges: [...this.asserted, ...this.derived].map((e) => ({ ...e })),
    }
  }

  /**
   * 뷰어 상단에 찍는 숫자.
   * @returns {{nodes: number, assertedEdges: number, derivedEdges: number}}
   */
  stats() {
    return { nodes: this.nodes.length, assertedEdges: this.asserted.length, derivedEdges: this.derived.length }
  }
}

/** 프로젝트를 따로 두지 않은 화면이 쓰는 기본 키. Neptune 쪽 projectId 와 같다 */
export const DEFAULT_PROJECT = 'default'

/**
 * Neptune 을 사실로 두는 저장소.
 *
 * 조회는 부모(GraphStore)의 색인을 그대로 쓴다 — 씨앗 탐지기 12종은 한 번 도는 데
 * 수백 번을 물어보므로, 그때마다 Neptune 을 왕복하면 화면이 멈춘다. 그래서 판은
 * 브라우저에 두고, Neptune 에는 바뀐 것만 뒤에서 흘려보낸다.
 *
 * 그래서 변경 메서드의 반환은 인메모리 판과 똑같이 동기다. 저장이 끝났는지 알아야
 * 하는 자리(역기입을 확정하는 화면)에서만 flush() 를 기다린다.
 */
class NeptuneGraphStore extends GraphStore {
  constructor(nodes, edges, warnings, net, projectId) {
    super(nodes, edges, warnings)
    this.net = net
    this.projectId = projectId
    /** 아직 안 끝난 저장. 순서를 지키려고 한 줄로 잇는다 */
    this.pending = Promise.resolve()
    /** flush 가 걷어 가는 저장 실패 목록 */
    this.failures = []
  }

  /** Neptune 왕복을 줄에 세운다. 실패는 삼키지 않고 flush 가 돌려줄 자리에 쌓는다 */
  queue(label, run) {
    this.pending = this.pending.then(run).catch((err) => {
      const msg = `Neptune ${label} 실패 — 화면은 그대로지만 저장되지 않았다: ${err.message}`
      this.failures.push(msg)
      this.warnings.push(msg)
    })
    return this.pending
  }

  /**
   * 줄에 선 저장이 끝날 때까지 기다린다.
   * @returns {Promise<{failures: Array<string>}>} 쌓였던 실패. 한 번 걷으면 비워진다
   */
  async flush() {
    await this.pending
    return { failures: this.failures.splice(0) }
  }

  /** 지금 판을 Neptune 에 통째로 밀어 넣는다. 추출 직후처럼 판이 새로 앉을 때 부른다 */
  save() {
    const nodes = this.nodes.map((n) => ({ ...n, props: asProps(n.props) }))
    const edges = this.getEdges({ asserted: true })
    return this.queue('그래프 저장', () => this.net.save({ projectId: this.projectId, nodes, edges }))
  }

  /** Neptune 을 다시 읽어 판을 갈아 앉힌다. 파생 엣지는 여기서 규칙이 다시 만든다 */
  async reload() {
    await this.pending
    const data = await this.net.load(this.projectId)
    const g = normalizeGraph({ nodes: asList(data?.nodes), edges: asList(data?.edges) })
    this.load(g.nodes, g.edges, g.warnings)
    return this
  }

  addNodes(nodes) {
    const r = super.addNodes(nodes)
    if (r.added.length) {
      this.queue('노드 추가', () => this.net.update({ projectId: this.projectId, addNodes: r.added }))
    }
    return r
  }

  addEdges(edges) {
    const r = super.addEdges(edges)
    // 파생 엣지는 보내지 않는다. 규칙이 브라우저에서 다시 만든다
    const asserted = r.added.filter((e) => !isDerived(e))
    if (asserted.length) {
      this.queue('엣지 추가', () => this.net.update({ projectId: this.projectId, addEdges: asserted }))
    }
    return r
  }

  removeEdges(edgeIds) {
    // 부모가 지우고 나면 어떤 삼항이었는지 알 수 없으니 먼저 풀어 둔다
    const triples = asList(edgeIds).map(tripleOf).filter(Boolean)
    const dropped = super.removeEdges(edgeIds)
    if (dropped && triples.length) {
      this.queue('엣지 삭제', () => this.net.update({ projectId: this.projectId, removeEdges: triples }))
    }
    return dropped
  }
}

/** 저장소 한 개를 만든다. net 이 있으면 Neptune 판, 없으면 인메모리 판 */
function make(src, normalize, net, projectId) {
  // {nodes:[], edges:[]} 도 정상 입력이다. 경고 없이 빈 저장소가 나온다
  const g = normalize ? normalizeGraph(src) : {
    nodes: asList(src.nodes).map((n) => ({ ...n, props: asProps(n.props) })),
    edges: asList(src.edges),
    warnings: [],
  }
  return net
    ? new NeptuneGraphStore(g.nodes, g.edges, g.warnings, net, projectId)
    : new GraphStore(g.nodes, g.edges, g.warnings)
}

/**
 * 그래프 JSON 을 색인해 조회용 저장소로 만든다.
 * 입력의 명시 엣지에 deriveEdges 의 파생 엣지를 붙여서 들고 있는다. 입력에 파생
 * 엣지가 이미 있어도 규칙이 만든 것과 겹치면 한 번만 남는다.
 *
 * net 을 넘기면 Neptune 을 사실로 두는 저장소가 나온다. 메서드 이름·인자·반환
 * 모양은 인메모리 판과 같고, save()·reload()·flush() 만 더 있다.
 *
 * @param {Object} graphJson - {nodes, edges}. mock/graph.json 과 같은 모양
 * @param {Object} [opts]
 * @param {boolean} [opts.normalize=true] normalizeGraph 를 한 번 거칠지.
 *        이미 정규화된 데이터면 결과가 같고 경고만 빈 배열로 나온다
 * @param {Object|null} [opts.net] net.js 의 graphClient(). 없으면 인메모리로 돈다
 * @param {string} [opts.projectId] Neptune 에서 이 그래프를 가리키는 키
 * @returns {GraphStore|NeptuneGraphStore}
 */
export function createGraphStore(graphJson, { normalize = true, net = null, projectId = DEFAULT_PROJECT } = {}) {
  const src = graphJson && typeof graphJson === 'object' ? graphJson : { nodes: [], edges: [] }
  return make(src, normalize, net, projectId)
}

/**
 * Neptune 에 남아 있는 그래프를 읽어 저장소로 만든다. 새로고침해도 판이 남는 길이다.
 *
 * @param {Object} [opts]
 * @param {Object|null} [opts.net] net.js 의 graphClient()
 * @param {string} [opts.projectId]
 * @returns {Promise<NeptuneGraphStore|null>} net 이 없으면 null — 부르는 쪽은
 *          목데이터로 판을 채운다. 저장된 것이 없으면 노드 0개인 저장소가 나온다
 */
export async function loadGraphStore({ net = null, projectId = DEFAULT_PROJECT } = {}) {
  if (!net) return null
  const data = await net.load(projectId)
  return make({ nodes: asList(data?.nodes), edges: asList(data?.edges) }, true, net, projectId)
}

export { GraphStore, NeptuneGraphStore }
