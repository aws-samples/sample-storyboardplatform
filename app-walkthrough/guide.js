/*
 * 예시 길잡이 · 막을 덮고 누를 자리 하나만 남기는 층.
 *
 * 화면을 어둡게 덮고, 지금 봐야 하는 것만 그 막 위로 내보이고, 눌러야 하는 자리에
 * 동그라미와 마우스 표시를 얹습니다. 그 자리를 누르면 내용이 채워지고 다음으로 갑니다.
 *
 * 예시 전용입니다. 이 폴더를 지우면 예시만 사라지고 제품은 그대로 돕니다. 빈 화면
 * 안내(「처음 오셨나요?」)는 예시를 안 보는 사람도 지나므로 제품 쪽에 있습니다
 * (app/components/empty-panel.js).
 *
 * 예전에는 타이머로 알아서 넘어가는 재생기였습니다. 화면이 저 혼자 움직이니 읽는 속도를
 * 사람이 정할 수 없었고, 다 본 뒤에도 어디를 눌러 그렇게 되었는지는 배우지 못했습니다.
 * 그래서 손이 직접 그 자리를 지나가게 바꿨습니다. 예시를 마친 사람은 이미 그 버튼을
 * 눌러 본 사람입니다. 이 파일에 타이머가 없는 것이 그 결과입니다.
 *
 * 그 다음에 고친 것이 지금 이 모양입니다. 한동안은 화면 아래에 검은 띠를 두고 거기
 * 「이 단계 실행」·「예시 끝내기」 버튼을 뒀습니다. 그러면 짚어 준 자리 대신 띠의 버튼을
 * 누르며 끝까지 가게 됩니다. 배우라고 만든 자리를 건너뛰는 길을 우리가 같이 놓아 준
 * 셈이었습니다. 게다가 막이 없어서 눈이 갈 곳이 화면 전체였습니다. 지금은 코치마크와
 * 같은 방식으로 막을 덮고(app/components/coachmark.js), 누를 자리 하나만 남깁니다. 그만두는
 * 길은 말풍선 모서리의 ×(그리고 Esc) 하나로 남겨 둡니다. 막에 갇히는 화면을 만들 수는
 * 없습니다.
 *
 * ══ 막에 구멍을 뚫습니다. 짚은 자리를 들어 올리지 않습니다
 *
 * 코치마크는 가리킬 것에 class 를 붙여 z-index 로 막 위로 들어 올립니다. 그 방법이
 * 여기서는 통하지 않았습니다. 들어 올리려는 자리가 이미 z-index 를 가진 판 안에 있으면
 * 그 판이 쌓임 문맥(stacking context)을 만들고, 안쪽 z-index 는 그 문맥 안에서만 셉니다.
 * 스토리 디벨롭의 대본 칸이 그런 자리입니다. 그래프 위에 얹힌 카드(.card 는
 * position:absolute·z-index:5)의 안쪽이라, 여기서 z-index 를 104 로 줘도 화면에서는
 * 카드째로 5 층에 남아 100 층의 막 아래에 깔립니다. 눌러야 하는 자리가 어두운 막에
 * 묻혀 보이지도 눌리지도 않았습니다. 실제로 그랬습니다.
 *
 * 그래서 반대로 했습니다. 짚은 자리는 그 자리에 그대로 두고, 막에 그 모양대로 구멍을
 * 뚫습니다(SVG mask). 막은 클릭을 받지 않고(pointer-events:none), 클릭을 막는 일은 구멍
 * 주위를 두르는 판 넷(.onbg__guard)이 맡습니다. 그래서 사람이 누르는 것은 우리가 그린
 * 무엇이 아니라 실제 그 버튼이고, 그 자리가 어떤 판 안에 들어 있든 상관이 없습니다.
 * 테·동그라미·마우스 표시도 막 위에 좌표로 그립니다. 요소에 얹으면 같은 이유로 묻힙니다.
 *
 * 단계가 부르는 일은 미리 받아 둔 예시 데이터(app-walkthrough/data/)로만 채웁니다.
 * 예시에서 Bedrock 이나 생성 서버를 부르지 않습니다. 한 번에 10~30초씩 걸리는 왕복을
 * 안내 중에 끼워 넣으면 배우는 시간이 아니라 기다리는 시간이 됩니다. 실제 모델은 예시를
 * 마친 뒤 직접 누를 때 돕니다.
 *
 * ══ 그래도 몇 초는 기다리게 합니다 (wait)
 *
 * 데이터가 이미 손에 있으니 누르는 순간 그래프가 다 서는 것이 기술적으로는 맞습니다.
 * 그런데 그러면 예시를 본 사람이 「이 버튼은 원래 즉시 끝나는 일」로 배웁니다. 직접
 * 할 때 같은 버튼이 20초를 먹으면 그 사람은 화면이 고장 난 것으로 읽습니다. 예시가
 * 가르친 것이 틀렸기 때문입니다. 그리고 즉시 완성된 결과는 진짜로 만든 것처럼 보이지
 * 않습니다(사용자의 말: 「너무 가라 같다」).
 *
 * 그래서 모델을 부르는 자리의 단계에는 wait 를 답니다. 그 초 동안 말풍선이 「무엇을
 * 기다리는지」를 적고 진행 띠가 돌고, 다 차면 run 이 돕니다. 기다리는 것은 흉내이고
 * 왕복은 없으므로 GPU 도 Bedrock 도 부르지 않습니다. 시간의 모양만 진짜를 닮습니다.
 *
 * ══ 기다려서 나온 것을 보고 갑니다 (done)
 *
 * 3초를 기다리게 해 놓고 다 차는 순간 다음 설명으로 넘어가면, 정작 그 3초가 만들어 낸
 * 것은 다음 단계가 짚는 자리 밖에 있어서 어두운 막에 덮입니다. 기다린 사람이 무엇을
 * 기다렸는지 못 보는 셈입니다.
 *
 * 그래서 run 뒤에 한 걸음을 더 둡니다(done). 결과가 들어간 판에 구멍을 뚫어 밝히고,
 * 말풍선은 「무엇이 만들어졌는지」를 적고 넘어갈 버튼 하나를 냅니다. 넘어가는 시점은
 * 사람이 정합니다. 또 타이머로 넘기면 읽는 속도를 우리가 정하는 셈이고, 이 파일에
 * 타이머가 없는 이유가 그것입니다.
 *
 * ══ 「왜 이렇게 만들었는가」는 다른 색으로 적습니다 (note)
 *
 * 예시에는 성격이 다른 두 가지 말이 섞입니다. 하나는 길잡이입니다. 어디를 누르고 그
 * 결과가 무엇인지. 다른 하나는 그것이 왜 그런 모양인지입니다. LLM 은 Bedrock 으로
 * 호출하고 그림 모델은 이 계정의 EC2 에서 직접 돌린다, 두 종류가 같이 도니 관리할 것이
 * 갈린다, 같은 말.
 *
 * 두 번째를 파란 안내와 같은 모양으로 적으면 「누르라는 지시」로 읽힙니다. 반대로 안
 * 적으면 화면이 하는 선택의 이유가 아무 데도 없습니다. 그래서 같은 말풍선 안에 호박색
 * 칸(--sb-work)으로 갈라 둡니다. 파랑은 「하실 일」, 호박은 「알아 두실 것」입니다.
 * 색을 나눈 김에 지시가 아님을 이름으로도 적어 둡니다(꼬리표 「참고」).
 *
 * 이 말은 예시에만 붙습니다. 직접 시작한 사람은 이미 쓰기로 정한 사람이라 값을 파는
 * 말을 다시 들을 이유가 없습니다. 그때는 막도 덮지 않습니다(각 화면의 onOwn).
 *
 * 되돌리기가 없다는 사실은 말풍선에 적어 둡니다. 예시 내용은 서버에 남고 같은 보드를
 * 보는 사람에게도 보입니다(app/pages/board.js 의 push 가 net.sendOp 를 부릅니다).
 * 그것을 모른 채 누르게 두지 않습니다. 네 화면을 잇는 예시는 그래서 「예시 프로젝트」
 * 한 판에만 씁니다(app-walkthrough/tour.js).
 */

