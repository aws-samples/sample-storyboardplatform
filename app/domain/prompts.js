/*
 * Bedrock 에 그대로 넣는 프롬프트 문자열을 만듭니다. 순수 함수입니다. 네트워크를 부르는
 * 쪽은 services/planner.js 이고, 여기는 "무엇을 물어볼지" 만 정합니다.
 *
 * 프롬프트 길이는 두 군데서 막힙니다. 입력 상한(PROMPT_MAX) 과 응답 토큰 상한입니다.
 * withBody/bodyRoom 이 앞의 것을 코드로 못 박는 자리입니다.
 */

import { GRAPH_SCHEMA } from './graph-schema.js'
import { CAMERAS } from './panels.js'
import { PROBES } from './graph-probes.js'
import { numOr } from '../lib/guards.js'

export const MODES = [
  { id: 'new', label: '새 스토리', hint: '프롬프트 하나로 이야기·인물·컷을 처음부터' },
  { id: 'next', label: '다음 회차', hint: '지금 판의 인물과 사건을 이어서' },
  { id: 'spin', label: '스핀오프', hint: '한 인물을 주인공으로 갈라 나온 이야기' },
]

export const GENRES = ['브랜드 필름', '드라마', '코미디', '스릴러', '판타지', '다큐멘터리', '뮤직비디오', '애니메이션']
export const TONES = ['따뜻한', '담백한', '유쾌한', '긴장된', '서늘한', '몽환적인', '씩씩한']
export const LENGTHS = [15, 30, 60, 120, 300]
export const CUTCOUNTS = [6, 8, 12, 16, 24]

export const beatCount = (cuts) => Math.min(8, Math.max(3, Math.round(cuts / 2)))
export const perBeat = (cuts, beats) => Math.max(1, Math.round(cuts / Math.max(1, beats)))
export const BATCH = 4
export const HARD_MAX = 40

export const JSON_ONLY = '오직 아래 모양의 JSON 하나만 출력한다. 설명·머리말·코드펜스를 붙이지 않는다.'

// 프롬프트 길이는 두 군데서 막힌다.
//  1) infra/resolvers/plan.js 가 8000자를 넘는 프롬프트를 BadRequest 로 튕긴다.
//  2) AppSync HTTP 데이터소스(Bedrock)는 30초 안에 끝나야 한다. 넘으면 Execution timeout 이다.
// 아래 상한이 (1) 을 코드로 못 박는 자리고, 응답 토큰 상한이 (2) 를 잡는다.
/** plan 리졸버가 받는 프롬프트 상한 */
const PROMPT_MAX = 8000
/** 위 상한에 두는 여유. 규칙 블록은 GRAPH_SCHEMA 가 늘면 같이 커진다 */
export const PROMPT_SAFE = PROMPT_MAX - 400

/**
 * 머리말·꼬리말 사이에 길이가 들쭉날쭉한 본문(대본 조각·컨텍스트 팩)을 끼운다.
 * 프롬프트가 PROMPT_MAX 를 넘지 않도록 본문만 자른다. 출력 모양과 규칙을 자르면
 * 응답이 깨지므로 건드리지 않는다.
 *
 * @param {Array<string>} head - 본문 앞에 오는 줄들
 * @param {string} body - 잘려도 되는 본문
 * @param {Array<string>} tail - 본문 뒤에 오는 줄들 (출력 모양·규칙)
 * @param {string} [note] 잘랐을 때 그 자리에 남기는 한 줄
 * @returns {string} 길이가 PROMPT_SAFE 이하인 프롬프트
 */
export const withBody = (head, body, tail, note = '(컨텍스트를 여기서 잘랐다)') => {
  const lines = [...head, '', ...tail]
  const room = Math.max(0, PROMPT_SAFE - lines.join('\n').length)
  const text = String(body || '')
  const fit = text.length <= room
    ? text
    : `${text.slice(0, Math.max(0, room - note.length - 1))}\n${note}`
  return [...head, fit, ...tail].join('\n')
}

/** 이 프롬프트에서 본문에 남는 자리. contextPackPrompt 의 limit 으로 넘긴다 */
export const roster = (chars) =>
  chars.length ? chars.map((c) => `- ${c.name}: ${c.brief || '(설명 없음)'}`).join('\n') : '(없음)'

