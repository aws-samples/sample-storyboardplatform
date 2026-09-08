
import { idToken } from './auth.js'

const uuid = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export async function connect(h) {
  const cfg = window.SB_CONFIG
  return cfg?.graphqlUrl ? awsTransport(cfg, h) : localTransport(h)
}

function localTransport(h) {
  const channel = new BroadcastChannel('storyboard-demo')
  let latency = 0
  const me = uuid()

  channel.onmessage = (e) => {
    const m = e.data
    if (m.from === me) return
    if (m.t === 'op') h.onOp(m.op)
    else if (m.t === 'presence') h.onPresence(m.p)
  }

  const post = (msg) => {
    const payload = { ...msg, from: me }
    if (latency > 0) setTimeout(() => channel.postMessage(payload), latency)
    else channel.postMessage(payload)
  }

  h.onStatus('open')
  return {
    mode: 'local',
    boardId: 'local',
    sendOp: (op) => post({ t: 'op', op }),
    sendPresence: (p) => post({ t: 'presence', p }),
    fetchOps: async () => null,
    setLatency: (ms) => { latency = ms },
  }
}

const OP_FIELDS = 'boardId id ts actor body'

const pad = (ts) => String(ts).padStart(13, '0')

const Q_LIST = `query List($boardId: ID!, $since: String, $nextToken: String) {
  listOps(boardId: $boardId, since: $since, nextToken: $nextToken) {
    items { ${OP_FIELDS} }
    nextToken
  }
}`

const M_OP = `mutation Pub($boardId: ID!, $id: ID!, $ts: String!, $actor: ID!, $body: String!) {
  publishOp(boardId: $boardId, id: $id, ts: $ts, actor: $actor, body: $body) { ${OP_FIELDS} }
}`

const M_PRESENCE = `mutation Beat($boardId: ID!, $actor: ID!, $body: String!) {
  publishPresence(boardId: $boardId, actor: $actor, body: $body) { boardId actor body }
}`

// plan 은 Query 가 아니라 Mutation 이다. AppSync 요청 실행 시간 상한이 30초(변경 불가)라서
// 느린 모델을 동기로 기다리면 Execution timeout 이 난다. 띄우고 결과를 따로 받아 간다.
const M_PLAN = `mutation Plan($spec: AWSJSON!) { plan(spec: $spec) { jobId status } }`
const Q_PLAN_RESULT = `query PlanResult($jobId: ID!) { planResult(jobId: $jobId) }`

const S_OP = `subscription OnOp($boardId: ID!) { onOp(boardId: $boardId) { ${OP_FIELDS} } }`
const S_PRESENCE = `subscription OnBeat($boardId: ID!) {
  onPresence(boardId: $boardId) { boardId actor body }
}`

const gqlPost = async (cfg, query, variables) => {
  const res = await fetch(cfg.graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: await idToken() },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (json.errors?.length) throw new Error(json.errors[0].message)
  return json.data
}

/**
 * AWSJSON 필드 하나를 값으로 푼다.
 *
 * 배포된 리졸버들은 response 에서 JSON.stringify(...) 한 문자열을 AWSJSON 필드로 내보낸다.
 * AppSync 가 AWSJSON 을 내보낼 때 한 번 더 감싸기 때문에, 한 번 파싱하면 값이 아니라
 * JSON 문자열이 또 나온다 ('"{\"text\":...}"' → '{"text":...}' → {text:...}).
 * 그래서 문자열이 남아 있으면 한 번 더 푼다. 리졸버가 나중에 ctx.result 를 그대로
 * 돌려주도록 고쳐도 이 함수는 그대로 맞는다. 그때는 첫 파싱에서 값이 나온다.
 *
 * @param {*} raw - json.data 의 AWSJSON 필드 값
 * @returns {*} 파싱한 값
 */
export const parseField = (raw) => {
  const v = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (typeof v !== 'string') return v
  // 한 겹 더 싸여 온 것은 객체나 배열이다. 값이 진짜 문자열인 경우('42', 대본 텍스트)
  // 까지 풀면 타입이 바뀌므로, 여는 괄호로 시작할 때만 한 번 더 푼다
  const s = v.trim()
  if (!s.startsWith('{') && !s.startsWith('[')) return v
  try {
    return JSON.parse(s)
  } catch {
    return v
  }
}

