// AppSync 의 GraphDs 데이터소스가 부르는 Lambda. 두 가지 일을 한다.
//
// Neptune 그래프 저장소. 브라우저의 graph-engine.js 가 기대는 것은 네 가지다.
//   loadGraph    projectId 의 노드·명시 엣지를 mock/graph.json 모양으로 돌려준다
//   saveGraph    그래프 하나를 통째로 덮어쓴다 (추출 직후 한 번)
//   queryGraph   이웃·서브그래프처럼 그래프를 걸어야 답이 나오는 조회
//   updateGraph  역기입. 엣지 끊기 → 노드 얹기 → 엣지 얹기 순서로 돈다.
//                payload.writeback 이 함께 오면 그 한 회차를 StoryHistory 에 남긴다
//
// Bedrock 호출. 대본·분기 생성이 쓴다. 이것만 Event(비동기)로 들어온다.
//   plan         Converse 로 모델을 부르고 결과를 Ops 테이블에 적는다.
//                브라우저는 planResult(jobId) 로 받아 간다. AppSync 30초 상한 우회.
//   navigate     세계관 네비게이터 챗봇. plan 과 같은 비동기 패턴이고 같은 Ops 테이블을 쓴다.
//                브라우저는 navigateResult(jobId) 로 받아 간다.
//
// 파생 엣지는 Neptune 에 넣지 않는다. 규칙은 graph-schema.js 의 deriveEdges 뿐이고
// 그것은 브라우저에서만 돈다. 저장해 두면 규칙을 고친 뒤에도 낡은 파생이 남는다.
//
// props 는 JSON 문자열 한 칸(propsJson)에 담는다. Neptune 프로퍼티는 원시값만 받는다.

const gremlin = require('gremlin')
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime')
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb')

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
 * 엣지는 한 번에 하나씩 보낸다. 같은 노드를 건드리는 쓰기를 겹치면
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
 * @param {Object} payload - {projectId, addNodes, addEdges, removeEdges, writeback?}
 *        writeback 은 이 역기입 한 회차의 변경 요약이다. 오면 StoryHistory 에 남긴다
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

  // 회차 한 줄을 이력에 남긴다. 못 남겨도 역기입은 이미 끝났으므로 던지지 않는다 —
  // 여기서 던지면 화면에 「세계관 저장이 실패했습니다」가 뜨는데 그래프는 멀쩡하다
  if (payload?.writeback) {
    try {
      out.historyKept = await putHistory(projectId, payload.writeback)
    } catch (err) {
      console.error('[graph] 세계관 이력을 남기지 못했다', projectId, err)
      out.historyKept = false
    }
  }
  return out
}

// ── Bedrock ──────────────────────────────────────────────────────────────────
// 원래 AppSync 의 HTTP 데이터소스(BedrockDs)가 /model/{id}/converse 를 직접 쳤다.
// 느린 모델에서 Execution timeout 이 나서 여기로 옮겼다. 보내는 몸통은 그때와 같다. // Converse API 를 SDK 로 부르는 것뿐이라 요청·응답 모양이 바뀌지 않는다.

// 프론트엔드가 spec.model 로 고르는 이름 → Bedrock 모델 id.
// 이름은 화면(app/story-graph.html 의 #modelSel)과 짝이 맞아야 한다.
//
// 배포 리전이 ap-northeast-2(서울)라서 전역(global.anthropic.…) 추론 프로필을 쓴다.
// 서울은 이 모델들의 In-Region 도 Geo 도 지원하지 않는다. 전역 프로필만 붙는다.
// APAC 지역 프로필(apac.…)은 존재하지 않는다. 지역 프로필은 us./eu./au./jp. 뿐이고
// 그중 서울을 소스 리전으로 받는 것이 없다. 잘못 넣으면 ValidationException 이 난다.
// 전역 프로필은 데이터 residency 를 보장하지 않는다. 전 세계 상용 리전으로 라우팅된다.
// 확인: 모델별 상세 페이지의 Regional availability 표
//   https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html
const MODELS = {
  'haiku-4.5': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'sonnet-5': 'global.anthropic.claude-sonnet-5',
  'opus-4.8': 'global.anthropic.claude-opus-4-8',
  'opus-5': 'global.anthropic.claude-opus-5',
}
/** 허용 목록. MODELS 를 이름으로 바로 찾으면 'constructor' 같은 이름이 프로토타입을 짚는다 */
const MODEL_NAMES = ['haiku-4.5', 'sonnet-5', 'opus-4.8', 'opus-5']
const DEFAULT_MODEL = 'sonnet-5'

const SYSTEM = '당신은 광고·단편 영상의 콘티 기획자다. 요청받은 JSON 하나만 출력한다. 설명·머리말·코드펜스를 붙이지 않는다.'

