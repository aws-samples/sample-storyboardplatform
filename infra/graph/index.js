// AppSync 의 GraphDs 데이터소스가 부르는 Lambda. 두 가지 일을 한다.
//
// Neptune 그래프 저장소 — 브라우저의 graph-engine.js 가 기대는 것은 네 가지다.
//   loadGraph    projectId 의 노드·명시 엣지를 mock/graph.json 모양으로 돌려준다
//   saveGraph    그래프 하나를 통째로 덮어쓴다 (추출 직후 한 번)
//   queryGraph   이웃·서브그래프처럼 그래프를 걸어야 답이 나오는 조회
//   updateGraph  역기입. 엣지 끊기 → 노드 얹기 → 엣지 얹기 순서로 돈다
//
// Bedrock 호출 — 대본·분기 생성이 쓴다. 이것만 Event(비동기)로 들어온다.
//   plan         Converse 로 모델을 부르고 결과를 Ops 테이블에 적는다.
//                브라우저는 planResult(jobId) 로 받아 간다 — AppSync 30초 상한 우회.
//
// 파생 엣지는 Neptune 에 넣지 않는다. 규칙은 graph-schema.js 의 deriveEdges 뿐이고
// 그것은 브라우저에서만 돈다. 저장해 두면 규칙을 고친 뒤에도 낡은 파생이 남는다.
//
// props 는 JSON 문자열 한 칸(propsJson)에 담는다. Neptune 프로퍼티는 원시값만 받는다.

const gremlin = require('gremlin')
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime')
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb')

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

// ── Bedrock ──────────────────────────────────────────────────────────────────
// 원래 AppSync 의 HTTP 데이터소스(BedrockDs)가 /model/{id}/converse 를 직접 쳤다.
// 느린 모델에서 Execution timeout 이 나서 여기로 옮겼다. 보내는 몸통은 그때와 같다 —
// Converse API 를 SDK 로 부르는 것뿐이라 요청·응답 모양이 바뀌지 않는다.

// 프론트엔드가 spec.model 로 고르는 이름 → Bedrock 모델 id.
// 이름은 화면(demo/story-graph.html 의 #modelSel)과 짝이 맞아야 한다.
// id 는 지금 쓰는 교차 리전 추론 프로필 형식(us.anthropic.…)을 그대로 따른다 —
// 리전에 있는 것과 다르면 Bedrock 이 ValidationException 을 낸다.
// 확인: aws bedrock list-inference-profiles --region <리전>
const MODELS = {
  'haiku-4.5': 'us.anthropic.claude-haiku-4-5',
  'sonnet-5': 'us.anthropic.claude-sonnet-5',
  'opus-4.8': 'us.anthropic.claude-opus-4-8',
}
/** 허용 목록. MODELS 를 이름으로 바로 찾으면 'constructor' 같은 이름이 프로토타입을 짚는다 */
const MODEL_NAMES = ['haiku-4.5', 'sonnet-5', 'opus-4.8']
const DEFAULT_MODEL = 'sonnet-5'

const SYSTEM = '당신은 광고·단편 영상의 콘티 기획자다. 요청받은 JSON 하나만 출력한다. 설명·머리말·코드펜스를 붙이지 않는다.'

// 재시도까지 합쳐 Lambda 타임아웃(120초) 안에 끝나도록 잡는다.
// 55초 × 2회 = 110초. 스로틀링에는 한 번 더 해 보고, 그 이상은 Lambda 가 끊는다.
let bedrock = null
const openBedrock = () => (bedrock ||= new BedrockRuntimeClient({
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 5000, requestTimeout: 55000 },
}))

/**
 * Bedrock Converse 를 한 번 부른다. 역할 체크는 리졸버가 이미 했다.
 * @param {Object} payload - {prompt, maxTokens?, model?, think?}
 * @returns {Promise<{text: string, usage: Object, stop: string}>}
 */