export function outlinePrompt(spec, ctx) {
  const nb = beatCount(spec.cuts)
  const keep = spec.useChars ? ctx.chars : []
  const head = {
    new: `아래 소재로 ${spec.secs}초 영상의 이야기를 처음부터 기획한다.`,
    next: `아래 판의 다음 회차(${spec.secs}초)를 기획한다. 인물과 앞 사건을 잇되, 이 회차 안에서 시작하고 끝나는 새 사건이어야 한다.`,
    spin: `아래 판에서 ${ctx.centerName || '한 인물'}을 주인공으로 갈라 나온 스핀오프(${spec.secs}초)를 기획한다. 본편과 다른 무대, 다른 사건이어야 한다.`,
  }[spec.mode]

  return [
    head,
    '',
    `소재: ${spec.prompt}`,
    `장르: ${spec.genre} / 톤: ${spec.tone}`,
    spec.mode === 'new' ? null : `지금 판의 제목: ${ctx.title || '(없음)'}`,
    spec.mode === 'new' ? null : `지금 판의 이야기:\n${ctx.scenario || '(없음)'}`,
    `이미 있는 인물:\n${roster(keep)}`,
    '',
    JSON_ONLY,
    '{"title":"제목","logline":"한 문장 요약","synopsis":"3~5문장 줄거리",',
    ' "chars":[{"name":"이름","brief":"나이·외모·옷·분위기를 한 줄로. 그림 지시로 쓸 수 있게 구체적으로"}],',
    ` "beats":[{"scene":"S1 장소","summary":"이 비트에서 일어나는 일","secs":초,"cast":["이름"]}]}`,
    '',
    '규칙',
    `- beats는 ${nb}개. secs 합계는 ${spec.secs}초에 맞춘다.`,
    spec.newChars > 0
      ? `- chars에는 새로 만드는 인물 ${spec.newChars}명만 넣는다. 이름은 한국어로 짓는다.`
      : '- chars는 빈 배열로 둔다.',
    keep.length ? '- 이미 있는 인물은 chars에 다시 넣지 않고 cast에서 이름으로만 부른다.' : null,
    '- 대사는 여기서 쓰지 않는다. 비트는 무슨 일이 벌어지는지만 적는다.',
    '- 한국어로 쓴다.',
  ].filter((l) => l !== null).join('\n')
}

export function cutsPrompt(spec, outline, beats, from, per) {
  const secs = beats.reduce((a, b) => a + b.secs, 0)
  const lines = beats.map((b, i) =>
    `${from + i + 1}. ${b.scene || `S${from + i + 1}`} · ${b.action} (${b.secs}초, 등장: ${b.cast.join(', ') || '없음'})`)

  return [
    '아래 이야기의 비트를 콘티 컷으로 펼친다.',
    '',
    `제목: ${outline.title}`,
    `로그라인: ${outline.logline}`,
    `톤: ${spec.tone}`,
    `인물:\n${roster(outline.chars)}`,
    '',
    '비트:',
    ...lines,
    '',
    JSON_ONLY,
    '{"cuts":[{"scene":"S1 장소","secs":초,"action":"화면에 보이는 것","dialogue":"대사 또는 빈 문자열","camera":"MS","cast":["이름"]}]}',
    '',
    '규칙',
    `- 비트마다 컷 ${per}개 안팎, 비트 순서대로 이어 붙인다.`,
    `- secs 합계는 ${secs}초에 맞춘다.`,
    '- action에는 카메라에 보이는 것만 쓴다. 인물의 속마음이나 설명은 쓰지 않는다.',
    '- dialogue는 실제로 말하는 문장만. 없으면 빈 문자열.',
    `- camera는 다음 중 하나: ${CAMERAS.join(' ')}`,
    '- 한국어로 쓴다.',
  ].join('\n')
}

// 조각 하나가 프롬프트에 통째로 들어가야 한다. 추출 프롬프트의 규칙·어휘 블록이
// 3천자 가까이 되고 판에 있는 노드 목록도 함께 실리므로, 조각은 그만큼 작게 자른다.
// 6000자로 자르던 때는 조각 하나가 8000자 상한을 넘어 리졸버가 BadRequest 로 튕겼다.
const GRAPH_CHUNK = 3000
const KNOWN_MAX = 40

