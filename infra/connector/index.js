'use strict'
/*
 * 커넥터. 밖에 있는 이미지·영상 모델을 API 키만 넣으면 쓰게 한다.
 *
 * 흐름은 한 줄이다: 키를 넣는다 → 제공자를 한 번 찔러 본다(probe) → 통과하면
 * SSM SecureString 에 넣는다 → 그 순간부터 그 제공자의 모델이 그림판의 모델 목록에
 * 뜨고 호출된다. 통과하지 못하면 저장하지 않는다. 못 쓰는 키가 저장되어 있는 것보다
 * 낫다.
 *
 * 왜 이 함수가 VPC 밖에 있나: 제공자 API(api.openai.com 등)로 나가야 한다.
 * GraphFn 은 퍼블릭 서브넷의 Lambda ENI 라서 퍼블릭 IP 를 못 받고 인터넷으로 못
 * 나간다. 그래서 나가는 일만 이 함수로 떼어 놓았다.
 *
 * 키는 브라우저로 내려가지 않는다. 목록에는 끝 네 글자만 보인다. 저장·삭제는
 * 리졸버에서 admin 만 통과한다.
 *
 * 오퍼레이션
 *   list    제공자 목록. 설정된 곳은 고를 수 있는 모델까지
 *   put     키 검증 후 저장
 *   remove  키 삭제
 *   gen     그림·영상 한 장. Event 로 들어와 결과를 Ops 테이블에 적는다 (plan 과 같다)
 */

const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime')
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3')
const {
  DeleteParameterCommand, GetParameterCommand, GetParametersByPathCommand,
  PutParameterCommand, SSMClient,
} = require('@aws-sdk/client-ssm')
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb')
const { randomUUID } = require('node:crypto')

const PREFIX = process.env.CONN_PREFIX || '/storyboard/connector'
const BUCKET = process.env.IMAGES_BUCKET
const TABLE = process.env.OPS_TABLE
const TTL_SEC = 60 * 60

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0))

let ssm = null
let s3 = null
let ddb = null
let br = null
const openSsm = () => (ssm ||= new SSMClient({}))
const openS3 = () => (s3 ||= new S3Client({}))
const openDdb = () => (ddb ||= DynamoDBDocumentClient.from(new DynamoDBClient({})))
const openBedrock = () => (br ||= new BedrockRuntimeClient({}))

// ── 프롬프트 ─────────────────────────────────────────────────────────────────
// infra/gpu/server.py 와 같은 문구다. 밖의 모델이 그려도 같은 화면에 섞여 놓이니
// 결이 맞아야 한다. 파이썬과 노드라서 상수를 공유할 방법이 없어 두 벌로 둔다.
// 고칠 때는 양쪽을 같이 고친다.

const STYLE = 'cinematic storyboard panel, expressive graphite pencil and ink wash on warm toned paper, '
  + 'confident linework, soft sepia monochrome, dramatic directional light'
const NEG = 'text, letters, handwriting, speech bubble, caption, subtitle, watermark, signature, '
  + 'logo, border, frame, photograph, 3d render, blurry, washed out'
const SHEET = 'character design sheet, single character, plain background, full body visible, '
const FINISH = 'finished storyboard panel drawn from this rough sketch, keep the same layout and camera, '
  + 'add full tonal shading, depth and atmosphere, '
const NOTEXT = 'Do not write any text, labels or captions. '

/** server.py 의 SIZE 와 같다. 픽셀을 그대로 받는 제공자에만 쓴다 */
const SIZE = { pose: [896, 1152], cut: [1216, 688] }

const EN_MODEL = process.env.EN_MODEL || 'global.anthropic.claude-haiku-4-5-20251001-v1:0'
const EN_SYSTEM = 'Translate the text into English for an image generation prompt. '
  + 'Reply with the translation only: no quotes, no notes, no extra words.'

const isAscii = (s) => !/[^\x00-\x7F]/.test(s)

