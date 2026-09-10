
// 씨앗 카드의 제목과 순서를 모델이 준 답으로 다듬는다.
//
// 탐지기(graph-probes.js)가 찾은 것을 사람의 말로 옮기는 곳이 seed-text.js 이고, 거기의
// 제목은 탐지기마다 한 벌이다. 같은 탐지기가 씨앗 셋을 찾으면 카드 셋의 제목이 같은
// 틀로 찍혀서, 목록에서는 무엇이 무엇인지 가릴 수 없었다. 순서도 마찬가지였다 —
// PROBES 의 weight 는 손으로 적어 둔 수라서 "이 소재가 왜 위에 있는가" 에 답하지 못한다.
//
// 그래서 제목과 순서만 모델에게 한 번씩 묻는다(prompts.js 의 seedTitlesPrompt ·
// seedRankPrompt, 부르는 곳은 services/planner.js 의 refineSeeds). 여기 있는 것은
// 그 답을 받아 쓸 수 있는 것만 남기는 순수 함수다. 탐지 자체와 수학 스코어는 그대로 둔다.
//
// 규칙 둘.
//   1. 못 쓰는 답은 버리고 탐지기가 만든 제목·점수 순서를 그대로 둔다. 하나가 이상해도
//      나머지는 살린다. 모델이 아예 답하지 못하면 화면은 전과 똑같이 돈다.
//   2. 기술 용어가 섞인 글은 못 쓰는 답이다. 이 글은 작가·PD 가 카드에서 그대로 읽는다.
//      프롬프트에서 한 번 막고(NO_JARGON) 온 뒤에 여기서 한 번 더 걸러낸다.

import { GRAPH_SCHEMA } from './graph-schema.js'
import { asList } from '../lib/guards.js'

/** 모델에게 순서를 물을 씨앗 개수. 앞의 이만큼만 묻고 나머지는 점수 순서를 그대로 둔다 */
export const RANK_MAX = 10
/**
 * 제목을 지어 달라고 물을 씨앗 개수. 목록에 처음 깔리는 카드는 열두 장이라(SEEDS_SHOWN)
 * 그보다 넉넉하게 두고 자른다. 사십 개를 다 물으면 프롬프트 본문이 상한에 걸려 뒤쪽이
 * 조용히 잘리고, 잘린 자리의 제목은 어차피 오지 않는다.
 */
export const TITLE_ASK_MAX = 16
/** 받아 쓰는 제목의 길이 상한. 프롬프트는 10자를 부탁하고, 조금 넘는 것까지는 그냥 쓴다 */
export const TITLE_MAX = 30
/** 순위 이유 한 줄의 길이 상한. 넘치면 뒤를 자른다 */
const WHY_MAX = 60

/** 카드에 새면 안 되는 한국어. 작가가 읽는 자리에 데이터 이야기가 나오면 안 된다 */
const KO_JARGON = ['노드', '엣지', '그래프', '술어', '역기입', '프로퍼티', '스키마', '파싱', '쿼리']

/**
 * 라틴 문자로 새는 말. 관계 어휘 전체(loves · mentor_of …)와 코드 냄새가 나는 이름들이다.
 * 어휘를 손으로 베끼지 않고 GRAPH_SCHEMA 에서 가져온다. 술어가 늘면 여기도 같이 는다.
 */
const EN_JARGON = [...new Set([
  ...GRAPH_SCHEMA.edgeRels,
  'id', 'ids', 'props', 'tension', 'kind', 'probe', 'seed', 'seeds', 'writeback',
  'json', 'node', 'edge', 'graph', 'score', 'focus', 'null', 'undefined',
])]

/** 낱말로 들어 있을 때만 잡는다. 이름 속에 우연히 낀 글자를 걸고넘어지지 않게 한다 */
const EN_RE = new RegExp(`(^|[^A-Za-z_])(${EN_JARGON.join('|')})([^A-Za-z_]|$)`, 'i')
/** t=0 · t = -3 같은 시점 표기 */
const T_RE = /\bt\s*=\s*-?\d/i

/**
 * 작가가 읽을 글에 기술 용어가 섞였나.
 *
 * @param {string} text - 모델이 준 제목이나 한 줄 이유
 * @returns {boolean} 하나라도 섞였으면 true. 그 글은 쓰지 않는다
 */
export function hasJargon(text) {
  const s = String(text ?? '')
  if (!s) return false
  if (T_RE.test(s)) return true
  if (KO_JARGON.some((w) => s.includes(w))) return true
  return EN_RE.test(s)
}