/** Lambda 타임아웃과 같다. 이보다 오래 걸리면 결과가 올 곳이 없다 */
export const PLAN_TIMEOUT_MS = 120_000
const PLAN_POLL_MS = 1500
/** 연속 폴링 실패 허용치. 한 번 끊긴 것으로 잡을 버리지 않는다 */
const PLAN_POLL_FAILS = 5

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * plan 한 건을 띄우고 끝날 때까지 기다린다. 30초 상한을 우회하는 곳이다.
 *
 * 1) mutation 으로 잡을 띄운다. Lambda 를 Event 로 부르고 jobId 만 즉시 온다 (1초 이내)
 * 2) planResult(jobId) 를 폴링한다. 결과는 잡을 띄운 사람만 읽을 수 있다. *    브로드캐스트가 아니라 자기 jobId 를 직접 읽는 것이라 남의 화면에 새지 않는다
 * 3) done 이면 {text, usage, stop} 을 돌려준다. 예전 동기 plan 과 같은 모양이라
 *    story.js 의 호출부는 그대로다
 *
 * @param {Function} post - (query, variables) => Promise<data>
 * @param {Object} spec - {prompt, maxTokens?, model?, think?}
 * @param {Object} [opts] - {pollMs, timeoutMs}. 테스트에서 기다리지 않게 두는 문이다
 * @returns {Promise<{text: string, usage: Object, stop: string}>}
 */
export async function runPlanJob(post, spec, opts = {}) {
  const pollMs = opts.pollMs ?? PLAN_POLL_MS
  const timeoutMs = opts.timeoutMs ?? PLAN_TIMEOUT_MS

  const started = await post(M_PLAN, { spec: JSON.stringify(spec) })
  const jobId = started?.plan?.jobId
  if (!jobId) throw new Error('plan jobId 를 받지 못했습니다')

  const deadline = Date.now() + timeoutMs
  let fails = 0
  while (Date.now() < deadline) {
    await sleep(pollMs)

    let got
    try {
      got = parseField((await post(Q_PLAN_RESULT, { jobId })).planResult)
      fails = 0
    } catch (e) {
      // Bedrock 은 계속 돌고 있다. 몇 번은 참고 다시 물어본다
      if (++fails > PLAN_POLL_FAILS) throw e
      continue
    }

    if (got?.status === 'done') return { text: got.text, usage: got.usage, stop: got.stop }
    if (got?.status === 'error') throw new Error(got.error || 'plan 실패')
  }
  throw new Error(`plan 이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다`)
}

/**
 * plan 만 쓰는 최소 클라이언트. story-graph.html 처럼 보드 동기화(구독·프레즌스)는
 * 필요 없고 Bedrock 호출만 하는 화면에서 쓴다.
 *
 * @returns {{plan: Function}|null} 설정이 없으면 null. 부르는 쪽은 로컬 모드로 내려간다
 */
export function planClient() {
  const cfg = window.SB_CONFIG
  if (!cfg?.graphqlUrl) return null
  return { plan: (spec) => runPlanJob((query, variables) => gqlPost(cfg, query, variables), spec) }
}

/**
 * 로그만 읽는 최소 클라이언트. 홈처럼 활동 내역만 보여주는 화면에서 씁니다.
 *
 * connect() 를 쓰지 않는 이유는 그쪽이 WebSocket 을 열고 구독 두 개를 붙이고
 * connection_ack 을 기다린다는 것입니다. 홈은 실시간으로 바뀔 것이 없고 한 번 읽어
 * 그리면 끝입니다. 문 앞에서 소켓을 붙잡고 있을 이유가 없습니다.
 *
 * 쓰기(sendOp)도 하나 둡니다. 보드 화면 밖에서도 「누가 뭘 했다」를 같은 로그에 남길
 * 수 있어야 하기 때문입니다. 키비주얼과 디벨롭이 그렇게 씁니다. connect() 쪽의
 * sendOp 과 달리 실패하면 대기열에 넣지 않고 그대로 던집니다. 기록은 화면의 본 일이
 * 아니므로 부르는 쪽이 조용히 넘깁니다.
 *
 * @param {string} [boardId] - 없으면 설정의 기본 보드
 * @returns {{boardId: string, fetchOps: Function, sendOp: Function}|null} 설정이 없으면 null
 */
export function opsClient(boardId) {
  const cfg = window.SB_CONFIG
  if (!cfg?.graphqlUrl) return null
  const id = boardId || cfg.boardId || 'demo'
  return {
    boardId: id,
    sendOp: (op) => gqlPost(cfg, M_OP, {
      boardId: id, id: op.id, ts: pad(op.ts), actor: op.actor, body: JSON.stringify(op),
    }),
    fetchOps: async (since) => {
      const out = []
      let token = null
      do {
        const d = await gqlPost(cfg, Q_LIST, { boardId: id, since: since ? pad(since) : null, nextToken: token })
        for (const it of d.listOps.items) {
          try { out.push(JSON.parse(it.body)) } catch {  }
        }
        token = d.listOps.nextToken
      } while (token)
      return out.sort((a, b) => a.ts - b.ts)
    },
  }
}

