/*
 * 키 비주얼 · 씬 단위 이미지 생성
 *
 * 실제 배포된 경로만 쓴다.
 *   대본 자르기      domain/scene-split.js 가 씬 머리글에서 끊는다
 *   프롬프트 쓰기    net.plan()  → AppSync → Bedrock Converse
 *   그림 그리기      POST /gen   → ALB → EC2 GPU
 *   보드에 남기기    net.sendOp  → AppSync → DynamoDB
 *
 * 로컬 모드(aws-config.js 가 null)에서는 plan 과 /gen 이 없다.
 * 그때는 화면이 무엇이 없어서 못 하는지 그대로 말한다. 흉내내지 않는다.
 */

import { ART_ROLES, orderKeyBetween } from '../domain/panels.js'
import { toScenes, readSlug, needsAiSplit, aiSplitScenes } from '../domain/scene-split.js'
import { configured, idToken, session } from '../services/auth.js'
import { connect } from '../services/api.js'
import { showLogin } from '../components/login-form.js'
import { NAV_TABS, navHref, boardFromSearch } from '../domain/routes.js'
import { mountNav } from '../components/nav-tabs.js'
import { mountBrand } from '../components/brand.js'
import * as coach from '../components/coachmark.js'
import { emptyHint } from '../components/empty-panel.js'
import { guiding } from '../../app-walkthrough/guide.js'
import { keyVisualExample } from '../../app-walkthrough/steps/key-visual.js'
import { makeArt } from '../lib/placeholder-art.js'
import { gpuDownHint } from '../lib/gpu-hours.js'
import { entries, group, markOp } from '../services/activity-log.js'
import { paintList } from '../components/history-list.js'
import { pickProject } from '../components/project-picker.js'
import { touch as touchProject } from '../services/projects.js'
import { saveAsset, loadAsset } from '../services/assets.js'
import { JOB_ROLES, allowed, denyReason, isDenied } from '../domain/permissions.js'
import { confirmAsk } from '../components/confirm.js'
import { askBackground } from '../components/background-ask.js'
import {
  questionsPrompt, normalizeQuestions, buildBackground, readBackground,
  backgroundLines, FALLBACK_QUESTIONS,
} from '../domain/story-background.js'
import { wire as wireTour, demoActive, demoAdvance, demoSay, demoTitle } from '../../app-walkthrough/tour.js'

/*
 * 예시가 쓸 제품 쪽 함수를 넣습니다. app-walkthrough 는 app/ 을 import 할 수 없습니다.
 * 배포에서 app/* 는 버킷 루트로 올라가서 상대 경로가 그쪽으로 닿지 않습니다
 * (app-walkthrough/tour.js 의 머리글).
 */
wireTour({
  navHref,
  label: (id) => NAV_TABS.find((t) => t.id === id)?.label || id,
  touch: touchProject,
})


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
  /*
   * 이 이야기의 공통 배경. { text, qa[], note } 이거나 null 입니다.
   *
   * 씬마다 다르게 그려지는 것을 막습니다(domain/story-background.js). 프로젝트에 저장해
   * 두었으면 boot 이 되살리고, 아니면 이번 생성에만 씁니다. bgAsked 는 이번에 이미 물었나
   * 입니다 — 「다시 생성」을 누를 때마다 같은 창을 세우지 않기 위해서입니다.
   */
  bg: null,
  bgAsked: false,
  bgKept: false,        // 프로젝트에 저장된 것인가. 서랍에서 지우면 다시 거짓이 됩니다
  size: 'key',
  seed: '',
  seedOn: false,
  model: null,
  busy: null,           // 'split'(머리글 없는 글을 모델이 나누는 중) | 'prompt' | 'batch'
  stop: false,          // 「남은 씬 멈추기」를 눌렀나. 갈래들이 이걸 보고 다음 씬을 집지 않는다
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
  journal: [],          // 보드 로그의 op 사본. 「지나간 일」이 이것만 읽는다
  histMine: false,
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
/*
 * plan() 을 부를 수 있는 역할인가. 「연결이 있나」(canPlan)와 다른 물음입니다.
 *
 * 아티스트는 그림은 그릴 수 있지만 plan 은 못 부릅니다(infra/resolvers/plan.js). 그래서
 * 이 화면에서 씬 나누기와 프롬프트 쓰기는 막히고 생성은 되는, 반쯤 열린 자리가 나옵니다.
 * 로컬 모드는 리졸버를 지나지 않으므로 역할을 보지 않습니다.
 */
const mayPlan = () => !configured || allowed('plan', myRole())
/*
 * 에셋을 담을 수 있는 역할인가(infra/resolvers/putAsset.js). 리뷰어만 막힙니다.
 *
 * 로컬 모드는 막지 않습니다. 브라우저 저장소라 리졸버를 지나지 않고, 무엇보다 로컬은
 * 자리를 돌려 가며 앉히므로 다섯 명 중 한 명이 리뷰어입니다(pages/board.js 의 resolveMe).
 * 그 자리에 앉은 사람만 저장이 안 되면 까닭을 알 수 없습니다.
 */
const mayKeep = () => !configured || allowed('putAsset', myRole())

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

/*
 * 「누가 뭘 했다」를 보드와 같은 로그에 남긴다.
 *
 * 이 화면이 하는 일 중 보드에 op 로 남는 것은 붙이기(panel.add)와 다시 그리기
 * (panel.version)뿐이다. 대본을 나눈 것, 프롬프트를 받은 것, 몇 장을 그린 것은
 * 여기서만 알고 있었고 그래서 홈이나 보드에서는 보이지 않았다. step.mark 로 남기면
 * app/history.js 가 그것을 한 줄로 옮긴다. applyOp 는 모르는 kind 라 지나가므로
 * 보드의 판은 흔들리지 않는다.
 *
 * 실패해도 삼킨다. 기록을 못 남긴 것이 이 화면의 본 일을 멈출 이유는 아니다.
 */
function mark(what, { ref = null, example = false } = {}) {
  const op = markOp({ step: 'keyvisual', actor: S.me?.id || 'local', what, ref, example })
  S.journal.push(op)
  try { S.net?.sendOp?.(op) } catch (e) { wire('r', `기록을 남기지 못했습니다. ${e.message}`) }
  // 프로젝트 카드의 「마지막 손길」도 같은 문장으로 고친다. 실패는 삼킨다(projects.touch)
  touchProject({ boardId: boardFromSearch(), actor: S.me?.id, what })
  paintHist()
}

const say = (m) => { const r = $('#live'); if (r) r.textContent = m }

/* ══ 프롬프트 · Bedrock ═══════════════════════════ */

const JSON_ONLY = '오직 아래 모양의 JSON 하나만 출력한다. 설명·머리말·코드펜스를 붙이지 않는다.'

/**
 * 씬마다 이미지 프롬프트를 쓰라는 프롬프트입니다.
 *
 * bg 를 주면 그 배경이 모든 씬에 공통으로 들어갑니다(domain/story-background.js). 배경이
 * 없으면 예전 그대로 돕니다 — 이 기능이 붙기 전에 만들어 둔 프로젝트가 그렇습니다.
 *
 * @param {Array} scenes
 * @param {{text: string}|null} [bg] - 이 이야기의 공통 배경
 */
export function keyVisualPrompt(scenes, bg = null) {
  const lines = scenes.map((s) =>
    `${s.id} | ${s.place}${s.time ? ' · ' + s.time : ''}`
    + `${s.cast?.length ? ` | 등장: ${s.cast.join(', ')}` : ''}`
    + `\n${s.text.replace(/\n+/g, ' ').slice(0, 400)}`)
  return [
    '아래는 한 대본을 씬으로 나눈 것이다. 씬마다 키 비주얼 한 장의 이미지 프롬프트를 쓴다.',
    '키 비주얼은 그 씬 전체의 화풍과 공간을 정하는 대표 그림이다. 컷보다 넓게 잡는다.',
    ...backgroundLines(bg),
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
    /*
     * 배경이 있으면 길이를 늘려 준다. 40 단어는 「공간·빛·자세·프레이밍」만 쓸 때의
     * 치수였다. 거기에 인물의 국적·나이·옷까지 매 장 넣으라고 하면서 같은 길이를 두면
     * 모델이 둘 중 하나를 버린다. 실제로 배경을 넣으면 프레이밍이 먼저 빠진다.
     */
    bg?.text
      ? '- prompt 는 위의 공통 배경 + 그 씬의 공간·빛·인물의 자세와 프레이밍을 쓴다. 65 단어 안쪽.'
      : '- prompt 는 공간·빛·인물의 자세와 프레이밍만 쓴다. 40 단어 안쪽.',
    '- beat · framing · place · time · weather 는 한국어로 쓴다.',
    '- 대본에 없는 인물을 만들지 않는다. cast 는 대본에 이름이 나온 사람만.',
  ].join('\n')
}

