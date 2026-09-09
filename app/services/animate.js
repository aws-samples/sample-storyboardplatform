/*
 * 컷 → 영상. 우리 GPU 에 일감을 넣고 결과를 물어봅니다(infra/gpu/server.py 의 /gen/animate).
 *
 * ══ 왜 두 걸음인가
 *
 * 한 컷에 30초~3분이 걸리는데 CloudFront 는 60초에 응답을 끊습니다(readTimeout). 그래서
 * POST 는 일감 번호만 받고 바로 끝나고, 진행은 GET 으로 물어봅니다. 기다리는 동안 창을
 * 닫아도 GPU 는 계속 만듭니다 — 번호를 알면 다시 물어볼 수 있습니다.
 *
 * ══ 서버가 한 번에 하나만 만듭니다
 *
 * GPU 가 하나이고 영상 모델과 그림 모델이 그 자리를 나눠 씁니다. 그래서 영상이 올라오면
 * 그림 모델은 내려갑니다(server.py 의 _unload). 다른 사람이 만들고 있으면 서버가 503 과
 * 그 사유를 주고, 그 문장을 그대로 화면에 옮깁니다 — 여기서 새 말을 만들지 않습니다.
 */
import { idToken } from './auth.js'

const cfg = window.SB_CONFIG || {}

/** 우리 GPU 로 영상을 만들 수 있는 배포인지. 로컬에는 생성 서버가 없습니다 */
export const canAnimate = () => !!cfg.genUrl

const AUTH = async () => `Bearer ${await idToken()}`

async function call(path, { method = 'GET', body, fetchImpl = fetch, auth = AUTH } = {}) {
  if (!cfg.genUrl && fetchImpl === fetch) throw new Error('이 배포에는 생성 서버가 없습니다.')
  // genUrl 은 이미 '/gen' 입니다(aws-config.js). 여기서 한 번 더 붙이면 /gen/gen/... 이
  // 되어 404 가 납니다 — 보드·키비주얼도 cfg.genUrl + path 로 부릅니다
  const res = await fetchImpl(`${cfg.genUrl || '/gen'}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: await auth() },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    // 서버의 사유(detail)가 사람 말로 적혀 있습니다. 그것이 있으면 그대로 씁니다.
    // 504 는 만났지만 60초 안에 답이 없던 것이라 「꺼졌다」와 다릅니다
    throw Object.assign(new Error(json.detail || (res.status === 504
      ? '생성 서버가 60초 안에 답하지 못했습니다 (504). 잠시 뒤 다시 눌러주세요'
      : res.status >= 500
        ? `생성 서버가 꺼져 있습니다 (${res.status}). GPU를 켜면 영상도 만들 수 있습니다`
        : `생성 서버 오류 (${res.status})`)), { status: res.status })
  }
  return json
}

export const videoHealth = (deps) => call('/health', deps)
export const startClip = (body, deps) => call('/animate', { ...deps, method: 'POST', body })
export const clipState = (job, deps) => call(`/animate/${encodeURIComponent(job)}`, deps)

/** 진행 한 줄. 걸음 수가 오면 남은 시간을 그것으로 다시 셉니다 */
export function clipHint(s = {}) {
  if (s.status === 'error') return s.error || '영상을 만들지 못했습니다.'
  if (s.status === 'done') return '영상이 나왔습니다.'
  if (s.status === 'run' && s.steps) {
    const done = Math.min(s.step || 0, s.steps)
    const left = Math.round((s.eta || 0) * (1 - done / s.steps))
    return `만듭니다 ${Math.round((done / s.steps) * 100)}%${left > 0 ? ` · 약 ${left}초 남음` : ''}`
  }
  return `자리를 잡았습니다${s.eta ? ` · 약 ${s.eta}초 걸립니다` : ''}…`
}

/**
 * 컷 하나를 영상으로. 넣고, 될 때까지 물어보고, 주소를 돌려줍니다.
 *
 * @param {{still: string, prompt: string, secs: number, quality: string, seed?: number}} body
 * @param {{onTick?: (s: object) => void, every?: number, sleep?: (ms: number) => Promise<void>}} [o]
 * @returns {Promise<{url: string, job: string, ms: number, size: number[], frames: number}>}
 */
export async function runClip(body, { onTick, every = 3000, sleep, ...deps } = {}) {
  const nap = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const job = await startClip(body, deps)
  onTick?.({ status: 'wait', eta: job.eta, job: job.job })

  // 예상 시간의 세 배까지 기다립니다. 그 뒤에는 화면을 놓아 주고 번호를 알려 줍니다
  const deadline = (job.eta || 60) * 3 + 120
  for (let t = 0; t < deadline; t += every / 1000) {
    await nap(every)
    const s = await clipState(job.job, deps)
    if (s.status === 'done' && s.url) return { ...s, job: job.job }
    if (s.status === 'error') throw new Error(s.error || '영상을 만들지 못했습니다.')
    onTick?.({ ...s, eta: s.eta || job.eta, job: job.job })
  }
  throw new Error(`너무 오래 걸립니다. 일감 ${job.job} 은 아직 돌고 있을 수 있습니다. 잠시 뒤 다시 눌러 보세요.`)
}
