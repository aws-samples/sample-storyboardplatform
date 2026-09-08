/*
 * 프로젝트가 들고 있는 에셋의 종류표입니다. 순수 데이터라서 DOM 도 네트워크도 없습니다.
 * 실제로 읽고 쓰는 것은 services/assets.js 이고, 그리는 것은 pages/project.js 입니다.
 *
 * ══ 왜 이 표가 필요한가
 *
 * 이 판이 생기기 전에는 프로젝트에 무엇이 들었는지 아무 데서도 볼 수 없었습니다. 카드에
 * 「마지막에 누가 뭘 했다」한 줄만 있었고(services/projects.js), 그 안의 대본이나 씬은
 * 화면을 하나씩 열어 봐야 알았습니다. 게다가 대본과 씬은 아예 저장되지 않아서
 * (pages/key-visual.js 의 S.script · S.scenes) 새로고침 한 번에 사라졌습니다. 그래서
 * 1·2 단계만 하는 사람이 자기 작업을 이어서 할 수가 없었습니다.
 *
 * ══ 왜 순서가 이 순서인가
 *
 * 만들어지는 순서입니다. 시놉시스 → 대본 → 그래프 → 씬 → 키 비주얼 → 콘티. 서랍에
 * 이 순서로 서고, 앞의 것이 뒤의 것의 입력입니다. 다만 앞이 비어 있어도 뒤를 만들 수
 * 있습니다. 대본을 밖에서 써 온 사람은 시놉시스 칸이 비어 있는 채로 씬부터 나눕니다.
 * 서랍이 빈 칸을 「덜 된 것」이 아니라 「아직 없는 것」으로 그리는 이유입니다.
 */

/**
 * 에셋 종류. key 가 저장소의 sk 접미(ASSET#<key>)이자 화면들이 쓰는 이름입니다.
 *
 *   label  서랍에 적히는 이름
 *   step   이 에셋을 만드는 화면. domain/routes.js 의 NAV_TABS 의 id 입니다
 *   make   비어 있을 때 서랍이 내미는 버튼의 말
 *   text   본문이 통째로 긴 글인지. true 면 body 가 문자열, false 면 객체입니다
 */
export const ASSET_KINDS = [
  {
    key: 'synopsis',
    label: '시놉시스',
    step: 'develop',
    make: '시놉시스 쓰기',
    text: false,
  },
  {
    key: 'script',
    label: '대본',
    step: 'develop',
    make: '대본 넣기',
    text: true,
  },
  {
    key: 'graph',
    label: '관계 그래프',
    step: 'develop',
    make: '그래프 뽑기',
    text: false,
  },
  {
    key: 'scenes',
    label: '씬',
    step: 'keyvisual',
    make: '씬 나누기',
    text: false,
  },
  {
    key: 'keyvisual',
    label: '키 비주얼',
    step: 'keyvisual',
    make: '그림 만들기',
    text: false,
  },
  {
    key: 'conti',
    label: '콘티',
    step: 'board',
    make: '컷 짜기',
    text: false,
  },
]

/** 저장소가 받아 주는 종류인지. 모르는 key 는 쓰지 않고 버립니다 */
export const KIND_KEYS = ASSET_KINDS.map((k) => k.key)
export const assetKind = (key) => ASSET_KINDS.find((k) => k.key === key) || null
export const isAssetKind = (key) => KIND_KEYS.includes(key)

/*
 * DynamoDB 항목 하나의 상한이 400KB 입니다. 대본 하나가 그 안에 들어가야 합니다.
 *
 * 넉넉히 잡되 상한보다 확실히 아래로 둡니다. 항목에는 본문 말고도 boardId·kind·
 * updatedAt·actor 가 같이 들어가고, DynamoDB 는 UTF-8 바이트로 셉니다. 한글은 글자당
 * 3바이트라서 120,000자면 약 360KB 입니다. 그 위로 여유를 두려면 이 정도가 맞습니다.
 *
 * 넘으면 자르지 않고 거부합니다. 조용히 자르면 대본이 반토막인 것을 아무도 모릅니다.
 * 두 시간 뒤에 「뒷부분이 어디 갔지」를 겪는 것보다 지금 「너무 깁니다」를 보는 편이
 * 낫습니다. 더 긴 대본을 받아야 하면 본문만 S3 로 옮기고 여기에 열쇠를 두면 됩니다.
 * 그때 갈아 끼울 자리는 services/assets.js 의 put 하나입니다.
 */
