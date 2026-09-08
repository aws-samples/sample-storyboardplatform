/*
 * 컷을 사람이 읽는 대본으로 만듭니다. 형식(드라마·영화·애니) 별 프롬프트와, 모델 응답에서
 * 대본 텍스트만 꺼내는 부분, 그리고 모델이 없을 때 쓰는 로컬 형식이 같이 있습니다.
 */

import { asList, asObj, numOr } from '../lib/guards.js'
import { withBody, roster } from './prompts.js'
import { unfence, repairJson } from './json-repair.js'

export function scriptToText(raw, name = '') {
  const s = String(raw || '')
  if (!/\.fdx$/i.test(name) && !/<FinalDraft/i.test(s)) return s.trim()
  const unesc = (v) => v.replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

  const out = []
  for (const m of s.matchAll(/<Paragraph\b([^>]*)>([\s\S]*?)<\/Paragraph>/g)) {
    const type = /Type="([^"]*)"/.exec(m[1])?.[1] || ''
    const text = unesc([...m[2].matchAll(/<Text\b[^>]*>([\s\S]*?)<\/Text>/g)].map((t) => t[1]).join(''))
    if (!text) continue
    if (type === 'Scene Heading') out.push('', text)
    else if (type === 'Character') out.push(`${text}:`)
    else if (type === 'Dialogue' && out.at(-1)?.endsWith(':')) out[out.length - 1] += ` ${text}`
    else out.push(text)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() || s.trim()
}

/**
 * 긴 텍스트를 추출 단위로 자른다. 빈 줄을 경계로 삼아 문단이 갈라지지 않게 한다.
 *
 * @param {string} text - 원문
 * @param {number} [size=GRAPH_CHUNK] 조각 하나의 글자 수 상한
 * @returns {Array<string>} 조각 배열. 빈 텍스트면 빈 배열
 */
export const SCRIPT_BATCH = 4
/** 대본 한 묶음의 응답 토큰 상한. 리졸버가 4000 에서 자른다 */
export const SCRIPT_TOKENS = 4000
/** 컷 하나에 요구하는 최소 줄 수 (지문 + 대사). 프롬프트와 묶음 크기가 같은 값을 본다 */
const SCRIPT_LINES = 15

/**
 * 대본 형식별 안내. 프롬프트의 형식 지시와 뷰어의 선택 항목이 같은 곳에서 나온다.
 */
export const SCRIPT_FORMATS = {
  drama: {
    label: '드라마 대본',
    guide: [
      '드라마 대본 형식으로 옮긴다.',
      'S#번호. 장소 / 시간',
      '등장인물: 이름, 이름',
      '지문은 평서문으로 쓴다. 한 동작을 한 줄로 끊는다. 짧은 지시는 (괄호) 안에.',
      '캐릭터: 대사',
    ],
  },
  film: {
    label: '영화 각본',
    guide: [
      '영화 각본 형식(Hollywood format)으로 옮긴다.',
      '맨 앞에 FADE IN: 을 한 번 쓴다.',
      'INT./EXT. 장소 - 시간',
      '액션 라인은 현재형으로 쓴다.',
      '캐릭터 이름을 한 줄에 두고, 그 아래 들여쓰기로 대사를 쓴다. 지시는 캐릭터 이름 뒤 (괄호) 에.',
      '맨 끝에 FADE OUT. 을 한 번 쓴다.',
    ],
  },
  webdrama: {
    label: '웹드라마',
    guide: [
      '웹드라마 대본 형식으로 옮긴다.',
      '[씬 번호 - 장소]',
      '모바일 화면에 맞게 짧은 호흡으로 쓴다.',
      '빠른 템포의 대사와 액션. 지문은 짧은 문장을 여러 줄로 끊어 쓴다.',
    ],
  },
}

const scriptFormat = (v) => (SCRIPT_FORMATS[v] ? v : 'drama')

