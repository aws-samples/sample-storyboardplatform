/*
 * 모델을 실제로 부르는 자리입니다. domain/prompts.js 가 만든 프롬프트를 net.plan 으로
 * 보내고, 응답을 domain/ 의 규칙으로 정규화해 돌려줍니다. net 이 없으면
 * domain/local-fallback.js 로 내려갑니다. 재시도·모델 선택·토큰 상한이 여기 있습니다.
 */

import { deriveEdges } from '../domain/graph-schema.js'
import { normalizeGraph, validateAgainstCanon } from '../domain/graph-rules.js'
import { normalizePlan } from '../domain/panels.js'
import { asList } from '../lib/guards.js'
import { PROMPT_SAFE, chunkText, SUMMARY_CHARS, summarizePrompt, extractGraphPrompt, CTX_BUDGET, contextPackPrompt, BRANCH_TOKENS, branchPrompt, freeDirectionPrompt, outlinePrompt, perBeat, BATCH, HARD_MAX, cutsPrompt } from '../domain/prompts.js'
import { finishStory, localBranches, localOutline, localCuts, BRANCH_OUTLINE_TOKENS, branchOutlinePrompt, localBranchOutline } from '../domain/local-fallback.js'
import { parseJson } from '../domain/json-repair.js'
import { SCRIPT_BATCH, SCRIPT_TOKENS, scriptFormatPrompt, scriptText, localScript } from '../domain/script-format.js'

const bodyRoom = (build) => Math.max(600, PROMPT_SAFE - build('').length)

const GRAPH_MAX_CHUNKS = 12
/** 프롬프트에 적는 기존 노드 줄 수 상한. 판이 커도 꼬리말이 본문을 밀어내지 않게 한다 */
const SUMMARY_MIN = 3000
/** 요약본 목표 글자 수. 추출 프롬프트에 통째로 들어가야 해서 GRAPH_CHUNK 아래로 둔다 */
const SUMMARY_TOKENS = 1500
/** 요약 프롬프트에 한 번에 넣는 원문 글자 수. 규칙 블록이 짧아 추출 조각보다 크게 잡는다 */
const SUMMARY_CHUNK = 6000

/**
 * 대본을 그래프 추출용으로 줄이는 프롬프트. 출력은 JSON 이 아니라 요약문이다.
 *
 * @param {string} text - 대본 전문 또는 그 조각
 * @param {Object} [opts]
 * @param {string} [opts.title] 작품 제목
 * @param {number} [opts.limit=SUMMARY_CHARS] 요약본 글자 수 상한
 * @param {{i: number, n: number}} [opts.part] 원문을 나눠 넣을 때의 조각 번호
 * @returns {string} Bedrock 에 그대로 넣는 프롬프트. 길이는 PROMPT_MAX 이하가 보장된다
 */
export async function summarizeForExtraction(net, source, ctx = {}) {
  const text = String(source || '').trim()
  if (!text) return { text: '', warnings: [] }
  if (!net?.plan) throw new Error('대본 요약에는 Bedrock 연결이 필요합니다.')

  const warnings = []
  let parts = chunkText(text, SUMMARY_CHUNK)
  if (parts.length > GRAPH_MAX_CHUNKS) {
    warnings.push(`대본이 길어 앞 ${GRAPH_MAX_CHUNKS}조각까지만 요약했다`)
    parts = parts.slice(0, GRAPH_MAX_CHUNKS)
  }
  // 조각이 여럿이면 이어 붙인 요약이 목표 길이를 넘지 않게 조각마다 몫을 나눠 준다
  const limit = Math.max(500, Math.round(SUMMARY_CHARS / parts.length))

  const got = await Promise.allSettled(parts.map((p, i) => net.plan(planSpec(
    summarizePrompt(p, { title: ctx.title, limit, part: { i: i + 1, n: parts.length } }),
    SUMMARY_TOKENS, ctx.model))))

  const out = []
  got.forEach((r, i) => {
    const body = r.status === 'fulfilled' ? String(r.value?.text ?? '').trim() : ''
    if (!body) {
      warnings.push(`${i + 1}/${parts.length} 조각 요약 실패 · 건너뛴다: ${r.reason?.message || ''}`)
      return
    }
    out.push(body)
  })
  if (!out.length) throw new Error('대본 요약을 받지 못했습니다. 다시 시도해 주세요.')
  return { text: out.join('\n\n'), warnings }
}

