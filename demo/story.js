
import {
  normalizePlan, normalizeGraph, normalizeStory, validateAgainstCanon, mergeGraphs, splitScenario, josa, CAMERAS,
} from './core.js'
import { GRAPH_SCHEMA, deriveEdges, edgeKey } from './graph-schema.js'
import { PROBES, findSeeds } from './graph-probes.js'

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

const asList = (v) => (Array.isArray(v) ? v : [])
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const numOr = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt)

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

// ── 씨앗 → 분기 스토리 ────────────────────────────────────────────────────────
// 컨텍스트 팩(씨앗 주변 서브그래프를 텍스트로 편 것) → 분기 프롬프트 → mock/stories.json
// 모양의 결과. 자유 입력은 같은 자리에 기획자의 방향만 얹는다.

/** 컨텍스트 팩에 넣는 노드 상한. 씨앗 주변만 보면 되니 전체를 넣지 않는다 */
const CTX_NODES = 24

const nm = (store, id) => store.getNode(id)?.name || String(id)
const tNum = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Number(v) : dflt)

/** 이 엣지를 사람이 읽는 한 줄로. 명시인지 추론인지도 같이 적는다 */
const edgeLine = (store, e) => {
  const arrow = GRAPH_SCHEMA.rels[e.p]?.dir === 'sym' ? '↔' : '→'
  const t = e.props?.tension
  const mark = e.asserted === false ? `추론${e.props?.derived_by ? ` ${e.props.derived_by}` : ''}` : '명시'
  const why = e.props?.cause ? ` — ${e.props.cause}` : ''
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
 * @returns {string} 프롬프트에 그대로 붙이는 컨텍스트 텍스트
 */
export function contextPackPrompt(seed, store) {
  if (!store?.getNodes) return '(그래프가 없다)'
  const scope = ctxScope(seed, store)
  const sub = store.getSubgraph(scope)
  const kind = (k) => sub.nodes.filter((n) => n.kind === k)
  const stats = store.stats()

  const chars = kind('Character').map((n) => {
    const p = n.props || {}
    const head = [p.age ? `${p.age}세` : null, p.role].filter(Boolean).join(', ')
    return `- ${n.name}${head ? ` (${head})` : ''}${p.desc ? ` — ${p.desc}` : ''}`
  })
  const groups = [...kind('Faction'), ...kind('Location'), ...kind('Object')]
    .map((n) => `- ${n.name} (${n.kind})${n.props?.desc ? ` — ${n.props.desc}` : ''}`)

  const isSide = (id) => ['Secret', 'Event'].includes(store.getNode(id)?.kind)
  const rels = sub.edges.filter((e) => !isSide(e.s) && !isSide(e.o)).map((e) => edgeLine(store, e))

  const events = kind('Event')
    .sort((a, b) => tNum(a.props?.t) - tNum(b.props?.t))
    .map((n) => {
      const cast = store.getEdgesTo(n.id).filter((e) => e.p === 'participated_in').map((e) => nm(store, e.s))
      const after = store.getEdgesFrom(n.id)
        .filter((e) => ['caused', 'enabled', 'resolves'].includes(e.p))
        .map((e) => `${e.p} ${nm(store, e.o)}`)
      return `- t=${tNum(n.props?.t)} ${n.name}${n.props?.desc ? ` — ${n.props.desc}` : ''}`
        + ` / 참여: ${cast.join(', ') || '(없음)'} / 결과: ${after.join(', ') || '(기록 없음)'}`
    })

  const secrets = kind('Secret').map((n) => {
    const inbound = store.getEdgesTo(n.id)
    const hold = inbound.filter((e) => e.p === 'conceals').map((e) => nm(store, e.s))
    const know = inbound.filter((e) => e.p === 'knows').map((e) => nm(store, e.s))
    const dark = store.getEdgesFrom(n.id).filter((e) => e.p === 'hidden_from').map((e) => nm(store, e.o))
    return `- ${n.name}: "${n.props?.claim || ''}" / 감춘 이: ${hold.join(', ') || '(없음)'}`
      + ` / 아는 이: ${know.join(', ') || '(없음)'} / 모르는 이: ${dark.join(', ') || '(없음)'}`
  })

  const probe = seed ? PROBES[seed.probe] : null
  const block = (head, lines) => (lines.length ? [head, ...lines].join('\n') : null)

  return [
    seed
      ? `[씨앗] ${probe?.label || seed.probe} (점수 ${Number(seed.score).toFixed(2)})\n${seed.title}\n${seed.desc}`
      : '[씨앗] 없다. 기획자가 방향을 직접 준다',
    block('[인물]', chars),
    block('[집단·장소·사물]', groups),
    block('[관계] → 는 단방향, ↔ 는 서로', rels),
    block('[사건] 시간 순, t 는 현재를 0 으로 둔 상대 시점', events),
    block('[비밀] 누가 알고 누가 모르는가', secrets),
    seed
      ? `[구조적 결함] 탐지기 ${seed.probe}\n${probe?.hint || ''}\n초점: ${(seed.focus || []).map((id) => nm(store, id)).join(', ')}`
      : null,
    `[전체 규모] 노드 ${stats.nodes} · 명시 엣지 ${stats.assertedEdges} · 추론 엣지 ${stats.derivedEdges}`
      + `${scope.length < stats.nodes ? ` (위에는 씨앗 주변 ${sub.nodes.length}개만 넣었다)` : ''}`,
  ].filter(Boolean).join('\n\n')
}

const STORY_SHAPE = [
  '{"title":"이 이야기의 제목","logline":"2~3문장 요약",',
  ' "pivot":{"title":"분기점: 무엇이 갈리는가","body":"그래프의 어느 엣지가 갈리는지 한두 문장"},',
  ' "branches":[{"id":"A","label":"짧은 제목","tone":"방식/결과 힌트","premise":"3~4문장 전개 요약",',
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
    '- 각 분기의 beats 는 3~5개. 한 비트는 한 장면이고, 카메라에 보이는 일만 적는다.',
    '- 세 분기는 서로 다른 선택이어야 한다. 같은 결말로 수렴하지 않는다.',
    '- 분기마다 writeback 이 달라야 한다. 서로 다른 엣지를 넣거나 끊는다.',
    '- writeback.nodes 의 kind 는 다음 중 하나다: ' + GRAPH_SCHEMA.nodeKinds.join(', '),
    `- writeback 의 술어(p)는 다음 중 하나만 쓴다.\n${relLines()}`,
    `- ${GRAPH_SCHEMA.derivedRels.join(', ')} 는 쓰지 않는다. 추론은 뒤 단계가 만든다.`,
    '- writeback edges 의 s·o 에는 위 컨텍스트에 나온 이름이나, 이 분기의 writeback.nodes 에서 새로 만든 이름만 쓴다.',
    '- remove_edges 에는 위 [관계]·[사건]에 실제로 있는 엣지만 넣는다. 끊을 것이 없으면 빈 배열로 둔다.',
    '- outcome 의 키는 인물 이름이다. 씨앗의 초점 인물은 빠뜨리지 않는다.',
    `- 지금 그래프는 노드 ${(g.nodes || []).length}개, 엣지 ${(g.edges || []).length}개다. 없는 인물이 필요하면 writeback.nodes 에 kind:"Character" 로 만든다.`,
    '- 한국어로 쓴다.',
  ].join('\n')
}

