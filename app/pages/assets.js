/*
 * 자산관리 — 인물 · 배경 · 소품 · 스틸.
 *
 * ══ 무엇을 하는 화면인가
 *
 * 프로젝트의 그림 자산이 모이는 곳입니다. 세 갈래로 들어옵니다.
 *   - 스토리보드에서 감독이 컷을 승인하면 그 그림에서 뽑힌 인물·배경·소품(board.js 의 extractAssets)
 *   - 여기서 직접 올린 그림(스케치·레퍼런스 사진)
 *   - 여기서 지시문으로 만든 그림
 * 그리고 그 자산들을 여러 장 골라 실사 스틸을 만듭니다. 콘티는 연필이지만 스틸은 VFX·영상 기획이
 * 룩을 잡는 한 장이라 사진 룩(server.py 의 STYLE_REAL)으로 갑니다. 참조 자산이 연필 그림이어도
 * 얼굴·장소·물건만 물려받고 질감은 버립니다. 크기는 1920×1088 이고 뷰어에서 원본 크기로 봅니다.
 *
 * ══ 후보 → 자산
 *
 * 지시문으로 만드는 것(자산·스틸)은 바로 자산이 되지 않습니다. 정한 수만큼 후보(S.drafts)로 나오고,
 * 사람이 그중 저장할 것만 고릅니다. 저장을 누른 것만 op(asset.add)가 되어 팀에 보이고 지울 때까지
 * 남습니다 — 그림 파일은 S3 에, 올린 그림도 putImage 로 S3 에 갑니다. 마음에 안 드는 넷 중 셋을
 * 지우는 일이 없어지고, 스틸은 여러 버전을 나란히 놓고 고릅니다. 지시문으로 만든 자산은 스틸과
 * 같은 사진 룩입니다 — 실사 스틸의 참조가 되는 것이라서입니다.
 *
 * ══ 탭을 오가도 일이 남습니다
 *
 * 작업자는 만들기를 눌러 두고 스토리보드에 다녀옵니다. 후보와 남은 일감(S.queue)은 이 브라우저의
 * localStorage(sb.drafts.<board> · sb.queue.<board>)에 있고, 돌아오면 큐가 이어서 돕니다. 페이지를 떠나며
 * 끊긴 요청은 서버가 일감 번호(job)로 결과를 보관하므로(server.py 의 /gen/result) 돌아와서 찾아갑니다.
 *
 * ══ 자산은 어디에 있나
 *
 * 스토리보드와 같은 op 로그입니다(asset.add · asset.patch · asset.remove). 이 화면은 그 로그를 처음부터
 * 다시 재생해 자산만 접습니다. 보드가 한 일이 여기 바로 보이고, 여기서 한 일이 보드의 「참조 자산」
 * 칩에 바로 뜹니다 — 두 화면이 같은 사실을 봅니다. 로컬 모드(aws-config 없음)는 보드가 저장하는
 * localStorage 판(sb.state.<board>)의 assets 칸을 같이 씁니다.
 *
 * ══ 실측
 *
 * klein 4B · L40S · 1920×1088 · 8걸음 · 참조 3장: 약 20초. CloudFront 의 /gen 60초 안입니다.
 */

import { boardFromSearch } from '../domain/routes.js'
import { mountNav } from '../components/nav-tabs.js'
import { mountBrand } from '../components/brand.js'
import { configured, idToken, session } from '../services/auth.js'
import { showLogin } from '../components/login-form.js'
import { connect, connectorClient } from '../services/api.js'
import { pickProject } from '../components/project-picker.js'
import { ASSET_TYPES, REF_TYPES, mergeField, scrub, isVideoSrc } from '../domain/panels.js'
import { allowed, denyReason } from '../domain/permissions.js'
import { downscale } from '../lib/placeholder-art.js'
import { esc, setHtml } from '../lib/dom.js'
import { gpuDownHint } from '../lib/gpu-hours.js'
import { confirmAsk } from '../components/confirm.js'

const $ = (id) => document.getElementById(id)
const cfg = window.SB_CONFIG || {}
const BOARD = boardFromSearch()
const conn = connectorClient()   // 배포 모드에서만. 올리기(S3)와 GPU 켜고 끄기가 이 길로 갑니다
const now = () => Date.now()
const uid = () => now().toString(36) + Math.random().toString(36).slice(2, 8)

/* 종류의 순서. 왼쪽 기둥과 스틸의 참조 순서(인물 → 배경 → 소품)가 이것입니다 */
const CATS = ['char', 'bg', 'prop', 'still']
/* 종류마다 「AI로 만들기」에 붙는 말. 서버가 한국어를 영어로 옮깁니다(server.py 의 en) */
const MAKE_HINT = {
  char: '인물 전신, 정면, 단색 배경, 배경 없음',
  bg: '사람 없는 빈 장소, 넓은 설정 샷',
  prop: '물건 하나만, 가운데 크게, 단색 배경, 손이나 사람 없음',
}
const MAKE_PLACEHOLDER = {
  char: '예: 화목한 가족 넷, 여름 옷차림',
  bg: '예: 넓고 맑은 바다, 한여름 정오',
  prop: '예: 노란 수영모자',
}
/* 한 번에 만드는 수. 후보로 나오고 고른 것만 자산이 됩니다. 서버는 장마다 따로 부르므로 수 자체에 제한은 없습니다 */
const COUNTS = [1, 2, 3, 4, 6]

const S = {
  me: null,
  net: null,
  assets: {},
  chars: {},
  cat: 'all',
  sel: [],            // 고른 자산 id. 순서가 참조 순서입니다
  prompt: '',
  make: null,         // { type, prompt, n } — 「AI로 만들기」 칸이 열려 있으면
  makeModel: null,    // 「AI로 만들기」로 고른 모델 id. 칸을 닫고 다시 열어도 남게 make 밖에 둡니다
  drafts: {},         // 후보. id → { id, type, name, src, prompt, refs?, gen, ts }. 저장한 것만 자산이 됩니다
  queue: [],          // 일감. { job, kind:'asset'|'still', type, prompt, name, refs, v, of, status:'todo'|'run', at }
  paused: '',         // 큐가 멈춘 이유(서버에 못 닿음 등). 「이어서 만들기」로 다시 돕니다
  stillN: 2,          // 스틸 버전 수
  stop: false,        // 「그만」— 다음 장부터 만들지 않습니다
  busy: null,         // 진행 한 줄
  busyKind: null,     // 'make' | 'still' — 어느 칸이 돌고 있는지. 다른 칸은 「그만」을 내지 않습니다
  startedAt: 0,       // 만들기를 누른 때. 더블클릭의 둘째 클릭이 방금 나타난 「그만」에 떨어지는 것을 걸러냅니다
  err: '',
  view: null,         // 뷰어가 보여주는 자산 id
  zoom: 'fit',
  gpu: { state: 'unknown', text: '확인 중', models: [], resident: null },
}

/* ══ 권한 ═══════════════════════════════════════════════════════════════════ */
const role = () => S.me?.role || 'reviewer'
const canGen = () => !!cfg.genUrl
// 그림 만들기(스틸 · AI로 만들기)는 아티스트·기획. 올리기·이름·지우기는 감독까지(자산 뽑기와 같은 표).
// 로컬 모드도 역할을 봅니다 — ?as=reviewer 로 리뷰어 화면을 확인할 수 있어야 합니다(보드와 같음)
const mayGen = () => allowed('gen', role())
const mayEdit = () => allowed('extract', role())

/* ══ 판 ═════════════════════════════════════════════════════════════════════ */
const list = () => Object.values(S.assets).sort((a, b) => (b.ts || 0) - (a.ts || 0))
const src = (a) => (a?.src && !isVideoSrc(a.src) ? a.src : null)
const inCat = (a) => S.cat === 'all' ? a.type !== 'still' : a.type === S.cat
const shown = () => list().filter(inCat).filter(src)
const picked = () => S.sel.map((id) => S.assets[id]).filter((a) => a && src(a) && REF_TYPES.includes(a.type))
const typeName = (t) => ASSET_TYPES[t] || t || ''
const whence = (a) => (a.fromPanelId ? '컷에서 뽑음' : a.source === 'upload' ? '올림' : a.type === 'still' ? '실사 스틸' : 'AI')
const charName = (id) => S.chars[id]?.name || ''
const drafts = () => Object.values(S.drafts).sort((a, b) => (b.ts || 0) - (a.ts || 0))
// 후보 판은 만든 순서(1 → N)로. 최신순이면 왼쪽이 마지막 버전이라 번호와 자리가 어긋납니다
const draftsIn = () => drafts().filter((d) => (S.cat === 'all' ? d.type !== 'still' : d.type === S.cat)).sort((a, b) => (a.ts || 0) - (b.ts || 0))
/** 뷰어·타일이 보는 그림 하나. 자산이거나 후보입니다 */
const item = (id) => S.assets[id] || S.drafts[id] || null
const isDraft = (a) => !!a && !S.assets[a.id] && !!S.drafts[a.id]