/**
 * 텍스트에서 그래프를 뽑아 app-walkthrough/data/graph.json 과 같은 모양으로 돌려준다.
 * 뽑은 것(asserted)에 deriveEdges 의 파생 엣지를 붙여서 준다.
 *
 * 텍스트가 SUMMARY_MIN 자 이상이면 두 단계로 돈다. 먼저 요약해서 줄이고, 그
 * 요약본에서 그래프를 뽑는다. 요약이 실패하면 예전처럼 원문을 조각내서 뽑는다.
 * 그보다 짧으면 요약 없이 바로 뽑는다.
 *
 * @param {Object} net - net.plan({prompt, maxTokens, think}) 를 가진 객체
 * @param {string} source - 대본·시놉시스 평문 (scriptToText 를 먼저 거친 것)
 * @param {Object} [ctx]
 * @param {string} [ctx.title] 작품 제목
 * @param {Object} [ctx.canon] 이미 확립된 {nodes, edges}. id 재사용과 모순 검사에 쓴다
 * @param {number} [ctx.maxNodes] 노드 상한
 * @param {string} [ctx.model] 쓸 모델. 요약과 추출이 같은 모델로 간다
 * @returns {Promise<{nodes: Array, edges: Array, warnings: Array, conflicts: Array, compatible: boolean}>}
 */