const relLines = () => GRAPH_SCHEMA.assertableRels.map((p) => `  ${p} · ${GRAPH_SCHEMA.rels[p].desc}`).join('\n')
const kindLines = () => GRAPH_SCHEMA.nodeKinds.map((k) => `  ${k} · ${GRAPH_SCHEMA.nodeKindDesc[k]}`).join('\n')
const knownLines = (known) => {
  const list = known || []
  if (!list.length) return '(없음)'
  const lines = list.slice(0, KNOWN_MAX).map((n) => `- ${n.id} (${n.kind}) ${n.name}`)
  if (list.length > KNOWN_MAX) lines.push(`- (그 외 ${list.length - KNOWN_MAX}개는 생략했다)`)
  return lines.join('\n')
}

/**
 * 대본·시놉시스 텍스트에서 관계 그래프를 뽑는 프롬프트.
 * 출력 모양은 app-walkthrough/data/graph.json 과 같아야 한다. 그래야 뷰어가 그대로 읽는다.
 *
 * @param {string} text - 대본 전문 또는 시놉시스 (한국어)
 * @param {Object} [ctx]
 * @param {string} [ctx.title] 작품 제목. 없으면 생략한다
 * @param {Array}  [ctx.known] 이미 판에 있는 노드 [{id, kind, name}]. id 를 다시 쓰게 한다
 * @param {{i: number, n: number}} [ctx.part] 긴 대본을 나눠 넣을 때의 조각 번호
 * @param {number} [ctx.maxNodes=40] 노드 상한
 * @returns {string} Bedrock 에 그대로 넣는 프롬프트. 길이는 PROMPT_MAX 이하가 보장된다
 */
export function extractGraphPrompt(text, ctx = {}) {
  const max = ctx.maxNodes || 40
  const part = ctx.part && ctx.part.n > 1 ? ctx.part : null

  return withBody([
    part
      ? `아래는 한 작품을 ${part.n}조각으로 나눈 것 중 ${part.i}번째다. 이 조각에서 인물과 관계를 뽑는다.`
      : '아래 글에서 인물과 관계를 뽑아 관계 그래프로 만든다.',
    ctx.title ? `작품: ${ctx.title}` : null,
    '',
    '글:',
  ].filter((l) => l !== null), text, [
    '',
    `이미 판에 있는 노드 (같은 대상이면 이 id 를 다시 쓴다):\n${knownLines(ctx.known)}`,
    '',
    JSON_ONLY,
    '{"nodes":[{"id":"rumi","kind":"Character","name":"루미","props":{"age":22,"role":"헌트릭스 리더·보컬","desc":"한 줄 설명"}}],',
    ' "edges":[{"s":"rumi","p":"loves","o":"jinu","asserted":true,"props":{"tension":0.7,"cause":"왜 그런지 한 줄"}}]}',
    '',
    `노드 kind 는 다음 중 하나다.\n${kindLines()}`,
    '',
    `엣지 술어(p)는 다음 중 하나다.\n${relLines()}`,
    '',
    '노드 규칙',
    `- 노드는 최대 ${max}개. 이야기를 움직이는 것만 남긴다.`,
    '- 모든 노드는 id 와 name 을 반드시 가진다. name 이 없는 노드는 만들지 않는다.',
    '- id 는 이름의 영문 로마자 소문자와 밑줄만 쓴다 (루미 → rumi, 사자보이즈 → saja_boys). 통용 표기가 있으면 그것을 쓴다.',
    '- name 은 글에 나온 한국어 이름 그대로 쓴다.',
    '- 같은 인물의 별명·호칭·직함은 노드 하나로 합친다. 이름이 여럿이면 가장 많이 불리는 것을 name 으로 한다.',
    '- Character props: age(알 수 있으면 숫자, 모르면 넣지 않는다), role(작품 안에서의 위치), desc(성격이나 처지를 한 줄).',
    '- Location 은 반복해서 나오는 주요 장소만. 한 번 스쳐가는 배경은 넣지 않는다.',
    '- Event 는 이후 관계를 바꾼 핵심 사건만. 일상적인 장면은 넣지 않는다. props.t 에 현재를 0으로 둔 상대 시점을 넣는다 (과거는 음수).',
    '- Secret 은 특정 인물만 아는 정보다. props.claim 에 그 내용을 한 줄로 적는다.',
    '- Secret 도 한국어 name 을 반드시 가진다. 무엇에 관한 비밀인지 짧은 명사구로 적는다.',
    '  예: {"id":"secret_exgf","kind":"Secret","name":"전 여자친구 관계","props":{"claim":"진우에게 숨긴 옛 연인이 있다"}}',
    '- Faction 은 집단·조직·팀이다.',
    '',
    '엣지 규칙',
    '- 글에 드러난 관계만 뽑는다. 짐작으로 잇지 않는다.',
    '- asserted 는 항상 true 로 둔다. 추론 엣지는 뒤 단계에서 따로 만든다.',
    `- ${GRAPH_SCHEMA.derivedRels.join(', ')} 는 여기서 쓰지 않는다.`,
    '- props.tension 은 0~1 사이 숫자로 갈등의 세기, props.cause 는 그렇게 본 근거를 한 줄로. 알 수 없으면 넣지 않는다.',
    '- loves 는 단방향이다. 서로 좋아하면 엣지를 두 개 만든다.',
    '- kin_of 는 props.type 에 parent, child, sibling, spouse 중 하나를 적는다.',
    '- conceals 는 비밀을 감춘 인물 → Secret, hidden_from 은 Secret → 모르는 인물 방향이다.',
    '- s 와 o 는 위 nodes 에 있는 id 여야 한다.',
    '- 한국어로 쓴다. id 만 로마자다.',
  ], '(글이 길어 여기서 잘랐다)')
}