/**
 * 한국어 프롬프트를 영어로 옮긴다. SD 계열은 한국어를 거의 못 읽는다.
 * 실패하면 원문을 그대로 쓴다 — 그림이 안 나오는 것보다 낫다. server.py 의 en() 과 같다.
 */
async function en(text) {
  const t = str(text)
  if (!t || isAscii(t)) return t
  try {
    const out = await openBedrock().send(new ConverseCommand({
      modelId: EN_MODEL,
      system: [{ text: EN_SYSTEM }],
      messages: [{ role: 'user', content: [{ text: t.slice(0, 900) }] }],
      inferenceConfig: { maxTokens: 512, temperature: 0 },
      additionalModelRequestFields: { thinking: { type: 'disabled' } },
    }))
    let said = ''
    for (const c of out.output?.message?.content || []) if (typeof c.text === 'string') said += c.text
    return str(said) || t
  } catch (err) {
    console.error('[conn] 번역 실패, 원문을 쓴다', err.name)
    return t
  }
}

/** 화면 요청을 제공자에게 보낼 한 문장으로 만든다 */
function promptFor(req, body) {
  const head = req.kind === 'pose' ? SHEET : ''
  const mid = req.init ? FINISH : ''
  return `${NOTEXT}${head}${mid}${str(body).slice(0, 400)}. ${STYLE}`
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** 실패는 호스트와 상태 코드, 응답 앞부분까지 남긴다. 키는 본문에 없으니 새지 않는다 */
async function ask(url, opt = {}) {
  const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(opt.ms || 120000) })
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}: ${str(await r.text()).slice(0, 300)}`)
  return r
}
const askJson = async (url, opt) => (await ask(url, opt)).json()
const askBytes = async (url, opt) => {
  const r = await ask(url, opt)
  return { bytes: Buffer.from(await r.arrayBuffer()), type: str(r.headers.get('content-type')) }
}

const bearer = (c) => ({ authorization: `Bearer ${c.key}` })
const sendJson = (headers, body) => ({
  method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const b64 = (data, type = 'image/png') => ({ bytes: Buffer.from(data, 'base64'), type })

/** 브라우저가 보내는 data:URL 을 바이트로 되돌린다. 헤더가 없는 순수 base64 도 받는다 */
function dataUrl(s) {
  const raw = str(s)
  const head = /^data:([^;,]+)[^,]*,/.exec(raw)
  return {
    bytes: Buffer.from(head ? raw.slice(head[0].length) : raw, 'base64'),
    type: head ? head[1] : 'image/png',
  }
}
const blobOf = (im) => new Blob([im.bytes], { type: im.type || 'image/png' })

/** multipart 한 벌. 값이 없는 칸은 넣지 않는다 (빈 칸을 싫어하는 제공자가 있다) */
function form(fields, file) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') f.set(k, String(v))
  if (file) f.set(file.name, blobOf(file.image), 'init.png')
  return f
}

// ── 제공자 ───────────────────────────────────────────────────────────────────
/*
 * 한 제공자는 네 가지를 말한다.
 *   fields  화면이 받아야 하는 칸. 지금은 모두 키 하나지만, 키 말고 비밀값을 더
 *           받는 곳이 생기면 여기에 이름만 더한다 (저장은 이미 객체 통째로 한다)
 *   probe   키가 살아 있는지 확인하고 사람이 읽을 한 줄을 돌려준다
 *   models  고를 수 있는 모델. 설정된 제공자만 화면에 나간다
 *   run     한 장 만들어 {bytes, type} 으로 돌려준다
 */

const GG = 'https://generativelanguage.googleapis.com/v1beta'

const PROVIDERS = {
  huggingface: {
    label: 'Hugging Face',
    hint: 'hf_ 로 시작하는 토큰. SD 3.5 처럼 게이트된 모델을 GPU 가 내려받을 때도 이 키를 쓴다',
    fields: ['key'],
    // 이 키는 두 곳에서 쓰인다. 여기(HF 추론으로 바로 그리기)와 GPU 서버(게이트된
    // 저장소 내려받기). server.py 의 hf_token() 이 같은 파라미터를 읽는다.
    gate: 'GPU 의 SD 3.5 잠금도 이 키로 풀린다',
    /*
     * whoami 는 토큰이 살아 있는지와 무엇을 할 수 있는지를 같이 알려준다.
     *
     * HF 의 세분화 토큰은 권한이 갈린다. 게이트된 저장소 내려받기(GPU 가 SD 3.5 를
     * 받을 때 쓰는 것)만 켜고 추론은 안 켠 토큰이 흔하다. 그 상태로 그림을 시키면
     * 403 이 나는데, 저장할 때 아무 말도 안 해 두면 그 403 을 볼 때까지 모른다.
     * 그래서 넣는 자리에서 미리 적어 준다.
     */
    probe: async (c) => {
      const j = await askJson('https://huggingface.co/api/whoami-v2', { headers: bearer(c) })
      const fine = j.auth?.accessToken?.fineGrained
      const scoped = (fine?.scoped || []).flatMap((s) => s.permissions || [])
      const perms = [...(fine?.global || []), ...scoped].map(String)
      const mayInfer = !fine || perms.some((p) => p.includes('inference'))
      const gated = !fine || fine.canReadGatedRepos
      return `계정 ${str(j.name) || '확인'} 로 붙었다`
        + (gated ? ' · 게이트 모델 내려받기 가능(GPU 의 SD 3.5)' : ' · 게이트 모델 내려받기 권한 없음')
        + (mayInfer ? ' · HF 추론 가능' : ' · HF 추론 권한 없음(토큰에 Inference Providers 를 켜야 여기서 그림이 나온다)')
    },
    models: [
      // init: false — 화면이 「기반 이미지를 받지 않는다」고 미리 말해 줄 수 있게 표시한다
      { id: 'stabilityai/stable-diffusion-3.5-large', label: 'SD 3.5 Large (HF 추론)', note: '외부 · HF', kind: 'image', init: false },
      { id: 'black-forest-labs/FLUX.1-dev', label: 'FLUX.1 dev (HF 추론)', note: '외부 · HF', kind: 'image', init: false },
    ],
    // HF 추론은 text-to-image 만 쓴다. 기준 그림(init)은 무시한다
    async run(c, model, req) {
      const [w, h] = SIZE[req.kind] || SIZE.cut
      try {
        return await askBytes(`https://router.huggingface.co/hf-inference/models/${model}`, {
          ...sendJson({ ...bearer(c), accept: 'image/png' },
            { inputs: req.prompt, parameters: { negative_prompt: NEG, width: w, height: h } }),
        })
      } catch (err) {
        // 게이트 모델만 받을 수 있는 토큰이 흔하다. 무엇을 켜야 하는지 여기서 말해 준다
        if (str(err.message).includes('403')) {
          throw new Error(`${err.message} — 이 토큰에는 추론 권한이 없다. `
            + 'HF 설정에서 Inference Providers 를 켜거나 그 권한이 있는 토큰으로 갈아 끼워라. '
            + 'GPU 의 게이트된 SD 3.5 내려받기는 지금 토큰으로도 된다')
        }
        throw err
      }
    },
  },

  openai: {
    label: 'OpenAI',
    hint: 'sk- 로 시작하는 키',
    fields: ['key'],
    probe: async (c) => {
      const j = await askJson('https://api.openai.com/v1/models', { headers: bearer(c) })
      return `모델 ${(j.data || []).length}개가 보인다`
    },
    models: [{ id: 'gpt-image-1', label: 'GPT Image 1', note: '외부 · OpenAI', kind: 'image' }],
    async run(c, model, req) {
      const size = req.kind === 'pose' ? '1024x1536' : '1536x1024'
      if (req.init) {
        const body = form({ model, prompt: req.prompt, size, input_fidelity: 'high' },
          { name: 'image', image: dataUrl(req.init) })
        const j = await askJson('https://api.openai.com/v1/images/edits',
          { method: 'POST', headers: bearer(c), body })
        return b64(j.data[0].b64_json)
      }
      const j = await askJson('https://api.openai.com/v1/images/generations',
        sendJson(bearer(c), { model, prompt: req.prompt, size, n: 1 }))
      return b64(j.data[0].b64_json)
    },
  },

  google: {
    label: 'Google Gemini',
    hint: 'AI Studio 의 API 키',
    fields: ['key'],
    // 키를 쿼리스트링(?key=)이 아니라 헤더로 보낸다. 주소에 키가 섞이면 어딘가에 남는다
    probe: async (c) => {
      const j = await askJson(`${GG}/models`, { headers: { 'x-goog-api-key': c.key } })
      return `모델 ${(j.models || []).length}개가 보인다`
    },
    models: [{ id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', note: '외부 · Google', kind: 'image' }],
    async run(c, model, req) {
      const parts = [{ text: req.prompt }]
      if (req.init) {
        const im = dataUrl(req.init)
        parts.push({ inlineData: { mimeType: im.type, data: im.bytes.toString('base64') } })
      }
      const j = await askJson(`${GG}/models/${model}:generateContent`,
        sendJson({ 'x-goog-api-key': c.key }, {
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio: req.kind === 'pose' ? '3:4' : '16:9' },
          },
        }))
      const got = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data)
      if (!got) throw new Error('Gemini 가 그림을 돌려주지 않았다 (안전 필터일 수 있다)')
      return b64(got.inlineData.data, str(got.inlineData.mimeType) || 'image/png')
    },
  },

  stability: {
    label: 'Stability AI',
    hint: 'sk- 로 시작하는 키. SD 3.5 를 GPU 없이 쓴다',
    fields: ['key'],
    probe: async (c) => {
      const j = await askJson('https://api.stability.ai/v1/user/account', { headers: bearer(c) })
      return `계정 ${str(j.email) || '확인'} 로 붙었다`
    },
    models: [
      { id: 'sd3.5-large', label: 'SD 3.5 Large (Stability API)', note: '외부 · Stability', kind: 'image', strength: true },
      { id: 'sd3.5-flash', label: 'SD 3.5 Flash (Stability API)', note: '외부 · Stability', kind: 'image', strength: true },
    ],
    async run(c, model, req) {
      const im = req.init ? dataUrl(req.init) : null
      // image-to-image 는 aspect_ratio 를 받지 않는다. 크기는 보낸 그림이 정한다
      const body = form({
        model, prompt: req.prompt, negative_prompt: NEG, output_format: 'png',
        mode: im ? 'image-to-image' : 'text-to-image',
        strength: im ? clamp(req.strength, 0.2, 0.95) : undefined,
        aspect_ratio: im ? undefined : (req.kind === 'pose' ? '2:3' : '16:9'),
        seed: req.seed || undefined,
      }, im && { name: 'image', image: im })
      return await askBytes('https://api.stability.ai/v2beta/stable-image/generate/sd3',
        { method: 'POST', headers: { ...bearer(c), accept: 'image/*' }, body })
    },
  },

  replicate: {
    label: 'Replicate',
    hint: 'r8_ 로 시작하는 토큰. 영상 모델은 여기로 붙는다',
    fields: ['key'],
    probe: async (c) => {
      const j = await askJson('https://api.replicate.com/v1/account', { headers: bearer(c) })
      return `계정 ${str(j.username) || '확인'} 로 붙었다`
    },
    // 목록에 없는 모델도 쓸 수 있다. 모델 이름을 replicate:소유자/이름 또는
    // replicate:소유자/이름:버전 으로 그대로 넣으면 그 예측을 띄운다
    models: [
      { id: 'black-forest-labs/flux-1.1-pro', label: 'FLUX 1.1 pro', note: '외부 · Replicate', kind: 'image' },
      { id: 'wan-video/wan-2.5-t2v-fast', label: 'WAN 2.5 (영상)', note: '외부 · Replicate 영상', kind: 'video' },
    ],
    async run(c, model, req) {
      const [slug, version] = model.split(':')
      const input = { prompt: req.prompt, ...(req.seed ? { seed: req.seed } : {}) }
      if (req.init) input.image = req.init
      const start = version
        ? await askJson('https://api.replicate.com/v1/predictions', sendJson(bearer(c), { version, input }))
        : await askJson(`https://api.replicate.com/v1/models/${slug}/predictions`,
          sendJson({ ...bearer(c), prefer: 'wait' }, { input }))
      const got = await settled(c, start)
      const out = got.output
      const url = Array.isArray(out) ? str(out[out.length - 1]) : str(out)
      if (!url.startsWith('http')) throw new Error(`Replicate 결과를 읽지 못했다: ${JSON.stringify(out).slice(0, 200)}`)
      return await askBytes(url)
    },
  },
}

