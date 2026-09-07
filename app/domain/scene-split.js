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

/**
 * 슬러그 라인. 우리가 쓰는 글에는 줄표를 넣지 않지만, 이 둘은 남이 쓴 대본을 받아
 * 읽는 자리라 붙임표 · 짧은 줄표 · 긴 줄표를 다 받습니다. 슬러그의 시간이 긴 줄표
 * 뒤에 붙어 있으면 그것을 못 읽어 그 씬의 시간이 통째로 빠집니다.
 */
const SLUG = /^(INT|EXT|I\/E)\.?\s+(.+?)(?:\s+[-–—]\s+(.+))?$/i
const KO_SLUG = /^(실내|실외)[.\s]+(.+?)(?:\s+[-–—]\s+(.+))?$/

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
 * 이어지는 씬 표시. 장소든 시간이든 어디에 붙어 있어도 먼저 떼어냅니다.
 * `(이어서)` 처럼 혼자 괄호를 차지할 때도 있고 `(낮, 이어서)` 처럼 시간 뒤에
 * 쉼표로 붙을 때도 있어서, 낱말만 지우고 빈 괄호를 따로 치웁니다.
 */
const CONT_WORD = /[,、]?\s*(?:이어서|이어짐|계속|CONT'?D\.?|CONTINUOUS|CONTINUED)/gi

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
  const raw = stripCont(String(line || '').trim())
  if (!raw) return null
  // `[씬 1 - 빵집]` 은 대괄호를 벗기고 봅니다. 벗긴 뒤가 머리글이 아니면 원래 줄로 돌아갑니다
  const inner = raw.match(BRACKET)?.[1]
  const s = inner && (NUM_HEAD.test(inner) || SLUG.test(inner) || KO_SLUG.test(inner)) ? inner : raw

  const num = s.match(NUM_HEAD)
  if (num) {
    const pt = placeTime(num[2])
    return { no: Number(num[1]), place: pt.place, time: pt.time }
  }

  if (SLUG.test(s) || KO_SLUG.test(s)) {
    const pt = placeTime(s)
    return { no: null, place: pt.place, time: pt.time }
  }

  const bare = s.match(BARE_HEAD)
  if (bare) {
    const pt = placeTime(bare[2])
    if (headLike(bare[2], pt)) return { no: Number(bare[1]), place: pt.place, time: pt.time }
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
       */
      const sameHead = last && last.no === null
        && last.place === (head.place || '장소 미정') && last.time === head.time
      cur = sameHead ? last : open(head)
    } else if (!last) {
      // 머리글보다 먼저 나온 지문. 버리지 않고 장소 미정인 씬에 담습니다
      cur = open(null)
    }

    const cast = readCast(line)
    if (cast) cur.cast = [...new Set([...cur.cast, ...cast])].slice(0, 12)

    if (!cur.blkIdx.includes(blk)) cur.blkIdx.push(blk)
    cur.lines.push(line)
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
