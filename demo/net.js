
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

const Q_PLAN = `query Plan($spec: AWSJSON!) { plan(spec: $spec) }`

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
 * 돌려주도록 고쳐도 이 함수는 그대로 맞는다 — 그때는 첫 파싱에서 값이 나온다.
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

/**
 * plan 쿼리만 쓰는 최소 클라이언트. story-graph.html 처럼 보드 동기화(구독·프레즌스)는
 * 필요 없고 Bedrock 호출만 하는 화면에서 쓴다.
 *
 * @returns {{plan: Function}|null} 설정이 없으면 null — 부르는 쪽은 로컬 모드로 내려간다
 */
export function planClient() {
  const cfg = window.SB_CONFIG
  if (!cfg?.graphqlUrl) return null
  return { plan: async (spec) => parseField((await gqlPost(cfg, Q_PLAN, { spec: JSON.stringify(spec) })).plan) }
}

const Q_LOAD_GRAPH = `query LoadGraph($projectId: String) { loadGraph(projectId: $projectId) }`
const Q_QUERY_GRAPH = `query QueryGraph($spec: AWSJSON!) { queryGraph(spec: $spec) }`
const M_SAVE_GRAPH = `mutation SaveGraph($spec: AWSJSON!) { saveGraph(spec: $spec) }`
const M_UPDATE_GRAPH = `mutation UpdateGraph($spec: AWSJSON!) { updateGraph(spec: $spec) }`

/**
 * Neptune 그래프 저장소 클라이언트. graph-engine.js 가 인메모리 대신 이걸 쓴다.
 * 배포에서 hasGraph 가 켜져 있을 때만 나온다 — 로컬에서는 null 이라 인메모리로 돈다.
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
        console.warn('[net] op 전송 실패 — 대기열에 넣는다', e.message)
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
    plan: async (spec) => parseField((await post(Q_PLAN, { spec: JSON.stringify(spec) })).plan),
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
    this.retryTimer = setTimeout(() => {
      this.closed = false
      this.open()
    }, wait)
  }
}
