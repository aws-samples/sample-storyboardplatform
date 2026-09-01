
import { normalizePlan, normalizeGraph, validateAgainstCanon, mergeGraphs, splitScenario, CAMERAS } from './core.js'
import { GRAPH_SCHEMA, deriveEdges } from './graph-schema.js'

export const MODES = [
  { id: 'new', label: '새 스토리', hint: '프롬프트 하나로 이야기·인물·컷을 처음부터' },
  { id: 'next', label: '다음 회차', hint: '지금 판의 인물과 사건을 이어서' },
  { id: 'spin', label: '스핀오프', hint: '한 인물을 주인공으로 갈라 나온 이야기' },
]

export const GENRES = ['브랜드 필름', '드라마', '코미디', '스릴러', '판타지', '다큐멘터리', '뮤직비디오', '애니메이션']
export const TONES = ['따뜻한', '담백한', '유쾌한', '긴장된', '서늘한', '몽환적인', '씩씩한']
export const LENGTHS = [15, 30, 60, 120, 300]
export const CUTCOUNTS = [6, 8, 12, 16, 24]

const beatCount = (cuts) => Math.min(8, Math.max(3, Math.round(cuts / 2)))
const perBeat = (cuts, beats) => Math.max(1, Math.round(cuts / Math.max(1, beats)))
const BATCH = 4
const HARD_MAX = 40

const JSON_ONLY = '오직 아래 모양의 JSON 하나만 출력한다. 설명·머리말·코드펜스를 붙이지 않는다.'

const roster = (chars) =>
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
    `${from + i + 1}. ${b.scene || `S${from + i + 1}`} — ${b.action} (${b.secs}초, 등장: ${b.cast.join(', ') || '없음'})`)

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

const GRAPH_CHUNK = 6000
const GRAPH_MAX_CHUNKS = 12
const GRAPH_SRC_MAX = 12000

const relLines = () => GRAPH_SCHEMA.assertableRels.map((p) => `  ${p} — ${GRAPH_SCHEMA.rels[p].desc}`).join('\n')
const kindLines = () => GRAPH_SCHEMA.nodeKinds.map((k) => `  ${k} — ${GRAPH_SCHEMA.nodeKindDesc[k]}`).join('\n')
const knownLines = (known) => (known || []).length
  ? known.map((n) => `- ${n.id} (${n.kind}) ${n.name}`).join('\n')
  : '(없음)'

/**
 * 대본·시놉시스 텍스트에서 관계 그래프를 뽑는 프롬프트.
 * 출력 모양은 mock/graph.json 과 같아야 한다. 그래야 뷰어가 그대로 읽는다.
 *
 * @param {string} text - 대본 전문 또는 시놉시스 (한국어)
 * @param {Object} [ctx]
 * @param {string} [ctx.title] 작품 제목. 없으면 생략한다
 * @param {Array}  [ctx.known] 이미 판에 있는 노드 [{id, kind, name}]. id 를 다시 쓰게 한다
 * @param {{i: number, n: number}} [ctx.part] 긴 대본을 나눠 넣을 때의 조각 번호
 * @param {number} [ctx.maxNodes=40] 노드 상한
 * @returns {string} Bedrock 에 그대로 넣는 프롬프트
 */
export function extractGraphPrompt(text, ctx = {}) {
  const max = ctx.maxNodes || 40
  const part = ctx.part && ctx.part.n > 1 ? ctx.part : null
  const src = String(text || '').slice(0, GRAPH_SRC_MAX)

  return [
    part
      ? `아래는 한 작품을 ${part.n}조각으로 나눈 것 중 ${part.i}번째다. 이 조각에서 인물과 관계를 뽑는다.`
      : '아래 글에서 인물과 관계를 뽑아 관계 그래프로 만든다.',
    ctx.title ? `작품: ${ctx.title}` : null,
    '',
    '글:',
    src,
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
    '- id 는 이름의 영문 로마자 소문자와 밑줄만 쓴다 (루미 → rumi, 사자보이즈 → saja_boys). 통용 표기가 있으면 그것을 쓴다.',
    '- name 은 글에 나온 한국어 이름 그대로 쓴다.',
    '- 같은 인물의 별명·호칭·직함은 노드 하나로 합친다. 이름이 여럿이면 가장 많이 불리는 것을 name 으로 한다.',
    '- Character props: age(알 수 있으면 숫자, 모르면 넣지 않는다), role(작품 안에서의 위치), desc(성격이나 처지를 한 줄).',
    '- Location 은 반복해서 나오는 주요 장소만. 한 번 스쳐가는 배경은 넣지 않는다.',
    '- Event 는 이후 관계를 바꾼 핵심 사건만. 일상적인 장면은 넣지 않는다. props.t 에 현재를 0으로 둔 상대 시점을 넣는다 (과거는 음수).',
    '- Secret 은 특정 인물만 아는 정보다. props.claim 에 그 내용을 한 줄로 적는다.',
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
  ].filter((l) => l !== null).join('\n')
}

