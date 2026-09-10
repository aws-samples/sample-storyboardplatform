/*
 * 스토리보드 화면의 예시 안내.
 *
 * app/pages/board.js 에 같이 있던 것을 여기로 옮겼습니다. 그 파일이 3,400줄이라
 * 예시 100줄이 섞여 있으면 어디까지가 제품인지 눈으로 갈라지지 않았습니다.
 *
 * 예시 데이터를 만드는 seedBuild 는 화면에 남겨 두었습니다. 관리 화면의 「보드 비우기」가
 * 판을 처음 상태로 되돌릴 때 같은 것을 씁니다. 예시만 쓰는 것이 아니라 제품도 씁니다.
 *
 * 이 폴더는 app/ 을 import 할 수 없습니다(../tour.js 의 머리글). 그래서 화면이 쓸
 * 것을 넣어 줍니다. boardExample 의 인자가 그것입니다.
 */

import { guide as guideExample } from '../guide.js'
import { demoActive, demoAdvance, demoSay, demoTitle } from '../tour.js'

/*
 * 화면이 넣어 주는 것. 전부 app/pages/board.js 의 것입니다.
 *   seedBuild  예시 op 한 벌과 「여기서부터 무엇을 하는 중인지」 표시(marks)
 *   push       op 하나를 판에 넣기. 사람이 손으로 할 때와 같은 길입니다
 *   render     다시 그리기
 *   pickView   고른 것이 없을 때 하나 고르기
 *   showCuts   컷 보드로 돌려놓고 첫 컷을 고르기. 예시를 마칠 때 씁니다
 *   cuts       () => 지금 판의 컷 수. done 의 got 이 셉니다
 *   selected   () => 고른 컷의 id. 예시가 도는 사이에 바뀝니다
 *   afterDone  예시가 끝났습니다. 화면이 다시 그립니다
 *
 * 예전에는 afterDone 뒤에 openCoach 를 하나 더 받아 코치마크를 이어 열었습니다.
 * 예시가 이미 화면을 다 짚은 뒤라 「여기까지가 예시입니다」 를 읽고 끝났다고 생각한
 * 사람에게 막이 한 번 더 덮였습니다. 예시 하나로 충분해서 그 자리를 없앴습니다.
 */
let seedBuild, push, render, pickView, showCuts, cuts, selected, afterDone

/** 예시를 시작합니다. 화면의 「예시 보기」와 코치마크가 부릅니다 */
export function boardExample(o) {
  ;({ seedBuild, push, render, pickView, showCuts, cuts, selected, afterDone } = o)
  return runExample()
}

let exampleRun = null

/*
 * 단계마다 짚을 자리. seedBuild 의 표시(marks)와 같은 순서입니다.
 *
 * 여기 적힌 자리는 모두 board.html 에 처음부터 있는 것들입니다. render() 가 다시 그려도
 * 사라지지 않아야 테가 남습니다. 자리를 못 찾으면 길잡이가 테 없이 넘어갑니다.
 *
 * 첫 걸음과 셋째 걸음은 시나리오 칸(#scenario)과 「컷으로 분해」(#breakdown)를 짚었고,
 * 그 다음에는 둘을 담고 있던 「시나리오를 컷으로」 단추(cuts)를 짚었습니다. 그 칸과 두
 * 단추가 다 화면에서 나갔습니다 — 이야기를 컷으로 나누는 일은 위 탭 바의 스토리 디벨롭이
 * 합니다(app/domain/routes.js 의 NAV_TABS).
 *
 * 그래서 두 걸음 다 스토리보드 칸(side-board)을 짚습니다. 이야기가 여기로 넘어와 컷으로
 * 서는 것을 말하는 걸음들이고, 그 컷 목록이 실제로 그 칸에 쌓입니다. 왼쪽 기둥의 칸이라
 * board.html 에 처음부터 있어서 판이 비어도 테가 남습니다.
 */
const EXAMPLE_SPOTS = ['side-board', '#newChar', 'side-board', 'board']

