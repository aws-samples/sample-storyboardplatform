/*
 * 히스토리 — 누가 · 어떤 단계에서 · 뭘 · 언제 했는지.
 *
 * 사실은 한 곳에 있습니다. 보드의 op 로그(DynamoDB, AppSync 의 listOps)입니다.
 * 그 로그를 세 화면이 다 남기고 다 읽습니다.
 *
 *   보드      panel.add · panel.status · comment.add …   원래부터 남기던 것
 *   키비주얼  panel.add(keyVisual) · panel.version       원래부터 남기던 것
 *   디벨롭    step.mark                                  이 파일이 새로 정한 것
 *
 * 새 종류를 만들지 않고 step.mark 하나만 더한 이유는, 로그를 읽는 쪽(demo/app.js 의
 * applyOp)이 모르는 kind 를 만나도 그냥 지나가게 되어 있어서입니다. 즉 디벨롭이
 * 남긴 줄이 보드의 판을 흔들지 않습니다. 반대로 이 파일은 모든 kind 를 사람이 읽는
 * 한 줄로 옮깁니다 — 그래서 보드에서 한 일도 홈에서 같이 보입니다.
 *
 * 화면이 사실을 따로 쌓지 않는 것이 중요합니다. 화면마다 자기 localStorage 에 목록을
 * 들고 있으면 다른 사람 브라우저에서는 비어 있고, "누가 뭘 했는지"가 애초에 성립하지
 * 않습니다. 그래서 이 파일에는 저장소가 없습니다. op 를 받아 줄로 옮기는 것만 합니다.
 */

import { navTab } from './nav-tabs.js'

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
 * @param {object} [o.data] - 이어서 할 때 되살릴 값. 작게 둡니다 — 로그는 대본 보관소가 아닙니다
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
 * op 한 건 → 사람이 읽는 한 줄.
 *
 * 여기 없는 kind 는 null 을 돌려주고 목록에서 빠집니다. 일부러입니다 — 프레즌스나
 * 읽음 표시처럼 "한 일"이 아닌 것을 히스토리에 섞으면 목록이 금방 쓸모없어집니다.
 *
 * refKind 는 ref 가 무엇을 가리키는지입니다. 「이어서 하기」가 갈 곳을 정하는 데
 * 씁니다 — panel 이면 보드가 #cut= 으로 그 패널을 열 수 있지만, ep 나 scene 은
 * 패널이 아니라서 그렇게 보내면 없는 패널을 찾다가 엉뚱한 화면에 도착합니다.
 */