function apply(raw) {
  const op = scrub(raw)
  switch (op?.kind) {
    case 'asset.add':
      if (op.asset?.id && !S.assets[op.asset.id]) S.assets[op.asset.id] = { ...op.asset, _ts: {} }
      return true
    case 'asset.patch': {
      const a = S.assets[op.assetId]
      if (a) for (const [k, v] of Object.entries(op.fields || {})) mergeField(a, k, v, op.ts)
      return !!a
    }
    case 'asset.remove':
      delete S.assets[op.assetId]
      S.sel = S.sel.filter((id) => id !== op.assetId)
      if (S.view === op.assetId) S.view = null
      return true
    case 'char.add':
      if (op.char?.id) S.chars[op.char.id] = { ...op.char, _ts: {} }
      return false
    case 'char.patch': {
      const c = S.chars[op.charId]
      if (c) for (const [k, v] of Object.entries(op.fields || {})) mergeField(c, k, v, op.ts)
      return false
    }
    default:
      return false
  }
}

/*
 * 로컬 모드의 저장. 보드가 쓰는 판(sb.state.<board>)의 assets 칸만 갈아 끼웁니다. 보드가 열려
 * 있으면 BroadcastChannel 로 같은 op 를 받아 자기 판에도 넣고 저장하므로 둘이 같은 곳을 씁니다.
 */
const localKey = () => `sb.state.${BOARD}`
function loadLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(localKey()) || 'null')
    if (!s) return
    S.assets = { ...(s.assets || {}) }
    S.chars = { ...(s.chars || {}) }
  } catch { /* 깨진 판은 빈 판으로 봅니다 */ }
}
function saveLocal() {
  if (S.net?.mode !== 'local') return
  try {
    const s = JSON.parse(localStorage.getItem(localKey()) || 'null') || {
      board: { title: '스토리보드', scenario: '', _ts: {} }, eps: {}, chars: {}, panels: {}, members: {}, perms: {},
      comments: [], events: [], notifs: [],
    }
    s.assets = S.assets
    localStorage.setItem(localKey(), JSON.stringify(s))
  } catch { /* 저장소가 꽉 찼으면 화면에는 남아 있습니다 */ }
}

/* 후보와 일감은 이 브라우저에 남습니다. 탭을 오가도, 새로고침해도 그대로입니다 */
const workKey = (k) => `sb.${k}.${BOARD}`
function saveWork() {
  try {
    localStorage.setItem(workKey('drafts'), JSON.stringify(S.drafts))
    localStorage.setItem(workKey('queue'), JSON.stringify(S.queue))
  } catch { /* 저장소가 꽉 찼으면 화면에는 남아 있습니다 */ }
}
function loadWork() {
  try { S.drafts = JSON.parse(localStorage.getItem(workKey('drafts')) || '{}') || {} } catch { S.drafts = {} }
  try { S.queue = (JSON.parse(localStorage.getItem(workKey('queue')) || '[]') || []).filter((t) => t && t.job) } catch { S.queue = [] }
}

function emit(op) {
  op.id = uid(); op.ts = now(); op.actor = S.me?.id || 'local'
  apply(op)
  S.net?.sendOp(op)
  saveLocal()
  paint()
}