const CSS = `
/* ── 길잡이: 막 · 누를 자리 · 말풍선 ──────────── */
/*
 * 층 구조는 코치마크(coach.js)와 같은 자리에 한 칸 위(100~106)를 씁니다. 둘이 같이
 * 뜨는 일은 없지만(각 화면의 openCoach 가 guiding() 을 보고 물러납니다), 겹쳤을 때
 * 안내가 막 아래에 깔려 아무것도 못 누르는 화면이 되는 것이 가장 나쁩니다.
 *
 * 다른 점이 둘입니다. 코치마크의 막은 어디를 눌러도 다음 장으로 넘어가지만 여기서는
 * 짚어 준 자리만 눌러야 넘어갑니다. 그리고 코치마크는 가리킬 것을 막 위로 들어 올리는데
 * 여기서는 막에 구멍을 뚫습니다. 위의 머리글에 적은 쌓임 문맥 때문입니다.
 */
body.onbguiding { overflow: hidden; }
/*
 * 층의 뿌리. 화면 전체를 덮지만 손에는 닿지 않습니다(pointer-events:none) · 이 판이
 * 클릭을 받으면 구멍 안의 진짜 버튼에 손이 닿지 않습니다. 클릭을 받는 것은 아래에서
 * 그것을 되돌리는 둘뿐입니다: 구멍 밖을 막는 판(.onbg__guard)과 말풍선(.onbg__b).
 */
.onbg {
  position: fixed; inset: 0; z-index: 100; pointer-events: none;
  font-family: var(--sb-sans, sans-serif);
}

/*
 * 막. 구멍은 SVG mask 로 뚫습니다. 흰 곳은 남고 검은 곳은 지워집니다. box-shadow 로
 * 사각형 하나를 오리는 흔한 방법을 쓰지 않은 이유는 구멍이 둘 이상일 수 있기
 * 때문입니다(누를 자리 하나 + 봐야 할 판 여러 개).
 *
 * pointer-events:none 입니다. 막이 클릭을 받으면 구멍 안의 진짜 버튼에 손이 닿지
 * 않습니다. 막을 뚫었다는 것은 눈에만 뚫린 것이 아니라 손에도 뚫렸다는 뜻입니다.
 */
.onbg__veil { position: absolute; inset: 0; background: rgba(15, 20, 30, .66); pointer-events: none; }

/*
 * 구멍 밖의 클릭을 막는 판 넷(위·아래·왼·오른). 막이 클릭을 받지 않으므로 막는 일은
 * 이쪽이 맡습니다. 이 판들이 없으면 어두워진 자리를 그냥 누를 수 있어서, 안내 중에
 * 엉뚱한 버튼이 눌리고 그 버튼이 Bedrock 을 부르는 자리일 수도 있습니다.
 */
.onbg__guard { position: absolute; background: transparent; pointer-events: auto; }

/*
 * 누를 자리에 두르는 테. 요소에 붙이지 않고 막 위에 좌표로 그립니다. 요소에 붙이면
 * 그 요소가 어떤 판 안에 있느냐에 따라 막 아래에 깔립니다(머리글의 쌓임 문맥).
 */
.onbg__ring {
  position: absolute; z-index: 104; pointer-events: none;
  border: 2.5px solid var(--sb-accent, #1a56db); border-radius: var(--sb-r, 6px);
  box-shadow: 0 0 0 5px rgba(26, 86, 219, .3), 0 0 22px rgba(26, 86, 219, .5);
  animation: onbPulse 1.7s ease-in-out infinite;
}
@keyframes onbPulse {
  50% { box-shadow: 0 0 0 11px rgba(26, 86, 219, .1), 0 0 22px rgba(26, 86, 219, .3); }
}

/*
 * 그 자리를 가리키는 물결과 마우스 표시. 둘 다 pointer-events:none 입니다. 정작
 * 눌러야 하는 자리를 자기가 덮어 버리면 안 됩니다.
 *
 * 물결은 자리의 중앙에서 퍼지고, 마우스 표시는 그 오른쪽 아래에 둡니다. 커서가 실제로
 * 그 방향에서 다가오기 때문에 그렇게 두는 편이 「여기를 누르라」로 읽힙니다.
 */
.onbg__wave {
  position: absolute; z-index: 105; pointer-events: none;
  width: 54px; height: 54px; margin: -27px 0 0 -27px; border-radius: 50%;
  border: 2px solid var(--sb-accent, #1a56db); background: rgba(26, 86, 219, .18);
  animation: onbWave 1.7s ease-out infinite;
}
@keyframes onbWave {
  0% { transform: scale(.55); opacity: .95; }
  70% { transform: scale(1.5); opacity: .12; }
  100% { transform: scale(1.5); opacity: 0; }
}
.onbg__hand {
  position: absolute; z-index: 106; pointer-events: none;
  font-size: 27px; line-height: 1; filter: drop-shadow(0 3px 7px rgba(15, 20, 30, .55));
  animation: onbHand 1.7s ease-in-out infinite;
}
@keyframes onbHand {
  0%, 100% { transform: translate(0, 0); }
  50% { transform: translate(-5px, -5px); }
}
/*
 * 「여기를 누르십시오」 꼬리표. 자리 바로 위(자리가 화면 위쪽이면 아래)에 붙입니다.
 * 말풍선은 자리에서 떨어져 앉을 수 있어서, 자리 옆에 이름을 하나 더 달아 둡니다.
 */
.onbg__tag {
  position: absolute; z-index: 106; pointer-events: none; white-space: nowrap;
  padding: 5px 10px; border-radius: 999px;
  background: var(--sb-accent, #1a56db); color: #fff;
  font: 600 11.5px/1 var(--sb-sans, sans-serif);
  box-shadow: 0 4px 14px rgba(26, 86, 219, .45);
  animation: onbHand 1.7s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .onbg__ring, .onbg__wave, .onbg__hand, .onbg__tag { animation: none; }
  .onbg__wave { opacity: .5; transform: scale(1); }
}

/*
 * 말풍선. 코치마크의 것과 같은 모양이라 두 안내가 한 화면의 두 방식으로 읽힙니다.
 * 다른 점은 「다음」 버튼이 없다는 것입니다. 넘어가는 길은 짚어 준 자리뿐입니다.
 */
.onbg__b {
  position: absolute; z-index: 106; pointer-events: auto; width: 330px; padding: 16px;
  background: var(--sb-panel, #fff); border-radius: var(--sb-r-lg, 10px);
  box-shadow: 0 12px 34px rgba(15, 20, 30, .34); display: grid; gap: 9px;
  color: var(--sb-ink, #111318);
  /*
   * 창보다 긴 말풍선은 스스로 굴러갑니다. 자리는 place 가 실제 높이를 재서 잡으므로
   * 보통은 이 줄이 걸리지 않습니다. 창을 아주 낮게 줄인 사람에게만 걸립니다. 그때
   * 잘리는 것보다 굴러가는 편이 낫습니다.
   */
  max-height: calc(100vh - 28px); overflow-y: auto; overscroll-behavior: contain;
}
.onbg__crumb { display: flex; align-items: baseline; gap: 8px; font-size: 11px; color: var(--sb-ink-3, #767f8c); }
.onbg__n { margin-left: auto; font: 500 11px var(--sb-mono, monospace); color: var(--sb-accent, #1a56db); }
.onbg__h { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -.02em; line-height: 1.35; }
.onbg__p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--sb-ink-2, #5b6472); }
.onbg__do {
  display: flex; align-items: center; gap: 7px; margin-top: 2px;
  font-size: 12.5px; font-weight: 600; color: var(--sb-accent, #1a56db);
}
.onbg__do::before { content: '◉'; font-size: 11px; }
/* 짚을 자리를 못 찾은 단계에서만 나옵니다. 그때는 이 버튼이 유일한 길입니다 */
.onbg__next {
  justify-self: start; margin-top: 3px; padding: 8px 16px; font: inherit; font-size: 13px;
  font-weight: 600; color: #fff; background: var(--sb-accent, #1a56db);
  border: 0; border-radius: var(--sb-r, 6px); cursor: pointer;
}
.onbg__next:hover { background: var(--sb-accent-ink, #1543ad); }
/* 「다음 메뉴 예시로 넘어가기」처럼 화면을 떠나는 버튼. 떠난다는 것을 화살로 적습니다 */
.onbg__next--go::after { content: ' →'; }
/*
 * 기다리는 동안의 진행 띠. 몇 초짜리인지를 transition 으로 주므로(아래 waitBar) 여기에
 * 시간이 박혀 있지 않습니다. 단계마다 다릅니다.
 */
.onbg__wait { display: grid; gap: 7px; margin-top: 3px; }
.onbg__waitsay {
  display: flex; align-items: center; gap: 8px;
  font-size: 12.5px; font-weight: 600; color: var(--sb-ink-2, #5b6472);
}
.onbg__waitsay::before {
  content: ''; width: 13px; height: 13px; flex: none; border-radius: 50%;
  border: 2px solid var(--sb-line, #e4e7ec); border-top-color: var(--sb-accent, #1a56db);
  animation: onbSpin .8s linear infinite;
}
@keyframes onbSpin { to { transform: rotate(360deg); } }
.onbg__waittrack {
  height: 5px; border-radius: 999px; background: var(--sb-line, #e4e7ec); overflow: hidden;
}
.onbg__waitfill {
  height: 100%; width: 0; border-radius: 999px; background: var(--sb-accent, #1a56db);
  transition: width linear;
}
@media (prefers-reduced-motion: reduce) {
  .onbg__waitsay::before { animation: none; }
}
/*
 * 기다린 것이 나왔다는 표시. 같은 단계의 뒷걸음이라 번호(1/6)는 그대로이므로, 말풍선이
 * 앞으로 갔는지 결과를 보고 있는지를 이 한 줄이 가릅니다.
 */
.onbg__got {
  display: flex; align-items: center; gap: 6px;
  font: 600 11.5px/1.4 var(--sb-sans, sans-serif); color: var(--sb-ok, #0f7b5f);
}
.onbg__got::before { content: '✓'; font-size: 12px; }
/*
 * 「왜 이렇게 만들었는가」를 적는 칸. 길잡이와 색을 갈라 둡니다. 파랑은 하실 일이고
 * 호박(--sb-work)은 알아 두실 것입니다. 상태 색 셋 중 파랑과 부딪히지 않는 것이
 * 호박이라 그것을 씁니다(app/theme.css 의 주석).
 */
.onbg__note {
  display: grid; gap: 4px; margin-top: 2px; padding: 9px 11px;
  background: var(--sb-work-soft, #fff7e8); border: 1px solid var(--sb-work-line, #f5dfb4);
  border-left-width: 3px; border-radius: var(--sb-r, 6px);
}
.onbg__note b {
  font: 700 10.5px/1 var(--sb-sans, sans-serif); letter-spacing: .04em;
  color: var(--sb-work, #b45309); text-transform: none;
}
.onbg__note b::before { content: '◆ '; }
.onbg__note span { font-size: 12.5px; line-height: 1.6; color: var(--sb-ink-2, #5b6472); }
.onbg__note em {
  font-style: normal; font-weight: 700; color: var(--sb-work, #b45309);
}
.onbg__x {
  position: absolute; top: 9px; right: 9px; width: 24px; height: 24px; padding: 0;
  display: grid; place-items: center; font: inherit; font-size: 15px;
  color: var(--sb-ink-3, #767f8c); background: none; border: 0; border-radius: 5px; cursor: pointer;
}
.onbg__x:hover { background: var(--sb-fill, #f8f9fb); color: var(--sb-ink, #111318); }
.onbg__dots { display: flex; gap: 5px; margin-top: 1px; }
.onbg__dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--sb-line, #e4e7ec); font-style: normal; }
.onbg__dots i.on { width: 16px; border-radius: 3px; background: var(--sb-accent, #1a56db); }
`