async function converse(payload) {
  const prompt = str(payload?.prompt)
  // 리졸버에서 이미 걸렀다. 여기서도 막아 두는 것은 Lambda 를 직접 부를 때를 위한 것이다
  if (prompt.length < 8 || prompt.length > 8000) throw new Error('프롬프트 길이가 8~8000자여야 합니다')

  const want = Number(payload?.maxTokens)
  const maxTokens = Math.min(4000, Math.max(300, Number.isFinite(want) ? Math.round(want) : 2000))

  const asked = str(payload?.model)
  const modelId = MODELS[MODEL_NAMES.includes(asked) ? asked : DEFAULT_MODEL]

  const input = {
    modelId,
    system: [{ text: SYSTEM }],
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens },
  }
  if (payload?.think !== true) input.additionalModelRequestFields = { thinking: { type: 'disabled' } }

  let out
  try {
    out = await openBedrock().send(new ConverseCommand(input))
  } catch (err) {
    console.error('[graph] Bedrock Converse 실패', modelId, err)
    throw new Error(`Bedrock ${err.name || 'Error'}: ${err.message}`)
  }

  // 여러 칸으로 쪼개져 올 수 있다. text 인 칸만 이어 붙인다 (thinking 칸은 버린다)
  let text = ''
  for (const c of out.output?.message?.content || []) if (typeof c.text === 'string') text += c.text
  return { text, usage: out.usage, stop: out.stopReason }
}

// ── plan 잡 ──────────────────────────────────────────────────────────────────
// AppSync 는 이 오퍼레이션을 Event(비동기)로 띄우고 즉시 jobId 만 돌려준다.
// 요청 실행 시간 상한이 30초(변경 불가)라서 Bedrock 을 동기로 기다릴 수 없다.
// 그래서 결과를 Ops 테이블에 적어 두고, 브라우저가 planResult 로 받아 간다.

const TABLE = process.env.OPS_TABLE
/** 결과를 들고 있는 시간. 브라우저가 120초 안에 받아 가므로 넉넉하다 */
const PLAN_TTL_SEC = 60 * 60

let ddb = null
const openDdb = () => (ddb ||= DynamoDBDocumentClient.from(new DynamoDBClient({})))

/**
 * 잡 결과 한 건을 적는다. planResult 리졸버가 이 키를 읽는다.
 * @param {string} jobId
 * @param {string} owner - 잡을 띄운 사람. 리졸버가 이것과 호출자를 대조한다
 * @param {Object} body - {status:'done', text, usage, stop} 또는 {status:'error', error}
 */
async function putPlanResult(jobId, owner, body) {
  await openDdb().send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `PLAN#${jobId}`,
      sk: 'RESULT',
      owner,
      status: body.status,
      body: JSON.stringify(body),
      ttl: Math.floor(Date.now() / 1000) + PLAN_TTL_SEC,
    },
  }))
}

/**
 * Bedrock 을 부르고 결과를 적는다. 성공이든 실패든 반드시 한 건 적는다 —
 * 안 적으면 브라우저가 타임아웃까지 빈손으로 기다린다.
 *
 * 던지지 않는 것이 중요하다. Event 호출에서 던지면 Lambda 가 비동기 재시도를 돌려
 * Bedrock 을 또 부른다 (스택에서 retryAttempts 를 0 으로 잡아 두었지만 여기서도 막는다).
 *
 * @param {Object} payload - {jobId, owner, prompt, maxTokens?, model?, think?}
 */
async function plan(payload) {
  const jobId = str(payload?.jobId)
  const owner = str(payload?.owner)
  if (!jobId) throw new Error('plan 에 jobId 가 없다')
  if (!TABLE) throw new Error('OPS_TABLE 이 비어 있다')

  try {
    await putPlanResult(jobId, owner, { status: 'done', ...(await converse(payload)) })
  } catch (err) {
    console.error('[graph] plan 실패', jobId, err)
    await putPlanResult(jobId, owner, { status: 'error', error: str(err?.message) || 'plan 실패' })
  }
  return { jobId, status: 'accepted' }
}

// ── 핸들러 ───────────────────────────────────────────────────────────────────

/** Neptune 을 여는 오퍼레이션. 끊긴 소켓 재연결이 붙는다 */
const GRAPH_OPS = { loadGraph, saveGraph, queryGraph, updateGraph }
/** Neptune 을 쓰지 않는 오퍼레이션. payload 하나만 받는다 */
const PLAIN_OPS = { plan }

/** 프로토타입의 값('constructor' 등)이 오퍼레이션으로 잡히지 않게 자기 키만 본다 */
const pick = (table, name) => (Object.hasOwn(table, name) ? table[name] : null)

exports.handler = async (event) => {
  const name = str(event?.operation)

  const plain = pick(PLAIN_OPS, name)
  if (plain) return await plain(event.payload)

  const op = pick(GRAPH_OPS, name)
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
      console.error('[graph] Neptune 쿼리 실패', name, again)
      throw new Error(`Neptune ${name} 실패: ${again.message || err.message}`)
    }
  }
}
