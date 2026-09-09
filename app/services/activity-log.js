/*
 * 히스토리 · 누가 · 어떤 단계에서 · 뭘 · 언제 했는지를 op 로그에서 읽어 냅니다.
 *
 * 사실은 한 곳에 있습니다. 보드의 op 로그(DynamoDB, AppSync 의 listOps)입니다.
 * 그 로그를 세 화면이 다 남기고 다 읽습니다.
 *
 *   보드      panel.add · panel.status · comment.add …   원래부터 남기던 것
 *   키비주얼  panel.add(keyVisual) · panel.version       원래부터 남기던 것
 *   디벨롭    step.mark                                  이 파일이 새로 정한 것
 *
 * 새 종류를 만들지 않고 step.mark 하나만 더한 이유는, 로그를 읽는 쪽(pages/board.js 의
 * applyOp)이 모르는 kind 를 만나도 그냥 지나가게 되어 있어서입니다. 즉 디벨롭이
 * 남긴 줄이 보드의 판을 흔들지 않습니다. 반대로 이 파일은 모든 kind 를 사람이 읽는
 * 한 줄로 옮깁니다. 그래서 보드에서 한 일도 홈에서 같이 보입니다.
 *
 * 화면이 사실을 따로 쌓지 않는 것이 중요합니다. 화면마다 자기 localStorage 에 목록을
 * 들고 있으면 다른 사람 브라우저에서는 비어 있고, "누가 뭘 했는지"가 애초에 성립하지
 * 않습니다. 그래서 이 파일에는 저장소가 없습니다. op 를 받아 줄로 옮기는 것만 합니다.
 * 그 줄을 그리는 것은 components/history-list.js 입니다.
 */

import { navTab } from '../domain/routes.js'
import { josa } from '../lib/josa.js'

/** step.mark 의 kind. applyOp 가 모르는 값이라 보드의 판에는 영향이 없다 */
export const MARK = 'step.mark'

/**
 * 단계 하나를 로그에 남기는 op 를 만듭니다. 보내는 것은 부르는 쪽이 합니다
 * (net.sendOp 또는 opsClient().sendOp).
 *
 * @param {object} o
 * @param {string} o.step - NAV_TABS 의 id. 'develop' | 'keyvisual' | 'board' …
 * @param {string} o.actor - 사용자 id
 * @param {string} o.what - 한 일. "씬 9개로 나눴습니다" 처럼 완결된 한 줄
 * @param {string} [o.ref] - 이어서 하려면 필요한 것. 씬 id, 회차 번호, 프로젝트 …
 *                            무엇을 가리키는지는 refKind 로 따로 말합니다
 * @param {object} [o.data] - 이어서 할 때 되살릴 값. 작게 둡니다. 로그는 대본 보관소가 아닙니다
 * @param {boolean} [o.example] - 예시 재생이 남긴 줄. 목록에서 갈라 보여줍니다
 * @returns {object} op
 */