let styled = false
function injectCss(doc) {
  if (styled) return
  styled = true
  const el = doc.createElement('style')
  el.id = 'onboardCss'
  el.textContent = CSS
  doc.head.appendChild(el)
}

/*
 * 시각과 기다림. 한 곳에 모아 둔 이유는 이 파일이 시간을 쓰는 자리가 wait 하나뿐이고,
 * 검사에서 그 하나를 짧게 줄여 돌리기 때문입니다(app/test.html).
 */
const now = () => Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const mk = (t, c, x) => {
  const n = document.createElement(t)
  if (c) n.className = c
  if (x != null) n.textContent = x
  return n
}
/* ══ 예시 길잡이 ═══════════════════════════════════ */

let live = null

/** 지금 예시가 돌고 있는지. 화면이 다시 그려질 때 띠를 덮어쓰지 않게 보는 데 씁니다 */
export const guiding = () => !!live

/** 지금 몇 번째 단계인지. 0부터입니다. 돌지 않으면 -1 입니다 */
export const guideAt = () => (live ? live.i : -1)

/**
 * 지금 짚은 자리와 같이 내보인 자리들.
 *
 * 화면이 쓰는 것이 아니라 검사가 씁니다. 예전에는 요소에 붙은 class(.onb-spot ·
 * .onb-see)로 「무엇을 짚었나」를 확인할 수 있었는데, 이제 요소에 아무것도 붙이지
 * 않으므로(막에 구멍을 뚫습니다) 물어볼 자리가 하나 있어야 합니다.
 */
