/**
 * 아키텍처 한 장. 이 데모가 무엇으로 어떻게 도는지 화면 안에서 보여 줍니다.
 *
 * 문서(README·infra/lib/storyboard-stack.js)에 있던 이야기를 그림으로 옮긴 것입니다. 데모를
 * 처음 보는 사람이 가장 자주 묻는 것이 「이게 어디서 도는 겁니까」인데, 그 답이 저장소 안에만
 * 있으면 화면을 보고 있는 사람에게는 없는 것과 같습니다.
 *
 * 모양은 AWS 아키텍처 다이어그램의 관례를 따릅니다. 왼쪽에서 오른쪽으로 ① 사람이 보는 곳
 * ② 앞에 선 것 ③ 일하는 곳 ④ 남는 곳 네 칸으로 나누고, 무엇이 무엇을 부르는지는 칸 사이를
 * 잇는 색 선으로 그립니다. 선의 번호는 아래 이야기의 번호와 같은 것입니다. 아이콘은 AWS
 * 공식 아이콘(components/aws-icons.js)이고 배경은 흰색입니다.
 *
 * 선은 상자를 늘어놓은 다음 실제 자리를 재서 그립니다(drawEdges). 좌표를 손으로 적어 두면
 * 글자가 한 줄 늘어나는 순간 선이 어긋납니다.
 *
 * 여기 적힌 리소스는 infra/lib/storyboard-stack.js 가 실제로 만드는 것들입니다. 그 파일을
 * 고치면 이 파일도 같이 고쳐야 합니다. 화면이 인프라를 조회해서 그리는 것이 아니라 사람이
 * 적어 둔 그림입니다 — 조회로 그리려면 브라우저에 CloudFormation 읽기 권한을 줘야 하고,
 * 그것은 이 데모가 열어 둘 문이 아닙니다.
 *
 * 모양(CSS)까지 이 파일이 들고 있습니다. 네 화면 어디서든 열리므로 보드의 스타일에 기댈 수
 * 없습니다. nav-tabs.js · perm.js 와 같은 방식입니다.
 */

import { esc, setHtml } from '../lib/dom.js'
import { icon } from './aws-icons.js'

/*
 * 칸. 왼쪽에서 오른쪽으로 「사람이 보는 것 → 그것을 지탱하는 것」 순서입니다.
 *
 * aws 가 true 인 칸은 AWS 안에서 도는 것들입니다. svc 는 서비스 이름이고 name 은 이 데모에서
 * 그것이 하는 일입니다. 서비스 이름만 적으면 무엇에 쓰는지 모르고, 하는 일만 적으면 무엇으로
 * 만들었는지 모릅니다. id 는 아래 흐름이 상자를 가리키는 이름입니다.
 */
