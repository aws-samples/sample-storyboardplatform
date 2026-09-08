
// 씨앗 카드에 찍히는 말.
//
// 탐지기(graph-probes.js)는 그래프에서 무엇을 찾았는지만 안다. 그것을 작가·PD 가 읽는
// 문장으로 옮기는 것은 이 파일이 한다. 두 가지를 갈라 둔 이유는 카드에 나오던 말이
// 그래프의 말이었기 때문이다: "t=0. 이 사건에서 나가는 결과 엣지가 하나도 없다".
// 무엇을 찾았는지는 맞지만 그것으로 이야기를 쓸 수는 없다.
//
// 규칙 셋.
//   1. 그래프 용어를 쓰지 않는다. 엣지·노드·t=0·props·영문 술어는 여기서 끝난다.
//   2. 숫자는 혼자 두지 않는다. 0.7 이 아니라 "긴장도 0.7" 이다 (tensionKo).
//   3. 한 문장 뒤에 "— 그래서 이것이 이야기다" 를 붙인다. 결함만 알려 주면 카드가
//      고장 목록처럼 읽히고, 다음에 무엇을 쓸지가 카드에 없다.
//
// 조사는 앞말의 받침에 따라 갈린다. 이름이 무엇이 올지 모르니 전부 josa 로 고른다.

import { josa } from '../lib/josa.js'
import { edgeToKo, tensionKo } from './graph-ko.js'

/** 여러 이름을 한 덩어리로 받았을 때도 조사가 맞게 붙는다 (namesOf 가 · 로 이어 준다) */
const eun = (w) => josa(w, '은', '는')
const i = (w) => josa(w, '이', '가')
const eul = (w) => josa(w, '을', '를')
const gwa = (w) => josa(w, '과', '와')

/** 감춰진 내용을 뒤에 인용한다. 없으면 아무것도 붙이지 않는다 */
const claimTail = (claim) => (claim ? ` 감춰진 내용: "${claim}"` : '')

/**
 * 탐지기별 씨앗 문구. 키는 PROBES 의 키와 같다.
 * 각 값은 title·desc 를 만드는 함수 묶음이고, 인자는 이름이 이미 풀린 값들이다
 * (탐지기가 노드 id 로 들고 있던 것을 nameOf 로 바꿔서 넘긴다).
 */