/**
 * 씨앗 하나로 분기 3개를 만드는 프롬프트. outlinePrompt/cutsPrompt 와 같은 호출 계약이다.
 * 출력 JSON 은 mock/stories.json 의 스토리 하나와 같은 모양이다.
 *
 * @param {Object|null} seed - 씨앗
 * @param {string} contextPack - contextPackPrompt 의 반환값
 * @param {Object} existingGraph - 지금 그래프 {nodes, edges}. 역기입 계획에 쓴다
 * @returns {string} Bedrock 에 그대로 넣는 프롬프트
 */
export function branchPrompt(seed, contextPack, existingGraph) {
  return [
    '아래 관계 그래프에서 찾은 씨앗 하나를 이야기 분기 3개로 편다.',
    '씨앗은 그래프의 구조적 결함이다. 그 결함을 어떻게 건드리느냐에 따라 이야기가 갈린다.',
    '',
    contextPack,
    '',
    JSON_ONLY,
    STORY_SHAPE,
    '',
    branchRules(existingGraph),
  ].join('\n')
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
  const dir = String(userInput || '').trim().slice(0, 2000)
  return [
    '아래 관계 그래프를 바탕으로 이야기 분기 3개를 만든다.',
    '방향은 기획자가 정했다. 탐지기가 찾은 씨앗보다 기획자의 지시가 먼저다.',
    '',
    `[기획자의 방향]\n${dir || '(비어 있다 — 그래프에서 가장 큰 긴장을 골라 쓴다)'}`,
    '',
    contextPack,
    '',
    JSON_ONLY,
    STORY_SHAPE,
    '',
    branchRules(existingGraph),
    '- 세 분기 모두 기획자의 방향 안에 있어야 한다. 방향을 벗어난 분기는 만들지 않는다.',
    '- 방향이 그래프의 사실과 어긋나면, 어긋나는 지점을 pivot.body 에 한 문장으로 적는다.',
  ].join('\n')
}

/** 이름으로 와도 노드를 찾는다. 역기입 엣지의 s·o 는 이름으로 오는 경우가 많다 */
const nodeRef = (store, v) => {
  const raw = String(v ?? '').trim()
  if (store.getNode(raw)) return raw
  return store.getNodes().find((n) => n.name === raw)?.id || ''
}

/** 이 삼항이 그래프에 실제로 있나. 있으면 그 엣지를 준다 (명시인지 파생인지도 함께) */
const findEdge = (store, e) => {
  const s = nodeRef(store, e?.s)
  const o = nodeRef(store, e?.o)
  if (!s || !o) return null
  return store.getEdgesFrom(s).find((x) => x.p === e?.p && x.o === o) || null
}

/** 이 삼항이 그래프에 실제로 있나. remove_edges 검증에 쓴다 */
const hasEdge = (store, e) => !!findEdge(store, e)

/** 정규화 + 역기입 검증. 로컬 폴백과 모델 결과가 같은 모양으로 나오게 한다 */
function finishStory(raw, seed, store, { local = false } = {}) {
  const story = normalizeStory(raw)
  for (const b of story.branches) {
    const keep = []
    for (const e of b.writeback.remove_edges) {
      if (store && !hasEdge(store, e)) {
        story.warnings.push(`${b.id} 역기입 삭제: 그래프에 없는 엣지 (${e.s} ${e.p} ${e.o}) — 뺀다`)
        continue
      }
      keep.push(e)
    }
    b.writeback.remove_edges = keep
  }
  if (seed) {
    story.probe = seed.probe
    story.seed = seed
  }
  story.local = local
  return story
}

/**
 * 씨앗 하나로 분기 3개를 만든다. planOutline/planCuts 와 같은 호출 패턴이다.
 * net.plan 이 없으면 로컬 폴백으로 내려간다.
 *
 * @param {Object} net - net.plan({prompt, maxTokens, think}) 를 가진 객체. 없으면 로컬 모드
 * @param {Object|null} seed - findSeeds 가 준 씨앗
 * @param {Object} store - GraphStore
 * @param {Object} [opts]
 * @param {Array} [opts.pool] 로컬 폴백에 쓸 스토리 묶음 (mock/stories.json)
 * @returns {Promise<Object>} mock/stories.json 의 스토리 하나와 같은 모양 + {warnings, local}
 */
