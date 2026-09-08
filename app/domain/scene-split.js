/*
 * 대본 텍스트를 씬으로 나눕니다.
 *
 * 키 비주얼 화면이 STEP 1 에서 쓰던 것을 여기로 옮겼습니다. 화면에 있을 때는
 * `INT./EXT.` 와 `실내/실외` 두 형식만 읽어서, 한국 드라마 대본의 표준인
 * `S#1. 장소 / 밤` 을 머리글로 보지 못했습니다. 머리글이 하나도 안 잡히면 모든
 * 블록이 앞 씬에 붙어 대본 전체가 씬 한 개로 들어옵니다.
 *
 * 나누는 규칙은 두 가지입니다.
 *   번호가 붙은 머리글    작가가 손으로 매긴 경계입니다. 장소·시간이 앞 씬과
 *                        같아도 무조건 새 씬으로 끊습니다.
 *   번호가 없는 머리글    `INT. 분장실 - 밤` 다음에 `INT. 분장실 - 밤 (이어서)`
 *                        처럼 같은 슬러그가 이어지면 한 씬으로 합칩니다.
 *
 * 빈 줄이 없는 대본도 받습니다. 줄 단위로 보면서 머리글을 만날 때 끊으므로,
 * 머리글과 지문이 빈 줄 없이 붙어 있어도 씬이 갈라집니다.
 */

import { parseJson } from './json-repair.js'

/**
 * 슬러그 라인. 우리가 쓰는 글에는 줄표를 넣지 않지만, 이 둘은 남이 쓴 대본을 받아
 * 읽는 자리라 붙임표 · 짧은 줄표 · 긴 줄표를 다 받습니다. 슬러그의 시간이 긴 줄표
 * 뒤에 붙어 있으면 그것을 못 읽어 그 씬의 시간이 통째로 빠집니다.
 */
// 갈마드는 자리의 순서가 중요합니다. `INT` 를 먼저 두면 `INT./EXT.` 의 앞 세 자만 먹고
// 장소가 `/EXT. 차 안` 이 됩니다. 긴 것을 앞에 둡니다
const SLUG = /^(INT\.?\/EXT|EXT\.?\/INT|INT|EXT|EST|I\/E)[.\s]\s*(.+?)(?:\s+[-–—]\s+(.+))?$/i
const KO_SLUG = /^(실내|실외|내부|외부)[.\s]+(.+?)(?:\s+[-–—]\s+(.+))?$/

/**
 * 번호가 붙은 머리글. `S#1.` · `S# 1` · `씬 3` · `SCENE 12` · `장면 4` · `#7` 을 받습니다.
 * 번호 뒤의 구분 기호(`.` `)` 줄표)는 있어도 없어도 됩니다.
 */
const NUM_HEAD = /^(?:S\s*#\s*|SCENE\s+|SC\.?\s*|씬\s*|장면\s*|#\s*)(\d+)\s*[.)\-–—]?\s*(.*)$/i

/** 번호만 앞에 붙은 머리글. `1. 카페 / 낮` 처럼 씁니다. 목록과 헷갈리므로 뒤를 따져봅니다 */
const BARE_HEAD = /^(\d+)\s*[.)]\s+(.+)$/

/** 웹드라마 형식의 `[씬 1 - 빵집]`. 대괄호를 먼저 벗깁니다 */
const BRACKET = /^[[［(]\s*(.+?)\s*[\]］)]$/

/**
 * Fountain 의 강제 표시. 앞의 `.` 하나는 「이 줄은 머리글이다」, `!` 하나는 「머리글이
 * 아니다」 입니다. 영어가 아닌 대본은 `INT.` 를 쓰지 않아서 Fountain 이 이 점을
 * 도피처로 둡니다. `...` 로 시작하는 지문을 머리글로 보지 않도록 뒤 한 자를 봅니다.
 */
const FORCE_HEAD = /^\.(?=[^.\s])\s*(.+)$/
const NOT_HEAD = /^!/

