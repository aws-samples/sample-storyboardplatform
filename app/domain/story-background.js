/*
 * 스토리의 공통 배경입니다. 순수 규칙만 있어서 DOM 도 네트워크도 없습니다.
 * 물어보는 창은 components/background-ask.js 이고, 저장은 services/assets.js 입니다.
 *
 * ══ 무엇을 고치려고 만들었나
 *
 * 키 비주얼 프롬프트가 씬마다 따로 쓰였습니다(pages/key-visual.js 의 keyVisualPrompt).
 * 모델은 씬 하나의 글만 보고 한 줄을 쓰고, 씬 사이에 공통으로 쥐고 있는 것이 없었습니다.
 * 그래서 같은 인물이 씬마다 다른 사람으로 그려졌습니다. 1번 씬의 소녀는 백인이고 3번
 * 씬의 소녀는 동양인이었습니다. 대본이 「소녀」라고만 적혀 있으면 모델은 매번 새로
 * 고르고, 그 고름은 씬마다 독립이기 때문입니다.
 *
 * 사람이 프롬프트마다 'The girl and her teacher(female) both are Korean.' 을 손으로
 * 붙여서 고쳐 왔습니다. 스무 씬이면 스무 번입니다. 그리고 그 문장은 아무 데도 남지
 * 않아서 다음에 이 프로젝트를 열면 처음부터 다시 붙였습니다.
 *
 * ══ 왜 「모든 컷에 같은 문장」인가
 *
 * 이미지 모델은 프롬프트 하나가 그림 하나입니다. 앞 장에서 무엇을 그렸는지 기억하지
 * 않습니다. 그래서 씬 사이의 일관성은 「모델이 기억하는 것」으로는 못 만들고, 같은
 * 문장을 매 장에 다시 넣는 것으로만 만듭니다. 이 파일이 그 문장 하나를 만듭니다.
 *
 * ══ 왜 사람에게 물어보나
 *
 * 대본에 없기 때문입니다. 국적·나이·머리·옷은 시나리오가 적지 않는 것들입니다. 적을
 * 이유가 없습니다 — 사람이 읽을 글이라 「소녀」면 충분합니다. 그런데 그림에는 반드시
 * 있어야 합니다. 대본에서 뽑을 수 없는 것을 모델에게 추측하게 하면 씬마다 다르게
 * 추측합니다. 그래서 모델이 물음을 만들고 사람이 답합니다. 물음을 모델이 만드는 이유는
 * 무엇을 물어야 하는지가 대본마다 다르기 때문입니다. 인물이 둘인 대본과 군중이 나오는
 * 대본에 같은 물음을 내밀면 반은 빈 칸으로 남습니다.
 */

import { JSON_ONLY } from './prompts.js'

/**
 * 물음 하나의 모양입니다.
 *
 *   id     답을 담을 열쇠. 영문 소문자·숫자·밑줄만 씁니다
 *   ask    사람에게 보이는 물음. 한국어입니다
 *   why    이것을 왜 묻는지 한 줄. 답하기 싫은 물음 앞에서 사람이 판단할 재료입니다
 *   hint   답의 예. 빈 칸에 흐리게 섭니다
 *   answer 사람이 넣은 답. 빈 문자열이면 답하지 않은 것입니다
 */

/** 물음은 이만큼까지만 받습니다. 더 오면 앞에서 자릅니다 */
export const MAX_QUESTIONS = 6
/** 한 답의 길이 상한. 배경은 프롬프트 앞에 매 장 들어가므로 짧아야 합니다 */
export const MAX_ANSWER = 120
/** 배경 문장 전체의 상한. 이 길이가 씬마다 프롬프트에 더해집니다 */
export const MAX_BACKGROUND = 600