/*
 * 프롬프트 한 줄의 상한입니다.
 *
 * 40 단어일 때는 400 이면 넉넉했습니다. 공통 배경이 붙어 65 단어가 되면서 영어 한 단어를
 * 6자로 세어도 400 에 닿습니다. 여기서 자르면 문장 가운데가 끊긴 채로 이미지 모델에
 * 갑니다. 넉넉히 둡니다 — 이 값은 「모델이 폭주했나」를 막는 자리이고, 65 단어 지시를
 * 지킨 응답을 자르는 자리가 아닙니다.
 */
const PROMPT_CHARS = 700

/** 형식이 어긋난 응답은 씬 상태에 닿기 전에 막는다. */
export function normalizeVisuals(raw, ids) {
  const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const ok = new Set(ids)
  const out = new Map()
  const list = Array.isArray(raw?.visuals) ? raw.visuals : []
  for (const v of list) {
    const id = clip(v?.scene, 8).toUpperCase()
    if (!ok.has(id) || out.has(id)) continue
    const prompt = clip(v?.prompt, PROMPT_CHARS)
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

/*
 * 이 프로젝트에 담긴 대본과 씬을 되살린다. boot 에서 한 번만 부른다.
 *
 * 못 읽어도 그냥 지나간다(loadAsset 이 null 을 준다). 대본 칸이 비어 있는 것은 이 화면의
 * 원래 첫 모습이라 사람이 붙여넣으면 그대로 굴러간다. 여기서 막으면 읽기 한 번 실패한
 * 것 때문에 화면 전체를 못 쓰게 된다.
 *
 * 예시를 재생하러 온 것이면 넣지 않는다. 예시는 자기 대본을 얹고 단계를 짚어 가는데,
 * 그 앞에 프로젝트의 대본이 들어가 있으면 예시가 남의 글을 나누는 것으로 보인다.
 */
async function restoreAssets() {
  if (demoActive()) return
  const board = boardFromSearch()
  const [script, scenes, background] = await Promise.all([
    loadAsset(board, 'script'),
    loadAsset(board, 'scenes'),
    loadAsset(board, 'background'),
  ])
  if (script && !S.script) S.script = script
  /*
   * 저장해 둔 배경을 되살립니다. 이것이 이 기능의 「영속」입니다 — 한 번 정해 두면 다음에
   * 이 프로젝트를 열 때도 프롬프트에 그대로 들어갑니다. 그래서 묻지 않습니다(bgAsked).
   *
   * readBackground 를 지나게 합니다. 저장된 것을 그대로 믿지 않는 이유는 이 판이 사람이
   * 지울 수 있는 것이고, 모양이 어긋난 것을 넣으면 'undefined' 가 스무 장에 그림 지시로
   * 붙기 때문입니다(domain/story-background.js).
   */
  const bg = readBackground(background)
  if (bg) { S.bg = bg; S.bgKept = true; S.bgAsked = true }
  const list = Array.isArray(scenes?.scenes) ? scenes.scenes : []
  if (list.length && !S.scenes.length) {
    S.scenes = list
    S.pick = list[0]?.id || null
    // 씬이 있으면 2단계부터다. 나누기를 다시 누르게 하면 되살린 값을 덮어쓴다
    S.step = 2
  }
}

/**
 * 씬을 프로젝트에 담는다. 실패는 삼키고 적어만 둔다.
 *
 * 프롬프트까지 같이 담는다. 씬 객체가 prompt 를 들고 있어서 따로 뺄 것이 없고, 서랍의
 * 요약이 「씬 2개 · 프롬프트 1/2」로 그것을 센다(domain/assets.js).
 */
async function keepScenes() {
  /*
   * 담을 권한이 없으면 보내지 않고, 못 담았다는 것을 말합니다.
   *
   * 전에는 여기서 조용히 돌아섰습니다. 「씬 14개로 나눴습니다」만 보이고 새로고침하면
   * 다 없어지는데, 그 사이에 아무 말도 없었습니다. 사라진 뒤에 알게 되는 것이 가장
   * 나쁩니다. 로컬 모드는 막지 않습니다 — 브라우저 저장소라 리졸버를 지나지 않습니다.
   */
  if (!mayKeep()) { noteKeepDenied(); return }
  try {
    await saveAsset({
      boardId: boardFromSearch(), kind: 'scenes',
      body: { scenes: S.scenes }, actor: S.me?.id,
    })
  } catch (err) {
    console.warn('[key-visual] 씬을 담지 못했습니다', err)
    S.warn = `씬을 프로젝트에 담지 못했습니다. ${err.message}`
    paint()
  }
}

/*
 * STEP 1 의 「씬으로 나누기」.
 *
 * 머리글(`S#1.` · `INT.` · `씬 1`)이 있으면 규칙으로 나눕니다. 왕복이 없어 즉시 끝납니다.
 * 머리글이 하나도 없는 글(시놉시스 · 트리트먼트)은 읽을 표시가 없어서 규칙으로는 씬
 * 하나입니다. 그 자리만 문장 모델에게 넘깁니다. 모델이 없거나 실패하면 규칙 결과로
 * 돌아갑니다. 나누지 못한 것이 이 화면을 멈출 이유는 아닙니다.
 */
async function splitScript() {
  if (!S.script.trim()) { S.warn = '대본을 먼저 붙여넣어 주세요.'; paint(); return }

  // 지난번 경고를 지웁니다. 이번에 다시 걸리면 아래에서 다시 답니다
  S.warn = null
  const ai = needsAiSplit(S.script)
  const useAi = ai && canPlan() && mayPlan()

  if (ai && !canPlan()) {
    // 로컬 모드입니다. 무엇이 없어서 못 하는지 그대로 말합니다. 흉내내지 않습니다
    S.warn = '머리글이 없는 글은 문장 모델이 나눕니다. 로컬 모드에서는 씬 하나로 들어갑니다. '
      + 'S#1. 장소 / 밤 처럼 머리글을 붙이면 모델 없이도 나뉩니다.'
  } else if (ai && !mayPlan()) {
    /*
     * 연결은 있는데 역할이 막힙니다. 보내 봐야 서버가 튕기므로 보내지 않고, 왜 안 되는지와
     * 이 사람이 지금 할 수 있는 것을 같이 적습니다. 머리글을 붙이는 길은 모델도 권한도
     * 필요 없어서 아티스트·리뷰어도 스스로 나눌 수 있습니다.
     */
    S.warn = `${denyReason('plan', myRole())} 규칙으로 씬 하나로 넣었습니다. `
      + 'S#1. 장소 / 밤 처럼 머리글을 붙이면 권한 없이도 나뉩니다.'
  }

  if (useAi) {
    S.busy = 'split'; paint()
    wire('u', `plan()  머리글이 없는 글 ${S.script.length}자 → 씬 나누기`)
  }

  const { scenes, byAi, err } = useAi
    ? await aiSplitScenes(S.net, S.script, { model: S.model })
    : { scenes: toScenes(S.script), byAi: false, err: null }

  S.busy = null
  S.scenes = scenes
  S.jobs = {}
  S.pick = scenes[0]?.id || null
  if (!scenes.length) { S.warn = '나눌 것을 찾지 못했습니다. 대본을 확인해 주세요.'; paint(); return }

  if (err) { wire('r', `실패  ${err}`); S.warn = `${err} 규칙으로 나눈 결과를 보여드립니다.` }
  else if (byAi) wire('g', `200  씬 ${scenes.length}개`)

  const how = byAi ? '문장 모델이 ' : ''
  note(`${how}대본을 씬 ${scenes.length}개로 나눴습니다`)
  mark(`${how}대본을 씬 ${scenes.length}개로 나눴습니다`)
  S.step = 2
  paint()
  /*
   * 대본과 씬을 함께 담는다. 대본은 사람이 이 칸에 직접 붙여넣었을 수 있어서, 나눈
   * 이 순간이 「쓸 만한 대본이 여기 있다」가 확인되는 자리다. 담아 두면 다음에 이
   * 화면에 올 때 칸이 채워져 있고, 서랍에서도 이 프로젝트에 대본이 있다고 보인다.
   *
   * 기다리지 않는다. 프롬프트 쓰기는 씬만 있으면 되고, 저장은 그것과 상관없다.
   */
  keepScript()
  keepScenes()
  if (canPlan()) writePrompts()
}

/**
 * 프롬프트를 못 쓸 때 그 까닭을 S.warn 에 적습니다. 쓸 수 있으면 아무것도 하지 않습니다.
 *
 * 씬 나누기에서 이미 적어 둔 경고를 덮지 않습니다. 「권한이 없어 규칙으로 나눴습니다」와
 * 「권한이 없어 프롬프트를 못 씁니다」는 같은 한 가지 이야기이고, 두 번째 문장이 첫 번째를
 * 지우면 사람이 방금 읽던 안내가 눈앞에서 바뀝니다.
 */
function notePlanDenied() {
  if (mayPlan() || S.warn) return
  S.warn = `${denyReason('plan', myRole())} 씬은 나뉘었습니다. `
    + '프롬프트 칸은 비어 있으니 직접 써주시거나 기획·감독에게 부탁해 주세요.'
}

/**
 * 에셋을 못 담을 때 그 까닭을 적습니다. 담을 수 있으면 아무것도 하지 않습니다.
 *
 * 「저장되지 않는다」는 사실은 늘 말해야 하므로 S.warn 이 차 있어도 덮습니다.
 * notePlanDenied 와 반대인 이유는, 저쪽은 「이번 것을 못 했다」이고 이쪽은 「지금 보이는
 * 것이 새로고침하면 사라진다」라서 더 급한 이야기입니다. paint 는 부르는 쪽이 합니다.
 */
function noteKeepDenied() {
  if (mayKeep()) return
  S.warn = `${denyReason('putAsset', myRole())} `
    + '지금 화면의 것은 새로고침하면 사라집니다. 필요하시면 대본을 복사해 두세요.'
}

/** 대본을 프로젝트에 담는다. 실패는 적어만 둔다. 대본은 칸에 그대로 남아 있다 */
async function keepScript() {
  if (!S.script.trim()) return
  // 권한 안내는 keepScenes 가 합니다. 둘이 나란히 불려서 같은 말을 두 번 적을 이유가 없습니다
  if (!mayKeep()) return
  try {
    await saveAsset({
      boardId: boardFromSearch(), kind: 'script', body: S.script, actor: S.me?.id,
    })
  } catch (err) {
    console.warn('[key-visual] 대본을 담지 못했습니다', err)
  }
}

/* ══ 공통 배경 ═════════════════════════════════════ */

/**
 * 대본을 읽고 물음을 만듭니다. 못 만들면 준비해 둔 물음으로 내려갑니다.
 *
 * 실패해도 던지지 않습니다. 물음을 만드는 것은 배경을 받기 위한 준비이고, 그 준비가
 * 어긋났다고 배경을 아예 못 넣게 하면 사람은 씬마다 손으로 붙이던 예전으로 돌아갑니다.
 * 폴백 물음도 국적·시대·나이·화풍을 물으므로 그것만으로도 일관성은 크게 나아집니다.
 *
 * @returns {Promise<{questions: Array, byAi: boolean}>}
 */
async function makeQuestions() {
  if (!canPlan() || !mayPlan()) return { questions: FALLBACK_QUESTIONS, byAi: false }
  S.busy = 'ask'; paint()
  wire('u', `plan()  씬 ${S.scenes.length}개 → 배경 물음 만들기`)
  try {
    const r = await S.net.plan({
      prompt: questionsPrompt(S.scenes), maxTokens: 1200, think: false,
    })
    const qs = normalizeQuestions(parseJson(r.text))
    const u = r.usage || {}
    wire('g', `200  물음 ${qs.length}개 · 토큰 ${u.inputTokens || '?'}→${u.outputTokens || '?'}`)
    if (!qs.length) {
      wire('r', '물음을 읽지 못했습니다. 준비해 둔 물음으로 갑니다')
      return { questions: FALLBACK_QUESTIONS, byAi: false }
    }
    return { questions: qs, byAi: true }
  } catch (e) {
    wire('r', `실패  ${e.message}. 준비해 둔 물음으로 갑니다`)
    return { questions: FALLBACK_QUESTIONS, byAi: false }
  } finally {
    S.busy = null; paint()
  }
}

/** 배경을 프로젝트에 담습니다. 실패는 적어만 둡니다 — 배경은 화면에 그대로 있습니다 */
async function keepBackground() {
  if (!S.bg) return
  if (!mayKeep()) { noteKeepDenied(); return }
  try {
    await saveAsset({
      boardId: boardFromSearch(), kind: 'background', body: S.bg, actor: S.me?.id,
    })
    S.bgKept = true
    note('이 이야기의 배경을 프로젝트에 저장했습니다')
    mark('이 이야기의 공통 배경을 저장했습니다')
  } catch (err) {
    console.warn('[key-visual] 배경을 담지 못했습니다', err)
    S.warn = `배경을 저장하지 못했습니다. ${err.message} 이번 생성에는 그대로 씁니다.`
  }
}

/**
 * 배경을 물어봅니다. 이미 있으면 묻지 않습니다.
 *
 * 돌려주는 것은 「생성을 계속할까」입니다. 배경을 받았는지가 아닙니다. 배경 없이
 * 진행하겠다고 한 사람도 참을 받습니다 — 그 사람이 원한 것은 생성이고, 배경은 그것을
 * 더 좋게 만드는 것이지 조건이 아닙니다. 그만둔 사람만 거짓입니다.
 *
 * @returns {Promise<boolean>} 프롬프트 생성을 계속할까
 */
async function ensureBackground() {
  // 이미 저장돼 있거나 이번에 한 번 물었으면 그것을 씁니다. 「다시 생성」마다 묻지 않습니다
  if (S.bg || S.bgAsked) return true
  S.bgAsked = true

  const { questions, byAi } = await makeQuestions()
  const out = await askBackground({
    questions, byAi, canKeep: mayKeep(),
    // 담을 권한이 없는 사람에게는 저장 칸을 세우지 않습니다. 대신 왜 없는지 적어 둡니다
  })
  if (!out) return false                 // 그만두기 · Esc · 바깥 누르기
  if (out.skipped) {
    note('배경 없이 진행합니다')
    return true
  }

  S.bg = buildBackground(out.questions, { note: out.note })
  if (!S.bg) {
    // 창은 눌렀지만 한 칸도 안 채웠습니다. 빈 배경을 만들지 않고 그냥 갑니다
    note('배경을 넣지 않고 진행합니다')
    return true
  }
  note(`이 이야기의 배경을 정했습니다 · ${S.bg.qa.length}개 답`)
  if (!mayKeep()) noteKeepDenied()
  else if (out.keep) await keepBackground()
  return true
}

/**
 * 배경을 고칩니다. 이미 있는 것을 다시 물어 봅니다.
 *
 * 물음은 저장된 qa 를 그대로 씁니다. 모델을 다시 부르지 않습니다 — 사람이 고치려는 것은
 * 자기가 넣은 답이고, 물음이 매번 달라지면 지난번 답이 어느 칸의 것인지 알 수 없습니다.
 * 저장된 qa 가 비어 있으면(옛 모양이거나 덧붙임만 있는 배경) 준비해 둔 물음으로 갑니다.
 */
async function editBackground() {
  const had = S.bg?.qa?.length
    ? S.bg.qa.map((q) => ({ id: q.id, ask: q.ask, why: '', hint: '', answer: q.answer }))
    : FALLBACK_QUESTIONS.map((q) => ({ ...q }))
  const out = await askBackground({
    questions: had, byAi: !!S.bg?.qa?.length, note: S.bg?.note || '',
    keep: S.bgKept, canKeep: mayKeep(), canSkip: false, yes: '이 배경으로 고칩니다',
  })
  if (!out || out.skipped) return
  S.bg = buildBackground(out.questions, { note: out.note })
  if (S.bg && out.keep) await keepBackground()
  else if (!S.bg && S.bgKept) await dropBackground()
  paint()
}

/**
 * 저장된 배경을 지웁니다. 화면에서도 뺍니다.
 *
 * 저장소에 「지우기」가 없어서 빈 본문을 덮어씁니다(services/assets.js 의 saveAsset).
 * readBackground 가 text 없는 것을 null 로 읽으므로 다음에 열면 배경이 없는 것과 같습니다.
 * 항목 자체를 지우는 길을 새로 내지 않은 이유는 리졸버와 스키마를 하나씩 늘려야 하고,
 * 서랍이 그 줄을 「아직 없습니다」로 그리는 결과는 어느 쪽이든 같기 때문입니다.
 */
async function dropBackground() {
  const ok = await confirmAsk({
    title: '이 이야기의 배경을 지우시겠습니까?',
    body: '다음 프롬프트 생성부터는 배경이 들어가지 않습니다. 이미 만들어 둔 프롬프트와 '
      + '그림은 그대로 있습니다.',
    list: S.bg?.text ? [S.bg.text] : [],
    yes: '지웁니다',
    danger: true,
  })
  if (!ok) return
  S.bg = null
  S.bgAsked = true   // 지운 사람에게 곧바로 다시 묻지 않습니다
  if (S.bgKept && mayKeep()) {
    try {
      await saveAsset({
        boardId: boardFromSearch(), kind: 'background', body: null, actor: S.me?.id,
      })
      S.bgKept = false
      note('저장해 둔 배경을 지웠습니다')
      mark('이 이야기의 공통 배경을 지웠습니다')
    } catch (err) {
      wire('r', `배경을 지우지 못했습니다. ${err.message}`)
      S.warn = `저장된 배경을 지우지 못했습니다. ${err.message}`
    }
  }
  paint()
}

/* ══ 프롬프트 쓰기 ═════════════════════════════════ */

async function writePrompts() {
  if (!canPlan()) { paint(); return }
  // 역할이 막히면 보내지 않고 까닭을 적습니다. 보내 봐야 리졸버가 튕깁니다
  if (!mayPlan()) { notePlanDenied(); paint(); return }
  /*
   * 프롬프트를 쓰기 전에 배경을 받습니다. 순서가 중요합니다 — 배경은 프롬프트 안에
   * 들어가는 것이라, 프롬프트를 먼저 쓰고 배경을 받으면 다시 써야 합니다.
   * 그만둔 사람은 여기서 멈춥니다.
   */
  if (!await ensureBackground()) return
  S.busy = 'prompt'; paint()
  wire('u', `plan()  씬 ${S.scenes.length}개 → 이미지 프롬프트${S.bg ? ' (공통 배경 포함)' : ''}`)
  try {
    const r = await S.net.plan({
      prompt: keyVisualPrompt(S.scenes, S.bg), maxTokens: 4000, think: false,
    })
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
        // 대본의 「등장인물:」 줄이 모델의 추측보다 정확합니다. 모델이 빈 값을 주면 그것을 지킵니다
        cast: v.cast.length ? v.cast : s.cast,
      })
      got++
    }
    const u = r.usage || {}
    wire('g', `200  ${got}/${S.scenes.length}개 · 토큰 ${u.inputTokens || '?'}→${u.outputTokens || '?'}`)
    note(`씬 ${got}개의 이미지 프롬프트를 생성했습니다`)
    mark(`씬 ${got}개의 이미지 프롬프트를 받았습니다`)
    if (got < S.scenes.length) {
      S.warn = `${S.scenes.length - got}개는 형식이 어긋나 버렸습니다. 그 씬은 직접 써주세요.`
    }
    // 프롬프트가 씬에 붙었으니 담아 둔 씬도 고칩니다. 이것이 Bedrock 왕복 한 번의 결과라
    // 새로고침으로 잃으면 다시 부르게 됩니다
    keepScenes()
  } catch (e) {
    wire('r', `실패  ${e.message}`)
    // 서버가 권한으로 튕겼습니다. 「Not Authorized to access plan on type Mutation」 을
    // 그대로 띄우면 사람은 자기가 뭘 잘못했는지 모릅니다. 우리 말로 바꿔 적습니다
    S.warn = isDenied(e)
      ? (denyReason('plan', myRole()) || '이미지 프롬프트를 쓸 권한이 없습니다.')
      : e.message
  } finally {
    S.busy = null; paint()
  }
}

