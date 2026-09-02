// Neptune 그래프 저장소를 도는 Lambda. AppSync 의 GraphDs 데이터소스가 부른다.
//
// 브라우저의 graph-engine.js 가 이 핸들러에 기대는 것은 네 가지다.
//   loadGraph    projectId 의 노드·명시 엣지를 mock/graph.json 모양으로 돌려준다
//   saveGraph    그래프 하나를 통째로 덮어쓴다 (추출 직후 한 번)
//   queryGraph   이웃·서브그래프처럼 그래프를 걸어야 답이 나오는 조회
//   updateGraph  역기입. 엣지 끊기 → 노드 얹기 → 엣지 얹기 순서로 돈다
//
// 파생 엣지는 Neptune 에 넣지 않는다. 규칙은 graph-schema.js 의 deriveEdges 뿐이고
// 그것은 브라우저에서만 돈다. 저장해 두면 규칙을 고친 뒤에도 낡은 파생이 남는다.
//
// props 는 JSON 문자열 한 칸(propsJson)에 담는다. Neptune 프로퍼티는 원시값만 받는다.

const gremlin = require('gremlin')

const __ = gremlin.process.statics
const P = gremlin.process.P

const ENDPOINT = process.env.NEPTUNE_ENDPOINT
const PORT = process.env.NEPTUNE_PORT || '8182'

// 연결은 핸들러 밖에 둬서 웜 컨테이너가 다시 쓴다. 끊긴 뒤에는 reset 으로 버린다.
let conn = null
let g = null

function open() {
  if (g) return g
  conn = new gremlin.driver.DriverRemoteConnection(`wss://${ENDPOINT}:${PORT}/gremlin`, {
    mimeType: 'application/vnd.gremlin-v3.0+json',
  })
  g = new gremlin.structure.Graph().traversal().withRemote(conn)
  return g
}

function reset() {
  try { conn?.close() } catch { /* 이미 닫힌 소켓 */ }
  conn = null
  g = null
}

const asList = (v) => (Array.isArray(v) ? v : [])
const str = (v) => String(v ?? '')
const pid = (payload) => str(payload?.projectId || 'default')

/** 파생으로 들어온 엣지인가. Neptune 에는 명시 엣지만 넣는다 */
const isDerived = (e) => e?.asserted === false || !!e?.derived

/** gremlin 이 돌려주는 Map 을 평범한 객체로 바꾼다 */
function plain(v) {
  if (v instanceof Map) {
    const out = {}
    for (const [k, val] of v) out[str(k)] = plain(val)
    return out
  }
  if (Array.isArray(v)) return v.map(plain)
  return v
}

/** valueMap 은 값을 배열로 준다. 첫 칸만 꺼낸다 */
const one = (v) => (Array.isArray(v) ? v[0] : v)