/**
 * 스토리보드의 컷을 정식 대본 포맷으로 옮기는 프롬프트.
 * 기존 outlinePrompt/cutsPrompt 와 같은 배열-join 구조지만, 출력은 JSON 이 아니라
 * 대본 텍스트다. 그래서 JSON_ONLY 대신 "대본 텍스트만" 을 못 박는다.
 *
 * @param {Array} cuts - 보드의 컷 배열 [{scene, action, dialogue, camera, cast, secs}]
 * @param {Object} [options]
 * @param {'drama'|'film'|'webdrama'} [options.format='drama'] 대본 형식
 * @param {string} [options.title] 작품 제목
 * @param {Array} [options.chars] 인물 목록 [{name, brief}]
 * @param {{i: number, n: number, from: number}} [options.part] 컷이 많아 묶음으로 나눌 때의 조각 번호
 * @returns {string} Bedrock 에 그대로 넣는 프롬프트
 */
export function scriptFormatPrompt(cuts, options = {}) {
  const o = asObj(options)
  const fmt = scriptFormat(o.format)
  const list = asList(cuts)
  const part = o.part && Number(o.part.n) > 1 ? o.part : null
  const from = Number(part?.from) || 0

  const lines = list.map((raw, i) => {
    const c = asObj(raw)
    const cast = asList(c.cast).filter(Boolean)
    return [
      `${from + i + 1}. ${c.scene || `S${from + i + 1}`} (${numOr(c.secs, 2)}초${c.camera ? `, ${c.camera}` : ''})`,
      c.action ? `   보이는 것: ${c.action}` : null,
      c.dialogue ? `   대사: ${c.dialogue}` : null,
      cast.length ? `   등장: ${cast.join(', ')}` : null,
    ].filter(Boolean).join('\n')
  })

  // 컷 목록만 잘릴 수 있게 withBody 로 감싼다. 형식 가이드와 아래 규칙을 자르면
  // 분량·묘사 지시가 사라져 예전처럼 두 줄짜리 대본이 돌아온다
  return withBody([
    part
      ? `아래는 콘티를 ${part.n}묶음으로 나눈 것 중 ${part.i}번째다. 이 묶음의 컷만 대본으로 옮긴다.`
      : '아래 콘티 컷을 정식 대본으로 옮긴다.',
    '콘티는 뼈대다. 한 컷을 실제로 촬영할 수 있는 한 장면으로 펴는 것이 이 작업이다.',
    '',
    ...SCRIPT_FORMATS[fmt].guide.map((g, i) => (i === 0 ? g : `- ${g}`)),
    '',
    o.title ? `제목: ${o.title}` : null,
    `인물:\n${roster(asList(o.chars))}`,
    '',
    '컷:',
  ].filter((l) => l !== null), lines.join('\n'), [
    '',
    '분량',
    `- 컷 하나를 지문과 대사 합쳐 ${SCRIPT_LINES}줄 이상으로 편다. 컷을 한두 줄로 요약하지 않는다.`,
    '- 한 씬(장소·시간이 같은 덩어리)은 최소 10줄이다. 짧게 끝내고 다음 씬으로 넘어가지 않는다.',
    '',
    '지문',
    '- 카메라 앵글·조명·인물의 미세한 표정과 손짓까지 적는다. 한 동작을 한 줄로 끊어 쓴다.',
    '- "해인의 손가락이 떨린다" 에서 멈추지 않는다. "해인의 왼손 약지가 테이블 모서리를 잡고,'
      + ' 손톱 끝이 하얗게 질릴 만큼 힘이 들어간다. 표정은 무너지지 않는다." 처럼 무엇이 어떻게 보이는지 적는다.',
    '- 감정을 이름으로 설명하지 않는다 (슬프다·화가 난다·불안하다). 시선·호흡·손에 쥔 소품·몸의 방향으로 보여준다.',
    '',
    '대사',
    '- 인물마다 말투가 달라야 한다. 위 인물 설명에서 그 사람의 말투를 정하고 끝까지 지킨다.',
    '- 자란 자리와 처지가 말에 남는다. 재벌가에서 자란 인물은 짧고 단정한 문장으로,'
      + ' 농촌에서 자란 인물은 따뜻하고 직설적인 말로 쓴다. 같은 뜻도 사람마다 다르게 말한다.',
    '- 대사를 연달아 붙이지 않는다. 대사와 대사 사이에 지문 한 줄을 넣어 호흡을 만든다.',
    '',
    '씬 전환',
    '- 씬이 바뀌면 시간과 장소가 어떻게 변했는지 첫 줄에서 알 수 있게 쓴다.',
    '- 앞 씬에서 인물의 감정이 어디까지 왔는지 이어 받는다. 같은 자리에서 다시 시작하지 않는다.',
    '',
    '규칙',
    '- 컷 순서를 지킨다. 컷을 합치거나 빼지 않는다.',
    part
      ? `- 씬 번호는 ${from + 1} 번부터 이어 붙인다. 앞뒤 묶음이 따로 만들어지므로 처음·끝 표시는 쓰지 않는다.`
      : null,
    '- 컷에 없는 사건이나 인물을 새로 만들지 않는다. 분량은 새 사건이 아니라'
      + ' 이미 컷에 있는 순간을 더 자세히 봐서 채운다.',
    '- 대사가 없는 컷은 지문만 쓴다. 대사를 억지로 만들지 않는다.',
    '- 대본 텍스트만 출력한다. JSON·설명·머리말·코드펜스를 붙이지 않는다.',
    '- 한국어로 쓴다. 형식 표기(INT./EXT., FADE IN 등)는 원어 그대로 둔다.',
  ].filter((l) => l !== null), '(컷이 많아 여기서 잘랐다)')
}

