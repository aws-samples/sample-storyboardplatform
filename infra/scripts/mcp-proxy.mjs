/*
 * Higgsfield MCP 중계기. 브라우저가 mcp.higgsfield.ai 를 직접 못 부르는 것만 해결합니다.
 *
 * 왜 필요한가. 측정 결과는 이렇습니다.
 *   POST https://mcp.higgsfield.ai/mcp  (Origin 헤더 없음)  -> 401 + www-authenticate: Bearer
 *   POST https://mcp.higgsfield.ai/mcp  (Origin 헤더 있음)  -> 403 (Cloudflare, access-control-* 없음)
 * 즉 막는 기준은 토큰이 아니라 Origin 헤더입니다. Claude Code 같은 MCP 클라이언트는 브라우저가
 * 아니라 Origin 을 붙이지 않으므로 잘 붙고, 웹페이지는 브라우저가 Origin 을 강제로 붙이므로
 * 무조건 403 입니다. 중계기는 Origin·Referer·Sec-Fetch-* 를 떼고 다시 부릅니다.
 *
 * 인증은 중계기가 손대지 않습니다. Authorization 헤더를 그대로 넘깁니다. 토큰 받기는 브라우저가
 * 직접 할 수 있습니다 — clerk.higgsfield.ai 는 CORS 를 열어 두었고(token_endpoint 가 우리 Origin
 * 을 그대로 되돌려 줍니다) 동적 클라이언트 등록과 PKCE(S256) 를 지원합니다.
 *
 *   node infra/scripts/mcp-proxy.mjs [포트]     # 기본 8096
 *   연동 화면의 주소 칸에 http://localhost:8096/mcp 를 넣습니다
 *
 * 배포판에서 쓰려면 같은 일을 하는 자리가 CloudFront 뒤에 하나 있어야 합니다(Lambda Function
 * URL 이나 CloudFront 추가 오리진). 이 파일은 로컬에서 그 설계가 맞는지 보는 용도입니다.
 */
import { createServer } from 'node:http'
import { Readable } from 'node:stream'

const PORT = Number(process.argv[2]) || 8096
const UP = process.env.MCP_UPSTREAM || 'https://mcp.higgsfield.ai/mcp'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version, accept',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-expose-headers': 'mcp-session-id',
  'access-control-max-age': '600',
}

// 넘길 헤더만 고릅니다. Origin 을 떼는 것이 이 중계기의 존재 이유입니다
const PASS = ['content-type', 'accept', 'authorization', 'mcp-session-id', 'mcp-protocol-version']

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
  if (!req.url.startsWith('/mcp')) { res.writeHead(404, CORS); return res.end('POST /mcp') }

  const chunks = []
  for await (const c of req) chunks.push(c)
  const head = Object.fromEntries(PASS.filter((k) => req.headers[k]).map((k) => [k, req.headers[k]]))

  try {
    const up = await fetch(UP, {
      method: req.method,
      headers: head,
      body: req.method === 'GET' ? undefined : Buffer.concat(chunks),
      redirect: 'manual',
    })
    const out = { ...CORS }
    for (const k of ['content-type', 'mcp-session-id', 'www-authenticate']) {
      const v = up.headers.get(k)
      if (v) out[k] = v
    }
    console.log(`${req.method} ${req.url} -> ${up.status}${head.authorization ? ' (토큰 있음)' : ' (토큰 없음)'}`)
    res.writeHead(up.status, out)
    if (!up.body) return res.end()
    // SSE 도 그대로 흘려보냅니다. 화면의 readBody 가 마지막 data 를 골라 읽습니다
    return Readable.fromWeb(up.body).pipe(res)
  } catch (e) {
    console.log(`${req.method} ${req.url} -> 실패: ${e.message}`)
    res.writeHead(502, { ...CORS, 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `중계 실패: ${e.message}` } }))
  }
}).listen(PORT, () => {
  console.log(`MCP 중계기: http://localhost:${PORT}/mcp  ->  ${UP}`)
})