/*
 * Bedrock 오류를 사람이 읽는 한 줄로 바꾼다. 이 문장이 그대로 화면에 뜬다 —
 * 잡 결과는 Ops 테이블을 지나 말풍선·안내 줄로 올라가고, 중간에 옮기는 곳이 없다.
 * 그래서 한때 작가·PD 가 보는 자리에 "Bedrock ServiceUnavailableException:
 * Bedrock is unable to process your request." 가 찍혔다. 원문은 console.error 로만 남긴다.
 * 브라우저 쪽에도 같은 표가 한 벌 있다 (app/services/api.js 의 SAY_BEDROCK) —
 * 이 Lambda 를 아직 못 올린 배포에서도 한국어가 뜨게 하려고 둔 것이다.
 */
const SAY_BEDROCK = {
  ServiceUnavailableException: '일시적으로 AI 서버가 바쁩니다. 잠시 후 다시 시도해주세요',
  ThrottlingException: '요청이 너무 빠릅니다. 잠시 후 다시 시도해주세요',
  TooManyRequestsException: '요청이 너무 빠릅니다. 잠시 후 다시 시도해주세요',
  ModelTimeoutException: '일시적으로 AI 서버가 바쁩니다. 잠시 후 다시 시도해주세요',
}
const BEDROCK_FALLBACK = 'AI 응답 생성 중 오류가 발생했습니다. 다시 시도해주세요'

/**
 * Bedrock 오류 하나를 화면에 올릴 한국어 한 줄로. 표에 없는 것은 한 문장으로 뭉갠다 —
 * 종류를 알아도 작가·PD 가 할 수 있는 일은 다시 눌러 보는 것뿐이다.
 *
 * @param {Error} err - SDK 가 던진 오류
 * @returns {string} 사용자에게 보여 줄 한국어 한 줄
 */
const bedrockSay = (err) => SAY_BEDROCK[str(err?.name)] || BEDROCK_FALLBACK

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
    throw new Error(bedrockSay(err))
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

// ── 세계관 확장 이력 (StoryHistory) ──────────────────────────────────────────
// 역기입 한 번이 한 「회차」다. 브라우저는 그 회차의 변경 요약(writebackSummary)을
// updateGraph 에 writeback 으로 얹어 보내고, 여기서 프로젝트별로 한 줄씩 쌓는다.
//
// 쌓아 두는 이유는 챗봇이다. 한때 네비게이터는 브라우저가 들고 있는 마지막 역기입
// 한 건(recentWriteback)만 받았다. 그래서 "세계관이 몇 번 확장됐어?" 에 늘 1회라고
// 답했고, 새로고침하면 그 한 건도 사라졌다. 이력은 Neptune 처럼 서버에 남는다.
//
// 다만 이 표가 회차를 세는 유일한 자리는 아니다. 여기에 못 적어도(putHistory 는 던지지
// 않는다) 브라우저가 이 판에서 센 회차를 같이 들고 오고, allRounds 가 둘을 합쳐 센다.
//
// Ops 테이블과 달리 TTL 이 없다 (infra/lib/storyboard-stack.js 의 StoryHistory).
// 정렬 키는 ISO 타임스탬프로 시작하므로 Query 의 기본 오름차순이 곧 1회차 → N회차 순이다.

const HISTORY_TABLE = process.env.HISTORY_TABLE
/** 한 프로젝트에서 읽어 오는 회차 상한. 프롬프트에 다 넣지는 않고 총 회차 수를 세는 데 쓴다 */
const HISTORY_READ_MAX = 200
/** 정렬 키 뒤에 붙이는 분기 이름의 길이 상한. 키를 무한정 길게 만들지 않는다 */
const HISTORY_KEY_TAIL = 80

/**
 * 회차 하나의 정렬 키. 시각만으로는 키가 겹칠 수 있다 — 겹치면 뒤에 온 Put 이 앞의
 * 회차를 소리 없이 덮어써서 이력에서 한 회차가 사라진다. 실제로 그렇게 첫 회차를
 * 잃었다 (브라우저가 같은 요약을 두 번 보냈고 시각이 같았다).
 *
 * 그래서 분기 이름을 뒤에 붙인다. 같은 회차를 다시 보내면(핸들러의 재시도) 키가 같아
 * 그대로 덮어쓰고, 다른 회차는 키가 갈라져 둘 다 남는다. ISO 시각이 앞에 있으므로
 * 사전순 정렬은 여전히 시간순이다.
 *
 * @param {string} at - ISO 타임스탬프
 * @param {string} branch - 붙인 분기 이름
 * @returns {string} 정렬 키
 */