/** Fountain 의 씬 번호. 머리글 끝에 `#1#` · `#1A#` · `#I-1-A#` 로 붙습니다 */
const HASH_NO = /\s*#([\w\-.]+)#\s*$/

/**
 * 이어지는 씬 표시. 장소든 시간이든 어디에 붙어 있어도 먼저 떼어냅니다.
 * `(이어서)` 처럼 혼자 괄호를 차지할 때도 있고 `(낮, 이어서)` 처럼 시간 뒤에
 * 쉼표로 붙을 때도 있어서, 낱말만 지우고 빈 괄호를 따로 치웁니다.
 */
const CONT_WORD = /[,、]?\s*(?:이어서|이어짐|계속|CONT'?D\.?|CONTINUOUS|CONTINUED)/gi

/**
 * 시간이 끊겼다는 표시. 씬은 「한 장소 · 이어지는 시간」이라서, 같은 장소를 두 시간에
 * 찍은 것은 씬 하나가 아니라 둘입니다. 이 말이 시간 자리에 있으면 합치지 않습니다.
 * `(이어서)` 와 반대 뜻이라 stripCont 가 지우는 낱말과 겹치지 않습니다.
 */
const LATER = /잠시\s?후|조금\s?뒤|얼마\s?후|이후|나중|다음\s?날|이튿날|새벽녘|LATER|MOMENTS\s+LATER|SAME\s+(?:TIME|DAY)|MEANWHILE/i

/** 슬러그의 시간 자리에 오는 말. 번호만 붙은 머리글이 머리글인지 가릴 때 씁니다 */
const TIME_WORD = new RegExp('^(?:낮|밤|아침|저녁|새벽|오전|오후|정오|한낮|심야|해질녘|황혼'
  + '|늦은\\s?밤|이른\\s?아침|DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|AFTERNOON'
  + '|LATER|CONTINUOUS|MOMENTS\\s+LATER)\\b', 'i')

/** 등장인물 줄. `등장인물: 한지영, 예린` 에서 이름을 꺼냅니다 */
const CAST_LINE = /^(?:등장인물|등장\s?인물|등장|인물|출연|CAST|CHARACTERS?)\s*[:：]\s*(.+)$/i

/** 문장으로 끝나는 줄. 머리글이 아니라 지문이라는 표시입니다 */
const SENTENCE_END = /[.!?…。]\s*$/

/**
 * 이어지는 씬 표시를 지웁니다. 낱말을 지운 뒤 남은 빈 괄호와 겹친 공백을 치웁니다.
 *
 * @param {string} s - 머리글 한 줄
 * @returns {string} `(이어서)` · `(낮, 이어서)` 의 표시만 빠진 줄
 */
export const stripCont = (s) => String(s)
  .replace(CONT_WORD, '')
  .replace(/[(（]\s*[)）]/g, '')
  .replace(/\s{2,}/g, ' ')
  .trim()

/**
 * 머리글의 장소·시간 부분을 가릅니다. 세 가지 모양을 봅니다.
 *   `INT. 카페 - 낮`   슬러그
 *   `흥신소 사무실 (낮)` 괄호 안이 시간
 *   `예린의 방 / 밤`     구분 기호 뒤가 시간
 *
 * @param {string} rest - 머리글에서 번호를 뗀 나머지
 * @returns {{place: string, time: string}} 못 가리면 전체를 장소로 봅니다
 */
export function placeTime(rest) {
  const s = String(rest || '').trim().replace(/[.,]\s*$/, '')
  if (!s) return { place: '', time: '' }

  const slug = s.match(SLUG) || s.match(KO_SLUG)
  if (slug) return { place: (slug[2] || '').trim(), time: (slug[3] || '').trim() }

  const par = s.match(/^(.*?)\s*[(（]([^)）]*)[)）]\s*$/)
  if (par && par[1].trim()) return { place: par[1].trim(), time: par[2].trim() }

  const sep = s.match(/^(.*?)\s*[/·|｜]\s*(.+)$/) || s.match(/^(.*?)\s+[-–—]\s+(.+)$/)
  if (sep && sep[1].trim()) return { place: sep[1].trim(), time: sep[2].trim() }

  return { place: s, time: '' }
}