export function markOp({ step, actor, what, ref = null, refKind = null, data = null, example = false }) {
  const id = `mk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return {
    kind: MARK, id, ts: Date.now(), actor,
    step, what: String(what || '').slice(0, 200),
    ...(ref ? { ref: String(ref).slice(0, 120) } : {}),
    ...(ref && refKind ? { refKind } : {}),
    ...(data ? { data } : {}),
    ...(example ? { example: true } : {}),
  }
}

/*
 * 조사를 앞말에 맞춰 붙입니다.
 *
 * 예전에는 「상태를 승인 로 옮겼습니다」·「구도 「전신」를 만들었습니다」였습니다. 이름과
 * 상태 이름이 데이터라서 받침이 그때그때 다른데 조사를 글자로 박아 두었기 때문입니다.
 * 편집 기록은 이 화면에서 가장 여러 번 읽는 글이라 여기서 어긋나면 계속 눈에 걸립니다.
 */
const wa = (s) => `${s}${josa(s, '을', '를')}`
const ro = (s) => `${s}${josa(s, '으로', '로')}`

/*
 * op 한 건 → 사람이 읽는 한 줄.
 *
 * 여기 없는 kind 는 null 을 돌려주고 목록에서 빠집니다. 일부러입니다. 프레즌스나
 * 읽음 표시처럼 "한 일"이 아닌 것을 히스토리에 섞으면 목록이 금방 쓸모없어집니다.
 *
 * refKind 는 ref 가 무엇을 가리키는지입니다. 「이어서 하기」가 갈 곳을 정하는 데
 * 씁니다. panel 이면 보드가 #cut= 으로 그 패널을 열 수 있지만, ep 나 scene 은
 * 패널이 아니라서 그렇게 보내면 없는 패널을 찾다가 엉뚱한 화면에 도착합니다.
 */
const SAY = {
  [MARK]: (op) => ({ step: op.step, what: op.what, ref: op.ref || null, refKind: op.refKind || null }),

  'board.patch': (op) => {
    const f = op.fields || {}
    if (f.title) return { step: 'board', what: `보드 제목을 ${ro(`「${f.title}」`)} 두었습니다` }
    if (f.scenario) return { step: 'board', what: '시나리오를 넣었습니다' }
    return null
  },

  'char.add': (op) => ({
    step: 'board', what: `인물 ${wa(`「${op.char?.name || op.char?.id}」`)} 만들었습니다`,
    ref: op.char?.id, refKind: 'char',
  }),

  'panel.add': (op) => {
    const p = op.panel || {}
    // 키비주얼이 붙인 것은 그 화면에서 한 일이다. 보드에서 만든 컷과 구분한다
    if (p.keyVisual) return { step: 'keyvisual', what: `${p.scene || '씬'} 키 비주얼을 보드에 붙였습니다`, ref: p.id, refKind: 'panel' }
    if (p.charId) return { step: 'board', what: `구도 ${wa(`「${p.pose || p.id}」`)} 만들었습니다`, ref: p.id, refKind: 'panel' }
    return { step: 'board', what: `컷을 만들었습니다${p.scene ? ` (${p.scene})` : ''}`, ref: p.id, refKind: 'panel' }
  },

  /*
   * 한 kind 에 세 가지 일이 섞여 있습니다. 키비주얼이 생성한 그림, 사람이 올린 그림,
   * 그리고 승인된 컷으로 만든 영상입니다(pages/board.js 의 animate). 영상은 우리 GPU 로
   * 만든 것('video')과 없어진 영상화 화면이 바깥 MCP 서버로 만들던 것('mcp') 둘 다 같은
   * 한 줄로 읽습니다 — 옛 판에는 그 줄이 남아 있습니다. 히스토리를
   * 보는 사람에게 중요한 것은 「컷이 영상이 되었다」이고, 어디서 만들었는지는 그 버전을
   * 열어 보면 적혀 있습니다. 영상은 보드에서 한 일로 셉니다 — 컷이 있어야 만들 수 있고,
   * 결과가 그 컷의 다음 버전으로 붙기 때문입니다.
   */
  'panel.version': (op) => {
    const src = op.version?.source
    if (src === 'video' || src === 'mcp') {
      return { step: 'board', what: '컷을 영상으로 만들었습니다', ref: op.panelId, refKind: 'panel' }
    }
    return {
      step: src === 'ai' ? 'keyvisual' : 'board',
      what: src === 'ai' ? '그림을 생성했습니다' : '그림을 올렸습니다',
      ref: op.panelId, refKind: 'panel',
    }
  },

  'panel.status': (op) => ({
    step: 'board', what: `상태를 ${ro(STATUS_KO[op.to] || op.to)} 옮겼습니다`,
    ref: op.panelId, refKind: 'panel',
  }),

  'comment.add': (op) => ({
    step: 'board', what: `의견을 남겼습니다. ${short(op.comment?.body)}`,
    ref: op.comment?.panelId, refKind: 'panel',
  }),

  'ep.add': (op) => ({
    step: 'board', what: `회차 ${wa(`「${op.ep?.title || op.ep?.id}」`)} 만들었습니다`,
    ref: op.ep?.id, refKind: 'ep',
  }),
}

const STATUS_KO = {
  draft: '초안', in_progress: '작업 중', in_review: '리뷰 중',
  changes_requested: '수정 요청', approved: '승인',
}

const short = (s, n = 40) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * op 하나를 히스토리 한 줄로 옮깁니다. 히스토리에 넣지 않을 op 면 null.
 *
 * @param {object} op
 * @param {(id: string) => object|null} [who] - actor id → {name, role}. 없으면 id 를 그대로 씁니다
 * @returns {{id, ts, actor, name, step, stepLabel, what, ref, refKind, data, example}|null}
 */
export function toEntry(op, who) {
  if (!op?.kind || !op.id) return null
  const say = SAY[op.kind]?.(op)
  if (!say) return null
  const p = who?.(op.actor) || null
  return {
    id: op.id,
    ts: Number(op.ts) || 0,
    actor: op.actor,
    name: p?.name || op.actor || '알 수 없음',
    step: say.step,
    stepLabel: navTab(say.step)?.label || say.step,
    what: say.what,
    ref: say.ref ?? null,
    refKind: say.refKind ?? null,
    data: op.data ?? null,
    // seed 는 예전 예시 데이터의 표시입니다. 예시 재생기가 남기는 것은 example 입니다
    example: !!(op.example || op.seed),
  }
}

/**
 * op 목록 → 히스토리. 최신이 앞입니다.
 *
 * @param {Array} ops
 * @param {object} o
 * @param {Function} [o.who] - actor id → {name}
 * @param {string} [o.step] - 이 단계만
 * @param {string} [o.actor] - 이 사람만. 「내가 등록한 목록」이 이걸 씁니다
 * @param {boolean} [o.example] - true 면 예시 줄만, false 면 예시를 뺍니다. 기본은 다 넣습니다
 * @param {number} [o.limit]
 * @returns {Array}
 */
export function entries(ops, { who, step, actor, example, limit = 60 } = {}) {
  const out = []
  for (const op of ops || []) {
    const e = toEntry(op, who)
    if (!e) continue
    if (step && e.step !== step) continue
    if (actor && e.actor !== actor) continue
    if (example === true && !e.example) continue
    if (example === false && e.example) continue
    out.push(e)
  }
  out.sort((a, b) => b.ts - a.ts)
  return out.slice(0, limit)
}

/**
 * 같은 사람이 같은 단계에서 잇달아 한 일을 한 덩어리로 묶습니다.
 *
 * 묶지 않으면 컷 9개를 만든 것이 9줄이 되어 목록이 그것만으로 찹니다. 「이어서 하기」는
 * 덩어리의 가장 최근 ref 를 씁니다. 그게 그 사람이 마지막으로 손댄 자리입니다.
 *
 * @param {Array} list - entries() 의 결과 (최신이 앞)
 * @param {number} [gapMs] - 이만큼 안에 이어진 것만 묶습니다
 * @returns {Array<{key, ts, actor, name, step, stepLabel, what, n, ref, refKind, data, example}>}
 */
export function group(list, gapMs = 6 * 60_000) {
  const out = []
  for (const e of list || []) {
    const last = out.at(-1)
    const same = last && last.actor === e.actor && last.step === e.step
      && last.example === e.example && last.ts - e.ts <= gapMs
    if (same) {
      last.n++
      // 덩어리에 적는 일과 시각은 가장 최근 것입니다. 목록이 최신 순이라 덩어리의
      // 첫 줄이 그것이고, 뒤에 붙는 것은 더 오래된 같은 종류입니다
      last.what = `${last.first} 외 ${last.n - 1}건`
      if (last.ref == null) { last.ref = e.ref; last.refKind = e.refKind }
      continue
    }
    out.push({ ...e, key: e.id, first: e.what, n: 1 })
  }
  return out
}