/** 예측이 끝날 때까지 본다. 영상은 몇 분 걸린다 — 이 함수의 상한이 잡 시간을 정한다 */
async function settled(c, start) {
  let j = start
  for (let i = 0; i < 100 && !['succeeded', 'failed', 'canceled'].includes(j.status); i++) {
    await sleep(5000)
    j = await askJson(j.urls.get, { headers: bearer(c) })
  }
  if (j.status !== 'succeeded') throw new Error(`Replicate ${j.status}: ${str(j.error) || '사유 없음'}`)
  return j
}

// ── 키 보관 ──────────────────────────────────────────────────────────────────

const nameOf = (provider) => `${PREFIX}/${provider}`
const tailOf = (key) => `…${str(key).slice(-4)}`

/** 알 수 없는 제공자 이름으로 SSM 을 두드리지 않는다 */
function providerOf(name) {
  const p = Object.hasOwn(PROVIDERS, str(name)) ? PROVIDERS[str(name)] : null
  if (!p) throw new Error(`모르는 제공자다: ${str(name) || '(빈 값)'}`)
  return p
}

async function creds(provider) {
  try {
    const out = await openSsm().send(new GetParameterCommand({ Name: nameOf(provider), WithDecryption: true }))
    const c = JSON.parse(out.Parameter.Value)
    if (!str(c.key)) throw new Error('키가 비어 있다')
    return c
  } catch (err) {
    if (err.name === 'ParameterNotFound') throw new Error(`${provider} 키가 없다. 커넥터에서 먼저 넣어야 한다`)
    throw err
  }
}