function historyKey(at, branch) {
  // '#' 은 자리를 가르는 글자다. 분기 이름에 들어 있으면 키가 헷갈리므로 바꿔 둔다
  const tail = str(branch).replace(/#/g, '＃').slice(0, HISTORY_KEY_TAIL)
  return tail ? `${at}#${tail}` : at
}

/**
 * 역기입 한 회차를 이력에 남긴다. 테이블이 없으면 조용히 지나간다 —
 * 이력은 역기입의 본 일이 아니고, 없어도 그래프는 그대로 자란다.
 *
 * @param {string} projectId
 * @param {Object} wb - 브라우저가 만든 변경 요약 (story-graph.js 의 writebackSummary)
 * @returns {Promise<boolean>} 실제로 남겼으면 true
 */
async function putHistory(projectId, wb) {
  if (!HISTORY_TABLE || !wb || typeof wb !== 'object') return false
  // at 이 비어 있으면 정렬 키가 없다. 받은 시각으로 채워 두고 본문에도 같은 값을 남긴다
  const at = str(wb.at) || new Date().toISOString()
  await openDdb().send(new PutCommand({
    TableName: HISTORY_TABLE,
    Item: { projectId, timestamp: historyKey(at, wb.branch), body: JSON.stringify({ ...wb, at }) },
  }))
  return true
}

/**
 * 한 프로젝트의 역기입 이력을 오래된 것부터 전부 읽는다.
 *
 * 던지지 않는다. 이력을 못 읽어도 질문에는 답해야 한다 — 그때는 지금 그래프와
 * 최근 한 건만으로 답하는, 이력이 붙기 전의 동작으로 내려간다.
 *
 * @param {string} projectId
 * @returns {Promise<Array<Object>>} 1회차부터 순서대로. 못 읽으면 빈 배열
 */
async function listHistory(projectId) {
  if (!HISTORY_TABLE) return []
  const out = []
  try {
    let start
    do {
      const r = await openDdb().send(new QueryCommand({
        TableName: HISTORY_TABLE,
        KeyConditionExpression: 'projectId = :p',
        ExpressionAttributeValues: { ':p': projectId },
        ExclusiveStartKey: start,
      }))
      for (const it of asList(r.Items)) {
        const wb = parseJson(it?.body, null)
        if (wb && typeof wb === 'object') out.push(wb)
      }
      start = r.LastEvaluatedKey
    } while (start && out.length < HISTORY_READ_MAX)
  } catch (err) {
    console.error('[graph] 세계관 이력을 읽지 못했다', projectId, err)
  }
  return out
}

/**
 * Bedrock 을 부르고 결과를 적는다. 성공이든 실패든 반드시 한 건 적는다. * 안 적으면 브라우저가 타임아웃까지 빈손으로 기다린다.
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

// ── navigate 잡 ──────────────────────────────────────────────────────────────
// 세계관 네비게이터 챗봇. plan 과 같은 비동기 패턴이고, 결과도 같은 Ops 테이블의
// 같은 키(PLAN#jobId)에 적는다 — navigateResult 리졸버가 planResult 와 같은 것을 읽는다.
// plan 과 다른 것은 세 가지뿐이다.
//   1) 시스템 프롬프트가 JSON 이 아니라 자연어 답변을 요구한다
//   2) 이전 대화를 messages 에 함께 넣는다 (plan 은 늘 한 턴이다)
//   3) 그래프를 여기서 직렬화한다 — 대본 생성은 브라우저(story.js 의 contextPackPrompt)가 했다

const NAVIGATE_SYSTEM = [
  '당신은 스토리 세계관 네비게이터입니다.',
  '사용자는 작가 또는 PD이며, 아래 캐릭터 관계 그래프를 기반으로 질문합니다.',
  '',
  '규칙:',
  '1. 반드시 그래프 데이터에 근거하여 답변하세요.',
  '2. 그래프에 없는 내용은 추측하지 말고 "현재 그래프에 해당 정보가 없습니다"라고 답하세요.',
  '3. 캐릭터 간 관계를 설명할 때 그 관계를 구체적으로 짚어 말하세요.',
  '4. 추론 규칙으로 파생된 관계는 "[추론]"으로 표시하세요.',
  '5. 비전문가가 이해할 수 있는 자연어로, 한국어로 답변하세요.',
  '6. 답변은 간결하게 하되, 필요한 맥락은 빠뜨리지 마세요.',
  '7. "## 최근 세계관 변경 사항" 블록이 있으면, 방금 무엇이 바뀌었는지 묻는 질문에는'
    + ' 그 목록만 근거로 답하세요. 블록이 없으면 최근에 무엇이 바뀌었는지 알 수 없다고 답하세요.',
  /*
   * 아래 컨텍스트는 그래프에서 편 것이라 목록 모양이다. 그것을 그대로 베끼면 작가·PD 가
   * 읽는 자리에 "재혁 → reveals → 강회장 비리" 같은 줄이 찍힌다. 답변은 사람의 말이어야 한다.
   */
  '8. 그래프 용어(노드, 엣지, 트리플, 술어)와 영문 관계 이름을 답변에 쓰지 마세요.'
    + ' "A → rel → B" 같은 화살표 표기도 쓰지 마세요. 한국어 문장으로 풀어 쓰세요'
    + ' (예: "재혁이 강회장의 비리를 폭로했습니다", "재혁이 강회장을 보좌하던 관계가 사라졌습니다").',
  /*
   * 9~11 은 누적 이력을 묻는 질문의 자리다. 이력 블록이 붙기 전에는 최근 한 건만
   * 들고 있었고, "세계관이 몇 번 확장됐어?" 에 늘 1회라고 답했다. 회차 수와 회차별
   * 요약은 블록에 그대로 적혀 오므로, 모델이 할 일은 그것을 사람의 말로 옮기는 것뿐이다.
   */
  '9. 세계관이 몇 번 업데이트·확장되었는지 묻는 질문에는 "## 세계관 확장 누적 이력" 블록의'
    + ' 총 회차 수를 먼저 말하고, 회차마다 한 줄 요약을 이어 붙이세요.'
    + ' 그 블록이 없으면 확장된 적이 없다고 답하세요.',
  '10. 누적 히스토리를 묻는 질문에는 1회차부터 시간순으로 회차별 추가·변경·삭제 내역을'
    + ' 정리해서 답하세요. 생략된 회차가 있다고 적혀 있으면 그 사실도 함께 말하세요.',
  '11. 회차는 "1회차", "2회차" 처럼 번호로 구분하고, 그 회차에 붙인 분기 이름이 있으면'
    + ' 번호와 함께 적으세요 (예: "2회차: \'A. 먼저 보여준 손\'").',
].join('\n')