export const guideMarks = () => ({
  lit: live?.lit || null, seen: [...(live?.seen || [])], done: !!live?.done,
})

/*
 * 선택자 하나를 찾습니다. 못 찾으면 null 입니다.
 *
 * try 로 감싸는 이유. 아래 spotOf 가 이름을 먼저 data-coach 선택자에 끼워 봅니다.
 * 그 이름이 이미 선택자면(예: '[data-seed="0"]') `[data-coach="[data-seed="0"]"]` 이라는
 * 잘못된 선택자가 되고, querySelector 는 그때 null 을 주지 않고 던집니다. 던지면
 * showStep 에서 안내가 그 자리에 서 버립니다.
 */
function q(sel) {
  try { return document.querySelector(sel) } catch { return null }
}

/** 이름 하나를 자리로. data-coach 이름이거나 CSS 선택자입니다 */
const one = (name) => (name ? q(`[data-coach="${name}"]`) || q(name) : null)

/** 짚을 자리(누를 곳) */
const spotOf = (step) => one(step?.spot)

/**
 * 막에 구멍을 내어 같이 보여 줄 자리들. see 를 따로 주지 않으면 누를 자리만 냅니다.
 *
 * 두 가지를 가르는 이유는, 누를 곳이 작은 버튼이고 봐야 할 것은 그 결과가 들어갈 넓은
 * 판인 경우가 흔하기 때문입니다. 버튼만 내면 「무엇이 채워졌는지」가 막에 묻힙니다.
 */
function seesOf(step) {
  const names = Array.isArray(step?.see) ? step.see : step?.see ? [step.see] : []
  return names.map(one).filter(Boolean)
}

/*
 * 짚어 둔 것을 놓습니다.
 *
 * 이제 요소에 class 를 붙이지 않으므로 걷어 낼 것도 없습니다. 지우는 것은 우리가 그린
 * 막뿐이고 그것은 draw 가 매번 새로 그립니다. 그래도 이 함수는 남겨 둡니다. 「지금 짚고
 * 있는 것이 무엇인가」를 한 곳에서 비우는 자리가 있어야 showStep 과 stop 이 같은 길을
 * 지납니다.
 */
function unspot() {
  if (!live) return
  live.lit = null
  live.seen = []
  live.wait = null
  // live.done 은 건드리지 않습니다. 결과를 보여 주는 뒷걸음도 showStep 을 한 번 지납니다
}

/*
 * 지금 그릴 단계. 결과를 보여 주는 중이면(live.done) 같은 단계를 다른 얼굴로 돌려줍니다.
 *
 * 단계를 하나 더 늘리지 않고 한 단계의 두 얼굴로 둔 이유는 셋입니다. 번호(1/6)가 늘지
 * 않아 예시의 길이가 결과 화면 수만큼 길어 보이지 않고, 각 화면의 steps 를 읽는 사람이
 * 「기다린다 → 나온 것을 본다」를 한 자리에서 읽고, done 을 지우면 기다림만 남아
 * 예전 동작으로 정확히 돌아갑니다.
 */
function viewOf(s) {
  const d = s?.done
  if (!live?.done || !d) return s || {}
  return {
    ...s,
    say: val(d.say) || '만들어졌습니다',
    sub: val(d.sub) || '',
    /* 짚을 자리는 없습니다. 이 걸음에서 할 일은 누르는 것이 아니라 보는 것입니다 */
    spot: null,
    see: d.see ?? s.see,
    got: val(d.got) || '방금 만들어진 것입니다',
    go: val(d.go) || '다음으로',
    /* 참고 칸은 물려받지 않습니다. 같은 말이 앞걸음과 뒷걸음에 두 번 적힙니다 */
    note: d.note || null,
    leaves: false,
    wait: 0,
  }
}