function parseProps(raw) {
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

// ── 모양 맞추기 ───────────────────────────────────────────────────────────────

/** valueMap 한 줄을 {id, kind, name, props} 로 */
function formatNode(row) {
  const m = plain(row)
  return {
    id: str(one(m.nodeId)),
    kind: str(one(m.kind)),
    name: str(one(m.name)),
    props: parseProps(one(m.propsJson)),
  }
}

/** project('s','o','attrs') 한 줄을 {s, p, o, asserted} 로 */
function formatEdge(row) {
  const m = plain(row)
  const attrs = m.attrs || {}
  const props = parseProps(one(attrs.propsJson))
  const edge = { s: str(m.s), p: str(one(attrs.predicate)), o: str(m.o), asserted: true }
  if (Object.keys(props).length) edge.props = props
  return edge
}

/** 엣지 조회에 공통으로 붙는 project. formatEdge 와 짝이다 */
const projectEdge = (t) => t
  .project('s', 'o', 'attrs')
  .by(__.outV().values('nodeId'))
  .by(__.inV().values('nodeId'))
  .by(__.valueMap())

/** 노드 조회에 공통으로 붙는 project. formatNode 와 짝이다 */
const projectNode = (t) => t.valueMap()

// ── 쓰기 ─────────────────────────────────────────────────────────────────────

/**
 * addV 하나를 트래버설에 이어 붙인다. addV 는 여러 번 이어도 되므로
 * 노드 전체를 한 번의 왕복으로 넣는다.
 */
const putNode = (t, projectId, n) => t
  .addV(str(n.kind) || 'Node')
  .property('projectId', projectId)
  .property('nodeId', str(n.id))
  .property('kind', str(n.kind))
  .property('name', str(n.name))
  .property('propsJson', JSON.stringify(n.props || {}))

/**
 * 엣지 하나를 넣는다. s·o 가 없으면 아무것도 만들어지지 않으므로 만들었는지 돌려준다.
 * 엣지는 한 번에 하나씩 보낸다 — 같은 노드를 건드리는 쓰기를 겹치면
 * Neptune 이 ConcurrentModificationException 을 던진다.
 *
 * @returns {Promise<boolean>} 실제로 만들었으면 true
 */
async function putEdge(g, projectId, e) {
  const label = str(e.p)
  if (!label || !e.s || !e.o) return false
  const r = await g
    .V().has('projectId', projectId).has('nodeId', str(e.s))
    .addE(label)
    .to(__.V().has('projectId', projectId).has('nodeId', str(e.o)))
    .property('projectId', projectId)
    .property('predicate', label)
    .property('asserted', true)
    .property('propsJson', JSON.stringify(e.props || {}))
    .next()
  return !r.done
}

async function putEdges(g, projectId, edges) {
  let n = 0
  for (const e of edges) if (await putEdge(g, projectId, e)) n++
  return n
}

// ── 오퍼레이션 ────────────────────────────────────────────────────────────────

/**
 * 그래프 전체를 읽는다. 파생 엣지는 브라우저가 다시 만든다.
 * @param {Object} payload - {projectId}
 * @returns {Promise<{nodes: Array, edges: Array}>} 빈 프로젝트면 둘 다 빈 배열
 */
async function loadGraph(g, payload) {
  const projectId = pid(payload)
  const [nodeRows, edgeRows] = await Promise.all([
    projectNode(g.V().has('projectId', projectId)).toList(),
    projectEdge(g.E().has('projectId', projectId).has('asserted', true)).toList(),
  ])
  return { nodes: nodeRows.map(formatNode), edges: edgeRows.map(formatEdge) }
}

/**
 * 그래프 하나를 통째로 덮어쓴다. 같은 projectId 의 기존 노드·엣지는 먼저 지운다.
 * @param {Object} payload - {projectId, nodes, edges}
 * @returns {Promise<{saved: {nodes: number, edges: number}}>}
 */
async function saveGraph(g, payload) {
  const projectId = pid(payload)
  const nodes = asList(payload?.nodes)
  const edges = asList(payload?.edges).filter((e) => !isDerived(e))

  // 노드를 지우면 붙어 있던 엣지도 함께 사라진다
  await g.V().has('projectId', projectId).drop().iterate()

  if (nodes.length) {
    let t = g
    for (const n of nodes) t = putNode(t, projectId, n)
    await t.iterate()
  }
  return { saved: { nodes: nodes.length, edges: await putEdges(g, projectId, edges) } }
}

/**
 * 그래프를 걸어야 답이 나오는 조회. 브라우저가 캐시로 답할 수 없을 때만 쓴다.
 * @param {Object} payload - {type, projectId, nodeId?, predicate?, nodeIds?, depth?}
 * @returns {Promise<Array|Object>} type 에 따라 노드 배열·엣지 배열·서브그래프
 */
async function queryGraph(g, payload) {
  const projectId = pid(payload)
  const at = (id) => g.V().has('projectId', projectId).has('nodeId', str(id))

  switch (payload?.type) {
    case 'edgesFrom':
      return (await projectEdge(at(payload.nodeId).outE()).toList()).map(formatEdge)

    case 'edgesTo':
      return (await projectEdge(at(payload.nodeId).inE()).toList()).map(formatEdge)

    case 'edgesByPredicate':
      return (await projectEdge(
        g.E().has('projectId', projectId).has('predicate', str(payload.predicate)),
      ).toList()).map(formatEdge)

    case 'neighbors': {
      // 자기 자신은 뺀다. depth 는 1 이상으로 자른다
      const depth = Math.max(1, Number(payload.depth) || 1)
      const rows = await projectNode(
        at(payload.nodeId).repeat(__.both().simplePath()).times(depth).emit().dedup(),
      ).toList()
      const start = str(payload.nodeId)
      return rows.map(formatNode).filter((n) => n.id !== start)
    }

    case 'subgraph': {
      const want = asList(payload.nodeIds).map(str)
      if (!want.length) return { nodes: [], edges: [] }
      const some = P.within(...want)
      const [nodeRows, edgeRows] = await Promise.all([
        projectNode(g.V().has('projectId', projectId).has('nodeId', some)).toList(),
        projectEdge(
          g.V().has('projectId', projectId).has('nodeId', some)
            .outE().where(__.inV().has('nodeId', some)),
        ).toList(),
      ])
      return { nodes: nodeRows.map(formatNode), edges: edgeRows.map(formatEdge) }
    }

    default:
      throw new Error(`알 수 없는 조회 종류: ${payload?.type}`)
  }
}

/**
 * 역기입. 끊기 → 노드 → 엣지 순으로 돈다 (새 엣지가 새 노드를 가리킬 수 있다).
 * @param {Object} payload - {projectId, addNodes, addEdges, removeEdges}
 * @returns {Promise<{nodesAdded: number, edgesAdded: number, edgesRemoved: number}>}
 */
async function updateGraph(g, payload) {
  const projectId = pid(payload)
  const out = { nodesAdded: 0, edgesAdded: 0, edgesRemoved: 0 }

  for (const e of asList(payload?.removeEdges)) {
    const label = str(e?.p)
    if (!label || !e?.s || !e?.o) continue
    const hit = g
      .V().has('projectId', projectId).has('nodeId', str(e.s))
      .outE(label).where(__.inV().has('nodeId', str(e.o)))
      .has('asserted', true)
    // drop 은 개수를 돌려주지 않는다. 세고 나서 지운다
    const n = (await hit.count().next()).value
    if (!n) continue
    await g
      .V().has('projectId', projectId).has('nodeId', str(e.s))
      .outE(label).where(__.inV().has('nodeId', str(e.o)))
      .has('asserted', true)
      .drop().iterate()
    out.edgesRemoved += Number(n)
  }

  const fresh = []
  for (const n of asList(payload?.addNodes)) {
    if (!n?.id) continue
    const exists = await g.V().has('projectId', projectId).has('nodeId', str(n.id)).hasNext()
    if (!exists) fresh.push(n)
  }
  if (fresh.length) {
    let t = g
    for (const n of fresh) t = putNode(t, projectId, n)
    await t.iterate()
    out.nodesAdded = fresh.length
  }

  out.edgesAdded = await putEdges(g, projectId, asList(payload?.addEdges).filter((e) => !isDerived(e)))
  return out
}

const OPS = { loadGraph, saveGraph, queryGraph, updateGraph }

exports.handler = async (event) => {
  const op = OPS[event?.operation]
  if (!op) throw new Error(`알 수 없는 오퍼레이션: ${event?.operation}`)
  if (!ENDPOINT) throw new Error('NEPTUNE_ENDPOINT 가 비어 있다')

  try {
    return await op(open(), event.payload)
  } catch (err) {
    // 웜 컨테이너가 들고 있던 소켓이 끊겼을 수 있다. 한 번만 다시 연결해 본다
    reset()
    try {
      return await op(open(), event.payload)
    } catch (again) {
      console.error('[graph] Neptune 쿼리 실패', event.operation, again)
      throw new Error(`Neptune ${event.operation} 실패: ${again.message || err.message}`)
    }
  }
}