/** 챗봇 답변 상한. 대본 생성(2000~4000)보다 짧다 */
const NAVIGATE_MAX_TOKENS = 2000
/** 프롬프트에 넣는 그래프 텍스트 상한. 넘치면 뒤를 자른다 */
const GRAPH_CTX_MAX = 12000
/** 모델에 다시 넣는 이전 대화 수. 오래된 턴은 버린다 */
const HISTORY_MAX = 10

/** AWSJSON 으로 온 문자열을 푼다. 깨졌으면 기본값 */
function parseJson(raw, dflt) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw) return dflt
  try {
    const v = JSON.parse(raw)
    return v === null || v === undefined ? dflt : v
  } catch {
    return dflt
  }
}

/** 프롬프트에 회차별로 펴 놓는 이력의 상한. 더 있으면 오래된 쪽을 생략하고 그 사실을 적는다 */
const HISTORY_ROUNDS_MAX = 10

/** 목록이 잘려 왔으면 개수를 앞세워 "이게 전부" 로 읽히지 않게 한다 */
function headKo(name, list, total) {
  const n = Number(total) >= list.length ? total : list.length
  return `${name} ${n}개${n > list.length ? ` (아래는 그중 ${list.length}개)` : ''}:`
}

/**
 * 역기입 한 회차의 변경 목록을 사람이 읽는 줄로 편다. 최근 한 건 블록과 누적 이력의
 * 회차 하나가 같은 줄 모양을 쓰도록 한 곳에 둔다.
 *
 * 줄은 브라우저가 한국어로 옮겨 보낸 것(wb.ko)을 먼저 쓴다. 술어 → 한국어 표는
 * app/domain/graph-ko.js 한 벌이고 이 Lambda 는 그것을 모른다 — 옮긴 줄이 없을 때만
 * 영문 술어를 그대로 적는다 (지난 판의 브라우저가 보낸 요약).
 *
 * @param {Object} wb - {at, branch, addedNodes, addedEdges, removedEdges, counts, ko?}
 * @param {Function} nm - id → 이름. graphContext 가 만든 표를 그대로 받는다
 * @returns {Array<string>|null} 변경이 하나도 없으면 null
 */
function changeLines(wb, nm) {
  if (!wb) return null
  const arrow = (e) => `${nm(e?.s)} --${str(e?.p) || '관계'}--> ${nm(e?.o)}${e?.derived ? ' [추론]' : ''}`
  /** 한국어로 옮겨 온 줄이 있으면 그것, 없으면 날것을 fmt 로 편다 */
  const lines = (ko, raw, fmt) => (asList(ko).length ? asList(ko).map(str) : asList(raw).map(fmt))
  const nodes = lines(wb?.ko?.nodes, wb?.addedNodes, nm)
  const added = lines(wb?.ko?.added, wb?.addedEdges, arrow)
  const removed = lines(wb?.ko?.removed, wb?.removedEdges, arrow)
  if (!nodes.length && !added.length && !removed.length) return null

  const counts = wb?.counts || {}
  const out = []
  if (nodes.length) out.push(headKo('새로 생긴 것', nodes, counts?.addedNodes), ...nodes.map((s) => `- ${s}`))
  else out.push('새로 생긴 것: 없다')
  if (added.length) out.push(headKo('새 관계', added, counts?.addedEdges), ...added.map((s) => `- ${s}`))
  else out.push('새 관계: 없다')
  if (removed.length) out.push(headKo('사라진 관계', removed, counts?.removedEdges), ...removed.map((s) => `- ${s}`))
  else out.push('사라진 관계: 없다')
  return out
}

/**
 * 방금 판에 붙인 역기입 한 번의 변경을 텍스트로 편다. 브라우저가 graphData 에
 * recentWriteback 으로 얹어 보낸다 (story-graph.js 의 writebackSummary) —
 * 현재 스냅샷만으로는 무엇이 새것인지 알 수 없어서 "방금 뭐가 추가됐어?" 에 답할 수 없다.
 *
 * 역기입을 한 적이 없으면 빈 문자열이다. 그때는 이 블록이 아예 붙지 않는다.
 *
 * @param {Object} wb - 회차 하나의 변경 요약
 * @param {Function} nm - id → 이름
 * @param {Object} [o]
 * @param {boolean} [o.earlier] - 앞 회차도 함께 넘겼는가. 누적 이력 블록이 붙는 판에서는
 *        "그 앞은 알 수 없다" 가 거짓이 되므로 그 한 줄을 뺀다
 * @returns {string} 프롬프트에 붙이는 블록. 변경이 없으면 빈 문자열
 */
