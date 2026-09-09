/*
 * MCP(Model Context Protocol) 로 바깥의 영상 생성 서버에 말을 붙입니다. Higgsfield 가
 * 그 서버입니다. 이 파일은 선(wire)만 압니다 — DOM 도 저장소도 건드리지 않습니다.
 *
 * ══ 지금 이 파일에서 화면이 쓰는 것은 cutPrompt 하나입니다
 *
 * 영상 만들기는 스토리보드 안으로 들어갔고 우리 GPU 로만 합니다(pages/board.js 의
 * animate). 그 자리가 「무엇이 어떻게 움직이는가」 한 문장을 여기서 가져갑니다 — 컷의
 * 작업 지시·대사·카메라를 읽어 한 줄로 만드는 일이라 영상 서버가 어디든 같습니다.
 *
 * 아래 선(initialize · tools/list · tools/call)은 없어진 영상화 화면이 쓰던 것입니다.
 * 바깥 서버로 영상을 만드는 길은 지금 제품에 없습니다. 지우지 않은 이유는 이 파일이
 * 순수하고(DOM·저장소를 건드리지 않습니다) 검사가 그대로 도는 데다, 다시 붙일 때 재 본
 * 사실(아래 401·403)을 다시 재야 하기 때문입니다.
 *
 * ══ 브라우저에서 mcp.higgsfield.ai 에 바로 닿지 못합니다 (직접 재 본 사실)
 *
 *   POST https://mcp.higgsfield.ai/mcp                → 401
 *     www-authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp",
 *                       scope="openid email offline_access"
 *   그 metadata 의 인증 서버 → clerk.higgsfield.ai (authorization_code + PKCE),
 *                              fnf-device-auth.higgsfield.ai (device_code)
 *   OPTIONS https://mcp.higgsfield.ai/mcp (Origin: 우리 CDN) → 403, access-control-* 없음
 *
 * 즉 프리플라이트가 막혀서 웹 페이지의 fetch 는 응답을 볼 수 없습니다. 이것은 토큰이
 * 있어도 마찬가지입니다. 그래서 이 파일은 세 가지를 다 할 수 있게 둡니다.
 *
 *   1. 진짜 MCP 를 말합니다. CORS 를 여는 주소(중계·자체 호스팅 브리지·로컬 스텁)를
 *      넣으면 initialize → tools/list → tools/call 이 그대로 돌아갑니다.
 *   2. 닿지 못하면 그 사실을 그대로 말합니다. 조용히 가짜로 넘어가지 않습니다.
 *   3. demoFetch 로 붙으면 같은 코드 길을 타면서 서버 없이 흐름을 보여줍니다.
 *
 * ══ 도구 이름을 하나로 박지 않습니다
 *
 * MCP 서버는 자기 도구 목록을 tools/list 로 알려 줍니다. Higgsfield 쪽 구현체마다 이름과
 * 인자가 다릅니다(generate_video · higgsfield_generate_video · image2video …). 그래서
 * pickTool 이 목록에서 「영상 만드는 것」을 골라내고, argsFor 가 그 도구가 실제로 선언한
 * inputSchema.properties 에만 값을 채웁니다. 서버가 안 받는 인자를 보내면 통째로 거부하는
 * 서버가 있어서, 모르는 칸은 비워 두고 required 중 못 채운 것만 사람에게 물어봅니다.
 */

import { isVideoSrc } from './panels.js'

/** 이 클라이언트가 말하는 MCP 판본. initialize 와 MCP-Protocol-Version 헤더에 씁니다 */
export const MCP_PROTOCOL = '2025-06-18'

/** Higgsfield 의 MCP 주소. 연동 화면의 기본값입니다 */
export const HF_ENDPOINT = 'https://mcp.higgsfield.ai/mcp'

/** 이 클라이언트의 이름. 서버 로그에 이렇게 남습니다 */
export const CLIENT = { name: 'summer-studio-storyboard', version: '1' }

/* ══ JSON-RPC ══════════════════════════════════════ */

let seq = 0

/**
 * JSON-RPC 요청 한 통. id 를 넣지 않으면 이 모듈이 세어 붙입니다.
 * @param {string} method - 'initialize' | 'tools/list' | 'tools/call'
 * @param {object} [params]
 * @param {number|string} [id]
 */
export const frame = (method, params, id) => ({
  jsonrpc: '2.0', id: id ?? ++seq, method, ...(params === undefined ? {} : { params }),
})