/* ══ 그림 · /gen ═══════════════════════════════════ */

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
    /*
     * 같은 GPU 를 영상화가 함께 씁니다. 영상 모델은 그림을 못 그리므로 이 화면에서는 없는
     * 것으로 봅니다. 걸러내지 않으면 영상 모델이 고를 수 있는 그림 모델로 보이고, 그것이
     * 올라와 있는 동안에는 사람이 고른 적도 없는데 저절로 골라집니다
     */
    const draw = (j.models || []).filter((m) => !m.video)
    const resident = draw.some((m) => m.id === j.modelId) ? j.modelId : null
    S.gpu = {
      state: j.error ? 'error' : j.loading ? 'loading' : !j.warm ? 'loading' : j.busy ? 'busy' : 'ready',
      text: j.error ? '생성 서버 오류' : j.loading || !j.warm ? '모델 올리는 중' : j.busy ? '그리는 중'
        : resident ? j.model : '그림 모델 대기',
      models: draw, resident, loading: j.loading, wait: j.wait || 0,
      gpu: j.gpu, err: j.error,
    }
    /* 처음 고르는 모델. 올라온 그림 모델이 없으면 서버가 말하는 기본 모델입니다 */
    if (!S.model) {
      S.model = [j.loading, resident, j.default].find((id) => draw.some((m) => m.id === id)) || null
    }
  } catch {
    // 업무 시간 밖이면 꺼져 있는 것이 정상입니다. 시간표와 다음에 켜지는 때를 적습니다
    S.gpu = { state: 'down', text: '생성 서버에 닿지 않음', models: [], hint: gpuDownHint() }
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
  // 예시 그림이 있던 자리라면 그 표시를 지운다. 진짜가 들어오면 예시가 아니다
  j.status = 'running'; j.tries++; delete j.err; delete j.code; delete j.example; delete j.art
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
    note(`${s.id} 이 ${e.code || '오류'} 로 돌아왔습니다. 이 씬만 다시 돌릴 수 있습니다`)
    return false
  } finally {
    paintQueue(); paintBoard(); pollGpu()
  }
}

