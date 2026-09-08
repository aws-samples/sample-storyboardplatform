/**
 * 아키텍처 한 장. 이 데모가 무엇으로 어떻게 도는지 화면 안에서 보여 줍니다.
 *
 * 문서(README·infra/lib/storyboard-stack.js)에 있던 이야기를 화면으로 옮긴 것입니다. 데모를
 * 처음 보는 사람이 가장 자주 묻는 것이 「이게 어디서 도는 겁니까」인데, 그 답이 저장소 안에만
 * 있으면 화면을 보고 있는 사람에게는 없는 것과 같습니다.
 *
 * 탭 바 오른쪽 끝에 접어 둡니다. 네 단계(스토리 디벨롭·대본화·키비주얼·스토리보드)와 나란히
 * 두면 다섯 번째 작업 단계로 읽히는데, 이것은 일이 아니라 설명입니다.
 *
 * 여기 적힌 리소스는 infra/lib/storyboard-stack.js 가 실제로 만드는 것들입니다. 그 파일을
 * 고치면 이 파일도 같이 고쳐야 합니다. 화면이 인프라를 조회해서 그리는 것이 아니라 사람이
 * 적어 둔 그림입니다 — 조회로 그리려면 브라우저에 CloudFormation 읽기 권한을 줘야 하고,
 * 그것은 이 데모가 열어 둘 문이 아닙니다.
 *
 * 모양(CSS)까지 이 파일이 들고 있습니다. 네 화면 어디서든 열리므로 보드의 스타일에 기댈 수
 * 없습니다. 색은 공통 토큰(app/theme.css 의 --sb-*)에서 받고, 없으면 뒤의 기본값으로
 * 떨어집니다. nav-tabs.js · perm.js 와 같은 방식입니다.
 */

import { esc, setHtml } from '../lib/dom.js'

/*
 * 층. 위에서 아래로 「사람이 보는 것 → 그것을 지탱하는 것」 순서입니다.
 *
 * svc 는 AWS 서비스 이름이고 name 은 이 데모에서 그것이 하는 일입니다. 서비스 이름만 적으면
 * 무엇에 쓰는지 모르고, 하는 일만 적으면 무엇으로 만들었는지 모릅니다.
 */