// 프롬프트로 "대본 텍스트만" 을 못 박아도 모델은 묶음의 뒤쪽에서 {"script": "S#5…"} 처럼
// JSON 으로 감싸 보낼 때가 있다. 그대로 이어 붙이면 대본 중간부터 JSON 문자열이 보인다.
// 아래 세 조각으로 벗긴다. JSON 으로 의심되는 모양일 때만 손을 대고, 평문은 건드리지 않는다.
//   SCRIPT_JSON → 여는 모양으로 JSON 여부를 가린다
//   scriptOf    → 파싱한 값에서 대본 문자열을 고른다
//   unquote     → 상한에서 잘려 파싱조차 안 되는 경우 문자열 값만 손으로 벗긴다

/** 대본이 JSON 으로 감싸여 올 때 텍스트가 들어 있을 만한 키 */
const SCRIPT_KEYS = ['script', 'text', 'content', 'body', '대본']

/**
 * JSON 으로 감싸여 온 응답의 여는 모양. `{` 뒤 키 따옴표, `[` 뒤 객체·배열·문자열만 본다. * webdrama 대본은 `[씬 1 - 빵집]` 으로 시작하므로 여는 괄호만으로 판단하면 평문을 건드린다.
 */
const SCRIPT_JSON = /^\{\s*["}]|^\[\s*[{["\]]/

/** 잘려 온 `{"script": "…` 에서 값이 시작하는 자리 */
const SCRIPT_OPEN = new RegExp(`^\\{\\s*"(?:${SCRIPT_KEYS.join('|')})"\\s*:\\s*"`)

/**
 * 파싱한 값에서 대본 문자열을 고른다. 아는 키를 먼저 보고, 키 이름이 다르면
 * 값 중에서 가장 긴 문자열을 대본으로 본다 (짧은 title·note 가 아니라 본문을 집는다).
 *
 * @param {*} v - JSON.parse 나 repairJson 이 준 값
 * @returns {string} 대본 텍스트. 문자열이 없으면 빈 문자열
 */
const scriptOf = (v) => {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(scriptOf).filter((t) => t.trim()).join('\n\n')
  const o = asObj(v)
  for (const k of SCRIPT_KEYS) if (typeof o[k] === 'string' && o[k].trim()) return o[k]
  const rest = Object.values(o).map(scriptOf).filter((t) => t.trim())
  return rest.sort((a, b) => b.length - a.length)[0] || ''
}

/**
 * 잘린 JSON 문자열 값의 이스케이프를 되돌린다. 닫는 따옴표를 만나면 거기서 끊는다.
 *
 * @param {string} s - 여는 따옴표 다음부터의 텍스트
 * @returns {string} 이스케이프를 푼 문자열
 */
const unquote = (s) => {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"') break
    if (c !== '\\') { out += c; continue }
    const e = s[++i]
    if (e === undefined) break
    if (e === 'n') out += '\n'
    else if (e === 't') out += '\t'
    else if (e === 'r') out += '\r'
    else if (e === 'u') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16) || 0); i += 4 }
    // \" \\ \/ 는 뒤 문자를 그대로 쓴다
    else out += e
  }
  return out
}