/**
 * Final Draft(.fdx)나 텍스트 대본을 추출에 넣을 평문으로 만든다.
 * .fdx 는 XML 이라 태그를 그대로 넣으면 토큰만 먹는다. 지시문·대사만 남긴다.
 *
 * @param {string} raw - 파일 내용
 * @param {string} [name] - 파일 이름. 확장자로 형식을 가린다
 * @returns {string} 평문 대본
 */
export function chunkText(text, size = GRAPH_CHUNK) {
  const s = String(text || '').trim()
  if (!s) return []
  if (s.length <= size) return [s]
  const out = []
  let cur = ''
  for (const block of s.split(/\n{2,}/)) {
    if (cur && cur.length + block.length + 2 > size) { out.push(cur); cur = '' }
    cur = cur ? `${cur}\n\n${block}` : block
    while (cur.length > size) { out.push(cur.slice(0, size)); cur = cur.slice(size) }
  }
  if (cur.trim()) out.push(cur)
  return out
}

// ── 긴 대본은 먼저 줄인다 ─────────────────────────────────────────────────────
// 조각마다 그래프를 뽑으면 조각 수만큼 (조각 + 규칙 블록) 프롬프트가 만들어져 상한에
// 걸리기 쉽고, 조각을 넘나드는 관계도 조각 안에서는 보이지 않는다. 그래서 긴 대본은
// 요약을 한 번 거쳐 짧게 만든 뒤 추출을 한 번만 돈다.
//   긴 대본 → summarizeForExtraction → extractGraphPrompt → normalizeGraph

/** 이 길이부터 먼저 요약한다. 이 밑은 예전처럼 바로 추출한다 */
export const SUMMARY_CHARS = 2000
/** 요약 응답 토큰 상한. 요약은 짧으니 이만큼이면 넉넉하다 */
export function summarizePrompt(text, opts = {}) {
  const limit = numOr(opts.limit, SUMMARY_CHARS)
  const part = opts.part && opts.part.n > 1 ? opts.part : null

  return withBody([
    `아래 대본의 핵심 인물, 관계, 사건, 비밀만 ${limit}자 이내로 요약해.`
      + ' 인물 이름, 나이, 역할, 관계를 빠짐없이 포함할 것.',
    part ? `아래는 한 대본을 ${part.n}조각으로 나눈 것 중 ${part.i}번째다. 이 조각만 요약한다.` : null,
    opts.title ? `작품: ${opts.title}` : null,
    '',
    '대본:',
  ].filter((l) => l !== null), text, [
    '',
    '규칙',
    '- 인물 이름은 대본에 나온 그대로 쓴다. 별명·호칭이 여럿이면 가장 많이 불리는 것을 쓴다.',
    '- 인물마다 나이·역할·소속을 알 수 있는 만큼 적는다.',
    '- 누가 누구를 어떻게 여기는지(사랑·불신·적대·보호 등)를 빠뜨리지 않는다.',
    '- 사건은 관계를 바꾼 것만, 일어난 순서로 적는다.',
    '- 비밀은 그 내용과 함께 누가 감추고 누가 아는지·모르는지를 적는다.',
    '- 대사·화면 묘사·장면 지시는 옮기지 않는다.',
    '- 요약문만 출력한다. 머리말·설명·코드펜스를 붙이지 않는다.',
    '- 한국어로 쓴다.',
  ], '(대본이 길어 여기서 잘랐다)')
}

