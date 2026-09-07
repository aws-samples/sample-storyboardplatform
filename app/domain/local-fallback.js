/*
 * 모델 없이도 화면이 도는 로컬 폴백입니다. net 이 없거나 응답이 깨졌을 때 planner 가
 * 여기로 내려옵니다. 결과 모양은 모델이 준 것과 같아야 해서(finishStory) 같이 둡니다.
 * 분기를 spec 으로 옮기는 branchToSpec 과 그 프롬프트도 여기 있습니다.
 */

import { PROBES } from './graph-probes.js'
import { normalizeStory } from './graph-rules.js'
import { normalizePlan, splitScenario } from './panels.js'
import { josa } from '../lib/josa.js'
import { asList, asObj, numOr } from '../lib/guards.js'
import { hasEdge, wbParts } from './graph-writeback.js'
import { beatCount, perBeat, HARD_MAX, GENRES, TONES, CUTCOUNTS, JSON_ONLY, withBody, roster } from './prompts.js'

export function finishStory(raw, seed, store, { local = false } = {}) {
  const story = normalizeStory(raw)
  for (const b of story.branches) {
    const keep = []
    for (const e of b.writeback.remove_edges) {
      if (store && !hasEdge(store, e)) {
        story.warnings.push(`${b.id} 역기입 삭제: 그래프에 없는 엣지 (${e.s} ${e.p} ${e.o}). 뺀다`)
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
 * @param {Array} [opts.pool] 로컬 폴백에 쓸 스토리 묶음 (app-walkthrough/data/stories.json)
 * @param {Function} [opts.onTry] 시도마다 (몇 번째, 전체) 를 받는다. 화면에 진행을 남길 때 쓴다
 * @param {string} [opts.model] 쓸 모델 ('haiku-4.5' | 'sonnet-5' | 'opus-4.8')
 * @returns {Promise<Object>} app-walkthrough/data/stories.json 의 스토리 하나와 같은 모양 + {warnings, local}
 */
const LOCAL_NAMES = ['가온', '노을', '바다', '한결']

export function localOutline(spec, ctx) {
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
      summary: lines[i % Math.max(1, lines.length)] || `${spec.prompt} · 비트 ${i + 1}`,
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
  // C 분기에서 끊을 엣지 · 두 초점 인물 사이에 실제로 있는 명시 엣지 하나
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
      const evName = `${core} · ${t.label}`.slice(0, 60)
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
 * @param {Array} [pool] - app-walkthrough/data/stories.json 처럼 {probe, focus, branches} 를 가진 스토리 묶음
 * @param {string} [direction] - 자유 입력 방향. 있으면 목데이터를 쓰지 않는다
 * @returns {Object} planBranches 와 같은 모양 (local: true)
 */
export function localBranches(seed, store, pool, direction) {
  const hit = direction ? null : poolPick(seed, pool)
  return finishStory(hit || dummyStory(seed, store, direction), seed, store, { local: true })
}

export function localCuts(spec, outline) {
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
  const head = t.scene ? `${t.scene} · ` : ''
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

// 비트 하나를 2~3문장으로 쓰게 하면서 응답 상한을 3000 으로 두면 뒤 비트가 잘려 온다
// (8비트 × 280자 + 제목·로그라인·줄거리 ≈ 3600 토큰). 리졸버 상한인 4000 까지 올려 둔다.
/** 분기 개요의 응답 토큰 상한. 이보다 큰 값은 리졸버(plan.js)가 4000 으로 깎는다 */
export const BRANCH_OUTLINE_TOKENS = 4000

/** 이 분기가 그래프에 남기는 것을 한 덩어리로. 개요 프롬프트에 근거로 넣는다 */
const writebackLines = (writeback) => {
  const { nodes, edges, removes } = wbParts(writeback)
  return [
    ...nodes.map((n) => `- 새 ${n?.kind || '노드'}: ${n?.name || ''}${n?.desc ? ` · ${n.desc}` : ''}`),
    ...edges.map((e) => `- 새 관계: ${e?.s} ${e?.p} ${e?.o}${e?.note ? ` (${e.note})` : ''}`),
    ...removes.map((e) => `- 끊기는 관계: ${e?.s} ${e?.p} ${e?.o}${e?.note ? ` (${e.note})` : ''}`),
  ].join('\n')
}

/**
 * 고른 분기를 기존 스토리 기획 파이프라인의 spec 으로 옮긴다.
 * 나온 spec 은 planCuts 가 그대로 읽고, prompt 에 분기 내용이 다 들어가 있어서
 * 급하면 기존 outlinePrompt 에 넣어도 뜻이 통한다.
 *
 * @param {Object} branch - planBranches 가 준 분기 하나 (app-walkthrough/data/stories.json 의 branch 스키마)
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
 * 다른 것은 소재 자리다. spec.prompt 대신 분기의 전개·장면·결과가 들어간다.
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

  // 판의 컨텍스트(제목·이야기·인물 목록)만 잘릴 수 있게 withBody 로 감싼다. 판이 커지면
  // 인물 목록이 수십 줄이 되는데, 아래 규칙이 잘리면 비트가 다시 한 줄로 돌아온다
  return withBody([
    head,
    '분기는 관계 그래프에서 찾은 씨앗이 갈라진 갈래다. 분기가 이미 정한 선택과 결과를 뒤집지 않는다.',
    '',
    `[고른 분기] ${b.id ? `${b.id}. ` : ''}${b.label || '(제목 없음)'}${b.tone ? ` · ${b.tone}` : ''}`,
    b.premise ? `전개: ${b.premise}` : null,
    beats.length ? `장면 순서:\n${beats.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : null,
    outcome ? `이 분기의 결과:\n${outcome}` : null,
    wb ? `이 분기가 관계 그래프에 남기는 것:\n${wb}` : null,
    '',
    `장르: ${s.genre || GENRES[0]} / 톤: ${s.tone || TONES[0]}`,
  ].filter((l) => l !== null), [
    `지금 판의 제목: ${ctx.title || '(없음)'}`,
    `지금 판의 이야기:\n${ctx.scenario || '(없음)'}`,
    `이미 있는 인물:\n${roster(keep)}`,
  ].join('\n'), [
    '',
    JSON_ONLY,
    '{"title":"제목","logline":"한 문장 요약","synopsis":"3~5문장 줄거리",',
    ' "chars":[{"name":"이름","brief":"나이·외모·옷·분위기를 한 줄로. 그림 지시로 쓸 수 있게 구체적으로"}],',
    ' "beats":[{"scene":"S1 장소","summary":"2~3문장. 보이는 사건 + 인물의 내면 변화 + 관계 변화",'
      + '"secs":초,"cast":["이름"]}]}',
    '',
    '규칙',
    `- beats는 ${nb}개. secs 합계는 ${secs}초에 맞춘다.`,
    '- 위 장면 순서를 뼈대로 삼는다. 순서를 뒤집거나 결과를 다르게 만들지 않는다.',
    '',
    '비트 쓰는 법',
    '- summary 를 한 줄로 끝내지 않는다. 2~3문장으로 쓰고 280자 안쪽으로 둔다.',
    '- 한 비트에 세 가지를 담는다. (1) 화면에 보이는 사건 (2) 그 사건이 인물의 안에서 무엇을 바꾸는지'
      + ' (3) 인물 사이의 관계가 어느 쪽으로 움직이는지.',
    '- 내면과 관계는 감정 단어로 이름 붙이지 않고, 인물이 무엇을 하기로 했는지로 적는다'
      + ' (\'불안해한다\' 대신 \'묻지 않기로 하고 자리를 옮긴다\').',
    '- 비트마다 앞 비트에서 달라진 것이 있어야 한다. 같은 상태를 두 번 적지 않는다.',
    newChars > 0
      ? `- chars에는 새로 만드는 인물 ${newChars}명만 넣는다. 이름은 한국어로 짓는다.`
      : '- chars는 빈 배열로 둔다.',
    keep.length ? '- 이미 있는 인물은 chars에 다시 넣지 않고 cast에서 이름으로만 부른다.' : null,
    '- 대사는 여기서 쓰지 않는다. 무슨 일이 벌어지고 그것이 인물을 어떻게 바꾸는지만 적는다.',
    '- 한국어로 쓴다.',
  ].filter((l) => l !== null), '(판의 컨텍스트를 여기서 잘랐다)')
}

/**
 * 고른 분기를 기반으로 개요를 만든다. planOutline 과 같은 호출 계약이다.
 * 이 다음의 컷 확장은 기존 planCuts(net, spec, outline) 를 그대로 쓴다.
 *
 * @param {Object} net - net.plan({prompt, maxTokens, think}) 를 가진 객체. 없으면 로컬 모드
 * @param {Object} branch - 고른 분기
 * @param {Object} spec - branchToSpec 의 반환값
 * @param {Object} [ctx] - planCtx() 와 같은 컨텍스트. ctx.model 로 쓸 모델을 고른다
 * @returns {Promise<Object>} normalizePlan 을 통과한 {title, logline, synopsis, chars, cuts, beats, local}
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
// 그래서 다음 회차의 탐침이 이전에는 없던 구멍을 찾는다. 이 기능의 핵심이다.