export const ASSET_MAX_CHARS = 100_000

/**
 * 저장할 수 있는 크기인지 봅니다.
 * @param {*} body - 저장할 본문. 문자열이거나 객체입니다
 * @returns {{ok: boolean, chars: number, why?: string}}
 */
export function fitsAsset(body) {
  const chars = (typeof body === 'string' ? body : JSON.stringify(body ?? null) || '').length
  if (chars <= ASSET_MAX_CHARS) return { ok: true, chars }
  return {
    ok: false,
    chars,
    why: `${chars.toLocaleString('ko-KR')}자입니다. 한 번에 담을 수 있는 것은 `
      + `${ASSET_MAX_CHARS.toLocaleString('ko-KR')}자까지입니다. 나눠서 넣어 주세요.`,
  }
}

/*
 * 서랍의 한 줄에 적히는 요약입니다.
 *
 * 본문을 다 읽어야 알 수 있는 것을 여기서 한 줄로 만듭니다. 서랍은 프로젝트 하나의
 * 에셋을 한 번에 읽으므로(같은 pk) 본문이 이미 손에 있습니다. 그래서 저장할 때 요약을
 * 따로 적어 두지 않아도 됩니다. 적어 두면 본문과 어긋날 자리가 하나 늘어납니다.
 *
 * 모르는 종류나 빈 본문은 null 입니다. 부르는 쪽이 「아직 없음」으로 그립니다.
 */
const SUM = {
  synopsis: (b) => {
    const bits = []
    if (b?.logline) bits.push('로그라인')
    if (b?.synopsis) bits.push('줄거리')
    if (b?.title) bits.unshift(`「${b.title}」`)
    return bits.length ? bits.join(' · ') : null
  },
  script: (b) => {
    const t = String(b || '')
    if (!t.trim()) return null
    const lines = t.split('\n').filter((l) => l.trim()).length
    return `${t.length.toLocaleString('ko-KR')}자 · ${lines.toLocaleString('ko-KR')}줄`
  },
  graph: (b) => {
    const n = b?.nodes?.length || 0
    const e = b?.edges?.length || 0
    return n || e ? `노드 ${n} · 관계 ${e}` : null
  },
  scenes: (b) => {
    const list = Array.isArray(b?.scenes) ? b.scenes : []
    if (!list.length) return null
    const withPrompt = list.filter((s) => s?.prompt).length
    return `${list.length}개 · 프롬프트 ${withPrompt}/${list.length}`
  },
  keyvisual: (b) => {
    const list = Array.isArray(b?.shots) ? b.shots : []
    return list.length ? `${list.length}장` : null
  },
  conti: (b) => {
    const cuts = Number(b?.cuts) || 0
    if (!cuts) return null
    const ok = Number(b?.approved) || 0
    const eps = Number(b?.eps) || 0
    return `컷 ${cuts}개 · 승인 ${ok}/${cuts}${eps ? ` · 회차 ${eps}` : ''}`
  },
}

/**
 * 에셋 한 줄의 요약. 아직 아무것도 없으면 null 입니다.
 * @param {string} key - ASSET_KINDS 의 key
 * @param {*} body - 저장된 본문
 * @returns {string|null}
 */
export function summarize(key, body) {
  if (body === null || body === undefined) return null
  try {
    return SUM[key]?.(body) ?? null
  } catch {
    // 본문의 모양이 예상과 다른 것뿐입니다. 서랍의 한 줄 때문에 화면을 멈추지 않습니다
    return null
  }
}