/**
 * 긴 대본을 그래프 추출에 넣을 요약본으로 줄인다. planGraph 의 1단계다.
 * 원문이 한 프롬프트에 들어가지 않으면 조각으로 나눠 요약하고 이어 붙인다. * 조각마다 그래프를 뽑는 것보다 이쪽이 싸고, 이어 붙인 요약은 한 번에 추출된다.
 *
 * @param {Object} net - net.plan({prompt, maxTokens, think}) 를 가진 객체
 * @param {string} source - 대본 평문 (scriptToText 를 먼저 거친 것)
 * @param {Object} [ctx]
 * @param {string} [ctx.title] 작품 제목
 * @param {string} [ctx.model] 쓸 모델 ('haiku-4.5' | 'sonnet-5' | 'opus-4.8')
 * @returns {Promise<{text: string, warnings: Array<string>}>} 요약본. 다 실패하면 throw 한다
 */
const CTX_NODES = 24

/** 컨텍스트 팩 글자 상한. 자리가 남아도 이만큼만 넣는다 (packFor) */
export const CTX_BUDGET = 3200
/** 한 줄에 붙는 설명(desc·claim) 상한. 추출본의 desc 는 문단째로 오는 경우가 있다 */
const CTX_DESC = 70
/** 분기 응답 토큰 상한. 30초 안에 끝나야 하므로 낮춰 둔다 */
export const BRANCH_TOKENS = 2000
/** 기획자의 자유 방향 상한. 이것도 프롬프트에 들어가니 못 박아 둔다 */
const DIR_MAX = 1200

const nm = (store, id) => store.getNode(id)?.name || String(id)
const tNum = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt)

/** 여러 줄로 오는 설명을 한 줄로 눕히고 상한에서 자른다 */
const oneLine = (v, n) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** 컨텍스트 팩의 목록 블록 하나. max 를 넘는 줄은 접어 두고 몇 줄 접었는지만 남긴다 */
const ctxBlock = (head, lines, keep, max) => ({
  head, keep, lines: lines.slice(0, max), dropped: Math.max(0, lines.length - max),
})

const ctxText = (b) => {
  if (!b.lines.length) return ''
  return [b.head, ...b.lines, ...(b.dropped ? [`- (${b.dropped}줄 더 있지만 생략했다)`] : [])].join('\n')
}

/** 블록들을 예산 안으로 줄인다. 지금 가장 긴 블록의 뒤에서 한 줄씩 덜어낸다 */
const trimCtx = (blocks, budget) => {
  const size = () => blocks.reduce((a, b) => a + (b.lines.length ? ctxText(b).length + 2 : 0), 0)
  while (size() > budget) {
    const big = blocks.filter((b) => b.lines.length > b.keep)
      .sort((x, y) => ctxText(y).length - ctxText(x).length)[0]
    if (!big) break
    big.lines = big.lines.slice(0, -1)
    big.dropped += 1
  }
  return blocks
}

/** 이 엣지를 사람이 읽는 한 줄로. 명시인지 추론인지도 같이 적는다 */
const edgeLine = (store, e) => {
  const arrow = GRAPH_SCHEMA.rels[e.p]?.dir === 'sym' ? '↔' : '→'
  const t = e.props?.tension
  const mark = e.asserted === false ? `추론${e.props?.derived_by ? ` ${e.props.derived_by}` : ''}` : '명시'
  const why = e.props?.cause ? ` · ${e.props.cause}` : ''
  return `- ${nm(store, e.s)} ${arrow} ${nm(store, e.o)} : ${e.p}`
    + `${t === undefined ? '' : ` (긴장 ${t})`} [${mark}]${why}`
}

/** 씨앗 주변으로 컨텍스트에 넣을 노드 id 를 고른다. 초점 → 이웃 순 */
const ctxScope = (seed, store, limit = CTX_NODES) => {
  const focus = (seed?.focus || []).filter((id) => store.getNode(id))
  if (!focus.length) return store.getNodes().slice(0, limit).map((n) => n.id)
  const out = [...new Set(focus)]
  for (const n of store.getNeighbors(focus[0], { depth: 1 })) if (!out.includes(n.id)) out.push(n.id)
  for (const id of focus.slice(1)) {
    for (const n of store.getNeighbors(id, { depth: 1 })) if (!out.includes(n.id)) out.push(n.id)
  }
  return out.slice(0, limit)
}