/**
 * 번호만 앞에 붙은 줄이 머리글인지 가립니다. `1. 카페 / 낮` 은 머리글이고
 * `1. 커피를 사서 나온다.` 는 지문입니다. 시간 자리가 시간처럼 보이거나,
 * 짧고 문장으로 끝나지 않을 때만 머리글로 봅니다.
 *
 * @param {string} rest - 번호를 뗀 나머지
 * @param {{place: string, time: string}} pt - placeTime 이 가린 결과
 * @returns {boolean}
 */
function headLike(rest, pt) {
  if (SLUG.test(rest) || KO_SLUG.test(rest)) return true
  if (pt.time && (TIME_WORD.test(pt.time) || pt.time.length <= 12)) return true
  return rest.length <= 24 && !SENTENCE_END.test(rest) && !/[:：]/.test(rest)
}

/**
 * 한 줄이 씬 머리글인지 읽습니다.
 *
 * @param {string} line - 대본의 한 줄
 * @returns {{no: number|null, place: string, time: string}|null}
 *   머리글이 아니면 null. `no` 는 작가가 매긴 씬 번호이고, 번호가 없는 슬러그면 null 입니다.
 */
export function readHeading(line) {
  const first = String(line || '').trim()
  // `!` 로 시작하면 머리글이 아닙니다. 대문자 지문을 머리글로 보지 않으려고 쓰는 도피처입니다
  if (NOT_HEAD.test(first)) return null

  const raw = stripCont(first)
  if (!raw) return null

  // 끝에 붙은 `#1A#` 은 작가가 매긴 씬 번호입니다. 장소를 읽기 전에 떼어냅니다
  const hash = raw.match(HASH_NO)
  const body = hash ? raw.slice(0, hash.index).trim() : raw
  // `#12#` 처럼 숫자만이면 씬 번호로, `#1A#` 처럼 글자가 섞이면 순서만 아는 표시로 둡니다
  const hashNo = hash && /^\d+$/.test(hash[1]) ? Number(hash[1]) : null

  // `.분장실` 은 강제 머리글입니다. INT. 를 쓰지 않는 대본이 쓸 수 있는 도피처입니다
  const forced = body.match(FORCE_HEAD)
  if (forced) {
    const pt = placeTime(forced[1])
    return { no: hashNo, place: pt.place, time: pt.time, forced: true }
  }

  // `[씬 1 - 빵집]` 은 대괄호를 벗기고 봅니다. 벗긴 뒤가 머리글이 아니면 원래 줄로 돌아갑니다
  const inner = body.match(BRACKET)?.[1]
  const s = inner && (NUM_HEAD.test(inner) || SLUG.test(inner) || KO_SLUG.test(inner)) ? inner : body

  const num = s.match(NUM_HEAD)
  if (num) {
    const pt = placeTime(num[2])
    return { no: Number(num[1]), place: pt.place, time: pt.time }
  }

  if (SLUG.test(s) || KO_SLUG.test(s)) {
    const pt = placeTime(s)
    return { no: hashNo, place: pt.place, time: pt.time }
  }

  const bare = s.match(BARE_HEAD)
  if (bare) {
    const pt = placeTime(bare[2])
    if (headLike(bare[2], pt)) return { no: Number(bare[1]), place: pt.place, time: pt.time }
  }

  // 번호 표시만 있고 나머지는 장소인 머리글. `분장실 - 밤 #12#` 처럼 씁니다
  if (hashNo !== null && s) {
    const pt = placeTime(s)
    return { no: hashNo, place: pt.place, time: pt.time }
  }

  return null
}

/**
 * 등장인물 줄에서 이름을 꺼냅니다.
 *
 * @param {string} line - 대본의 한 줄
 * @returns {Array<string>|null} 등장인물 줄이 아니면 null
 */
