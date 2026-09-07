/*
 * 스토리 디벨롭 화면의 예시 안내.
 *
 * app/screens/story-graph.js 에 같이 있던 것을 여기로 옮겼습니다. 화면 코드가 1,669줄
 * 이었고 그중 170줄 가까이가 예시만 쓰는 것이었습니다.
 *
 * 이 폴더는 app/ 을 import 할 수 없습니다(../tour.js 의 머리글). 그래서 화면이 쓸
 * 것을 넣어 줍니다. developExample 의 인자가 그것입니다.
 */

import { guide as guideExample } from '../guide.js'
import { demoActive, demoAdvance, demoSay, demoTitle } from '../tour.js'

/*
 * 화면이 넣어 주는 것. 전부 app/screens/story-graph.js 의 것입니다.
 *   $            id 로 요소 하나. 예시가 대본 칸과 자유 입력 칸에 글을 씁니다
 *   NET          plan 을 부를 수 있는지. 안내 문구가 로컬 모드에서 달라집니다
 *   modelLabel   지금 고른 모델의 짧은 이름
 *   store        () => STORE. 예시가 boot 뒤에 다시 읽으므로 함수로 받습니다
 *   stories      () => STORIES. 위와 같습니다
 *   seeds        () => SEEDS
 *   boot mark openTab pickSeed
 *   playing      예시 재생 중임을 화면에 알립니다(그 사이의 기록에 표시가 붙습니다)
 *   afterDone    예시가 끝났습니다. 화면이 다시 그립니다
 *   openCoach    그 뒤에 코치마크. 예시가 남긴 것을 짚으므로 순서가 이래야 합니다
 *
 * STORE · SEEDS · STORIES 는 예시가 도는 사이에 값이 바뀝니다. 그래서 값이 아니라
 * 읽는 함수를 받습니다. 값으로 받으면 예시가 시작할 때의 빈 판을 계속 들고 있습니다.
 */
let $, NET, modelLabel, store, stories, seeds, boot, mark, openTab, pickSeed
let playing, afterDone, openCoach

/** 예시를 시작합니다. 화면의 「예시 보기」와 코치마크가 부릅니다 */
export function developExample(o) {
  ;({ $, NET, modelLabel, store, stories, seeds, boot, mark, openTab, pickSeed,
    playing, afterDone, openCoach } = o)
  return runExample()
}

/**
 * 예시 안내. 목데이터를 한 번에 쏟지 않고 사람이 손으로 할 순서를 그대로 밟게 합니다. * 대본을 넣고, 그래프를 얹고, 씨앗을 보고, 첫 씨앗의 분기를 만듭니다. 단계마다 누를
 * 자리를 짚어 주고 그 자리를 눌러야 넘어갑니다. 다 본 사람은 이미 그 버튼들을 눌러
 * 본 사람입니다.
 *
 * 어느 단계도 Bedrock 을 부르지 않습니다. 그래프는 미리 뽑아 둔 것(boot 이 읽는
 * app-walkthrough/data/)을 얹고, 분기는 pickSeed(0, true) 로 목데이터(POOL)에서
 * 세웁니다. 예전에는 여기서 planBranches 가 돌아 한 단계에 10~30초가 걸렸는데,
 * 안내 중의 그 시간은 배우는 시간이 아니라 기다리는 시간입니다.
 *
 * 분기까지만 갑니다. 개요·컷·대본은 그 뒤에 직접 누르게 둡니다.
 */