const COLS = [
  {
    n: '①',
    title: '사람이 보는 곳',
    en: 'EXPERIENCE',
    tiles: [
      {
        id: 'browser',
        ico: 'user',
        name: '기획 · 아티스트 · 감독 · 리뷰어',
        svc: '브라우저 한 장',
        note: '네 화면을 오갑니다 — 스토리 디벨롭 · 대본화 · 키비주얼 · 스토리보드. 영상은 스토리보드 안에서 승인된 컷으로 만듭니다',
      },
      {
        id: 'site',
        ico: 's3',
        aws: true,
        name: '화면 파일',
        svc: 'Amazon S3 (Site)',
        note: 'app/ 을 빌드 없이 그대로 올립니다. aws-config.js 만 배포가 만들어 넣습니다 — 리전과 풀 ID 가 들어갑니다(SB_DEMO_PW 를 준 배포는 데모 비밀번호까지 들어가고, 그 파일은 누구나 내려받습니다)',
      },
    ],
  },
  {
    n: '②',
    title: '앞에 선 것',
    en: 'EDGE · IDENTITY · API',
    aws: true,
    tiles: [
      {
        id: 'cdn',
        ico: 'cloudfront',
        name: '한 도메인',
        svc: 'Amazon CloudFront',
        note: '길에 따라 뒤가 다릅니다 — / 는 화면, /img/* 는 그림 버킷, /gen* 는 GPU 서버',
      },
      {
        id: 'cognito',
        ico: 'cognito',
        name: '로그인 · 역할',
        svc: 'Amazon Cognito User Pool',
        note: '가입은 막아 두고 조직이 계정을 만듭니다. 역할은 custom:role 한 칸(기획·아티스트·감독·리뷰어·관리자), ID 토큰은 8시간',
      },
      {
        id: 'appsync',
        ico: 'appsync',
        name: '한 줄씩 주고받기',
        svc: 'AWS AppSync (GraphQL)',
        note: 'publishOp 로 넣고 listOps 로 읽고 구독으로 받습니다. 커서와 편집 중 표시는 None 데이터소스로 지나갑니다',
      },
      {
        id: 'alb',
        ico: 'elb',
        name: 'GPU 앞의 문',
        svc: 'Application Load Balancer',
        note: 'CloudFront 프리픽스 리스트에서 온 것만 받습니다. GPU 인스턴스는 밖으로 열려 있지 않습니다',
      },
    ],
  },
  {
    n: '③',
    title: '일하는 곳',
    en: 'COMPUTE',
    aws: true,
    tiles: [
      {
        id: 'graphfn',
        ico: 'lambda',
        name: '기획 · 대본 · 그래프',
        svc: 'AWS Lambda (GraphFn)',
        vpc: true,
        note: '시놉시스에서 비트를 뽑고 컷으로 펼치고 대본을 씁니다. 1분을 넘기기도 해서 요청은 곧바로 끝내고 결과만 표에 적습니다',
      },
      {
        id: 'gpu',
        ico: 'ec2',
        name: '그림과 영상',
        svc: 'Amazon EC2 g6e.2xlarge (L40S 48GB)',
        note: 'server.py 한 장. 기본은 FLUX.2 klein 4B 이고 영상은 Wan 2.2 입니다. 그림 모델과 영상 모델은 한 번에 하나만 올라갑니다. 가중치는 200GB gp3 에 남아 껐다 켜도 다시 받지 않습니다',
      },
      {
        id: 'sched',
        ico: 'eventbridge',
        name: '켜고 끄기',
        svc: 'Amazon EventBridge Scheduler',
        note: '평일 09:00 켜고 20:00 끕니다(KST). 유휴 감지가 아니라 시계입니다',
      },
      {
        id: 'connfn',
        ico: 'lambda',
        name: '밖의 모델 붙이기',
        svc: 'AWS Lambda (ConnFn)',
        note: 'API 키를 넣으면 그 모델이 그림판 목록에 뜹니다. 밖으로 나가는 일은 이 함수만 합니다(VPC 밖)',
      },
    ],
  },
  {
    n: '④',
    title: '남는 곳 · 모델',
    en: 'DATA · MODELS',
    aws: true,
    tiles: [
      {
        id: 'ops',
        ico: 'dynamodb',
        name: '작업 로그 · 프로젝트 카드',
        svc: 'Amazon DynamoDB (Ops)',
        note: 'pk=BOARD#<판> 에 컷·인물·승인·메모·권한이 op 한 줄로 남습니다(30일 TTL). 같은 칸의 ASSET#(대본·시놉시스·씬·그래프·키비주얼·콘티)과 pk=PROJECTS 판 목록에는 TTL 이 없습니다',
      },
      {
        id: 'bedrock',
        ico: 'bedrock',
        name: '언어 모델',
        svc: 'Amazon Bedrock (Claude)',
        note: '기획·대본과 한국어 프롬프트를 영어로 옮기는 일. NAT 없이 인터페이스 엔드포인트로 닿습니다',
      },
      {
        id: 'neptune',
        ico: 'neptune',
        name: '관계 그래프',
        svc: 'Amazon Neptune (Gremlin)',
        vpc: true,
        note: '인물·사건·장소가 어떻게 얽혔는지. 화면의 services/graph-store.js 가 묻고 사실은 여기 남습니다',
      },
      {
        id: 'images',
        ico: 's3',
        name: '나온 그림 · 영상',
        svc: 'Amazon S3 (Images)',
        note: '브라우저는 버킷을 직접 보지 않습니다. 판에는 주소만 남고 CloudFront /img/* 로 다시 화면에 옵니다',
      },
      {
        id: 'ssm',
        ico: 'ssm',
        name: '키 보관',
        svc: 'AWS Systems Manager Parameter Store',
        note: '/storyboard/connector/* 에 SecureString 으로. 넣은 뒤에는 브라우저로 돌려주지 않습니다',
      },
    ],
  },
]

