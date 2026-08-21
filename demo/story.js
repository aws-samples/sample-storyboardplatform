
import { normalizePlan, splitScenario, CAMERAS } from './core.js'

export const MODES = [
  { id: 'new', label: '새 스토리', hint: '프롬프트 하나로 이야기·인물·컷을 처음부터' },
  { id: 'next', label: '다음 회차', hint: '지금 판의 인물과 사건을 이어서' },
  { id: 'spin', label: '스핀오프', hint: '한 인물을 주인공으로 갈라 나온 이야기' },
]

export const GENRES = ['브랜드 필름', '드라마', '코미디', '스릴러', '판타지', '다큐멘터리', '뮤직비디오', '애니메이션']
export const TONES = ['따뜻한', '담백한', '유쾌한', '긴장된', '서늘한', '몽환적인', '씩씩한']
export const LENGTHS = [15, 30, 60, 120, 300]
export const CUTCOUNTS = [6, 8, 12, 16, 24]

const beatCount = (cuts) => Math.min(8, Math.max(3, Math.round(cuts / 2)))
const perBeat = (cuts, beats) => Math.max(1, Math.round(cuts / Math.max(1, beats)))
const BATCH = 4
const HARD_MAX = 40

const JSON_ONLY = '오직 아래 모양의 JSON 하나만 출력한다. 설명·머리말·코드펜스를 붙이지 않는다.'

const roster = (chars) =>
  chars.length ? chars.map((c) => `- ${c.name}: ${c.brief || '(설명 없음)'}`).join('\n') : '(없음)'

export function outlinePrompt(spec, ctx) {
  const nb = beatCount(spec.cuts)
  const keep = spec.useChars ? ctx.chars : []
  const head = {
    new: `아래 소재로 ${spec.secs}초 영상의 이야기를 처음부터 기획한다.`,
    next: `아래 판의 다음 회차(${spec.secs}초)를 기획한다. 인물과 앞 사건을 잇되, 이 회차 안에서 시작하고 끝나는 새 사건이어야 한다.`,
    spin: `아래 판에서 ${ctx.centerName || '한 인물'}을 주인공으로 갈라 나온 스핀오프(${spec.secs}초)를 기획한다. 본편과 다른 무대, 다른 사건이어야 한다.`,
  }[spec.mode]

  return [
    head,
    '',
    `소재: ${spec.prompt}`,
    `장르: ${spec.genre} / 톤: ${spec.tone}`,
    spec.mode === 'new' ? null : `지금 판의 제목: ${ctx.title || '(없음)'}`,
    spec.mode === 'new' ? null : `지금 판의 이야기:\n${ctx.scenario || '(없음)'}`,
    `이미 있는 인물:\n${roster(keep)}`,
    '',
    JSON_ONLY,
    '{"title":"제목","logline":"한 문장 요약","synopsis":"3~5문장 줄거리",',
    ' "chars":[{"name":"이름","brief":"나이·외모·옷·분위기를 한 줄로. 그림 지시로 쓸 수 있게 구체적으로"}],',
    ` "beats":[{"scene":"S1 장소","summary":"이 비트에서 일어나는 일","secs":초,"cast":["이름"]}]}`,
    '',
    '규칙',
    `- beats는 ${nb}개. secs 합계는 ${spec.secs}초에 맞춘다.`,
    spec.newChars > 0
      ? `- chars에는 새로 만드는 인물 ${spec.newChars}명만 넣는다. 이름은 한국어로 짓는다.`
      : '- chars는 빈 배열로 둔다.',
    keep.length ? '- 이미 있는 인물은 chars에 다시 넣지 않고 cast에서 이름으로만 부른다.' : null,
    '- 대사는 여기서 쓰지 않는다. 비트는 무슨 일이 벌어지는지만 적는다.',
    '- 한국어로 쓴다.',
  ].filter((l) => l !== null).join('\n')
}