/*
 * 모델이 물음을 못 만들었을 때 세우는 물음입니다.
 *
 * 로컬 모드(net 이 없음)와 권한이 막힌 자리(아티스트·리뷰어는 plan 을 못 부릅니다)에서
 * 씁니다. 물음을 만드는 것이 모델의 일이지만, 모델이 없다고 배경 자체를 못 넣게 하면
 * 로컬에서는 이 기능이 아예 없는 것이 됩니다. 그래서 어느 대본에나 필요한 것 넷만
 * 남겨 두었습니다. 국적·시대·화풍·나이는 대본이 거의 적지 않으면서 그림에는 반드시
 * 있어야 하는 것들입니다.
 */
export const FALLBACK_QUESTIONS = [
  {
    id: 'nationality',
    ask: '인물들의 국적이나 인종은 어떻게 됩니까?',
    why: '대본에 없으면 모델이 씬마다 다르게 고릅니다. 같은 인물이 다른 사람으로 그려지는 가장 큰 까닭입니다.',
    hint: '한국인. 소녀와 선생님 모두',
  },
  {
    id: 'era',
    ask: '언제, 어디의 이야기입니까?',
    why: '옷과 건물과 소품이 여기서 갈립니다.',
    hint: '2020년대 한국의 지방 소도시',
  },
  {
    id: 'ages',
    ask: '주요 인물들의 나이는 대략 어떻게 됩니까?',
    why: '「소녀」가 8살인지 17살인지에 따라 그림이 완전히 달라집니다.',
    hint: '소녀 11살, 선생님 30대 중반 여성',
  },
  {
    id: 'look',
    ask: '전체적으로 어떤 화면을 원하십니까?',
    why: '씬마다 다른 분위기로 그려지지 않게 잡아 둡니다.',
    hint: '따뜻한 자연광, 차분한 색, 다큐멘터리 같은 느낌',
  },
]

/**
 * 대본을 보고 물음을 만들라는 프롬프트입니다.
 *
 * 씬의 글을 조금씩만 넣습니다. 물음을 만드는 데에 필요한 것은 「누가 나오고 어디인가」
 * 까지이고, 대본 전문을 넣으면 토큰만 쓰면서 물음은 같아집니다.
 *
 * @param {Array} scenes - { id, place, time, cast[], text } 의 배열
 * @returns {string}
 */
export function questionsPrompt(scenes) {
  const list = Array.isArray(scenes) ? scenes : []
  const cast = [...new Set(list.flatMap((s) => (Array.isArray(s?.cast) ? s.cast : [])))].slice(0, 12)
  const lines = list.slice(0, 12).map((s) =>
    `${s?.id || '?'} | ${s?.place || '장소 미정'}${s?.time ? ' · ' + s.time : ''}`
    + `\n${String(s?.text || '').replace(/\s+/g, ' ').slice(0, 200)}`)

  return [
    '아래는 한 대본을 씬으로 나눈 것이다. 이 대본으로 씬마다 이미지를 생성하려고 한다.',
    '',
    '이미지 모델은 프롬프트 한 개가 그림 한 장이고 앞 장을 기억하지 않는다. 그래서 대본에',
    '적혀 있지 않은 것(국적·나이·옷·시대·화풍 같은 것)은 씬마다 다르게 그려진다. 그것을',
    '막으려면 모든 씬에 공통으로 넣을 배경 설명이 필요하고, 그 재료를 사람에게 물어야 한다.',
    '',
    '이 대본에 필요한 물음을 만든다. 대본을 읽고, 그림을 그리려면 알아야 하는데 대본에는',
    '없는 것만 묻는다.',
    '',
    cast.length ? `대본에 이름이 나온 사람: ${cast.join(', ')}` : '(등장인물 줄이 없다)',
    '',
    ...lines,
    '',
    JSON_ONLY,
    '{"questions":[{"id":"nationality","ask":"물음","why":"이것을 왜 묻는지 한 줄","hint":"답의 예"}]}',
    '',
    '규칙',
    `- questions 는 3개에서 ${MAX_QUESTIONS}개. 적을수록 좋다. 사람이 답해야 하는 것들이다.`,
    '- id 는 영문 소문자·숫자·밑줄만. 무엇에 대한 물음인지 알 수 있게 짓는다.',
    '- ask · why · hint 는 한국어로 쓴다.',
    '- 대본에 이미 있는 것은 묻지 않는다. 장소와 시간대는 씬 머리글에 있으므로 묻지 않는다.',
    '- 줄거리나 결말을 묻지 않는다. 그림에 보이는 것만 묻는다.',
    '- hint 는 그 자리에 들어갈 만한 답을 실제로 하나 써 준다. 「예: ...」 같은 머리말은 붙이지 않는다.',
    '- 이 대본에 인물이 한 명뿐이면 인물에 대한 물음도 한 명 몫만 만든다.',
  ].join('\n')
}

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/**
 * 모델이 준 물음을 씁니다. 형식이 어긋난 것은 사람 앞에 세우기 전에 버립니다.
 *
 * 하나도 못 건지면 빈 배열입니다. 부르는 쪽이 FALLBACK_QUESTIONS 로 내려갑니다.
 * 여기서 폴백을 돌려주지 않는 이유는, 그러면 부르는 쪽이 「모델이 만든 물음」과
 * 「우리가 준비한 물음」을 구분할 수 없어서 사람에게 어느 쪽인지 말해 줄 수 없습니다.
 *
 * @param {*} raw - 모델 응답을 JSON.parse 한 것
 * @returns {Array} 물음들. 못 건지면 빈 배열
 */