/** 답을 기다리지 않는 알림. id 가 없는 것이 요청과의 차이입니다 */
export const note = (method, params) => ({
  jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }),
})

/**
 * 응답 본문 → JSON-RPC 메시지 하나.
 *
 * 같은 엔드포인트가 두 가지 모양으로 답합니다. 그냥 JSON 을 주기도 하고,
 * text/event-stream 으로 `data: {…}` 줄을 여러 개 흘리기도 합니다(MCP 의 Streamable
 * HTTP). 스트림에서는 진행 알림이 앞에 오고 결과가 마지막에 오므로, result 나 error 를
 * 든 마지막 메시지를 답으로 봅니다.
 *
 * @param {string} text - 응답 본문 전체
 * @param {string} [contentType]
 * @returns {object} result 나 error 를 든 JSON-RPC 메시지
 */
export function readBody(text, contentType = '') {
  const raw = String(text ?? '')
  const sse = /text\/event-stream/i.test(contentType) || /^\s*(event|data|id):/m.test(raw)
  const chunks = sse
    ? raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim())
    : [raw.trim()]

  let last = null
  for (const c of chunks) {
    if (!c || c === '[DONE]') continue
    let msg
    try { msg = JSON.parse(c) } catch { continue }
    // 배치 응답이면 배열로 옵니다
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (m && typeof m === 'object' && ('result' in m || 'error' in m)) last = m
    }
  }
  if (!last) {
    throw new Error(`MCP 응답을 읽지 못했습니다. ${raw ? `받은 것: ${raw.slice(0, 120)}` : '본문이 비었습니다'}`)
  }
  return last
}

/** result 를 꺼냅니다. error 면 던집니다 — 조용히 null 로 넘기면 실패가 성공처럼 보입니다 */
export function unwrap(msg) {
  if (msg?.error) {
    const err = new Error(msg.error.message || `MCP 오류 ${msg.error.code ?? ''}`.trim())
    err.rpc = msg.error
    throw err
  }
  return msg?.result ?? null
}

/* ══ 도구 고르기 ═══════════════════════════════════ */

/*
 * 널리 쓰이는 Higgsfield MCP 구현체들의 이름을 먼저 찾아보고, 없으면 이름·설명으로
 * 점수를 매깁니다. veto 는 「비슷한 낱말이 들어갔지만 그 일이 아닌 것」입니다 —
 * list_models 는 model 이 들어가지만 영상을 만들지 않습니다.
 */
const KINDS = {
  video: {
    exact: ['generate_video', 'higgsfield_generate_video', 'image2video', 'img2video',
      'image_to_video', 'create_video', 'video_generate', 'animate_image'],
    name: /(video|animate|motion|i2v)/i,
    text: /(video|영상|애니메이션|motion)/i,
    veto: /(list|models|status|wait|poll|cancel|delete|upload|download)/i,
  },
  status: {
    exact: ['higgsfield_wait_for_job', 'wait_for_job', 'get_job', 'job_status',
      'check_job', 'poll_job', 'get_job_set'],
    name: /(wait|status|poll|job|result)/i,
    text: /(status|상태|완료|job|기다)/i,
    veto: /(generate|create|submit|cancel|upload)/i,
  },
  upload: {
    exact: ['media_upload', 'upload_media', 'upload_image', 'upload_file', 'higgsfield_upload'],
    name: /(upload|media)/i,
    text: /(upload|업로드|올립)/i,
    veto: /(list|delete|video)/i,
  },
}

/**
 * tools/list 의 목록에서 우리가 쓸 도구 하나를 고릅니다. 없으면 null.
 *
 * @param {Array<{name: string, description?: string}>} tools
 * @param {'video'|'status'|'upload'} [kind]
 */
export function pickTool(tools, kind = 'video') {
  const spec = KINDS[kind]
  if (!spec) return null
  const list = (tools || []).filter((t) => t && typeof t.name === 'string')

  for (const want of spec.exact) {
    const hit = list.find((t) => t.name.toLowerCase() === want)
    if (hit) return hit
  }

  let best = null
  let bestScore = 0
  for (const t of list) {
    const name = t.name.toLowerCase()
    let s = 0
    if (spec.name.test(name)) s += 3
    if (spec.text.test(String(t.description || ''))) s += 1
    if (spec.veto.test(name)) s -= 4
    if (s > bestScore) { best = t; bestScore = s }
  }
  return best
}