/*
 * done 의 글자는 함수로도 줄 수 있습니다. 「노드 87개」처럼 run 이 돈 뒤에야 알 수 있는
 * 숫자를 적으려면 그때 세야 하는데, steps 는 안내가 시작되기 전에 한 번 만들어집니다.
 */
const val = (v) => (typeof v === 'function' ? v() : v)

/** 지금 단계의 원본. run·wait 을 읽는 자리(fire)가 씁니다 */
const raw = () => live?.steps[live.i]

/** 지금 그릴 얼굴. 그리는 자리(showStep·draw)가 씁니다 */
const cur = () => viewOf(raw())

/**
 * 한 단계를 화면에 올립니다. 실행하지는 않습니다. 누를 자리를 짚고 기다립니다.
 *
 * 자리를 못 찾으면 말풍선에 「다음」 버튼을 내어 그것으로 넘기게 합니다. 없는 자리에
 * 테를 두르면 안내가 먼저 신뢰를 잃고, 막까지 덮은 상태에서 누를 곳이 하나도 없으면
 * 그 화면은 갇힙니다.
 */
function showStep() {
  if (!live) return
  unspot()
  const s = cur()
  const el = spotOf(s)
  if (el) live.lit = el
  else if (s?.spot) console.warn('[onboard] 짚을 자리를 못 찾았습니다:', s.spot)
  live.seen = seesOf(s)
  // 안쪽에서 스크롤되는 판 속에 있으면 화면 밖일 수 있습니다. 좌표를 재기 전에 끌어옵니다
  for (const n of [el, ...live.seen]) n?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  // 화면이 다시 그려진 뒤에 좌표를 잽니다. coach.js 의 show 와 같은 이유입니다
  requestAnimationFrame(() => draw())
}

/** 자리가 화면 안에 실제로 그려져 있는지. 0×0 이거나 화면 밖이면 없는 것으로 봅니다 */
const onScreen = (r) => !!r && r.width > 0 && r.height > 0
  && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth

/** 구멍 하나의 네 변. 자리보다 살짝 넓게 잡아 테가 글자에 붙지 않게 합니다 */
const holeOf = (r, pad = 6) => ({
  left: Math.max(0, r.left - pad), top: Math.max(0, r.top - pad),
  right: Math.min(innerWidth, r.right + pad), bottom: Math.min(innerHeight, r.bottom + pad),
})

/**
 * 막·테·물결·마우스 표시·꼬리표·말풍선을 지금 좌표에 맞춰 다시 그립니다.
 *
 * 순서가 있습니다. 막을 먼저 깔고, 그 위에 클릭을 막는 판을 두르고, 그 위에 표시를
 * 얹고, 말풍선을 마지막에 올립니다. 표시가 다 pointer-events:none 이므로 이 순서가
 * 「보이는 것」의 순서일 뿐 「눌리는 것」에는 영향이 없습니다.
 */
function draw() {
  if (!live) return
  const s = cur()
  const root = live.root
  root.textContent = ''

  const spot = live.lit ? live.lit.getBoundingClientRect() : null
  const lit = onScreen(spot) ? spot : null
  const boxes = [...(lit ? [lit] : []),
    ...live.seen.map((n) => n.getBoundingClientRect()).filter(onScreen)]

  root.append(veilWith(boxes.map((r) => holeOf(r))))

  /*
   * 구멍 밖의 클릭을 막는 판. 누를 자리 하나만 열어 둡니다. see 로 낸 구멍은 보여
   * 주려고 낸 것이고 거기까지 열면 안내 중에 그 판의 버튼이 눌립니다.
   */
  if (lit) for (const g of guards(holeOf(lit))) root.append(g)
  else root.append(guardAll())

  if (lit) {
    /*
     * 테·물결·마우스 표시·꼬리표. 자리가 화면 밖으로 밀렸으면 아무것도 얹지 않습니다. * 허공에 손가락을 띄우는 것보다 없는 편이 낫습니다(그래서 lit 이 null 입니다).
     */
    const h = holeOf(lit)
    const ring = mk('span', 'onbg__ring')
    ring.style.cssText = `left:${h.left}px;top:${h.top}px;`
      + `width:${h.right - h.left}px;height:${h.bottom - h.top}px`
    ring.setAttribute('aria-hidden', 'true')

    const cx = (h.left + h.right) / 2
    const cy = (h.top + h.bottom) / 2
    const wave = mk('span', 'onbg__wave')
    wave.style.cssText = `left:${cx}px;top:${cy}px`
    wave.setAttribute('aria-hidden', 'true')

    const hand = mk('span', 'onbg__hand', '🖱')
    hand.style.cssText = `left:${cx + 14}px;top:${cy + 9}px`
    hand.setAttribute('aria-hidden', 'true')

    /* 꼬리표는 자리 위에 붙이고, 위에 자리가 없으면 아래로 내립니다 */
    const tag = mk('span', 'onbg__tag', s?.tag || '여기를 누르십시오')
    const above = h.top > 34
    tag.style.cssText = `left:${Math.max(6, h.left)}px;`
      + `top:${above ? h.top - 30 : Math.min(innerHeight - 28, h.bottom + 9)}px`
    tag.setAttribute('aria-hidden', 'true')

    root.append(ring, wave, hand, tag)
  }

  /*
   * 붙이고 나서 자리를 잡습니다. place 가 높이를 재려면 이미 문서 안에 있어야 합니다.
   * 같은 프레임 안이므로 잠깐 왼쪽 위에 있는 모습이 눈에 보이지는 않습니다.
   */
  const b = bubble(s, !!lit)
  root.append(b)
  place(b, boxes)
}