/** 한 줄로 눕히고 앞뒤 장식(번호·따옴표·대괄호)을 걷어낸다 */
const tidy = (v) => String(v ?? '')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/^[-–·•[\]\d.)\s]+/, '')
  .replace(/^["'「『“”]+|["'」』“”]+$/g, '')
  .trim()

/**
 * 받은 제목 하나를 쓸 수 있는 모양으로. 쓸 수 없으면 빈 문자열이고, 그때는
 * 부르는 쪽이 탐지기 제목을 그대로 둔다.
 *
 * @param {string} raw - 모델이 준 제목
 * @returns {string} 다듬은 제목. 못 쓰면 ''
 */
export function cleanSeedTitle(raw) {
  const t = tidy(raw)
  if (t.length < 2 || t.length > TITLE_MAX) return ''
  if (hasJargon(t)) return ''
  return t
}

/** 순위 이유 한 줄. 기술 용어가 섞였으면 버리고, 길면 뒤를 자른다 */
const cleanWhy = (raw) => {
  const s = tidy(raw)
  if (s.length < 2 || hasJargon(s)) return ''
  return s.length > WHY_MAX ? `${s.slice(0, WHY_MAX - 1)}…` : s
}

/** 모델이 목록을 어디에 담아 오든 배열로 꺼낸다 */
const rowsOf = (raw, keys) => {
  if (Array.isArray(raw)) return raw
  for (const k of keys) if (Array.isArray(raw?.[k])) return raw[k]
  return []
}

/** 응답 한 줄이 가리키는 씨앗 번호. n 이 없으면 온 순서로 본다 */
const indexOf = (row, i) => {
  const n = Number(row?.n ?? row?.no ?? row?.index ?? row?.번호)
  return (Number.isFinite(n) ? n : i + 1) - 1
}

/**
 * 모델이 지어 준 제목을 씨앗에 입힌다. 순서는 건드리지 않는다.
 *
 * 못 쓰는 제목(비었거나·너무 길거나·기술 용어가 섞였거나·앞 카드가 이미 쓴 제목)은
 * 버리고 그 씨앗만 탐지기 제목으로 남는다. 탐지기 제목은 baseTitle 에 남겨 둔다.
 *
 * @param {Array<Object>} seeds - findSeeds 가 준 씨앗 배열
 * @param {Object|Array} raw - 모델 응답 (parseJson 을 지난 것)
 * @returns {Array<Object>} 길이와 순서가 그대로인 새 배열
 */
export function applySeedTitles(seeds, raw) {
  const list = asList(seeds)
  const got = new Map()
  rowsOf(raw, ['titles', 'seeds', 'items']).forEach((row, i) => {
    const at = indexOf(row, i)
    const title = cleanSeedTitle(typeof row === 'string' ? row : row?.title)
    if (!title || at < 0 || at >= list.length || got.has(at)) return
    got.set(at, title)
  })
  // 이미 쓴 제목은 두 번 쓰지 않는다. 겹치는 제목을 없애려고 물어본 것이다
  const used = new Set(list.map((s) => s?.title).filter(Boolean))
  return list.map((s, i) => {
    const t = got.get(i)
    if (!t || used.has(t)) return s
    used.add(t)
    return { ...s, title: t, baseTitle: s?.title }
  })
}

/**
 * 모델이 준 순위로 앞쪽 씨앗을 다시 세운다. 뒤쪽(순위를 묻지 않은 것)은 점수 순서 그대로다.
 *
 * 쓸 수 있는 줄이 둘도 안 되면 아무것도 바꾸지 않는다. 한 줄만 온 답으로 목록을
 * 흔들면 점수 순서도 모델 순서도 아닌 것이 된다.
 *
 * @param {Array<Object>} seeds - 점수 내림차순으로 정렬된 씨앗 배열
 * @param {Object|Array} raw - 모델 응답 (parseJson 을 지난 것)
 * @param {Object} [opts]
 * @param {number} [opts.max=RANK_MAX] 앞에서 몇 개까지 다시 세울지
 * @returns {Array<Object>} 다시 세운 배열. 길이는 그대로다
 */
export function applySeedRank(seeds, raw, { max = RANK_MAX } = {}) {
  const list = asList(seeds)
  const head = list.slice(0, Math.max(0, max))
  const tail = list.slice(head.length)
  const rows = []
  const seen = new Set()
  rowsOf(raw, ['ranking', 'ranks', 'order', 'seeds']).forEach((row, i) => {
    const at = indexOf(row, i)
    if (at < 0 || at >= head.length || seen.has(at)) return
    seen.add(at)
    const rank = Number(row?.rank ?? row?.순위)
    rows.push({
      at,
      // 순위를 안 적어 왔으면 온 순서가 곧 순위다
      rank: Number.isFinite(rank) ? rank : rows.length + 1,
      why: cleanWhy(row?.why ?? row?.reason ?? row?.이유),
    })
  })
  if (rows.length < 2) return list
  rows.sort((a, b) => a.rank - b.rank)
  return [
    ...rows.map(({ at, why }) => (why ? { ...head[at], why } : head[at])),
    // 순위에서 빠진 것은 뒤로 보내되 서로의 순서는 점수 순서를 지킨다
    ...head.filter((_, i) => !seen.has(i)),
    ...tail,
  ]
}