/** 설정된 제공자 목록. 값은 가져오지 않는다 (마스킹은 저장할 때 적어 둔 tail 로 한다) */
async function saved() {
  const out = await openSsm().send(new GetParametersByPathCommand({ Path: PREFIX, Recursive: true }))
  const map = {}
  for (const p of out.Parameters || []) {
    const key = p.Name.slice(PREFIX.length + 1)
    map[key] = { at: p.LastModifiedDate?.toISOString?.() || null }
  }
  return map
}

async function list() {
  const have = await saved()
  return {
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      label: p.label,
      hint: p.hint,
      gate: p.gate || null,
      fields: p.fields,
      configured: !!have[id],
      at: have[id]?.at || null,
      // 설정되지 않은 제공자의 모델은 내보내지 않는다. 못 부르는 모델이 목록에 뜨면 안 된다
      models: have[id] ? p.models.map((m) => ({ ...m, id: `${id}:${m.id}` })) : [],
    })),
  }
}

/** 검증하고 저장한다. 검증에 실패하면 저장하지 않는다 */
async function put(payload) {
  const id = str(payload?.provider)
  const p = providerOf(id)
  const key = str(payload?.key)
  if (key.length < 8) throw new Error('키가 너무 짧다')

  // 다른 칸(비밀값 등)은 제공자가 말한 것만 받는다
  const extra = {}
  for (const f of p.fields) if (f !== 'key' && str(payload?.[f])) extra[f] = str(payload[f])

  const note = await p.probe({ key, ...extra })
  await openSsm().send(new PutParameterCommand({
    Name: nameOf(id),
    Type: 'SecureString',
    Overwrite: true,
    Value: JSON.stringify({ key, ...extra, by: str(payload?.owner), at: new Date().toISOString() }),
    Description: `${p.label} 커넥터 키`,
  }))
  return { provider: id, ok: true, note, tail: tailOf(key) }
}