/**
 * 구멍 뚫린 막 한 장.
 *
 * SVG mask 로 뚫습니다. 흰 것은 남고 검은 것은 지워집니다. 구멍이 하나면 box-shadow
 * 로도 되지만 여기서는 여러 개일 수 있어서(누를 자리 + 봐야 할 판들) 마스크 쪽이 맞습니다.
 * mask 를 못 읽는 브라우저에서는 구멍 없는 막이 되고, 그때도 클릭은 아래 guards 가
 * 가리므로 눌러야 할 자리는 여전히 눌립니다. 어둡게 보일 뿐입니다.
 *
 * 괄호를 손으로 한 번 더 감쌉니다. encodeURIComponent 는 ( 와 ) 를 그냥 둡니다. 그래서
 * 안쪽의 url(#m) 이 그대로 남고, CSS 는 그 닫는 괄호를 바깥 url() 의 끝으로 읽어
 * 선언 하나가 통째로 버려집니다. 실제로 그랬습니다(막이 아예 안 그려졌습니다).
 */
function veilWith(holes) {
  const veil = mk('div', 'onbg__veil')
  if (!holes.length) return veil
  const rects = holes.map((h) => `<rect x="${h.left}" y="${h.top}" `
    + `width="${Math.max(0, h.right - h.left)}" height="${Math.max(0, h.bottom - h.top)}" `
    + 'rx="8" fill="#000"/>').join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${innerWidth}" height="${innerHeight}">`
    + `<mask id="m"><rect width="100%" height="100%" fill="#fff"/>${rects}</mask>`
    + `<rect width="100%" height="100%" fill="#0f141e" fill-opacity=".66" mask="url(#m)"/></svg>`
  const enc = encodeURIComponent(svg).replace(/\(/g, '%28').replace(/\)/g, '%29')
  // 바탕색은 지웁니다. 안 지우면 뚫은 구멍 뒤에 그 색이 그대로 남습니다
  veil.style.cssText = 'background-color:transparent;'
    + `background-image:url("data:image/svg+xml;utf8,${enc}")`
  return veil
}

/** 구멍 하나를 둘러 클릭을 막는 판 넷. 구멍 안쪽만 손에 닿습니다 */
function guards(h) {
  const box = (css) => { const n = mk('div', 'onbg__guard'); n.style.cssText = css; return n }
  return [
    box(`left:0;top:0;right:0;height:${Math.max(0, h.top)}px`),
    box(`left:0;top:${h.bottom}px;right:0;bottom:0`),
    box(`left:0;top:${h.top}px;width:${Math.max(0, h.left)}px;height:${h.bottom - h.top}px`),
    box(`left:${h.right}px;top:${h.top}px;right:0;height:${h.bottom - h.top}px`),
  ]
}

/** 누를 자리가 없는 단계에서는 화면 전체를 막습니다. 그때 길은 말풍선의 버튼뿐입니다 */
function guardAll() {
  const n = mk('div', 'onbg__guard')
  n.style.cssText = 'inset:0'
  return n
}

/**
 * 말풍선 한 장. 넘어가는 길은 짚은 자리이고, 자리가 없을 때만 「다음」이 나옵니다.
 *
 * 자리는 여기서 잡지 않습니다. 높이를 재야 하므로 붙인 뒤에 place 가 잡습니다.
 *
 * @param {boolean} lit - 짚은 자리가 화면에 실제로 그려져 있는지. live.lit 이 있어도
 *   그 자리가 0×0 이거나 화면 밖이면 테를 얹지 못했으므로 「표시된 곳」이 없습니다.
 *   그때 「표시된 곳을 눌러 주십시오」만 적으면 누를 곳이 하나도 없는 화면이 됩니다.
 */
function bubble(s, lit) {
  const b = mk('div', 'onbg__b')
  b.setAttribute('role', 'dialog')
  b.setAttribute('aria-modal', 'true')

  const top = mk('div', 'onbg__crumb')
  top.append(mk('span', null, live.title))
  top.append(mk('span', 'onbg__n', `${live.i + 1} / ${live.steps.length}`))
  b.append(top)

  const x = mk('button', 'onbg__x', '×')
  x.type = 'button'
  x.title = '예시를 그만 봅니다'
  x.setAttribute('aria-label', '예시 그만두기')
  x.onclick = () => stop()
  b.append(x)

  const h = mk('h2', 'onbg__h', s?.say || '')
  b.append(h)
  if (s?.sub) b.append(mk('p', 'onbg__p', s.sub))
  /* 기다려서 나온 것을 보고 있는 걸음이면 그렇다고 적습니다. 번호는 그대로이므로 */
  if (s?.got) b.append(mk('div', 'onbg__got', s.got))
  /*
   * 「왜 이렇게 만들었는가」. 누를 곳을 적기 전에 둡니다. 무엇인지 → 왜 그런지 →
   * 무엇을 할지 순서로 읽힙니다. 지시 다음에 두면 누른 뒤에 읽게 됩니다.
   */
  if (s?.note) b.append(noteBox(s.note))

  /*
   * 아래 셋 중 하나가 붙습니다.
   *   기다리는 중  진행 띠. 누를 것이 없습니다. 몇 초 뒤 run 이 알아서 돕니다
   *   짚은 자리 있음  「어디를 누르라」
   *   자리 없음    「다음」 버튼. 그때는 그 버튼이 유일한 길입니다
   */
  if (live.wait) {
    b.append(waitBar(s))
  } else if (lit) {
    b.append(mk('div', 'onbg__do', s?.do || '표시된 곳을 눌러 주십시오'))
  } else {
    const go = mk('button', 'onbg__next' + (s?.leaves ? ' onbg__next--go' : ''), s?.go || '다음')
    go.type = 'button'
    go.onclick = () => fire()
    go.disabled = !!live.busy
    b.append(go)
  }

  const dots = mk('div', 'onbg__dots')
  live.steps.forEach((_, i) => dots.append(mk('i', i === live.i ? 'on' : null)))
  dots.setAttribute('aria-hidden', 'true')
  b.append(dots)

  return b
}

/**
 * 말풍선을 막 위로 올린 것을 덮지 않는 자리로 보냅니다.
 *
 * 높이를 재고 나서 잡습니다. 예전에는 240px 로 어림했는데, 참고 칸이 붙는 걸음(설명 +
 * 결과 한 줄 + 호박색 칸 + 점)은 그보다 훨씬 길어서 아래가 창밖으로 잘렸습니다. 「그래프와
 * 씨앗이 만들어졌습니다」가 그 걸음입니다. 그래서 붙인 뒤에 실제 높이로 잽니다.
 *
 * @param {HTMLElement} b - 이미 root 에 붙어 있는 말풍선. 안 붙었으면 높이가 0 입니다
 * @param {Array} boxes - 구멍들. 비어 있으면 화면 가운데
 */