function runExample() {
  const slot = $('onbSlot')
  if (slot) slot.hidden = true
  playing(true)
  let synopsis = ''

  const steps = [
    {
      say: '예시 시놉시스를 넣습니다',
      sub: '케이팝 데몬 헌터스. 세 사람이 노래로 결계를 붙잡고 있는 이야기입니다',
      spot: '#scriptIn', see: 'input',
      run: async () => {
        try {
          const res = await fetch('/app-walkthrough/data/kdh-synopsis.txt', { cache: 'no-store' })
          synopsis = res.ok ? await res.text() : ''
        } catch { synopsis = '' }
        if (synopsis) {
          $('scriptIn').value = synopsis
          $('inputHint').className = 'hint'
          $('inputHint').textContent = '예시 시놉시스를 넣었습니다. 직접 할 때는 여기에 붙여 넣습니다.'
        }
      },
    },
    {
      say: '대본에서 그래프를 뽑습니다',
      sub: NET
        ? '직접 하실 때는 이 버튼이 Bedrock 으로 이 일을 합니다. 예시는 미리 뽑아 둔 결과를 얹으므로 기다리지 않습니다'
        : '로컬 모드에서는 추출이 막혀 있어 미리 뽑아 둔 결과를 얹습니다',
      spot: 'extract', see: 'input',
      /*
       * 미리 뽑아 둔 그래프를 얹는 것이라 실제로는 즉시 끝납니다. 그래도 3초를 기다립니다. * 직접 할 때 이 버튼은 Bedrock 을 부르고 대본이 길면 먼저 요약까지 합니다. 예시가
       * 즉시 끝나는 것으로 보여 주면 직접 하는 사람이 그 기다림을 고장으로 읽습니다.
       */
      wait: 3000, waitSay: `${modelLabel()} 로 그래프를 뽑고 있습니다`,
      /*
       * 여기서 값을 팝니다. 이 버튼이 문장 모델을 부르는 자리이고, 그 모델을 우리가
       * 띄우지 않는다는 것이 이 화면 구조의 절반입니다(나머지 절반은 키비주얼의 그림
       * 모델입니다). 파란 안내와 색을 갈라 적습니다. guide.js 머리글의 note.
       */
      note: {
        head: '문장 모델은 부르기만 합니다',
        body: '대본에서 그래프를 뽑는 것은 *Amazon Bedrock* 이 합니다. 서버도 GPU도 띄우지 않고 '
          + '부른 만큼만 냅니다.',
      },
      run: async () => {
        await boot()
        if (store()) mark(`예시 그래프를 얹었습니다. 노드 ${store().stats().nodes}개`)
      },
      /*
       * 3초를 기다리게 해 놓고 바로 다음 설명으로 넘어가면 그 3초가 만든 그래프가 막에
       * 덮입니다. 여기서 한 걸음 서서 그래프와 숫자 판을 같이 밝힙니다.
       *
       * 씨앗 판도 같이 엽니다. 그래프는 그 자체가 결과가 아니고 씨앗이 나오는 바탕입니다.
       * 그래프만 밝히면 「그림이 예쁘게 나왔다」로 끝나고, 다음 단계가 씨앗을 꺼낼 때
       * 그것이 어디서 나온 것인지가 끊깁니다.
       */
      done: {
        say: '그래프와 씨앗이 만들어졌습니다',
        sub: '인물 · 장소 · 사건이 노드가 되고 그 사이의 관계가 엣지가 됩니다. '
          + '「명시 엣지」는 대본에 적혀 있던 것이고 「추론」은 그것에서 따라 나온 것입니다. '
          + '오른쪽 씨앗은 그 그래프를 탐지기 12종이 읽어 찾아낸 이야기거리입니다',
        see: ['stats', '#network', 'tabs', '#seedsList'],
        got: () => {
          const st = store()?.stats()
          return st
            ? `노드 ${st.nodes}개 · 명시 엣지 ${st.assertedEdges}개 · 추론 ${st.derivedEdges}개 · 씨앗 ${seeds().length}개`
            : ''
        },
        note: {
          head: '그래프로 두는 이유',
          body: '대본을 글로 두면 「미라가 무엇을 숨겼는지」를 사람이 다시 읽어야 압니다. '
            + '그래프로 두면 *탐지기가 그것을 찾습니다* · 회차가 쌓일수록 이 판이 자라고, '
            + '자란 판에서 다음 이야기가 나옵니다.',
        },
      },
    },
    {
      say: '탐지기 12종이 이야기 씨앗을 찾습니다',
      sub: '숨긴 비밀 · 삼각관계 · 체호프의 총 … 인물 사이에 걸린 것을 그래프에서 읽어 냅니다',
      spot: 'tabs', see: 'stats',
      run: () => { openTab('seeds') },
    },
    {
      say: '씨앗 하나에서 분기를 만듭니다',
      sub: '직접 하실 때는 이 버튼이 모델을 부릅니다. 예시는 미리 받아 둔 분기를 그 자리에 세웁니다',
      spot: '[data-seed="0"]', see: 'tabs',
      wait: 3000, waitSay: '분기 세 개를 만들고 있습니다',
      run: () => (seeds().length ? pickSeed(0, true) : null),
      /*
       * 기다려서 나온 스토리를 밝힙니다. 판(#storyPanel)까지 같이 냅니다. 탭만 밝히면
       * 「탭이 하나 켜졌다」로 보이고, 정작 3초가 만든 분기 · 비트 · 역기입 미리보기는
       * 막 아래에 그대로 남습니다.
       */
      done: {
        say: '스토리가 만들어졌습니다',
        sub: '한 씨앗에서 갈 수 있는 길 셋입니다. 분기마다 비트와 「이 분기의 결과」가 붙고, '
          + '아래 역기입 미리보기가 이 이야기를 판에 붙일 때 그래프가 어떻게 자라는지 미리 셉니다. '
          + '하나를 골라 [이 분기로 대본 생성] 을 누르면 개요 → 컷 → 대본으로 이어집니다',
        see: ['tabs', '#storyPanel'],
        got: () => {
          const n = stories().get('0')?.branches?.length || 0
          return n ? `분기 ${n}개 · 비트와 역기입까지` : '스토리 탭에 들어왔습니다'
        },
        note: {
          head: '고르는 일은 사람이 합니다',
          body: '모델은 길을 *셋 내놓기만* 합니다. 어느 길로 갈지, 무엇을 판에 붙일지는 기획자가 '
            + '고릅니다. 붙이기 전에 역기입을 미리 보여 주는 것이 그래서입니다.',
        },
      },
    },
    /*
     * 자유 입력을 짚습니다. 탐지기가 찾아 준 씨앗만으로 도는 화면으로 읽히면 기획자가
     * 「내 생각을 넣을 자리」를 못 찾습니다. 이 칸이 그 자리입니다. 예시는 방향 한 줄을
     * 넣어 보이는 것까지만 하고 생성은 하지 않습니다(그것이 모델을 부르는 자리입니다).
     */
    {
      say: '기획자가 방향을 직접 줄 수도 있습니다',
      sub: '탐지기가 제안한 분기가 마음에 들지 않을 때 이 칸에 원하는 방향을 적습니다. 씨앗을 고르지 않아도 됩니다',
      spot: 'free', see: 'tabs',
      tag: '이 칸을 누르십시오', do: '표시된 칸을 눌러 예시 방향을 넣습니다',
      run: () => {
        const box = $('freeIn')
        if (!box) return
        box.value = '미라가 먼저 비밀을 알아내고, 루미를 감싸는 쪽으로.'
        box.scrollIntoView({ block: 'nearest' })
      },
    },
    /*
     * 끝은 말풍선의 버튼 하나로 냅니다. 예전에는 「지나간 일」을 짚고 그것을 누르게 했는데,
     * 짚어 준 자리를 누르는 것과 예시를 끝내는 것이 같은 동작이 되어 무엇이 끝나는지가
     * 흐렸습니다. 나가는 일은 나가는 버튼으로 합니다. 지나간 일은 see 로 열어 둡니다. * 예시가 남긴 기록이 어디에 쌓이는지는 보여 주고 싶습니다.
     */
    {
      say: demoActive() ? '스토리 디벨롭을 다 보셨습니다' : '여기까지가 예시입니다',
      sub: demoActive()
        ? demoSay('develop')
        : '분기를 골라 [이 분기로 대본 생성] 을 누르면 개요 → 컷 → 대본으로 이어집니다. 이제 직접 해 보세요',
      see: 'histbox',
      go: demoActive() ? '다음 메뉴 예시로 넘어가기' : '예시 마치기',
      leaves: demoActive(),
    },
  ]

  guideExample({
    steps, title: demoTitle('develop', '스토리 디벨롭'),
    onDone: () => {
      playing(false)
      afterDone()
      // 예시 프로젝트를 밟고 있으면 다음 화면(키비주얼)으로 넘어간다 (tour.js)
      if (demoAdvance('develop')) return
      openCoach()
    },
  })
}