export function readCast(line) {
  const m = String(line || '').trim().match(CAST_LINE)
  if (!m) return null
  const names = m[1].split(/[,、·/]|\s+및\s+|\s+와\s+|\s+과\s+/)
    .map((n) => n.trim().replace(/[.。]$/, ''))
    .filter((n) => n && n.length <= 20 && n !== '없음')
  return names.length ? [...new Set(names)].slice(0, 12) : null
}

/**
 * 대본을 씬 목록으로 나눕니다. 씬을 고르지 않습니다. 목록 전체가 그대로 넘어갑니다.
 *
 * @param {string} text - 붙여넣은 대본
 * @returns {Array<Object>} { id, no, place, time, weather, blkIdx[], blocks, text, cast[], prompt, beat, framing }
 */
export function toScenes(text) {
  const lines = String(text || '').split('\n')
  const out = []
  let blk = 0
  let blank = true   // 앞줄이 빈 줄이었는지. 블록 번호를 매기는 데만 씁니다

  const open = (head) => {
    out.push({
      no: head?.no ?? null,
      place: head?.place || '장소 미정',
      time: head?.time || '',
      weather: '',
      blkIdx: [],
      cast: [],
      lines: [],
    })
    return out.at(-1)
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { blank = true; continue }
    if (blank) { blk++; blank = false }

    const head = readHeading(line)
    const last = out.at(-1)
    let cur = last

    if (head) {
      /*
       * 번호가 있으면 작가가 끊은 자리입니다. 장소·시간이 앞 씬과 같아도 새 씬입니다.
       * 번호가 없으면 슬러그가 같은 동안만 앞 씬에 붙입니다. `(이어서)` 는 이미 떼었으니
       * `분장실 - 밤` 과 `분장실 - 밤 (이어서)` 는 여기서 같은 슬러그로 만납니다.
       *
       * 단, 시간이 끊기면 장소가 같아도 다른 씬입니다. 씬은 「한 장소 · 이어지는 시간」
       * 이라서 같은 자리를 두 시간에 찍은 것은 씬 둘입니다. `잠시 후` · `LATER` 가
       * 그 표시라서, 이것이 붙은 머리글은 합치지 않습니다.
       */
      const sameHead = last && last.no === null && !LATER.test(head.time)
        && last.place === (head.place || '장소 미정') && last.time === head.time
      cur = sameHead ? last : open(head)
    } else if (!last) {
      // 머리글보다 먼저 나온 지문. 버리지 않고 장소 미정인 씬에 담습니다
      cur = open(null)
    }

    const cast = readCast(line)
    if (cast) cur.cast = [...new Set([...cur.cast, ...cast])].slice(0, 12)

    if (!cur.blkIdx.includes(blk)) cur.blkIdx.push(blk)
    // Fountain 의 강제 표시는 사람이 읽을 것이 아니라 파서에게 하는 말입니다. 본문에 남기지 않습니다
    cur.lines.push(line.replace(NOT_HEAD, '').replace(HASH_NO, '') || line)
  }

  return out.map((s, i) => {
    const { lines: own, ...rest } = s
    return {
      ...rest,
      id: `S${String(i + 1).padStart(2, '0')}`,
      text: own.join('\n'),
      blocks: s.blkIdx.length <= 1
        ? `블록 ${s.blkIdx[0] ?? 1}`
        : `블록 ${s.blkIdx[0]}–${s.blkIdx.at(-1)} 병합`,
      prompt: '',
      beat: '',
      framing: '',
    }
  })
}

/**
 * 옛 이름. 슬러그만 읽던 함수를 쓰던 자리가 남아 있어 이름을 지켜 둡니다.
 *
 * @param {string} text - 블록 하나
 * @returns {{place: string, time: string}|null}
 */
export function readSlug(text) {
  const head = readHeading(String(text).split('\n')[0])
  return head ? { place: head.place, time: head.time } : null
}

/* ══ 머리글이 없는 글 ══════════════════════════════ */