/* ══ 인자 채우기 ═══════════════════════════════════ */

/*
 * 우리가 들고 있는 값 ↔ 서버가 선언한 인자 이름. 서버마다 다르게 부르므로 이름으로
 * 짝을 찾습니다. 여기 없는 칸은 건드리지 않습니다 — 서버의 기본값이 우리 추측보다 낫습니다.
 */
const FIELDS = [
  ['image', /^(image|image_url|imageurl|img|img_url|images|image_urls|input_image|input_images|input_files|init_image|first_frame|first_frame_image|start_image|source_image|photo|frame)$/i],
  ['prompt', /^(prompt|text|description|caption|instruction|motion_prompt)$/i],
  ['model', /^(model|model_id|model_name|motion|motion_id|motion_name|preset|style|style_id|template)$/i],
  ['quality', /^(quality|tier)$/i],
  ['secs', /^(duration|duration_seconds|seconds|secs|length|video_length|num_seconds)$/i],
  ['aspect', /^(aspect_ratio|aspect|ratio)$/i],
  ['seed', /^seed$/i],
]

const numeric = (spec) => spec?.type === 'number' || spec?.type === 'integer'

/** 이 칸에 넣을 값 하나. 서버가 enum 을 걸어 두면 그 안의 값만 씁니다 */
function valueFor(slot, want, spec, required) {
  let v = want[slot === 'image' ? 'imageUrl' : slot]
  const en = Array.isArray(spec?.enum) && spec.enum.length ? spec.enum : null
  /*
   * 값이 없는데 서버가 「이 중에서 고르라」고 목록을 주고 반드시 필요하다고 했으면 첫
   * 값을 씁니다. 그러지 않으면 사람이 그 도구의 문서를 찾아 손으로 적어야 합니다.
   * 목록이 없는 required 칸은 그대로 비워 두고 missing 으로 물어봅니다 — 아무 값이나
   * 지어 넣으면 서버가 거부하고, 왜 거부했는지는 사람이 알 수 없습니다.
   */
  if (v === undefined || v === null || v === '') return en && required ? en[0] : undefined

  if (en) {
    const hit = en.find((e) => String(e).toLowerCase() === String(v).toLowerCase())
    // 못 맞추면 비웁니다. required 라서 비울 수 없으면 서버가 준 첫 값을 씁니다
    if (!hit) return required ? en[0] : undefined
    v = hit
  }
  if (numeric(spec)) {
    const n = Number(v)
    if (!Number.isFinite(n)) return undefined
    v = spec.type === 'integer' ? Math.round(n) : n
  }
  if (spec?.type === 'array') return [v]
  if (spec?.type === 'string') return String(v)
  return v
}

/**
 * 도구가 선언한 스키마에 우리 값을 얹습니다.
 *
 * @param {object} tool - tools/list 의 항목
 * @param {object} want - {prompt, imageUrl, model, quality, secs, aspect, seed}
 * @returns {{args: object, imaged: boolean, missing: string[], props: string[]}}
 *          imaged=false 면 그림을 넣을 칸이 없는 도구입니다(글만 받는 영상 생성기).
 *          missing 은 required 인데 우리가 채우지 못한 칸입니다 — 사람에게 물어봐야 합니다.
 */
export function argsFor(tool, want = {}) {
  const schema = tool?.inputSchema || tool?.input_schema || {}
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required : []

  const args = {}
  let imaged = false
  for (const [key, spec] of Object.entries(props)) {
    const slot = FIELDS.find(([, re]) => re.test(key))?.[0]
    if (!slot) continue
    const v = valueFor(slot, want, spec, required.includes(key))
    if (v === undefined) continue
    args[key] = v
    if (slot === 'image') imaged = true
  }
  return {
    args, imaged,
    missing: required.filter((k) => args[k] === undefined),
    props: Object.keys(props),
  }
}

/* ══ 결과 읽기 ═════════════════════════════════════ */

/*
 * 주소를 받아들이는 자는 판과 나눠 씁니다(위의 import). 여기서 더 넉넉하게 받으면 그
 * 주소가 컷에 실리는 순간 빈 칸이 되어, 화면은 「만들었습니다」라고 말하고 컷은 비어
 * 있습니다. 그래서 판이 안 받을 모양이면 여기서도 url 로 삼지 않고, job 과 원문만
 * 돌려줍니다 — 사람이 그 주소를 원문에서 직접 열어 볼 수 있습니다.
 */