/*
 * 한 번에 열어 두는 요청 수.
 *
 * 서버는 어차피 한 번에 한 장만 그린다. infra/gpu/server.py 의 `gpu = threading.Lock()`
 * 이 파이프라인 전체를 감싸고 있다. 실제로 4장을 동시에 던져 재보면 벽시계가
 * 12s / 24s / 36s / 47s 로 정확히 쌓인다. 즉 동시에 보내도 총 시간은 줄지 않는다.
 * 줄어드는 것은 장 사이의 빈 시간이다. 한 장씩 기다렸다 보내면 락이 풀린 뒤
 * 다음 요청이 도착할 때까지 GPU 가 놀고, 그 왕복이 장 수만큼 붙는다. 미리 넣어
 * 두면 앞 장이 끝나는 순간 다음 장이 이미 대기 중이다.
 *
 * 그래서 전부 한꺼번에 던지지 않는다. 뒤에 선 요청은 앞의 것들이 끝날 때까지
 * 응답 없이 열린 채로 기다리는데, CloudFront 의 /gen* readTimeout 이 60초다
 * (infra/lib/storyboard-stack.js). 장당 약 12초이므로 5번째부터는 시간 안에
 * 못 들어온다. 3으로 묶으면 최악이 약 36초 · 여유가 있다. 씬이 20개여도
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

  /*
   * 여러 장이면 한 번 더 묻습니다. 이 화면에서 가장 오래 걸리고 가장 비싼 자리입니다 —
   * 장당 10초 남짓이 순서대로 쌓이고(LANES 위의 머리글), 그리는 것은 우리 EC2 의 GPU 라
   * 그 시간만큼 장비가 붙어 있습니다. 이미 그린 장이 있으면 그것도 다시 그립니다.
   *
   * 한 장은 묻지 않습니다. 「이 씬만 다시 생성」은 프롬프트를 고쳐 가며 여러 번 누르는
   * 자리이고, 10초짜리 한 장 앞에 창을 세우면 그 손질이 창 닫기만 반복하는 일이 됩니다.
   * 창을 여는 기준은 「비싼 일인가」이지 「생성인가」가 아닙니다.
   */
  if (targets.length > 1) {
    const had = targets.filter((s) => job(s.id).status === 'done').length
    const ok = await confirmAsk({
      title: '키 비주얼을 생성하시겠습니까?',
      body: canGen()
        ? '씬 순서대로 한 장씩 그립니다. 그리는 동안 다른 씬은 대기하고, 「남은 씬 멈추기」로 멈출 수 있습니다.'
        : 'aws-config.js 에 생성 서버가 없어 실제로 그리지 못합니다. 눌러도 씬마다 오류로 돌아옵니다.',
      list: [
        `씬 ${targets.length}개 · ${SIZES[S.size].label}`,
        `모델 ${S.model || '기본'}${S.seedOn && S.seed ? ` · seed ${S.seed} 고정` : ''}`,
        // 장당 10초를 targets 수로 곱합니다. 갈래가 셋이어도 서버가 한 장씩 그립니다
        `장당 10초 남짓 · 모두 ${Math.max(1, Math.round(targets.length * 10 / 60))}분쯤 걸립니다`,
        ...(had ? [`이미 그린 ${had}장을 다시 그립니다`] : []),
      ],
      yes: '생성합니다',
    })
    if (!ok) return
  }

  /*
   * 대기열 단계로 넘깁니다. 전에는 부르는 쪽이 S.step = 3 을 먼저 박았는데, 물어보는
   * 창이 생기면서 그만둔 사람도 빈 대기열 앞에 서게 됐습니다. 진행이 보일 자리로
   * 옮기는 것은 실제로 시작하는 여기의 일입니다.
   *
   * 이미 3보다 뒤라면 두고 갑니다. 「대본과 맞춰 보기」(4단계)에서 한 씬을 다시 그리는
   * 사람을 3단계로 끌어내리면 보고 있던 것이 사라집니다.
   */
  if (S.step < 3) S.step = 3

  S.busy = 'batch'; S.warn = null; S.t0 = now()
  for (const s of targets) { const j = job(s.id); j.status = 'queued'; delete j.err }
  paint()

  /*
   * 영상 모델이 올라와 있으면 health 는 warm 이라고 답하므로 state 는 'ready' 인데,
   * 그림 모델은 하나도 올라와 있지 않습니다(resident 가 null). 상태만 보고 넘어가면
   * 모델을 올리지 않은 채로 넣어 씬마다 503 이 됩니다. 올라온 것이 내가 고른 것인지로 봅니다
   */
  if (canGen() && S.gpu.state !== 'busy' && S.gpu.resident !== S.model) await preload()

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
  // 멈춰서 끝났는지를 깃발을 내리기 전에 챙긴다. 아래 안내가 이것을 봐야 한다
  const stopped = S.stop
  S.stop = false

  S.busy = null
  paint()
  const d = doneJobs().length, f = failedJobs().length
  // 멈춰서 끝난 것과 다 그려서 끝난 것은 다른 일이다. 「3장 완료」만 적으면 멈춘 사람이
  // 자기가 멈춘 것인지 나머지가 실패한 것인지 알 수 없다
  const how = stopped ? ' · 남은 씬은 멈췄습니다' : ''
  say(`${d}장 완료${f ? `, ${f}장 실패` : ''}${how}`)
  // 장마다 남기지 않는다. 한 배치가 한 줄이다. 8장을 8줄로 남기면 목록이 그것만으로 찬다
  mark(`키 비주얼 ${d}장을 생성했습니다${f ? ` (${f}장 실패)` : ''}${how}`)
  keepKeyVisual()
}

