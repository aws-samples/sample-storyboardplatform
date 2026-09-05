/*
 * 로컬 개발 서버. 배포된 CloudFront 의 경로 구조를 그대로 재현한다.
 *
 * 왜 `python -m http.server` 로 안 되는가 — 배포본의 파일 배치가 저장소와 다르다.
 * CDK 는 demo/* 를 버킷 루트에 올리고, 같은 것을 /demo/ 에도 한 번 더 올린다
 * (storyboard-stack.js 의 Web / WebDemo / WebKeyVisual 세 배포). 저장소 루트에는
 * index.html 이 아예 없다. 그래서 저장소를 그냥 서빙하면
 *   - '/'                     → 404 (index.html 이 루트에 없다)
 *   - '/index.html' (보드로)  → 404 ← 방금 고친 링크가 이걸 가리킨다
 *   - '/aws-config.js'        → 있다 (gitignore 된 로컬 파일)
 *   - '/demo/core.js'         → 있다 (keyvisual.js 가 '../demo/core.js' 로 부른다)
 * 즉 링크 수정이 맞는지 로컬에서 확인하려면 이 배치를 흉내내야 한다.
 *
 * 그리고 aws-config.js 의 genUrl 은 '/gen' 이라는 상대경로다. 배포에서는
 * CloudFront 가 그 경로만 ALB 로 보낸다. 로컬에는 그 CloudFront 가 없으므로
 * /gen* 을 배포된 CloudFront 로 넘긴다 — 없으면 그림 그리기가 이 서버의 404 를 받는다.
 *
 * ALB 를 직접 치지 않는다. ALB 의 보안그룹은 CloudFront 관리형 prefix list
 * (pl-22a6434b) 에서 오는 80 포트만 받는다 — storyboard-stack.js 의
 * `albSg.addIngressRule(ec2.Peer.prefixList(CF_ORIGINS), ...)` 이다. 그래서 여기서
 * ALB 주소로 보내면 SG 가 패킷을 버리고 연결이 그냥 타임아웃된다 (거절도 아니다).
 * 뚫으려면 내 IP 를 ALB 에 열어야 하는데, 그건 GPU 를 인터넷에 직접 노출시키는
 * 일이다. CloudFront 를 경유하면 배포와 완전히 같은 경로를 지나므로 더 정확하다.
 *
 *   node infra/scripts/serve-local.mjs [포트]
 *
 * GPU 가 꺼져 있으면 /gen 은 502 가 된다. 화면은 「생성 서버에 닿지 않음」으로
 * 그 상태를 그대로 말하므로, 대본 자르기·프롬프트·보드는 그대로 볼 수 있다.
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
 * URL 경로 → 디스크 경로. 배포의 세 버킷 배포와 같은 순서로 찾는다.
 * 앞의 것이 이긴다 — 배포에서도 루트 배포가 /aws-config.js 를 쥐고 있다.
 */
function candidates(p) {
  const rel = p.replace(/^\/+/, '')
  if (rel === '' ) return ['demo/index.html']
  const out = []
  if (rel.startsWith('key-visual/') || rel.startsWith('demo/') || rel.startsWith('walkthrough/')) {
    out.push(rel)                       // /demo/*, /key-visual/*, /walkthrough/* 는 그대로
  }
  out.push(rel)                          // /aws-config.js 같은 루트 파일
  out.push(path.posix.join('demo', rel)) // 루트에 올라간 demo/* — /index.html, /core.js …
  return out
}

async function findFile(urlPath) {
  for (const c of candidates(decodeURIComponent(urlPath.split('?')[0]))) {
    const abs = path.join(ROOT, c)
    // 루트 밖으로 나가는 경로는 거부한다 (../ 로 파일을 읽어가지 못하게)
    if (!abs.startsWith(ROOT)) continue
    try {
      const s = await stat(abs)
      if (s.isFile()) return abs
      if (s.isDirectory()) {
        const idx = path.join(abs, 'index.html')
        try { if ((await stat(idx)).isFile()) return idx } catch {}
      }
    } catch {}
  }
  return null
}

/*
 * /gen* 과 /img/* 를 배포된 CloudFront 로 넘긴다. 거기서 ALB 로 간다.
 *
 * 한 장에 약 12초, 배치는 세 갈래로 열어 두므로 최악이 약 36초다. Node 의 기본
 * 소켓 타임아웃보다 길 수 있어 넉넉히 잡는다 — CloudFront 쪽 /gen* readTimeout
 * 60초가 실질적인 상한이다.
 */
function proxyGen(req, res) {
  if (!ORIGIN) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ detail: 'SB_ORIGIN 이 없다 — CloudFront 도메인을 넣어야 /gen 이 넘어간다' }))
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
    res.end(JSON.stringify({ detail: `생성 서버에 닿지 못했다: ${e.message} — GPU 가 꺼져 있을 수 있다` }))
  })
  req.pipe(up)
}

createServer(async (req, res) => {
  const url = req.url || '/'
  if (url === '/gen' || url.startsWith('/gen/') || url.startsWith('/img/')) return proxyGen(req, res)

  const file = await findFile(url)
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`404 ${url}\n찾아본 곳: ${candidates(url.split('?')[0]).join(', ')}\n`)
    return
  }
  const body = await readFile(file)
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',       // 고친 파일이 바로 보여야 한다
  })
  res.end(body)
}).listen(PORT, () => {
  console.log(`로컬 서버   http://localhost:${PORT}`)
  console.log(`  보드       http://localhost:${PORT}/index.html`)
  console.log(`  키 비주얼  http://localhost:${PORT}/key-visual/`)
  console.log(`  /gen       ${ORIGIN ? `→ https://${ORIGIN}` : '없음 (SB_ORIGIN 미설정 → 502)'}`)
})