const LAYERS = [
  {
    id: 'web',
    title: '보는 곳',
    boxes: [
      {
        name: '네 화면',
        svc: 'ES 모듈 · 빌드 단계 없음',
        note: '스토리 디벨롭 · 대본화 · 키비주얼 · 스토리보드. pages/ 가 화면, domain/ 이 규칙, services/ 가 밖과의 통신, components/ 가 공통 부품입니다',
      },
      {
        name: '배달',
        svc: 'CloudFront',
        note: '길에 따라 뒤가 다릅니다. / 는 사이트 버킷, /img/* 는 이미지 버킷, /gen* 는 GPU 서버',
      },
      {
        name: '정적 파일',
        svc: 'S3 (Site)',
        note: 'app/ 을 그대로 올립니다. aws-config.js 만 배포가 만들어 넣습니다(공개 파일 — 비밀은 넣지 않습니다)',
      },
    ],
  },
  {
    id: 'auth',
    title: '누구인가',
    boxes: [
      {
        name: '로그인 · 역할',
        svc: 'Cognito User Pool',
        note: '가입은 막아 두고 조직이 계정을 만듭니다. 역할은 custom:role 한 칸(기획·작화·감독·리뷰어·관리자)',
      },
      {
        name: '토큰',
        svc: 'ID 토큰 8시간',
        note: 'AppSync 가 이 토큰으로 사람을 가립니다. 화면이 스스로 권한을 정하지 않습니다',
      },
    ],
  },
  {
    id: 'sync',
    title: '함께 고치는 곳',
    boxes: [
      {
        name: '한 줄씩 주고받기',
        svc: 'AppSync (GraphQL)',
        note: '리졸버는 JS 런타임. publishOp 로 넣고 listOps 로 읽고 구독으로 받습니다',
      },
      {
        name: '작업 로그',
        svc: 'DynamoDB (Ops)',
        note: 'pk=BOARD#<판>. 컷·인물·승인·메모·권한이 모두 op 한 줄로 남습니다. 30일 TTL',
      },
      {
        name: '커서와 자리',
        svc: 'AppSync None 데이터소스',
        note: '남의 마우스와 편집 중 표시는 저장하지 않고 지나갑니다. 판에 남을 것이 아닙니다',
      },
      {
        name: '프로젝트 카드',
        svc: 'DynamoDB (같은 표, pk=PROJECTS)',
        note: '판 목록만 한자리에 모읍니다. 여기에는 TTL 이 없습니다',
      },
    ],
  },
  {
    id: 'story',
    title: '이야기를 만드는 곳',
    boxes: [
      {
        name: '기획 · 대본 · 그래프',
        svc: 'Lambda (GraphFn, VPC 안)',
        note: '시놉시스에서 비트를 뽑고 컷으로 펼치고 대본을 씁니다. 오래 걸려서 비동기로 띄우고 결과를 표에 적습니다',
      },
      {
        name: '모델',
        svc: 'Bedrock (Claude)',
        note: '기본 VPC 에는 NAT 가 없어서 인터페이스 엔드포인트로 닿습니다. 한국어 프롬프트를 영어로 옮기는 일도 여기서',
      },
      {
        name: '관계 그래프',
        svc: 'Neptune (Gremlin)',
        note: '인물·사건·장소가 어떻게 얽혔는지. 화면의 graph-engine.js 가 묻고 사실은 여기 남습니다',
      },
      {
        name: '기획 이력',
        svc: 'DynamoDB (StoryHistory)',
        note: '프로젝트별로 무엇을 어떻게 고쳐 왔는지. TTL 없이 남깁니다',
      },
    ],
  },
  {
    id: 'draw',
    title: '그림을 만드는 곳',
    boxes: [
      {
        name: '우리 GPU 서버',
        svc: 'EC2 g6e.2xlarge (L40S 48GB)',
        note: 'server.py 한 장. 모델을 올려 두고 그립니다. 가중치는 200GB gp3 에 남아 껐다 켜도 다시 받지 않습니다',
      },
      {
        name: '앞에 선 문',
        svc: 'ALB (80 → 8000)',
        note: 'CloudFront 프리픽스 리스트에서 온 것만 받습니다. 인스턴스는 밖으로 열려 있지 않습니다',
      },
      {
        name: '켜고 끄기',
        svc: 'EventBridge Scheduler',
        note: '평일 09:00 켜고 20:00 끕니다(KST). 유휴 감지가 아니라 시계입니다',
      },
      {
        name: '나온 그림',
        svc: 'S3 (Images) → CloudFront /img/*',
        note: '브라우저는 버킷을 직접 보지 않습니다. 판에는 주소만 남습니다',
      },
    ],
  },
  {
    id: 'conn',
    title: '밖의 모델을 붙이는 곳',
    boxes: [
      {
        name: '커넥터',
        svc: 'Lambda (ConnFn, VPC 밖)',
        note: 'API 키를 넣으면 그 모델이 그림판의 모델 목록에 뜹니다. 밖으로 나가는 일만 이 함수가 합니다',
      },
      {
        name: '키 보관',
        svc: 'SSM Parameter Store (SecureString)',
        note: '/storyboard/connector/*. 이 함수만 넣고 읽고 지웁니다. 브라우저로는 돌려주지 않습니다',
      },
      {
        name: '제공자',
        svc: '밖의 이미지 · 영상 API',
        note: 'Hugging Face 키는 GPU 서버도 읽습니다 — 잠긴 저장소(SD 3.5)를 내려받을 때만',
      },
    ],
  },
]

/*
 * 흐름. 상자만 늘어놓으면 무엇이 무엇을 부르는지 모릅니다. 사람이 실제로 하는 다섯 가지 일을
 * 순서대로 적습니다. 마지막 칸이 그 일의 결과가 남는 자리입니다.
 */