/**
 * tools/call 의 결과에서 영상 주소와 작업 번호를 파냅니다.
 *
 * 서버마다 담는 자리가 다릅니다. structuredContent 에 넣는 곳, content[].text 안에 JSON
 * 문자열로 넣는 곳, 사람이 읽는 문장에 주소만 섞어 두는 곳이 다 있습니다. 그래서 값을
 * 훑으며 찾습니다. 못 찾으면 url 이 null 이고, 그때는 job 번호와 원문을 사람에게 보여
 * 줍니다 — 「만들었습니다」라고 말해 놓고 아무것도 안 보이는 것이 가장 나쁩니다.
 *
 * @param {object} result
 * @returns {{url: string|null, job: string|null, text: string}}
 */
export function videoFrom(result) {
  let url = null
  let job = null
  const texts = []

  const walk = (v, key = '', depth = 0) => {
    if (v == null || depth > 7) return
    if (typeof v === 'string') {
      if (!url) {
        for (const u of v.match(/https?:\/\/[^\s"'<>)\]},]+/g) || []) {
          if (isVideoSrc(u)) { url = u; break }
        }
      }
      if (!job && /job|task|request/i.test(key) && /^[\w:-]{6,80}$/.test(v)) job = v
      if (/^(text|message|note|status)$/i.test(key) || key === '') texts.push(v)
      if (/^\s*[{[]/.test(v)) {
        try { walk(JSON.parse(v), key, depth + 1) } catch { /* 그냥 글이었습니다 */ }
      }
      return
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1)
  }
  walk(result)

  return { url, job, text: texts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400) }
}

/* ══ 컷 → 프롬프트 ═════════════════════════════════ */

/*
 * 컷에 이미 적혀 있는 것으로 프롬프트를 만듭니다. 새로 물어보지 않습니다 — 보드에서
 * action·camera·dialogue 를 정하는 것이 이 프로그램의 절반이고, 그것을 여기서 다시
 * 쓰게 하면 두 곳이 어긋납니다.
 *
 * 대사는 말 그대로 넣지 않습니다. 영상 모델은 그걸 화면의 글자로 그려 넣습니다. 대신
 * 「말하는 중」이라는 움직임으로 옮깁니다.
 */
const CAM_MOVE = {
  TRACKING: '카메라가 인물을 따라 천천히 이동한다',
  PAN: '카메라가 좌우로 천천히 패닝한다',
  TILT: '카메라가 위아래로 천천히 틸트한다',
  POV: '인물의 시선으로 화면이 흔들린다',
  INSERT: '대상에 아주 천천히 다가간다',
}

/**
 * 컷 하나 → 영상 프롬프트.
 * @param {object} cut - 보드의 패널 {scene, action, camera, dialogue}
 * @param {string} [tail] - 사람이 덧붙인 말
 */
export function cutPrompt(cut = {}, tail = '') {
  const out = []
  if (cut.scene) out.push(String(cut.scene).trim())
  if (cut.action) out.push(String(cut.action).trim())
  const move = CAM_MOVE[String(cut.camera || '').toUpperCase()]
  if (move) out.push(move)
  else if (cut.camera) out.push(`${cut.camera} 구도를 유지한다`)
  if (cut.dialogue) out.push('인물이 말하는 중이다')
  if (tail) out.push(String(tail).trim())
  const s = out.filter(Boolean).join('. ').replace(/\.{2,}/g, '.')
  return (s || '그림 속 인물과 배경이 자연스럽게 움직인다').slice(0, 600)
}

/* ══ op 로그 → 컷 목록 ═════════════════════════════ */

/*
 * 이 화면은 보드가 아니라서 보드의 판(state)을 들고 있지 않습니다. 그런데 컷은 에셋이
 * 아니라 op 로그에 있습니다. 그래서 로그를 접어 컷만 꺼냅니다. board.js 의 applyOp 를
 * 가져다 쓸 수 없는 이유는 그것이 알림·읽음·프레즌스까지 다루는 화면 상태라는 것입니다.
 * 여기서 필요한 것은 「어떤 컷이 있고 그 그림이 무엇이냐」뿐입니다.
 */
export function foldCuts(ops) {
  const panels = new Map()
  for (const op of (ops || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
    switch (op?.kind) {
      case 'panel.add':
        if (op.panel?.id && !panels.has(op.panel.id)) panels.set(op.panel.id, { ...op.panel })
        break
      case 'panel.patch': {
        const p = panels.get(op.panelId)
        if (p) Object.assign(p, op.fields || {})
        break
      }
      case 'panel.remove':
        panels.delete(op.panelId)
        break
      case 'panel.version': {
        const p = panels.get(op.panelId)
        if (!p) break
        p.versions = [...(p.versions || []), { ...op.version, vid: op.id }]
        p.current = p.versions.length - 1
        break
      }
      case 'panel.version.remove': {
        const p = panels.get(op.panelId)
        // 보드는 지운 버전의 열쇠를 verId 에 담습니다(board.js 의 emit). 이름이 어긋나면
        // 아무 것도 못 걸러 지운 그림이 영상화에 다시 나타납니다
        const vid = op.verId ?? op.vid
        if (!p || !vid) break
        /*
         * 배열에서 빼지 않고 보드처럼 dead 에 적습니다. panel.patch 의 current 는 지운
         * 것까지 센 자리번호이므로, 여기서 배열을 줄이면 그 번호가 어긋납니다
         */
        p.dead = { ...(p.dead || {}), [vid]: op.ts }
        break
      }
      case 'board.reset':
        // 판을 비운 op. 그 전의 컷은 없는 것입니다(board.js 의 applyOp 와 같습니다)
        panels.clear()
        break
      default:
        // 모르는 kind 는 지나갑니다. 보드의 applyOp 와 같은 태도입니다
        break
    }
  }
  /*
   * 컷만 돌려줍니다. charId 가 있는 것은 인물 구도판이고 keyVisual 은 키비주얼 화면이
   * 붙인 것입니다. 둘 다 「스토리보드에서 만든 컷」이 아니라 영상으로 만들 대상이 아닙니다.
   */
  return [...panels.values()]
    .filter((p) => !p.charId && !p.keyVisual)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0))
}

/* ══ 클라이언트 ════════════════════════════════════ */

/** 선이 끊긴 이유를 사람 말로. CORS 는 브라우저가 이유를 안 주므로 우리가 설명합니다 */
function wireError(e, endpoint) {
  if (e?.name === 'AbortError') return new Error('서버가 시간 안에 답하지 않아 끊었습니다.')
  const msg = String(e?.message || e)
  if (e instanceof TypeError || /failed to fetch|networkerror|load failed|cors/i.test(msg)) {
    return new Error(`${endpoint} 에 브라우저가 닿지 못했습니다. 주소가 틀렸거나, `
      + '그 서버가 CORS 를 열지 않아 웹 페이지에서 부를 수 없는 경우입니다 '
      + '(mcp.higgsfield.ai 가 그렇습니다 — 프리플라이트가 403 입니다). '
      + 'CORS 를 여는 중계 주소를 넣거나, 아래 「데모로 연결」로 흐름만 먼저 보세요.')
  }
  return e instanceof Error ? e : new Error(msg)
}

/**
 * MCP 클라이언트 하나. Streamable HTTP 만 씁니다(SSE 응답도 읽습니다).
 *
 * @param {object} o
 * @param {string} [o.endpoint]
 * @param {string} [o.token] - Bearer 토큰. 'Bearer …' 로 적어 줘도 됩니다
 * @param {Function} [o.fetchImpl] - 테스트와 데모가 여기를 갈아 끼웁니다
 * @param {number} [o.timeoutMs] - 영상은 몇 분 걸립니다. 기본을 넉넉히 둡니다
 * @returns {{open, tools, run, session, info, endpoint}}
 */
export function mcp({ endpoint = HF_ENDPOINT, token = '', fetchImpl = null, timeoutMs = 300_000 } = {}) {
  const f = fetchImpl || ((...a) => fetch(...a))
  let sid = null
  let info = null

  const head = () => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': MCP_PROTOCOL,
    ...(token ? { authorization: /^bearer\s/i.test(token) ? token : `Bearer ${token}` } : {}),
    ...(sid ? { 'mcp-session-id': sid } : {}),
  })

  const post = async (body, { silent = false } = {}) => {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null
    let res
    try {
      res = await f(endpoint, {
        method: 'POST', headers: head(), body: JSON.stringify(body),
        ...(ctl ? { signal: ctl.signal } : {}),
      })
    } catch (e) {
      throw wireError(e, endpoint)
    } finally {
      if (timer) clearTimeout(timer)
    }

    // 서버가 세션을 열어 주면 그다음 요청마다 되돌려 줘야 합니다
    const got = res.headers?.get?.('mcp-session-id')
    if (got) sid = got

    if (res.status === 401 || res.status === 403) {
      const hint = res.headers?.get?.('www-authenticate') || ''
      throw new Error(`서버가 인증을 요구했습니다(${res.status}).`
        + (hint ? ` ${hint}` : ' 토큰을 확인해 주세요.'))
    }
    if (silent) return null
    const text = await res.text().catch(() => '')
    if (!res.ok) throw new Error(`HTTP ${res.status}. ${text.slice(0, 200)}`)
    return unwrap(readBody(text, res.headers?.get?.('content-type') || ''))
  }

  return {
    endpoint,
    session: () => sid,
    info: () => info,

    /** initialize + notifications/initialized. 서버가 자기 이름과 능력을 돌려줍니다 */
    async open() {
      info = await post(frame('initialize', {
        protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: CLIENT,
      })) || {}
      // 알림은 202 로 본문 없이 옵니다. 이걸 안 보내면 도구를 안 내주는 서버가 있습니다
      await post(note('notifications/initialized'), { silent: true }).catch(() => null)
      return info
    },

    async tools() {
      const r = await post(frame('tools/list', {}))
      return Array.isArray(r?.tools) ? r.tools : []
    },

    run: (name, args = {}) => post(frame('tools/call', { name, arguments: args })),
  }
}