async function remove(payload) {
  const id = str(payload?.provider)
  providerOf(id)
  try {
    await openSsm().send(new DeleteParameterCommand({ Name: nameOf(id) }))
  } catch (err) {
    if (err.name !== 'ParameterNotFound') throw err
  }
  return { provider: id, ok: true }
}

// ── 만들기 ───────────────────────────────────────────────────────────────────

/** 'openai:gpt-image-1' → ['openai', 'gpt-image-1']. 모델 이름에 콜론이 더 있어도 살린다 */
function splitModel(full) {
  const s = str(full)
  const i = s.indexOf(':')
  if (i < 1) throw new Error(`모델 이름이 제공자:모델 꼴이 아니다: ${s || '(빈 값)'}`)
  return [s.slice(0, i), s.slice(i + 1)]
}

const isVideo = (type) => str(type).startsWith('video/')

async function upload(out) {
  const ext = isVideo(out.type) ? 'mp4' : 'png'
  const key = `img/${randomUUID().replace(/-/g, '')}.${ext}`
  await openS3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: out.bytes,
    ContentType: str(out.type) || 'image/png',
    CacheControl: 'public, max-age=31536000, immutable',
  }))
  return `/${key}`
}

async function putResult(jobId, owner, body) {
  await openDdb().send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `GEN#${jobId}`,
      sk: 'RESULT',
      owner,
      status: body.status,
      body: JSON.stringify(body),
      ttl: Math.floor(Date.now() / 1000) + TTL_SEC,
    },
  }))
}