/*
 * 위까지는 작가가 쓴 머리글을 읽는 일입니다. 머리글이 아예 없는 글 — 시놉시스 ·
 * 트리트먼트 · 소설에서 옮긴 것 — 은 읽을 표시가 없어서 규칙으로는 씬 하나입니다.
 * 그 자리를 모델에게 넘깁니다.
 *
 * 무엇을 경계로 볼 것인지가 이 프롬프트의 전부입니다. 영화에서 씬은 「한 장소 ·
 * 이어지는 시간 · 이어지는 행동」의 덩어리이고, 그래서 경계는 세 가지에서 생깁니다.
 *   장소가 바뀐다
 *   시간이 끊긴다 (같은 자리를 두 시간에 찍으면 씬 둘입니다)
 *   무대에 있는 사람이 바뀐다 (연극의 French scene 이 이것만으로 씬을 가릅니다)
 * 같은 시간에 다른 곳에서 벌어지는 일은 서로 다른 씬입니다. 단, 전화나 화면으로
 * 이어져 있으면 한 씬으로 봅니다.
 *
 * 이 셋을 프롬프트에 그대로 적습니다. 「알아서 나눠라」 라고만 하면 모델이 문단 수나
 * 문장 수로 나눠서, 한 장소에서 이어지는 대화가 여러 씬으로 갈라집니다.
 */

/** 머리글 없는 글을 모델에게 넘길지 가리는 최소 길이. 이보다 짧으면 나눌 것이 없습니다 */
export const PROSE_MIN = 400

/** 한 번에 넘기는 글의 상한. 넘치면 뒤는 자릅니다 */
const PROSE_MAX = 12000

/** 모델이 낼 수 있는 씬 수의 상한. 한 화면에서 그릴 수 있는 만큼입니다 */
export const PROSE_CAP = 24

/**
 * 머리글이 하나도 없는지 봅니다. 하나라도 있으면 작가가 쓴 표시를 믿고 규칙으로 나눕니다.
 *
 * @param {string} text - 붙여넣은 글
 * @returns {boolean} 모델의 도움이 필요한 글이면 true
 */
export function needsAiSplit(text) {
  const s = String(text || '')
  if (s.trim().length < PROSE_MIN) return false
  return !s.split('\n').some((l) => readHeading(l))
}

/**
 * 머리글이 없는 글을 씬으로 나누라는 프롬프트.
 *
 * @param {string} text - 시놉시스 · 트리트먼트 등 머리글이 없는 글
 * @returns {string} Bedrock 에 그대로 넣는 프롬프트
 */
export function proseSplitPrompt(text) {
  const body = String(text || '').slice(0, PROSE_MAX)
  return [
    '아래 글을 촬영할 수 있는 씬으로 나눈다. 씬 머리글이 없는 글이다.',
    '',
    '씬은 「한 장소 · 이어지는 시간 · 이어지는 행동」의 덩어리다. 그래서 아래 세 가지에서 씬이 갈린다.',
    '- 장소가 바뀐다.',
    '- 시간이 끊긴다. 같은 장소라도 다른 시간에 벌어진 일은 다른 씬이다.',
    '- 그 자리에 있는 인물이 바뀐다. 누가 들어오거나 나가면 거기서 끊는다.',
    '',
    '나누지 않는 자리',
    '- 한 장소에서 이어지는 대화는 길어도 한 씬이다. 문단이 나뉘어 있어도 합친다.',
    '- 카메라가 움직이거나 앵글이 바뀌는 것은 씬이 아니라 컷이다. 그것으로 나누지 않는다.',
    '- 같은 시간에 다른 곳에서 벌어지는 일은 서로 다른 씬이다. 다만 전화·화면으로 이어져'
      + ' 있으면 한 씬으로 둔다.',
    '',
    '글:',
    body,
    '',
    '오직 아래 모양의 JSON 하나만 출력한다. 설명·머리말·코드펜스를 붙이지 않는다.',
    '{"scenes":[{"place":"장소","time":"낮 또는 밤 등","cast":["이름"],'
      + '"text":"이 씬에 해당하는 내용"}]}',
    '',
    '규칙',
    `- scenes 는 ${PROSE_CAP}개를 넘지 않는다. 글이 짧으면 적게 낸다.`,
    '- text 는 원문의 문장을 그대로 옮긴다. 요약하지 않고, 없는 사건을 만들지 않는다.',
    '- 원문의 순서를 지킨다. 원문에 있는 내용을 빼지 않는다.',
    '- 글에 시간이 적혀 있지 않으면 time 은 빈 문자열로 둔다. 짐작해서 채우지 않는다.',
    '- cast 는 그 씬에 나오는 사람만. 글에 이름이 없으면 빈 배열로 둔다.',
    '- place · time · cast 는 한국어로 쓴다.',
  ].join('\n')
}

