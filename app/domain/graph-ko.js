
// 그래프의 말을 사람의 말로 옮기는 자리.
//
// 그래프 안에서 술어는 영문이다 (graph-schema.js 의 RELS). 그것이 그대로 화면에 나오면
// 씨앗 카드에 "표선생 mentor_of 재민의 아들" 이 찍힌다. 읽는 사람은 작가·PD 다.
// 그래서 화면에 내보내기 직전에 이 파일을 지난다. 표는 한 벌이어야 한다. 판의 엣지 라벨과
// 씨앗 설명이 다른 표를 보면 같은 관계가 두 가지 말로 불린다.
//
// 여기 있는 것은 표시용 문자열뿐이다. 그래프의 어휘·파생 규칙은 graph-schema.js 가 들고 있다.

import { josa } from '../lib/josa.js'

/**
 * 술어를 한국어 서술로 옮기는 표. "A ─라벨→ B" 로 읽으면 문장이 되게 적는다.
 * 조사는 목적어(B) 쪽에 붙으므로 라벨은 조사로 시작한다 ("표선생 ─을 가르침→ 재민의 아들").
 *
 * 여기 적힌 조사는 받침이 있는 목적어를 기준으로 한 형태다. 목적어를 실제로 아는
 * 자리(predicateToKo)에서는 받침을 보고 을/를·과/와·으로/로 를 바꿔 준다.
 *
 * 술어 어휘(GRAPH_SCHEMA.edgeRels)에 있는 것은 빠짐없이 여기에도 있어야 한다. 사용자에게
 * 보이는 자리에 영문 술어가 새는 것을 막는 자리가 이 표다 (test.html 이 전수로 확인한다).
 */
export const PREDICATE_KO = {
  // 소속과 역할
  member_of: '에 소속됨',
  mentor_of: '을 가르침',
  manages: '을 관리함',
  maintains: '을 유지함',
  serves: '을 보좌함',
  kin_of: '과 혈연 관계임',
  // 감정
  loves: '을 사랑함',
  drawn_to: '에게 끌림',
  rival_of: '과 경쟁함',
  distrusts: '을 불신함',
  estranged_from: '과 멀어짐',
  protects: '을 보호함',
  targets: '을 겨냥함',
  deceives: '을 속임',
  // 비밀
  conceals: '을 은닉함',
  knows: '을 알고 있음',
  hidden_from: '에게 숨겨짐',
  reveals: '을 폭로함',
  concerns: '에 관한 것임',
  remembers: '을 기억함',
  // 사건과 인과
  participated_in: '에 참여함',
  caused: '을 초래함',
  enabled: '을 가능케 함',
  resolves: '을 해소함',
  weakened_by: '에 의해 약해짐',
  dissolving: '으로 해체되는 중임',
  withdraws_from: '에서 이탈함',
  uses: '을 사용함',
  calls_true_name: '의 참이름을 부름',
  // 장소
  located_in: '에 위치함',
  last_seen_in: '에서 마지막으로 목격됨',
  passes_through: '을 지나감',
  performs_at: '에서 활동함',
  // 파생
  has_leverage_over: '의 약점을 쥠',
  unrequited_love: '에게 짝사랑받음',
  potential_rival_of: '과 잠재적으로 맞섬',
  threatens: '을 위협함',
}

/**
 * 친족은 술어가 하나뿐이고 props.type 에 관계가 담긴다 (위 kin_of).
 * type 을 알면 이쪽이 kin_of 의 기본 라벨을 대신한다.
 */
export const KIN_KO = {
  parent: '의 부모임',
  child: '의 자녀임',
  sibling: '의 형제임',
  spouse: '의 배우자임',
}

/** 목적어의 받침에 따라 갈리는 조사. 라벨의 첫 조사를 이 표로 고쳐 준다 */
const PARTICLE_ALT = { 을: '를', 과: '와', 은: '는', 이: '가', 으로: '로' }

/**
 * 라벨의 첫 조사를 목적어의 받침에 맞춰 고친다. "재민의 아들" + "을 가르침" 은 그대로,
 * "루미" + "을 사랑함" 은 "루미를 사랑함" 이 된다.
 */
const fitParticle = (label, object) => {
  for (const [withJong, noJong] of Object.entries(PARTICLE_ALT)) {
    if (!label.startsWith(withJong)) continue
    return josa(object, withJong, noJong) + label.slice(withJong.length)
  }
  return label
}

/**
 * 엣지 하나에 얹을 한국어 라벨. 그래프 판의 엣지 알약이 이것을 쓴다.
 * "A ─라벨→ B" 로 읽히는 서술이다.
 *
 * @param {string} p - 술어
 * @param {Object} [props] - 엣지의 props. kin_of 의 type 을 여기서 본다
 * @returns {string} 한국어 서술. 어휘에 없는 술어는 원본 문자열 그대로
 */
export function predicateLabel(p, props) {
  const key = String(p ?? '')
  if (key === 'kin_of') {
    const kin = KIN_KO[String(props?.type ?? '').toLowerCase()]
    if (kin) return kin
  }
  return PREDICATE_KO[key] || key
}