export async function planBranches(net, seed, store, opts = {}) {
  if (!net?.plan) return localBranches(seed, store, opts.pool)
  const context = contextPackPrompt(seed, store)
  const raw = await ask(net, branchPrompt(seed, context, store?.toJSON?.() || null), 4000)
  return finishStory(raw, seed, store)
}

/**
 * 기획자가 준 방향으로 분기를 다시 만든다. 씨앗이 없어도(0개여도) 동작한다.
 *
 * @param {Object} net - net.plan 을 가진 객체. 없으면 로컬 모드
 * @param {string} userInput - 자유 방향 텍스트
 * @param {Object|null} seed - 지금 고른 씨앗. 없으면 null 이고 컨텍스트는 그래프 전체로 채운다
 * @param {Object} store - GraphStore
 * @param {Object} [opts]
 * @param {Array} [opts.pool] 로컬 폴백에 쓸 스토리 묶음
 * @returns {Promise<Object>} planBranches 와 같은 모양
 */
export async function planFreeBranches(net, userInput, seed, store, opts = {}) {
  if (!net?.plan) return localBranches(seed, store, opts.pool, userInput)
  const context = contextPackPrompt(seed, store)
  const raw = await ask(net, freeDirectionPrompt(userInput, seed, context, store?.toJSON?.() || null), 4000)
  return finishStory(raw, seed, store)
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

/** 로컬 폴백 분기 세 갈래. 씨앗을 건드리는 방식만 다르게 둔다 */
const LOCAL_BRANCHES = [
  { label: '드러낸다', tone: '공개 / 되돌릴 수 없다', p: 'distrusts', move: '덮여 있던 것을 무대 위로 올린다' },
  { label: '덮는다', tone: '은폐 / 시간을 번다', p: 'protects', move: '한 번 더 감추고 시간을 번다' },
  { label: '제삼자가 움직인다', tone: '개입 / 판이 바뀐다', p: 'targets', move: '다른 사람이 먼저 손을 쓴다' },
]

/** 목데이터 묶음에서 이 씨앗에 맞는 스토리를 고른다. 탐지기가 같고 초점이 겹치는 것 */
const poolPick = (seed, pool) => {
  const list = (Array.isArray(pool) ? pool : []).filter((s) => s && Array.isArray(s.branches))
  if (!list.length || !seed) return null
  const focus = new Set(seed.focus || [])
  let best = null
  for (const st of list) {
    const score = (st.probe === seed.probe ? 2 : 0) + (st.focus || []).filter((id) => focus.has(id)).length
    if (!best || score > best.score) best = { st, score }
  }
  // 탐지기가 같거나 초점이 둘 이상 겹칠 때만 쓴다. 하나만 겹치는 것은 남의 이야기다
  return best && best.score >= 2 ? best.st : null
}

/**
 * Bedrock 없이 씨앗 구조만 보고 만드는 임시 분기 3개.
 * 내용이 아니라 자리를 채우는 것이 목적이다. 화면에 로컬 모드임을 적어 둔다.
 */
function dummyStory(seed, store, direction) {
  const nodes = store?.getNodes?.() || []
  const focus = (seed?.focus || []).filter((id) => store?.getNode?.(id))
  const cast = focus.filter((id) => store.getNode(id).kind === 'Character')
  const fallback = nodes.filter((n) => n.kind === 'Character').slice(0, 2).map((n) => n.id)
  const [a, b] = cast.length ? [cast[0], cast[1]] : fallback
  const nameA = a ? store.getNode(a).name : '첫 인물'
  const nameB = b ? store.getNode(b).name : ''
  const label = seed ? (PROBES[seed.probe]?.label || seed.probe) : '자유 방향'
  const dir = String(direction || '').trim()
  const anchor = seed?.title || dir || '그래프에서 가장 큰 긴장'
  // 비트에 넣을 짧은 말. 씨앗 제목의 콜론 뒤가 대개 대상 이름이다
  const core = (seed?.title ? String(seed.title).split(':').pop() : dir).trim() || '비어 있는 자리'
  // C 분기에서 끊을 엣지 — 두 초점 인물 사이에 실제로 있는 명시 엣지 하나
  const cut = a && b ? (store.getEdgesFrom(a).find((e) => e.o === b && e.asserted !== false) || null) : null

  return {
    title: seed ? seed.title : (dir ? `방향: ${dir.slice(0, 30)}` : '자유 방향 분기'),
    logline: `(로컬 모드) ${dir || seed?.desc || '그래프만 보고 만든 임시 분기다.'} `
      + 'Bedrock 에 연결하면 같은 자리에 생성 결과가 들어온다.',
    pivot: {
      title: `분기점: ${label}`,
      body: [seed ? PROBES[seed.probe]?.hint : null, dir ? `기획자의 방향: ${dir}` : null]
        .filter(Boolean).join(' ') || '그래프에서 이 자리가 아직 정해지지 않았다.',
    },
    branches: LOCAL_BRANCHES.map((t, i) => {
      const evName = `${core} — ${t.label}`.slice(0, 60)
      const edges = [a ? { s: nameA, p: 'participated_in', o: evName, note: '로컬 임시' } : null,
        a && b ? { s: nameA, p: t.p, o: nameB, note: '로컬 임시' } : null].filter(Boolean)
      return {
        id: ['A', 'B', 'C'][i],
        label: t.label,
        tone: t.tone,
        premise: `${anchor}. ${nameA}${nameB ? `${josa(nameA, '과', '와')} ${nameB}` : ''}`
          + `${josa(nameB || nameA, '이', '가')} ${t.move}.`
          + `${dir ? ` 기획자의 방향: ${dir}` : ''} 로컬 모드에서 자리만 채운 분기다.`,
        beats: [
          `${nameA}${josa(nameA, '이', '가')} ${core} 쪽으로 먼저 움직인다.`,
          `${nameB || '상대'}${josa(nameB || '상대', '이', '가')} 그것을 알아챈다. ${t.move}.`,
          `그 선택의 값이 ${nameA}에게 돌아온다.`,
        ],
        outcome: Object.fromEntries([
          [nameA, `${t.label} 쪽으로 움직인다`],
          ...(nameB && nameB !== nameA ? [[nameB, `${nameA}의 선택을 뒤늦게 안다`]] : []),
        ]),
        writeback: {
          nodes: [{ name: evName, kind: 'Event', t: 0, desc: `${t.move} (로컬 임시 사건)` }],
          edges,
          remove_edges: i === 2 && cut ? [{ s: nameA, p: cut.p, o: nameB, note: '이 분기에서 끊긴다' }] : [],
        },
      }
    }),
  }
}

/**
 * Bedrock 없이 분기를 얻는다. 목데이터 묶음에 맞는 스토리가 있으면 그것을,
 * 없으면 씨앗 구조로 만든 임시 분기 3개를 준다.
 * 기획자가 방향을 준 경우에는 그 방향이 보이도록 늘 임시 분기를 만든다.
 *
 * @param {Object|null} seed - 씨앗
 * @param {Object} store - GraphStore
 * @param {Array} [pool] - mock/stories.json 처럼 {probe, focus, branches} 를 가진 스토리 묶음
 * @param {string} [direction] - 자유 입력 방향. 있으면 목데이터를 쓰지 않는다
 * @returns {Object} planBranches 와 같은 모양 (local: true)
 */
export function localBranches(seed, store, pool, direction) {
  const hit = direction ? null : poolPick(seed, pool)
  return finishStory(hit || dummyStory(seed, store, direction), seed, store, { local: true })
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

// ── 고른 분기 → 대본 ─────────────────────────────────────────────────────────
// 새 생성 경로를 만들지 않는다. 고른 분기를 기존 기획 파이프라인이 읽는 모양으로
// 옮겨 주는 어댑터다. 개요만 분기에서 출발하고, 컷 확장은 planCuts 를 그대로 쓴다.
//   branchToSpec → planBranchOutline → planCuts → (뷰어의 applyPlan/ep.add 자리)

/** 비트를 한 줄로. normalizeStory 는 문자열과 {scene, action, secs, cast} 객체를 모두 낸다 */
const beatLine = (b) => {
  if (typeof b === 'string' || typeof b === 'number') return String(b).trim()
  const t = asObj(b)
  const head = t.scene ? `${t.scene} — ` : ''
  return `${head}${t.action || ''}`.trim()
}

/** 비트 하나를 normalizePlan 이 읽는 모양으로. 로컬 폴백 개요에 쓴다 */
const beatPlan = (b, i, secs, cast) => {
  if (typeof b === 'string' || typeof b === 'number') {
    return { scene: `S${i + 1}`, summary: String(b), secs, cast }
  }
  const t = asObj(b)
  return {
    scene: t.scene || `S${i + 1}`,
    summary: t.action || '',
    secs: numOr(t.secs, secs),
    cast: asList(t.cast).length ? t.cast : cast,
  }
}

const outcomeLines = (outcome) =>
  Object.entries(asObj(outcome)).map(([k, v]) => `- ${k}: ${v}`).join('\n')

/** 이 분기가 그래프에 남기는 것을 한 덩어리로. 개요 프롬프트에 근거로 넣는다 */
const writebackLines = (writeback) => {
  const { nodes, edges, removes } = wbParts(writeback)
  return [
    ...nodes.map((n) => `- 새 ${n?.kind || '노드'}: ${n?.name || ''}${n?.desc ? ` — ${n.desc}` : ''}`),
    ...edges.map((e) => `- 새 관계: ${e?.s} ${e?.p} ${e?.o}${e?.note ? ` (${e.note})` : ''}`),
    ...removes.map((e) => `- 끊기는 관계: ${e?.s} ${e?.p} ${e?.o}${e?.note ? ` (${e.note})` : ''}`),
  ].join('\n')
}

/**
 * 고른 분기를 기존 스토리 기획 파이프라인의 spec 으로 옮긴다.
 * 나온 spec 은 planCuts 가 그대로 읽고, prompt 에 분기 내용이 다 들어가 있어서
 * 급하면 기존 outlinePrompt 에 넣어도 뜻이 통한다.
 *
 * @param {Object} branch - planBranches 가 준 분기 하나 (mock/stories.json 의 branch 스키마)
 * @param {Object} [options]
 * @param {'next'|'spin'} [options.mode='next'] 새 회차인지 스핀오프인지. 'new' 는 쓰지 않는다
 * @param {string} [options.genre] 장르. 없으면 GENRES[0]
 * @param {string} [options.tone] 톤. 없으면 분기의 tone, 그것도 없으면 TONES[0]
 * @param {number} [options.secs=30] 러닝타임(초)
 * @param {number} [options.cuts=8] 만들 컷 수
 * @param {number} [options.newChars] 새로 만들 인물 수. 없으면 역기입의 Character 수
 * @param {boolean} [options.useChars=true] 지금 판의 인물을 그대로 쓸지
 * @returns {Object} planBranchOutline/planCuts 에 넣는 spec
 *          {mode, genre, tone, secs, cuts, newChars, useChars, prompt, branchId, branchLabel}
 */
export function branchToSpec(branch, options = {}) {
  const b = asObj(branch)
  const o = asObj(options)
  const { nodes: wbNodes } = wbParts(b.writeback)
  const newFolk = wbNodes.filter((n) => n?.kind === 'Character')
  const beats = asList(b.beats).map(beatLine).filter(Boolean)
  const outcome = outcomeLines(b.outcome)

  return {
    mode: o.mode === 'spin' ? 'spin' : 'next',
    genre: o.genre || GENRES[0],
    tone: o.tone || b.tone || TONES[0],
    secs: numOr(o.secs, 30),
    cuts: numOr(o.cuts, CUTCOUNTS[1]),
    newChars: Math.min(4, Math.max(0, o.newChars === undefined ? newFolk.length : Number(o.newChars) || 0)),
    useChars: o.useChars !== false,
    prompt: [
      `${b.label || '고른 분기'}${b.tone ? ` (${b.tone})` : ''}`,
      b.premise || '',
      beats.length ? `장면 순서:\n${beats.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : '',
      outcome ? `이 분기의 결과:\n${outcome}` : '',
    ].filter(Boolean).join('\n\n'),
    branchId: b.id || '',
    branchLabel: b.label || '',
  }
}

/**
 * 분기에서 출발하는 개요 생성 프롬프트. 기존 outlinePrompt 와 같은 구조·같은 출력이다.
 * 다른 것은 소재 자리다 — spec.prompt 대신 분기의 전개·장면·결과가 들어간다.
 *
 * @param {Object} branch - 고른 분기
 * @param {Object} spec - branchToSpec 의 반환값
 * @param {Object} [ctx] - app.js 의 planCtx() 와 같은 모양 {title, scenario, chars, centerName}
 * @returns {string} Bedrock 에 그대로 넣는 프롬프트
 */
export function branchOutlinePrompt(branch, spec, ctx = {}) {
  const b = asObj(branch)
  const s = asObj(spec)
  const mode = s.mode === 'spin' ? 'spin' : 'next'
  const secs = numOr(s.secs, 30)
  const nb = beatCount(numOr(s.cuts, CUTCOUNTS[1]))
  const keep = s.useChars === false ? [] : asList(ctx.chars)
  const beats = asList(b.beats).map(beatLine).filter(Boolean)
  const outcome = outcomeLines(b.outcome)
  const wb = writebackLines(b.writeback)
  const newChars = Math.max(0, Number(s.newChars) || 0)

  const head = {
    next: `아래 분기를 다음 회차(${secs}초)로 기획한다. 인물과 앞 사건을 잇되, 이 회차 안에서 시작하고 끝나야 한다.`,
    spin: `아래 분기를 ${ctx.centerName || '한 인물'}을 주인공으로 갈라 나온 스핀오프(${secs}초)로 기획한다.`,
  }[mode]

  return [
    head,
    '분기는 관계 그래프에서 찾은 씨앗이 갈라진 갈래다. 분기가 이미 정한 선택과 결과를 뒤집지 않는다.',
    '',
    `[고른 분기] ${b.id ? `${b.id}. ` : ''}${b.label || '(제목 없음)'}${b.tone ? ` — ${b.tone}` : ''}`,
    b.premise ? `전개: ${b.premise}` : null,
    beats.length ? `장면 순서:\n${beats.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : null,
    outcome ? `이 분기의 결과:\n${outcome}` : null,
    wb ? `이 분기가 관계 그래프에 남기는 것:\n${wb}` : null,
    '',
    `장르: ${s.genre || GENRES[0]} / 톤: ${s.tone || TONES[0]}`,
    `지금 판의 제목: ${ctx.title || '(없음)'}`,
    `지금 판의 이야기:\n${ctx.scenario || '(없음)'}`,
    `이미 있는 인물:\n${roster(keep)}`,
    '',
    JSON_ONLY,
    '{"title":"제목","logline":"한 문장 요약","synopsis":"3~5문장 줄거리",',
    ' "chars":[{"name":"이름","brief":"나이·외모·옷·분위기를 한 줄로. 그림 지시로 쓸 수 있게 구체적으로"}],',
    ' "beats":[{"scene":"S1 장소","summary":"이 비트에서 일어나는 일","secs":초,"cast":["이름"]}]}',
    '',
    '규칙',
    `- beats는 ${nb}개. secs 합계는 ${secs}초에 맞춘다.`,
    '- 위 장면 순서를 뼈대로 삼는다. 순서를 뒤집거나 결과를 다르게 만들지 않는다.',
    newChars > 0
      ? `- chars에는 새로 만드는 인물 ${newChars}명만 넣는다. 이름은 한국어로 짓는다.`
      : '- chars는 빈 배열로 둔다.',
    keep.length ? '- 이미 있는 인물은 chars에 다시 넣지 않고 cast에서 이름으로만 부른다.' : null,
    '- 대사는 여기서 쓰지 않는다. 비트는 무슨 일이 벌어지는지만 적는다.',
    '- 한국어로 쓴다.',
  ].filter((l) => l !== null).join('\n')
}

/**
 * 고른 분기를 기반으로 개요를 만든다. planOutline 과 같은 호출 계약이다.
 * 이 다음의 컷 확장은 기존 planCuts(net, spec, outline) 를 그대로 쓴다.
 *
 * @param {Object} net - net.plan({prompt, maxTokens, think}) 를 가진 객체. 없으면 로컬 모드
 * @param {Object} branch - 고른 분기
 * @param {Object} spec - branchToSpec 의 반환값
 * @param {Object} [ctx] - planCtx() 와 같은 컨텍스트
 * @returns {Promise<Object>} normalizePlan 을 통과한 {title, logline, synopsis, chars, cuts, beats, local}
 */
export async function planBranchOutline(net, branch, spec, ctx = {}) {
  if (!net?.plan) return localBranchOutline(branch, spec, ctx)
  const maxChars = Number.isFinite(Number(spec?.newChars)) ? Number(spec.newChars) : 4
  const p = normalizePlan(await ask(net, branchOutlinePrompt(branch, spec, ctx), 3000), { maxChars, maxCuts: 12 })
  if (!p.cuts.length) throw new Error('비트를 받지 못했습니다. 다시 시도해 주세요.')
  return { ...p, beats: p.cuts, local: false }
}

/**
 * Bedrock 없이 분기의 비트를 그대로 개요로 세운다. localOutline 과 같은 자리다.
 *
 * @param {Object} branch - 고른 분기
 * @param {Object} spec - branchToSpec 의 반환값
 * @param {Object} [ctx] - planCtx() 와 같은 컨텍스트
 * @returns {Object} planBranchOutline 과 같은 모양 (local: true)
 */
export function localBranchOutline(branch, spec, ctx = {}) {
  const b = asObj(branch)
  const s = asObj(spec)
  const secs = numOr(s.secs, 30)
  const newChars = Math.max(0, Number(s.newChars) || 0)
  const raw = asList(b.beats).filter((t) => (typeof t === 'string' ? t.trim() : !!asObj(t).action))
  const nb = raw.length || beatCount(numOr(s.cuts, CUTCOUNTS[1]))
  const keep = s.useChars === false ? [] : asList(ctx.chars).map((c) => c.name).slice(0, 2)
  const chars = LOCAL_NAMES.slice(0, newChars).map((name) => ({
    name, brief: `${s.tone || TONES[0]} 분위기의 인물 (로컬 모드 임시)`,
  }))
  const cast = [...keep, ...chars.map((c) => c.name)]
  const beats = (raw.length ? raw : Array.from({ length: nb }, () => b.premise || '분기의 장면'))
    .map((t, i) => beatPlan(t, i, secs / nb, cast))
  const outcome = outcomeLines(b.outcome)

  const p = normalizePlan({
    title: b.label || '분기 대본',
    logline: b.premise || b.label || '',
    synopsis: [b.premise, outcome].filter(Boolean).join('\n'),
    chars,
    beats,
  }, { maxChars: newChars, maxCuts: 12 })
  return { ...p, beats: p.cuts, local: true }
}

// ── 그래프 역기입 ─────────────────────────────────────────────────────────────
// 고른 분기의 writeback 을 그래프에 얹는다. 노드·엣지가 늘고, 끊은 명시 엣지에서
// 나왔던 파생 엣지도 같이 사라진다 (graph-engine 의 rebuild 가 매번 다시 만든다).
// 그래서 다음 회차의 탐침이 이전에는 없던 구멍을 찾는다 — 이 기능의 핵심이다.

const KIND_OK = new Set(GRAPH_SCHEMA.nodeKinds)
const REL_OK = new Set(GRAPH_SCHEMA.edgeRels)
const DERIVED_ONLY = new Set(GRAPH_SCHEMA.derivedRels)

/**
 * 역기입의 세 목록을 꺼낸다.
 * mock/stories.json 스키마({nodes, edges, remove_edges})와 지시서 스키마
 * ({add_nodes, add_edges, remove_edges})를 둘 다 받는다.
 */
function wbParts(writeback) {
  const wb = asObj(writeback)
  return {
    nodes: [...asList(wb.nodes), ...asList(wb.add_nodes)],
    edges: [...asList(wb.edges), ...asList(wb.add_edges)],
    removes: [...asList(wb.remove_edges), ...asList(wb.remove), ...asList(wb.removeEdges)],
  }
}

/** 역기입 노드를 normalizeGraph 가 읽는 {id?, kind, name, props} 로 편다 */
const wbNodeShape = (n) => {
  const src = asObj(n)
  const props = { ...asObj(src.props) }
  const t = Number(src.t ?? props.t)
  if (Number.isFinite(t)) props.t = t
  if (src.desc && !props.desc) props.desc = src.desc
  if (src.claim && !props.claim) props.claim = src.claim
  const out = { kind: src.kind, name: src.name, props }
  if (src.id) out.id = src.id
  return out
}

/** 역기입 엣지에는 note 가 있고 그래프에는 그 자리가 없다. props.cause 로 옮겨 근거를 남긴다 */
const wbEdgeShape = (e, s, p, o) => {
  const props = { ...asObj(e.props) }
  if (e.note && !props.cause) props.cause = String(e.note)
  const out = { s, p, o, asserted: true }
  if (Object.keys(props).length) out.props = props
  return out
}

/**
 * 역기입을 미리 훑어 무엇이 들어가고 무엇이 걸리는지 가른다. store 는 건드리지 않는다.
 * applyWriteback 과 validateWritebackBeforeApply 가 같은 판정을 쓰도록 한 곳에 둔다.
 *
 * errors 는 데이터가 어긋나 넣을 수 없는 것(모르는 kind·술어, 없는 노드, 정본 모순),
 * warnings 는 넣지 않고 넘어가도 되는 것(이미 있는 노드·엣지, 없는 엣지 삭제 시도).
 */
function planWriteback(store, writeback) {
  const warnings = []
  const errors = []
  if (!store?.getNode) {
    errors.push('그래프 저장소가 없다 — 역기입을 적용할 수 없다')
    return { nodes: [], edges: [], removes: [], warnings, errors, conflicts: [] }
  }
  const { nodes: rawNodes, edges: rawEdges, removes: rawRemoves } = wbParts(writeback)

  // 1. 끊을 엣지. 실제로 있는 명시 엣지만 끊는다 — 파생은 근거를 지워야 사라진다
  const removes = []
  const cutKeys = new Set()
  for (const e of rawRemoves) {
    const src = asObj(e)
    const label = `${src.s ?? '없음'} ${src.p ?? '?'} ${src.o ?? '없음'}`
    const hit = findEdge(store, src)
    if (!hit) { warnings.push(`역기입 삭제: 그래프에 없는 엣지 (${label}) — 건너뛴다`); continue }
    if (hit.asserted === false) {
      warnings.push(`역기입 삭제: 파생 엣지는 직접 삭제할 수 없습니다 (${label}) — 건너뛴다`)
      continue
    }
    const key = edgeKey(hit)
    if (cutKeys.has(key)) continue
    cutKeys.add(key)
    removes.push({ s: hit.s, p: hit.p, o: hit.o })
  }

  // 2. 새 노드. normalizeGraph 로 검증하면서 id 까지 미리 정한다 (addNodes 가 하는 것과 같다)
  const okNodes = []
  for (const n of rawNodes) {
    const src = asObj(n)
    const name = String(src.name ?? src.label ?? '').trim()
    const kind = String(src.kind ?? src.type ?? '').trim()
    if (!name) { errors.push('역기입 노드: 이름이 없다 — 노드를 버린다'); continue }
    if (!KIND_OK.has(kind)) {
      errors.push(`역기입 노드 "${name}": 모르는 kind "${kind || '없음'}" — 노드를 버린다`)
      continue
    }
    okNodes.push(src)
  }
  const g = normalizeGraph({ nodes: okNodes.map(wbNodeShape), edges: [] })
  warnings.push(...g.warnings)

  const nodes = []
  const fresh = new Map() // 이 역기입에서 새로 생기는 노드의 이름·id → 얹힌 뒤의 id
  for (const n of g.nodes) {
    const prev = store.getNode(n.id) || store.getNodes().find((x) => x.name === n.name)
    if (prev) {
      warnings.push(`역기입 노드 "${n.name}": 이미 있는 노드(${prev.id}) — 새로 만들지 않는다`)
      fresh.set(n.id, prev.id)
      fresh.set(n.name, prev.id)
      continue
    }
    nodes.push(n)
    fresh.set(n.id, n.id)
    fresh.set(n.name, n.id)
  }

  // 3. 새 엣지. 양끝은 기존 노드거나 이 역기입에서 새로 만드는 노드여야 한다
  const ref = (v) => {
    const raw = String(v ?? '').trim()
    return nodeRef(store, raw) || fresh.get(raw) || ''
  }
  const edges = []
  const addKeys = new Set()
  for (const e of rawEdges) {
    const src = asObj(e)
    const p = String(src.p ?? src.rel ?? src.pred ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    const label = `${src.s ?? '없음'} ${p || '?'} ${src.o ?? '없음'}`
    if (!REL_OK.has(p)) { errors.push(`역기입 엣지: 어휘에 없는 술어 (${label}) — 버린다`); continue }
    if (DERIVED_ONLY.has(p)) {
      warnings.push(`역기입 엣지: ${p} 는 파생 전용이라 직접 넣지 않는다 (${label}) — 추론이 다시 만든다`)
      continue
    }
    const s = ref(src.s ?? src.from ?? src.subject)
    const o = ref(src.o ?? src.to ?? src.object)
    if (!s || !o) { errors.push(`역기입 엣지: 없는 노드를 가리킨다 (${label}) — 버린다`); continue }
    if (s === o) { warnings.push(`역기입 엣지: 자기 자신을 가리킨다 (${label}) — 버린다`); continue }
    const key = edgeKey({ s, p, o })
    if (addKeys.has(key)) { warnings.push(`역기입 엣지: 같은 엣지가 두 번 왔다 (${label})`); continue }
    if (!cutKeys.has(key) && store.getEdgesFrom(s).some((x) => x.p === p && x.o === o)) {
      warnings.push(`역기입 엣지: 이미 있는 엣지 (${label}) — 넣지 않는다`)
      continue
    }
    addKeys.add(key)
    edges.push(wbEdgeShape(src, s, p, o))
  }

  // 4. 이미 확립된 그래프와 어긋나지 않는지. 끊기로 한 엣지는 빼고 견준다
  const canon = store.toJSON()
  const check = validateAgainstCanon(
    { nodes, edges },
    { nodes: canon.nodes, edges: canon.edges.filter((e) => !cutKeys.has(edgeKey(e))) },
  )
  for (const c of check.conflicts) (c.level === 'error' ? errors : warnings).push(`역기입 모순: ${c.msg}`)

  return { nodes, edges, removes, warnings, errors, conflicts: check.conflicts }
}

/**
 * 역기입을 적용하기 전에 안전한지 본다. store 는 바뀌지 않는다.
 * 뷰어는 이 결과로 "+ 노드 N · + 엣지 N · − 엣지 N" 미리보기를 띄운다.
 *
 * @param {Object} store - GraphStore
 * @param {Object} writeback - branch.writeback
 * @returns {{safe: boolean, warnings: Array<string>, conflicts: Array,
 *            preview: {nodesAdded: number, edgesAdded: number, edgesRemoved: number}}}
 *          safe 는 넣을 수 없는 항목이 하나도 없을 때만 true
 */
export function validateWritebackBeforeApply(store, writeback) {
  const p = planWriteback(store, writeback)
  return {
    safe: p.errors.length === 0,
    warnings: [...p.errors, ...p.warnings],
    conflicts: p.conflicts,
    preview: { nodesAdded: p.nodes.length, edgesAdded: p.edges.length, edgesRemoved: p.removes.length },
  }
}

/**
 * 분기의 역기입을 그래프에 적용한다. #1 파이프라인의 apply_writeback 자리다.
 *
 * 끊기 → 노드 → 엣지 순으로 얹는다. 엣지가 새 노드를 가리킬 수 있어서 노드가 먼저다.
 * 파생 엣지는 GraphStore 가 매번 다시 만들기 때문에, 끊은 명시 엣지에서 나왔던
 * 파생도 함께 사라진다 (진우 serves 귀마 를 끊으면 귀마 rival_of 루미 도 사라진다).
 *
 * @param {Object} store - GraphStore. 이 함수가 직접 바꾼다
 * @param {Object} writeback - branch.writeback ({nodes, edges, remove_edges} 또는 add_* 스키마)
 * @returns {{applied: {nodesAdded: number, edgesAdded: number, edgesRemoved: number, derivedLost: number},
 *            warnings: Array<string>, newSeeds: Array, before: Object, after: Object}}
 *          newSeeds 는 적용 뒤에 다시 돌린 findSeeds 의 결과다
 */
export function applyWriteback(store, writeback) {
  const p = planWriteback(store, writeback)
  if (!store?.addNodes) {
    return {
      applied: { nodesAdded: 0, edgesAdded: 0, edgesRemoved: 0, derivedLost: 0 },
      warnings: [...p.errors, ...p.warnings],
      newSeeds: [],
      before: null,
      after: null,
    }
  }
  const warnings = [...p.errors, ...p.warnings]
  const before = store.stats()

  // removeEdges 는 파생까지 합한 감소분을 낸다. 끊은 명시 엣지 수와 갈라서 적는다
  const dropped = p.removes.length ? store.removeEdges(p.removes) : 0
  const addedNodes = p.nodes.length ? store.addNodes(p.nodes) : { added: [], warnings: [] }
  warnings.push(...addedNodes.warnings)
  const addedEdges = p.edges.length ? store.addEdges(p.edges) : { added: [], warnings: [] }
  warnings.push(...addedEdges.warnings)

  return {
    applied: {
      nodesAdded: addedNodes.added.length,
      edgesAdded: addedEdges.added.length,
      edgesRemoved: p.removes.length,
      derivedLost: Math.max(0, dropped - p.removes.length),
    },
    warnings,
    newSeeds: findSeeds(store),
    before,
    after: store.stats(),
  }
}

// ── 대본화 ───────────────────────────────────────────────────────────────────
// 보드의 컷을 정식 대본 포맷으로 옮긴다. 스토리 디벨롭과는 따로 도는 기능이다.
// 출력이 JSON 이 아니라 대본 텍스트라서 여기서는 parseJson 을 쓰지 않는다.

/** 한 번에 대본으로 옮기는 컷 수. 넘으면 묶음으로 나눠 부른다 (planCuts 와 같은 패턴) */
const SCRIPT_BATCH = 10

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
      '지문은 평서문 한두 줄로 쓴다. 짧은 지시는 (괄호) 안에.',
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
      '빠른 템포의 대사와 액션. 지문은 한 줄로.',
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

  return [
    part
      ? `아래는 콘티를 ${part.n}묶음으로 나눈 것 중 ${part.i}번째다. 이 묶음의 컷만 대본으로 옮긴다.`
      : '아래 콘티 컷을 정식 대본으로 옮긴다.',
    '',
    ...SCRIPT_FORMATS[fmt].guide.map((g, i) => (i === 0 ? g : `- ${g}`)),
    '',
    o.title ? `제목: ${o.title}` : null,
    `인물:\n${roster(asList(o.chars))}`,
    '',
    '컷:',
    ...lines,
    '',
    '규칙',
    '- 컷 순서를 지킨다. 컷을 합치거나 빼지 않는다.',
    part
      ? `- 씬 번호는 ${from + 1} 번부터 이어 붙인다. 앞뒤 묶음이 따로 만들어지므로 처음·끝 표시는 쓰지 않는다.`
      : null,
    '- 컷에 없는 사건이나 인물을 새로 만들지 않는다. 대사가 없는 컷은 지문만 쓴다.',
    '- 대본 텍스트만 출력한다. JSON·설명·머리말·코드펜스를 붙이지 않는다.',
    '- 한국어로 쓴다. 형식 표기(INT./EXT., FADE IN 등)는 원어 그대로 둔다.',
  ].filter((l) => l !== null).join('\n')
}

/**
 * 컷을 정식 대본으로 옮긴다. 반환값은 JSON 이 아니라 대본 텍스트다.
 * 컷이 많으면 planCuts 처럼 묶음으로 나눠 부르고 이어 붙인다.
 *
 * @param {Object} net - net.plan 을 가진 객체. 없으면 로컬 모드
 * @param {Array} cuts - 보드의 컷 배열
 * @param {Object} [options] - scriptFormatPrompt 와 같은 {format, title, chars}
 * @returns {Promise<string>} 대본 텍스트. 컷이 없으면 빈 문자열
 */
export async function planScript(net, cuts, options = {}) {
  const list = asList(cuts)
  if (!list.length) return ''
  if (!net?.plan) return localScript(list, options)

  const batches = []
  for (let i = 0; i < list.length; i += SCRIPT_BATCH) batches.push(list.slice(i, i + SCRIPT_BATCH))
  const got = await Promise.allSettled(batches.map((b, i) => net.plan({
    prompt: scriptFormatPrompt(b, { ...options, part: { i: i + 1, n: batches.length, from: i * SCRIPT_BATCH } }),
    maxTokens: 4000,
    think: false,
  })))

  const out = []
  let failed = 0
  got.forEach((r, i) => {
    const text = r.status === 'fulfilled' ? String(r.value?.text ?? '').trim() : ''
    if (text) { out.push(text); return }
    // 묶음 하나가 비어 오면 그 자리만 로컬 형식으로 메운다. 전부 비면 에러다 —
    // 형식만 갖춘 대본을 모델이 쓴 것처럼 내놓지 않는다
    failed++
    console.warn('[story] 대본 묶음 실패 — 로컬 형식으로 채운다', r.reason?.message)
    out.push(localScript(batches[i], { ...options, from: i * SCRIPT_BATCH, whole: batches.length === 1 }))
  })

  const body = out.filter(Boolean).join('\n\n')
  if (failed === batches.length || !body) throw new Error('대본을 받지 못했습니다. 다시 시도해 주세요.')
  return body
}

/**
 * Bedrock 없이 컷을 대본 형식으로 조합한다. 내용이 아니라 형식을 갖추는 것이 목적이다.
 *
 * @param {Array} cuts - 컷 배열
 * @param {Object} [options]
 * @param {'drama'|'film'|'webdrama'} [options.format='drama'] 대본 형식
 * @param {string} [options.title] 제목
 * @param {number} [options.from=0] 씬 번호 시작 오프셋. 묶음을 채울 때 쓴다
 * @param {boolean} [options.whole=true] 작품 전체인지. false 면 FADE IN/OUT 을 붙이지 않는다
 * @returns {string} 대본 텍스트. 컷이 없으면 빈 문자열
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
