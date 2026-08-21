
const POSE_ART = {
  '정면': { turn: 0, scale: 1, crop: 'bust' },
  '3/4': { turn: .38, scale: 1, crop: 'bust' },
  '측면': { turn: .92, scale: 1, crop: 'bust' },
  '후면': { turn: 1, scale: 1, crop: 'bust', back: true },
  '전신': { turn: .2, scale: .62, crop: 'full' },
  '표정': { turn: .1, scale: 1.7, crop: 'head' },
}

const memo = new Map()

export function srcOf(v) {
  if (!v) return null
  if (v.src) return v.src
  if (!v.art) return null
  const key = JSON.stringify(v.art)
  let url = memo.get(key)
  if (!url) {
    url = makeArt(v.art)
    if (memo.size > 200) memo.clear()
    memo.set(key, url)
  }
  return url
}

export function makeArt({ seed = 1, mode = 'sketch', prompt = '', figure = false, pose = '' } = {}) {
  let s = seed * 9301 + 49297
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280)

  const c = document.createElement('canvas')
  const W = figure ? 480 : 640
  const H = figure ? 640 : 360
  c.width = W; c.height = H
  const g = c.getContext('2d')

  if (figure) drawFigure(g, { rnd, pose, mode, W, H })
  else drawScene(g, { rnd, mode })

  g.font = '600 13px "IBM Plex Mono", monospace'
  g.fillStyle = mode === 'ai' ? '#2A5CA8' : '#6B665E'
  g.fillText(mode === 'ai' ? 'GENERATED' : 'SKETCH', 16, 28)
  const cap = figure ? pose : prompt
  if (cap) {
    g.font = '12px "IBM Plex Sans KR", sans-serif'
    g.fillStyle = 'rgba(40,42,46,.55)'
    g.fillText(String(cap).slice(0, 46), 16, H - 16)
  }
  return c.toDataURL('image/jpeg', 0.7)
}

function drawFigure(g, { rnd, pose, W, H }) {
  g.fillStyle = '#F3F0E8'
  g.fillRect(0, 0, W, H)

  g.strokeStyle = 'rgba(40,42,46,.06)'
  g.lineWidth = 1
  for (let x = 60; x < W; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke() }
  for (let y = 60; y < H; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke() }

  const hue = Math.floor(rnd() * 360)
  const hair = `hsl(${hue}, 30%, 24%)`
  const cloth = `hsl(${(hue + 155) % 360}, 32%, 52%)`
  const pants = `hsl(${(hue + 155) % 360}, 22%, 34%)`
  const skin = '#E7CFB6'

  const spec = POSE_ART[pose] || POSE_ART['정면']
  const k = spec.scale
  const cx = W / 2 + spec.turn * 34
  const headR = 56 * k
  const headY = spec.crop === 'head' ? H * 0.44 : spec.crop === 'full' ? H * 0.2 : H * 0.3

  g.strokeStyle = 'rgba(40,42,46,.1)'
  g.beginPath(); g.moveTo(0, headY); g.lineTo(W, headY); g.stroke()

  const shoulder = 128 * k * (1 - spec.turn * 0.55)
  const bodyTop = headY + headR * 0.92
  const bodyBot = spec.crop === 'full' ? H * 0.62 : H * 0.94

  if (spec.crop === 'full') {
    g.fillStyle = 'rgba(40,42,46,.09)'
    g.beginPath(); g.ellipse(cx, H * 0.87, 86, 11, 0, 0, 7); g.fill()
  }

  g.fillStyle = cloth
  g.beginPath()
  g.moveTo(cx - shoulder / 2, bodyTop + 12)
  g.quadraticCurveTo(cx, bodyTop - 8, cx + shoulder / 2, bodyTop + 12)
  g.lineTo(cx + shoulder * 0.42, bodyBot)
  g.lineTo(cx - shoulder * 0.42, bodyBot)
  g.closePath(); g.fill()

  if (spec.crop === 'full') {
    g.fillStyle = pants
    g.fillRect(cx - shoulder * 0.36, bodyBot - 4, shoulder * 0.28, H * 0.25)
    g.fillRect(cx + shoulder * 0.08, bodyBot - 4, shoulder * 0.28, H * 0.25)
  }

  g.fillStyle = skin
  g.fillRect(cx - 13 * k, bodyTop - 24 * k, 26 * k, 28 * k)
  g.beginPath(); g.arc(cx, headY, headR, 0, 7); g.fill()

  if (!spec.back && spec.turn > 0.55) {
    g.beginPath()
    g.moveTo(cx + headR * 0.84, headY)
    g.lineTo(cx + headR * (0.84 + 0.34 * spec.turn), headY + headR * 0.2)
    g.lineTo(cx + headR * 0.8, headY + headR * 0.32)
    g.closePath(); g.fill()
  }

  g.fillStyle = hair
  if (spec.back) {
    g.beginPath(); g.arc(cx, headY, headR * 1.02, 0, 7); g.fill()
  } else {
    g.beginPath()
    g.arc(cx - spec.turn * headR * 0.26, headY - headR * 0.12, headR * 1.05, Math.PI, Math.PI * 2)
    g.fill()
    if (spec.turn > 0.5) {
      g.beginPath(); g.arc(cx - headR * 0.4, headY + headR * 0.06, headR * 0.66, 0, 7); g.fill()
    }
  }

  if (!spec.back) {
    const ex = spec.turn * headR * 0.4
    g.fillStyle = 'rgba(40,42,46,.72)'
    const eyeR = 4.6 * k
    if (spec.turn < 0.8) {
      g.beginPath(); g.arc(cx - headR * 0.3 + ex, headY + headR * 0.06, eyeR, 0, 7); g.fill()
    }
    g.beginPath(); g.arc(cx + headR * 0.3 + ex * 0.6, headY + headR * 0.06, eyeR, 0, 7); g.fill()

    g.strokeStyle = 'rgba(40,42,46,.5)'
    g.lineWidth = 2 * k
    g.beginPath()
    g.moveTo(cx + ex * 1.2, headY + headR * 0.16)
    g.lineTo(cx + ex * 1.2 + spec.turn * 9, headY + headR * 0.38)
    g.stroke()
    g.beginPath()
    g.moveTo(cx - headR * 0.16 + ex, headY + headR * 0.56)
    g.lineTo(cx + headR * 0.18 + ex, headY + headR * 0.56)
    g.stroke()
  }

  g.strokeStyle = 'rgba(40,42,46,.1)'
  g.lineWidth = 1
  for (let i = 0; i < 18; i++) {
    const y = rnd() * H
    g.beginPath(); g.moveTo(rnd() * 140, y); g.lineTo(rnd() * 220 + 220, y + (rnd() - .5) * 10); g.stroke()
  }
}