/**
 * 모델이 준 씬 목록을 화면이 쓰는 모양으로 맞춥니다. 형식이 어긋난 것은 씬 상태에
 * 닿기 전에 막습니다. toScenes 와 같은 키를 내므로 뒤쪽 단계는 무엇이 나눴는지 모릅니다.
 *
 * @param {*} raw - parseJson 이 준 값
 * @param {string} [source] - 원문. 모델이 text 를 비워 보냈을 때 견주어 봅니다
 * @returns {Array<Object>} 씬 배열. 쓸 것이 없으면 빈 배열
 */
export function normalizeProseScenes(raw, source = '') {
  const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const list = Array.isArray(raw?.scenes) ? raw.scenes : Array.isArray(raw) ? raw : []
  const out = []

  for (const s of list) {
    if (out.length >= PROSE_CAP) break
    /*
     * 내용이 없는 씬은 그릴 것이 없습니다. 장소만 있고 본문이 빈 것은 버립니다.
     * 다만 짧다고 버리지는 않습니다. 「혼문이 갈라진다.」 한 줄도 그릴 수 있는 씬입니다.
     */
    const text = String(s?.text ?? '').trim()
    if (text.length < 4) continue
    out.push({
      no: null,
      place: clip(s?.place, 40) || '장소 미정',
      time: clip(s?.time, 20),
      weather: '',
      cast: (Array.isArray(s?.cast) ? s.cast : []).map((c) => clip(c, 20)).filter(Boolean).slice(0, 12),
      text: text.slice(0, 4000),
      blkIdx: [],
      byAi: true,
    })
  }

  return out.map((s, i) => ({
    ...s,
    id: `S${String(i + 1).padStart(2, '0')}`,
    blocks: 'AI 가 나눔',
    prompt: '',
    beat: '',
    framing: '',
  }))
}

/**
 * 머리글이 없는 글을 모델에게 나눠 달라고 합니다. 모델이 없거나 쓸 것을 못 주면
 * 규칙으로 나눈 결과를 그대로 돌려줍니다. 이 함수가 실패해도 화면은 멈추지 않습니다.
 *
 * @param {Object} net - net.plan 을 가진 객체. 없으면 규칙 결과를 그대로 냅니다
 * @param {string} text - 붙여넣은 글
 * @param {Object} [options]
 * @param {string} [options.model] - 쓸 모델
 * @returns {Promise<{scenes: Array, byAi: boolean, err: string|null}>}
 */
export async function aiSplitScenes(net, text, options = {}) {
  const fallback = toScenes(text)
  if (!net?.plan || !needsAiSplit(text)) return { scenes: fallback, byAi: false, err: null }

  try {
    const r = await net.plan({
      prompt: proseSplitPrompt(text),
      maxTokens: 8000,
      think: false,
      ...(options.model ? { model: options.model } : {}),
    })
    const scenes = normalizeProseScenes(parseJson(r?.text))
    // 하나도 못 건졌으면 규칙 결과가 낫습니다. 빈 화면을 내밀지 않습니다
    if (!scenes.length) return { scenes: fallback, byAi: false, err: '모델이 씬을 주지 않았습니다' }
    return { scenes, byAi: true, err: null }
  } catch (e) {
    return { scenes: fallback, byAi: false, err: e?.message || '나누지 못했습니다' }
  }
}