export function normalizeQuestions(raw) {
  const list = Array.isArray(raw?.questions) ? raw.questions : []
  const out = []
  const seen = new Set()
  for (const q of list) {
    // id 는 저장할 때 열쇠가 됩니다. 이상한 글자가 섞이면 그 자리에서 걸러 둡니다
    const id = clip(q?.id, 24).toLowerCase().replace(/[^a-z0-9_]/g, '')
    const ask = clip(q?.ask, 140)
    if (!id || !ask || seen.has(id)) continue
    seen.add(id)
    out.push({ id, ask, why: clip(q?.why, 160), hint: clip(q?.hint, 80), answer: '' })
    if (out.length >= MAX_QUESTIONS) break
  }
  return out
}

/**
 * 사람이 답한 것만 남깁니다. 빈 칸은 「모르겠다」가 아니라 「이건 안 정한다」입니다.
 *
 * 빈 칸을 배경에 넣지 않는 것이 중요합니다. 「국적: (없음)」 같은 줄이 프롬프트에 들어가면
 * 모델은 그것도 지시로 읽습니다. 사람이 안 정한 것은 모델이 자유롭게 고르는 편이 낫습니다.
 *
 * @param {Array} questions - answer 가 채워진 물음들
 * @returns {Array<{id: string, ask: string, answer: string}>}
 */
export function answered(questions) {
  return (Array.isArray(questions) ? questions : [])
    .map((q) => ({ id: clip(q?.id, 24), ask: clip(q?.ask, 140), answer: clip(q?.answer, MAX_ANSWER) }))
    .filter((q) => q.id && q.answer)
}

/**
 * 저장하고 프롬프트에 넣을 배경 하나를 만듭니다.
 *
 * text 가 이 판의 본체입니다. 그것이 씬마다 프롬프트 앞에 들어갑니다. qa 를 같이 두는
 * 이유는 나중에 이 배경을 고칠 때 무엇을 물어서 나온 답인지 보여주기 위해서입니다.
 * text 만 남겨 두면 고치는 화면이 긴 한 덩이 글만 내밀게 됩니다.
 *
 * @param {Array} questions - answer 가 채워진 물음들
 * @param {object} [o]
 * @param {string} [o.note] - 사람이 직접 덧붙인 줄. 물음에 없던 것을 적는 자리입니다
 * @returns {{text: string, qa: Array, note: string}|null} 답이 하나도 없으면 null
 */