function writebackContext(wb, nm, { earlier = false } = {}) {
  const body = changeLines(wb, nm)
  if (!body) return ''
  const out = ['## 최근 세계관 변경 사항']
  if (wb?.branch) out.push(`붙인 분기: ${str(wb.branch)}`)
  if (wb?.at) out.push(`붙인 시각: ${str(wb.at)}`)
  out.push(earlier
    ? '이 목록이 이 그래프에서 가장 최근에 바뀐 것 전부다. 그 앞의 변경은 누적 이력에 있다.'
    : '이 목록이 이 그래프에서 가장 최근에 바뀐 것 전부다. 그 앞의 변경은 알 수 없다.')
  out.push(...body)
  return out.join('\n')
}

/**
 * 이 프로젝트의 역기입 이력을 회차별로 편다. "세계관이 몇 번 확장됐어?" 와
 * "누적 히스토리 알려줘" 가 근거로 쓰는 블록이다 (NAVIGATE_SYSTEM 9~11).
 *
 * 회차 번호는 1회차부터 센다. 총 회차 수는 생략한 것까지 포함한 전체이고,
 * 펴 놓는 것은 뒤쪽 HISTORY_ROUNDS_MAX 회차뿐이다 — 프롬프트가 이력만으로
 * 불어나면 정작 답이 짧아진다.
 *
 * @param {Array<Object>} rounds - 1회차부터 순서대로 (listHistory 가 준 순서)
 * @param {Function} nm - id → 이름
 * @returns {string} 프롬프트에 붙이는 블록. 이력이 없으면 빈 문자열
 */
function historyContext(rounds, nm) {
  const all = asList(rounds)
  if (!all.length) return ''
  const skipped = Math.max(0, all.length - HISTORY_ROUNDS_MAX)
  const out = [
    '## 세계관 확장 누적 이력',
    `이 프로젝트의 세계관은 지금까지 총 ${all.length}회 확장되었다.`,
    '회차는 1회차부터 시간순이다.',
  ]
  if (skipped) out.push(`아래에는 최근 ${HISTORY_ROUNDS_MAX}회차만 적는다. 이전 ${skipped}회차는 생략했다.`)
  for (let i = skipped; i < all.length; i++) {
    const wb = all[i]
    const head = `### ${i + 1}회차${wb?.branch ? ` · ${str(wb.branch)}` : ''}${wb?.at ? ` (${str(wb.at)})` : ''}`
    out.push('', head, ...(changeLines(wb, nm) || ['변경 내역이 남아 있지 않다.']))
  }
  return out.join('\n')
}

/** 회차 하나의 신원. putHistory 의 정렬 키와 같은 짝이다 (historyKey) */
const roundKey = (wb) => `${str(wb?.at)}#${str(wb?.branch)}`

/** 이 회차에 남아 있는 내역의 양. 같은 회차가 두 곳에서 오면 많은 쪽을 남긴다 */
const roundDetail = (wb) => asList(wb?.ko?.nodes).length + asList(wb?.ko?.added).length
  + asList(wb?.ko?.removed).length + asList(wb?.addedNodes).length
  + asList(wb?.addedEdges).length + asList(wb?.removedEdges).length

/**
 * 서버 이력과 브라우저가 들고 온 회차를 한 줄로 합친다. 회차 수를 세는 근거다.
 *
 * 세 곳에서 온다. 서버 이력(listHistory)이 사실이고, 나머지 둘은 그것이 모자랄 때의
 * 받침이다 — 이력 쓰기는 실패할 수 있고(putHistory 는 던지지 않는다), 이력 표가 없는
 * 배포도 있고, 로컬·인메모리 판에는 남길 곳이 아예 없다.
 *
 *   rounds   StoryHistory 에 쌓인 회차. 1회차부터 순서대로
 *   session  브라우저가 이 판에서 센 회차 전부 (graphData.writebackRounds)
 *   recent   그중 마지막 한 건을 통째로 (graphData.recentWriteback)
 *
 * 한때 recent 하나만 받았다. 그래서 이력 쓰기 한 건이 떨어지면 두 번 붙인 세계관이
 * "1회 확장" 으로 답해지고 첫 회차가 사라졌다 — 화면에도 콘솔에도 아무 말이 없었다.
 *
 * 같은 회차는 시각+분기로 하나로 센다. 겹칠 때는 내역이 많은 쪽을 남긴다 (브라우저가
 * 들고 오는 지난 회차는 줄 수를 줄여 온다 · graph-writeback.js 의 thinWritebackRound).
 *
 * @param {Array<Object>} rounds - listHistory 가 읽어 온 회차
 * @param {Object|null} recent - 브라우저가 얹어 보낸 recentWriteback
 * @param {Array<Object>} [session] - 브라우저가 얹어 보낸 writebackRounds
 * @returns {Array<Object>} 시간순. 1회차부터
 */