const PROJECT_FIELDS = 'boardId name createdAt createdBy updatedAt lastActor lastWhat'

const Q_PROJECTS = `query Projects($nextToken: String) {
  listProjects(nextToken: $nextToken) {
    items { ${PROJECT_FIELDS} }
    nextToken
  }
}`

const M_PUT_PROJECT = `mutation PutProject($boardId: ID!, $name: String, $actor: ID!, $what: String, $ts: String!) {
  putProject(boardId: $boardId, name: $name, actor: $actor, what: $what, ts: $ts) { ${PROJECT_FIELDS} }
}`

/**
 * 프로젝트 카드를 읽고 쓰는 클라이언트. 작업판 앞에 세우는 보드가 씁니다.
 *
 * op 로그와 따로 두는 까닭은 두 가지입니다. op 는 pk=BOARD#<id> 로 흩어져 있어서
 * 「보드가 몇 개 있나」를 물으면 테이블을 훑어야 하고, 30일 TTL 이 걸려 있어서
 * 한 달 쉰 프로젝트는 이름까지 사라집니다. 카드는 pk='PROJECTS' 한 자리에 모으고
 * TTL 을 걸지 않습니다.
 *
 * @returns {{list: Function, put: Function}|null} 설정이 없으면 null · 부르는 쪽이
 *          브라우저 저장소로 내려갑니다
 */
export function projectsClient() {
  const cfg = window.SB_CONFIG
  if (!cfg?.graphqlUrl) return null
  return {
    list: async () => {
      const out = []
      let token = null
      do {
        const d = await gqlPost(cfg, Q_PROJECTS, { nextToken: token })
        out.push(...d.listProjects.items)
        token = d.listProjects.nextToken
      } while (token)
      return out
    },
    put: async ({ boardId, name, actor, what, ts }) => {
      const d = await gqlPost(cfg, M_PUT_PROJECT, {
        boardId, name: name ?? null, actor, what: what ?? null, ts: pad(ts ?? Date.now()),
      })
      return d.putProject
    },
  }
}

const Q_LOAD_GRAPH = `query LoadGraph($projectId: String) { loadGraph(projectId: $projectId) }`
const Q_QUERY_GRAPH = `query QueryGraph($spec: AWSJSON!) { queryGraph(spec: $spec) }`
const M_SAVE_GRAPH = `mutation SaveGraph($spec: AWSJSON!) { saveGraph(spec: $spec) }`
const M_UPDATE_GRAPH = `mutation UpdateGraph($spec: AWSJSON!) { updateGraph(spec: $spec) }`

/**
 * Neptune 그래프 저장소 클라이언트. graph-engine.js 가 인메모리 대신 이걸 쓴다.
 * 배포에서 hasGraph 가 켜져 있을 때만 나온다. 로컬에서는 null 이라 인메모리로 돈다.
 *
 * @returns {{load: Function, save: Function, query: Function, update: Function}|null}
 */
export function graphClient() {
  const cfg = window.SB_CONFIG
  if (!cfg?.graphqlUrl || !cfg?.hasGraph) return null
  // 그래프 리졸버 4개도 plan 과 같이 JSON.stringify 한 문자열을 AWSJSON 으로 내보낸다
  const ask = async (query, field, variables) => parseField((await gqlPost(cfg, query, variables))[field])
  const spec = (query, field) => (payload) => ask(query, field, { spec: JSON.stringify(payload) })
  return {
    load: (projectId = 'default') => ask(Q_LOAD_GRAPH, 'loadGraph', { projectId }),
    query: spec(Q_QUERY_GRAPH, 'queryGraph'),
    save: spec(M_SAVE_GRAPH, 'saveGraph'),
    update: spec(M_UPDATE_GRAPH, 'updateGraph'),
  }
}

const Q_CONNECTORS = 'query Connectors { connectors }'
const M_PUT_CONNECTOR = `mutation PutConnector($spec: AWSJSON!) { putConnector(spec: $spec) }`
const M_DELETE_CONNECTOR = `mutation DeleteConnector($spec: AWSJSON!) { deleteConnector(spec: $spec) }`
const M_GEN_CONNECTOR = `mutation GenConnector($spec: AWSJSON!) { genConnector(spec: $spec) { jobId status } }`
const Q_GEN_RESULT = `query GenResult($jobId: ID!) { genResult(jobId: $jobId) }`