/* ══ GPU ════════════════════════════════════════════════════════════════════ */
async function askGpu(body, path = '') {
  const res = await fetch(cfg.genUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await idToken()}` },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(json.detail || (res.status === 502
      ? '생성 서버가 꺼져 있습니다 (502)'
      : res.status === 504 ? '생성 서버가 60초 안에 답하지 못했습니다 (504). 잠시 뒤 다시 눌러주세요'
        : `생성 서버 오류 (${res.status})`))
    err.status = res.status
    throw err
  }
  return json
}

async function health() {
  const r = await fetch(`${cfg.genUrl}/health`, { cache: 'no-store' })
  return r.json()
}

async function pollGpu() {
  if (!canGen()) { S.gpu = { state: 'none', text: '이 배포에는 생성 서버가 없습니다', models: [] }; paintStill(); return }
  try {
    const j = await health()
    const draw = (j.models || []).filter((m) => !m.video)
    const resident = draw.some((m) => m.id === j.modelId) ? j.modelId : null
    // 다른 모델의 실패 사유는 이 화면의 것이 아닙니다. 스틸은 참조 모델(klein)로 가므로
    // krea 가 못 올라온 사유를 빨간 불로 보이면 되는 일을 안 되는 것으로 읽습니다
    const mine = j.ref || draw.find((m) => m.strength === false && m.init !== false)?.id || 'klein'
    const err = j.error && (!j.errorModel || j.errorModel === mine) ? j.error : null
    S.gpu = {
      state: err ? 'error' : j.loading || !j.warm ? 'loading' : j.busy ? 'busy' : 'ready',
      text: err ? `생성 서버: ${err}` : j.loading || !j.warm ? `모델을 올리는 중${j.wait ? ` · 약 ${Math.round(j.wait)}초` : ''}`
        : j.busy ? '다른 그림을 그리는 중' : resident ? `${j.model} 준비됨` : '그림 모델 대기',
      models: draw, resident, wait: j.wait || 0, err, default: j.default, ref: j.ref || null,
    }
  } catch {
    S.gpu = { state: 'down', text: gpuDownHint(), models: [] }
  }
  paintStill()
}

/*
 * ══ 이 화면의 모델이 둘로 갈립니다 ═══════════════════════════════════════════
 *
 * 자산 하나하나를 만드는 일(왼쪽 「AI로 만들기」)은 고를 수 있습니다. 인물 한 명·배경 한
 * 장·소품 하나를 글로 그리는 일이라 무엇으로 그릴지가 취향입니다 — 글만 보고 빠르게 그리는
 * 것과 참조 이미지를 받아 기존 자산을 살리는 것이 다른 결과를 냅니다.
 *
 * 자산 여러 장을 한 장으로 합치는 일(오른쪽 「실사 스틸」)은 못 고릅니다. 늘 FLUX 계열입니다.
 * 고르는 것이 아니라 그것만 되는 일입니다 — 스틸은 자산 N장을 조건으로 받아야 하고, 그림
 * 목록을 조건으로 받는 갈래가 flux2 뿐입니다. img2img 갈래(chroma·sd3)는 한 장만 받고 그
 * 그림을 지우고 다시 그려서 얼굴이 바뀌고, krea 는 그림을 아예 받지 않습니다(server.py 의
 * refs_of · MODELS 의 init). 목록에 내 두고 고르게 하면 고른 사람은 참조가 말없이 버려진
 * 그림을 받습니다. 서버도 같은 판단을 겹으로 합니다(pick_for).
 *
 * 그래서 스틸 칸은 모델 줄을 「FLUX.2 klein · 고정」으로 적고 고르는 칸을 내지 않습니다.
 */

/* 「AI로 만들기」가 쓸 모델. 고른 것이 없으면 올라와 있는 것, 그것도 없으면 서버 기본 */
const makeModelId = () => {
  const ids = S.gpu.models.map((m) => m.id)
  if (S.makeModel && ids.includes(S.makeModel)) return S.makeModel
  return [S.gpu.resident, S.gpu.default].find((id) => ids.includes(id)) || ids[0] || null
}
/*
 * 스틸이 쓸 모델. 서버가 말해 주는 것(j.ref → ref_model)을 그대로 씁니다 — 9B 가중치가
 * 디스크에 있으면 그것이고 없으면 4B 라, 화면이 다시 셈하면 두 곳이 갈라집니다. 못 물어본
 * 사이(GPU 가 꺼져 있을 때)는 목록에서 조건으로 받는 것을 찾고, 그것도 없으면 klein 입니다.
 */
const refModel = () => (S.gpu.ref && S.gpu.models.some((m) => m.id === S.gpu.ref) ? S.gpu.ref
  : S.gpu.models.find((m) => m.strength === false && m.init !== false)?.id ?? 'klein')
/*
 * 그 모델의 사람이 읽는 이름. 목록이 아직 없으면(GPU 가 꺼져 있으면) 갈래 이름으로 적습니다 —
 * 「klein」은 id 라 화면에 그대로 내면 무엇인지 모릅니다. 어느 판(4B·9B)인지는 켜진 뒤에
 * 정해지므로(server.py 의 ref_model), 그때까지는 갈래까지만 말하는 것이 맞습니다.
 */
const refLabel = () => S.gpu.models.find((m) => m.id === refModel())?.label || 'FLUX.2 klein'

/** 503 이면 모델이 올라올 때까지 기다린 뒤 한 번 다시 보냅니다 */
async function askPatient(body, tick) {
  try {
    return await askGpu(body)
  } catch (err) {
    if (err.status !== 503) throw err
    tick(`${err.message} 준비되면 이어서 만듭니다.`)
    for (let i = 0; i < 36; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      if (S.stop) throw new Error(STOPPED)
      const j = await health().catch(() => null)
      if (!j || j.video?.busy) break
      if (j.error && (!j.errorModel || j.errorModel === body.model)) throw new Error(j.error)
      if (j.warm && !j.loading && (!body.model || j.modelId === body.model)) return askGpu(body)
      tick(`모델을 올리는 중${j.wait ? ` · 약 ${Math.round(j.wait)}초` : ''}…`)
    }
    throw err
  }
}

async function asInit(s) {
  if (!s) return null
  if (s.startsWith('data:')) return s
  const res = await fetch(s)
  if (!res.ok) throw new Error('참조 이미지를 읽지 못했습니다')
  return downscale(await res.blob(), 400_000)
}

/*
 * GPU 켜고 끄기. 시간표로 끄지 않고 사람이 정합니다 — 꺼진 GPU 앞에서 데모가 멈추고 다시 올리는 몇 분이
 * 기다림이었습니다. 켜 둔 GPU 는 시간당 약 2달러라 일이 끝나면 끕니다. 커넥터 Lambda 가 EC2 를 부릅니다.
 */
async function gpuPower(action) {
  if (!conn) return
  if (action === 'off') {
    const ok = await confirmAsk({
      title: 'GPU 를 끕니다', body: '팀 전원의 그림·영상 생성이 멈춥니다. 다시 켜면 모델이 올라오기까지 약 3~4분 걸립니다.',
      list: ['아침 9시에는 저절로 다시 켜집니다', '남은 일감은 이 브라우저에 남고, 켜지면 「이어서 만들기」로 잇습니다'], yes: 'GPU 를 끕니다', danger: true,
    })
    if (!ok) return
  }
  S.busy = action === 'on' ? 'GPU 를 켭니다 · 모델까지 약 3~4분…' : 'GPU 를 끕니다…'
  paintStill()
  try {
    const r = await conn.power(action)
    say(action === 'on' ? `GPU 를 켰습니다 (${r.state}). 약 3~4분 뒤 준비됩니다` : `GPU 를 끕니다 (${r.state})`)
    S.gpu.text = action === 'on' ? 'GPU 켜는 중 · 약 3~4분' : 'GPU 끄는 중'
  } catch (err) {
    // 아직 꺼지는 중이면 1분쯤 뒤 저절로 다시 켭니다. 사람이 시계를 보며 다시 누르게 하지 않습니다
    if (action === 'on' && /꺼지는 중/.test(err.message)) {
      S.gpu.text = 'GPU 가 아직 꺼지는 중 · 끝나면 저절로 켭니다'
      setTimeout(() => gpuPower('on'), 20_000)
    } else S.err = `GPU 를 ${action === 'on' ? '켜지' : '끄지'} 못했습니다 · ${err.message}`
  }
  S.busy = null
  paintStill()
  setTimeout(pollGpu, 8000)
}

/* ══ 만들기 ═════════════════════════════════════════════════════════════════ */

/* ══ 일감 큐 ════════════════════════════════════════════════════════════════
 *
 * 만들기는 일감(task)을 큐에 넣는 것이고, pump() 가 한 장씩 차례로 서버에 보냅니다. 큐와 후보는
 * localStorage 에 있어 탭을 오가도 남고, 돌아오면 이어서 돕니다. 페이지를 떠나며 끊긴 장은 서버가
 * job 번호로 결과를 보관하므로(/gen/result) 다시 찍지 않고 찾아갑니다.
 */
const taskLabel = (t) => `${t.kind === 'still' ? '실사 스틸' : typeName(t.type)}${t.of > 1 ? ` ${t.v}/${t.of}` : ''}`

/** 고른 자산으로 실사 스틸을 S.stillN 장 큐에 넣습니다 */
function makeStill() {
  const refs = picked()
  if (!refs.length) { S.err = '먼저 인물·배경·소품에서 참조할 자산을 고르세요.'; paintStill(); return }
  if (!mayGen()) { S.err = denyReason('gen', role()); paintStill(); return }
  const n = COUNTS.includes(S.stillN) ? S.stillN : 1
  const names = refs.map((a) => `${typeName(a.type)} ${a.name}`).join(', ')
  const prompt = S.prompt.trim() || `${names}. 영화 스틸 한 장`
  for (let i = 0; i < n; i += 1) {
    S.queue.push({
      job: uid(), kind: 'still', type: 'still', prompt, name: (S.prompt.trim() || names).slice(0, 40),
      refs: refs.map((a) => a.id), v: i + 1, of: n, status: 'todo', at: now(),
    })
  }
  S.err = ''
  saveWork()
  pump()
}

/** 지시문으로 자산 후보를 S.make.n 장 큐에 넣습니다 */
function makeAsset() {
  const m = S.make
  if (!m?.prompt.trim()) return
  if (!mayGen()) { S.err = denyReason('gen', role()); paint(); return }
  const n = COUNTS.includes(m.n) ? m.n : 1
  const model = makeModelId()
  const takesRefs = S.gpu.models.find((x) => x.id === model)?.init !== false
  const refs = takesRefs ? picked().map((a) => a.id) : []
  for (let i = 0; i < n; i += 1) {
    S.queue.push({ job: uid(), kind: 'asset', type: m.type, prompt: m.prompt.trim(), name: m.prompt.trim().slice(0, 40), model, refs, v: i + 1, of: n, status: 'todo', at: now() })
  }
  S.err = ''
  saveWork()
  pump()
}

/** 서버가 보관한 일감 결과. done 이면 결과, error 면 던지고, 모르는 일감(404)이면 null — 다시 보냅니다 */
async function fetchResult(t, tick) {
  for (let i = 0; i < 180; i += 1) {
    const res = await fetch(`${cfg.genUrl}/result/${encodeURIComponent(t.job)}`, {
      headers: { authorization: `Bearer ${await idToken()}` }, cache: 'no-store',
    })
    if (res.status === 404) return null
    if (!res.ok) { const e = new Error(`생성 서버 오류 (${res.status})`); e.status = res.status; throw e }
    const j = await res.json()
    if (j.status === 'done') return j
    if (j.status === 'error') throw new Error(j.detail || '그리다 실패했습니다')
    if (S.stop) throw new Error(STOPPED)
    tick(`${taskLabel(t)} · 떠나 있던 사이 그리던 것을 기다립니다…`)
    await new Promise((r) => setTimeout(r, 4000))
  }
  return null
}

async function runTask(t, tick) {
  if (t.kind === 'still') {
    const refs = t.refs.map((id) => S.assets[id]).filter((a) => a && src(a))
    if (!refs.length) throw new Error('참조 자산이 없어졌습니다')
    tick(`${taskLabel(t)} · 참조 그림을 읽습니다…`)
    const imgs = await Promise.all(refs.map((a) => asInit(src(a))))
    tick(`${taskLabel(t)} 그리는 중 · 약 20초…`)
    return askPatient({
      prompt: t.prompt, kind: 'still', model: refModel(), refs: imgs, refKind: 'assets', style: 'real', strength: 0.95, job: t.job,
    }, tick)
  }
  // 참조 자산이 있으면(klein) 입력으로 같이 갑니다. 없어진 자산은 빠집니다
  const refs = (t.refs || []).map((id) => S.assets[id]).filter((a) => a && src(a))
  const imgs = refs.length ? await Promise.all(refs.map((a) => asInit(src(a)))) : null
  tick(`${taskLabel(t)} 그리는 중${imgs ? ` · 참조 ${imgs.length}장` : ''}…`)
  return askPatient({
    prompt: `${t.prompt}, ${MAKE_HINT[t.type]}`, kind: t.type === 'bg' ? 'cut' : 'asset', model: t.model || null, style: 'real', job: t.job,
    ...(imgs ? { refs: imgs, refKind: 'assets', strength: 0.95 } : {}),
  }, tick)
}

function addDraft(t, r) {
  S.drafts[t.job] = {
    id: t.job, type: t.type, name: t.name, v: t.v, of: t.of, src: r.url, source: 'ai', prompt: t.prompt,
    refs: t.kind === 'still' ? t.refs : undefined, author: S.me?.id || 'local', ts: now(),
    gen: { model: r.model, seed: r.seed ?? null, ms: r.ms ?? null, size: r.size || null },
  }
  // 스틸 후보는 실사 스틸 칸에 섭니다. 첫 장이 나오면 그쪽으로 옮겨 나란히 보게 합니다(한 번만)
  if (t.kind === 'still' && t.v === 1) S.cat = 'still'
}

let pumping = false
async function pump() {
  if (pumping || !S.queue.length) return
  if (!canGen()) { S.paused = '이 배포에는 생성 서버가 없습니다'; paint(); return }
  pumping = true
  S.paused = ''
  S.stop = false
  S.startedAt = now()
  const tick = (t) => { S.busy = t; paint() }
  let made = 0
  try {
    while (S.queue.length) {
      const t = S.queue[0]
      if (S.stop) {
        // 「그만」: 아직 안 보낸 것만 버립니다. 도는 장은 끝나면 후보로 남습니다
        S.queue = S.queue.filter((x) => x.status === 'run')
        S.stop = false
        saveWork()
        if (!S.queue.length) break
        continue
      }
      S.busyKind = t.kind === 'still' ? 'still' : 'make'
      try {
        let r = null
        if (t.status === 'run') r = await fetchResult(t, tick)
        if (!r) {
          if (!mayGen()) throw new Error(denyReason('gen', role()))
          t.status = 'run'; t.at = now(); saveWork()
          r = await runTask(t, tick)
        }
        addDraft(t, r)
        made += 1
        S.queue.shift()
      } catch (err) {
        if (err.message === STOPPED) { S.queue.shift() }
        else if (err.status === undefined && /fetch|network|닿지|Failed/i.test(err.message || '')) {
          // 서버에 닿지 않습니다(GPU 꺼짐 등). 일감은 남겨 두고 멈춥니다 — 「이어서 만들기」로 다시
          S.paused = `생성 서버에 닿지 않습니다. GPU 가 켜지면 「이어서 만들기」를 누르세요 (${err.message})`
          break
        } else {
          S.err = `${taskLabel(t)}: ${err.message}`
          S.queue.shift()
        }
      }
      saveWork()
      paint()
    }
  } finally {
    pumping = false
    S.busy = null
    S.busyKind = null
    S.stop = false
    saveWork()
    if (made) say(`후보 ${made}장이 나왔습니다. 저장할 것을 고르세요`)
    paint()
  }
}

/** 후보 하나를 자산으로. op 가 되어 팀에 보입니다 */
function keep(id) {
  const d = S.drafts[id]
  if (!d) return
  if (!mayEdit()) { S.err = denyReason('extract', role()); paint(); return }
  delete S.drafts[id]
  saveWork()
  const { v, of, ...rest } = d   // 버전 번호는 후보 판의 것입니다. 고른 뒤에는 뜻이 없어 자산에 남기지 않습니다
  // 같은 id 로 자산이 되므로 열려 있던 뷰어는 그대로 그 그림을 봅니다
  emit({ kind: 'asset.add', asset: rest })
  say(`${typeName(d.type)} 「${d.name}」을 자산으로 저장했습니다`)
}

async function dropAll() {
  const dr = draftsIn()
  if (!dr.length) return
  // 후보 넷은 GPU 80초분입니다. 한 장은 바로, 여럿은 한 번 묻습니다
  if (dr.length > 1) {
    const ok = await confirmAsk({
      title: `후보 ${dr.length}장을 버립니다`,
      body: '버린 후보는 되돌릴 수 없습니다. 저장하지 않은 그림은 자산이 되지 않습니다.',
      list: dr.map((d) => `${typeName(d.type)} · ${d.name}${d.of > 1 ? ` (버전 ${d.v}/${d.of})` : ''}`),
      yes: '버립니다',
      danger: true,
    })
    if (!ok) return
  }
  for (const x of dr) drop(x.id)
  say(`후보 ${dr.length}장을 버렸습니다`)
}

function drop(id) {
  const d = S.drafts[id]
  if (!d) return
  // 뷰어에서 버리면 같은 종류의 다음 후보로 넘어갑니다. 넷을 비교하다 하나를 버릴 때마다 판으로 튕기지 않게
  const next = S.view === id ? drafts().filter((x) => x.type === d.type && x.id !== id)[0] : null
  delete S.drafts[id]
  saveWork()
  S.sel = S.sel.filter((x) => x !== id)
  if (S.view === id) S.view = next?.id || null
  paint()
}

/** 파일을 올립니다. 브라우저에서 줄여(≤300KB) op 에 그대로 담습니다 */
async function upload(files) {
  const type = CATS.includes(S.cat) && S.cat !== 'still' ? S.cat : null
  if (!type) { S.err = '인물 · 배경 · 소품 중 하나를 고른 뒤 올리세요.'; paint(); return }
  if (!mayEdit()) { S.err = denyReason('extract', role()); paint(); return }
  let n = 0
  for (const f of files) {
    try {
      const data = await downscale(f, 300_000)
      // 배포 모드는 S3 에 영구 보관합니다(커넥터 Lambda 의 upload). 로컬 모드만 data:URL 로 판에 둡니다
      S.busy = `${f.name} 올리는 중…`; paint()
      const src = conn ? (await conn.upload(data, f.name)).url : data
      S.busy = null
      emit({
        kind: 'asset.add',
        asset: {
          id: uid(), type, name: f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || typeName(type), src,
          source: 'upload', author: S.me?.id || 'local', ts: now(),
        },
      })
      n += 1
    } catch (err) {
      S.busy = null
      S.err = `${f.name}: ${err.message}`
    }
  }
  if (n) say(`${typeName(type)} ${n}장을 올렸습니다. 지울 때까지 남습니다`)
  paint()
}

async function remove(id) {
  const a = S.assets[id]
  if (!a) return
  if (!mayEdit()) { S.err = denyReason('extract', role()); paint(); return }
  const uses = list().filter((x) => x.type === 'still' && (x.refs || []).includes(id)).length
  const ok = await confirmAsk({
    title: `「${a.name || typeName(a.type)}」을 지웁니다`,
    body: '되돌릴 수 없습니다. 같은 프로젝트를 보는 사람에게서도 사라집니다.',
    list: [
      `${typeName(a.type)} · ${whence(a)}`,
      ...(uses ? [`이 자산을 참조한 스틸 ${uses}장은 남습니다`] : []),
      ...(a.type !== 'still' ? ['스토리보드의 「참조 자산」 칩에서도 빠집니다'] : []),
    ],
    yes: '지웁니다',
    danger: true,
  })
  if (!ok) return
  emit({ kind: 'asset.remove', assetId: id })
  say('자산을 지웠습니다')
}

function rename(id, name) {
  const a = S.assets[id]
  const v = String(name || '').trim().slice(0, 40)
  if (!a || !v || v === a.name) return
  if (!mayEdit()) { S.err = denyReason('extract', role()); paint(); return }
  emit({ kind: 'asset.patch', assetId: id, fields: { name: v } })
}

const STOPPED = '그만두었습니다'
/* 「그만」. 시작 직후 600ms 는 무시합니다 — 만들기 단추를 더블클릭하면 둘째 클릭이 그 자리에 방금 선 이 단추에 떨어집니다 */
const stopNow = () => {
  if (now() - S.startedAt < 600) return
  S.stop = true
  if (!pumping) { S.queue = S.queue.filter((x) => x.status === 'run'); S.stop = false; saveWork() }
  paint()
}
const MAX_REFS = 6   // server.py 의 MAX_REFS. 넘는 장은 서버가 말없이 버리므로 여기서 막습니다

function toggle(id) {
  const a = S.assets[id]
  if (!a || !REF_TYPES.includes(a.type)) return
  if (!S.sel.includes(id) && S.sel.length >= MAX_REFS) { S.err = `참조는 ${MAX_REFS}장까지입니다. 하나를 빼고 고르세요.`; paint(); return }
  S.err = ''
  S.sel = S.sel.includes(id) ? S.sel.filter((x) => x !== id) : [...S.sel, id]
  // 참조는 인물 → 배경 → 소품 순서로 보냅니다. server.py 의 ASSETS 가 그 순서로 읽습니다
  S.sel.sort((x, y) => REF_TYPES.indexOf(S.assets[x]?.type) - REF_TYPES.indexOf(S.assets[y]?.type))
  paint()
}

/* ══ 그리기 ═════════════════════════════════════════════════════════════════ */
const say = (t) => { const el = $('live'); if (el) el.textContent = t }

function paint() { paintCats(); paintGrid(); paintStill(); paintViewer() }

function paintCats() {
  const all = list()
  const count = (t) => all.filter((a) => t === 'all' ? a.type !== 'still' : a.type === t).length
  const pend = (t) => drafts().filter((d) => (t === 'all' ? d.type !== 'still' : d.type === t)).length
  const row = (id, label) => `<button class="cat" data-cat="${id}" aria-current="${S.cat === id}">
    ${esc(label)}${pend(id) ? `<span class="cat__pend" title="저장을 기다리는 후보">후보 ${pend(id)}</span>` : ''}<span class="cat__n">${count(id) || ''}</span></button>`
  setHtml($('cats'), `
    <div class="cats__h">자산</div>
    ${row('all', '전체')}
    ${CATS.filter((t) => t !== 'still').map((t) => row(t, typeName(t))).join('')}
    <div class="cats__sep"></div>
    ${row('still', '실사 스틸')}
    <div class="cats__sep"></div>
    <p class="hint">승인된 컷에서 뽑힌 것과 직접 올린 것이 모입니다.</p>`)
}

/* 다시 그릴 때 글을 치던 칸의 초점과 캐럿을 지킵니다. 20초마다(pollGpu) 와 남의 op 마다 다시 그립니다 */
const keepTyping = (ids) => {
  const a = document.activeElement
  if (!a || !ids.includes(a.id)) return () => {}
  const k = { id: a.id, s: a.selectionStart, e: a.selectionEnd }
  return () => { const el = $(k.id); if (el) { el.focus(); try { el.setSelectionRange(k.s, k.e) } catch { /* 값이 짧아졌을 때 */ } } }
}

function paintGrid() {
  const back = keepTyping(['makeText'])
  const items = shown()
  const catLabel = S.cat === 'all' ? '전체' : typeName(S.cat)
  const canMake = S.cat !== 'all' && S.cat !== 'still'
  const genNo = canGen() ? (mayGen() ? '' : denyReason('gen', role())) : '이 배포에는 생성 서버가 없습니다'
  const editNo = mayEdit() ? '' : denyReason('extract', role())
  const make = S.make && S.make.type === S.cat ? `
    <div class="make">
      <textarea id="makeText" placeholder="${esc(MAKE_PLACEHOLDER[S.cat] || '')}" ${S.busy ? 'disabled' : ''}>${esc(S.make.prompt)}</textarea>
      <div style="display:grid;gap:6px">
        ${/*
          * 모델을 고르는 칸. 자산 하나하나를 만드는 일에만 있습니다(위 makeModelId 머리글).
          *
          * GPU 가 꺼져 있으면 서버에 물어본 목록이 없어서 option 이 한 줄도 없는 빈 select 가
          * 섰습니다 — 「모델」이라 적힌 빈 칸을 눌러 보고 아무것도 안 나오면 고장으로 읽힙니다.
          * 그때는 칸 대신 지금 무엇을 기다리는지 한 줄을 냅니다. 켜지면 목록이 옵니다(pollGpu).
          */''}
        ${S.gpu.models.length ? `
          <label class="nsel"><span class="mono">모델</span><select id="makeModel" ${S.busy ? 'disabled' : ''}>${S.gpu.models.map((m) => `<option value="${esc(m.id)}"${makeModelId() === m.id ? ' selected' : ''}>${esc(m.label)}${m.init === false ? ' · 글만' : ' · 이미지 입력'}</option>`).join('')}</select></label>`
    : `<p class="note note--no">${esc(S.gpu.text)} · 모델 목록은 GPU 가 켜진 뒤에 옵니다</p>`}
        <label class="nsel"><span class="mono">장수</span><select id="makeN" ${S.busy ? 'disabled' : ''}>${COUNTS.map((c) => `<option value="${c}"${S.make.n === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
        <button class="btn btn--go" id="makeGo" ${S.busy || !S.make.prompt.trim() ? 'disabled' : ''}>${S.busy ? (S.busyKind === 'make' ? '만드는 중…' : '다른 작업 중…') : `후보 ${S.make.n}장 만들기`}</button>
        ${S.busy && S.busyKind === 'make' ? `<button class="btn" id="makeStop" ${S.stop ? 'disabled' : ''}>${S.stop ? '멈추는 중' : '그만'}</button>`
    : `<button class="btn" id="makeClose" ${S.busy ? 'disabled' : ''}>닫기</button>`}
      </div>
      <p class="note ${S.busy && S.busyKind === 'make' ? 'note--busy' : ''}">${S.busy && S.busyKind === 'make' ? `${esc(S.busy)}${S.stop ? ' — 지금 장은 끝나면 후보로 남고, 다음 장부터 만들지 않습니다.' : ''}`
    : `지시문 뒤에 「${esc(MAKE_HINT[S.cat])}」이 붙어 사진 룩의 ${esc(typeName(S.cat))} 후보로 나옵니다. 저장한 것만 자산이 됩니다.`}</p>
      ${(() => {
        /*
         * 고른 모델이 무엇을 하는지 한 줄. 이름만으로는 두 모델의 차이가 안 보입니다 —
         * 하나는 글만 보고 그리고 하나는 참조 이미지를 받습니다. 그 차이가 이 화면에서
         * 하는 일을 가릅니다(고른 자산이 입력으로 가는지 아닌지).
         *
         * 오른쪽 스틸 칸과 갈라 두는 말도 여기 한 번 답니다. 같은 화면에 「고르는 모델」과
         * 「고정된 모델」이 둘 다 있어서, 어느 쪽이 무엇인지 말해 주지 않으면 여기서 고른
         * 것이 스틸에도 갈 것으로 읽힙니다.
         */
        const m = S.gpu.models.find((x) => x.id === makeModelId())
        if (!m) return ''
        const still = `<span class="note"> 자산 여러 장을 한 장으로 합치는 오른쪽 「실사 스틸」은 늘 ${esc(refLabel())}입니다 — 여기서 고른 것과 무관합니다.</span>`
        if (m.init === false) return `<p class="note">${esc(m.label)}은 글만 보고 그립니다. 고른 자산을 참조로 넣으려면 이미지 입력을 받는 모델로 바꾸세요.${still}</p>`
        const n = picked().length
        return `<p class="note note--busy">${esc(m.label)}은 참조 이미지를 받습니다. ${n ? `오른쪽에서 고른 자산 ${n}장이 입력으로 들어가 그 얼굴·장소·물건을 살립니다.` : '오른쪽 「실사 스틸」 칸에서 자산을 고르면 그 그림이 입력으로 들어갑니다. 안 고르면 글만으로 그립니다.'}${still}</p>`
      })()}
    </div>` : ''
  /*
   * 후보 판. 지시문으로 만든 것이 여기 서고, 저장한 것만 아래 격자(자산)로 내려갑니다.
   * 스틸 후보는 실사 스틸 칸에 섭니다 — 여러 버전을 나란히 놓고 고르는 자리입니다.
   */
  const dr = draftsIn()
  const qn = S.queue.filter((t) => (S.cat === 'all' ? t.kind !== 'still' : t.type === S.cat)).length
  const queueLine = qn ? `<p class="note ${S.paused ? 'note--no' : 'note--busy'}">${S.paused
    ? `${esc(S.paused)} · 남은 일감 ${qn}장 <button class="mini" data-resume="1" type="button">이어서 만들기</button>`
    : `남은 일감 ${qn}장${S.busy ? ` · ${esc(S.busy)}` : ''}`}</p>` : ''
  const tray = dr.length || qn ? `
    <section class="tray" aria-label="후보">
      <div class="tray__h">후보 ${dr.length}장 <span class="note">저장한 것만 자산이 됩니다 — 저장하면 S3 에 지울 때까지 남습니다. 후보는 이 브라우저에 남습니다</span>
        <span class="spacer"></span>
        <button class="mini mini--quiet" data-dropall="1">전부 버리기</button>
        <button class="mini mini--go" data-keepall="1" ${mayEdit() ? '' : 'disabled'}>전부 저장</button></div>
      ${queueLine}
      ${dr.length ? `<div class="grid ${S.cat === 'still' || S.cat === 'bg' ? 'grid--wide' : ''}">${dr.map(draftTile).join('')}</div>` : ''}
    </section>` : ''
  setHtml($('main'), `
    <div class="tools">
      <h1>${esc(catLabel)}<span class="count">${items.length}</span></h1>
      <span class="spacer"></span>
      ${canMake ? `
        ${editNo || genNo ? `<span class="note note--no">${esc(editNo || genNo)}</span>` : ''}
        <button class="btn" id="uploadBtn" ${editNo ? `disabled title="${esc(editNo)}"` : ''}>올리기</button>
        <button class="btn" id="makeBtn" ${genNo ? `disabled title="${esc(genNo)}"` : S.busy ? 'disabled' : ''} aria-expanded="${!!(S.make && S.make.type === S.cat)}">AI로 만들기</button>`
    : S.cat === 'all' ? '<span class="note">올리거나 만들려면 왼쪽에서 종류를 고르세요.</span>'
      : '<span class="note">스틸은 오른쪽에서 자산을 골라 만듭니다.</span>'}
    </div>
    ${make}
    ${tray}
    ${S.err && !S.view ? `<p class="note note--no" style="margin-bottom:10px">${esc(S.err)}</p>` : ''}
    ${items.length ? `<div class="grid ${S.cat === 'still' || S.cat === 'bg' ? 'grid--wide' : ''}">${items.map(tile).join('')}</div>`
    : dr.length ? `<p class="note">저장한 ${esc(S.cat === 'still' ? '스틸' : catLabel)}은 여기 아래에 모입니다.</p>`
    : `<div class="empty">${S.cat === 'still'
      ? '아직 스틸이 없습니다.<br>인물·배경·소품에서 자산을 고르고 오른쪽 <b>실사 스틸 N버전</b>을 누르세요.'
      : `아직 ${esc(catLabel === '전체' ? '자산' : catLabel)}이 없습니다.<br>스토리보드에서 컷을 <b>승인</b>하면 그 그림에서 뽑혀 옵니다.${canMake ? ' 위의 <b>올리기</b>·<b>AI로 만들기</b>로도 넣습니다.' : ''}`}</div>`}`)
  $('uploadBtn')?.addEventListener('click', () => { const f = $('file'); f.value = ''; f.click() })
  $('makeBtn')?.addEventListener('click', () => { S.make = S.make?.type === S.cat ? null : { type: S.cat, prompt: '', n: 2 }; paintGrid(); $('makeText')?.focus() })
  $('makeClose')?.addEventListener('click', () => { S.make = null; paintGrid() })
  $('makeGo')?.addEventListener('click', makeAsset)
  $('makeN')?.addEventListener('change', (e) => { S.make.n = Number(e.target.value); paintGrid() })
  $('makeModel')?.addEventListener('change', (e) => { S.makeModel = e.target.value; paintGrid() })
  $('makeStop')?.addEventListener('click', stopNow)
  $('makeText')?.addEventListener('input', (e) => { S.make.prompt = e.target.value; const g = $('makeGo'); if (g) g.disabled = !e.target.value.trim() })
  back()
}

function tile(a) {
  const refable = REF_TYPES.includes(a.type)
  const on = S.sel.includes(a.id)
  const meta = [whence(a), a.charId && charName(a.charId) ? charName(a.charId) : ''].filter(Boolean).join(' · ')
  return `<div class="tile" data-type="${esc(a.type)}" data-id="${a.id}" role="${refable ? 'button' : 'group'}" ${refable ? `tabindex="0" aria-pressed="${on}"` : ''}>
    <img class="tile__im" src="${src(a)}" alt="" loading="lazy">
    ${refable ? '<span class="tile__pick" aria-hidden="true"></span>' : ''}
    <button class="tile__zoom" data-zoom="${a.id}" type="button">크게</button>
    <div class="tile__cap">
      <span class="tile__name">${esc(a.name || typeName(a.type))}</span>
      <span class="tile__meta">${esc(meta)}</span>
    </div>
  </div>`
}

/** 후보 타일. 저장·버리기가 붙고, 고르기(참조)는 없습니다 — 아직 자산이 아닙니다 */
function draftTile(d) {
  return `<div class="tile tile--draft" data-type="${esc(d.type)}" data-draft="${d.id}" role="group">
    <img class="tile__im" src="${src(d)}" alt="" loading="lazy">
    <button class="tile__zoom" data-zoom="${d.id}" type="button">크게</button>
    <div class="tile__cap"><span class="tile__name">${esc(d.name || typeName(d.type))}</span>
      <span class="tile__meta">${esc([d.of > 1 ? `버전 ${d.v}/${d.of}` : '후보', d.type === 'still' ? `참조 ${(d.refs || []).length}장` : ''].filter(Boolean).join(' · '))}</span></div>
    <div class="tile__acts">
      <button class="mini mini--go" data-keep="${d.id}" type="button" ${mayEdit() ? '' : 'disabled'}>저장</button>
      <button class="mini mini--quiet" data-drop="${d.id}" type="button">버리기</button>
    </div>
  </div>`
}

function paintStill() {
  const back = keepTyping(['stillText'])
  const refs = picked()
  const led = { ready: 'ready', busy: 'busy', loading: 'busy', down: 'down', error: 'down', none: 'down' }[S.gpu.state] || ''
  const genNo = !canGen() ? '이 배포에는 생성 서버가 없습니다' : mayGen() ? '' : denyReason('gen', role())
  const stills = list().filter((a) => a.type === 'still' && src(a)).slice(0, 4)
  setHtml($('still'), `
    <div>
      <div class="still__h">실사 스틸</div>
      <p class="still__s">인물·배경·소품에서 여러 장을 골라 사진 룩의 스틸을 정한 버전 수만큼 만듭니다. 고른 자산의 얼굴·장소·물건이 그대로 들어가고, 나온 버전은 「실사 스틸」 칸의 후보 판에 섭니다.</p>
    </div>
    <div class="picked">${refs.length ? refs.map((a) => `
      <div class="pick" data-type="${esc(a.type)}"><img src="${src(a)}" alt=""><b>${esc(typeName(a.type))} · ${esc(a.name || '')}</b>
        <button class="pick__x" data-unpick="${a.id}" title="참조에서 뺍니다" type="button">×</button></div>`).join('')
    : '<div class="empty">왼쪽 격자에서 자산을 눌러 고르세요.</div>'}</div>
    <textarea id="stillText" placeholder="장면 설명 (선택) · 예: 새벽 카페 창가, 손에 든 콜드브루를 바라본다" ${S.busy ? 'disabled' : ''}>${esc(S.prompt)}</textarea>
    <dl class="kv">
      ${/*
        * 고르는 칸이 아닙니다. 자산 여러 장을 한 장으로 합치는 일은 늘 FLUX 계열이라(위
        * makeModelId 머리글) 「고정」을 글로 박습니다. 왼쪽 「AI로 만들기」에는 고르는 칸이
        * 있어서, 여기에도 있을 것으로 읽히는 것을 막아야 합니다.
        */''}
      <dt>모델</dt><dd>${esc(refLabel())} <b class="fix">고정</b> · 참조 ${refs.length}장
        <span class="note">— 자산 여러 장을 조건으로 받는 모델이라야 얼굴·장소·물건이 그대로 들어갑니다. 자산 하나하나를 만들 때는 왼쪽 「AI로 만들기」에서 모델을 고릅니다</span></dd>
      <dt>크기</dt><dd>1920 × 1088 · 실사</dd>
      <dt>서버</dt><dd><span class="led led--${led}"></span>${esc(S.gpu.text)}${conn && allowed('power', role()) ? (S.gpu.state === 'down'
    ? ' <button class="mini mini--go" id="gpuOn" type="button">GPU 켜기</button>'
    : ' <button class="mini mini--quiet" id="gpuOff" type="button">끄기</button>') : ''}</dd>
    </dl>
    <div class="nrow">
      <label class="nsel"><span class="mono">버전</span><select id="stillN" ${S.busy ? 'disabled' : ''}>${COUNTS.map((c) => `<option value="${c}"${S.stillN === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
      <button class="btn btn--go" id="stillGo" style="flex:1" ${S.busy || !refs.length || genNo ? `disabled ${genNo ? `title="${esc(genNo)}"` : ''}` : ''}>
        ${S.busy ? (S.busyKind === 'still' ? '만드는 중…' : '다른 작업 중…') : `실사 스틸 ${S.stillN}버전${refs.length ? ` · ${refs.length}장 참조` : ''}`}</button>
      ${S.busy && S.busyKind === 'still' ? `<button class="btn" id="stillStop" ${S.stop ? 'disabled' : ''}>${S.stop ? '멈추는 중' : '그만'}</button>` : ''}
    </div>
    ${S.busy && S.busyKind === 'still' ? `<p class="note note--busy">${esc(S.busy)}${S.stop ? ' — 지금 장은 끝나면 후보로 남고, 다음 장부터 만들지 않습니다.' : ''}</p>` : ''}
    ${drafts().some((d) => d.type === 'still') ? `<p class="note">스틸 후보 ${drafts().filter((d) => d.type === 'still').length}장이 「실사 스틸」 칸에 있습니다. 나란히 보고 저장할 것을 고르세요.</p>` : ''}
    ${S.err && !S.make ? `<p class="note note--no">${esc(S.err)}</p>` : ''}
    ${genNo && canGen() ? `<p class="note note--no">${esc(genNo)}</p>` : ''}
    ${stills.length ? `<div class="recent"><div class="recent__h">최근 스틸</div>
      <div class="grid grid--wide" style="grid-template-columns:1fr">${stills.map((a) => `
        <div class="tile" data-type="still" role="group"><img class="tile__im" src="${src(a)}" alt="" loading="lazy">
          <button class="tile__zoom" data-zoom="${a.id}" type="button">크게</button>
          <div class="tile__cap"><span class="tile__name">${esc(a.name || '스틸')}</span>
          <span class="tile__meta">${esc([Array.isArray(a.gen?.size) ? a.gen.size.join('×') : '', `참조 ${(a.refs || []).length}장`].filter(Boolean).join(' · '))}</span></div></div>`).join('')}
      </div></div>` : ''}`)
  $('stillGo')?.addEventListener('click', makeStill)
  $('gpuOn')?.addEventListener('click', () => gpuPower('on'))
  $('gpuOff')?.addEventListener('click', () => gpuPower('off'))
  $('stillN')?.addEventListener('change', (e) => { S.stillN = Number(e.target.value); paintStill() })
  $('stillStop')?.addEventListener('click', stopNow)
  $('stillText')?.addEventListener('input', (e) => { S.prompt = e.target.value })
  back()
}

/* ══ 뷰어 ═══════════════════════════════════════════════════════════════════ */
function paintViewer() {
  const host = $('viewer')
  const a = item(S.view)
  document.body.classList.toggle('viewing', !!a)
  if (!a || !src(a)) {
    const was = !host.hidden
    host.hidden = true; setHtml(host, ''); S.view = null; delete host.dataset.key
    if (was && viewFrom?.isConnected) viewFrom.focus()
    return
  }
  const opening = host.hidden
  if (opening) viewFrom = document.activeElement
  // 같은 그림을 같은 상태로 다시 그리지 않습니다. 후보가 한 장씩 올 때마다 이름 칸과 스크롤이 튀었습니다
  const key = `${a.id}|${src(a)}|${isDraft(a)}|${S.sel.includes(a.id)}|${a.name}|${mayEdit()}`
  if (!opening && host.dataset.key === key) return
  host.dataset.key = key
  host.hidden = false
  const refs = (a.refs || []).map((id) => S.assets[id]).filter((x) => x && src(x))
  const on = S.sel.includes(a.id)
  const size = Array.isArray(a.gen?.size) ? a.gen.size.join(' × ') : ''
  setHtml(host, `
    <div class="vw__bar">
      <span class="vw__type">${esc(typeName(a.type))}${isDraft(a) ? ' · 후보' : ''}</span>
      <input class="vw__name" id="vwName" value="${esc(a.name || '')}" ${mayEdit() ? '' : 'readonly'} aria-label="자산 이름" maxlength="40">
      <span class="vw__meta" id="vwMeta">${esc([whence(a), a.gen?.model, size].filter(Boolean).join(' · '))}</span>
      <span class="spacer"></span>
      <span class="vw__zoom" role="group" aria-label="확대">
        <button class="vw__btn" data-z="fit" aria-pressed="${S.zoom === 'fit'}">맞춤</button>
        <button class="vw__btn" data-z="1" aria-pressed="${S.zoom === '1'}">1:1</button>
        <button class="vw__btn" data-z="2" aria-pressed="${S.zoom === '2'}">2×</button>
      </span>
      ${isDraft(a) ? `<button class="vw__btn" id="vwKeep" ${mayEdit() ? '' : 'disabled'}>자산으로 저장</button><button class="vw__btn vw__btn--no" id="vwDrop">버리기</button>`
    : REF_TYPES.includes(a.type) ? `<button class="vw__btn" id="vwPick" aria-pressed="${on}">${on ? '참조에 들어 있음' : '참조로 고르기'}</button>` : ''}
      <a class="vw__btn" href="${src(a)}" download="${esc((a.name || typeName(a.type)).replace(/[\\/:*?"<>|]/g, '_'))}.${src(a).startsWith('data:image/jpeg') ? 'jpg' : 'png'}">다운로드</a>
      ${mayEdit() && !isDraft(a) ? '<button class="vw__btn vw__btn--no" id="vwRemove">지우기</button>' : ''}
      <button class="vw__btn" id="vwClose" aria-label="닫기">닫기 ⎋</button>
    </div>
    <div class="vw__stage" id="vwStage" data-zoom="${S.zoom}">
      <img id="vwImg" src="${src(a)}" alt="${esc(a.name || '')}" draggable="false">
    </div>
    <div class="vw__foot">
      ${refs.length ? `<span>참조</span><span class="refs">${refs.map((r) => `<img src="${src(r)}" alt="" title="${esc(`${typeName(r.type)} · ${r.name || ''}`)}">`).join('')}</span>` : ''}
      ${a.prompt ? `<span class="prompt" title="${esc(a.prompt)}">${esc(a.prompt)}</span>` : ''}
      <span class="spacer"></span>
      <span>클릭 · 휠로 확대 · 확대 상태에서 끌어서 이동 · ← → 로 다음 자산</span>
    </div>`)
  const img = $('vwImg')
  const stage = $('vwStage')
  // 대화상자처럼 초점을 안으로 옮깁니다. 안 그러면 Tab 이 오버레이 뒤의 보이지 않는 타일을 돕니다
  if (opening) $('vwClose').focus()
  img.onload = () => {
    if (!size) $('vwMeta').textContent = [whence(a), a.gen?.model, `${img.naturalWidth} × ${img.naturalHeight}`].filter(Boolean).join(' · ')
    applyZoom()
  }
  if (img.complete) img.onload()
  $('vwClose').onclick = () => { S.view = null; paintViewer() }
  $('vwPick')?.addEventListener('click', () => toggle(a.id))
  $('vwRemove')?.addEventListener('click', () => remove(a.id))
  $('vwKeep')?.addEventListener('click', () => { keep(a.id); paintViewer() })
  $('vwDrop')?.addEventListener('click', () => drop(a.id))
  $('vwName').addEventListener('change', (e) => (isDraft(a) ? (a.name = e.target.value.trim().slice(0, 40) || a.name, paint()) : rename(a.id, e.target.value)))
  host.querySelectorAll('[data-z]').forEach((b) => { b.onclick = () => setZoom(b.dataset.z) })
  /*
   * 그림을 누르면 맞춤 ↔ 1:1. 휠은 한 단계씩.
   * click 은 stage 에 답니다 — 확대 상태에서는 onpointerdown 의 setPointerCapture 때문에 click 이 img 가
   * 아니라 stage 로 오므로 img.onclick 은 한 번도 불리지 않았습니다. 끌었으면(moved) 토글하지 않습니다
   */
  stage.onclick = (e) => {
    if (drag?.moved) return
    if (S.zoom === 'fit' && e.target !== img) return
    setZoom(S.zoom === 'fit' ? '1' : 'fit', e.target === img ? e : null)
  }
  stage.onwheel = (e) => {
    e.preventDefault()
    const order = ['fit', '1', '2']
    const i = order.indexOf(S.zoom)
    const next = order[Math.max(0, Math.min(order.length - 1, i + (e.deltaY < 0 ? 1 : -1)))]
    if (next !== S.zoom) setZoom(next, e)
  }
  // 확대 상태에서 끌어서 이동
  stage.onpointerdown = (e) => {
    if (S.zoom === 'fit') return
    drag = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop, moved: false }
    stage.classList.add('dragging')
    stage.setPointerCapture(e.pointerId)
  }
  stage.onpointermove = (e) => {
    if (!drag || S.zoom === 'fit') return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
    stage.scrollLeft = drag.l - dx
    stage.scrollTop = drag.t - dy
  }
  stage.onpointerup = stage.onpointercancel = () => { stage.classList.remove('dragging'); setTimeout(() => { drag = null }, 0) }
}

let drag = null
let viewFrom = null   // 뷰어를 열기 전에 초점이 있던 곳. 닫으면 되돌립니다

function setZoom(z, e = null) {
  S.zoom = z
  const stage = $('vwStage')
  if (!stage) return
  stage.dataset.zoom = z
  document.querySelectorAll('[data-z]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.z === z)))
  applyZoom(e)
}

/* 확대 배율을 픽셀로 적용하고, 누른 자리가 화면 가운데에 오게 스크롤합니다 */
function applyZoom(e = null) {
  const img = $('vwImg')
  const stage = $('vwStage')
  if (!img || !stage) return
  if (S.zoom === 'fit') { img.style.width = ''; return }
  const k = S.zoom === '2' ? 2 : 1
  img.style.width = `${img.naturalWidth * k}px`
  const fx = e ? (e.offsetX || 0) / Math.max(1, e.target?.clientWidth || 1) : 0.5
  const fy = e ? (e.offsetY || 0) / Math.max(1, e.target?.clientHeight || 1) : 0.5
  requestAnimationFrame(() => {
    stage.scrollLeft = img.offsetWidth * fx - stage.clientWidth / 2
    stage.scrollTop = img.offsetHeight * fy - stage.clientHeight / 2
  })
}

function step(dir) {
  const cur = item(S.view)
  const items = isDraft(cur) ? drafts().filter((d) => d.type === cur.type)
    : cur?.type === 'still' ? list().filter((a) => a.type === 'still' && src(a)) : shown().filter((a) => a.type !== 'still')
  const pool = items.length ? items : list().filter(src)
  const i = pool.findIndex((a) => a.id === S.view)
  const next = pool[(i + dir + pool.length) % pool.length]
  if (next) { S.view = next.id; S.zoom = 'fit'; paintViewer() }
}

/* ══ 이벤트 ═════════════════════════════════════════════════════════════════ */
$('cats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]')
  if (!b) return
  S.cat = b.dataset.cat
  // 만드는 중인 폼은 지우지 않습니다. 돌아오면 지시문·진행·「그만」이 그대로 있어야 합니다
  if (!(S.busy && S.busyKind === 'make')) S.make = null
  S.err = ''
  paint()
})
$('main').addEventListener('click', (e) => {
  const z = e.target.closest('[data-zoom]')
  if (z) { e.stopPropagation(); S.view = z.dataset.zoom; S.zoom = 'fit'; paintViewer(); return }
  const k = e.target.closest('[data-keep]'); if (k) { keep(k.dataset.keep); return }
  const d = e.target.closest('[data-drop]'); if (d) { drop(d.dataset.drop); return }
  if (e.target.closest('[data-keepall]')) { for (const x of draftsIn()) keep(x.id); return }
  if (e.target.closest('[data-resume]')) { pump(); return }
  if (e.target.closest('[data-dropall]')) { dropAll(); return }
  const t = e.target.closest('.tile[data-id]')
  if (t && t.getAttribute('role') === 'button') toggle(t.dataset.id)
})
$('main').addEventListener('keydown', (e) => {
  // 타일 안의 「크게」 단추는 자기 일(뷰어)을 합니다. 타일 자체에 초점이 있을 때만 고르기입니다
  if (e.target.closest('button')) return
  const t = e.target.closest('.tile[data-id]')
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(t.dataset.id) }
})
// 더블클릭도 크게 보기. 마우스로는 「크게」가 hover 에서만 보여 이 길이 하나 더 있어야 합니다
$('main').addEventListener('dblclick', (e) => {
  const t = e.target.closest('.tile[data-id], .tile[data-draft]')
  if (t) { S.view = t.dataset.id || t.dataset.draft; S.zoom = 'fit'; paintViewer() }
})
$('still').addEventListener('click', (e) => {
  const x = e.target.closest('[data-unpick]')
  if (x) { toggle(x.dataset.unpick); return }
  const z = e.target.closest('[data-zoom]')
  if (z) { S.view = z.dataset.zoom; S.zoom = 'fit'; paintViewer() }
})
$('file').addEventListener('change', (e) => { if (e.target.files?.length) upload([...e.target.files]) })
// 후보와 일감은 localStorage 에 남으므로 떠나도 묻지 않습니다. 돌아오면 boot() 이 이어서 돕니다
document.addEventListener('keydown', (e) => {
  if (!S.view) return
  if (e.target.tagName === 'INPUT') return
  if (e.key === 'Escape') { S.view = null; paintViewer() }
  if (e.key === 'ArrowRight') step(1)
  if (e.key === 'ArrowLeft') step(-1)
})

/* ══ 시작 ═══════════════════════════════════════════════════════════════════ */
async function boot() {
  mountNav({ mount: $('navMount'), active: 'assets', handled: ['assets'], utilMount: $('utilMount') })
  mountBrand('#brandMount')

  if (configured) {
    let s = session()
    if (s && !(await idToken())) s = null
    S.me = s || await showLogin($('gate'))
  }
  // 로컬 모드의 역할은 보드처럼 ?as= 로 고릅니다. 없으면 기획입니다
  const asked = new URLSearchParams(location.search).get('as')
  S.me = S.me || session() || { id: 'local', name: '로컬', role: ['planner', 'artist', 'director', 'reviewer', 'admin'].includes(asked) ? asked : 'planner' }
  $('whoami').textContent = `${S.me.name || S.me.id} · ${S.me.role}`

  await pickProject({ step: 'assets', actor: S.me?.id, who: (id) => (id === S.me?.id ? S.me : null) })

  // 배포 모드는 서버 로그가 사실입니다. 로컬 판을 섞으면 지운 자산이 되살아납니다
  if (!configured) loadLocal()
  loadWork()
  paint()

  try {
    S.net = await connect({
      onOp: (op) => { if (apply(op)) paint() },
      onPresence: () => {},
      onStatus: () => {},
      onResync: () => {},
    })
  } catch (e) {
    S.err = `보드 연결 실패 · ${e.message}`
  }
  const beat = () => S.net?.sendPresence?.({ ...S.me, view: 'assets' })
  beat()
  setInterval(beat, 12_000)

  /*
   * 로그를 처음부터 재생합니다. 자산과 인물 이름만 접고 나머지 op 는 지나갑니다. 배포 모드는
   * 서버 로그가 사실이라 로컬 판은 쓰지 않습니다 — 둘을 섬으면 지운 자산이 되살아납니다.
   */
  const past = await S.net?.fetchOps?.().catch(() => null)
  if (past) {
    S.assets = {}; S.chars = {}
    for (const op of past) apply(op)
  }
  paint()
  await pollGpu()
  setInterval(pollGpu, 20_000)
  // 떠나 있던 사이 남은 일감을 이어서 합니다
  if (S.queue.length) pump()
}

boot()