function allRounds(rounds, recent, session) {
  const byKey = new Map()
  const put = (wb) => {
    if (!wb || typeof wb !== 'object') return
    const k = roundKey(wb)
    const had = byKey.get(k)
    if (!had || roundDetail(wb) > roundDetail(had)) byKey.set(k, wb)
  }
  asList(rounds).forEach(put)
  asList(session).forEach(put)
  put(recent)
  // at 이 ISO 시각이라 사전순이 곧 시간순이다 (historyKey 와 같은 근거)
  return [...byKey.values()].sort((a, b) => str(a.at).localeCompare(str(b.at)))
}

/**
 * 그래프 하나를 사람이 읽는 텍스트로 편다. 엣지 이름은 s/p/o 로 오지만
 * source/predicate/target 으로 오는 경우도 받는다.
 *
 * 역기입 이력(rounds)과 최근 역기입 요약(recentWriteback)이 있으면 블록 두 개를 뒤에
 * 붙인다. 그래프를 상한에서 자른 뒤에 붙이므로, 판이 커도 이 블록들은 잘려 나가지 않는다.
 *
 * @param {string|Object} raw - JSON 문자열 또는
 *        {nodes, edges, recentWriteback?, writebackRounds?}. 뒤의 둘은 브라우저가
 *        이 판에서 센 회차다. 서버 이력과 겹치는 것은 allRounds 가 하나로 센다
 * @param {Array<Object>} [rounds] - listHistory 가 읽어 온 회차. 1회차부터 순서대로
 * @returns {string} 프롬프트에 그대로 붙이는 그래프 컨텍스트
 */
function graphContext(raw, rounds = []) {
  const data = parseJson(raw, {})
  const nodes = asList(data?.nodes)
  const edges = asList(data?.edges)
  if (!nodes.length && !edges.length) return '(그래프가 비어 있다)'

  const label = new Map()
  for (const n of nodes) label.set(str(n?.id), str(n?.name) || str(n?.id))
  const nm = (id) => label.get(str(id)) || str(id) || '(알 수 없음)'

  const nodeLines = nodes.map((n) => `- ${str(n?.name) || str(n?.id)} (${str(n?.kind) || '종류 없음'})`)
  /*
   * 엣지 한 줄. 브라우저가 한국어 서술(e.ko)을 달아 보내면 그것을 쓴다 — 영문 술어를
   * 프롬프트에 넣으면 모델이 그대로 베껴 답변에 새어 나온다 (NAVIGATE_SYSTEM 8번).
   * 술어 → 한국어 표는 app/domain/graph-ko.js 한 벌이라 이쪽에서는 옮길 수 없다.
   */
  const koEdges = edges.some((e) => str(e?.ko))
  const edgeLines = edges.map((e) => {
    const p = str(e?.p ?? e?.predicate)
    const body = str(e?.ko) || `${nm(e?.s ?? e?.source)} --${p || '관계'}--> ${nm(e?.o ?? e?.target)}`
    // ko 는 [추론] 을 이미 달고 온다. 두 번 붙지 않게 본다
    return `- ${body}${isDerived(e) && !body.includes('[추론]') ? ' [추론]' : ''}`
  })

  const text = [
    `[노드 ${nodes.length}개] 이름 (종류)`,
    ...nodeLines,
    '',
    koEdges ? `[관계 ${edges.length}개] 한 줄에 관계 하나씩, 한국어 서술이다`
      : `[관계 ${edges.length}개] 출발 --관계--> 도착`,
    ...edgeLines,
  ].join('\n')
  const body = text.length <= GRAPH_CTX_MAX ? text : `${text.slice(0, GRAPH_CTX_MAX)}\n(그래프를 여기서 잘랐다)`

  /*
   * 이력의 마지막 회차가 곧 「최근 변경」이다. 두 블록에 같은 회차가 두 번 적히지만
   * 하는 일이 다르다 — 이력은 회차를 세는 근거고(9~11번), 최근 블록은 "방금 뭐가
   * 바뀌었어?" 의 근거다(7번). 총 회차 수는 이력 블록에 숫자로 적어 두므로 두 번
   * 세이지 않는다.
   */
  const all = allRounds(rounds, data?.recentWriteback, data?.writebackRounds)
  const parts = [body]
  const past = historyContext(all, nm)
  if (past) parts.push(past)
  const recent = writebackContext(all[all.length - 1], nm, { earlier: all.length > 1 })
  if (recent) parts.push(recent)
  return parts.join('\n\n')
}

/**
 * 이전 대화 + 이번 질문을 Converse 의 messages 로 만든다.
 * Converse 는 user 로 시작해서 user·assistant 가 번갈아 와야 한다 —
 * 어긋나면 ValidationException 이라서 여기서 모양을 맞춘다.
 *
 * @param {string|Array} historyRaw - [{role, content}, ...]
 * @param {string} finalText - 마지막 user message 로 들어갈 그래프 컨텍스트 + 질문
 * @returns {Array} ConverseCommand 의 messages
 */