/**
 * 씨앗에 관련된 서브그래프를 LLM 이 읽을 텍스트로 편다. #1 파이프라인의 ContextPack 자리다.
 * 씨앗이 null 이면(자유 입력 우회로) 그래프 전체를 요약해서 대신 넣는다.
 *
 * @param {Object|null} seed - findSeeds 가 준 씨앗 하나 {probe, score, title, desc, focus}
 * @param {Object} store - GraphStore
 * @param {Object} [opts]
 * @param {number} [opts.limit=CTX_BUDGET] 팩 전체 글자 상한. 넘치면 큰 블록부터 줄을 덜어낸다
 * @returns {string} 프롬프트에 그대로 붙이는 컨텍스트 텍스트
 */
export function contextPackPrompt(seed, store, opts = {}) {
  if (!store?.getNodes) return '(그래프가 없다)'
  const scope = ctxScope(seed, store)
  const sub = store.getSubgraph(scope)
  const kind = (k) => sub.nodes.filter((n) => n.kind === k)
  const stats = store.stats()

  const chars = kind('Character').map((n) => {
    const p = n.props || {}
    const head = [p.age ? `${p.age}세` : null, p.role].filter(Boolean).join(', ')
    const desc = oneLine(p.desc, CTX_DESC)
    return `- ${n.name}${head ? ` (${head})` : ''}${desc ? ` · ${desc}` : ''}`
  })
  const groups = [...kind('Faction'), ...kind('Location'), ...kind('Object')].map((n) => {
    const desc = oneLine(n.props?.desc, CTX_DESC)
    return `- ${n.name} (${n.kind})${desc ? ` · ${desc}` : ''}`
  })

  const isSide = (id) => ['Secret', 'Event'].includes(store.getNode(id)?.kind)
  const rels = sub.edges.filter((e) => !isSide(e.s) && !isSide(e.o)).map((e) => edgeLine(store, e))

  const events = kind('Event')
    .sort((a, b) => tNum(a.props?.t) - tNum(b.props?.t))
    .map((n) => {
      const cast = store.getEdgesTo(n.id).filter((e) => e.p === 'participated_in').map((e) => nm(store, e.s))
      const after = store.getEdgesFrom(n.id)
        .filter((e) => ['caused', 'enabled', 'resolves'].includes(e.p))
        .map((e) => `${e.p} ${nm(store, e.o)}`)
      const desc = oneLine(n.props?.desc, CTX_DESC)
      // 빈 절은 아예 빼서 줄을 짧게 유지한다. "(없음)" 은 모델에 주는 정보가 없다
      return `- t=${tNum(n.props?.t)} ${n.name}${desc ? ` · ${desc}` : ''}`
        + `${cast.length ? ` / 참여: ${cast.join(', ')}` : ''}${after.length ? ` / 결과: ${after.join(', ')}` : ''}`
    })

  const secrets = kind('Secret').map((n) => {
    const inbound = store.getEdgesTo(n.id)
    const hold = inbound.filter((e) => e.p === 'conceals').map((e) => nm(store, e.s))
    const know = inbound.filter((e) => e.p === 'knows').map((e) => nm(store, e.s))
    const dark = store.getEdgesFrom(n.id).filter((e) => e.p === 'hidden_from').map((e) => nm(store, e.o))
    return `- ${n.name}: "${oneLine(n.props?.claim, CTX_DESC)}" / 감춘 이: ${hold.join(', ') || '(없음)'}`
      + ` / 아는 이: ${know.join(', ') || '(없음)'} / 모르는 이: ${dark.join(', ') || '(없음)'}`
  })

  const probe = seed ? PROBES[seed.probe] : null
  const head = seed
    ? `[씨앗] ${probe?.label || seed.probe} (점수 ${Number(seed.score).toFixed(2)})`
      + `\n${oneLine(seed.title, 120)}\n${oneLine(seed.desc, 200)}`
    : '[씨앗] 없다. 기획자가 방향을 직접 준다'
  const flaw = seed
    ? `[구조적 결함] 탐지기 ${seed.probe}\n${oneLine(probe?.hint, 140)}`
      + `\n초점: ${(seed.focus || []).map((id) => nm(store, id)).join(', ')}`
    : null
  const scale = `[전체 규모] 노드 ${stats.nodes} · 명시 엣지 ${stats.assertedEdges} · 추론 엣지 ${stats.derivedEdges}`
    + `${scope.length < stats.nodes ? ` (위에는 씨앗 주변 ${sub.nodes.length}개만 넣었다)` : ''}`

  // 씨앗·결함·규모는 짧고 항상 필요하다. 남는 예산만 목록 블록이 나눠 쓴다.
  const fixed = [head, flaw, scale].filter(Boolean).join('\n\n').length
  const b = {
    chars: ctxBlock('[인물]', chars, 4, 14),
    groups: ctxBlock('[집단·장소·사물]', groups, 2, 10),
    rels: ctxBlock('[관계] → 는 단방향, ↔ 는 서로', rels, 6, 36),
    events: ctxBlock('[사건] 시간 순, t 는 현재를 0 으로 둔 상대 시점', events, 2, 12),
    secrets: ctxBlock('[비밀] 누가 알고 누가 모르는가', secrets, 2, 8),
  }
  trimCtx(Object.values(b), Math.max(400, (opts.limit || CTX_BUDGET) - fixed))

  return [head, ctxText(b.chars), ctxText(b.groups), ctxText(b.rels), ctxText(b.events),
    ctxText(b.secrets), flaw, scale].filter(Boolean).join('\n\n')
}