/**
 * 삼항 하나를 한국어 문장으로 옮긴다. 씨앗 설명·역기입 목록처럼 사람이 읽는
 * 자리에서는 "표선생 mentor_of 재민의 아들" 대신 이 문장을 쓴다.
 *
 * @param {string} subject - 주어 (예: "표선생")
 * @param {string} predicate - 술어 (예: "mentor_of")
 * @param {string} object - 목적어 (예: "재민의 아들")
 * @param {Object} [props] - 엣지의 props. kin_of 의 type 을 여기서 본다
 * @returns {string} 한국어 문장 (예: "표선생이 재민의 아들을 가르침").
 *                  어휘에 없는 술어는 대시로 잇는다 ("표선생 — zzz — 재민의 아들")
 */
export function predicateToKo(subject, predicate, object, props) {
  const s = String(subject ?? '').trim()
  const o = String(object ?? '').trim()
  const label = predicateLabel(predicate, props)
  if (!label || label === String(predicate ?? '')) {
    return [s, label || predicate, o].filter(Boolean).join(' — ')
  }
  if (!s) return `${o}${fitParticle(label, o)}`
  return `${s}${josa(s, '이', '가')} ${o}${fitParticle(label, o)}`
}

/**
 * 엣지 하나를 한국어 문장으로. 이름을 이미 아는 자리에서 부른다.
 *
 * @param {{s: string, p: string, o: string, props?: Object}} edge - s·o 는 노드 이름
 * @returns {string} "표선생이 재민의 아들을 가르침"
 */
export const edgeToKo = (edge) => predicateToKo(edge?.s, edge?.p, edge?.o, edge?.props)

/**
 * 긴장도를 사람이 읽는 꼬리말로. 숫자만 노출하지 않고 무엇의 숫자인지 붙인다.
 *
 * @param {number|string|undefined} tension - 0~1 사이 값
 * @returns {string} " (긴장도 0.7)" 또는 값이 없으면 빈 문자열
 */
export function tensionKo(tension) {
  if (tension === null || tension === undefined || tension === '') return ''
  const n = Number(tension)
  return Number.isFinite(n) ? ` (긴장도 ${Math.round(n * 100) / 100})` : ''
}

/**
 * 사건의 상대 시점(현재 0)을 사람이 읽는 말로. props.t 를 날것으로 보여 주지 않는다.
 *
 * @param {number|string|undefined} t - 현재를 0 으로 둔 상대 시점 (과거는 음수)
 * @returns {string} "지금" · "3년 전" · "2년 뒤". 숫자가 아니면 빈 문자열
 */
export function whenKo(t) {
  if (t === null || t === undefined || t === '') return ''
  const n = Number(t)
  if (!Number.isFinite(n)) return ''
  if (n === 0) return '지금'
  return n < 0 ? `${-n}년 전` : `${n}년 뒤`
}

// ── 세계관 업데이트(역기입)의 말 ──────────────────────────────────────────────
// 역기입 패널은 작가·PD 가 마지막으로 보는 자리다. 거기에 "+ 노드 1 · + 엣지 3" 이
// 찍혀 있었다. 그 말을 아는 사람은 이 화면 앞에 앉지 않는다. 개수만 적으면 무엇이
// 늘었는지도 알 수 없어서, 결국 「적용」을 누를지 말지를 짐작으로 정하게 된다.
//
// 그래서 개수 대신 이름을 적는다. 종류는 사람의 말로 갈라 세고(등장인물·사건·비밀…),
// 관계는 predicateToKo 가 문장으로 옮긴다. id·props·kind·영문 술어는 여기서 걸린다.
// 넣을 수 없는 항목이나 id 를 새로 지었다는 말은 개발자용이라 화면에 올리지 않는다
// (부르는 쪽이 console.warn 으로 남긴다).

const asList = (v) => (Array.isArray(v) ? v : [])

/**
 * 노드 종류를 역기입 문장에 넣는 이름으로. 판의 범례(graph-view.js 의 KIND_LABEL)와
 * 갈라 두는 이유는, 범례는 색 옆에 붙는 짧은 딱지고 이쪽은 문장 안에 들어가기
 * 때문이다 ("「밀실 각서」 소품/물건이 새로 추가됩니다").
 */
export const NODE_KIND_KO = {
  Character: '등장인물',
  Faction: '조직',
  Location: '장소',
  Event: '사건',
  Secret: '비밀',
  Object: '소품/물건',
}

/** 모르는 kind 도 문장은 서야 한다. 그때는 종류를 말하지 않고 "항목" 으로 센다 */
export const nodeKindKo = (kind) => NODE_KIND_KO[String(kind ?? '')] || '항목'

/** 종류별 셈말. 사람은 명으로 세고 나머지는 개로 센다 */
const counterKo = (kind) => (String(kind ?? '') === 'Character' ? '명' : '개')

