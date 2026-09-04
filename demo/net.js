
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

async function awsTransport(cfg, h) {
  const boardId = new URL(location.href).searchParams.get('board') || cfg.boardId || 'demo'
  let latency = 0

  const post = async (query, variables) => {
    const res = await fetch(cfg.graphqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: await idToken() },
      body: JSON.stringify({ query, variables }),
    })
    const json = await res.json()
    if (json.errors?.length) throw new Error(json.errors[0].message)
    return json.data
  }

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
    plan: async (spec) => JSON.parse((await post(Q_PLAN, { spec: JSON.stringify(spec) })).plan),
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
     * 첫 connection_ack 전에도 계속 닫히는 경우가 있다 — 만료된 토큰, 네트워크.
     * ready() 는 ack 에서만 resolve 하므로 그대로 두면 호출자가 영구히 매달린다.
     * reject 가 아니라 미해결이라서 try/catch 도 잡지 못한다 — key-visual 화면이
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