export function buildBackground(questions, { note = '' } = {}) {
  const qa = answered(questions)
  const extra = clip(note, MAX_ANSWER * 2)
  if (!qa.length && !extra) return null
  /*
   * 한 줄로 잇습니다. 이미지 모델의 프롬프트는 쉼표로 이은 한 덩이라서, 줄바꿈이나
   * 「국적:」 같은 이름표를 넣으면 모델이 그 이름표까지 그림의 요소로 읽습니다.
   * 실제로 프롬프트에 라벨을 넣으면 그 글자가 그림에 나타나는 일이 있습니다.
   */
  const text = clip([...qa.map((q) => q.answer), extra].filter(Boolean).join('. '), MAX_BACKGROUND)
  return { text, qa, note: extra }
}

/**
 * 저장소에서 읽은 배경이 쓸 만한지 봅니다. 아니면 null 입니다.
 *
 * 저장된 것을 그대로 믿지 않습니다. 이 판은 사람이 지울 수 있고 옛 모양으로 남아 있을
 * 수도 있습니다. 모양이 어긋난 것을 프롬프트에 넣으면 'undefined' 가 그림 지시로
 * 들어갑니다. 그것이 조용히 스무 장에 붙는 것이 가장 나쁩니다.
 *
 * @param {*} body - loadAsset(board, 'background') 가 준 것
 * @returns {{text: string, qa: Array, note: string}|null}
 */
export function readBackground(body) {
  const text = clip(body?.text, MAX_BACKGROUND)
  if (!text) return null
  const qa = (Array.isArray(body?.qa) ? body.qa : [])
    .map((q) => ({ id: clip(q?.id, 24), ask: clip(q?.ask, 140), answer: clip(q?.answer, MAX_ANSWER) }))
    .filter((q) => q.answer)
  return { text, qa, note: clip(body?.note, MAX_ANSWER * 2) }
}

/**
 * 서랍에 적히는 한 줄입니다. domain/assets.js 의 SUM 이 씁니다.
 *
 * @param {*} body
 * @returns {string|null}
 */
export function summarizeBackground(body) {
  const bg = readBackground(body)
  if (!bg) return null
  const n = bg.qa.length
  return `${n ? `답 ${n}개 · ` : ''}${bg.text.slice(0, 40)}${bg.text.length > 40 ? '…' : ''}`
}

/**
 * 배경을 프롬프트에 넣을 영어 지시로 바꿉니다.
 *
 * 사람은 한국어로 답합니다. 프롬프트는 영어입니다(keyVisualPrompt 의 규칙). 그 사이를
 * 여기서 잇지 않습니다 — 번역은 모델이 합니다. 이 함수는 「이 배경을 모든 프롬프트에
 * 넣어라」는 지시만 만들고, 배경 자체는 사람이 쓴 그대로 넘깁니다. 여기서 우리가 어설프게
 * 영어로 옮기면 사람이 쓴 뜻이 한 번 더 흐려지고, 그 흐려진 것이 매 장에 들어갑니다.
 *
 * @param {{text: string}|null} bg
 * @returns {string[]} 프롬프트에 끼울 줄들. 배경이 없으면 빈 배열
 */
export function backgroundLines(bg) {
  const text = clip(bg?.text, MAX_BACKGROUND)
  if (!text) return []
  return [
    '',
    '══ 이 이야기의 공통 배경 ══',
    text,
    '',
    '이 배경은 모든 씬에 공통이다. 씬마다 쓰는 prompt 안에 이 배경을 영어로 옮겨 반드시',
    '넣는다. 인물의 국적·나이·모습은 씬이 달라도 같아야 한다. 배경과 대본이 어긋나면',
    '배경을 따른다 — 사람이 직접 정한 것이다.',
  ]
}
