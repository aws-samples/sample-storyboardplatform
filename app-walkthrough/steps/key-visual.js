/*
 * 키 비주얼 화면의 예시 안내.
 *
 * app/screens/key-visual.js 에 같이 있던 것을 여기로 옮겼습니다. 예시만 쓰는 코드가
 * 300줄 넘게 그 파일에 섞여 있어서, 화면을 고치는 사람이 매번 그것을 지나가야 했고
 * 「예시 코드는 app-walkthrough 에」라는 말과도 달랐습니다.
 *
 * 이 폴더는 app/ 을 import 할 수 없습니다(../tour.js 의 머리글). 그래서 화면이 쓸
 * 것을 넣어 줍니다. keyVisualExample 의 인자가 그것입니다.
 */

import { guide as guideExample } from '../guide.js'
import { demoActive, demoAdvance, demoSay, demoTitle } from '../tour.js'

/*
 * 화면이 넣어 주는 것. 전부 app/screens/key-visual.js 의 것입니다.
 *   S                상태 한 덩이. 예시가 대본과 씬을 여기에 씁니다
 *   paint            다시 그리기
 *   wire note mark   지금 무엇을 부르는지 · 아래 안내 한 줄 · 지나간 일 한 줄
 *   job              씬 하나의 생성 상태 칸
 *   makeArt          브라우저가 그리는 대신 그림 (app/art/art.js)
 *   toScenes         대본을 씬으로 자르기
 *   normalizeVisuals 프롬프트 응답의 형식 검사. 실제 경로와 같은 검사를 지납니다
 *   paintQueue paintBoard doneJobs
 *   afterDone        예시를 마친 뒤 할 일. 화면은 코치마크를 엽니다
 *
 * 이름을 그대로 받아 그대로 씁니다. 옮기면서 부르는 모양이 달라지면 옮긴 것 때문에
 * 깨진 것인지 원래 그랬는지 갈라 보기 어렵습니다.
 */
let S, paint, wire, note, mark, job, makeArt, toScenes, normalizeVisuals
let paintQueue, paintBoard, doneJobs, afterDone

/**
 * 예시를 시작합니다. 화면의 「예시 보기」 버튼과 코치마크가 부릅니다.
 * 이미 도는 중이면 아무 일도 하지 않습니다.
 */
export function keyVisualExample(o) {
  ;({ S, paint, wire, note, mark, job, makeArt, toScenes, normalizeVisuals,
    paintQueue, paintBoard, doneJobs, afterDone } = o)
  return runExample()
}

/*
 * 예시가 넣는 대본. 실제 대본과 같은 형식이라 화면의 toScenes 를 그대로 지납니다.
 * 예시만 아는 형식을 쓰면 대본을 자르는 규칙이 예시에서는 한 번도 돌지 않게 됩니다.
 */

const SAMPLE = `INT. 극장 분장실 - 밤
거울 앞. 분장을 지우다 멈춘다.

    수린
  그 이름을 어디서 들었어.

INT. 극장 분장실 - 밤 (이어서)
문틈으로 복도의 빛이 새어든다.

INT. 본무대 - 밤
객석의 웅성거림. 조명이 한 점으로.

INT. 객석 - 밤
빈 좌석 한가운데 한 사람.

    무영
  자리는 처음부터 비어 있었지.

INT. 분장실 앞 복도 - 새벽
반쯤 열린 문. 바닥에 찬 빛이 깔린다.

EXT. 극장 옥상 - 새벽
두 사람이 난간에 서 있다.

INT. 지하 연습실 - 낮
거울 벽. 빛줄기 속의 먼지.

EXT. 극장 앞 거리 - 낮
반쯤 찢긴 포스터. 지나가는 사람들.`

/*
 * 예시 안내가 쓰는 프롬프트. 미리 받아 둔 것을 읽어 옵니다.
 *
 * 응답 모양이 net.plan() 과 같아서 normalizeVisuals 를 그대로 지납니다. 예시가 실제
 * 경로와 다른 형식을 쓰면 형식 검사가 예시에서는 한 번도 돌지 않게 됩니다.
 *
 * 한 번 읽으면 들고 있습니다. 안내를 두 번 눌러도 다시 받지 않습니다.
 */
let SAMPLE_VISUALS = null

async function sampleVisuals() {
  if (SAMPLE_VISUALS) return SAMPLE_VISUALS
  const res = await fetch('/app-walkthrough/data/key-visuals.json', { cache: 'no-store' })
  if (!res.ok) throw new Error(`예시 프롬프트를 읽지 못했습니다 (${res.status})`)
  SAMPLE_VISUALS = await res.json()
  return SAMPLE_VISUALS
}