/**
 * 만든 그림을 프로젝트에 담는다. 주소만 담고 그림 자체는 담지 않는다.
 *
 * /gen 이 돌려주는 url 은 S3 의 키다(infra/gpu/server.py). 서명이 붙은 주소가 아니라
 * 시간이 지나도 살아 있고, 그래서 담아 두면 다음에 그대로 뜬다.
 *
 * 예시 그림은 담지 않는다. 그것은 data: URL 이거나 그리는 법(art)이고, 예시로 만든
 * 것이 프로젝트의 에셋으로 남으면 서랍이 「키 비주얼 3장」이라 말하는데 정작 만든
 * 사람은 예시를 본 것뿐인 자리가 생긴다.
 */
async function keepKeyVisual() {
  const shots = S.scenes
    .map((s) => ({ s, j: job(s.id) }))
    .filter(({ j }) => j.status === 'done' && j.url && !j.example)
    .map(({ s, j }) => ({
      sceneId: s.id, place: s.place, url: j.url, seed: j.seed ?? null,
      model: j.modelLabel || null, size: S.size,
    }))
  // 담을 것이 있는지를 먼저 봅니다. 없으면 권한 이야기를 꺼낼 자리가 아닙니다 —
  // 아무것도 안 만든 사람에게 「담을 권한이 없습니다」는 뜬금없는 말입니다
  if (!shots.length) return
  if (!mayKeep()) { noteKeepDenied(); paint(); return }
  try {
    await saveAsset({
      boardId: boardFromSearch(), kind: 'keyvisual',
      body: { shots }, actor: S.me?.id,
    })
  } catch (err) {
    console.warn('[key-visual] 키 비주얼을 담지 못했습니다', err)
  }
}

/*
 * 보드에 붙인 만큼 서랍의 콘티 줄을 올려 둡니다.
 *
 * 서랍(project.html)은 op 로그를 읽지 않고 ASSET#conti 한 칸만 봅니다. 그 칸을 쓰는
 * 곳이 지금까지 보드 화면 하나뿐이었습니다(pages/board.js 의 keepConti). 그래서 여기서
 * 키 비주얼을 다 만들어 붙여 놓고도, 보드 화면을 한 번도 열지 않으면 서랍의 콘티는
 * 계속 「아직 없습니다」였습니다. 붙인 사람 입장에서는 보드에 컷이 서 있는데 서랍이
 * 없다고 말하는 셈입니다.
 *
 * 세는 방식이 보드 쪽과 다릅니다. 보드는 판에 있는 컷을 통째로 세지만 이 화면은
 * 자기가 방금 보낸 것만 압니다(state.panels 이 여기에는 없습니다). 그래서 담겨 있던
 * 수에 이번에 붙인 수를 더합니다. 새로 쓰지 않는 이유는 컷이 서른 개인 판에 키 비주얼
 * 세 장을 붙였을 때 서랍이 「컷 3개」로 줄어들기 때문입니다.
 *
 * 승인 수와 회차 수는 담겨 있던 값을 그대로 넘깁니다. 여기서 붙는 패널은 draft 이고
 * 회차에 속하지 않으므로 둘 다 늘지 않습니다. 보드 화면을 열면 그쪽이 판을 통째로
 * 다시 세어 정확한 값으로 갈아 둡니다. 이것은 그 전까지의 어림값입니다.
 */
async function keepConti(added) {
  if (!added) return
  if (!mayKeep()) { noteKeepDenied(); paint(); return }
  const board = boardFromSearch()
  try {
    // 못 읽으면 loadAsset 이 null 을 줍니다. 그때는 이번에 붙인 것만이라도 담습니다
    const prev = (await loadAsset(board, 'conti')) || {}
    await saveAsset({
      boardId: board, kind: 'conti', actor: S.me?.id,
      body: {
        cuts: (Number(prev.cuts) || 0) + added,
        approved: Number(prev.approved) || 0,
        eps: Number(prev.eps) || 0,
      },
    })
  } catch (err) {
    console.warn('[key-visual] 콘티 요약을 담지 못했습니다', err)
  }
}

/* ══ 보드에 붙이기 · publishOp ════════════════════ */

/*
 * 그림 한 장을 op 에 담을 모양으로. 두 갈래입니다.
 *
 *   진짜 생성  src 에 S3 주소가 들어갑니다. 그 주소는 짧습니다.
 *   예시       art 에 그리는 법만 넣습니다 (app/art.js 의 makeArt 인자). 보는 쪽이
 *              srcOf 로 그 자리에서 다시 그립니다. app/board.js 의 예시 데이터와 같은
 *              방식입니다. 예시 그림은 data: URL 이라 그대로 넣으면 op 하나가 수십 KB 가
 *              되어 DynamoDB 에 그 덩어리가 쌓입니다.
 */
const artFields = (j) => (j.example ? { art: j.art } : { src: j.url })

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
          n: 1, ...artFields(j), source: 'ai', author: actor, ts: now(),
          prompt: s.prompt,
          gen: { model: j.modelLabel || null, seed: j.seed ?? null, ms: j.ms ?? null, ref: 'none', strength: null },
        }],
      },
    })
  }
  return ops
}

/** 붙여둔 패널을 다시 그렸을 때. app/board.js 의 panel.version 과 같은 모양이어야 한다. */
function pushVersion(s, j) {
  j.ver = (j.ver || 1) + 1
  const op = {
    id: uid(), ts: now(), actor: S.me?.id || 'local',
    kind: 'panel.version', panelId: j.panelId, scene: s.id,
    version: {
      n: j.ver, ...artFields(j), source: 'ai', author: S.me?.id || 'local', ts: now(),
      prompt: s.prompt,
      gen: { model: j.modelLabel || null, seed: j.seed ?? null, ms: j.ms ?? null, ref: 'none', strength: null },
    },
  }
  S.net?.sendOp(op)
  wire('u', `publishOp  panel.version  ${s.id} v${j.ver}`)
}

/**
 * 붙인 패널이 실제로 보이는 뷰로 '보드로' 링크를 맞춘다.
 *
 * 보드는 sessionStorage 의 마지막 뷰(sb.view · sb.ep)로 열린다. 그런데 여기서 만드는
 * 패널에는 epId 가 없다. 이 화면의 대본은 보드의 회차가 아니라 자체 샘플이라서
 * 어느 회차의 것도 아니다. app/board.js 의 cutsOf() 는 (p.epId ?? null) === viewEp 로
 * 거르므로, 대본화로 회차를 만든 뒤라면 보드가 그 회차를 보고 있어서 epId 없는
 * 패널은 목록에 아예 안 나온다. 붙이기는 됐는데 컷 수가 늘지 않는 것처럼 보인다.
 *
 * app.js 의 pickView() 는 #cut=<panelId> 가 있으면 그 패널의 뷰(viewChar · viewEp)로
 * 맞추고 그 패널을 고른다. 그 계약에 링크를 얹는다.
 */
function aimBoardLink(panelId) {
  const a = $('#toBoard')
  if (a && panelId) a.href = `/board.html#cut=${panelId}`
}