/**
 * Final Draft(.fdx)나 텍스트 대본을 추출에 넣을 평문으로 만든다.
 * .fdx 는 XML 이라 태그를 그대로 넣으면 토큰만 먹는다. 지시문·대사만 남긴다.
 *
 * @param {string} raw - 파일 내용
 * @param {string} [name] - 파일 이름. 확장자로 형식을 가린다
 * @returns {string} 평문 대본
 */
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
 * @param {number} [size=6000] 조각 하나의 글자 수 상한
 * @returns {Array<string>} 조각 배열. 빈 텍스트면 빈 배열
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

/**
 * 텍스트에서 그래프를 뽑아 mock/graph.json 과 같은 모양으로 돌려준다.
 * 뽑은 것(asserted)에 deriveEdges 의 파생 엣지를 붙여서 준다.
 *
 * @param {Object} net - net.plan({prompt, maxTokens, think}) 를 가진 객체
 * @param {string} source - 대본·시놉시스 평문 (scriptToText 를 먼저 거친 것)
 * @param {Object} [ctx]
 * @param {string} [ctx.title] 작품 제목
 * @param {Object} [ctx.canon] 이미 확립된 {nodes, edges}. id 재사용과 모순 검사에 쓴다
 * @param {number} [ctx.maxNodes] 노드 상한
 * @returns {Promise<{nodes: Array, edges: Array, warnings: Array, conflicts: Array, compatible: boolean}>}
 */
export async function planGraph(net, source, ctx = {}) {
  const text = String(source || '').trim()
  if (!text) throw new Error('추출할 텍스트가 비어 있습니다.')
  if (!net?.plan) throw new Error('그래프 추출에는 Bedrock 연결이 필요합니다.')

  const warnings = []
  let parts = chunkText(text)
  if (parts.length > GRAPH_MAX_CHUNKS) {
    warnings.push(`텍스트가 길어 앞 ${GRAPH_MAX_CHUNKS}조각까지만 읽었다`)
    parts = parts.slice(0, GRAPH_MAX_CHUNKS)
  }
  const canon = { nodes: ctx.canon?.nodes || [], edges: ctx.canon?.edges || [] }
  const known = canon.nodes.map((n) => ({ id: n.id, kind: n.kind, name: n.name }))

  const got = await Promise.allSettled(parts.map((p, i) => ask(net,
    extractGraphPrompt(p, { ...ctx, known, part: { i: i + 1, n: parts.length } }), 4000)))

  const raws = []
  got.forEach((r, i) => {
    if (r.status === 'rejected') {
      warnings.push(`${i + 1}/${parts.length} 조각 추출 실패 — 건너뛴다: ${r.reason?.message || ''}`)
      return
    }
    raws.push(r.value)
  })
  if (!raws.length) throw new Error('그래프를 받지 못했습니다. 다시 시도해 주세요.')

  // 조각을 먼저 합친 뒤 한 번에 정규화한다. 따로 정규화하면 조각을 넘나드는 엣지가
  // 없는 노드를 가리킨다는 이유로 버려진다.
  const list = (v) => (Array.isArray(v) ? v : [])
  const merged = normalizeGraph({
    nodes: raws.flatMap((g) => list(g?.nodes ?? g?.entities)),
    edges: raws.flatMap((g) => list(g?.edges ?? g?.relations)),
  }, { maxNodes: ctx.maxNodes ? ctx.maxNodes * Math.max(1, parts.length) : undefined })
  warnings.push(...merged.warnings)

  const check = validateAgainstCanon(merged, canon)
  const derived = deriveEdges(merged.nodes, merged.edges)
  return {
    nodes: merged.nodes,
    edges: [...merged.edges, ...derived],
    warnings,
    conflicts: check.conflicts,
    compatible: check.compatible,
  }
}

