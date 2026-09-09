/*
 * 로컬 MCP 스텁. 영상 연동(app/domain/mcp.js) 의 「진짜 선」을 확인할 때 씁니다.
 *
 * 지금 제품에는 그 길이 없습니다 — 영상은 우리 GPU 로만 만들고(app/pages/board.js 의
 * animate), 그것을 부르던 영상화 화면은 없어졌습니다. 다시 붙일 때 쓰라고 둡니다.
 *
 * 왜 필요한가. mcp.higgsfield.ai 는 브라우저에서 부를 수 없습니다 — 프리플라이트
 * (OPTIONS /mcp) 가 403 이고 access-control-* 헤더가 없습니다. 그래서 CORS 를 여는
 * MCP 서버가 하나 있어야 initialize → tools/list → tools/call → 세션 헤더 → SSE 파싱 →
 * 보드에 붙이기까지가 진짜 HTTP 로 돌아가는지 볼 수 있습니다. demoFetch 는 fetch 를
 * 갈아 끼우므로 그 길을 타지 않습니다.
 *
 *   node infra/scripts/mcp-stub.mjs [포트]     # 기본 8098
 *   연동 화면의 주소 칸에 http://localhost:8098/mcp 를 넣습니다
 *
 * 일부러 두 가지를 진짜 서버처럼 합니다.
 *   1. tools/list 를 text/event-stream 으로 답합니다. MCP 의 Streamable HTTP 가 그렇게
 *      답할 수 있고, 우리 readBody 가 그 모양을 읽는지 여기서 확인합니다.
 *   2. Mcp-Session-Id 를 initialize 에서 발급하고 그 뒤로는 없으면 400 을 냅니다.
 *
 * 토큰은 있으면 적어만 둡니다. 스텁이라 검사하지 않습니다.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.argv[2]) || 8098
const sessions = new Set()

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version, accept',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-expose-headers': 'mcp-session-id',
  'access-control-max-age': '600',
}

const TOOLS = [
  {
    name: 'generate_video',
    description: 'Generate a video from an image and a motion preset.',
    inputSchema: {
      type: 'object',
      properties: {
        image_url: { type: 'string', description: 'Public URL of the first frame' },
        motion_id: { type: 'string', description: 'Motion preset id' },
        prompt: { type: 'string' },
        quality: { type: 'string', enum: ['lite', 'turbo', 'standard'] },
        duration: { type: 'integer' },
      },
      required: ['image_url', 'motion_id'],
    },
  },
  {
    name: 'higgsfield_wait_for_job',
    description: 'Wait for a job set to finish and return its results.',
    inputSchema: { type: 'object', properties: { job_set_id: { type: 'string' } }, required: ['job_set_id'] },
  },
  { name: 'list_models', description: 'List motion presets.', inputSchema: { type: 'object', properties: {} } },
]

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { ...CORS, ...headers })
  res.end(body)
}

const rpc = (res, id, result, { sse = false, sid = null } = {}) => {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result })
  const head = sid ? { 'mcp-session-id': sid } : {}
  if (!sse) return send(res, 200, msg, { 'content-type': 'application/json', ...head })
  // 진행 알림 한 줄을 먼저 흘리고 결과를 뒤에 둡니다. 마지막 것을 골라 읽어야 맞습니다
  const stream = `event: message\ndata: ${JSON.stringify({
    jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1, total: 2 },
  })}\n\nevent: message\ndata: ${msg}\n\n`
  return send(res, 200, stream, { 'content-type': 'text/event-stream', ...head })
}

const err = (res, id, code, message) => send(res, 200,
  JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  { 'content-type': 'application/json' })

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '')

  // 결과 주소가 가리키는 자리. 파일은 없습니다 — 선이 이어지는지만 보는 스텁입니다
  if (req.url.startsWith('/clip')) return send(res, 404, 'no clip file in the stub')
  if (req.url !== '/mcp') return send(res, 404, 'POST /mcp')
  if (req.method !== 'POST') return send(res, 405, 'POST /mcp')

  const chunks = []
  for await (const c of req) chunks.push(c)
  let msg
  try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    return err(res, null, -32700, 'parse error')
  }

  const sid = req.headers['mcp-session-id']
  console.log(`  ${msg.method}${sid ? ` sid=${sid.slice(0, 8)}` : ''}${
    req.headers.authorization ? ' auth=있음' : ''}`)

  if (msg.method === 'initialize') {
    const fresh = randomUUID()
    sessions.add(fresh)
    return rpc(res, msg.id, {
      protocolVersion: msg.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'local-mcp-stub', version: '1' },
    }, { sid: fresh })
  }
  // 알림에는 답이 없습니다
  if (!('id' in msg)) return send(res, 202, '')
  if (!sid || !sessions.has(sid)) return err(res, msg.id, -32600, 'Mcp-Session-Id 가 없습니다')

  if (msg.method === 'tools/list') return rpc(res, msg.id, { tools: TOOLS }, { sse: true })

  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params || {}
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) return err(res, msg.id, -32602, `모르는 도구: ${name}`)
    // 화면이 실제로 무엇을 보냈는지 봐야 인자 채우기(domain/mcp.js 의 argsFor)를 검사할 수 있습니다
    console.log(`tools/call ${name} ${JSON.stringify(args)}`)
    const miss = (tool.inputSchema.required || []).filter((k) => args[k] === undefined)
    if (miss.length) return err(res, msg.id, -32602, `빠진 인자: ${miss.join(', ')}`)

    const job = `js-${randomUUID().slice(0, 8)}`
    return rpc(res, msg.id, {
      content: [{
        type: 'text',
        text: JSON.stringify({
          job_set_id: job,
          status: 'completed',
          /*
           * 진짜 서버가 주는 모양 그대로 https 로 답합니다. 보드는 판에 실리는 주소를
           * 걸러내므로(domain/panels.js 의 RE.src) 여기서 http 로 주면 그 검사에 걸려
           * 컷에 빈 그림이 남고, 그게 스텁 탓인지 화면 탓인지 알 수 없게 됩니다.
           * 파일은 없습니다. 이 스텁은 선을 검사하는 것이고 재생은 검사하지 않습니다.
           */
          results: [{ type: 'video', url: `https://cdn.example/clip/${job}.mp4` }],
        }),
      }],
    }, { sse: true })
  }

  return err(res, msg.id, -32601, `모르는 method: ${msg.method}`)
}).listen(PORT, () => {
  console.log(`MCP 스텁: http://localhost:${PORT}/mcp  (CORS 열림, tools/list 는 SSE)`)
})