/**
 * 한 장 만들고 결과를 적는다. 성공이든 실패든 반드시 한 건 적는다.
 * 던지지 않는다 — Event 호출에서 던지면 Lambda 가 재시도를 돌려 돈이 두 번 나간다.
 */
async function gen(payload) {
  const jobId = str(payload?.jobId)
  const owner = str(payload?.owner)
  if (!jobId) throw new Error('gen 에 jobId 가 없다')
  if (!TABLE) throw new Error('OPS_TABLE 이 비어 있다')
  if (!BUCKET) throw new Error('IMAGES_BUCKET 이 비어 있다')

  const t = Date.now()
  try {
    const [id, model] = splitModel(payload?.model)
    const p = providerOf(id)
    const c = await creds(id)
    const req = {
      kind: str(payload?.kind) === 'pose' ? 'pose' : 'cut',
      init: str(payload?.init) || null,
      strength: payload?.strength,
      seed: Number(payload?.seed) || null,
      prompt: '',
    }
    req.prompt = promptFor(req, await en(payload?.prompt))

    const out = await p.run(c, model, req)
    if (!out?.bytes?.length) throw new Error(`${p.label} 이 빈 응답을 돌려줬다`)
    const known = p.models.find((m) => m.id === model)
    await putResult(jobId, owner, {
      status: 'done',
      url: await upload(out),
      kind: isVideo(out.type) ? 'video' : 'image',
      model: known?.label || `${p.label} ${model}`,
      modelId: `${id}:${model}`,
      seed: req.seed,
      ms: Date.now() - t,
    })
  } catch (err) {
    console.error('[conn] gen 실패', jobId, err)
    await putResult(jobId, owner, { status: 'error', error: str(err?.message) || 'gen 실패' })
  }
  return { jobId, status: 'accepted' }
}

