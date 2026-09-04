/*
 * 키 비주얼 — 씬 단위 이미지 생성
 *
 * 실제 배포된 경로만 쓴다.
 *   대본 자르기      빈 줄로 블록을 나누고 슬러그가 같으면 한 씬으로 합친다
 *   프롬프트 쓰기    net.plan()  → AppSync → Bedrock Converse
 *   그림 그리기      POST /gen   → ALB → EC2 GPU
 *   보드에 남기기    net.sendOp  → AppSync → DynamoDB
 *
 * 로컬 모드(aws-config.js 가 null)에서는 plan 과 /gen 이 없다.
 * 그때는 화면이 무엇이 없어서 못 하는지 그대로 말한다. 흉내내지 않는다.
 */

import { ART_ROLES, orderKeyBetween } from '../demo/core.js'
import { configured, idToken, session } from '../demo/auth.js'
import { connect } from '../demo/net.js'
import { showLogin } from '../demo/login.js'
import * as coach from './coach.js'

const cfg = window.SB_CONFIG || {}
const $ = (s, r = document) => r.querySelector(s)
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n }
const uid = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
const now = () => Date.now()

/* ══ 상태 ══════════════════════════════════════════ */

const S = {
  step: 1,
  script: '',
  scenes: [],           // { id, place, time, weather, blocks, blkIdx[], text, prompt, cast[], beat, framing }
  size: 'key',
  seed: '',
  seedOn: false,
  model: null,
  busy: null,           // 'split' | 'prompt' | 'batch'
  gpu: { state: 'unknown', text: '확인 중', models: [], resident: null, loading: null, wait: 0 },
  jobs: {},             // sceneId → { status, ms, url, err, code, tries }
  pick: null,
  blk: 0,
  posted: false,
  me: null,
  net: null,
  peers: new Map(),     // actorId → { id, name, role, at, seen }
  feed: [],
  log: [],
}

// 서버가 내주는 크기는 두 가지뿐이다. server.py 의 SIZE 와 같아야 한다.
const SIZES = {
  key: { label: '가로 1216×688', kind: 'cut' },
  pose: { label: '세로 896×1152', kind: 'pose' },
}

const job = (id) => (S.jobs[id] ??= { status: 'idle', tries: 0 })
const scene = (id) => S.scenes.find((s) => s.id === id)
const doneJobs = () => S.scenes.filter((s) => job(s.id).status === 'done')
const failedJobs = () => S.scenes.filter((s) => job(s.id).status === 'failed')
const canGen = () => !!cfg.genUrl
const canPlan = () => !!S.net?.plan
const myRole = () => S.me?.role || 'reviewer'
const mayGen = () => ART_ROLES.includes(myRole())

/* ══ 로그 · 기록 ══════════════════════════════════ */

function wire(cls, text) {
  S.log.unshift({ cls, text, at: new Date().toTimeString().slice(0, 8) })
  if (S.log.length > 60) S.log.pop()
  paintLog()
}

function note(text, who) {
  S.feed.unshift({ text, who: who || S.me, at: new Date().toTimeString().slice(0, 5) })
  if (S.feed.length > 30) S.feed.pop()
  paintFeed()
}

const say = (m) => { const r = $('#live'); if (r) r.textContent = m }

/* ══ 대본 → 씬 ════════════════════════════════════ */

const SLUG = /^(INT|EXT|I\/E)\.?\s+(.+?)(?:\s+[-–—]\s+(.+))?$/i
const KO_SLUG = /^(실내|실외)[.\s]+(.+?)(?:\s+[-–—]\s+(.+))?$/

/**
 * 슬러그 라인에서 장소·시간을 뽑는다. 없으면 null.
 * 이어지는 씬 표시는 장소든 시간이든 어디에 붙어 있어도 먼저 떼어낸다.
 * 그러지 않으면 "분장실 - 밤" 과 "분장실 - 밤 (이어서)" 가 다른 씬으로 갈라진다.
 */
