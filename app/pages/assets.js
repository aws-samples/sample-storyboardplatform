/*
 * 자산관리 — 인물 · 배경 · 소품 · 스틸.
 *
 * ══ 무엇을 하는 화면인가
 *
 * 프로젝트의 그림 자산이 모이는 곳입니다. 세 갈래로 들어옵니다.
 *   - 스토리보드에서 감독이 컷을 승인하면 그 그림에서 뽑힌 인물·배경·소품(board.js 의 extractAssets)
 *   - 여기서 직접 올린 그림(스케치·레퍼런스 사진)
 *   - 여기서 지시문으로 만든 그림
 * 그리고 그 자산들을 여러 장 골라 실사 스틸 한 장을 만듭니다. 콘티는 연필이지만 스틸은 VFX·영상
 * 기획이 룩을 잡는 한 장이라 사진 룩(server.py 의 STYLE_REAL)으로 갑니다. 참조 자산이 연필 그림이어도
 * 얼굴·장소·물건만 물려받고 질감은 버립니다. 크기는 1920×1088 이고 뷰어에서 원본 크기로 봅니다.
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
import { connect } from '../services/api.js'
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
const now = () => Date.now()
const uid = () => now().toString(36) + Math.random().toString(36).slice(2, 8)

/* 종류의 순서. 왼쪽 기둥과 스틸의 참조 순서(인물 → 배경 → 소품)가 이것입니다 */
const CATS = ['char', 'bg', 'prop', 'still']
/* 종류마다 「AI로 만들기」에 붙는 말. 서버가 한국어를 영어로 옮깁니다(server.py 의 en) */
const MAKE_HINT = {
  char: '인물 한 명, 전신, 정면, 단색 배경, 다른 사람 없음',
  bg: '사람 없는 빈 장소, 넓은 설정 샷',
  prop: '물건 하나만, 가운데 크게, 단색 배경, 손이나 사람 없음',
}
const MAKE_PLACEHOLDER = {
  char: '예: 30대 여성 바리스타, 검은 앞치마, 짧은 머리',
  bg: '예: 새벽의 한강 다리, 안개, 가로등',
  prop: '예: 유리병에 든 콜드브루, 라벨에 로고',
}

const S = {
  me: null,
  net: null,
  assets: {},
  chars: {},
  cat: 'all',
  sel: [],            // 고른 자산 id. 순서가 참조 순서입니다
  prompt: '',
  make: null,         // { type, prompt } — 「AI로 만들기」 칸이 열려 있으면
  busy: null,         // 진행 한 줄
  err: '',
  view: null,         // 뷰어가 보여주는 자산 id
  zoom: 'fit',
  gpu: { state: 'unknown', text: '확인 중', models: [], resident: null },
  lastStill: null,
}

/* ══ 권한 ═══════════════════════════════════════════════════════════════════ */
const role = () => S.me?.role || 'reviewer'
const canGen = () => !!cfg.genUrl
// 그림 만들기(스틸 · AI로 만들기)는 아티스트·기획. 올리기·이름·지우기는 감독까지(자산 뽑기와 같은 표)
const mayGen = () => !configured || allowed('gen', role())
const mayEdit = () => !configured || allowed('extract', role())

/* ══ 판 ═════════════════════════════════════════════════════════════════════ */
const list = () => Object.values(S.assets).sort((a, b) => (b.ts || 0) - (a.ts || 0))
const src = (a) => (a?.src && !isVideoSrc(a.src) ? a.src : null)
const inCat = (a) => S.cat === 'all' ? a.type !== 'still' : a.type === S.cat
const shown = () => list().filter(inCat).filter(src)
const picked = () => S.sel.map((id) => S.assets[id]).filter((a) => a && src(a) && REF_TYPES.includes(a.type))
const typeName = (t) => ASSET_TYPES[t] || t || ''
const whence = (a) => (a.fromPanelId ? '컷에서 뽑음' : a.source === 'upload' ? '올림' : a.type === 'still' ? '실사 스틸' : 'AI')
const charName = (id) => S.chars[id]?.name || ''

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
    S.gpu = {
      state: j.error ? 'error' : j.loading || !j.warm ? 'loading' : j.busy ? 'busy' : 'ready',
      text: j.error ? `생성 서버: ${j.error}` : j.loading || !j.warm ? `모델을 올리는 중${j.wait ? ` · 약 ${Math.round(j.wait)}초` : ''}`
        : j.busy ? '다른 그림을 그리는 중' : resident ? `${j.model} 준비됨` : '그림 모델 대기',
      models: draw, resident, wait: j.wait || 0, err: j.error, default: j.default,
    }
  } catch {
    S.gpu = { state: 'down', text: gpuDownHint(), models: [] }
  }
  paintStill()
}

