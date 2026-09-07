/*
 * 로컬 개발 서버. 배포된 CloudFront 의 경로 구조를 그대로 재현합니다.
 *
 * 왜 `python -m http.server` 로 안 되는가. 배포본의 파일 배치가 저장소와 다릅니다.
 * CDK 는 app/* 를 버킷 루트에 올리고 app-walkthrough/* 는 그 이름의 폴더에 올립니다
 * (storyboard-stack.js 의 Web / WebWalkthrough 두 배포). 저장소 루트에는 index.html 이
 * 아예 없습니다. 그래서 저장소를 그냥 서빙하면
 *   - '/'                          → 404 (index.html 이 루트에 없습니다)
 *   - '/board.html' (보드)         → 404
 *   - '/aws-config.js'             → 있습니다 (gitignore 된 로컬 파일)
 *   - '/app-walkthrough/data/*'    → 있습니다 (예시가 목데이터를 여기서 읽습니다)
 * 즉 링크 수정이 맞는지 로컬에서 확인하려면 이 배치를 흉내내야 합니다.
 *
 * 디렉터리 index 를 흉내내지 않습니다. 이게 중요합니다. CloudFront 의
 * defaultRootObject 는 루트 '/' 에만 적용되고 하위 디렉터리에는 적용되지 않습니다.
 * 즉 배포에서 디렉터리로 끝나는 주소는 403 입니다. 예전 이 서버는 디렉터리를 보면
 * index.html 을 스스로 찾아줬는데, 그래서 디렉터리로 끝나던 탭 주소가 로컬에서는
 * 열리고 배포에서만 403 이 났습니다. 로컬이 더 관대하면 이런 버그가 배포까지 갑니다.
 * 그래서 루트만 예외로 두고 나머지 디렉터리는 배포처럼 403 을 돌려줍니다.
 *
 * 그리고 aws-config.js 의 genUrl 은 '/gen' 이라는 상대경로입니다. 배포에서는
 * CloudFront 가 그 경로만 ALB 로 보냅니다. 로컬에는 그 CloudFront 가 없으므로
 * /gen* 을 배포된 CloudFront 로 넘깁니다. 없으면 그림 그리기가 이 서버의 404 를 받습니다.
 *
 * ALB 를 직접 치지 않습니다. ALB 의 보안그룹은 CloudFront 관리형 prefix list
 * (pl-22a6434b) 에서 오는 80 포트만 받습니다. storyboard-stack.js 의
 * `albSg.addIngressRule(ec2.Peer.prefixList(CF_ORIGINS), ...)` 입니다. 그래서 여기서
 * ALB 주소로 보내면 SG 가 패킷을 버리고 연결이 그냥 타임아웃됩니다 (거절도 아닙니다).
 * 뚫으려면 내 IP 를 ALB 에 열어야 하는데, 그건 GPU 를 인터넷에 직접 노출시키는
 * 일입니다. CloudFront 를 경유하면 배포와 완전히 같은 경로를 지나므로 더 정확합니다.
 *
 *   node infra/scripts/serve-local.mjs [포트]
 *
 * GPU 가 꺼져 있으면 /gen 은 502 가 됩니다. 화면은 「생성 서버에 닿지 않음」으로
 * 그 상태를 그대로 말하므로, 대본 자르기·프롬프트·보드는 그대로 볼 수 있습니다.
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { request as httpsRequest } from 'node:https'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PORT = Number(process.argv[2]) || 8080

// CloudFront 도메인. CDK 출력(Url)에서 온다. 없으면 /gen 은 그냥 502 다.
const ORIGIN = (process.env.SB_ORIGIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
}

/*
 * URL 경로 → 디스크 경로. 배포의 두 버킷 배포와 같은 순서로 찾습니다.
 * 앞의 것이 이깁니다. 배포에서도 루트 배포가 /aws-config.js 를 쥐고 있습니다.
 */
function candidates(p) {
  const rel = p.replace(/^\/+/, '')
  if (rel === '') return ['app/index.html']
  return [
    rel,                                // /aws-config.js, /app-walkthrough/data/* 같은 그대로인 것
    path.posix.join('app', rel),        // 루트에 올라간 app/* · /index.html, /core.js …
  ]
}