function chatMessages(historyRaw, finalText) {
  const out = []
  const push = (role, content) => {
    const text = str(content)
    if (!text) return
    const last = out[out.length - 1]
    // 같은 역할이 이어지면 버리지 않고 한 칸으로 합친다
    if (last && last.role === role) last.content[0].text += `\n\n${text}`
    else out.push({ role, content: [{ text }] })
  }

  for (const m of asList(parseJson(historyRaw, [])).slice(-HISTORY_MAX)) {
    const role = m?.role === 'assistant' ? 'assistant' : 'user'
    if (!out.length && role !== 'user') continue // assistant 로 시작할 수 없다
    push(role, m?.content)
  }
  push('user', finalText)
  return out
}

/**
 * 질문 하나에 답하고 결과를 적는다. plan 과 같이 던지지 않는다 —
 * Event 호출에서 던지면 Lambda 가 비동기 재시도를 돌려 Bedrock 을 또 부른다.
 *
 * @param {Object} payload - {jobId, owner, projectId, question, graphData, conversationHistory, model}
 */
async function navigate(payload) {
  const jobId = str(payload?.jobId)
  const owner = str(payload?.owner)
  if (!jobId) throw new Error('navigate 에 jobId 가 없다')
  if (!TABLE) throw new Error('OPS_TABLE 이 비어 있다')

  try {
    const question = str(payload?.question).trim()
    if (!question) throw new Error('질문이 비어 있습니다')

    const asked = str(payload?.model)
    const modelId = MODELS[MODEL_NAMES.includes(asked) ? asked : DEFAULT_MODEL]
    // 역기입 이력은 서버에 남아 있다. 브라우저가 들고 오는 것은 마지막 한 건뿐이라
    // 이것 없이는 "몇 번 확장됐어?" 에 늘 1회라고 답한다 (listHistory 의 머리글)
    const rounds = await listHistory(pid(payload))
    const messages = chatMessages(payload?.conversationHistory, [
      '## 현재 세계관 그래프',
      graphContext(payload?.graphData, rounds),
      '',
      '## 질문',
      question,
    ].join('\n'))

    let out
    try {
      out = await openBedrock().send(new ConverseCommand({
        modelId,
        system: [{ text: NAVIGATE_SYSTEM }],
        messages,
        inferenceConfig: { maxTokens: NAVIGATE_MAX_TOKENS },
        additionalModelRequestFields: { thinking: { type: 'disabled' } },
      }))
    } catch (err) {
      console.error('[graph] Bedrock Converse 실패', modelId, err)
      throw new Error(bedrockSay(err))
    }

    // 여러 칸으로 쪼개져 올 수 있다. text 인 칸만 이어 붙인다
    let text = ''
    for (const c of out.output?.message?.content || []) if (typeof c.text === 'string') text += c.text
    await putPlanResult(jobId, owner, { status: 'done', text, usage: out.usage, stop: out.stopReason })
  } catch (err) {
    console.error('[graph] navigate 실패', jobId, err)
    await putPlanResult(jobId, owner, { status: 'error', error: str(err?.message) || 'navigate 실패' })
  }
  return { jobId, status: 'accepted' }
}

// ── 프로젝트 삭제 ────────────────────────────────────────────────────────────
//
// 리졸버가 아니라 여기서 하는 이유는 지울 것이 몇 개인지 모른다는 것이다. 한 프로젝트에
// 남는 것은 세 갈래다.
//
//   pk='PROJECTS'   sk='P#<boardId>'   카드 한 장
//   pk=BOARD#<id>   sk='ASSET#…'       에셋 여섯 개까지
//   pk=BOARD#<id>   sk='OP#…'          컷·댓글·명부. 수백 줄이 된다
//
// 마지막 것이 문제다. AppSync 의 JS 리졸버는 한 번에 한 요청만 보내고 그 안에서 돌 수
// 없어서, op 가 BatchWriteItem 한 번(25건)을 넘으면 나머지가 남는다. 반쯤 지워진
// 프로젝트는 지우지 않은 것보다 나쁘다 — 카드는 사라졌는데 보드를 주소로 열면 컷이
// 그대로 있고, 아무 화면에서도 그것을 다시 지울 수 없다.
//
// 그래서 Query → BatchWrite 를 다 지울 때까지 돈다. Neptune 의 그래프도 같은 자리에서
// 지운다. 브라우저는 이 오퍼레이션 하나만 부르면 된다.