export async function planGraph(net, source, ctx = {}) {
  const text = String(source || '').trim()
  if (!text) throw new Error('추출할 텍스트가 비어 있습니다.')
  if (!net?.plan) throw new Error('그래프 추출에는 Bedrock 연결이 필요합니다.')

  const warnings = []
  let body = text
  if (text.length >= SUMMARY_MIN) {
    // 요약이 안 되면 추출까지 같이 죽이지 않는다. 조각내서 뽑는 예전 길로 내려간다
    const sum = await summarizeForExtraction(net, text, ctx).catch((err) => {
      warnings.push(`대본 요약 실패 · 원문을 조각내서 뽑는다: ${err.message || ''}`)
      return null
    })
    if (sum) {
      warnings.push(...sum.warnings)
      warnings.push(`대본이 ${text.length}자라 ${sum.text.length}자로 요약한 뒤 뽑았다`)
      body = sum.text
    }
  }

  let parts = chunkText(body)
  if (parts.length > GRAPH_MAX_CHUNKS) {
    warnings.push(`텍스트가 길어 앞 ${GRAPH_MAX_CHUNKS}조각까지만 읽었다`)
    parts = parts.slice(0, GRAPH_MAX_CHUNKS)
  }
  const canon = { nodes: ctx.canon?.nodes || [], edges: ctx.canon?.edges || [] }
  const known = canon.nodes.map((n) => ({ id: n.id, kind: n.kind, name: n.name }))

  const got = await Promise.allSettled(parts.map((p, i) => ask(net,
    extractGraphPrompt(p, { ...ctx, known, part: { i: i + 1, n: parts.length } }),
    4000, { model: ctx.model })))

  const raws = []
  got.forEach((r, i) => {
    if (r.status === 'rejected') {
      warnings.push(`${i + 1}/${parts.length} 조각 추출 실패 · 건너뛴다: ${r.reason?.message || ''}`)
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
const packFor = (seed, store, build) =>
  contextPackPrompt(seed, store, { limit: Math.min(CTX_BUDGET, bodyRoom(build)) })

/** 정규화 + 역기입 검증. 로컬 폴백과 모델 결과가 같은 모양으로 나오게 한다 */
export async function planBranches(net, seed, store, opts = {}) {
  if (!net?.plan) return localBranches(seed, store, opts.pool)
  const graph = store?.toJSON?.() || null
  const build = (ctx) => branchPrompt(seed, ctx, graph)
  const raw = await ask(net, build(packFor(seed, store, build)), BRANCH_TOKENS,
    { onTry: opts.onTry, model: opts.model })
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
 * @param {Function} [opts.onTry] 시도마다 (몇 번째, 전체) 를 받는다. 화면에 진행을 남길 때 쓴다
 * @param {string} [opts.model] 쓸 모델 ('haiku-4.5' | 'sonnet-5' | 'opus-4.8')
 * @returns {Promise<Object>} planBranches 와 같은 모양
 */
export async function planFreeBranches(net, userInput, seed, store, opts = {}) {
  if (!net?.plan) return localBranches(seed, store, opts.pool, userInput)
  const graph = store?.toJSON?.() || null
  const build = (ctx) => freeDirectionPrompt(userInput, seed, ctx, graph)
  const raw = await ask(net, build(packFor(seed, store, build)), BRANCH_TOKENS,
    { onTry: opts.onTry, model: opts.model })
  return finishStory(raw, seed, store)
}

// 프롬프트로 "JSON 하나만" 을 못 박아도 모델은 코드펜스를 붙이거나 앞에 한 마디를 얹고,
// 응답 상한(stop: max_tokens)에 걸리면 문장 중간에서 끊긴다. 아래 세 단계로 살린다.
//   unfence  → 코드펜스를 벗긴다
//   jsonBody → 앞뒤 설명을 버리고 여는 괄호부터 남긴다
//   repairJson → 잘린 자리를 되짚어 열린 괄호를 닫는다

const ASK_TRIES = 3
/** 실패한 응답을 콘솔에 남길 때의 글자 수 */
const RAW_LOG = 500
/** 상한에서 잘려 온 뒤 다시 물어볼 때 덧붙이는 한 줄 */
const SHORTER = '\n- 앞 요청의 답이 길어서 잘렸다. 같은 모양의 JSON 을 더 짧게 쓴다.'
  + ' 설명은 한 문장으로 줄이고 항목 수도 최소로 한다.'

/**
 * net.plan 에 보내는 요청 하나. 모델 선택은 화면에서 오고 리졸버가 허용 목록으로 걸러 준다.
 * 고른 것이 없으면 model 을 아예 싣지 않는다. 그때는 리졸버의 기본 모델로 간다.
 *
 * @param {string} prompt - 보낼 프롬프트
 * @param {number} maxTokens - 응답 토큰 상한
 * @param {string} [model] - 'haiku-4.5' | 'sonnet-5' | 'opus-4.8' (infra/resolvers/plan.js 의 MODELS)
 * @returns {{prompt: string, maxTokens: number, think: boolean, model?: string}}
 */
const planSpec = (prompt, maxTokens, model) => {
  const spec = { prompt, maxTokens, think: false }
  if (model) spec.model = String(model)
  return spec
}

/**
 * 프롬프트를 보내고 JSON 을 받는다. 못 읽으면 원문을 콘솔에 남기고 다시 물어본다.
 * 같은 프롬프트를 그대로 다시 보내면 같은 자리에서 또 잘리므로, 상한에 걸렸을 때는
 * 더 짧게 쓰라는 한 줄을 붙여서 보낸다.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.onTry] 시도마다 (몇 번째, 전체) 를 받는다. 화면에 진행을 남길 때 쓴다
 * @param {string} [opts.model] 쓸 모델. 없으면 리졸버 기본값
 */
const ask = async (net, prompt, maxTokens, opts = {}) => {
  const { onTry, model } = opts
  let last = null
  let cut = false
  for (let i = 1; i <= ASK_TRIES; i++) {
    onTry?.(i, ASK_TRIES)
    const res = await net.plan(planSpec(cut ? prompt + SHORTER : prompt, maxTokens, model))
    const text = String(res?.text ?? '')
    try {
      return parseJson(text)
    } catch (err) {
      cut = res?.stop === 'max_tokens'
      // 원문을 남긴다. 어떤 모양으로 오는지 모르면 이 실패는 재현이 안 된다
      console.warn(`[story] 기획 결과를 읽지 못했다 (${i}/${ASK_TRIES})`
        + ` stop=${res?.stop || '?'} ${text.length}자: ${err.message}`)
      console.log('[story] Bedrock raw:', text.slice(0, RAW_LOG))
      last = cut
        ? new Error('기획 결과가 응답 상한에서 잘렸습니다. 다시 시도해 주세요.')
        : err
    }
  }
  throw last
}

/** ctx·opts 에 model 이 있으면 그것을, 없으면 spec 에 실려 온 것을 쓴다 (branchToSpec 경로) */
const pickModel = (a, b) => a?.model || b?.model || undefined

export async function planOutline(net, spec, ctx) {
  if (!net?.plan) return localOutline(spec, ctx)
  const p = normalizePlan(await ask(net, outlinePrompt(spec, ctx), 3000, { model: pickModel(ctx, spec) }), {
    maxChars: spec.newChars,
    maxCuts: 12,
  })
  if (!p.cuts.length) throw new Error('비트를 받지 못했습니다. 다시 시도해 주세요.')
  return { ...p, beats: p.cuts, local: false }
}

/**
 * @param {Object} [opts]
 * @param {string} [opts.model] 쓸 모델. 없으면 spec.model, 그것도 없으면 리졸버 기본값
 */
export async function planCuts(net, spec, outline, opts = {}) {
  if (!net?.plan) return localCuts(spec, outline)
  const per = perBeat(spec.cuts, outline.beats.length)
  const model = pickModel(opts, spec)
  const batches = []
  for (let i = 0; i < outline.beats.length; i += BATCH) batches.push(outline.beats.slice(i, i + BATCH))

  const got = await Promise.allSettled(
    batches.map((b, i) => ask(net, cutsPrompt(spec, outline, b, i * BATCH, per), 2500, { model })))

  const out = []
  got.forEach((r, i) => {
    const cuts = r.status === 'fulfilled'
      ? normalizePlan(r.value, { maxChars: 0, maxCuts: batches[i].length * per + 2 }).cuts
      : []
    if (r.status === 'rejected') console.warn('[story] 컷 묶음 실패. 비트로 대체한다', r.reason?.message)
    out.push(...(cuts.length ? cuts : batches[i]))
  })
  return out.slice(0, Math.min(HARD_MAX, spec.cuts + 6))
}

export async function planBranchOutline(net, branch, spec, ctx = {}) {
  if (!net?.plan) return localBranchOutline(branch, spec, ctx)
  const maxChars = Number.isFinite(Number(spec?.newChars)) ? Number(spec.newChars) : 4
  const p = normalizePlan(await ask(net, branchOutlinePrompt(branch, spec, ctx), BRANCH_OUTLINE_TOKENS,
    { model: pickModel(ctx, spec) }), { maxChars, maxCuts: 12 })
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
export async function planScript(net, cuts, options = {}) {
  const list = asList(cuts)
  if (!list.length) return ''
  if (!net?.plan) return localScript(list, options)

  const batches = []
  for (let i = 0; i < list.length; i += SCRIPT_BATCH) batches.push(list.slice(i, i + SCRIPT_BATCH))
  const got = await Promise.allSettled(batches.map((b, i) => net.plan(planSpec(
    scriptFormatPrompt(b, { ...options, part: { i: i + 1, n: batches.length, from: i * SCRIPT_BATCH } }),
    SCRIPT_TOKENS, options.model))))

  const out = []
  let failed = 0
  got.forEach((r, i) => {
    // 뒤쪽 묶음이 {"script": "S#5…"} 로 감싸 오는 일이 있다. 래핑을 벗겨 텍스트만 이어 붙인다
    const text = r.status === 'fulfilled' ? scriptText(r.value?.text) : ''
    // 상한에서 잘려도 앞부분은 쓸 수 있다. 다만 뒤 컷이 사라진 것이므로 콘솔에 남긴다. // 자주 보이면 SCRIPT_BATCH 를 줄일 자리다
    if (text && r.value?.stop === 'max_tokens') {
      console.warn(`[story] 대본 ${i + 1}/${batches.length} 묶음이 응답 상한에서 잘렸다`
        + ` · 컷 ${batches[i].length}개, ${text.length}자`)
    }
    if (text) { out.push(text); return }
    // 묶음 하나가 비어 오면 그 자리만 로컬 형식으로 메운다. 전부 비면 에러다. // 형식만 갖춘 대본을 모델이 쓴 것처럼 내놓지 않는다
    failed++
    console.warn('[story] 대본 묶음 실패. 로컬 형식으로 채운다', r.reason?.message)
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