function place(b, boxes) {
  const gap = 14
  const W = b.offsetWidth || 330
  // 재지 못하는 곳(테스트의 jsdom)에서는 예전 어림값으로 둡니다
  const H = Math.min(b.offsetHeight || 240, innerHeight - gap * 2)

  const span = boxes.reduce((a, r) => ({
    top: Math.min(a.top, r.top), bottom: Math.max(a.bottom, r.bottom),
    left: Math.min(a.left, r.left), right: Math.max(a.right, r.right),
  }), { top: 1e9, bottom: -1e9, left: 1e9, right: -1e9 })

  let x0, y0
  if (!boxes.length) {
    x0 = (innerWidth - W) / 2
    y0 = (innerHeight - H) / 2
  } else if (innerWidth - span.right - gap >= W) { x0 = span.right + gap; y0 = span.top }
  else if (span.left - gap >= W) { x0 = span.left - gap - W; y0 = span.top }
  else if (innerHeight - span.bottom - gap >= H) { x0 = span.left; y0 = span.bottom + gap }
  else { x0 = innerWidth - W - gap; y0 = innerHeight - H - gap }

  b.style.left = `${Math.max(gap, Math.min(x0, innerWidth - W - gap))}px`
  b.style.top = `${Math.max(gap, Math.min(y0, innerHeight - H - gap))}px`
}

/**
 * 참고 칸 한 장. 길잡이가 아니라 「이 화면이 왜 이런 모양인가」입니다.
 *
 * 문자열 하나로도, { head, body } 로도 받습니다. 굵게 할 말은 * 로 감쌉니다. * innerHTML 을 쓰지 않으려고 둔 최소한의 표시입니다(예시 문구도 결국 사람이 쓴
 * 데이터이므로 태그를 그대로 심는 길은 열어 두지 않습니다).
 *
 * @param {string|{head?: string, body: string}} note
 */
function noteBox(note) {
  const { head = '참고', body } = typeof note === 'string' ? { body: note } : note
  const box = mk('div', 'onbg__note')
  box.append(mk('b', null, head))
  const line = mk('span')
  // * 로 감싼 토막만 굵게. 홀수 번째가 감싸인 쪽입니다
  String(body || '').split('*').forEach((part, i) => {
    if (!part) return
    line.append(i % 2 ? mk('em', null, part) : document.createTextNode(part))
  })
  box.append(line)
  return box
}

/**
 * 기다리는 동안의 진행 띠 한 장.
 *
 * 남은 시간만큼만 채웁니다. draw 는 창이 바뀔 때마다 다시 도는데, 그때 띠를 0 에서 다시
 * 시작하면 스크롤 한 번에 진행이 되돌아가는 것으로 보입니다. 그래서 live.wait 에 끝나는
 * 시각을 적어 두고 여기서는 그것까지의 나머지만 그립니다.
 */
function waitBar(s) {
  const box = mk('div', 'onbg__wait')
  box.append(mk('div', 'onbg__waitsay', s?.waitSay || '만들고 있습니다'))
  const track = mk('div', 'onbg__waittrack')
  const fill = mk('i', 'onbg__waitfill')
  fill.style.fontStyle = 'normal'
  fill.style.display = 'block'
  track.append(fill)
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-label', s?.waitSay || '만들고 있습니다')
  box.append(track)

  const left = Math.max(0, live.wait.until - now())
  fill.style.width = `${Math.round(100 - (left / live.wait.ms) * 100)}%`
  // 다음 프레임에 목표를 줍니다. 같은 프레임에 주면 브라우저가 시작값을 못 봅니다
  requestAnimationFrame(() => {
    fill.style.transitionDuration = `${left}ms`
    fill.style.width = '100%'
  })
  return box
}

/**
 * 지금 단계를 실행하고 다음으로 넘깁니다. 짚은 자리를 눌러도, 띠의 버튼을 눌러도
 * 여기 한 곳을 지납니다.
 *
 * wait 가 붙은 단계는 그 초를 먼저 기다립니다. 짚은 자리는 그때 걷습니다(live.lit 을
 * 비웁니다). 안 걷으면 기다리는 동안 그 자리가 여전히 열려 있어서 두 번, 세 번 눌리고,
 * 사람은 「첫 번째 클릭이 안 먹었다」로 읽습니다.
 *
 * done 이 붙은 단계는 run 뒤에 한 걸음을 더 섭니다. 기다려 나온 것을 밝혀 보여 주는
 * 걸음입니다. 그 걸음에서 다시 여기로 오면(버튼 하나뿐입니다) 다음 단계로 넘어갑니다.
 *
 * run 이 비동기인 동안 버튼을 잠급니다. 안 잠그면 두 번 눌러 같은 단계가 두 번 돕니다.
 *
 * 기다리는 중에 안내가 멈출 수 있습니다(사람이 닫거나 다른 화면으로 갑니다). 그때 잠든
 * 이 함수는 그대로 살아 있다가 깨어나므로, 깬 자리가 아직 「내가 시작한 그 안내」인지를
 * 봐야 합니다. live 가 있는지만 보면 그 사이에 새로 시작된 다른 안내의 단계를 밀어
 * 버립니다. 안내를 잇달아 두 번 여는 화면에서 첫 안내의 잠꼬대가 두 번째를 흔듭니다.
 */
async function fire() {
  if (!live || live.busy) return
  const me = live
  const s = raw()

  /*
   * 결과를 보고 있던 걸음에서 온 것이면 run 을 다시 돌리지 않고 그냥 넘깁니다. * 같은 단계의 run 이 두 번 돌면 예시 데이터가 두 번 얹힙니다.
   */
  if (live.done) {
    live.done = false
    if (live.i >= live.steps.length - 1) { stop(); return }
    live.i += 1
    showStep()
    return
  }

  live.busy = true

  if (s?.wait > 0) {
    live.lit = null
    live.wait = { ms: s.wait, until: now() + s.wait }
    draw()
    await sleep(s.wait)
    if (live !== me) return
    live.wait = null
  }

  try {
    await s?.run?.()
  } catch (e) {
    console.warn('[onboard] 예시 단계에서 걸렸습니다', e)
  }
  if (live !== me) return
  live.busy = false

  /*
   * 나온 것을 보고 갑니다. 마지막 단계에도 붙일 수 있게 넘어갈지 여부보다 먼저 봅니다. * 여기서 끝내 버리면 마지막 단계의 결과는 아무도 못 봅니다.
   */
  if (s?.done) {
    live.done = true
    showStep()
    return
  }

  if (live.i >= live.steps.length - 1) { stop(); return }
  live.i += 1
  showStep()
}