const STORY_SHAPE = [
  '{"title":"제목","logline":"1~2문장 요약",',
  ' "pivot":{"title":"무엇이 갈리는가","body":"어느 인물의 어떤 관계가 갈리는지 한 문장"},',
  ' "branches":[{"id":"A","label":"짧은 제목","tone":"방식/결과 힌트","premise":"2문장 전개 요약",',
  '   "beats":["한 장면을 한 문장으로"],',
  '   "outcome":{"인물 이름":"이 분기에서 그 인물이 맞는 결과 한 줄"},',
  '   "writeback":{"nodes":[{"name":"새 사건 이름","kind":"Event","t":0,"desc":"한 줄 설명"}],',
  '     "edges":[{"s":"루미","p":"calls_true_name","o":"진우","note":"왜 생기는지 짧게"}],',
  '     "remove_edges":[{"s":"진우","p":"serves","o":"귀마","note":"왜 끊기는지 짧게"}]}}]}',
].join('\n')

const branchRules = (existingGraph) => {
  const g = existingGraph && typeof existingGraph === 'object' ? existingGraph : { nodes: [], edges: [] }
  return [
    '규칙',
    '- branches 는 정확히 3개. id 는 A, B, C 로 붙인다.',
    '- 각 분기의 beats 는 3~4개. 한 비트는 한 장면이고, 카메라에 보이는 일만 한 문장으로 적는다.',
    '- 세 분기는 서로 다른 선택이어야 한다. 같은 결말로 수렴하지 않는다.',
    '- 분기마다 writeback 이 달라야 한다. 서로 다른 엣지를 넣거나 끊는다.',
    '- writeback.nodes 는 분기마다 최대 2개, edges 는 1~3개로 둔다.',
    '- outcome 은 이 분기에서 실제로 달라지는 인물 2~3명만 넣는다.',
    '- 짧게 쓴다. 같은 말을 두 번 쓰지 않고, 이미 컨텍스트에 있는 설명은 되풀이하지 않는다.',
    '- writeback.nodes 의 kind 는 다음 중 하나다: ' + GRAPH_SCHEMA.nodeKinds.join(', '),
    `- writeback 의 술어(p)는 다음 중 하나만 쓴다.\n${relLines()}`,
    `- ${GRAPH_SCHEMA.derivedRels.join(', ')} 는 쓰지 않는다. 추론은 뒤 단계가 만든다.`,
    '- writeback edges 의 s·o 에는 위 컨텍스트에 나온 이름이나, 이 분기의 writeback.nodes 에서 새로 만든 이름만 쓴다.',
    '- remove_edges 에는 위 [관계]·[사건]에 실제로 있는 엣지만 넣는다. 끊을 것이 없으면 빈 배열로 둔다.',
    '- outcome 의 키는 인물 이름이다. 씨앗의 초점 인물은 빠뜨리지 않는다.',
    // 노드만 적고 이을 엣지를 빠뜨리면 판에 섬 노드가 뜬다. 첫 겹은 여기서 막는다
    '- writeback.nodes 에 넣은 새 노드는 하나도 빠짐없이 writeback.edges 에서 최소 한 개의 엣지로'
      + ' 위 컨텍스트에 있는 노드와 잇는다. 어디에도 닿지 않는 노드는 만들지 않는다.',
    '- 엣지의 s·o 가 같은 writeback 의 새 노드를 가리켜도 된다. nodes 와 edges 의 순서는 상관없다.',
    // 이 글은 작가·PD 가 그대로 읽는다. 화면에 찍히는 자리에 그래프 용어가 새면 안 된다
    '- title·logline·pivot·premise·beats·outcome 은 작가가 읽는 글이다. "엣지" · "노드" · "t=0" 같은'
      + ' 그래프 용어나 영문 술어(loves, serves 같은 것)를 쓰지 않고, 인물과 사건의 말로 쓴다.'
      + ' 술어는 writeback 안에서만 쓴다.',
    `- 지금 그래프는 노드 ${(g.nodes || []).length}개, 엣지 ${(g.edges || []).length}개다. 없는 인물이 필요하면 writeback.nodes 에 kind:"Character" 로 만든다.`,
    '- 한국어로 쓴다.',
  ].join('\n')
}