/*
 * 흐름. 상자만 늘어놓으면 무엇이 무엇을 부르는지 모릅니다. 사람이 실제로 하는 다섯 가지 일을
 * 색과 번호로 나눠 그립니다.
 *
 * hops 는 이어지는 길이고, side 는 그 길에서 갈라져 나가는 곁길입니다(점선). 번호 뱃지는
 * 마지막 구간이 닿는 자리(화살표 앞)에 놓습니다 — 앞 구간은 다섯 흐름이 같이 쓰는 길이라
 * 거기에 두면 뱃지가 겹칩니다. 색은 AWS 아이콘의 갈래 색에서 가져왔습니다.
 */
const FLOWS = [
  {
    n: 1,
    c: '#DD344C',
    title: '로그인',
    hops: ['browser', 'cdn', 'cognito', 'appsync'],
    story: '역할은 ID 토큰 안에 있습니다. 화면은 그것을 읽어 무엇을 보여줄지 정하고, 막는 것은 AppSync 가 합니다 — 화면이 스스로 권한을 정하지 않습니다.',
  },
  {
    n: 2,
    c: '#8C4FFF',
    title: '같이 고치기',
    hops: ['browser', 'cdn', 'appsync', 'ops'],
    story: '컷을 옮기고 인물을 붙이고 승인을 누르는 일이 모두 op 한 줄입니다. 보낸 사람도 자기 op 를 먼저 화면에 얹고 보내서 손이 느려지지 않고, 남의 화면은 구독으로 같은 줄을 받습니다.',
  },
  {
    n: 3,
    c: '#01A88D',
    title: '이야기 기획 · 대본화',
    hops: ['browser', 'cdn', 'appsync', 'graphfn', 'bedrock'],
    side: [['graphfn', 'neptune'], ['graphfn', 'ops']],
    story: '한 번에 1분을 넘기기도 해서 요청은 곧바로 끝냅니다. 함수가 모델에 묻고 관계를 그래프에 적고 결과를 작업 로그에 남기면, 화면이 그것을 받아 갑니다.',
  },
  {
    n: 4,
    c: '#ED7100',
    title: '그림 · 영상 만들기',
    hops: ['browser', 'cdn', 'alb', 'gpu', 'images'],
    side: [['sched', 'gpu']],
    story: '기반 이미지를 얹으면 스케치·인물 얼굴·키비주얼을 물려받아 같은 씬이 어긋나지 않습니다. 그 그림을 감독이 승인하면 같은 자리에서 몇 초짜리 영상이 되고, 승인된 그림이 그대로 첫 장이 됩니다. GPU 가 꺼져 있으면 그림과 영상만 멈추고 나머지 기능은 그대로 돕니다.',
  },
  {
    n: 5,
    c: '#7AA116',
    title: '밖의 모델 붙이기',
    hops: ['browser', 'cdn', 'appsync', 'connfn', 'ssm'],
    side: [['connfn', 'images']],
    story: '키는 넣은 뒤 다시 볼 수 없습니다 — 지우는 것만 됩니다. Hugging Face 키는 GPU 서버도 읽습니다(잠긴 저장소를 내려받을 때만. 기본 모델과 영상 모델은 잠겨 있지 않아 키 없이 받아집니다).',
  },
]

/* 데모를 처음 켜 보는 사람이 걸려 넘어지는 자리들. 아키텍처를 보러 온 사람이 같이 알아야 합니다 */
const NOTES = [
  'GPU 인스턴스는 시간당 요금이 붙습니다. 업무 시간 밖에는 스케줄러가 끄고, 그동안 남는 것은 볼륨과 ALB 뿐입니다.',
  'Neptune 은 provisioned 라서 쓰지 않는 동안에도 요금이 붙습니다. infra/scripts/stop.sh 로 세웁니다.',
  '작업 로그(Ops)에는 30일 TTL 이 있습니다. 한 달 쉰 판의 op(컷·승인·메모)는 사라지고, 프로젝트 카드와 저장해 둔 대본·시놉시스·키비주얼·콘티는 남습니다.',
  'aws-config.js 는 누구나 내려받을 수 있는 파일입니다. 리전과 풀 ID 가 들어갑니다 — SB_DEMO_PW 를 준 배포는 데모 비밀번호까지 이 파일에 씁니다.',
]