async function postToBoard() {
  const ops = opsForBoard(S.scenes, S.jobs, S.me?.id || 'local')
  if (!ops.length) return
  // sendOp 이 옵셔널 체이닝이라 연결이 없으면 조용히 아무 일도 안 하고 지나간다.
  // 그 상태로 '붙였습니다' 라고 말하면 안 된다. 보드에 남는 것이 없다.
  if (!S.net) {
    wire('r', 'publishOp 보낼 곳이 없습니다. 보드에 연결되지 않았습니다')
    note('보드에 연결되지 않아 붙이지 못했습니다')
    say('보드에 연결되지 않아 붙이지 못했습니다')
    return
  }
  for (const op of ops) {
    op.id = uid(); op.ts = now(); op.actor = S.me?.id || 'local'
    S.net.sendOp(op)
    S.journal.push(op)
  }
  wire('u', `publishOp × ${ops.length}  보드에 씬 패널로 남깁니다`)
  note(`키 비주얼 ${ops.length}장을 보드에 붙였습니다`)
  S.posted = true
  aimBoardLink(ops[0].panel.id)
  paint()
  say(`${ops.length}장을 보드에 붙였습니다`)
  /*
   * 붙인 다음에 담습니다. 붙이는 것이 이 화면의 일이고 서랍의 한 줄은 그 사본입니다.
   * 앞에 두면 담기를 기다리는 동안 「붙였습니다」가 늦게 뜹니다.
   *
   * 예시로 만든 그림도 셉니다. 키 비주얼 목록(keepKeyVisual)에서는 예시를 빼지만, 이쪽은
   * 보드에 실제로 선 컷의 수입니다. 예시 패널도 op 로 보드에 남아 보이므로 그것을 빼면
   * 서랍의 수가 보드의 컷 수와 어긋납니다.
   */
  await keepConti(ops.length)
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
  st.append(el('i', 'led'), el('b', null, g.text || '-'))
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
    else if (!s.prompt) mid.append(el('span', 'q__err', '프롬프트 없음. 건너뜁니다'))
    else mid.append(el('span', 'q__p', s.prompt.slice(0, 74)))
    r.append(mid)
    r.append(el('span', 'q__t',
      // 예시 그림에는 걸린 시간이 없다. 0.0s 라고 적으면 진짜를 그린 것으로 읽힌다
      j.status === 'done' ? (j.example ? '예시' : `${(j.ms / 1000).toFixed(1)}s`)
        : j.status === 'running' ? '그리는 중'
          : j.status === 'queued' ? '대기'
            : j.status === 'failed' ? '실패' : '-'))
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
  // STEP 3 에서는 세는 줄이 같이 있다. 장이 끝날 때마다 여기서 고친다. // 카드를 다시 만들지 않으므로 이미 뜬 그림이 다시 불려 깜빡이지 않는다.
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
  const a = card('대본',
    '씬 머리글에서 끊습니다. S#1 · INT. · 씬 1 을 다 읽습니다. 머리글이 없는 글은 문장 모델이 나눕니다.',
    'script')
  const ta = el('textarea', 'script')
  ta.value = S.script
  ta.placeholder = 'INT. 극장 분장실 - 밤\n거울 앞. 분장을 지우다 멈춘다.\n\n    수린\n  그 이름을 어디서 들었어.'
  ta.spellcheck = false
  ta.oninput = () => { S.script = ta.value }
  a.append(ta)
  const row = el('div', 'row')
  const go = el('button', 'btn btn--go', '씬으로 나누기')
  go.type = 'button'
  go.dataset.coach = 'split'    // 예시 안내가 짚는 자리입니다
  go.onclick = () => splitScript()
  go.disabled = S.busy === 'split'
  row.append(go)
  /*
   * 나누기 전에도 무엇을 보고 나눌지 말해 줍니다. 머리글이 있으면 그 수를, 머리글이
   * 없는 글이면 모델이 나눌 것임을 미리 알립니다. 눌러 보고 알게 되지 않도록 합니다.
   */
  const heads = S.script.split('\n').filter((l) => readSlug(l)).length
  const n = el('span', 'hint', S.busy === 'split' ? '나누는 중입니다'
    : heads ? `씬 머리글 ${heads}개`
      : needsAiSplit(S.script) ? '머리글이 없는 글입니다. 문장 모델이 나눕니다'
        : `${S.script.split(/\n[ \t]*\n/).filter((x) => x.trim()).length} 블록`)
  row.append(n)
  a.append(row)
  w.append(a)

  /*
   * 아직 아무것도 없으면 「씬 후보 0」 이라는 빈 칸 대신 두 갈래를 보여준다.
   *
   * 예시 프로젝트로 들어온 것이면(?demo=1) 이 판을 띄우지 않는다. 「예시를 보겠다」를
   * 이미 누른 사람에게 「예시 보기」를 다시 내미는 셈이고, paint 가 runExample 보다
   * 먼저 지나므로 한 프레임 깜빡였다 사라진다.
   */
  if (!S.script.trim() && !S.scenes.length && !demoActive()) { w.append(welcomePanel()); return w }

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

/**
 * 이 이야기의 공통 배경 카드. 프롬프트 목록 위에 섭니다.
 *
 * 자리가 위인 이유는 이것이 아래 프롬프트 전부에 들어가 있는 것이기 때문입니다. 아래에
 * 두면 「이 문장이 어디서 왔나」를 스무 줄 지나서 알게 됩니다.
 *
 * 배경이 없을 때도 카드를 세웁니다. 「없다」가 이 화면에서 알아야 하는 사실입니다 —
 * 그림이 씬마다 다른 사람으로 나오는 까닭이 여기 있기 때문입니다.
 */
function bgCard() {
  const has = !!S.bg?.text
  const c = card('이 이야기의 공통 배경',
    has
      ? '아래 프롬프트 전부에 이 배경이 함께 들어갑니다. 씬이 달라도 같은 인물로 그려집니다.'
      : '대본에 없는 것(국적·나이·시대·화풍)은 씬마다 다르게 그려집니다. 배경을 정해 두면 그것이 모든 씬에 함께 들어갑니다.',
    'background')

  if (has) {
    c.append(el('p', 'bgc__text', S.bg.text))
    const where = S.bgKept
      ? '이 프로젝트에 저장돼 있습니다. 다음에 열 때도 그대로 있습니다.'
      : '저장하지 않았습니다. 새로고침하면 사라집니다.'
    c.append(el('p', 'note', where))
  }

  const row = el('div', 'row')
  const edit = el('button', 'btn btn--line', has ? '배경 고치기' : '배경 정하기')
  edit.type = 'button'
  edit.disabled = !!S.busy
  /*
   * 없을 때는 물음부터 만들어야 하므로 ensureBackground 로 갑니다. 그 함수는 이미 물었으면
   * 그냥 참을 주고 돌아서므로, 여기서는 bgAsked 를 먼저 내려 다시 묻게 합니다. 「정하기」를
   * 눌렀는데 아무 창도 안 뜨는 것이 가장 나쁩니다.
   */
  edit.onclick = async () => {
    if (has) { editBackground(); return }
    S.bgAsked = false
    await ensureBackground()
    paint()
  }
  row.append(edit)

  if (has) {
    const del = el('button', 'btn btn--line', '지우기')
    del.type = 'button'
    del.disabled = !!S.busy
    del.onclick = () => dropBackground()
    row.append(del)
  }
  c.append(row)

  // 고친 배경은 다시 생성해야 프롬프트에 들어갑니다. 그 사실을 버튼 옆에 적어 둡니다
  if (has && S.scenes.some((s) => s.prompt) && canPlan()) {
    c.append(el('p', 'note', '배경을 고치신 뒤에는 아래 「다시 생성」을 눌러야 프롬프트에 반영됩니다.'))
  }
  return c
}

/* ── STEP 2 ───────────────────────────────────── */
function step2() {
  const w = el('div', 'wrap wrap--2')

  /*
   * 왼쪽 칸입니다. 배경 카드와 프롬프트 목록이 위아래로 섭니다.
   *
   * 이 div 가 필요합니다. .wrap--2 는 두 칸 그리드라서(key-visual.html) 카드를 w 에 바로
   * 붙이면 그것이 칸 하나를 차지하고 오른쪽 옵션이 다음 줄로 밀립니다. .wrap>div 가
   * 이미 「한 칸 안의 세로 쌓기」 모양을 들고 있어서 오른쪽 칸과 같은 방식입니다.
   */
  const left = el('div')
  left.append(bgCard())

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
    // 'ask' 는 배경 물음을 만드는 중입니다. 그것도 이 버튼이 시작한 일이라 여기서 말합니다
    const re = el('button', 'btn btn--line',
      S.busy === 'prompt' ? '생성중…' : S.busy === 'ask' ? '물음을 만드는 중…' : '다시 생성')
    re.type = 'button'; re.disabled = !!S.busy
    re.onclick = () => writePrompts()
    row.append(re)
  }
  a.append(row)
  left.append(a)
  w.append(left)

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
  go.dataset.coach = 'gen'      // 예시 안내가 짚는 자리입니다
  go.disabled = !S.scenes.some((s) => s.prompt)
  // 단계를 여기서 넘기지 않습니다. 물어보는 창을 그만둔 사람이 빈 대기열 앞에 서지
  // 않도록 runBatch 가 실제로 시작할 때 넘깁니다
  go.onclick = () => runBatch()
  b.append(go)
  // 권한이 없으면 버튼을 눌리게 두지 않습니다. 눌러 봐야 403 이 오고, 그 왕복이
  // 알려 주는 것은 이 줄이 미리 말해 주는 것과 같습니다
  if (!mayGen()) {
    go.disabled = true
    b.append(el('p', 'note note--no', denyReason('gen', myRole())))
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
   * 이미 있었다. genOne 이 장마다 paintBoard() 를 부르는데, #kvgrid 가 STEP 4
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
    /*
     * 이미 눌렀으면 누른 것이 보이게 합니다.
     *
     * 전에는 이 버튼이 S.stop 만 세우고 say() 로 끝났습니다. say 는 화면에 안 보이는
     * 칸에 적으므로(key-visual.html 의 .sr #live) 눈에는 아무 일도 일어나지 않고,
     * 버튼은 그대로 눌리는 채였습니다. 게다가 이미 GPU 로 떠난 요청 세 개는 끝까지
     * 그려집니다(LANES). 그래서 사람은 30초 넘게 그림이 계속 나오는 것을 보며
     * 「안 먹는다」고 판단하고 다시 누릅니다. 눌린 것과 남은 것을 여기서 말합니다.
     */
    const left = S.scenes.filter((s) => job(s.id).status === 'running').length
    const st = el('button', 'btn btn--line', S.stop
      ? `멈추는 중 · 보낸 ${left}장은 끝까지 그립니다` : '남은 씬 멈추기')
    st.type = 'button'
    st.disabled = S.stop
    st.onclick = () => {
      S.stop = true
      wire('u', '남은 씬 멈추기 · 대기 중인 씬을 취소합니다')
      say('멈추는 중입니다. 이미 보낸 장은 끝까지 그립니다')
      // 대기였던 씬을 그 자리에서 대기열에서 뺍니다. 이것이 눈에 보이는 유일한 변화입니다
      for (const s of S.scenes) {
        const j = job(s.id)
        if (j.status === 'queued') j.status = 'idle'
      }
      paint()
    }
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
  /*
   * 두 줄을 표에서 만듭니다(domain/permissions.js). 손으로 적어 두면 서버의 허용 목록이
   * 바뀔 때 이 카드만 옛말을 하는데, 하필 「누가 할 수 있나」를 알려 주는 카드입니다.
   */
  const kos = (list) => list.map((r) => ROLE_KO[r] || r).join(' · ')
  const may = JOB_ROLES.gen
  const mayNot = Object.keys(ROLE_KO).filter((r) => !may.includes(r))
  line(kos(may), '생성 요청이 통과합니다', true)
  line(kos(mayNot), '서버가 403 으로 거절합니다', false)
  p.append(tbl)
  p.append(el('p', mayGen() ? 'note' : 'note note--no', mayGen()
    ? `지금 역할은 ${ROLE_KO[myRole()]} 입니다. 생성이 통과합니다.`
    : denyReason('gen', myRole())))
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
    { k: '여러 대', v: '같은 대기열을 여러 대가 나눠 집습니다', t: one ? '장당 시간은 그대로' : '-' },
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
      ? (j.example
        ? '예시 그림. 생성 서버를 부르지 않았습니다. 「이 씬만 다시 생성」이 진짜로 그립니다'
        : `${(j.ms / 1000).toFixed(1)}s · seed ${j.seed} · ${j.modelLabel || ''}`)
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

/* ══ 온보딩 ════════════════════════════════════════ */

/**
 * 비어 있을 때의 판. 예시 대본을 넣고 돌려 보거나, 직접 붙여넣고 시작합니다.
 *
 * 예전에는 boot() 이 SAMPLE 을 무조건 S.script 에 넣었습니다. 그러면 처음 온 사람이
 * 자기가 넣지도 않은 대본을 보게 되고, 그것이 예시인지 남이 넣은 것인지 알 수
 * 없었습니다. 이제 비어 있으면 비어 있는 대로 두고, 예시는 눌러서 넣습니다.
 */
function welcomePanel() {
  return emptyHint({
    text: '처음이시면 예시로 네 단계를 먼저 볼 수 있습니다.',
    exampleLabel: '예시로 보기',
    onExample: () => runExample(),
    /*
     * 「직접 시작하기」를 없앴습니다. 이 화면의 「직접」은 왼쪽 칸에 대본을 붙여넣는
     * 것이고 그 칸이 바로 옆에 열려 있습니다. 버튼이 하던 일도 커서를 그 칸에 두는
     * 것뿐이라, 사람이 그냥 칸을 누르는 것과 같았습니다.
     */
    note: '예시는 미리 받아 둔 데이터만 씁니다. 기다리는 시간이 없고, 그림은 「예시」로 표시됩니다.',
  })
}

/*
 * 코치마크 넉 장. 지금 화면에 실제로 있는 것만 가리킨다. 앵커가 없는 장은 coach.js 가
 * 조용히 건너뛴다. step 은 그 앵커가 있는 단계라서, 코치마크가 화면을 그 단계로 옮긴다.
 *
 * 여기에 쓰지 않는 말 세 개: 빠르다 · 무한히 확장된다 · 제작 기간이 줄어든다.
 * 화면에서 8장이 몇 분 걸리고 한 장은 실패하고 한 대가 순서대로 그린다.
 */
const KV_CARDS = [
  {
    step: 1,
    head: '대본은 이 계정 안에 머뭅니다',
    body: '여기 붙인 대본은 우리 계정 안에서만 읽힙니다.\n그림 설명을 쓰는 모델도, 그림을 그리는 모델도\n같은 계정 안에 있습니다.',
    spot: ['script'],
    next: '다음', skip: '건너뛰기',
  },
  {
    step: 3,
    head: '만드는 동안만 장비가 켜집니다',
    body: '그래픽 장비는 업무 시간에만 켜져 있습니다.\n첫 장이 조금 늦는 것은 그때 모델을 올리기\n때문입니다. 밤과 주말에는 내려가 있습니다.',
    spot: ['rig', 'queue'],
    next: '다음', skip: '건너뛰기',
  },
  {
    step: 3,
    head: '생성 권한은 서버에서 확인합니다',
    body: '검수자에게 버튼을 숨기지 않습니다.\n요청이 도착하면 서버가 역할을 보고 거절합니다.\n화면을 우회해도 결과는 같습니다.',
    spot: ['perm', 'whoami'],
    next: '다음', skip: '건너뛰기',
  },
  {
    step: 3,
    head: '그림 모델만 직접 운영합니다',
    body: 'LLM 은 Bedrock 으로 호출하고,\n그림 모델은 이 계정의 EC2 에서 직접 돌립니다.\n두 종류가 같이 도는데 관리할 것은 한 대입니다.',
    spot: ['tab2', 'rig'],
    tags: [{ on: 'tab2', text: 'LLM · Bedrock' }, { on: 'rig', text: '그림 모델 · 직접 운영' }],
    next: '다음', skip: '건너뛰기',
  },
  {
    head: '지나간 일은 옆 기둥에 남습니다',
    body: '누가 어느 단계에서 무엇을 했는지 오른쪽에 모입니다.\n줄을 누르면 그 씬으로 갑니다. 이어서 하는 자리입니다.\n보드와 같은 기록을 봅니다.',
    spot: ['histbox'],
    next: '시작하기', skip: '다시 보지 않기',
  },
]

const COACH_KEY = 'sb.kv.coach.v1'

/*
 * 예시 안내를 시작합니다. 안내 자체는 app-walkthrough 에 있습니다. 그쪽은 이 파일을
 * import 할 수 없어서(../../app-walkthrough/tour.js 의 머리글) 쓸 것을 여기서 넣습니다.
 * 넘기는 이름은 다 이 파일의 것이고, 안내는 사람이 손으로 누르는 것과 같은 함수를
 * 부릅니다. 안내만 아는 길로 화면을 움직이면 안내에서만 되는 일이 생깁니다.
 */
function runExample() {
  return keyVisualExample({
    S, paint, wire, note, mark, job, makeArt, toScenes, normalizeVisuals,
    paintQueue, paintBoard, doneJobs,
    /*
     * 예시를 마치면 끝입니다. 예전에는 여기서 코치마크 넉 장을 이어 열었습니다.
     * 예시가 이미 네 단계를 짚어 가며 그 화면을 다 보여준 뒤라, 「여기까지가
     * 예시입니다」 를 읽고 끝났다고 생각한 사람에게 막이 한 번 더 덮이는 셈이었습니다.
     * 다 본 사람에게 같은 화면을 다시 설명하는 것이 피로해서 그 자리를 없앴습니다.
     *
     * 코치마크 자체는 남아 있습니다. 예시를 보지 않고 온 사람에게는 여전히 열리고,
     * 다시 보고 싶으면 헤더의 「안내 다시 보기」입니다. 예시를 본 사람에게만 열지
     * 않습니다. 그래서 봤다고 적어 둡니다. 안 적으면 다음에 이 화면을 열 때(그때는
     * 대본이 차 있으므로) 스스로 열려서, 없앤 것이 한 걸음 미뤄지기만 합니다.
     */
    afterDone: () => { coach.skip(COACH_KEY); paint() },
  })
}

function openCoach() {
  // 예시 안내 중에는 막을 덮지 않습니다. 짚은 자리를 사람이 실제로 눌러야 합니다
  if (guiding()) return
  coach.start({
    cards: KV_CARDS,
    key: COACH_KEY,
    title: '키 비주얼',
    host: {
      atStep: () => S.step,
      goStep: (n) => {
        // 2·3·4 장은 뒤쪽 단계를 가리킨다. 아직 못 간 단계면 앵커를 보여줄 수 없으니
        // 대본을 먼저 나눠서 화면을 만든다. 대본이 비어 있으면 나눌 것이 없어 그 장은
        // 앵커가 없는 채로 남고, coach.js 가 조용히 건너뛴다.
        if (n > 1 && !S.scenes.length) { S.scenes = toScenes(S.script); S.pick = S.scenes[0]?.id || null }
        S.step = n
        paint()
      },
    },
  })
}

/* ══ 지나간 일 ═════════════════════════════════════ */

/**
 * 히스토리. 보드와 같은 로그를 읽습니다. 이 화면이 따로 쌓는 것이 아닙니다.
 * 「내 것만」으로 좁히면 내가 이 화면에서 등록한 목록이 되고, 줄을 누르면 그 씬으로
 * 갑니다.
 */
function paintHist() {
  const box = $('#hist')
  if (!box) return
  const list = group(entries(S.journal, {
    who: (id) => (id === S.me?.id ? S.me : S.peers.get(id)) || null,
    actor: S.histMine ? S.me?.id : null,
    limit: 30,
  }))
  $('#histMine')?.setAttribute('aria-pressed', String(S.histMine))
  paintList(box, list, {
    showStep: true,
    none: S.histMine ? '내가 등록한 것이 아직 없습니다.' : '아직 지나간 일이 없습니다.',
    onPick: (e) => {
      // ref 는 씬 id(S01) 이거나 보드 패널 id 다. 이 화면에 있는 씬만 골라 준다
      const s = scene(e.ref) || S.scenes.find((x) => job(x.id).panelId === e.ref)
      if (!s) { say('그 씬은 지금 이 화면에 없습니다.'); return }
      S.pick = s.id
      S.blk = s.blkIdx[0]
      if (S.step < 3) S.step = job(s.id).status === 'done' ? 4 : 2
      paint()
    },
  })
}

/* ══ 전체 ══════════════════════════════════════════ */

function paint() {
  paintNav(); paintPeers(); paintFeed(); paintHist()
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
  // 「배포됨」 배지는 없앴습니다. 보는 사람이 할 일과 상관없는 값이라 머리만 길어졌습니다.
  // 배포인지 로컬인지가 실제로 갈리는 자리(생성 서버 · 문장 모델)는 그 자리에서 말합니다.
  const w = $('#whoami')
  w.textContent = `${ROLE_KO[myRole()] || myRole()}로 로그인`
  w.title = mayGen() ? '생성 요청이 서버를 통과합니다' : '서버가 생성 요청을 403 으로 거절합니다'
}

/* ══ 시작 ══════════════════════════════════════════ */

async function boot() {
  /*
   * 세 화면 공통 기능 탭. 로그인을 기다리기 전에 먼저 붙인다. 로그인 창이 떠 있는
   * 동안에도 머리 띠가 완성된 모양으로 보이고, 여기서 다른 기능으로 나갈 수도 있다.
   *
   * keyvisual 만 이 화면 몫(handled)이다. handled 에 든 탭은 <a> 가 아니라 <button>
   * 이 되어 이동하지 않으므로, 화면이 없는 탭을 넣으면 눌러도 아무 일 없는 버튼이
   * 된다. onSelect 를 주지 않은 것도 그래서다. 이미 이 화면이라 할 일이 없다.
   *
   * 아래의 #nav(paintNav)와는 층이 다르다. 이건 "어느 기능", 그건 "그 기능의 몇 번째
   * 단계"다.
   */
  /*
   * utilMount: 아키텍처 · 권한 관리 · 홈은 탭 바가 아니라 머리 띠 오른쪽에 붙는다.
   * 탭 바 안에서는 잔글씨로 흐려져 있어 셋 다 눈에 걸리지 않았다.
   */
  mountNav({
    mount: $('#navMount'), active: 'keyvisual', handled: ['keyvisual'], utilMount: $('#utilMount'),
  })

  // 머리의 왼쪽. 네 화면이 같은 것을 씁니다. 누르면 홈입니다
  mountBrand('#brandMount')

  /*
   * 배포 모드에서는 먼저 로그인을 받는다.
   *
   * 예전에는 이 화면에 로그인 창이 없어서, 토큰 없이 열면 AppSync 가 WebSocket 을
   * 바로 닫았다. net.js 의 ready() 는 connection_ack 에서만 resolve 하므로 그 상태로는
   * resolve 도 reject 도 되지 않고 · 아래 await 에서 영구히 멈췄다. 예외가 아니라
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

  /*
   * 작업판 앞에 프로젝트 보드를 세운다. 주소에 ?board= 가 있으면 그대로 지나간다.
   * 고르면 그 주소로 화면을 다시 여는 것이라 이 await 은 끝나지 않는다. 아래의
   * connect() 도 로그 읽기도 시작하지 않는다. 어느 보드인지 모르는 채로 소켓을 열면
   * 고른 뒤에 그것을 다 물려야 한다.
   */
  await pickProject({
    step: 'keyvisual',
    actor: S.me?.id,
    who: (id) => S.peers.get(id) || (id === S.me?.id ? S.me : null),
  })

  /*
   * 대본 칸을 이 프로젝트에 담긴 대본으로 채운다.
   *
   * 예전에는 비어 있는 채로 시작했다. 예시 대본을 미리 넣어 두면 처음 온 사람이 자기가
   * 넣지도 않은 대본 앞에서 그것이 예시인지 남이 넣은 것인지 모른 채 「씬으로 나누기」를
   * 누르게 되므로, 그것을 없앤 자리다. 예시는 여전히 「예시 보기」로만 들어온다.
   *
   * 지금 넣는 것은 예시가 아니라 이 프로젝트의 대본이다. 스토리 디벨롭에서 만들었으면
   * 거기서 담겼다(pages/story-graph.js 의 keepScript). 그전에는 사람이 그 화면에서
   * 「복사」를 눌러 이 칸에 붙여야 했다. step 1-2-3 이 이어진 것처럼 보였던 것은 화면
   * 순서일 뿐이고 데이터로는 끊겨 있었다. 이 한 줄이 그것을 잇는다.
   *
   * 씬도 같이 되살린다. 새로고침으로 씬이 사라지면 「그림 만들기」를 다시 하려고 나누기를
   * 또 눌러야 했고, 머리글 없는 글이면 그것이 Bedrock 왕복 한 번이었다.
   */
  await restoreAssets()

  // 보드에 붙기 전에 한 번 그린다. 연결이 오래 걸리거나 실패해도 화면은 이미 있고,
  // 실시간 기능만 나중에 붙는다. 아래 connect() 가 유일한 렌더 관문이면 안 된다.
  paint()

  try {
    S.net = await connect({
      onOp: (op) => {
        // 남이 지금 한 일도 「지나간 일」에 들어간다. 내 것은 mark 와 postToBoard 가 이미 넣었다
        if (op.actor !== S.me.id) { S.journal.push(op); paintHist() }
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
    wire('r', `보드 연결 실패 · ${e.message}`)
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

  /*
   * 지나간 일은 보드와 같은 로그에서 읽는다. 이 화면이 따로 쌓는 것이 없으므로
   * 다른 사람이 어제 무엇을 했는지도 여기서 보인다. 실패하면 빈 목록으로 둔다. * 기록을 못 읽은 것이 생성을 막을 이유는 아니다.
   */
  const past = await S.net?.fetchOps?.().catch((e) => {
    wire('r', `기록을 읽지 못했습니다. ${e.message}`)
    return null
  })
  // 목록은 최근 30줄만 그린다. 오래된 것을 다 들고 있을 이유가 없다
  if (past?.length) S.journal.unshift(...past.slice(-300))

  pollGpu()
  setInterval(pollGpu, 20_000)
  paint()

  $('#coachBtn').onclick = () => openCoach()
  $('#histMine').onclick = () => { S.histMine = !S.histMine; paintHist() }
  /*
   * 처음 온 사람에게 코치마크를 연다. 단, 대본 칸이 비어 있으면 열지 않는다. 그때는
   * 화면에 「처음 오셨나요?」 판이 있고 그 판이 두 갈래를 이미 말해 준다. 막을 덮어
   * 그것을 가릴 이유가 없다. 예시를 보거나 직접 시작하면 그 뒤에 열린다.
   */
  if (demoActive()) {
    // 예시 프로젝트가 데려온 길이다. 「예시 보기」를 한 번 더 누를 이유가 없다
    runExample()
    return
  }

  if (!coach.seen(COACH_KEY) && S.script.trim()) openCoach()
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('textarea, input')) return
  if (e.key === 'ArrowRight' && S.step < 4 && stepOk(S.step)) { S.step++; paint() }
  if (e.key === 'ArrowLeft' && S.step > 1) { S.step--; paint() }
})

boot()

export { S, runBatch, genOne, postToBoard }
// 씬 나누기는 domain/scene-split.js 로 옮겼습니다. 이 이름을 쓰던 자리를 위해 다시 내보냅니다
export { toScenes, readSlug }