// ── 핸들러 ───────────────────────────────────────────────────────────────────

const OPS = { list, put, remove, gen }

exports.handler = async (event) => {
  const name = str(event?.operation)
  const op = Object.hasOwn(OPS, name) ? OPS[name] : null
  if (!op) throw new Error(`알 수 없는 오퍼레이션: ${event?.operation}`)
  return await op(event.payload)
}

// ── 자기 점검 ────────────────────────────────────────────────────────────────
// node index.js — 네트워크 없이 도는 부분만 본다
if (require.main === module) {
  const ok = (c, m) => { if (!c) throw new Error(m) }

  ok(splitModel('openai:gpt-image-1')[0] === 'openai', '제공자 분리')
  ok(splitModel('huggingface:stabilityai/stable-diffusion-3.5-large')[1] === 'stabilityai/stable-diffusion-3.5-large', '슬래시 모델')
  ok(splitModel('replicate:owner/name:abc123')[1] === 'owner/name:abc123', '버전 콜론 유지')
  for (const bad of ['', 'openai', ':x', null]) {
    let threw = false
    try { splitModel(bad) } catch { threw = true }
    ok(threw, `잘못된 모델 이름을 걸러야 한다: ${bad}`)
  }

  const im = dataUrl('data:image/png;base64,aGk=')
  ok(im.type === 'image/png' && im.bytes.toString() === 'hi', 'data:URL 해석')
  ok(dataUrl('aGk=').bytes.toString() === 'hi', '헤더 없는 base64')

  const cut = promptFor({ kind: 'cut' }, 'a baker')
  const pose = promptFor({ kind: 'pose', init: 'x' }, 'a baker')
  ok(cut.includes(NOTEXT) && cut.includes(STYLE) && !cut.includes(SHEET) && !cut.includes(FINISH), '컷 프롬프트')
  ok(pose.includes(SHEET) && pose.includes(FINISH), '포즈 + 기준 그림 프롬프트')
  ok(!STYLE.includes('watermark') && NEG.includes('watermark'), '네거티브에만 watermark')

  ok(tailOf('sk-abcdefgh') === '…efgh', '끝 네 글자만')
  ok(nameOf('openai') === '/storyboard/connector/openai', 'SSM 이름')
  ok(clamp(9, 0.2, 0.95) === 0.95 && clamp(0, 0.2, 0.95) === 0.2, '강도 자르기')
  ok(isAscii('hello') && !isAscii('빵집'), '아스키 판정')
  ok(isVideo('video/mp4') && !isVideo('image/png'), '영상 판정')

  const f = form({ a: '1', b: '', c: undefined, d: 2 })
  ok(f.get('a') === '1' && !f.has('b') && !f.has('c') && f.get('d') === '2', '빈 칸은 빼고 보낸다')

  for (const [id, p] of Object.entries(PROVIDERS)) {
    ok(p.label && p.hint && p.fields.includes('key'), `${id} 설명`)
    ok(typeof p.probe === 'function' && typeof p.run === 'function', `${id} 함수`)
    for (const m of p.models) ok(m.id && m.label && ['image', 'video'].includes(m.kind), `${id} 모델 ${m.id}`)
  }
  ok(PROVIDERS.huggingface.gate, 'HF 키는 GPU 게이트도 연다는 안내가 있어야 한다')
  ok(PROVIDERS.replicate.models.some((m) => m.kind === 'video'), '영상 모델이 하나는 있어야 한다')

  let threw = false
  try { providerOf('없는곳') } catch { threw = true }
  ok(threw, '모르는 제공자를 막아야 한다')

  console.log('ok')
}