/** 커넥터 잡 상한. ConnFn 의 타임아웃(10분)과 같다. 이보다 오래 걸리면 결과가 올 곳이 없다 */
export const GEN_TIMEOUT_MS = 600_000
/** plan 보다 느긋하게 묻는다. 밖의 제공자는 빨라도 십수 초다 */
const GEN_POLL_MS = 2500

/**
 * 커넥터 모델로 한 장 만들고 끝날 때까지 기다린다. runPlanJob 과 같은 잡 방식이다.
 * 다른 점은 상한뿐이다 — 영상은 몇 분 걸린다.
 *
 * @param {Function} post - (query, variables) => Promise<data>
 * @param {Object} spec - {model:'제공자:모델', prompt, kind?, init?, strength?, seed?}
 * @returns {Promise<{url: string, kind: string, model: string, ms: number}>}
 */
export async function runGenJob(post, spec, opts = {}) {
  const pollMs = opts.pollMs ?? GEN_POLL_MS
  const timeoutMs = opts.timeoutMs ?? GEN_TIMEOUT_MS

  const started = await post(M_GEN_CONNECTOR, { spec: JSON.stringify(spec) })
  const jobId = started?.genConnector?.jobId
  if (!jobId) throw new Error('커넥터 jobId 를 받지 못했습니다')

  const deadline = Date.now() + timeoutMs
  let fails = 0
  while (Date.now() < deadline) {
    await sleep(pollMs)

    let got
    try {
      got = parseField((await post(Q_GEN_RESULT, { jobId })).genResult)
      fails = 0
    } catch (e) {
      if (++fails > PLAN_POLL_FAILS) throw e
      continue
    }

    if (got?.status === 'done') return got
    if (got?.status === 'error') throw new Error(got.error || '커넥터 생성 실패')
  }
  throw new Error(`커넥터가 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다`)
}

/**
 * 커넥터 클라이언트. 밖의 이미지·영상 모델을 API 키로 붙인다.
 *
 * 키는 put 으로 올라가고 다시는 내려오지 않는다. list 는 어떤 제공자가 붙어 있고
 * 어떤 모델을 고를 수 있는지만 준다. 넣고 지우는 것은 서버에서 admin 만 통과한다.
 *
 * @returns {{list: Function, put: Function, remove: Function, gen: Function}|null}
 */
export function connectorClient() {
  const cfg = window.SB_CONFIG
  if (!cfg?.graphqlUrl) return null
  const post = (query, variables) => gqlPost(cfg, query, variables)
  const ask = async (query, field, variables) => parseField((await post(query, variables))[field])
  return {
    list: () => ask(Q_CONNECTORS, 'connectors', {}),
    put: (payload) => ask(M_PUT_CONNECTOR, 'putConnector', { spec: JSON.stringify(payload) }),
    remove: (provider) => ask(M_DELETE_CONNECTOR, 'deleteConnector', { spec: JSON.stringify({ provider }) }),
    gen: (spec, opts) => runGenJob(post, spec, opts),
  }
}

async function awsTransport(cfg, h) {
  const boardId = new URL(location.href).searchParams.get('board') || cfg.boardId || 'demo'
  let latency = 0

  const post = (query, variables) => gqlPost(cfg, query, variables)

  const retry = async (fn, left = 3) => {
    for (let i = 0; ; i++) {
      try {
        return await fn()
      } catch (e) {
        if (i >= left) throw e
        await new Promise((r) => setTimeout(r, 400 * 3 ** i))
      }
    }
  }

  const outbox = []
  const flush = () => {
    for (const item of outbox.splice(0)) send(item.q, item.v)
    h.onPending?.(outbox.length)
  }
  setInterval(() => { if (outbox.length) flush() }, 10_000)

  const send = (query, variables) => {
    const go = () =>
      retry(() => post(query, variables)).catch((e) => {
        console.warn('[net] op 전송 실패. 대기열에 넣는다', e.message)
        outbox.push({ q: query, v: variables })
        h.onPending?.(outbox.length)
      })
    if (latency > 0) setTimeout(go, latency)
    else go()
  }

  const beat = (variables) => {
    const go = () => post(M_PRESENCE, variables).catch(() => {})
    if (latency > 0) setTimeout(go, latency)
    else go()
  }

  const realtime = new Realtime(cfg, { ...h, onResync: () => { flush(); h.onResync() } })
  realtime.subscribe(S_OP, { boardId }, (d) => h.onOp(JSON.parse(d.onOp.body)))
  realtime.subscribe(S_PRESENCE, { boardId }, (d) => h.onPresence(JSON.parse(d.onPresence.body)))
  await realtime.ready()

  return {
    mode: 'aws',
    boardId,
    sendOp: (op) =>
      send(M_OP, { boardId, id: op.id, ts: pad(op.ts), actor: op.actor, body: JSON.stringify(op) }),
    sendPresence: (p) => beat({ boardId, actor: p.id, body: JSON.stringify(p) }),
    fetchOps: async (since) => {
      const out = []
      let token = null
      do {
        const d = await retry(() =>
          post(Q_LIST, { boardId, since: since ? pad(since) : null, nextToken: token }))
        for (const it of d.listOps.items) {
          try { out.push(JSON.parse(it.body)) } catch {  }
        }
        token = d.listOps.nextToken
      } while (token)
      return out.sort((a, b) => a.ts - b.ts)
    },
    plan: (spec) => runPlanJob(post, spec),
    setLatency: (ms) => { latency = ms },
  }
}