/** 미리 받아 둔 프롬프트를 씬에 올립니다. 왕복이 없으므로 기다리는 시간이 없습니다 */
async function fillPromptsFromSample() {
  const map = normalizeVisuals(await sampleVisuals(), S.scenes.map((s) => s.id))
  let got = 0
  for (const s of S.scenes) {
    const v = map.get(s.id)
    if (!v) continue
    Object.assign(s, {
      prompt: v.prompt,
      place: v.place || s.place,
      time: v.time || s.time,
      weather: v.weather,
      beat: v.beat,
      framing: v.framing,
      cast: v.cast,
    })
    got++
  }
  wire('g', `예시  ${got}/${S.scenes.length}개 프롬프트 (왕복 없음)`)
  note(`예시 프롬프트 ${got}개를 올렸습니다`)
  mark(`예시 프롬프트 ${got}개를 올렸습니다`, { example: true })
  paint()
  return got
}

/**
 * 예시 그림 한 장. 브라우저가 그립니다. 생성 서버를 부르지 않습니다.
 *
 * 진짜 그림처럼 보이게 하려는 것이 아니라, 그림이 자리에 들어오면 화면이 어떻게
 * 되는지 보여주려는 것입니다. 그래서 'sketch' 로 그려 「SKETCH」가 찍히고, 큐와 상세는
 * 예시임을 그대로 적습니다 (j.example). 진짜 생성은 예시를 마친 뒤 직접 누를 때 돕니다.
 */
function drawSample(s) {
  const j = job(s.id)
  const art = { seed: Number(String(s.id).replace(/\D/g, '')) || 1, mode: 'sketch', prompt: s.prompt }
  j.status = 'done'
  j.example = true
  j.art = art
  j.url = makeArt(art)
  j.ms = null
  j.seed = null
  j.modelLabel = null
  paintQueue(); paintBoard()
}

let exampleRun = null

/**
 * 예시를 클릭에 맞춰 안내합니다. 사람이 손으로 밟는 순서를 그대로, 그 자리를 실제로
 * 눌러 가며 밟습니다. 다 본 사람은 이미 그 버튼들을 눌러 본 사람입니다.
 *
 * 네 단계 모두 미리 받아 둔 데이터만 씁니다. 어느 단계도 문장 모델(net.plan)이나 생성
 * 서버(/gen)를 부르지 않습니다.
 *
 * 예전에는 프롬프트 단계가 writePrompts() 로 Bedrock 을, 생성 단계가 runBatch() 로 GPU 를
 * 불렀습니다. 두 왕복을 합치면 한 번 보는 데 20~40초가 붙고, 한 장은 실패할 수도 있어서
 * 처음 온 사람이 안내 중에 오류 문구를 먼저 보게 됐습니다. 그래서 예시는 프롬프트를
 * app-walkthrough/data/key-visuals.json 에서 읽고 그림은 브라우저가 그립니다. 로컬 모드와
 * 배포 모드가 같은 예시를 보게 된 것도 그 결과입니다. 갈래를 둘로 나눌 필요가 없어졌습니다.
 *
 * 대신 예시 그림은 예시라고 적습니다(job 의 example). 진짜 생성은 예시를 마친 뒤 직접
 * 「이 씬만 다시 생성」을 누를 때 돕니다.
 */