const FLOWS = [
  {
    title: '로그인',
    steps: ['브라우저', 'Cognito', 'ID 토큰', 'AppSync'],
    note: '역할은 토큰 안에 있습니다. 화면은 그것을 읽어 무엇을 보여줄지 정하고, 막는 것은 서버가 합니다',
  },
  {
    title: '같이 고치기',
    steps: ['내 화면', 'publishOp', 'DynamoDB (Ops)', '구독 중인 남의 화면'],
    note: '보낸 사람도 자기 op 를 먼저 화면에 얹고 보냅니다. 그래서 손이 느려지지 않습니다',
  },
  {
    title: '이야기 기획 · 대본화',
    steps: ['화면', 'AppSync plan', 'Lambda', 'Bedrock · Neptune', 'Ops 표에 결과', '화면이 받아 감'],
    note: '한 번에 1분을 넘기기도 해서 요청은 곧바로 끝내고 결과만 나중에 가져갑니다',
  },
  {
    title: '그림 만들기 (우리 GPU)',
    steps: ['화면', 'CloudFront /gen', 'ALB', 'EC2 GPU', 'S3 (Images)', '/img/* 로 다시 화면'],
    note: '기반 이미지를 얹으면 스케치나 키비주얼을 물려받아 같은 씬이 어긋나지 않습니다',
  },
  {
    title: '밖의 모델 붙이기',
    steps: ['화면에 키 입력', 'AppSync', 'Lambda (ConnFn)', 'SSM 에 보관', '제공자 API', 'S3 · Ops 표'],
    note: '키는 넣은 뒤 다시 볼 수 없습니다. 지우는 것만 됩니다',
  },
]