/**
 * 예시를 클릭에 맞춰 안내합니다. 타이머가 없습니다. 사람이 누를 때만 넘어갑니다.
 *
 * 화면을 막으로 덮고, 지금 봐야 하는 것과 눌러야 하는 자리에만 구멍을 뚫습니다. 그
 * 자리에는 테 · 물결 · 마우스 표시 · 꼬리표 넉 장이 얹혀서 어디를 눌러야 하는지 한눈에
 * 보입니다. 누르면 그 자리의 원래 동작은 막고 run 이 대신 돌아 내용이 채워집니다.
 *
 * 각 단계는 { say, sub?, note?, spot?, see?, do?, tag?, go?, leaves?, wait?, waitSay?, done?, run? } 입니다.
 *   say      말풍선의 큰 줄. 지금 무엇을 하는지
 *   sub      그 아래 설명 줄
 *   note     「왜 이렇게 만들었는가」. 호박색 칸으로 갈라 적습니다(머리글의 note).
 *            문자열이거나 { head, body }. 굵게 할 토막은 *별표* 로 감쌉니다
 *   spot     누를 자리. data-coach 이름이거나 CSS 선택자
 *   see      같이 막 위로 올려 보여 줄 자리들. 누를 곳과 결과가 들어갈 판이 다를 때 씁니다
 *   do       「표시된 곳을 눌러 주십시오」 대신 적을 한 줄
 *   tag      자리에 붙는 꼬리표의 글자. 기본은 「여기를 누르십시오」
 *   go       자리를 못 찾았을 때만 나오는 버튼의 글자. 기본은 「다음」
 *   leaves   그 버튼이 이 화면을 떠나는 것이면 true. 이름 뒤에 화살을 붙입니다
 *   wait     run 전에 기다릴 밀리초. 모델을 부르는 자리의 단계에 답니다(머리글 참고)
 *   waitSay  기다리는 동안 적을 한 줄. 기본은 「만들고 있습니다」
 *   run      실제로 화면을 바꾸는 함수. 동기·비동기 둘 다 됩니다
 *   done     run 뒤에 나온 것을 보여 줄 한 걸음. 없으면 바로 다음 단계로 갑니다
 *            { say, sub?, see?, got?, go?, note? } · see 를 주면 그 판만 밝힙니다(기본은 단계의 see).
 *            네 글자는 함수로도 줄 수 있습니다. run 이 돈 뒤에야 아는 숫자를 적을 때 씁니다.
 *            note 는 물려받지 않습니다. 여기 적은 것만 이 걸음에 뜹니다
 *
 * 원래 동작을 막는 것은 예시가 실수로 진짜 모델 호출에 닿지 않게 하려는 것입니다. * 무슨 일이 일어나는지는 run 한 곳만 읽으면 됩니다. 자리에 커서를 두어야 하는
 * 단계(대본 칸 같은 것)는 run 에서 focus 를 부릅니다.
 *
 * 그만두는 길은 말풍선의 × 와 Esc 입니다. 막을 덮는 화면에 나가는 길이 없으면
 * 그것은 안내가 아니라 갇힌 화면입니다.
 *
 * @param {object} o
 * @param {Array} o.steps
 * @param {string} [o.title] - 말풍선 왼쪽 위에 붙는 이름
 * @param {() => void} o.onDone - 다 돌았거나 그만둔 뒤. 중간에 그만둬도 부릅니다
 * @returns {{stop: () => void}|null} 이미 돌고 있으면 null
 */
export function guide({ steps = [], title = '예시', onDone } = {}) {
  if (live) return null
  if (!steps.length) { onDone?.(); return null }
  injectCss(document)

  const root = mk('div', 'onbg')
  root.id = 'onbGuide'
  document.body.append(root)
  document.body.classList.add('onbguiding')

  live = {
    i: 0, steps, root, title, lit: null, seen: [], busy: false, wait: null, done: false, onDone,
  }

  /*
   * 짚은 자리의 클릭을 document 의 캡처 단계에서 받습니다. 캡처는 target 보다 먼저
   * 지나가므로 여기서 멈추면 그 자리의 원래 핸들러가 돌지 않습니다.
   * 말풍선 안에서 난 클릭은 이 길을 타지 않습니다. 그쪽은 자기 onclick 이 받습니다.
   */
  live.onClick = (e) => {
    if (!live || live.root.contains(e.target)) return
    if (!live.lit) return
    if (!live.lit.contains(e.target) && live.lit !== e.target) return
    e.preventDefault()
    e.stopPropagation()
    fire()
  }
  // 키보드로 짚은 자리에 닿은 사람도 같은 길을 씁니다
  live.onKey = (e) => {
    if (!live) return
    if (e.key === 'Escape') { e.preventDefault(); stop(); return }
    if (!live.lit || e.key !== 'Enter') return
    if (!live.lit.contains(e.target) && live.lit !== e.target) return
    e.preventDefault()
    e.stopPropagation()
    fire()
  }
  // 창이 바뀌거나 안쪽 판이 움직이면 잰 좌표가 어긋납니다. 다시 잽니다
  live.onSize = () => draw()
  addEventListener('click', live.onClick, true)
  addEventListener('keydown', live.onKey, true)
  addEventListener('resize', live.onSize)
  addEventListener('scroll', live.onSize, true)

  showStep()
  return { stop }
}

/** 안내를 끝냅니다. 끝까지 가도, 중간에 그만둬도 여기 한 곳을 지납니다 */
export function stop() {
  if (!live) return
  unspot()
  removeEventListener('click', live.onClick, true)
  removeEventListener('keydown', live.onKey, true)
  removeEventListener('resize', live.onSize)
  removeEventListener('scroll', live.onSize, true)
  live.root.remove()
  document.body.classList.remove('onbguiding')
  const { onDone } = live
  live = null
  onDone?.()
}