/*
 * 그 걸음을 마친 뒤 화면을 어디에 두는지.
 *
 * 걸음의 run 은 자기가 짚은 자리를 누른 뒤에 돕니다. 그래서 다음 걸음이 짚을 자리를
 * 세워 두는 일은 앞 걸음의 몫입니다(길잡이에 「그리기 전에 준비하는」 자리가 없습니다).
 *
 * 인물 걸음이 끝나면 컷 보드로 돌려놓습니다. 그 걸음의 run 이 pickView 를 지나면서 첫
 * 인물의 판으로 넘어갑니다(board.js 의 pickView 는 아무것도 안 골려 있으면 첫 인물을
 * 고릅니다).
 *
 * 화면이 어긋나는 것이 문제입니다. 셋째 걸음은 3초를 기다린 뒤 「컷 N개가
 * 만들어졌습니다」를 보드에 구멍을 뚫어 보여 줍니다(EXAMPLE_WAITS 의 done). 그 보드가
 * 인물 구도 판이면 컷은 한 장도 없는 화면을 가리키며 컷 수를 세는 셈입니다.
 *
 * 대신 잃는 것이 있습니다. 인물 걸음이 만든 구도 여섯 벌을 그 자리에서 보지 못합니다.
 * 왼쪽 기둥에 인물 이름이 서는 것으로 갈음합니다. 그리고 빈 컷 보드에서 셋째 걸음을
 * 누르는 편이 컷이 서는 것을 더 또렷하게 보여 줍니다 — 구도가 깔린 판이 컷으로 바뀌는
 * 것은 「나뉘었다」보다 「딴 판으로 갔다」로 읽힙니다.
 */
const EXAMPLE_AFTER = {
  1: () => showCuts(),
}

/*
 * 그 단계에서 기다릴 초와, 기다려서 나온 것을 보여 줄 걸음. 모델을 부르는 자리에만
 * 답니다. 이야기를 컷으로 나누는 걸음이 그렇습니다. 예시는 미리 만들어 둔 op 를 밀어 넣으므로
 * 실제로는 즉시 끝나지만, 그렇게 보여 주면 직접 할 때의 기다림을 고장으로 읽게 됩니다.
 * 그리고 기다린 것을 보지 못한 채 다음 설명으로 넘어가면 그 3초가 헛것이 됩니다
 * (guide.js 머리글의 wait 와 done).
 */
const EXAMPLE_WAITS = {
  2: {
    wait: 3000,
    waitSay: '컷을 받아 오고 있습니다',
    done: {
      say: '컷이 만들어졌습니다',
      sub: '컷은 씬으로 묶이고 순서대로 시간이 매겨집니다. 컷을 눌러 '
        + '오른쪽에서 대사와 지시를 고칩니다',
      see: 'board',
      // 인물 구도도 같은 panels 에 삽니다(charId 가 붙습니다). 컷만 셉니다
      got: () => `컷 ${cuts()}개`,
      /*
       * 이 화면의 값은 모델이 아니라 판 자체입니다. 컷이 서는 것을 본 자리에서 한 번
       * 적어 둡니다. 앞의 두 화면에서 「무엇을 맡기고 무엇을 직접 드는지」를 말했으니
       * 여기서는 「만든 것이 어디에 쌓이는지」를 말합니다(guide.js 의 note).
       */
      note: {
        head: '고친 것이 아니라 고친 일이 쌓입니다',
        body: '판의 유일한 사실은 *편집 기록 한 줄씩*입니다. 그래서 두 사람이 같은 보드를 열어도 '
          + '서로의 손이 덮이지 않고, 누가 무엇을 언제 했는지가 남습니다.',
      },
    },
  },
}

/**
 * 예시를 클릭에 맞춰 안내합니다. op 를 한 번에 밀어 넣지 않고 seedBuild 의 표시(marks)
 * 단위로 나눠 넣어, 시나리오 → 인물 → 컷 → 리뷰 순서를 사람이 한 번씩 눌러 보게 합니다.
 *
 * 부르는 곳이 세 군데(빈 화면의 버튼·코치마크·직접)라 눌린 자리의 원래 동작은 길잡이가
 * 막습니다. 예를 들어 「+ 인물 추가」를 짚었을 때 눌러도 빈 인물이 생기는 게 아니라 아래
 * run 이 돕니다. 예시가 실제 판을 엉뚱하게 건드리지 않게 하려는 것입니다.
 */