const { QueryCommand, BatchWriteCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb')

/** BatchWriteItem 한 번에 담을 수 있는 최대. DynamoDB 가 정한 값이다 */
const BATCH = 25
/*
 * 한 번의 삭제에서 돌 수 있는 배치의 상한. 25 × 200 = 5,000 줄이다.
 *
 * 상한을 두는 이유는 Lambda 가 120초에 끊긴다는 것이다. 끊기면 반쯤 지워진 채로 남고
 * 그것이 위에 적은 최악의 상태다. 상한에 닿으면 남은 수를 세어 돌려주고, 부르는 쪽이
 * 「다 못 지웠다」고 말한다. 조용히 멈추지 않는 것이 요점이다.
 */
const MAX_ROUNDS = 200

/** 키 한 묶음을 지운다. DynamoDB 가 처리하지 못하고 돌려준 것은 다시 넣는다 */
async function dropKeys(keys) {
  let left = keys
  let tries = 0
  while (left.length && tries < 5) {
    tries += 1
    const res = await openDdb().send(new BatchWriteCommand({
      RequestItems: { [TABLE]: left.slice(0, BATCH).map((Key) => ({ DeleteRequest: { Key } })) },
    }))
    const un = res.UnprocessedItems?.[TABLE] || []
    // 처리하지 못한 것 + 아직 보내지 않은 것
    left = [...un.map((r) => r.DeleteRequest.Key), ...left.slice(BATCH)]
  }
  return left.length
}

/**
 * 프로젝트 하나를 지운다. 카드 · 에셋 · op 로그 · Neptune 그래프 전부다.
 *
 * 지우는 순서가 있다. 카드를 마지막에 지운다. 중간에 끊기면 카드가 남아 있어야 사람이
 * 목록에서 그 프로젝트를 다시 찾아 다시 지울 수 있다. 카드를 먼저 지우면 남은 op 를
 * 어느 화면에서도 가리킬 수 없다.
 *
 * Neptune 이 실패해도 DynamoDB 는 계속 지운다. 그래프만 남는 것은 되돌릴 수 있다 —
 * 대본을 다시 넣고 추출하면 saveGraph 가 projectId 째로 덮어쓴다(위의 saveGraph).
 *
 * @param {Object} payload - {boardId, projectId?}
 * @returns {Promise<Object>} {deleted:{ops,assets,card}, left, graph}
 */
async function deleteProject(payload) {
  const boardId = str(payload?.boardId)
  if (!boardId) throw new Error('deleteProject 에 boardId 가 없다')
  if (!TABLE) throw new Error('OPS_TABLE 이 비어 있다')

  const ddbc = openDdb()
  const pk = `BOARD#${boardId}`
  let ops = 0
  let assets = 0
  let left = 0
  let round = 0
  let more = true

  /*
   * 한 판의 op 와 에셋은 같은 pk 에 산다. 그래서 Query 한 번이 둘을 같이 집는다.
   * 세는 것만 sk 로 갈라 둔다 — 「op 340줄과 에셋 3개를 지웠습니다」가 「343줄을
   * 지웠습니다」보다 사람에게 무엇을 잃었는지 말해 준다.
   *
   * LastEvaluatedKey 를 이어받지 않고 늘 처음부터 다시 묻는다. 방금 지운 자리를 커서로
   * 가리키면 그 뒤부터 읽게 되고, 지우는 중에 남는 것이 생긴다. 앞이 비어 있으므로
   * 다시 묻는 값도 같다.
   */
  while (more && round < MAX_ROUNDS) {
    round += 1
    const page = await ddbc.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': pk },
      ProjectionExpression: 'pk, sk',
      Limit: BATCH,
    }))
    const items = page.Items || []
    for (const it of items) {
      if (str(it.sk).startsWith('ASSET#')) assets += 1
      else ops += 1
    }
    if (items.length) left += await dropKeys(items.map(({ pk: p, sk }) => ({ pk: p, sk })))
    // 한 페이지를 꽉 채워 받았으면 더 있을 수 있다. 덜 받았으면 그것이 마지막이다
    more = items.length === BATCH
  }
  // 상한에 닿았는데 아직 남아 있다. 카드를 남겨 다시 지울 수 있게 한다
  if (more) left += 1

  // Neptune. 실패해도 던지지 않는다
  let graph = 'skipped'
  if (ENDPOINT) {
    try {
      await open().V().has('projectId', str(payload?.projectId || boardId)).drop().iterate()
      graph = 'dropped'
    } catch (err) {
      reset()
      console.error('[graph] 그래프를 지우지 못했다', boardId, err)
      graph = `failed: ${str(err?.message)}`
    }
  }

  // 카드는 마지막이다. 이것이 남아 있으면 다시 지울 수 있다
  let card = 0
  if (!left) {
    await ddbc.send(new DeleteCommand({
      TableName: TABLE,
      Key: { pk: 'PROJECTS', sk: `P#${boardId}` },
    }))
    card = 1
  }

  return { boardId, deleted: { ops, assets, card }, left, graph }
}

// ── 핸들러 ───────────────────────────────────────────────────────────────────

/** Neptune 을 여는 오퍼레이션. 끊긴 소켓 재연결이 붙는다 */
const GRAPH_OPS = { loadGraph, saveGraph, queryGraph, updateGraph }
/*
 * Neptune 을 쓰지 않는 오퍼레이션. payload 하나만 받는다.
 *
 * deleteProject 는 Neptune 도 만지지만 여기에 둔다. GRAPH_OPS 쪽은 g 를 인자로 받고
 * 실패하면 통째로 다시 돌리는데(재연결), 이 일은 두 번 돌면 이미 지운 것을 또 세어
 * 「op 340줄을 지웠다」를 두 번 말한다. 그래프 실패는 자기 안에서 삼킨다.
 */
const PLAIN_OPS = { plan, navigate, deleteProject }

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