const SAY = {
  [MARK]: (op) => ({ step: op.step, what: op.what, ref: op.ref || null, refKind: op.refKind || null }),

  'board.patch': (op) => {
    const f = op.fields || {}
    if (f.title) return { step: 'board', what: `보드 제목을 「${f.title}」로 두었습니다` }
    if (f.scenario) return { step: 'board', what: '시나리오를 넣었습니다' }
    return null
  },

  'char.add': (op) => ({
    step: 'board', what: `인물 「${op.char?.name || op.char?.id}」을 만들었습니다`,
    ref: op.char?.id, refKind: 'char',
  }),

  'panel.add': (op) => {
    const p = op.panel || {}
    // 키비주얼이 붙인 것은 그 화면에서 한 일이다. 보드에서 만든 컷과 구분한다
    if (p.keyVisual) return { step: 'keyvisual', what: `${p.scene || '씬'} 키 비주얼을 보드에 붙였습니다`, ref: p.id, refKind: 'panel' }
    if (p.charId) return { step: 'board', what: `구도 「${p.pose || p.id}」를 만들었습니다`, ref: p.id, refKind: 'panel' }
    return { step: 'board', what: `컷을 만들었습니다${p.scene ? ` (${p.scene})` : ''}`, ref: p.id, refKind: 'panel' }
  },

  'panel.version': (op) => ({
    step: op.version?.source === 'ai' ? 'keyvisual' : 'board',
    what: op.version?.source === 'ai' ? '그림을 생성했습니다' : '그림을 올렸습니다',
    ref: op.panelId, refKind: 'panel',
  }),

  'panel.status': (op) => ({
    step: 'board', what: `상태를 ${STATUS_KO[op.to] || op.to} 로 옮겼습니다`,
    ref: op.panelId, refKind: 'panel',
  }),

  'comment.add': (op) => ({
    step: 'board', what: `의견을 남겼습니다 — ${short(op.comment?.body)}`,
    ref: op.comment?.panelId, refKind: 'panel',
  }),

  'ep.add': (op) => ({
    step: 'board', what: `회차 「${op.ep?.title || op.ep?.id}」를 만들었습니다`,
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
 * 덩어리의 가장 최근 ref 를 씁니다 — 그게 그 사람이 마지막으로 손댄 자리입니다.
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

/** 사람이 읽는 시각. 오늘이면 시:분, 아니면 월/일 */
export function when(ts, nowMs = Date.now()) {
  const d = new Date(Number(ts) || 0)
  if (!Number.isFinite(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  const today = new Date(nowMs)
  const sameDay = d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`
}

/* ══ 그리기 ════════════════════════════════════════ */

/*
 * 목록의 모양도 이 파일이 들고 있습니다. 홈과 세 화면이 같은 목록을 보여주는데
 * 화면마다 CSS 를 베껴 두면 한 곳만 고쳐도 나머지가 어긋납니다 — nav-tabs.js 와
 * coach.js 가 같은 방식입니다.
 */
const CSS = `
.hist { display: grid; gap: 1px; background: var(--sb-line-2, #f1f3f6);
  border-radius: var(--sb-r, 6px); overflow: hidden; font-family: var(--sb-sans, sans-serif); }
.hist__row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 10px;
  align-items: center; padding: 9px 11px; background: var(--sb-panel, #fff);
  text-align: left; border: 0; font: inherit; color: var(--sb-ink, #111318); width: 100%;
}
button.hist__row { cursor: pointer; }
button.hist__row:hover { background: var(--sb-fill, #f8f9fb); }
.hist__step {
  font: 500 10.5px/1 var(--sb-mono, monospace); color: var(--sb-accent, #1a56db);
  background: var(--sb-accent-soft, #eef2ff); padding: 4px 7px; border-radius: 4px; white-space: nowrap;
}
.hist__mid { min-width: 0; display: grid; gap: 1px; }
.hist__what {
  font-size: 12.5px; line-height: 1.45; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hist__who { font-size: 11px; color: var(--sb-ink-3, #767f8c); }
.hist__who b { font-weight: 600; color: var(--sb-ink-2, #5b6472); }
.hist__ex {
  font: 500 10px/1 var(--sb-mono, monospace); color: var(--sb-ink-3, #767f8c);
  border: 1px solid var(--sb-line, #e4e7ec); padding: 3px 6px; border-radius: 4px; white-space: nowrap;
}
.hist__t { font: 400 11px var(--sb-mono, monospace); color: var(--sb-ink-3, #767f8c); white-space: nowrap; }
.hist__none {
  padding: 14px 12px; background: var(--sb-panel, #fff); font-size: 12.5px;
  color: var(--sb-ink-3, #767f8c); line-height: 1.6;
}
`

let styled = false
function injectCss(doc) {
  if (styled) return
  styled = true
  const el = doc.createElement('style')
  el.id = 'histCss'
  el.textContent = CSS
  doc.head.appendChild(el)
}

const mk = (t, c, x) => {
  const n = document.createElement(t)
  if (c) n.className = c
  if (x != null) n.textContent = x
  return n
}

/**
 * 히스토리 목록을 그립니다.
 *
 * onPick 을 주면 각 줄이 버튼이 됩니다 — 「필요한 경우 그걸 선택해 이어서」 하는 자리
 * 입니다. 주지 않으면 읽기만 하는 목록입니다. 이어서 갈 수 없는 줄(ref 가 없는 것)은
 * onPick 이 있어도 버튼으로 만들지 않습니다. 눌러도 아무 일 없는 버튼을 두지 않습니다.
 *
 * @param {HTMLElement} mount
 * @param {Array} list - group() 이나 entries() 의 결과
 * @param {object} o
 * @param {(e: object) => void} [o.onPick]
 * @param {string} [o.none] - 비었을 때의 한 줄
 * @param {boolean} [o.showStep] - 단계 이름을 붙입니다. 한 화면 안의 목록에서는 껍니다
 * @param {number} [o.nowMs]
 */
export function paintList(mount, list, { onPick, none = '아직 기록이 없습니다.', showStep = true, nowMs } = {}) {
  if (!mount) return
  injectCss(mount.ownerDocument || document)
  mount.textContent = ''
  mount.className = 'hist'
  if (!list?.length) {
    mount.append(mk('div', 'hist__none', none))
    return
  }
  for (const e of list) {
    const go = onPick && e.ref != null
    const row = mk(go ? 'button' : 'div', 'hist__row')
    if (go) {
      row.type = 'button'
      row.title = '여기서 이어서 합니다'
      row.onclick = () => onPick(e)
    }
    row.append(showStep ? mk('span', 'hist__step', e.stepLabel) : mk('span'))
    const mid = mk('div', 'hist__mid')
    mid.append(mk('div', 'hist__what', e.what))
    const who = mk('div', 'hist__who')
    who.append(mk('b', null, e.name))
    who.append(document.createTextNode(e.ref ? ` · ${e.ref}` : ''))
    mid.append(who)
    row.append(mid)
    row.append(e.example ? mk('span', 'hist__ex', '예시') : mk('span'))
    row.append(mk('span', 'hist__t', when(e.ts, nowMs)))
    mount.append(row)
  }
}