export function cutsPrompt(spec, outline, beats, from, per) {
  const secs = beats.reduce((a, b) => a + b.secs, 0)
  const lines = beats.map((b, i) =>
    `${from + i + 1}. ${b.scene || `S${from + i + 1}`} — ${b.action} (${b.secs}초, 등장: ${b.cast.join(', ') || '없음'})`)

  return [
    '아래 이야기의 비트를 콘티 컷으로 펼친다.',
    '',
    `제목: ${outline.title}`,
    `로그라인: ${outline.logline}`,
    `톤: ${spec.tone}`,
    `인물:\n${roster(outline.chars)}`,
    '',
    '비트:',
    ...lines,
    '',
    JSON_ONLY,
    '{"cuts":[{"scene":"S1 장소","secs":초,"action":"화면에 보이는 것","dialogue":"대사 또는 빈 문자열","camera":"MS","cast":["이름"]}]}',
    '',
    '규칙',
    `- 비트마다 컷 ${per}개 안팎, 비트 순서대로 이어 붙인다.`,
    `- secs 합계는 ${secs}초에 맞춘다.`,
    '- action에는 카메라에 보이는 것만 쓴다. 인물의 속마음이나 설명은 쓰지 않는다.',
    '- dialogue는 실제로 말하는 문장만. 없으면 빈 문자열.',
    `- camera는 다음 중 하나: ${CAMERAS.join(' ')}`,
    '- 한국어로 쓴다.',
  ].join('\n')
}

export function parseJson(text) {
  const s = String(text || '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('기획 결과를 읽지 못했습니다. 다시 시도해 주세요.')
  try {
    return JSON.parse(s.slice(a, b + 1))
  } catch {
    throw new Error('기획 결과가 깨져서 왔습니다. 다시 시도해 주세요.')
  }
}

const ask = async (net, prompt, maxTokens) =>
  parseJson((await net.plan({ prompt, maxTokens, think: false })).text)

export async function planOutline(net, spec, ctx) {
  if (!net?.plan) return localOutline(spec, ctx)
  const p = normalizePlan(await ask(net, outlinePrompt(spec, ctx), 3000), {
    maxChars: spec.newChars,
    maxCuts: 12,
  })
  if (!p.cuts.length) throw new Error('비트를 받지 못했습니다. 다시 시도해 주세요.')
  return { ...p, beats: p.cuts, local: false }
}

export async function planCuts(net, spec, outline) {
  if (!net?.plan) return localCuts(spec, outline)
  const per = perBeat(spec.cuts, outline.beats.length)
  const batches = []
  for (let i = 0; i < outline.beats.length; i += BATCH) batches.push(outline.beats.slice(i, i + BATCH))

  const got = await Promise.allSettled(
    batches.map((b, i) => ask(net, cutsPrompt(spec, outline, b, i * BATCH, per), 2500)))

  const out = []
  got.forEach((r, i) => {
    const cuts = r.status === 'fulfilled'
      ? normalizePlan(r.value, { maxChars: 0, maxCuts: batches[i].length * per + 2 }).cuts
      : []
    if (r.status === 'rejected') console.warn('[story] 컷 묶음 실패 — 비트로 대체한다', r.reason?.message)
    out.push(...(cuts.length ? cuts : batches[i]))
  })
  return out.slice(0, Math.min(HARD_MAX, spec.cuts + 6))
}

const LOCAL_NAMES = ['가온', '노을', '바다', '한결']

function localOutline(spec, ctx) {
  const lines = String(spec.prompt || '').split(/[.\n]/).map((s) => s.trim()).filter(Boolean)
  const nb = beatCount(spec.cuts)
  const cast = spec.useChars ? ctx.chars.map((c) => c.name).slice(0, 2) : []
  const chars = LOCAL_NAMES.slice(0, spec.newChars).map((name) => ({
    name, brief: `${spec.tone} 분위기의 인물 (로컬 모드 임시)`,
  }))
  const p = normalizePlan({
    title: lines[0] || '새 스토리',
    logline: spec.prompt,
    synopsis: spec.prompt,
    chars,
    beats: Array.from({ length: nb }, (_, i) => ({
      scene: `S${i + 1}`,
      summary: lines[i % Math.max(1, lines.length)] || `${spec.prompt} — 비트 ${i + 1}`,
      secs: spec.secs / nb,
      cast: [...cast, ...chars.map((c) => c.name)],
    })),
  }, { maxChars: spec.newChars, maxCuts: 12 })
  return { ...p, beats: p.cuts, local: true }
}

function localCuts(spec, outline) {
  const per = perBeat(spec.cuts, outline.beats.length)
  const out = []
  for (const b of outline.beats) {
    const parts = splitScenario(b.action).slice(0, per)
    const list = parts.length ? parts : [{ action: b.action, dialogue: '', camera: b.camera }]
    for (const c of list) {
      out.push({ ...c, scene: b.scene, cast: b.cast, secs: Math.max(0.5, Math.round((b.secs / list.length) * 10) / 10) })
    }
  }
  return out.slice(0, HARD_MAX)
}