/**
 * 역기입의 변경 개수를 사람이 읽는 조각으로 나눈다. 노드는 종류별로 갈라 세어
 * "노드 3" 이 아니라 "새 등장인물 1명 · 새 사건 2개" 로 읽히게 한다.
 *
 * HTML 은 만들지 않는다. 숫자를 굵게 할지 흐리게 할지는 부르는 화면이 정한다.
 *
 * @param {{nodes?: Array, edges?: Array, removes?: Array}} changes - 실제로 들어가는 변경
 * @param {Object} [o]
 * @param {boolean} [o.done] - 적용을 이미 마쳤는가. 미리보기는 "추가/변경" 을 덧붙인다
 * @returns {Array<{label: string, n: number, tail: string, weak: boolean}>}
 *          weak 는 「변경된 관계」처럼 더한 것이 아닌 조각이다
 */
export function writebackCountsKo(changes, { done = false } = {}) {
  const parts = []
  const byKind = new Map()
  for (const n of asList(changes?.nodes)) byKind.set(n?.kind, (byKind.get(n?.kind) || 0) + 1)
  for (const [kind, n] of byKind) {
    parts.push({ label: `새 ${nodeKindKo(kind)}`, n, tail: `${counterKo(kind)}${done ? '' : ' 추가'}`, weak: false })
  }
  const added = asList(changes?.edges).length
  if (added) parts.push({ label: '새 관계', n: added, tail: done ? '개' : '개 추가', weak: false })
  const gone = asList(changes?.removes).length
  if (gone) {
    parts.push({ label: done ? '변경된 관계' : '기존 관계', n: gone, tail: done ? '개' : '개 변경', weak: true })
  }
  return parts
}

/**
 * 역기입의 변경 하나하나를 완결된 문장으로. 「확인사항」목록이 이것을 쓴다.
 *
 * @param {{nodes?: Array, edges?: Array, removes?: Array}} changes - 실제로 들어가는 변경.
 *        엣지의 s·o 는 노드 id 다. nameOf 로 이름을 찾아 문장에 넣는다
 * @param {(id: string) => string} [nameOf] - id → 이름. 없으면 id 를 그대로 쓴다
 * @param {Object} [o]
 * @param {boolean} [o.done] - 적용을 이미 마쳤는가 ("추가되었습니다" vs "추가됩니다")
 * @returns {Array<string>} 사람이 읽는 문장. 그래프 용어는 하나도 들어가지 않는다
 */
export function writebackNotesKo(changes, nameOf, { done = false } = {}) {
  /*
   * 미리보기에서는 새 노드가 아직 판에 없다. nameOf 만 믿으면 그 노드를 가리키는 엣지가
   * "가온과 bareum_의 관계가 추가됩니다" 로 찍힌다. 지어 둔 id 가 그대로 새는 자리라
   * changes.nodes 의 이름을 먼저 본다. 적용 뒤에는 둘이 같은 이름을 준다.
   */
  const fresh = new Map()
  for (const n of asList(changes?.nodes)) if (n?.id) fresh.set(String(n.id), String(n.name ?? ''))
  const name = (id) => {
    const key = String(id ?? '')
    const got = fresh.get(key) || (typeof nameOf === 'function' ? nameOf(key) : null)
    return String(got ?? key).trim() || key
  }
  const ended = done ? '되었습니다' : '됩니다'
  const notes = []
  for (const n of asList(changes?.nodes)) {
    const kind = nodeKindKo(n?.kind)
    notes.push(`"${String(n?.name ?? '')}" ${kind}${josa(kind, '이', '가')} 새로 추가${ended}`)
  }
  for (const e of asList(changes?.edges)) {
    const s = name(e?.s)
    const o = name(e?.o)
    notes.push(`${s}${josa(s, '과', '와')} ${o}의 관계가 추가${ended}: ${predicateToKo(s, e?.p, o, e?.props)}`)
  }
  for (const e of asList(changes?.removes)) {
    const s = name(e?.s)
    const o = name(e?.o)
    notes.push(`${s}${josa(s, '과', '와')} ${o}의 관계가 변경${ended}`)
  }
  return notes
}

/**
 * 역기입 한 번을 화면이 그대로 쓸 수 있는 두 벌로 옮긴다. 미리보기 패널과 적용 뒤의
 * 기록 패널이 같은 표를 보게 한 곳에 둔다.
 *
 * @param {{nodes?: Array, edges?: Array, removes?: Array}} changes - planWriteback 이 정한 변경
 * @param {(id: string) => string} [nameOf] - id → 이름
 * @param {Object} [o]
 * @param {boolean} [o.done] - 적용을 이미 마쳤는가
 * @param {Array<string>} [o.notices] - 사람에게 뜻이 있는 알림 (자동 연결 등). 목록 끝에 붙는다
 * @returns {{counts: Array, notes: Array<string>}}
 */
export function writebackKo(changes, nameOf, { done = false, notices = [] } = {}) {
  return {
    counts: writebackCountsKo(changes, { done }),
    notes: [...writebackNotesKo(changes, nameOf, { done }), ...asList(notices).map(String)],
  }
}