/** 지금 이 브라우저가 어디에 붙어 있는지. 막혔을 때 먼저 봐야 하는 세 줄입니다 */
function hereHtml() {
  const cfg = typeof window === 'undefined' ? null : window.SB_CONFIG
  if (!cfg?.graphqlUrl) {
    return `<p class="ar__here ar__here--off">이 화면은 서버에 붙어 있지 않습니다(로컬 모드).
      아래 그림은 배포된 데모의 구조이고, 지금은 브라우저 안의 메모리만 씁니다.</p>`
  }
  const host = (() => {
    try { return new URL(cfg.graphqlUrl).host } catch { return cfg.graphqlUrl }
  })()
  return `<p class="ar__here">
    <span><b>리전</b> ${esc(cfg.region || '?')}</span>
    <span><b>AppSync</b> ${esc(host)}</span>
    <span><b>판</b> ${esc(cfg.boardId || 'demo')}</span>
    <span><b>GPU 길</b> ${esc(cfg.genUrl || '없음')}</span>
    <span><b>관계 그래프</b> ${cfg.hasGraph ? 'Neptune' : '브라우저 메모리'}</span></p>`
}

/** 상자 한 장 */
function tileHtml(t) {
  return `<article class="ar__t" data-t="${esc(t.id)}">
    <span class="ar__ico">${icon(t.ico, 36)}</span>
    <b class="ar__tn">${esc(t.name)}</b>
    <span class="ar__ts">${esc(t.svc)}${t.vpc ? '<span class="ar__vpc">VPC 안</span>' : ''}${
    /* ① 칸은 사람 쪽이라 AWS 테를 두르지 않습니다. 그 안에 있는 S3 만 따로 표를 답니다 */
    t.aws ? '<span class="ar__vpc">AWS</span>' : ''}</span>
    <span class="ar__note">${esc(t.note)}</span>
  </article>`
}