function runExample() {
  if (exampleRun) return
  const { ops, marks } = seedBuild()
  // 표시 사이의 구간마다 그만큼의 op 를 밀어 넣는다. 마지막 구간은 끝까지다
  const steps = marks.map((m, i) => {
    const from = m.at
    const to = marks[i + 1]?.at ?? ops.length
    return {
      say: m.say, sub: m.sub, spot: EXAMPLE_SPOTS[i], see: 'board',
      ...(EXAMPLE_WAITS[i] || {}),
      run: () => {
        for (const op of ops.slice(from, to)) push(op)
        if (!selected()) { pickView() }
        render()
        // 다음 걸음이 짚을 자리를 세워 둡니다. render 뒤여야 합니다 (EXAMPLE_AFTER)
        EXAMPLE_AFTER[i]?.()
      },
    }
  })
  /*
   * 영상. 예전에는 '영상화'라는 다섯째 화면이었고 거기서 따로 안내했습니다. 이제 승인된
   * 컷의 오른쪽 칸에 있는 일이라 여기서 한 걸음으로 말합니다.
   *
   * 짚는 자리가 없을 수도 있습니다 — 단추는 컷이 승인된 뒤에 열리고, 생성 서버가 없는
   * 배포에는 아예 나오지 않습니다. 그때 길잡이는 테 없이 말만 띄웁니다(guide.js 의
   * showStep). 실제로 누르게 하지는 않습니다. GPU 가 한 컷에 30초~4분을 쓰는데, 기다리는
   * 것을 안내라고 부를 수 없습니다.
   */
  steps.push({
    say: '승인이 끝나면 영상으로',
    // 말풍선의 sub 는 글자 그대로 나옵니다. * 로 굵게 되는 곳은 note.body 뿐입니다
    sub: '컷 하나를 감독이 승인하면 오른쪽 「이 컷 그리기」 옆에 「영상으로 생성」이 열립니다. '
      + '승인된 그림이 첫 프레임이 되고, 움직임은 그 컷의 작업 지시·대사·카메라에서 만들어 '
      + '보냅니다. 나온 영상은 그 컷의 다음 버전으로 붙습니다 — 따로 모아 두는 곳이 없습니다.',
    spot: '[data-do="animate"]',
    see: 'board',
    run: () => showCuts(),
  })
  /*
   * 자산. 승인이 만드는 두 번째 것입니다. 위 탭 바의 「자산관리」를 짚습니다 — 그 탭은
   * 모든 화면에 처음부터 있어서(components/nav-tabs.js) 판이 비어도 테가 남습니다.
   */
  steps.push({
    say: '승인하면 자산이 됩니다',
    sub: '승인된 그림에서 인물·배경·소품을 따로 그려 「자산관리」에 모아 둡니다. 거기서 직접 그린 '
      + '그림을 올리고, 자산 여러 장을 골라 실사 스틸을 만듭니다. 다음 컷을 만들 때는 「참조 자산」으로 '
      + '골라 넣어 같은 얼굴·같은 장소·같은 물건으로 새 구도를 냅니다.',
    spot: '[data-nav="assets"]',
    see: 'board',
    run: () => showCuts(),
  })
  // 끝은 말풍선의 버튼으로 냅니다. 나가는 일과 짚은 자리를 누르는 일을 가릅니다
  steps.push({
    say: demoActive() ? '스토리보드까지 다 보셨습니다' : '여기까지가 예시입니다',
    sub: demoActive()
      ? demoSay('board')
      : '이제 컷을 눌러 오른쪽에서 고치거나, 관리 화면에서 보드를 비우고 직접 시작할 수 있습니다',
    /*
     * 컷 보드를 짚습니다. 「지나간 일」을 짚던 자리입니다.
     *
     * 그것은 왼쪽 기둥 맨 아래에 있어서 짚으려고 끌어오면 기둥이 통째로 굴러갔습니다
     * (guide.js 의 showStep 이 scrollIntoView 를 합니다). 그러면 예시가 끝난 화면에서
     * 「컷 보드」 항목이 스크롤 밖에 있었습니다. 마지막 말이 「이제 컷을 눌러…」인데
     * 짚는 자리가 컷이 아닌 것도 어긋났습니다.
     */
    see: 'board',
    // 보드가 마지막 걸음이라 여기서는 두 갈래가 같은 곳으로 갑니다. 홈으로 돌아갑니다
    go: demoActive() ? '예시를 마치고 홈으로' : '예시 마치기',
    leaves: demoActive(),
    /*
     * pickView 를 부르던 자리입니다. 그것은 sessionStorage 에 아무것도 없으면 첫 인물을
     * 골라서(board.js 의 pickView), 예시가 인물 구도 판에서 끝났습니다. 컷이 화면에
     * 하나도 없는 채로 「이제 컷을 눌러…」를 읽는 셈이었습니다.
     */
    run: () => showCuts(),
  })
  exampleRun = guideExample({
    steps, title: demoTitle('board', '스토리보드'),
    onDone: () => {
      exampleRun = null
      afterDone()
      /*
       * 예시 프로젝트를 밟고 있으면 다음 화면으로 넘어간다. 보드는 마지막 단계라
       * 홈으로 돌아간다(tour.js 의 DEMO_STEPS).
       */
      demoAdvance('board')
    },
  })
}