/**
 * 한 묶음의 응답에서 대본 텍스트만 꺼낸다. 코드펜스와 JSON 래핑을 벗기고,
 * 평문 대본은 모델이 준 그대로 넘긴다.
 *
 * @param {*} raw - net.plan 이 준 text
 * @returns {string} 이어 붙일 대본 텍스트. 감싼 JSON 에 텍스트가 없으면 빈 문자열
 */
export const scriptText = (raw) => {
  const s = unfence(String(raw ?? '')).trim()
  if (!SCRIPT_JSON.test(s)) return s

  let val
  try { val = JSON.parse(s) } catch { val = repairJson(s) }
  // 파싱은 됐다. 텍스트가 없으면 빈 문자열이다. 감싼 JSON 을 대본으로 내보내지 않는다
  if (val !== undefined) return scriptOf(val).trim()

  // 상한에서 문자열 중간이 잘려 repairJson 도 못 살린 경우. 값만 손으로 벗긴다
  const m = s.match(SCRIPT_OPEN)
  if (m) return unquote(s.slice(m[0].length)).trim()
  return s
}

/**
 * 컷을 정식 대본으로 옮긴다. 반환값은 JSON 이 아니라 대본 텍스트다.
 * 컷이 많으면 planCuts 처럼 묶음으로 나눠 부르고 이어 붙인다.
 *
 * @param {Object} net - net.plan 을 가진 객체. 없으면 로컬 모드
 * @param {Array} cuts - 보드의 컷 배열
 * @param {Object} [options] - scriptFormatPrompt 와 같은 {format, title, chars} + {model}
 * @returns {Promise<string>} 대본 텍스트. 컷이 없으면 빈 문자열
 */
export function localScript(cuts, options = {}) {
  const list = asList(cuts)
  if (!list.length) return ''
  const o = asObj(options)
  const fmt = scriptFormat(o.format)
  const from = Math.max(0, Number(o.from) || 0)
  const whole = o.whole !== false && !from
  const lines = []

  if (o.title && whole) lines.push(fmt === 'film' ? String(o.title).toUpperCase() : String(o.title), '')
  if (fmt === 'film' && whole) lines.push('FADE IN:', '')

  list.forEach((raw, i) => {
    const cut = asObj(raw)
    const n = from + i + 1
    const place = cut.scene || '장소 미정'
    const cast = asList(cut.cast).filter(Boolean)
    const who = cast[0] || '인물'
    if (fmt === 'film') {
      lines.push(`INT. ${place} - DAY`)
      if (cut.action) lines.push(cut.action)
      if (cut.dialogue) lines.push('', `        ${who}`, `    ${cut.dialogue}`)
    } else if (fmt === 'webdrama') {
      lines.push(`[씬 ${n} - ${place}]`)
      if (cast.length) lines.push(`(${cast.join(', ')})`)
      if (cut.action) lines.push(cut.action)
      if (cut.dialogue) lines.push(`${who}: ${cut.dialogue}`)
    } else {
      lines.push(`S#${n}. ${place}`)
      if (cast.length) lines.push(`등장인물: ${cast.join(', ')}`)
      if (cut.action) lines.push(`  ${cut.action}`)
      if (cut.dialogue) lines.push(`  ${who}: ${cut.dialogue}`)
    }
    lines.push('')
  })

  if (fmt === 'film' && whole) lines.push('FADE OUT.')
  return lines.join('\n').trim()
}

/** UTF-8 BOM. 한글 작가들이 쓰는 편집기가 BOM 없는 UTF-8 을 깨뜨리는 일이 있다 */
export const SCRIPT_BOM = '\uFEFF'

/**
 * 대본 텍스트를 .txt 로 내려받을 Blob 으로 만든다.
 *
 * @param {string} text - 대본 텍스트
 * @returns {Blob} BOM 이 붙은 UTF-8 텍스트 Blob
 */
export function scriptBlob(text) {
  return new Blob([SCRIPT_BOM + String(text ?? '')], { type: 'text/plain;charset=utf-8' })
}

/**
 * 내려받을 대본 파일 이름. 제목을 앞에 둔다.
 *
 * @param {string} title - 작품 제목
 * @returns {string} "제목_대본.txt"
 */
export function scriptFileName(title) {
  const base = String(title ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return `${base || '무제'}_대본.txt`
}