/**
 * 뽑은 그래프를 이미 확립된 그래프에 얹는다. 파생 엣지는 합친 결과에서 다시 만든다.
 *
 * @param {Object} canon - 기존 {nodes, edges}
 * @param {Object} next - planGraph 결과
 * @returns {{nodes: Array, edges: Array, conflicts: Array, compatible: boolean}}
 */
export function commitGraph(canon, next) {
  const check = validateAgainstCanon(next, canon)
  const base = mergeGraphs(
    { nodes: canon?.nodes || [], edges: (canon?.edges || []).filter((e) => e.asserted !== false) },
    { nodes: next?.nodes || [], edges: (next?.edges || []).filter((e) => e.asserted !== false) },
  )
  return { ...base, edges: [...base.edges, ...deriveEdges(base.nodes, base.edges)], ...check }
}

export function parseJson(text) {
  const s = String(text || '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('기획 결과를 읽지 못했습니다. 다시 시도해 주세요.')
  try {
    return JSON.parse(s.slice(a, b + 1))
  } catch {
    throw new Error('기획 결과가 깨져서 왔습니다. 다시 시도해 주세요.')
  }
}

const ask = async (net, prompt, maxTokens) =>
  parseJson((await net.plan({ prompt, maxTokens, think: false })).text)

export async function planOutline(net, spec, ctx) {
  if (!net?.plan) return localOutline(spec, ctx)
  const p = normalizePlan(await ask(net, outlinePrompt(spec, ctx), 3000), {
    maxChars: spec.newChars,
    maxCuts: 12,
  })
  if (!p.cuts.length) throw new Error('비트를 받지 못했습니다. 다시 시도해 주세요.')
  return { ...p, beats: p.cuts, local: false }
}

export async function planCuts(net, spec, outline) {
  if (!net?.plan) return localCuts(spec, outline)
  const per = perBeat(spec.cuts, outline.beats.length)
  const batches = []
  for (let i = 0; i < outline.beats.length; i += BATCH) batches.push(outline.beats.slice(i, i + BATCH))

  const got = await Promise.allSettled(
    batches.map((b, i) => ask(net, cutsPrompt(spec, outline, b, i * BATCH, per), 2500)))

  const out = []
  got.forEach((r, i) => {
    const cuts = r.status === 'fulfilled'
      ? normalizePlan(r.value, { maxChars: 0, maxCuts: batches[i].length * per + 2 }).cuts
      : []
    if (r.status === 'rejected') console.warn('[story] 컷 묶음 실패 — 비트로 대체한다', r.reason?.message)
    out.push(...(cuts.length ? cuts : batches[i]))
  })
  return out.slice(0, Math.min(HARD_MAX, spec.cuts + 6))
}

const LOCAL_NAMES = ['가온', '노을', '바다', '한결']

function localOutline(spec, ctx) {
  const lines = String(spec.prompt || '').split(/[.\n]/).map((s) => s.trim()).filter(Boolean)
  const nb = beatCount(spec.cuts)
  const cast = spec.useChars ? ctx.chars.map((c) => c.name).slice(0, 2) : []
  const chars = LOCAL_NAMES.slice(0, spec.newChars).map((name) => ({
    name, brief: `${spec.tone} 분위기의 인물 (로컬 모드 임시)`,
  }))
  const p = normalizePlan({
    title: lines[0] || '새 스토리',
    logline: spec.prompt,
    synopsis: spec.prompt,
    chars,
    beats: Array.from({ length: nb }, (_, i) => ({
      scene: `S${i + 1}`,
      summary: lines[i % Math.max(1, lines.length)] || `${spec.prompt} — 비트 ${i + 1}`,
      secs: spec.secs / nb,
      cast: [...cast, ...chars.map((c) => c.name)],
    })),
  }, { maxChars: spec.newChars, maxCuts: 12 })
  return { ...p, beats: p.cuts, local: true }
}

function localCuts(spec, outline) {
  const per = perBeat(spec.cuts, outline.beats.length)
  const out = []
  for (const b of outline.beats) {
    const parts = splitScenario(b.action).slice(0, per)
    const list = parts.length ? parts : [{ action: b.action, dialogue: '', camera: b.camera }]
    for (const c of list) {
      out.push({ ...c, scene: b.scene, cast: b.cast, secs: Math.max(0.5, Math.round((b.secs / list.length) * 10) / 10) })
    }
  }
  return out.slice(0, HARD_MAX)
}