/**
 * 씨앗 하나로 분기 3개를 만드는 프롬프트. outlinePrompt/cutsPrompt 와 같은 호출 계약이다.
 * 출력 JSON 은 app-walkthrough/data/stories.json 의 스토리 하나와 같은 모양이다.
 *
 * @param {Object|null} seed - 씨앗
 * @param {string} contextPack - contextPackPrompt 의 반환값
 * @param {Object} existingGraph - 지금 그래프 {nodes, edges}. 역기입 계획에 쓴다
 * @returns {string} Bedrock 에 그대로 넣는 프롬프트. 길이는 PROMPT_MAX 이하가 보장된다
 */
export function branchPrompt(seed, contextPack, existingGraph) {
  return withBody(
    [
      '아래 관계 그래프에서 찾은 씨앗 하나를 이야기 분기 3개로 편다.',
      '씨앗은 그래프의 구조적 결함이다. 그 결함을 어떻게 건드리느냐에 따라 이야기가 갈린다.',
      '',
    ],
    contextPack,
    ['', JSON_ONLY, STORY_SHAPE, '', branchRules(existingGraph)],
  )
}

/**
 * 기획자가 준 방향으로 분기를 다시 만드는 프롬프트.
 * "그래프가 제안하고 기획자가 틀어주는" 우회로다. 씨앗은 없어도 된다.
 *
 * @param {string} userInput - 기획자가 적은 자유 방향
 * @param {Object|null} seed - 지금 고른 씨앗. 없으면 null
 * @param {string} contextPack - contextPackPrompt 의 반환값
 * @param {Object} existingGraph - 지금 그래프 {nodes, edges}
 * @returns {string} 프롬프트
 */
export function freeDirectionPrompt(userInput, seed, contextPack, existingGraph) {
  const dir = String(userInput || '').trim().slice(0, DIR_MAX)
  // 기획자의 방향은 머리말에 둔다. 자리가 모자라면 컨텍스트 팩이 먼저 줄어든다
  return withBody(
    [
      '아래 관계 그래프를 바탕으로 이야기 분기 3개를 만든다.',
      '방향은 기획자가 정했다. 탐지기가 찾은 씨앗보다 기획자의 지시가 먼저다.',
      '',
      `[기획자의 방향]\n${dir || '(비어 있다. 그래프에서 가장 큰 긴장을 골라 쓴다)'}`,
      '',
    ],
    contextPack,
    ['', JSON_ONLY, STORY_SHAPE, '', branchRules(existingGraph),
      '- 세 분기 모두 기획자의 방향 안에 있어야 한다. 방향을 벗어난 분기는 만들지 않는다.',
      '- 방향이 그래프의 사실과 어긋나면, 어긋나는 지점을 pivot.body 에 한 문장으로 적는다.'],
  )
}

/** 이름으로 와도 노드를 찾는다. 역기입 엣지의 s·o 는 이름으로 오는 경우가 많다 */