/* 데모를 처음 켜 보는 사람이 걸려 넘어지는 자리들. 아키텍처를 보러 온 사람이 같이 알아야 합니다 */
const NOTES = [
  'GPU 인스턴스는 시간당 요금이 붙습니다. 업무 시간 밖에는 스케줄러가 끄고, 그동안 남는 것은 볼륨과 ALB 뿐입니다.',
  'Neptune 은 provisioned 라서 쓰지 않는 동안에도 요금이 붙습니다. infra/scripts/stop.sh 로 세웁니다.',
  '작업 로그(Ops)에는 30일 TTL 이 있습니다. 한 달 쉰 판의 op 는 사라지고, 프로젝트 카드만 남습니다.',
  'aws-config.js 는 누구나 내려받을 수 있는 파일입니다. 리전과 풀 ID 만 있고 비밀은 들어가지 않습니다.',
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

/** 아키텍처 판 한 장. 창 밖에서도 쓸 수 있게 문자열만 돌려줍니다 */
export function archHtml() {
  return `
    <p class="ar__lead">서울 리전(ap-northeast-2) 한 스택입니다. 화면은 빌드 없이 S3 에 그대로 올라가고,
      함께 고치는 일은 op 한 줄씩 오갑니다. 무거운 일(모델 호출·그림 생성)은 요청을 곧바로 끝내고
      결과만 나중에 표에서 가져갑니다.</p>
    ${hereHtml()}
    ${LAYERS.map((l) => `
      <section class="ar__layer" data-layer="${l.id}">
        <h3 class="ar__h">${esc(l.title)}</h3>
        <div class="ar__row">
          ${l.boxes.map((b) => `
            <article class="ar__box">
              <b class="ar__name">${esc(b.name)}</b>
              <span class="ar__svc">${esc(b.svc)}</span>
              <span class="ar__note">${esc(b.note)}</span>
            </article>`).join('')}
        </div>
      </section>`).join('')}
    <h3 class="ar__h ar__h--gap">무엇이 무엇을 부르는가</h3>
    <ul class="ar__flows">
      ${FLOWS.map((f) => `
        <li class="ar__flow">
          <b class="ar__name">${esc(f.title)}</b>
          <span class="ar__steps">${f.steps.map((s) => `<span class="ar__step">${esc(s)}</span>`).join('<span class="ar__to" aria-hidden="true">›</span>')}</span>
          <span class="ar__note">${esc(f.note)}</span>
        </li>`).join('')}
    </ul>
    <h3 class="ar__h ar__h--gap">알아 둘 것</h3>
    <ul class="ar__notes">${NOTES.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
}

/* ── 모양 ───────────────────────────────────────────────────────────────────── */

const CSS = `
.ardlg {
  width: min(1080px, 94vw); max-height: 88vh; padding: 0; overflow: hidden;
  border: 1px solid var(--sb-line, #e4e7ec); border-radius: 12px;
  background: var(--sb-panel, #fff); color: var(--sb-ink, #111318);
  font: inherit; box-shadow: 0 24px 60px rgba(16, 24, 40, .22);
}
.ardlg::backdrop { background: rgba(16, 24, 40, .45); }
.ardlg__bar {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border-bottom: 1px solid var(--sb-line, #e4e7ec); background: var(--sb-fill, #f8f9fb);
}
.ardlg__bar h2 { font-size: 14px; margin: 0; }
.ardlg__bar button {
  margin-left: auto; font: inherit; font-size: 12px; padding: 5px 9px; cursor: pointer;
  border: 1px solid var(--sb-line, #e4e7ec); border-radius: 6px;
  background: var(--sb-panel, #fff); color: var(--sb-ink, #111318);
}
.ardlg__body { padding: 14px 16px 20px; overflow: auto; max-height: calc(88vh - 52px); }

.ar__lead, .ar__note { font-size: 12px; line-height: 1.6; color: var(--sb-ink-3, #767f8c); }
.ar__lead { margin: 0 0 10px; }
.ar__here {
  display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 0 4px; padding: 8px 10px;
  font-size: 11.5px; color: var(--sb-ink-3, #767f8c);
  background: var(--sb-fill, #f8f9fb); border: 1px solid var(--sb-line, #e4e7ec); border-radius: 8px;
}
.ar__here b { color: var(--sb-ink, #111318); font-weight: 600; margin-right: 4px; }
.ar__here--off { display: block; line-height: 1.6; }
.ar__h { font-size: 12px; margin: 16px 0 6px; color: var(--sb-ink, #111318); }
.ar__h--gap { margin-top: 22px; }
/* 층은 한 줄이고 좁으면 접힙니다. 상자 넓이를 고정하지 않아 글이 잘리지 않습니다 */
.ar__row { display: flex; flex-wrap: wrap; gap: 8px; }
.ar__box {
  flex: 1 1 220px; min-width: 200px; padding: 9px 11px;
  border: 1px solid var(--sb-line, #e4e7ec); border-radius: 8px; background: var(--sb-panel, #fff);
}
.ar__name { display: block; font-size: 12.5px; }
.ar__svc {
  display: block; margin: 2px 0 4px; font-size: 11px;
  color: var(--sb-accent, #1a56db); letter-spacing: -.01em;
}
.ar__note { display: block; font-size: 11.5px; }
.ar__flows, .ar__notes { margin: 0; padding: 0; list-style: none; }
.ar__flow { padding: 8px 0; border-bottom: 1px solid var(--sb-line, #e4e7ec); }
.ar__steps { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: 5px 0 4px; }
.ar__step {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--sb-line, #e4e7ec); color: var(--sb-ink, #111318);
}
.ar__to { color: var(--sb-ink-3, #767f8c); font-size: 11px; }
.ar__notes li {
  font-size: 11.5px; line-height: 1.6; color: var(--sb-ink-3, #767f8c);
  padding-left: 12px; position: relative;
}
.ar__notes li::before { content: '·'; position: absolute; left: 3px; }
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
  }
  setHtml(dlg.querySelector('.ardlg__body'), archHtml())
  if (!dlg.open) dlg.showModal()
}