/* ══ 데모 서버 ═════════════════════════════════════ */

const okRes = (obj) => ({
  ok: true, status: 200,
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
  text: async () => JSON.stringify(obj),
})

/**
 * 서버 없이 같은 코드 길을 타 보는 가짜 fetch. mcp({fetchImpl: demoFetch()}) 로 씁니다.
 *
 * 도구 이름과 인자 모양을 Higgsfield 쪽 구현체에서 그대로 가져왔습니다. 그래야 pickTool
 * 과 argsFor 가 진짜 서버에서 할 일을 여기서 미리 합니다. 영상 주소는 주지 않습니다 —
 * 없는 파일을 가리키는 주소를 내주면 그게 op 로그에 남아 나중에 깨진 링크가 됩니다.
 * 데모의 영상은 화면이 브라우저에서 직접 만들고 그 자리에서만 씁니다.
 */
export function demoFetch({ delayMs = 400 } = {}) {
  let n = 0
  return async (_url, init) => {
    const req = JSON.parse(init?.body || '{}')
    await new Promise((r) => setTimeout(r, delayMs))

    if (req.method === 'initialize') {
      return okRes({
        jsonrpc: '2.0', id: req.id,
        result: {
          protocolVersion: MCP_PROTOCOL, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'higgsfield-mcp (데모)', version: '0-demo' },
          instructions: '데모 연결입니다. 바깥으로 아무것도 나가지 않습니다.',
        },
      })
    }
    if (req.method === 'tools/list') {
      return okRes({
        jsonrpc: '2.0', id: req.id,
        result: {
          tools: [
            {
              name: 'generate_video',
              description: 'Generate a video from an image and a motion preset.',
              inputSchema: {
                type: 'object',
                properties: {
                  image_url: { type: 'string', description: 'Public URL of the first frame' },
                  /*
                   * 고를 목록을 줍니다. 진짜 Higgsfield 는 여기에 목록을 주지 않고
                   * list_models 로 따로 알려 주므로, 그쪽에 붙으면 화면이 사람에게
                   * 모션 id 를 물어봅니다. 데모는 물어볼 곳이 없어서 목록을 답니다.
                   */
                  motion_id: {
                    type: 'string', description: 'Motion preset id',
                    enum: ['slow-push-in', 'handheld-drift', 'static'],
                  },
                  prompt: { type: 'string' },
                  quality: { type: 'string', enum: ['lite', 'turbo', 'standard'] },
                },
                required: ['image_url', 'motion_id'],
              },
            },
            {
              name: 'higgsfield_wait_for_job',
              description: 'Wait for a job set to finish and return its results.',
              inputSchema: {
                type: 'object',
                properties: { job_set_id: { type: 'string' } },
                required: ['job_set_id'],
              },
            },
            {
              name: 'list_models',
              description: 'List available motion presets and models.',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      })
    }
    if (req.method === 'tools/call') {
      const job = `demo-${++n}`
      return okRes({
        jsonrpc: '2.0', id: req.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ job_set_id: job, status: 'completed' }) }],
        },
      })
    }
    // 알림. 본문 없이 202
    return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' }
  }
}