function runExample() {
  if (exampleRun) return
  const blocks = SAMPLE.split(/\n[ \t]*\n/).filter((x) => x.trim()).length
  const steps = [
    {
      say: '예시 대본을 넣습니다', see: 'script',
      sub: `${blocks}개 블록 · 극장 하나를 배경으로 한 짧은 대본입니다`,
      spot: 'script',
      run: () => { S.script = SAMPLE; S.step = 1; paint() },
    },
    {
      say: '대본을 씬으로 나눕니다', see: 'script',
      sub: '빈 줄로 블록을 자르고, 슬러그가 같은 인접 블록은 한 씬으로 합칩니다',
      spot: 'split',
      run: () => {
        S.scenes = toScenes(S.script)
        S.jobs = {}
        S.pick = S.scenes[0]?.id || null
        S.step = 2
        paint()
        mark(`예시 대본을 씬 ${S.scenes.length}개로 나눴습니다`, { example: true })
      },
    },
    {
      say: '씬마다 이미지 프롬프트를 올립니다', see: 'prompts',
      sub: '직접 하실 때는 문장 모델이 이 칸을 채웁니다. 예시는 미리 받아 둔 것을 올립니다',
      spot: 'prompts',
      // 미리 받아 둔 것을 올리는 것이라 즉시 끝나지만 3초를 기다린다. 직접 할 때는
      // 이 칸을 문장 모델이 채운다. guide.js 머리글의 wait 를 참고
      wait: 3000, waitSay: '씬마다 프롬프트를 쓰고 있습니다',
      /*
       * 이 화면에는 모델이 둘 지납니다. 이 칸을 채우는 LLM 은 Bedrock 이고, 다음 단계의
       * 그림 모델은 우리 EC2 에서 돕니다. 그 갈림을 여기서 한 번 적어 두고, 다음 단계에서
       * 그림 쪽의 값을 적습니다(guide.js 의 note).
       */
      note: {
        head: 'LLM 은 Bedrock 으로 호출합니다',
        body: '씬을 읽고 프롬프트를 쓰는 것은 *Amazon Bedrock* 이 합니다. *토큰 수만큼만 과금*되므로 '
          + '쓰지 않는 동안의 비용이 0 입니다. 호출은 *VPC 엔드포인트를 지나 인터넷으로 나가지 않고*, '
          + 'IAM 으로 인증되며 모델 학습에 쓰이지 않습니다.',
      },
      run: () => fillPromptsFromSample(),
      /*
       * 3초 기다린 것을 보고 갑니다. 안 세우면 다음 단계가 [생성] 버튼을 짚는 사이
       * 방금 채워진 프롬프트 칸이 막에 덮입니다(guide.js 머리글의 done).
       */
      done: {
        say: '프롬프트가 채워졌습니다',
        sub: '씬의 장소 · 시간 · 인물이 한 줄의 그림 지시가 됩니다. 각 줄은 손으로 고칠 수 있고, '
          + '고친 것이 그대로 생성에 들어갑니다',
        see: 'prompts',
        got: () => `씬 ${S.scenes.filter((s) => s.prompt).length}개의 프롬프트`,
      },
    },
    {
      say: '씬마다 그림 한 장을 세웁니다', see: 'queue',
      sub: '직접 하실 때는 이 버튼이 생성 서버를 부릅니다. 장당 10초 남짓입니다. 예시 그림은 미리 받아 둔 것입니다',
      spot: 'gen',
      wait: 3000, waitSay: '씬마다 그림을 그리고 있습니다',
      /*
       * 우리 EC2 에서 도는 쪽입니다. 이 화면의 값이 여기 한 줄에 있습니다. 코치마크의
       * 같은 이름 카드(KV_CARDS)와 짝입니다. 그 카드는 「직접 시작하기」를 누른 사람에게
       * 뜨지 않으므로(그때는 안내를 열지 않습니다), 예시를 보는 사람은 여기서 읽습니다.
       */
      note: {
        head: '그림 모델만 직접 운영합니다',
        body: 'LLM 은 Bedrock 으로 호출하고, 그림 모델은 *이 계정의 EC2 에서 직접 돌립니다*. '
          + '가중치가 공개된 모델이라 화풍을 우리 것으로 고정할 수 있고, 대본과 그림이 '
          + '이 계정 밖으로 나가지 않습니다.',
      },
      run: () => {
        S.step = 3
        paint()
        for (const s of S.scenes) if (s.prompt) drawSample(s)
        mark(`예시 그림 ${doneJobs().length}장을 세웠습니다`, { example: true })
        paint()
      },
      done: {
        say: '그림이 나왔습니다',
        sub: '씬마다 한 장씩 들어옵니다. 마음에 안 드는 씬은 프롬프트를 고쳐 그 씬만 다시 그리고, '
          + '고른 장은 스토리보드의 컷으로 넘깁니다',
        see: ['kvgrid', 'queue'],
        got: () => `그림 ${doneJobs().length}장`,
        /*
         * 대가를 같은 칸에 적습니다. 값만 적고 대가를 빼면 다음에 실제로 기다리는 사람이
         * 속았다고 느낍니다. 그래서 여기에 쓰지 않는 말이 있습니다. 빠르다 · 무한히
         * 확장된다 · 제작 기간이 줄어든다(coach.js 머리글과 같은 규칙입니다).
         */
        note: {
          head: '한 대가 한 장씩 그립니다',
          body: '줄이 서 있는 것이 그 때문입니다. 카드 하나에 모델 하나만 올라가므로 *동시에 여러 장이 '
            + '아니라 순서대로* 나옵니다. GPU 는 켜 둔 시간만큼 돈이 들어서 *평일 09–20시만 켭니다*. '
            + '예시 그림은 미리 받아 둔 것이라 이 줄이 즉시 비었습니다.',
        },
      },
    },
    {
      // 끝은 말풍선의 버튼으로 냅니다. 나가는 일과 짚은 자리를 누르는 일을 가릅니다
      say: demoActive() ? '키 비주얼을 다 보셨습니다' : '여기까지가 예시입니다',
      sub: demoActive()
        ? demoSay('keyvisual')
        : '이제 대본을 바꿔 다시 나누거나, 「이 씬만 다시 생성」으로 진짜 그림을 받아 보드에 붙일 수 있습니다',
      see: 'histbox',
      go: demoActive() ? '다음 메뉴 예시로 넘어가기' : '예시 마치기',
      leaves: demoActive(),
      run: () => paint(),
    },
  ]

  exampleRun = guideExample({
    steps, title: demoTitle('keyvisual', '키 비주얼'),
    onDone: () => {
      exampleRun = null
      paint()
      // 예시 프로젝트를 밟고 있으면 다음 화면으로 넘어간다 (tour.js). 화면을 떠나는
      // 중에 막을 덮으면 한 번 반짝하고 사라지므로 코치마크는 열지 않는다
      if (demoAdvance('keyvisual')) return
      // 예시가 끝난 뒤에 짚는다. 순서가 반대면 가리킬 것이 아직 화면에 없다
      afterDone()
    },
  })
}