export const SEED_TEXT = {
  // 1. 아는 쪽과 모르는 쪽이 갈린 비밀
  secret_leverage: {
    title: ({ secret, know, dark }) => (dark
      ? `${dark}만 모르는 것: ${secret}`
      : `${know}${i(know)} 쥐고 있는 것: ${secret}`),
    desc: ({ know, dark, hold, claim }) => (dark
      ? `${know}${eun(know)} 알고 있지만 ${dark}${eun(dark)} 모릅니다`
        + ` — 이 정보 비대칭이 극적 긴장을 만듭니다.${claimTail(claim)}`
      : `${know}${eun(know)} ${hold}${i(hold)} 감춘 것을 이미 알고 있습니다`
        + ` — 언제 꺼내느냐가 곧 칼자루입니다.${claimTail(claim)}`),
  },

  // 2. 한 사람을 두고 마음이 겹치는 삼각. 겹치는 모양이 셋이라 desc 도 셋이다
  love_triangle: {
    title: ({ axis, a, b }) => `${axis}${eul(axis)} 축으로 한 삼각: ${a} · ${b}`,
    shared: ({ axis, a, b }) =>
      `${a}${gwa(a)} ${b}${i(b)} 모두 ${axis}에게 마음을 두고 있습니다 — 감정의 충돌을 피할 수 없습니다.`,
    chain: ({ a, axis, b }) =>
      `${a}${eun(a)} ${axis}${eul(axis)}, ${axis}${eun(axis)} ${b}${eul(b)} 바라봅니다`
      + ' — 마음이 한 방향으로만 흘러 아무도 마주 보지 못합니다.',
    rivalry: ({ axis, a, b }) =>
      `${a}${gwa(a)} ${b}${i(b)} ${axis}${eul(axis)} 두고 맞섭니다`
      + ' — 한쪽은 연정이고 한쪽은 소유라서 같은 자리에 설 수 없습니다.',
  },

  // 3. 긴장은 센데 함께 겪은 사건이 없는 관계
  unresolved_tension: {
    title: ({ a, b }) => `해소되지 않은 긴장: ${a} ↔ ${b}`,
    desc: ({ edge, tension }) => `${edgeToKo(edge)}${tensionKo(tension)}.`
      + ' 두 사람이 함께 겪은 사건이 아직 없습니다 — 화해도 충돌도 없이 긴장만 방치돼 있습니다.',
  },

  // 4. 등장했지만 아무 일도 일으키지 않은 사물
  chekhov_object: {
    title: ({ object }) => `회수되지 않은 사물: ${object}`,
    desc: ({ holders }) => (holders
      ? `${holders}${gwa(holders)} 얽혀 있지만 이 물건이 일으킨 사건이 아직 없습니다`
        + ' — 언젠가는 발사돼야 하는 총입니다.'
      : '아직 아무와도 얽히지 않은 채 놓여만 있습니다 — 누구의 손에 들어가느냐가 사건이 됩니다.'),
  },

  // 5. 같은 사건에 있었는데 서로 아무 관계가 없는 둘
  strangers_shared_past: {
    title: ({ a, b }) => `같은 자리에 있었지만 남인 둘: ${a} · ${b}`,
    desc: ({ a, b, event }) => `${a}${gwa(a)} ${b}${eun(b)} ${event} 자리에 함께 있었지만`
      + ' 서로 아무 관계도 없습니다 — 한쪽이 먼저 알아보는 순간이 사건이 됩니다.',
  },

  // 6. 끊어진 채 남아 있는 사제 관계
  severed_bond: {
    title: ({ a, b }) => `끊어진 사제: ${a} → ${b}`,
    desc: ({ edge, backlash, broken, tension }) => {
      const why = broken ? '이미 끊어진 관계로 기록돼 있습니다'
        : backlash ? `그러면서 ${edgeToKo(backlash)}`
          : `그런데 두 사람 사이의 긴장도가 ${tension} 까지 올라 있습니다`
      return `${edgeToKo(edge)}. ${why} — 화해도 결별도 아직 이야기로 기록되지 않았습니다.`
    },
  },

  // 7. 값이 치러지지 않은 사건. 지난 사건이면 몇 해째인지 제목에 적는다
  dangling_consequence: {
    title: ({ event, t }) => (t < 0
      ? `${-t}년째 값이 치러지지 않은 사건: ${event}`
      : `아직 결과가 남지 않은 사건: ${event}`),
    desc: ({ event, cast }) => `${event} 사건 이후 아무런 후속 전개가 없습니다 — `
      + (cast
        ? `${cast}${i(cast)} 치른 값을 다룰 새 이야기가 필요합니다.`
        : '이 사건의 결과를 다룰 새 이야기가 필요합니다.'),
  },

  // 8. 여러 사람이 같은 것을 원한다
  contested_goal: {
    title: ({ n, want }) => `같은 것을 원하는 ${n}명: ${want}`,
    desc: ({ who, want }) => `${who}${i(who)} 모두 ${want}${eul(want)} 원합니다`
      + ' — 하나뿐이라면 나머지는 잃습니다.',
  },

  // 9. 섬기는 주인의 적과 이미 얽혀 있는 내부자
  betrayal_potential: {
    title: ({ member }) => `안에서 갈라지는 충성: ${member}`,
    desc: ({ member, lord, foe, bond }) => `${member}${eun(member)} ${lord}${eul(lord)} 섬기면서,`
      + ` 그 적인 ${foe}${gwa(foe)}도 이미 얽혀 있습니다 (${bond})`
      + ' — 어느 쪽을 택해도 배신이 됩니다.',
  },

  // 10. 서로 적인 곳에 동시에 속했거나, 자기에 관한 비밀을 자기가 감춘다
  identity_crisis: {
    bothTitle: ({ who }) => `두 곳에 동시에 속한 인물: ${who}`,
    both: ({ who, a, b }) => `${a}${gwa(a)} ${b}${eun(b)} 서로 적인데`
      + ` ${who}${eun(who)} 양쪽 모두에 이름이 올라 있습니다 — 언젠가 한쪽을 배신해야 합니다.`,
    selfTitle: ({ who }) => `자기를 숨기는 인물: ${who}`,
    self: ({ who, claim }) => `${who}${eun(who)} 자기에 관한 것을 스스로 감추고 있습니다`
      + ` — 들키는 순간 지금의 자리를 잃습니다.${claimTail(claim)}`,
  },

  // 11. 사랑해선 안 될 상대. 소속이 적이거나, 매인 쪽이 상대와 적이다
  forbidden_bond: {
    title: ({ a, b }) => `사랑해선 안 될 상대: ${a} → ${b}`,
    factions: ({ edge, a, b }) => `${edgeToKo(edge)}. 그런데 ${a}${gwa(a)} ${b}${i(b)} 서로 적입니다`
      + ' — 마음을 지키려면 소속을 버려야 합니다.',
    keeper: ({ lover, keeper, mate }) => `${lover}${i(lover)} 매여 있는 ${keeper}${gwa(keeper)}`
      + ` ${mate}${eun(mate)} 서로 적입니다 — 계약과 마음이 함께 설 수 없습니다.`,
  },

  // 12. 이끄는 자리가 흔들리거나 아예 비어 있다
  power_vacuum: {
    shakenTitle: ({ leader }) => `이끄는 자가 흔들린다: ${leader}`,
    shaken: ({ leader, event, tension, led }) => `${leader}${i(leader)} ${event} 사건에`
      + ` 긴장도 ${tension} 로 얽혀 있습니다.`
      + ` ${led}${eul(led)} 이끌 자리가 비게 됩니다 — 누가 그 자리를 채울까요?`,
    headlessTitle: ({ faction }) => `이끄는 사람이 없는 집단: ${faction}`,
    headless: ({ members }) => `${members}${i(members)} 속해 있지만 이끄는 사람이 정해져 있지 않습니다`
      + ' — 빈 자리를 누가 채우느냐가 다음 갈등입니다.',
  },
}