const CONT = /\s*\((?:이어서|계속|CONT'?D\.?|CONTINUOUS)\)\s*/gi

function readSlug(text) {
  const first = String(text).split('\n')[0].trim().replace(CONT, ' ')
  const m = first.match(SLUG) || first.match(KO_SLUG)
  if (!m) return null
  return { place: (m[2] || '').trim(), time: (m[3] || '').trim() }
}

/**
 * splitScenario() 로 블록을 자르고, 슬러그의 장소·시간이 같은 인접 블록을 한 씬으로 합친다.
 * 씬을 고르지 않는다. 목록 전체가 그대로 넘어간다.
 */
function toScenes(text) {
  const blocks = String(text).split(/\n[ \t]*\n/).map((s) => s.trim()).filter(Boolean)
  const out = []
  blocks.forEach((b, i) => {
    const slug = readSlug(b)
    const last = out.at(-1)
    const sameHead = last && slug && last.place === slug.place && last.time === slug.time
    const noSlug = !slug && last
    if (sameHead || noSlug) {
      last.blkIdx.push(i)
      last.text += '\n\n' + b
    } else {
      out.push({
        place: slug?.place || '장소 미정',
        time: slug?.time || '',
        weather: '',
        blkIdx: [i],
        text: b,
      })
    }
  })
  return out.map((s, i) => ({
    ...s,
    id: `S${String(i + 1).padStart(2, '0')}`,
    blocks: s.blkIdx.length === 1 ? `블록 ${s.blkIdx[0] + 1}` : `블록 ${s.blkIdx[0] + 1}–${s.blkIdx.at(-1) + 1} 병합`,
    prompt: '',
    cast: [],
    beat: '',
    framing: '',
  }))
}

/* ══ 프롬프트 — Bedrock ═══════════════════════════ */

const JSON_ONLY = '오직 아래 모양의 JSON 하나만 출력한다. 설명·머리말·코드펜스를 붙이지 않는다.'

export function keyVisualPrompt(scenes) {
  const lines = scenes.map((s) =>
    `${s.id} | ${s.place}${s.time ? ' · ' + s.time : ''}\n${s.text.replace(/\n+/g, ' ').slice(0, 400)}`)
  return [
    '아래는 한 대본을 씬으로 나눈 것이다. 씬마다 키 비주얼 한 장의 이미지 프롬프트를 쓴다.',
    '키 비주얼은 그 씬 전체의 화풍과 공간을 정하는 대표 그림이다. 컷보다 넓게 잡는다.',
    '',
    ...lines,
    '',
    JSON_ONLY,
    '{"visuals":[{"scene":"S01","place":"장소","time":"밤","weather":"비 그친 뒤",',
    ' "cast":["이름"],"beat":"이 씬의 드라마틱한 한 순간",',
    ' "framing":"wide, 무엇을 프레임에 넣는지",',
    ' "prompt":"영어 이미지 프롬프트"}]}',
    '',
    '규칙',
    `- visuals 는 ${scenes.length}개. scene 은 위의 id 를 그대로 쓴다.`,
    '- prompt 는 영어로 쓴다. 화풍 지시(연필·수채 등)는 쓰지 않는다. 서버가 붙인다.',
    '- prompt 에 글자·자막·말풍선을 넣으라는 말은 쓰지 않는다.',
    '- prompt 는 공간·빛·인물의 자세와 프레이밍만 쓴다. 40 단어 안쪽.',
    '- beat · framing · place · time · weather 는 한국어로 쓴다.',
    '- 대본에 없는 인물을 만들지 않는다. cast 는 대본에 이름이 나온 사람만.',
  ].join('\n')
}

/** 형식이 어긋난 응답은 씬 상태에 닿기 전에 막는다. */
export function normalizeVisuals(raw, ids) {
  const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const ok = new Set(ids)
  const out = new Map()
  const list = Array.isArray(raw?.visuals) ? raw.visuals : []
  for (const v of list) {
    const id = clip(v?.scene, 8).toUpperCase()
    if (!ok.has(id) || out.has(id)) continue
    const prompt = clip(v?.prompt, 400)
    if (prompt.length < 8) continue
    out.set(id, {
      prompt,
      place: clip(v?.place, 40),
      time: clip(v?.time, 20),
      weather: clip(v?.weather, 20),
      beat: clip(v?.beat, 80),
      framing: clip(v?.framing, 60),
      cast: (Array.isArray(v?.cast) ? v.cast : []).map((c) => clip(c, 20)).filter(Boolean).slice(0, 6),
    })
  }
  return out
}

function parseJson(text) {
  const s = String(text || '')
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('프롬프트를 읽지 못했습니다. 다시 눌러주세요.')
  try { return JSON.parse(s.slice(a, b + 1)) } catch {
    throw new Error('프롬프트가 깨져서 왔습니다. 다시 눌러주세요.')
  }
}

async function writePrompts() {
  if (!canPlan()) { paint(); return }
  S.busy = 'prompt'; paint()
  wire('u', `plan()  씬 ${S.scenes.length}개 → 이미지 프롬프트`)
  try {
    const r = await S.net.plan({ prompt: keyVisualPrompt(S.scenes), maxTokens: 4000, think: false })
    const map = normalizeVisuals(parseJson(r.text), S.scenes.map((s) => s.id))
    let got = 0
    for (const s of S.scenes) {
      const v = map.get(s.id)
      if (!v) continue
      Object.assign(s, {
        prompt: v.prompt,
        place: v.place || s.place,
        time: v.time || s.time,
        weather: v.weather,
        beat: v.beat,
        framing: v.framing,
        cast: v.cast,
      })
      got++
    }
    const u = r.usage || {}
    wire('g', `200  ${got}/${S.scenes.length}개 · 토큰 ${u.inputTokens || '?'}→${u.outputTokens || '?'}`)
    note(`씬 ${got}개의 이미지 프롬프트를 생성했습니다`)
    if (got < S.scenes.length) {
      S.warn = `${S.scenes.length - got}개는 형식이 어긋나 버렸습니다. 그 씬은 직접 써주세요.`
    }
  } catch (e) {
    wire('r', `실패  ${e.message}`)
    S.warn = e.message
  } finally {
    S.busy = null; paint()
  }
}

/* ══ 그림 — /gen ═══════════════════════════════════ */

async function askGpu(body, path = '') {
  const res = await fetch(cfg.genUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await idToken()}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(json.detail || `생성 서버 오류 (${res.status})`)
    err.code = res.status
    throw err
  }
  return json
}

async function pollGpu() {
  if (!canGen()) { S.gpu = { state: 'none', text: '생성 서버 없음', models: [] }; return }
  try {
    const r = await fetch(`${cfg.genUrl}/health`, { cache: 'no-store' })
    const j = await r.json()
    S.gpu = {
      state: j.error ? 'error' : j.loading ? 'loading' : !j.warm ? 'loading' : j.busy ? 'busy' : 'ready',
      text: j.error ? '생성 서버 오류' : j.loading || !j.warm ? '모델 올리는 중' : j.busy ? '그리는 중' : j.model,
      models: j.models || [], resident: j.modelId, loading: j.loading, wait: j.wait || 0,
      gpu: j.gpu, err: j.error,
    }
    if (!S.model) S.model = j.loading || j.modelId
  } catch {
    S.gpu = { state: 'down', text: '생성 서버에 닿지 않음', models: [], hint: '인스턴스가 꺼져 있을 수 있습니다' }
  }
  paintRig()
}

async function preload() {
  if (!canGen() || !S.model) return
  if (S.gpu.resident === S.model) return
  wire('u', `POST /gen/load  { model: "${S.model}" }`)
  try {
    const r = await askGpu({ model: S.model }, '/load')
    wire('g', `200  resident=${r.resident ?? '없음'} loading=${r.loading ?? '없음'} 대기 ${r.wait}s`)
    note('모델을 올리기 시작했습니다')
  } catch (e) {
    wire('r', `${e.code || ''} ${e.message}`)
    S.warn = e.message
  }
  pollGpu()
}

/** 한 씬 한 장. 실패는 그 씬에만 남는다. */
async function genOne(s) {
  const j = job(s.id)
  j.status = 'running'; j.tries++; delete j.err; delete j.code
  paintQueue(); paintBoard()
  const t0 = performance.now()
  wire('u', `POST /gen  { scene: "${s.id}", model: "${S.model || '기본'}" }`)
  try {
    const r = await askGpu({
      prompt: s.prompt,
      kind: SIZES[S.size].kind,
      model: S.model,
      seed: S.seedOn && S.seed ? Number(S.seed) : null,
    })
    j.status = 'done'; j.url = r.url; j.ms = r.ms ?? Math.round(performance.now() - t0)
    j.seed = r.seed; j.modelLabel = r.model
    wire('g', `200  ${s.id} → ${r.url}  ${Math.round(j.ms / 1000)}s  seed ${r.seed}`)
    note(`${s.id} ${s.place} 키 비주얼을 만들었습니다`)
    // 이미 보드에 있는 패널이면 새 버전으로 올린다. 다른 사람 화면에도 그대로 뜬다.
    if (j.panelId) pushVersion(s, j)
    return true
  } catch (e) {
    j.status = 'failed'; j.err = e.message; j.code = e.code
    wire('r', `${e.code || ''} ${s.id} · ${e.message}`)
    note(`${s.id} 이 ${e.code || '오류'} 로 돌아왔습니다 — 이 씬만 다시 돌릴 수 있습니다`)
    return false
  } finally {
    paintQueue(); paintBoard(); pollGpu()
  }
}

/*
 * 한 번에 열어 두는 요청 수.
 *
 * 서버는 어차피 한 번에 한 장만 그린다 — infra/gpu/server.py 의 `gpu = threading.Lock()`
 * 이 파이프라인 전체를 감싸고 있다. 실제로 4장을 동시에 던져 재보면 벽시계가
 * 12s / 24s / 36s / 47s 로 정확히 쌓인다. 즉 동시에 보내도 총 시간은 줄지 않는다.
 * 줄어드는 것은 장 사이의 빈 시간이다 — 한 장씩 기다렸다 보내면 락이 풀린 뒤
 * 다음 요청이 도착할 때까지 GPU 가 놀고, 그 왕복이 장 수만큼 붙는다. 미리 넣어
 * 두면 앞 장이 끝나는 순간 다음 장이 이미 대기 중이다.
 *
 * 그래서 전부 한꺼번에 던지지 않는다. 뒤에 선 요청은 앞의 것들이 끝날 때까지
 * 응답 없이 열린 채로 기다리는데, CloudFront 의 /gen* readTimeout 이 60초다
 * (infra/lib/storyboard-stack.js). 장당 약 12초이므로 5번째부터는 시간 안에
 * 못 들어온다. 3으로 묶으면 최악이 약 36초 — 여유가 있다. 씬이 20개여도
 * 열려 있는 요청은 항상 3개뿐이다.
 */
const LANES = 3

/**
 * 배치. 씬 여러 개를 동시에 띄우고, 한 장이 끝나는 대로 다음 씬을 그 자리에 넣는다.
 * 한 씬의 실패가 배치를 끝내지 않는다.
 */
async function runBatch(ids) {
  if (S.busy) return
  const targets = (ids || S.scenes.map((s) => s.id)).map(scene).filter((s) => s?.prompt)
  if (!targets.length) { S.warn = '프롬프트가 있는 씬이 없습니다. STEP 2 에서 먼저 받아주세요.'; paint(); return }

  S.busy = 'batch'; S.warn = null; S.t0 = now()
  for (const s of targets) { const j = job(s.id); j.status = 'queued'; delete j.err }
  paint()

  if (canGen() && S.gpu.state !== 'ready' && S.gpu.state !== 'busy') await preload()

  /*
   * 대기열을 여러 갈래가 나눠 집는다. 갈래마다 자기 장이 끝나면 바로 다음 번호를
   * 가져가므로, 느린 씬 하나가 뒤를 다 막지 않는다. 씬을 미리 3등분하면 그렇게 된다.
   */
  let next = 0
  const lane = async () => {
    while (!S.stop) {
      const i = next++
      if (i >= targets.length) return
      await genOne(targets[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(LANES, targets.length) }, lane))
  S.stop = false

  S.busy = null
  paint()
  const d = doneJobs().length, f = failedJobs().length
  say(`${d}장 완료${f ? `, ${f}장 실패` : ''}`)
}

/* ══ 보드에 붙이기 — publishOp ════════════════════ */

/** 키 비주얼 한 장을 씬 패널 한 개로 만든다. 컷 패널과 같은 모양이라 같은 방식으로 복제된다. */
export function opsForBoard(scenes, jobs, actor, newId = uid) {
  const ops = []
  let key = null
  for (const s of scenes) {
    const j = jobs[s.id]
    if (j?.status !== 'done') continue
    key = orderKeyBetween(key, null)
    const id = newId()
    j.panelId = id
    j.ver = 1
    ops.push({
      kind: 'panel.add',
      panel: {
        id, orderKey: key,
        scene: `${s.id} ${s.place}${s.time ? ' · ' + s.time : ''}`,
        action: s.beat || String(s.text || '').replace(/\n+/g, ' ').slice(0, 120),
        dialogue: '', camera: 'WS', cast: s.cast || [], secs: 2,
        status: 'draft', assignee: null, generating: false, current: 0,
        keyVisual: true,
        versions: [{
          n: 1, src: j.url, source: 'ai', author: actor, ts: now(),
          prompt: s.prompt,
          gen: { model: j.modelLabel || null, seed: j.seed ?? null, ms: j.ms ?? null, ref: 'none', strength: null },
        }],
      },
    })
  }
  return ops
}

/** 붙여둔 패널을 다시 그렸을 때. demo/app.js 의 panel.version 과 같은 모양이어야 한다. */
function pushVersion(s, j) {
  j.ver = (j.ver || 1) + 1
  const op = {
    id: uid(), ts: now(), actor: S.me?.id || 'local',
    kind: 'panel.version', panelId: j.panelId, scene: s.id,
    version: {
      n: j.ver, src: j.url, source: 'ai', author: S.me?.id || 'local', ts: now(),
      prompt: s.prompt,
      gen: { model: j.modelLabel || null, seed: j.seed ?? null, ms: j.ms ?? null, ref: 'none', strength: null },
    },
  }
  S.net?.sendOp(op)
  wire('u', `publishOp  panel.version  ${s.id} v${j.ver}`)
}

async function postToBoard() {
  const ops = opsForBoard(S.scenes, S.jobs, S.me?.id || 'local')
  if (!ops.length) return
  for (const op of ops) {
    op.id = uid(); op.ts = now(); op.actor = S.me?.id || 'local'
    S.net?.sendOp(op)
  }
  wire('u', `publishOp × ${ops.length}  보드에 씬 패널로 남긴다`)
  note(`키 비주얼 ${ops.length}장을 보드에 붙였습니다`)
  S.posted = true
  paint()
  say(`${ops.length}장을 보드에 붙였습니다`)
}

/* ══ 그리기 ════════════════════════════════════════ */

const STEPS = [
  { n: 1, t: '대본', sub: '씬으로 나누기' },
  { n: 2, t: '프롬프트', sub: '씬마다 한 줄' },
  { n: 3, t: '생성', sub: '한 번에 배치' },
  { n: 4, t: '보드', sub: '대본과 맞춰 보기' },
]

const stepOk = (n) =>
  n === 1 ? S.scenes.length > 0
    : n === 2 ? S.scenes.some((s) => s.prompt)
      : n === 3 ? doneJobs().length > 0
        : S.posted

function paintNav() {
  const box = $('#nav'); box.textContent = ''
  STEPS.forEach((s, i) => {
    const b = el('button', 'tab')
    b.type = 'button'
    b.setAttribute('aria-current', String(S.step === s.n))
    b.dataset.coach = 'tab' + s.n
    b.disabled = s.n > 1 && !stepOk(s.n - 1)
    b.append(el('span', 'tab__n', String(s.n)))
    const t = el('span', 'tab__t')
    t.append(el('b', null, s.t), el('span', null, s.sub))
    b.append(t)
    if (stepOk(s.n)) b.append(el('span', 'tab__ok', '✓'))
    b.onclick = () => { S.step = s.n; paint() }
    box.append(b)
    if (i < STEPS.length - 1) box.append(el('span', 'tab__sep', ''))
  })
}

function paintRig() {
  const box = $('#rig'); if (!box) return
  const g = S.gpu
  box.textContent = ''
  box.className = 'rig rig--' + g.state

  const top = el('div', 'rig__top')
  const st = el('div', 'rig__st')
  st.append(el('i', 'led'), el('b', null, g.text || '—'))
  top.append(st)

  if (g.state === 'loading' && g.wait) {
    top.append(el('span', 'rig__wait', `약 ${Math.max(1, Math.round(g.wait / 60))}분`))
  }
  if (g.gpu) top.append(el('span', 'rig__gpu', g.gpu))
  box.append(top)

  if (g.models?.length) {
    const row = el('div', 'models')
    for (const m of g.models) {
      const b = el('button', 'model' + (S.model === m.id ? ' model--on' : '') + (g.resident === m.id ? ' model--res' : ''))
      b.type = 'button'
      b.append(el('b', null, m.label))
      b.append(el('span', null, g.resident === m.id ? '올라와 있음' : `올리는 데 ${Math.max(1, Math.round(m.wait / 60))}분`))
      b.disabled = !!S.busy
      b.onclick = () => { S.model = m.id; paintRig(); preload() }
      row.append(b)
    }
    box.append(row)
  }

  if (g.err) box.append(el('p', 'rig__err', g.err))
  if (g.state === 'down') box.append(el('p', 'rig__err', g.hint || '생성 서버에 닿지 않습니다'))
  if (g.state === 'none') {
    box.append(el('p', 'rig__err', 'aws-config.js 가 비어 있어 생성 서버가 없습니다. 배포한 주소에서 열어야 그림이 나옵니다.'))
  }
}

function paintQueue() {
  const box = $('#queue'); if (!box) return
  box.textContent = ''
  for (const s of S.scenes) {
    const j = job(s.id)
    const r = el('div', 'q q--' + j.status)
    r.append(el('span', 'q__id', s.id))
    const mid = el('div', 'q__mid')
    mid.append(el('b', null, `${s.place}${s.time ? ' · ' + s.time : ''}`))
    if (j.status === 'failed') mid.append(el('span', 'q__err', `${j.code || ''} ${j.err}`))
    else if (!s.prompt) mid.append(el('span', 'q__err', '프롬프트 없음 — 건너뜁니다'))
    else mid.append(el('span', 'q__p', s.prompt.slice(0, 74)))
    r.append(mid)
    r.append(el('span', 'q__t',
      j.status === 'done' ? `${(j.ms / 1000).toFixed(1)}s`
        : j.status === 'running' ? '그리는 중'
          : j.status === 'queued' ? '대기'
            : j.status === 'failed' ? '실패' : '—'))
    const b = el('button', 'mini', j.status === 'done' ? '다시' : '이 씬만')
    b.type = 'button'
    b.disabled = !!S.busy || !s.prompt || !mayGen()
    b.onclick = () => runBatch([s.id])
    r.append(b)
    box.append(r)
  }
}

function paintBoard() {
  const g = $('#kvgrid'); if (!g) return
  // STEP 3 에서는 세는 줄이 같이 있다. 장이 끝날 때마다 여기서 고친다 —
  // 카드를 다시 만들지 않으므로 이미 뜬 그림이 다시 불려 깜빡이지 않는다.
  const cnt = $('#kvcount')
  if (cnt) {
    const f = failedJobs().length
    cnt.textContent = `${doneJobs().length}/${S.scenes.length}${f ? ` · ${f}장 실패` : ''}` +
      (S.busy === 'batch' ? ' · 끝나는 대로 채워집니다' : '')
  }
  g.textContent = ''
  g.style.setProperty('--ar', S.size === 'pose' ? '896/1152' : '1216/688')
  for (const s of S.scenes) {
    const j = job(s.id)
    const c = el('button', 'kv' + (S.pick === s.id ? ' kv--on' : ''))
    c.type = 'button'
    if (j.status === 'done') {
      const im = el('img', 'kv__im'); im.src = j.url; im.alt = `${s.id} ${s.place}`; im.loading = 'lazy'
      c.append(im)
    } else {
      c.append(el('div', 'kv__ph', j.status === 'failed' ? `${j.code || ''} 실패`
        : j.status === 'running' ? '그리는 중' : j.status === 'queued' ? '대기' : '아직 없음'))
    }
    const cap = el('div', 'kv__cap')
    cap.append(el('b', null, s.id), el('span', null, `${s.place}${s.time ? ' · ' + s.time : ''}`))
    c.append(cap)
    const eyes = [...S.peers.values()].filter((p) => p.at === s.id)
    if (eyes.length) {
      const e = el('div', 'kv__eyes')
      for (const p of eyes.slice(0, 3)) e.append(el('i', 'eye', p.name[0]))
      c.append(e)
    }
    c.onclick = () => { S.pick = s.id; S.blk = s.blkIdx[0]; paint() }
    g.append(c)
  }
}

function paintLog() {
  const box = $('#log'); if (!box) return
  box.textContent = ''
  for (const w of S.log.slice(0, 18)) {
    const p = el('p', w.cls ? 'l l--' + w.cls : 'l')
    p.append(el('time', null, w.at), el('span', null, w.text))
    box.append(p)
  }
}

function paintFeed() {
  const ul = $('#feed'); if (!ul) return
  ul.textContent = ''
  if (!S.feed.length) { ul.append(el('li', 'feed__none', '아직 기록이 없습니다.')); return }
  for (const f of S.feed.slice(0, 14)) {
    const li = el('li')
    li.append(el('i', 'av', (f.who?.name || '?')[0]))
    const box = el('div')
    box.append(el('b', null, f.who?.name || '누군가'), el('span', null, ' ' + f.text))
    box.append(el('time', null, f.at))
    li.append(box)
    ul.append(li)
  }
}

function paintPeers() {
  const box = $('#peers'); if (!box) return
  box.textContent = ''
  const list = [S.me, ...S.peers.values()].filter(Boolean)
  for (const p of list) {
    const r = el('div', 'peer')
    r.append(el('i', 'av', (p.name || '?')[0]))
    const m = el('div')
    m.append(el('b', null, p.name))
    m.append(el('span', null, ROLE_KO[p.role] || p.role))
    r.append(m)
    r.append(el('span', 'peer__at', p === S.me ? '나' : p.at ? `${p.at} 보는 중` : '보드'))
    box.append(r)
  }
}

const ROLE_KO = { planner: '기획', artist: '아티스트', director: '감독', reviewer: '리뷰어', admin: '관리자' }

/* ── STEP 1 ───────────────────────────────────── */
function step1() {
  const w = el('div', 'wrap wrap--2')
  const a = card('대본', '붙여넣은 대본을 블록으로 자르고, 슬러그가 같은 인접 블록을 한 씬으로 합칩니다.', 'script')
  const ta = el('textarea', 'script')
  ta.value = S.script
  ta.placeholder = 'INT. 극장 분장실 - 밤\n거울 앞. 분장을 지우다 멈춘다.\n\n    수린\n  그 이름을 어디서 들었어.'
  ta.spellcheck = false
  ta.oninput = () => { S.script = ta.value }
  a.append(ta)
  const row = el('div', 'row')
  const go = el('button', 'btn btn--go', '씬으로 나누기')
  go.type = 'button'
  go.onclick = () => {
    S.scenes = toScenes(S.script)
    S.jobs = {}
    S.pick = S.scenes[0]?.id || null
    if (!S.scenes.length) { S.warn = '대본을 먼저 붙여넣어 주세요.'; paint(); return }
    S.warn = null
    note(`대본을 씬 ${S.scenes.length}개로 나눴습니다`)
    S.step = 2
    paint()
    if (canPlan()) writePrompts()
  }
  row.append(go)
  const n = el('span', 'hint', `${S.script.split(/\n[ \t]*\n/).filter((x) => x.trim()).length} 블록`)
  row.append(n)
  a.append(row)
  w.append(a)

  const b = card(`씬 후보 ${S.scenes.length}`, S.scenes.length ? '씬을 고르지 않습니다. 목록 전체가 다음 단계로 넘어갑니다.' : '나누기를 누르면 여기에 나옵니다.')
  if (S.scenes.length) {
    const list = el('div', 'scenes')
    for (const s of S.scenes) {
      const r = el('div', 'sc')
      r.append(el('span', 'sc__id', s.id))
      r.append(el('span', 'sc__pl', `${s.place}${s.time ? ' · ' + s.time : ''}`))
      r.append(el('span', 'sc__bl', s.blocks))
      list.append(r)
    }
    b.append(list)
  }
  w.append(b)
  return w
}

/* ── STEP 2 ───────────────────────────────────── */
function step2() {
  const w = el('div', 'wrap wrap--2')

  const a = card(`이미지 프롬프트 · 씬 ${S.scenes.length}개`,
    canPlan()
      ? '한 번에 생성합니다. 각 줄은 손으로 고칠 수 있습니다.'
      // 두 경우를 구분해서 말한다. 설정이 없는 것과 연결이 안 된 것은 할 일이 다르다.
      : cfg.graphqlUrl
        ? '보드에 연결되지 않아 문장 모델을 쓸 수 없습니다. 프롬프트를 직접 써주세요.'
        : 'aws-config.js 가 비어 있어 문장 모델이 없습니다. 프롬프트를 직접 써주세요.',
    'prompts')
  for (const s of S.scenes) {
    const r = el('div', 'pr')
    const top = el('div', 'pr__top')
    top.append(el('span', 'sc__id', s.id))
    top.append(el('b', null, `${s.place}${s.time ? ' · ' + s.time : ''}${s.weather ? ' · ' + s.weather : ''}`))
    if (s.cast?.length) top.append(el('span', 'pr__cast', s.cast.join(' · ')))
    r.append(top)
    if (s.beat) r.append(el('p', 'pr__beat', s.beat))
    const ta = el('textarea', 'pr__in')
    ta.value = s.prompt
    ta.placeholder = S.busy === 'prompt' ? '생성중…' : '영어로 씁니다. 공간·빛·인물·프레이밍.'
    ta.spellcheck = false
    ta.rows = 2
    ta.oninput = () => { s.prompt = ta.value }
    r.append(ta)
    a.append(r)
  }
  const row = el('div', 'row')
  if (canPlan()) {
    const re = el('button', 'btn btn--line', S.busy === 'prompt' ? '생성중…' : '다시 생성')
    re.type = 'button'; re.disabled = !!S.busy
    re.onclick = () => writePrompts()
    row.append(re)
  }
  a.append(row)
  w.append(a)

  const b = el('div')
  const o = card('공통 옵션')
  const g = el('div', 'opts')
  const l1 = el('label', 'opt')
  l1.append(el('span', null, '사이즈'))
  const sel = el('select')
  for (const [k, v] of Object.entries(SIZES)) {
    const op = el('option', null, v.label); op.value = k
    if (S.size === k) op.selected = true
    sel.append(op)
  }
  sel.onchange = () => { S.size = sel.value }
  l1.append(sel)
  g.append(l1)

  const l2 = el('label', 'opt')
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = S.seedOn
  cb.onchange = () => { S.seedOn = cb.checked; paint() }
  l2.append(cb, el('span', null, 'seed 고정'))
  const sd = el('input', 'seed'); sd.type = 'text'; sd.value = S.seed; sd.placeholder = '20260902'
  sd.disabled = !S.seedOn
  sd.oninput = () => { S.seed = sd.value.replace(/\D/g, '').slice(0, 9) }
  l2.append(sd)
  g.append(l2)
  o.append(g)
  o.append(el('p', 'note', 'seed 를 고정하면 같은 프롬프트가 같은 그림을 냅니다. 한 씬만 다시 그릴 때 나머지와 화풍을 맞출 수 있습니다.'))
  b.append(o)

  const go = el('button', 'btn btn--go btn--wide',
    `키 비주얼 생성하기 · ${S.scenes.filter((s) => s.prompt).length}개`)
  go.type = 'button'
  go.disabled = !S.scenes.some((s) => s.prompt)
  go.onclick = () => { S.step = 3; paint(); runBatch() }
  b.append(go)
  if (!mayGen()) {
    b.append(el('p', 'note', `지금 역할은 ${ROLE_KO[myRole()]} 입니다. 버튼은 눌립니다 — 서버가 역할을 보고 거절합니다.`))
  }
  w.append(b)
  return w
}

/* ── STEP 3 ───────────────────────────────────── */
function step3() {
  const w = el('div', 'wrap wrap--2')

  const a = el('div')
  const r = card('생성 장비', null, 'rig')
  const rig = el('div'); rig.id = 'rig'
  r.append(rig)
  a.append(r)

  /*
   * 나온 그림을 이 단계에서 바로 보여준다.
   *
   * 예전에는 이 자리에 글자만 있었고, 그림은 STEP 4 에 가야 보였다. 데이터는
   * 이미 있었다 — genOne 이 장마다 paintBoard() 를 부르는데, #kvgrid 가 STEP 4
   * 에만 있어서 그 호출이 조용히 아무 일도 안 했다. id 를 여기에도 두면 같은
   * 렌더러가 이 단계에서 그대로 동작한다. 두 단계가 같이 보이는 일은 없다.
   */
  const g = card('나온 것', '끝나는 대로 채워집니다', 'kvgrid')
  g.querySelector('.card__s').id = 'kvcount'      // 장이 끝날 때마다 paintBoard 가 고친다
  const grid = el('div', 'kvgrid'); grid.id = 'kvgrid'
  g.append(grid)
  a.append(g)

  const q = card(`씬별 · ${S.scenes.length}개`,
    `한 번에 ${LANES}개씩 보냅니다. 서버는 한 장씩 그리므로 나머지는 줄을 섭니다. 한 씬의 실패는 배치를 끝내지 않습니다.`, 'queue')
  const qb = el('div', 'queue'); qb.id = 'queue'
  q.append(qb)

  const row = el('div', 'row')
  if (S.busy === 'batch') {
    const st = el('button', 'btn btn--line', '남은 씬 멈추기')
    st.type = 'button'; st.onclick = () => { S.stop = true; say('멈추는 중입니다') }
    row.append(st)
    row.append(el('span', 'hint', `${doneJobs().length}/${S.scenes.length} 완료`))
  } else {
    const f = failedJobs()
    if (f.length) {
      const b = el('button', 'btn btn--go', `실패한 씬만 다시 · ${f.length}개`)
      b.type = 'button'; b.onclick = () => runBatch(f.map((s) => s.id))
      row.append(b)
    }
    const all = el('button', 'btn ' + (f.length ? 'btn--line' : 'btn--go'), '전체 다시 생성')
    all.type = 'button'; all.onclick = () => runBatch()
    row.append(all)
    if (doneJobs().length) {
      const nx = el('button', 'btn btn--line', `대본과 맞춰 보기 · ${doneJobs().length}장`)
      nx.type = 'button'; nx.onclick = () => { S.step = 4; paint() }
      row.append(nx)
    }
  }
  q.append(row)
  a.append(q)
  w.append(a)

  const b = el('div')
  const lg = card('서버가 본 것', '역할 확인은 화면이 아니라 서버가 합니다.')
  const lb = el('div', 'log'); lb.id = 'log'
  lg.append(lb)
  b.append(lg)

  const p = card('권한', null, 'perm')
  const tbl = el('div', 'perm')
  const line = (k, v, ok) => {
    const r2 = el('div', 'perm__r' + (ok ? '' : ' perm__r--no'))
    r2.append(el('b', null, k), el('span', null, v))
    tbl.append(r2)
  }
  line('아티스트 · 기획', '생성 요청이 통과합니다', true)
  line('감독 · 리뷰어 · 관리자', '서버가 403 으로 거절합니다', false)
  p.append(tbl)
  p.append(el('p', 'note', `지금 역할은 ${ROLE_KO[myRole()]} 입니다. ${mayGen() ? '생성이 통과합니다.' : '버튼은 눌리고, 요청은 서버에서 거절됩니다.'}`))
  b.append(p)

  b.append(scaleCard())
  w.append(b)
  return w
}

/**
 * 브라우저는 여러 장을 동시에 보내지만 그리는 것은 한 대다. 그래서 총 시간은
 * 장 수에 비례해서 늘어난다. 그걸 감추지 않고, 대수를 늘리면 어디가 어떻게
 * 달라지는지 같은 화면에서 보여준다.
 */
function scaleCard() {
  const c = card('대수', '지금 몇 대로 돌고 있는지, 늘리면 무엇이 달라지는지.', 'scale')
  const n = S.scenes.filter((s) => s.prompt).length || 8
  const one = doneJobs().length >= 2
    ? Math.round(doneJobs().reduce((a, s) => a + job(s.id).ms, 0) / doneJobs().length / 1000)
    : null

  const rows = [
    { k: '1대 · 지금', v: `씬 ${n}개가 한 대 앞에 줄을 섭니다`, t: one ? `장당 약 ${one}초` : '측정 전', on: true },
    { k: '여러 대', v: '같은 대기열을 여러 대가 나눠 집습니다', t: one ? '장당 시간은 그대로' : '—' },
  ]
  const box = el('div', 'scale')
  for (const r of rows) {
    const row = el('div', 'scale__r' + (r.on ? ' scale__r--on' : ''))
    row.append(el('b', null, r.k))
    row.append(el('span', null, r.v))
    row.append(el('span', 'scale__t', r.t))
    box.append(row)
  }
  c.append(box)

  const d = el('details', 'path')
  d.append(el('summary', null, '늘리는 경로'))
  const ol = el('ol')
  for (const t of [
    '지금은 장비가 한 대로 고정되어 있습니다. 대수를 늘리려면 여기부터 바꿉니다.',
    '대기열을 서버 밖으로 뺍니다. 지금은 브라우저가 열어 둔 요청이 대기열 역할을 합니다.',
    '한 대가 한 모델만 들고 있게 하면 모델을 갈아끼우는 시간이 사라집니다.',
    '늘어나는 것은 동시에 그리는 장수입니다. 한 장이 나오는 시간은 그대로입니다.',
  ]) ol.append(el('li', null, t))
  d.append(ol)
  c.append(d)
  return c
}

/* ── STEP 4 ───────────────────────────────────── */
function step4() {
  const w = el('div', 'wrap wrap--match')

  const a = card('대본', '블록을 누르면 짝이 되는 키 비주얼로 갑니다.', 'match')
  const scr = el('div', 'scroll')
  S.script.split(/\n[ \t]*\n/).filter((x) => x.trim()).forEach((txt, i) => {
    const hit = S.scenes.find((s) => s.blkIdx.includes(i))
    const b = el('button', 'blk' + (S.blk === i ? ' blk--on' : ''))
    b.type = 'button'
    if (hit && hit.blkIdx[0] === i) b.append(el('span', 'blk__id', `${hit.id} · ${hit.place}`))
    b.append(el('span', 'blk__t', txt.trim()))
    b.onclick = () => { S.blk = i; if (hit) S.pick = hit.id; paint() }
    scr.append(b)
  })
  a.append(scr)
  w.append(a)

  const b = el('div')
  const kv = card('키 비주얼 · 씬 순서대로', null, 'kvgrid')
  const grid = el('div', 'kvgrid'); grid.id = 'kvgrid'
  kv.append(grid)
  b.append(kv)

  const s = scene(S.pick) || S.scenes[0]
  if (s) {
    const j = job(s.id)
    const d = card('선택한 씬')
    const dl = el('dl', 'meta')
    const add = (k, v) => { dl.append(el('dt', null, k), el('dd', null, v)) }
    add('씬', `${s.id} · ${s.place}${s.time ? ' · ' + s.time : ''}${s.weather ? ' · ' + s.weather : ''}`)
    if (s.cast?.length) add('인물', s.cast.join(' · '))
    if (s.beat) add('비트', s.beat)
    if (s.framing) add('프레이밍', s.framing)
    add('상태', j.status === 'done'
      ? `${(j.ms / 1000).toFixed(1)}s · seed ${j.seed} · ${j.modelLabel || ''}`
      : j.status === 'failed' ? `${j.code || ''} ${j.err}` : '아직 없음')
    d.append(dl)
    const again = el('button', 'btn btn--line btn--wide', '이 씬만 다시 생성')
    again.type = 'button'; again.disabled = !!S.busy || !s.prompt || !mayGen()
    again.onclick = () => runBatch([s.id])
    d.append(again)
    b.append(d)
  }

  const post = el('button', 'btn btn--go btn--wide',
    S.posted ? '보드에 붙였습니다 ✓' : `보드에 붙이기 · ${doneJobs().length}장`)
  post.type = 'button'
  post.disabled = !doneJobs().length || S.posted || !mayGen()
  post.onclick = () => postToBoard()
  b.append(post)
  b.append(el('p', 'note', '씬 패널로 남습니다. 컷 패널과 같은 모양이라 새로고침을 견디고, 보드를 열어 둔 사람에게 바로 갑니다.'))
  w.append(b)
  return w
}

function card(title, sub, coach) {
  const c = el('section', 'card')
  if (coach) c.dataset.coach = coach
  const h = el('h2', 'card__h', title)
  c.append(h)
  if (sub) c.append(el('p', 'card__s', sub))
  return c
}

/* ══ 전체 ══════════════════════════════════════════ */

function paint() {
  paintNav(); paintPeers(); paintFeed()
  const m = $('#main')
  m.textContent = ''
  if (S.warn) {
    const a = el('div', 'warn')
    a.append(el('span', null, S.warn))
    const x = el('button', 'warn__x', '닫기'); x.type = 'button'
    x.onclick = () => { S.warn = null; paint() }
    a.append(x)
    m.append(a)
  }
  m.append([step1, step2, step3, step4][S.step - 1]())
  if (S.step === 3) { paintRig(); paintQueue(); paintLog() }
  if (S.step === 3 || S.step === 4) paintBoard()   // 두 단계 다 #kvgrid 를 가진다
  $('#modeTag').textContent = canGen() ? '배포됨' : '로컬'
  $('#modeTag').className = 'tag ' + (canGen() ? 'tag--live' : 'tag--local')
  const w = $('#whoami')
  w.textContent = `${ROLE_KO[myRole()] || myRole()}로 로그인`
  w.title = mayGen() ? '생성 요청이 서버를 통과합니다' : '서버가 생성 요청을 403 으로 거절합니다'
}

/* ══ 시작 ══════════════════════════════════════════ */

const SAMPLE = `INT. 극장 분장실 - 밤
거울 앞. 분장을 지우다 멈춘다.

    수린
  그 이름을 어디서 들었어.

INT. 극장 분장실 - 밤 (이어서)
문틈으로 복도의 빛이 새어든다.

INT. 본무대 - 밤
객석의 웅성거림. 조명이 한 점으로.

INT. 객석 - 밤
빈 좌석 한가운데 한 사람.

    무영
  자리는 처음부터 비어 있었지.

INT. 분장실 앞 복도 - 새벽
반쯤 열린 문. 바닥에 찬 빛이 깔린다.

EXT. 극장 옥상 - 새벽
두 사람이 난간에 서 있다.

INT. 지하 연습실 - 낮
거울 벽. 빛줄기 속의 먼지.

EXT. 극장 앞 거리 - 낮
반쯤 찢긴 포스터. 지나가는 사람들.`

async function boot() {
  /*
   * 배포 모드에서는 먼저 로그인을 받는다.
   *
   * 예전에는 이 화면에 로그인 창이 없어서, 토큰 없이 열면 AppSync 가 WebSocket 을
   * 바로 닫았다. net.js 의 ready() 는 connection_ack 에서만 resolve 하므로 그 상태로는
   * resolve 도 reject 도 되지 않고 — 아래 await 에서 영구히 멈췄다. 예외가 아니라
   * 미해결이라 try/catch 도 잡지 못해서 paint() 까지 못 가고 화면이 끝까지 비었다.
   * net.js 쪽에도 몇 번 실패하면 진행시키는 안전장치를 넣었지만, 근본은 로그인이다.
   *
   * 로컬 모드(aws-config.js 가 없음)에는 Cognito 가 없다. 그때는 묻지 않고 들어간다.
   */
  if (configured) {
    let s = session()
    if (s && !(await idToken())) s = null   // 만료된 토큰은 없는 것으로 본다
    S.me = s || await showLogin($('#gate'))
  }
  S.me = S.me || session() || { id: 'local', name: '로컬', role: 'planner' }
  S.script = SAMPLE

  // 보드에 붙기 전에 한 번 그린다. 연결이 오래 걸리거나 실패해도 화면은 이미 있고,
  // 실시간 기능만 나중에 붙는다. 아래 connect() 가 유일한 렌더 관문이면 안 된다.
  paint()

  try {
    S.net = await connect({
      onOp: (op) => {
        if (op.actor === S.me.id) return
        const p = S.peers.get(op.actor)
        const who = { name: p?.name || op.actor, role: p?.role || 'artist' }
        if (op.kind === 'panel.add' && op.panel?.keyVisual) {
          note(`${op.panel.scene} 키 비주얼을 보드에 붙였습니다`, who)
        } else if (op.kind === 'panel.version') {
          note(`${op.scene || op.panelId} 을 다시 생성했습니다`, who)
        }
      },
      onPresence: (p) => {
        if (!p?.id || p.id === S.me.id) return
        S.peers.set(p.id, { ...p, seen: now() })
        paintPeers()
      },
      onStatus: () => {},
      onResync: () => {},
    })
  } catch (e) {
    wire('r', `보드 연결 실패 — ${e.message}`)
  }

  // 이 화면을 보고 있다는 것을 알린다
  const beat = () => S.net?.sendPresence?.({ ...S.me, at: S.pick || null, view: 'keyvisual' })
  beat()
  setInterval(beat, 12_000)
  setInterval(() => {
    let drop = false
    for (const [k, p] of S.peers) if (now() - p.seen > 40_000) { S.peers.delete(k); drop = true }
    if (drop) paintPeers()
  }, 15_000)

  pollGpu()
  setInterval(pollGpu, 20_000)
  paint()

  $('#coachBtn').onclick = () => openCoach()
  if (!coach.seen()) openCoach()
}

function openCoach() {
  coach.start({
    atStep: () => S.step,
    goStep: (n) => {
      // 2·3·4 장은 뒤쪽 단계를 가리킨다. 아직 못 간 단계면 앵커를 보여줄 수 없으니
      // 대본을 먼저 나눠서 화면을 만든다.
      if (n > 1 && !S.scenes.length) { S.scenes = toScenes(S.script); S.pick = S.scenes[0]?.id || null }
      S.step = n
      paint()
    },
  })
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('textarea, input')) return
  if (e.key === 'ArrowRight' && S.step < 4 && stepOk(S.step)) { S.step++; paint() }
  if (e.key === 'ArrowLeft' && S.step > 1) { S.step--; paint() }
})

boot()

export { S, toScenes, readSlug, runBatch, genOne, postToBoard }