const errText = (pl) => (pl?.errors || [pl]).map((e) => e?.errorType || e?.message || '알 수 없음').join(' · ')

class Realtime {
  constructor(cfg, h) {
    this.cfg = cfg
    this.h = h
    this.subs = []
    this.tries = 0
    this.first = new Promise((res) => { this.resolveFirst = res })
    this.open()
  }

  ready() { return this.first }

  subscribe(query, variables, onData) {
    const sub = { id: uuid(), query, variables, onData, acked: false }
    this.subs.push(sub)
    if (this.acked) this.start(sub)
    return sub
  }

  async auth() {
    this.token = await idToken()
    return { host: new URL(this.cfg.graphqlUrl).host, Authorization: this.token }
  }

  url(auth) {
    const api = new URL(this.cfg.graphqlUrl)
    const rt = this.cfg.realtimeUrl ||
      `wss://${api.host.replace('appsync-api', 'appsync-realtime-api')}${api.pathname}`
    const header = btoa(JSON.stringify(auth))
    return `${rt}?header=${encodeURIComponent(header)}&payload=e30=`
  }

  async open() {
    clearTimeout(this.retryTimer)
    this.acked = false
    this.ws = new WebSocket(this.url(await this.auth()), 'graphql-ws')

    this.ws.onopen = () => this.ws.send(JSON.stringify({ type: 'connection_init' }))

    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      this.alive()
      switch (m.type) {
        case 'connection_ack':
          this.acked = true
          this.tries = 0
          this.timeout = m.payload?.connectionTimeoutMs || 300_000
          for (const s of this.subs) this.start(s)
          this.h.onStatus('open')
          this.resolveFirst()
          if (this.needResync) { this.needResync = false; this.h.onResync() }
          break
        case 'start_ack': {
          const s = this.subs.find((x) => x.id === m.id)
          if (s) s.acked = true
          break
        }
        case 'data': {
          const s = this.subs.find((x) => x.id === m.id)
          if (s && m.payload?.data) s.onData(m.payload.data)
          break
        }
        case 'error':
        case 'connection_error':
          console.warn('[net] AppSync 오류', m.type, errText(m.payload))
          break
      }
    }

    this.ws.onclose = () => this.down()
    this.ws.onerror = () => this.down()
  }

  start(sub) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const auth = { host: new URL(this.cfg.graphqlUrl).host, Authorization: this.token }
    this.ws.send(JSON.stringify({
      id: sub.id,
      type: 'start',
      payload: {
        data: JSON.stringify({ query: sub.query, variables: sub.variables }),
        extensions: { authorization: auth },
      },
    }))
  }

  alive() {
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => {
      try { this.ws.close() } catch {  }
    }, 90_000)
  }

  down() {
    if (this.closed) return
    this.closed = true
    this.needResync = true
    clearTimeout(this.watchdog)
    for (const s of this.subs) s.acked = false
    this.h.onStatus('down')
    const wait = Math.min(8000, 400 * 2 ** this.tries++)
    /*
     * 첫 connection_ack 전에도 계속 닫히는 경우가 있다. 만료된 토큰, 네트워크.
     * ready() 는 ack 에서만 resolve 하므로 그대로 두면 호출자가 영구히 매달린다.
     * reject 가 아니라 미해결이라서 try/catch 도 잡지 못한다. key-visual 화면이
     * 그 상태로 끝까지 비어 있었다. 몇 번 실패하면 일단 진행시킨다. 연결이 늦게
     * 열려도 구독은 그때 붙고, 그동안 onStatus('down') 이 화면에 상태를 알린다.
     * tries 는 ack 에서 0 으로 돌아가므로 연결된 뒤의 재시도에는 영향이 없다.
     */
    if (this.tries > 3) this.resolveFirst()
    this.retryTimer = setTimeout(() => {
      this.closed = false
      this.open()
    }, wait)
  }
}
