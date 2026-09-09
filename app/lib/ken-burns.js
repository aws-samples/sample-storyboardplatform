/*
 * 컷 그림 한 장 → 짧은 동영상 파일. 브라우저 안에서만 만듭니다.
 *
 * 왜 이것이 있나: MCP 연동 화면의 「데모로 연결」이 쓸 영상입니다. 데모는 바깥으로
 * 아무것도 보내지 않으므로 진짜 생성 결과가 없는데, 그렇다고 없는 주소를 영상이라고
 * 내밀 수는 없습니다(op 로그에 남아 깨진 링크가 됩니다). 그래서 그 자리에서 진짜 영상
 * 파일을 만듭니다 — 캔버스에 그림을 아주 천천히 밀고 당기며 그리고 그것을 녹화합니다.
 * 연출로는 켄 번스 효과이고, 재생되는 파일은 진짜 webm 입니다.
 *
 * ponytail: 이것은 데모용입니다. 진짜 모션은 Higgsfield 가 만듭니다. 여기서 프레임
 * 보간이나 카메라 경로를 늘릴 일은 없습니다 — 그럴 값어치가 있으면 서버에 붙일 때입니다.
 */

const MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']

/** 이 브라우저가 녹화할 수 있는지. 없으면 화면이 데모 영상을 권하지 않습니다 */
export const canRecord = () => typeof MediaRecorder === 'function'
  && typeof HTMLCanvasElement !== 'undefined'
  && typeof HTMLCanvasElement.prototype.captureStream === 'function'

const pickMime = () => MIMES.find((m) => MediaRecorder.isTypeSupported?.(m)) || ''

/*
 * 그림을 담습니다. 다른 출처의 그림은 crossOrigin 없이 그리면 캔버스가 오염되어
 * captureStream 이 막힙니다. 그래서 anonymous 로 먼저 받아 보고, 그것이 실패하면
 * 그림 없이 만듭니다(아래 drawBlank).
 */
const loadImage = (src) => new Promise((done) => {
  if (!src) { done(null); return }
  const img = new Image()
  if (!/^data:/.test(src)) img.crossOrigin = 'anonymous'
  img.onload = () => done(img)
  img.onerror = () => done(null)
  img.src = src
})

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2)

function drawBlank(ctx, w, h, text) {
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, '#1b2230')
  g.addColorStop(1, '#0e1218')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(255,255,255,.72)'
  ctx.font = `${Math.round(h / 18)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText(String(text || '그림이 없는 컷').slice(0, 40), w / 2, h / 2)
  ctx.textAlign = 'left'
}

/**
 * 그림 한 장을 천천히 밀며 녹화합니다.
 *
 * @param {object} o
 * @param {string} o.src - 컷 그림. data: 도 됩니다
 * @param {number} [o.secs] - 길이
 * @param {number} [o.w] @param {number} [o.h]
 * @param {string} [o.label] - 화면 구석에 태워 넣을 표시. 데모임을 파일 안에도 남깁니다
 * @param {string} [o.alt] - 그림을 못 받았을 때 대신 적을 글
 * @returns {Promise<{url: string, blob: Blob, mime: string, ms: number}>}
 */
export async function makeClip({ src, secs = 3, w = 768, h = 432, label = '', alt = '' } = {}) {
  if (!canRecord()) throw new Error('이 브라우저는 캔버스 녹화(MediaRecorder)를 지원하지 않습니다.')

  const img = await loadImage(src)
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h })
  const ctx = canvas.getContext('2d')
  const dur = Math.max(1, Math.min(10, Number(secs) || 3)) * 1000

  const mime = pickMime()
  const rec = new MediaRecorder(canvas.captureStream(30), mime ? { mimeType: mime } : undefined)
  const parts = []
  rec.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data) }

  const t0 = performance.now()
  const done = new Promise((resolve, reject) => {
    rec.onstop = () => resolve()
    rec.onerror = (e) => reject(e.error || new Error('녹화가 실패했습니다.'))
  })
  rec.start()

  // 한 프레임씩 그립니다. 그리지 않으면 captureStream 이 아무 프레임도 못 냅니다
  await new Promise((resolve) => {
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / dur)
      ctx.fillStyle = '#0b0e13'
      ctx.fillRect(0, 0, w, h)
      if (img) {
        // 1.0 → 1.09 배로 들어가며 아주 조금 왼쪽으로 흘립니다
        const z = 1 + 0.09 * ease(t)
        const cover = Math.max(w / img.width, h / img.height) * z
        const dw = img.width * cover
        const dh = img.height * cover
        ctx.drawImage(img, (w - dw) / 2 - (dw - w) * 0.12 * ease(t), (h - dh) / 2, dw, dh)
      } else {
        drawBlank(ctx, w, h, alt)
      }
      if (label) {
        ctx.font = `${Math.round(h / 26)}px sans-serif`
        const pad = Math.round(h / 36)
        const tw = ctx.measureText(label).width
        ctx.fillStyle = 'rgba(11,14,19,.62)'
        ctx.fillRect(pad, h - pad - Math.round(h / 20), tw + pad, Math.round(h / 20))
        ctx.fillStyle = 'rgba(255,255,255,.9)'
        ctx.fillText(label, pad * 1.5, h - pad * 1.6)
      }
      if (t >= 1) { resolve(); return }
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })

  rec.stop()
  await done
  const blob = new Blob(parts, { type: mime || 'video/webm' })
  return { url: URL.createObjectURL(blob), blob, mime: blob.type, ms: Math.round(performance.now() - t0) }
}