/*
 * 파일만 찾습니다. 디렉터리를 만나면 index.html 로 넘어가지 않습니다. 위에 적은 대로
 * 배포가 그렇게 동작하지 않기 때문입니다. 루트 '/' 만 candidates 가 미리
 * 'app/index.html' 로 바꿔 두므로 그 한 곳은 열립니다.
 */
async function findFile(urlPath) {
  for (const c of candidates(decodeURIComponent(urlPath.split('?')[0]))) {
    const abs = path.join(ROOT, c)
    // 루트 밖으로 나가는 경로는 거부한다 (../ 로 파일을 읽어가지 못하게)
    if (!abs.startsWith(ROOT)) continue
    try {
      const s = await stat(abs)
      if (s.isFile()) return abs
    } catch {}
  }
  return null
}

/*
 * /gen* 과 /img/* 를 배포된 CloudFront 로 넘긴다. 거기서 ALB 로 간다.
 *
 * 한 장에 약 12초, 배치는 세 갈래로 열어 두므로 최악이 약 36초다. Node 의 기본
 * 소켓 타임아웃보다 길 수 있어 넉넉히 잡는다. CloudFront 쪽 /gen* readTimeout
 * 60초가 실질적인 상한이다.
 */
function proxyGen(req, res) {
  if (!ORIGIN) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ detail: 'SB_ORIGIN 이 없다. CloudFront 도메인을 넣어야 /gen 이 넘어간다' }))
    return
  }
  // 원본 host 헤더를 그대로 넘기면 CloudFront 가 자기 배포를 못 찾는다
  const headers = { ...req.headers, host: ORIGIN }
  delete headers['accept-encoding']       // 그대로 파이프하므로 압축은 받지 않는다
  const up = httpsRequest({
    host: ORIGIN, port: 443, path: req.url, method: req.method, headers, timeout: 90_000,
  }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers)
    r.pipe(res)
  })
  up.on('timeout', () => up.destroy(new Error('90초 안에 응답이 없었다')))
  up.on('error', (e) => {
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ detail: `생성 서버에 닿지 못했다: ${e.message}. GPU 가 꺼져 있을 수 있다` }))
  })
  req.pipe(up)
}

createServer(async (req, res) => {
  const url = req.url || '/'
  if (url === '/gen' || url.startsWith('/gen/') || url.startsWith('/img/')) return proxyGen(req, res)

  const file = await findFile(url)
  if (!file) {
    /*
     * 디렉터리로 끝나는 주소는 403 으로 답합니다. 배포의 S3 오리진이 그렇게 답하기
     * 때문입니다. 404 로 답하면 "파일이 없다"로 읽히지만 실제 원인은 "디렉터리라서
     * 못 준다"이고, 고칠 곳이 파일 위치가 아니라 링크 쪽입니다.
     */
    const dirish = url.split('?')[0].endsWith('/')
    res.writeHead(dirish ? 403 : 404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(dirish
      ? `403 ${url}\n디렉터리에는 index 가 없습니다. 배포도 같습니다. 파일 이름까지 적어야 합니다.\n`
      : `404 ${url}\n찾아본 곳: ${candidates(url.split('?')[0]).join(', ')}\n`)
    return
  }
  const body = await readFile(file)
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',       // 고친 파일이 바로 보여야 합니다
  })
  res.end(body)
}).listen(PORT, () => {
  console.log(`로컬 서버   http://localhost:${PORT}`)
  console.log(`  홈         http://localhost:${PORT}/`)
  console.log(`  보드       http://localhost:${PORT}/board.html`)
  console.log(`  디벨롭     http://localhost:${PORT}/story-graph.html`)
  console.log(`  키 비주얼  http://localhost:${PORT}/key-visual.html`)
  console.log(`  /gen       ${ORIGIN ? `→ https://${ORIGIN}` : '없음 (SB_ORIGIN 미설정 → 502)'}`)
})