function drawScene(g, { rnd, mode }) {
  g.fillStyle = mode === 'ai' ? '#EDE9E1' : '#F4F1E9'
  g.fillRect(0, 0, 640, 360)

  g.strokeStyle = mode === 'ai' ? 'rgba(58,66,80,.45)' : 'rgba(40,42,46,.5)'
  g.lineWidth = 2
  const horizon = 150 + rnd() * 90
  g.beginPath(); g.moveTo(0, horizon); g.lineTo(640, horizon + (rnd() - .5) * 30); g.stroke()

  for (let i = 0; i < 4; i++) {
    const x = 40 + rnd() * 520, y = horizon - 20 - rnd() * 90
    const w = 40 + rnd() * 130, h = 40 + rnd() * 120
    g.globalAlpha = 0.12 + rnd() * 0.2
    g.fillStyle = mode === 'ai' ? '#5A6B84' : '#4A4741'
    g.fillRect(x, y, w, h + (horizon - y))
    g.globalAlpha = 1
  }

  const px = 180 + rnd() * 260
  g.globalAlpha = .5
  g.fillStyle = '#2B2A28'
  g.beginPath(); g.arc(px, horizon - 74, 15, 0, 7); g.fill()
  g.fillRect(px - 15, horizon - 58, 30, 58)
  g.globalAlpha = 1

  g.strokeStyle = 'rgba(40,42,46,.14)'
  g.lineWidth = 1
  for (let i = 0; i < 26; i++) {
    const y = rnd() * 360
    g.beginPath(); g.moveTo(rnd() * 200, y); g.lineTo(rnd() * 300 + 300, y + (rnd() - .5) * 12); g.stroke()
  }
}

export function downscale(file, maxBytes = 140_000) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let max = 1280
      let out = ''
      for (const [m, q] of [[1280, .82], [960, .72], [720, .64], [560, .55], [420, .45]]) {
        max = m
        out = render(img, m, q)
        if (out.length <= maxBytes) break
      }
      resolve(out)
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다')) }
    img.src = url
  })
}

function render(img, max, q) {
  const scale = Math.min(1, max / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * scale)
  c.height = Math.round(img.height * scale)
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', q)
}