/** 아키텍처 판 한 장. 창 밖에서도 쓸 수 있게 문자열만 돌려줍니다 */
export function archHtml() {
  return `
    <p class="ar__lead">서울 리전(ap-northeast-2) 한 스택입니다. 화면은 빌드 없이 S3 에 그대로 올라가고,
      함께 고치는 일은 op 한 줄씩 오갑니다. 무거운 일(모델 호출 · 그림 생성)은 요청을 곧바로 끝내고
      결과만 나중에 표에서 가져갑니다.</p>
    ${hereHtml()}
    <div class="ar__map">
      ${COLS.map((c) => `
        <section class="ar__col${c.aws ? ' ar__col--aws' : ''}">
          <h3 class="ar__ch"><span class="ar__cn">${c.n}</span>${esc(c.title)}
            <small>${esc(c.en)}</small></h3>
          ${c.tiles.map(tileHtml).join('')}
        </section>`).join('')}
      <svg class="ar__edges" aria-hidden="true"></svg>
      <svg class="ar__pins" aria-hidden="true"></svg>
    </div>
    <p class="ar__frame">② ③ ④ 와 ①의 S3 는 AWS 클라우드 · 서울 리전(ap-northeast-2) 안에서 돕니다.
      점선은 곁길이고, 번호는 아래 이야기의 번호입니다.</p>
    <ul class="ar__leg">
      ${FLOWS.map((f) => `<li><span class="ar__dot" style="background:${f.c}">${f.n}</span>${esc(f.title)}</li>`).join('')}
    </ul>
    <h3 class="ar__h ar__h--gap">무엇이 무엇을 부르는가</h3>
    <ol class="ar__story">
      ${FLOWS.map((f) => `<li>
        <span class="ar__dot" style="background:${f.c}">${f.n}</span>
        <b>${esc(f.title)}</b>
        <span class="ar__steps">${f.hops.map((h) => `<span class="ar__step">${esc(labelOf(h))}</span>`).join('<span class="ar__to" aria-hidden="true">›</span>')}</span>
        <span class="ar__note">${esc(f.story)}</span>
      </li>`).join('')}
    </ol>
    <h3 class="ar__h ar__h--gap">알아 둘 것</h3>
    <ul class="ar__notes">${NOTES.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
}

/** 흐름 줄에 적을 상자 이름. 서비스 이름 쪽이 짧아서 그것을 씁니다 */
function labelOf(id) {
  for (const c of COLS) for (const t of c.tiles) if (t.id === id) return t.svc
  return id
}

/* ── 선 ─────────────────────────────────────────────────────────────────────── */

/** 상자의 자리(판 왼쪽 위 기준). 없는 상자는 null */
function boxOf(map, id) {
  const el = map.querySelector(`[data-t="${id}"]`)
  if (!el) return null
  const b = map.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  return {
    l: r.left - b.left,
    r: r.right - b.left,
    t: r.top - b.top,
    b: r.bottom - b.top,
    cx: r.left - b.left + r.width / 2,
    cy: r.top - b.top + r.height / 2,
  }
}

/**
 * 상자 두 개를 잇는 곡선 하나. off 는 같은 길을 여러 흐름이 쓸 때 겹치지 않게 밀어 두는 값입니다.
 *
 * 오른쪽으로 가는 길, 왼쪽으로 되돌아오는 길, 같은 칸 안에서 위아래로 잇는 길 세 가지입니다.
 */
function seg(a, z, off) {
  if (z.l - a.r > 10) {
    const [y1, y2] = [a.cy + off, z.cy + off]
    const mx = (a.r + z.l) / 2
    return { d: `M${a.r} ${y1} C${mx} ${y1} ${mx} ${y2} ${z.l} ${y2}`, x: z.l - 14, y: y2 }
  }
  if (a.l - z.r > 10) {
    const [y1, y2] = [a.cy + off, z.cy + off]
    const mx = (a.l + z.r) / 2
    return { d: `M${a.l} ${y1} C${mx} ${y1} ${mx} ${y2} ${z.r} ${y2}`, x: z.r + 14, y: y2 }
  }
  const down = a.cy < z.cy
  const [x1, x2] = [a.cx + off, z.cx + off]
  const [y1, y2] = down ? [a.b, z.t] : [a.t, z.b]
  const my = (y1 + y2) / 2
  return {
    d: `M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`,
    x: x2, y: y2 + (down ? -13 : 13),
  }
}

/**
 * 흐름 선을 그립니다. 상자를 그린 다음 실제 자리를 재서 그리므로 글이 늘어나도 어긋나지
 * 않습니다. 상자가 세로로 접히는 좁은 화면에서도 같은 규칙으로 이어집니다.
 */
export function drawEdges(root = document) {
  const map = root.querySelector('.ar__map')
  const svg = map?.querySelector('.ar__edges')
  const pinSvg = map?.querySelector('.ar__pins')
  if (!svg || !pinSvg) return
  const size = map.getBoundingClientRect()
  const box = `0 0 ${Math.round(size.width)} ${Math.round(size.height)}`
  svg.setAttribute('viewBox', box)
  pinSvg.setAttribute('viewBox', box)

  /*
   * 한 상자에 몇 개의 선이 닿는지 미리 셉니다 — 그만큼 나눠서 비켜 그립니다.
   *
   * 보내는 쪽까지 묶어 세면(browser>cdn 처럼) 출발지가 다른 선은 서로를 못 봅니다.
   * appsync>ops 와 graphfn>ops 가 그렇게 둘 다 가운데로 들어와 화살촉이 겹치고, 그
   * 자리에 앉는 번호 뱃지도 하나가 다른 하나를 덮었습니다. 그래서 도착하는 상자만으로
   * 셉니다 — 같은 길을 여러 흐름이 쓰는 경우도 이 안에 들어옵니다.
   */
  const pairs = []
  for (const f of FLOWS) {
    for (let i = 0; i < f.hops.length - 1; i += 1) {
      pairs.push({ f, a: f.hops[i], z: f.hops[i + 1], tip: i === f.hops.length - 2 })
    }
    for (const [a, z] of f.side || []) pairs.push({ f, a, z, dash: true })
  }
  const uses = pairs.reduce((m, p) => m.set(p.z, (m.get(p.z) || 0) + 1), new Map())
  const drawn = new Map()

  const out = [`<defs>${FLOWS.map((f) => `<marker id="arA${f.n}" viewBox="0 0 10 10"
    refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M0 0 10 5 0 10z" fill="${f.c}"/></marker>`).join('')}</defs>`]
  const pins = []

  for (const p of pairs) {
    const [a, z] = [boxOf(map, p.a), boxOf(map, p.z)]
    if (!a || !z) continue
    const i = drawn.get(p.z) || 0
    drawn.set(p.z, i + 1)
    const off = (i - (uses.get(p.z) - 1) / 2) * 7
    const s = seg(a, z, off)
    out.push(`<path d="${s.d}" fill="none" stroke="${p.f.c}" stroke-width="1.6"
      ${p.dash ? 'stroke-dasharray="4 4"' : ''} marker-end="url(#arA${p.f.n})"/>`)
    if (p.tip) {
      /* 뱃지는 상자보다 위에 있는 층에 그립니다 — 선처럼 상자 뒤로 숨으면 번호를 못 읽습니다 */
      pins.push(`<circle cx="${s.x}" cy="${s.y}" r="9" fill="${p.f.c}" stroke="#fff" stroke-width="1.5"/>
        <text x="${s.x}" y="${s.y}" fill="#fff" font-size="11" font-weight="600"
          text-anchor="middle" dominant-baseline="central">${p.f.n}</text>`)
    }
  }
  svg.innerHTML = out.join('')
  pinSvg.innerHTML = pins.join('')
}

/* ── 모양 ───────────────────────────────────────────────────────────────────── */

const CSS = `
.ardlg {
  width: min(1240px, 96vw); max-height: 90vh; padding: 0; overflow: hidden;
  border: 1px solid #e4e7ec; border-radius: 12px;
  background: #fff; color: #16191f;
  font: inherit; box-shadow: 0 24px 60px rgba(16, 24, 40, .22);
}
.ardlg::backdrop { background: rgba(16, 24, 40, .45); }
.ardlg__bar {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border-bottom: 1px solid #e4e7ec; background: #f8f9fb;
}
.ardlg__bar h2 { font-size: 14px; margin: 0; }
.ardlg__bar button {
  margin-left: auto; font: inherit; font-size: 12px; padding: 5px 9px; cursor: pointer;
  border: 1px solid #e4e7ec; border-radius: 6px; background: #fff; color: #16191f;
}
.ardlg__body { padding: 14px 16px 20px; overflow: auto; max-height: calc(90vh - 52px); background: #fff; }

.ar__lead, .ar__note, .ar__frame { font-size: 12px; line-height: 1.6; color: #5f6b7a; }
.ar__lead { margin: 0 0 10px; }
.ar__here {
  display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 0 12px; padding: 8px 10px;
  font-size: 11.5px; color: #5f6b7a; background: #f8f9fb;
  border: 1px solid #e4e7ec; border-radius: 8px;
}
.ar__here b { color: #16191f; font-weight: 600; margin-right: 4px; }
.ar__here--off { display: block; line-height: 1.6; }
.ar__h { font-size: 12px; margin: 16px 0 6px; color: #16191f; }
.ar__h--gap { margin-top: 22px; }

/* 판. 네 칸을 나란히 두고 선은 그 위에 겹쳐 그립니다 */
.ar__map {
  position: relative; display: grid; gap: 14px 42px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
/* 선은 상자 뒤(z 0), 번호는 상자 위(z 2). 상자가 z 1 로 그 사이에 있습니다 */
.ar__edges, .ar__pins { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.ar__pins { z-index: 2; }
/* align-self 로 칸이 내용만큼만 자랍니다 — 늘리면 짧은 칸 밑에 빈 테두리가 남습니다 */
.ar__col {
  display: flex; flex-direction: column; align-self: start; gap: 22px;
  padding: 8px 8px 10px; border-radius: 10px;
}
.ar__col--aws { border: 1px dashed #c9d1dc; background: #f7f9fc; }
.ar__ch {
  display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  margin: 0 0 2px; font-size: 12.5px; color: #16191f;
}
/* 10px 짜리 영문 꼬리표입니다. 회색을 더 옅게 두면 흰 배경에서 4.5:1 을 못 넘깁니다 */
.ar__ch small { font-size: 10px; letter-spacing: .08em; color: #5f6b7a; font-weight: 400; }
.ar__cn {
  display: inline-grid; place-items: center; width: 17px; height: 17px; border-radius: 50%;
  background: #16191f; color: #fff; font-size: 10.5px;
}
/* 상자. 배경을 흰색으로 두어 선이 상자 뒤로 지나가는 것처럼 보입니다 */
.ar__t {
  position: relative; z-index: 1; padding: 9px 10px;
  border: 1px solid #d5dbe4; border-radius: 8px; background: #fff;
}
.ar__ico { display: block; margin-bottom: 5px; }
.awsicon { display: block; border-radius: 3px; }
.ar__tn { display: block; font-size: 12.5px; }
.ar__ts { display: block; margin: 2px 0 4px; font-size: 11px; color: #0972d3; letter-spacing: -.01em; }
.ar__vpc {
  margin-left: 5px; padding: 0 5px; border-radius: 999px; font-size: 9.5px;
  border: 1px solid #c9d1dc; color: #5f6b7a;
}
.ar__note { display: block; font-size: 11.5px; }
.ar__frame { margin: 12px 0 8px; }

.ar__leg { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0; padding: 0; list-style: none; }
.ar__leg li { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: #16191f; }
.ar__dot {
  display: inline-grid; place-items: center; width: 16px; height: 16px; flex: 0 0 16px;
  border-radius: 50%; color: #fff; font-size: 10px; font-weight: 600;
}
.ar__story, .ar__notes { margin: 0; padding: 0; list-style: none; }
.ar__story li {
  display: grid; grid-template-columns: 16px 1fr; gap: 4px 7px; align-items: center;
  padding: 8px 0; border-bottom: 1px solid #eef1f5;
}
.ar__story b { font-size: 12.5px; }
.ar__story .ar__steps, .ar__story .ar__note { grid-column: 2; }
.ar__steps { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: 2px 0 3px; }
.ar__step { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #d5dbe4; color: #16191f; }
.ar__to { color: #8a95a3; font-size: 11px; }
.ar__notes li { font-size: 11.5px; line-height: 1.6; color: #5f6b7a; padding-left: 12px; position: relative; }
.ar__notes li::before { content: '·'; position: absolute; left: 3px; }

/*
 * 좁은 화면. 칸이 둘씩 접힙니다. 선은 접힌 자리를 잇느라 판을 가로질러 도는데, 그러면
 * 흐름이 오히려 안 읽힙니다 — 아래 「무엇이 무엇을 부르는가」에 같은 순서가 글로 있으니
 * 여기서는 선을 접습니다.
 */
@media (max-width: 900px) {
  .ar__map { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 30px; }
  .ar__edges, .ar__pins { display: none; }
}
@media (max-width: 560px) {
  .ar__map { grid-template-columns: 1fr; }
}
`

let styled = false
/** 아키텍처 판 스타일을 한 번만 꽂습니다 */
export function injectCss(doc = document) {
  if (styled) return
  styled = true
  const el = doc.createElement('style')
  el.id = 'archCss'
  el.textContent = CSS
  doc.head.appendChild(el)
}

let dlg = null

/**
 * 아키텍처 창을 엽니다. 탭 바 오른쪽 끝의 단추가 이것을 부릅니다.
 *
 * 읽기만 하는 창이라 판(state)도 로그인도 보지 않습니다. 로컬 모드에서도 같은 그림이 뜨고,
 * 「지금 붙어 있는 곳」 줄만 로컬이라고 말합니다.
 */
export function openArch() {
  injectCss(document)
  if (!dlg) {
    dlg = document.createElement('dialog')
    dlg.className = 'ardlg'
    dlg.id = 'archDlg'
    dlg.setAttribute('aria-label', '아키텍처')
    dlg.innerHTML = `
      <header class="ardlg__bar">
        <h2>아키텍처</h2>
        <button type="button" data-aclose="1">닫기</button>
      </header>
      <div class="ardlg__body"></div>`
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-aclose]')) dlg.close()
    })
    document.body.appendChild(dlg)
    /* 창 크기가 바뀌면 상자가 접히고 선의 자리도 달라집니다 */
    window.addEventListener('resize', () => { if (dlg.open) drawEdges(dlg) })
  }
  setHtml(dlg.querySelector('.ardlg__body'), archHtml())
  if (!dlg.open) dlg.showModal()
  /* 상자가 자리를 잡은 뒤에 재야 합니다 */
  requestAnimationFrame(() => drawEdges(dlg))
}