/*
 * 참조를 조건으로 받는 모델. 스틸은 자산 여러 장을 조건으로 받아야 하므로 klein 계열이어야 합니다.
 * img2img 갈래(chroma·sd3)는 그림을 지우고 다시 그려 얼굴이 바뀌고, krea 는 그림을 받지 않습니다.
 */
const refModel = () => S.gpu.models.find((m) => m.strength === false && m.init !== false)?.id ?? 'klein'

/** 503 이면 모델이 올라올 때까지 기다린 뒤 한 번 다시 보냅니다 */
async function askPatient(body, tick) {
  try {
    return await askGpu(body)
  } catch (err) {
    if (err.status !== 503) throw err
    tick(`${err.message} 준비되면 이어서 만듭니다.`)
    for (let i = 0; i < 36; i++) {
      await new Promise((r) => setTimeout(r, 5000))
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

/* ══ 만들기 ═════════════════════════════════════════════════════════════════ */

/** 고른 자산으로 실사 스틸 한 장 */
async function makeStill() {
  const refs = picked()
  if (!refs.length) { S.err = '먼저 인물·배경·소품에서 참조할 자산을 고르세요.'; paintStill(); return }
  if (!mayGen()) { S.err = denyReason('gen', role()); paintStill(); return }
  if (S.busy) return
  const tick = (t) => { S.busy = t; S.err = ''; paintStill() }
  tick('참조 그림을 읽습니다…')
  const names = refs.map((a) => `${typeName(a.type)} ${a.name}`).join(', ')
  const prompt = S.prompt.trim() || `${names}. 영화 스틸 한 장`
  const t0 = performance.now()
  try {
    const imgs = await Promise.all(refs.map((a) => asInit(src(a))))
    tick('실사 스틸을 그립니다 · 약 20초…')
    const r = await askPatient({
      prompt, kind: 'still', model: refModel(), refs: imgs, refKind: 'assets', style: 'real', strength: 0.95,
    }, tick)
    const id = uid()
    emit({
      kind: 'asset.add',
      asset: {
        id, type: 'still', name: (S.prompt.trim() || names).slice(0, 40), src: r.url, source: 'ai',
        refs: refs.map((a) => a.id), prompt, author: S.me?.id || 'local', ts: now(),
        gen: { model: r.model, seed: r.seed ?? null, ms: r.ms ?? Math.round(performance.now() - t0), size: r.size || null },
      },
    })
    S.lastStill = id
    S.busy = null
    S.view = id; S.zoom = 'fit'
    say(`실사 스틸이 나왔습니다 · ${Math.round((r.ms || 0) / 1000)}초`)
    paint()
  } catch (err) {
    S.busy = null
    S.err = err.message
    paintStill()
  }
}

/** 지시문으로 자산 한 장. 종류의 힌트가 앞에 붙습니다 */
async function makeAsset() {
  const m = S.make
  if (!m?.prompt.trim()) return
  if (!mayGen()) { S.err = denyReason('gen', role()); paint(); return }
  if (S.busy) return
  const tick = (t) => { S.busy = t; S.err = ''; paint() }
  tick(`${typeName(m.type)}을 그립니다…`)
  try {
    const r = await askPatient({
      prompt: `${m.prompt.trim()}, ${MAKE_HINT[m.type]}`, kind: m.type === 'bg' ? 'cut' : 'asset', model: null,
    }, tick)
    emit({
      kind: 'asset.add',
      asset: {
        id: uid(), type: m.type, name: m.prompt.trim().slice(0, 40), src: r.url, source: 'ai', prompt: m.prompt.trim(),
        author: S.me?.id || 'local', ts: now(), gen: { model: r.model, seed: r.seed ?? null, ms: r.ms ?? null },
      },
    })
    S.busy = null
    S.make = null
    say(`${typeName(m.type)} 자산을 만들었습니다`)
    paint()
  } catch (err) {
    S.busy = null
    S.err = err.message
    paint()
  }
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
      emit({
        kind: 'asset.add',
        asset: {
          id: uid(), type, name: f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || typeName(type), src: data,
          source: 'upload', author: S.me?.id || 'local', ts: now(),
        },
      })
      n += 1
    } catch (err) {
      S.err = `${f.name}: ${err.message}`
    }
  }
  if (n) say(`${typeName(type)} ${n}장을 올렸습니다`)
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

function toggle(id) {
  const a = S.assets[id]
  if (!a || !REF_TYPES.includes(a.type)) return
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
  const row = (id, label) => `<button class="cat" data-cat="${id}" aria-current="${S.cat === id}">
    ${esc(label)}<span class="cat__n">${count(id) || ''}</span></button>`
  setHtml($('cats'), `
    <div class="cats__h">자산</div>
    ${row('all', '전체')}
    ${CATS.filter((t) => t !== 'still').map((t) => row(t, typeName(t))).join('')}
    <div class="cats__sep"></div>
    ${row('still', '실사 스틸')}
    <div class="cats__sep"></div>
    <p class="hint">스토리보드에서 컷이 승인되면 그 그림의 인물·배경·소품이 여기로 옵니다. 직접 올리거나 지시문으로 만들 수도 있습니다.</p>`)
}

function paintGrid() {
  const items = shown()
  const catLabel = S.cat === 'all' ? '전체' : typeName(S.cat)
  const canMake = S.cat !== 'all' && S.cat !== 'still'
  const genNo = canGen() ? (mayGen() ? '' : denyReason('gen', role())) : '이 배포에는 생성 서버가 없습니다'
  const editNo = mayEdit() ? '' : denyReason('extract', role())
  const make = S.make && S.make.type === S.cat ? `
    <div class="make">
      <textarea id="makeText" placeholder="${esc(MAKE_PLACEHOLDER[S.cat] || '')}" ${S.busy ? 'disabled' : ''}>${esc(S.make.prompt)}</textarea>
      <div style="display:grid;gap:6px">
        <button class="btn btn--go" id="makeGo" ${S.busy || !S.make.prompt.trim() ? 'disabled' : ''}>${S.busy ? '그리는 중…' : '만들기'}</button>
        <button class="btn" id="makeClose" ${S.busy ? 'disabled' : ''}>닫기</button>
      </div>
      <p class="note">${esc(typeName(S.cat))}은 ${esc(MAKE_HINT[S.cat])}으로 그립니다. 나온 그림은 이 칸에 자산으로 남고, 스토리보드의 참조로도 쓸 수 있습니다.</p>
    </div>` : ''
  setHtml($('main'), `
    <div class="tools">
      <h1>${esc(catLabel)}<span class="count">${items.length}</span></h1>
      <span class="spacer"></span>
      ${canMake ? `
        <button class="btn" id="uploadBtn" ${editNo ? `disabled title="${esc(editNo)}"` : ''}>올리기</button>
        <button class="btn" id="makeBtn" ${genNo ? `disabled title="${esc(genNo)}"` : ''} aria-expanded="${!!(S.make && S.make.type === S.cat)}">AI로 만들기</button>`
    : S.cat === 'all' ? '<span class="note">올리거나 만들려면 왼쪽에서 종류를 고르세요.</span>'
      : '<span class="note">스틸은 오른쪽에서 자산을 골라 만듭니다.</span>'}
    </div>
    ${make}
    ${S.err && !S.view ? `<p class="note note--no" style="margin-bottom:10px">${esc(S.err)}</p>` : ''}
    ${items.length ? `<div class="grid ${S.cat === 'still' || S.cat === 'bg' ? 'grid--wide' : ''}">${items.map(tile).join('')}</div>`
    : `<div class="empty">${S.cat === 'still'
      ? '아직 스틸이 없습니다.<br>인물·배경·소품에서 자산을 고르고 오른쪽 <b>실사 스틸 만들기</b>를 누르세요.'
      : `아직 ${esc(catLabel === '전체' ? '자산' : catLabel)}이 없습니다.<br>스토리보드에서 컷을 <b>승인</b>하면 그 그림에서 뽑혀 옵니다.${canMake ? ' 위의 <b>올리기</b>·<b>AI로 만들기</b>로도 넣습니다.' : ''}`}</div>`}`)
  $('uploadBtn')?.addEventListener('click', () => { const f = $('file'); f.value = ''; f.click() })
  $('makeBtn')?.addEventListener('click', () => { S.make = S.make?.type === S.cat ? null : { type: S.cat, prompt: '' }; paintGrid(); $('makeText')?.focus() })
  $('makeClose')?.addEventListener('click', () => { S.make = null; paintGrid() })
  $('makeGo')?.addEventListener('click', makeAsset)
  $('makeText')?.addEventListener('input', (e) => { S.make.prompt = e.target.value; $('makeGo').disabled = !e.target.value.trim() })
}

function tile(a) {
  const refable = REF_TYPES.includes(a.type)
  const on = S.sel.includes(a.id)
  const meta = [whence(a), a.charId && charName(a.charId) ? charName(a.charId) : '', a.gen?.model || ''].filter(Boolean).join(' · ')
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

function paintStill() {
  const refs = picked()
  const led = { ready: 'ready', busy: 'busy', loading: 'busy', down: 'down', error: 'down', none: 'down' }[S.gpu.state] || ''
  const genNo = !canGen() ? '이 배포에는 생성 서버가 없습니다' : mayGen() ? '' : denyReason('gen', role())
  const model = S.gpu.models.find((m) => m.id === refModel())
  const stills = list().filter((a) => a.type === 'still' && src(a)).slice(0, 4)
  setHtml($('still'), `
    <div>
      <div class="still__h">실사 스틸</div>
      <p class="still__s">인물·배경·소품에서 여러 장을 골라 사진 룩의 스틸 한 장을 만듭니다. 고른 자산의 얼굴·장소·물건이 그대로 들어갑니다.</p>
    </div>
    <div class="picked">${refs.length ? refs.map((a) => `
      <div class="pick" data-type="${esc(a.type)}"><img src="${src(a)}" alt=""><b>${esc(typeName(a.type))} · ${esc(a.name || '')}</b>
        <button class="pick__x" data-unpick="${a.id}" title="참조에서 뺍니다" type="button">×</button></div>`).join('')
    : '<div class="empty">왼쪽 격자에서 자산을 눌러 고르세요.</div>'}</div>
    <textarea id="stillText" placeholder="장면 설명 (선택) · 예: 새벽 카페 창가, 손에 든 콜드브루를 바라본다" ${S.busy ? 'disabled' : ''}>${esc(S.prompt)}</textarea>
    <dl class="kv">
      <dt>모델</dt><dd>${esc(model?.label || 'FLUX.2 klein')} · 참조 ${refs.length}장</dd>
      <dt>크기</dt><dd>1920 × 1088 · 실사</dd>
      <dt>서버</dt><dd><span class="led led--${led}"></span>${esc(S.gpu.text)}</dd>
    </dl>
    <button class="btn btn--go btn--wide" id="stillGo" ${S.busy || !refs.length || genNo ? `disabled ${genNo ? `title="${esc(genNo)}"` : ''}` : ''}>
      ${S.busy ? '만드는 중…' : `실사 스틸 만들기${refs.length ? ` · ${refs.length}장 참조` : ''}`}</button>
    ${S.busy ? `<p class="note note--busy">${esc(S.busy)}</p>` : ''}
    ${S.err && !S.make ? `<p class="note note--no">${esc(S.err)}</p>` : ''}
    ${genNo && canGen() ? `<p class="note note--no">${esc(genNo)}</p>` : ''}
    ${stills.length ? `<div class="recent"><div class="recent__h">최근 스틸</div>
      <div class="grid grid--wide" style="grid-template-columns:1fr">${stills.map((a) => `
        <div class="tile" data-type="still" role="group"><img class="tile__im" src="${src(a)}" alt="" loading="lazy">
          <button class="tile__zoom" data-zoom="${a.id}" type="button">크게</button>
          <div class="tile__cap"><span class="tile__name">${esc(a.name || '스틸')}</span>
          <span class="tile__meta">${esc([a.gen?.model, a.gen?.size ? a.gen.size.join('×') : '', `참조 ${(a.refs || []).length}장`].filter(Boolean).join(' · '))}</span></div></div>`).join('')}
      </div></div>` : ''}`)
  $('stillGo')?.addEventListener('click', makeStill)
  $('stillText')?.addEventListener('input', (e) => { S.prompt = e.target.value })
}

/* ══ 뷰어 ═══════════════════════════════════════════════════════════════════ */
function paintViewer() {
  const host = $('viewer')
  const a = S.assets[S.view]
  document.body.classList.toggle('viewing', !!a)
  if (!a || !src(a)) { host.hidden = true; setHtml(host, ''); S.view = null; return }
  host.hidden = false
  const refs = (a.refs || []).map((id) => S.assets[id]).filter((x) => x && src(x))
  const on = S.sel.includes(a.id)
  const size = a.gen?.size ? a.gen.size.join(' × ') : ''
  setHtml(host, `
    <div class="vw__bar">
      <span class="vw__type">${esc(typeName(a.type))}</span>
      <input class="vw__name" id="vwName" value="${esc(a.name || '')}" ${mayEdit() ? '' : 'readonly'} aria-label="자산 이름" maxlength="40">
      <span class="vw__meta" id="vwMeta">${esc([whence(a), a.gen?.model, size].filter(Boolean).join(' · '))}</span>
      <span class="spacer"></span>
      <span class="vw__zoom" role="group" aria-label="확대">
        <button class="vw__btn" data-z="fit" aria-pressed="${S.zoom === 'fit'}">맞춤</button>
        <button class="vw__btn" data-z="1" aria-pressed="${S.zoom === '1'}">1:1</button>
        <button class="vw__btn" data-z="2" aria-pressed="${S.zoom === '2'}">2×</button>
      </span>
      ${REF_TYPES.includes(a.type) ? `<button class="vw__btn" id="vwPick" aria-pressed="${on}">${on ? '참조에 들어 있음' : '참조로 고르기'}</button>` : ''}
      <a class="vw__btn" href="${src(a)}" download="${esc((a.name || typeName(a.type)).replace(/[\\/:*?"<>|]/g, '_'))}.png">다운로드</a>
      ${mayEdit() ? '<button class="vw__btn vw__btn--no" id="vwRemove">지우기</button>' : ''}
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
  img.onload = () => {
    if (!size) $('vwMeta').textContent = [whence(a), a.gen?.model, `${img.naturalWidth} × ${img.naturalHeight}`].filter(Boolean).join(' · ')
    applyZoom()
  }
  if (img.complete) img.onload()
  $('vwClose').onclick = () => { S.view = null; paintViewer() }
  $('vwPick')?.addEventListener('click', () => toggle(a.id))
  $('vwRemove')?.addEventListener('click', () => remove(a.id))
  $('vwName').addEventListener('change', (e) => rename(a.id, e.target.value))
  host.querySelectorAll('[data-z]').forEach((b) => { b.onclick = () => setZoom(b.dataset.z) })
  // 그림을 누르면 맞춤 ↔ 1:1. 휠은 한 단계씩
  img.onclick = (e) => { if (drag.moved) return; setZoom(S.zoom === 'fit' ? '1' : 'fit', e) }
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
  const items = S.cat === 'still' ? list().filter((a) => a.type === 'still' && src(a)) : shown()
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
  S.make = null
  S.err = ''
  paint()
})
$('main').addEventListener('click', (e) => {
  const z = e.target.closest('[data-zoom]')
  if (z) { e.stopPropagation(); S.view = z.dataset.zoom; S.zoom = 'fit'; paintViewer(); return }
  const t = e.target.closest('.tile[data-id]')
  if (t && t.getAttribute('role') === 'button') toggle(t.dataset.id)
})
$('main').addEventListener('keydown', (e) => {
  const t = e.target.closest('.tile[data-id]')
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(t.dataset.id) }
})
$('still').addEventListener('click', (e) => {
  const x = e.target.closest('[data-unpick]')
  if (x) { toggle(x.dataset.unpick); return }
  const z = e.target.closest('[data-zoom]')
  if (z) { S.view = z.dataset.zoom; S.zoom = 'fit'; paintViewer() }
})
$('file').addEventListener('change', (e) => { if (e.target.files?.length) upload([...e.target.files]) })
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
  S.me = S.me || session() || { id: 'local', name: '로컬', role: 'planner' }
  $('whoami').textContent = `${S.me.name || S.me.id} · ${S.me.role}`

  await pickProject({ step: 'assets', actor: S.me?.id, who: (id) => (id === S.me?.id ? S.me : null) })

  loadLocal()
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
  pollGpu()
  setInterval(pollGpu, 20_000)
}

boot()
