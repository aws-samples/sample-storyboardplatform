/*
 * 프로젝트 보드 · 작업판을 열기 전에 먼저 뜨는 화면입니다.
 *
 * 네 화면은 모두 「지금 보고 있는 보드 하나」를 전제로 돌아갑니다. 그 보드가 무엇인지는
 * 주소의 ?board= 이 정하고, 없으면 기본 보드로 떨어졌습니다. 그래서 누가 들어와도 늘
 * 같은 한 판을 보게 되고, 어제 다른 팀이 만든 대본이나 키비주얼은 화면 어디에도
 * 없었습니다. 이 파일이 그 앞에 한 겹을 둡니다.
 *
 * 카드에 적히는 것: 프로젝트 이름 · 마지막에 손댄 사람 · 그 사람이 한 일 · 언제.
 * 그 값을 읽어 오는 곳은 services/projects.js 입니다.
 */

import { navHref, boardParam, DEFAULT_BOARD, navTab, wantsNew } from '../domain/routes.js'
import { when } from './history-list.js'
import { DEMO_USERS } from './login-form.js'
import { newBoardId, touch, list } from '../services/projects.js'

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* ══ 그리기 ════════════════════════════════════════ */

/*
 * 모양도 이 파일이 들고 있습니다. nav-tabs.js · history.js · coach.js 와 같은 방식
 * 입니다. 네 화면이 같은 보드를 보는데 화면마다 CSS 를 베껴 두면 한 곳만 고쳐도
 * 나머지가 어긋납니다. 색은 공통 토큰(app/theme.css 의 --sb-*)에서 받고, 두 번째
 * 인자는 그 파일을 못 불러왔을 때의 기본값입니다.
 */
const CSS = `
.pjwrap {
  position: fixed; inset: 0; z-index: 60; overflow: auto;
  display: flex; align-items: flex-start; justify-content: center;
  padding: 40px 20px; background: var(--sb-bg, #f4f5f7);
  font-family: var(--sb-sans, sans-serif); color: var(--sb-ink, #111318);
}
.pj {
  /* 카드가 두 열로 서므로 문도 그만큼 넓힙니다. 620px 에서는 두 열이 너무 좁습니다 */
  width: 100%; max-width: 680px; background: var(--sb-panel, #fff);
  border: 1px solid var(--sb-line, #e4e7ec); border-radius: var(--sb-r, 6px);
  padding: 22px 22px 18px;
}
.pj__eyebrow {
  font: 500 11px/1 var(--sb-mono, monospace); letter-spacing: .08em; text-transform: uppercase;
  color: var(--sb-accent, #1a56db); margin-bottom: 9px;
}
.pj__h { margin: 0 0 7px; font-size: 20px; font-weight: 650; letter-spacing: -.015em; }
.pj__p { margin: 0 0 16px; font-size: 12.5px; line-height: 1.65; color: var(--sb-ink-2, #5b6472); }
/*
 * 두 열로 셉니다. 한 열로 길게 늘어놓으면 판이 열 개만 넘어도 아래가 접히고, 세 열로
 * 쪼개면 카드 하나의 폭이 프로젝트 이름을 담지 못합니다. 좁은 화면에서는 한 열입니다.
 */
.pj__list { display: grid; gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 620px) { .pj__list { grid-template-columns: minmax(0, 1fr); } }
/*
 * 카드 한 장의 자리입니다. 카드와 「⋮」 버튼이 여기 나란히 섭니다.
 *
 * 겹을 하나 더 두는 까닭은 「⋮」를 카드 버튼 안에 넣을 수 없기 때문입니다. 카드 자체가
 * button 이라서 그 안에 버튼을 또 두면 화면 낭독기가 무엇을 누른 것인지 말하지 못하고,
 * 브라우저마다 안쪽 버튼의 클릭이 바깥으로 새기도 합니다(그러면 메뉴를 열려다 판이
 * 열립니다). 그래서 형제로 둡니다. 아래 .pj__card 의 여백이 「⋮」 자리만큼 비어 있는
 * 것도 이 때문입니다 — 이름이 길면 글자가 「⋮」 밑으로 들어갑니다.
 */
.pj__slot { position: relative; display: grid; }
.pj__card {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px 10px;
  align-content: start; width: 100%; padding: 13px; text-align: left;
  background: var(--sb-panel, #fff); font: inherit; color: var(--sb-ink, #111318);
  border: 1px solid var(--sb-line, #e4e7ec); border-radius: 9px;
}
button.pj__card { cursor: pointer; }
button.pj__card:hover { border-color: var(--sb-accent, #1a56db); background: var(--sb-accent-soft, #eef2ff); }
button.pj__card:hover .pj__open { color: var(--sb-accent, #1a56db); }
.pj__card:focus-visible { outline: 2px solid var(--sb-accent, #1a56db); outline-offset: 1px; }
.pj__card[aria-current="true"] { border-color: var(--sb-accent, #1a56db); background: var(--sb-accent-soft, #eef2ff); }
/* 이름 첫 글자. 카드가 두 열로 서면 이름을 읽기 전에 어느 판인지 눈에 걸립니다 */
.pj__mark {
  grid-row: 1; display: grid; place-items: center; width: 26px; height: 26px; flex: none;
  border-radius: 7px; background: var(--sb-accent-soft, #eef2ff);
  border: 1px solid var(--sb-accent-line, #c7d6f7);
  font-size: 12px; font-weight: 700; color: var(--sb-accent, #1a56db);
}
.pj__name { grid-row: 1; align-self: center; font-size: 14px; font-weight: 650; letter-spacing: -.01em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pj__open { grid-row: 1; align-self: center; font-size: 13px; color: var(--sb-ink-3, #767f8c); }
.pj__last { grid-column: 1 / -1; margin: 3px 0 1px; font-size: 12px; line-height: 1.5;
  color: var(--sb-ink-2, #5b6472); overflow: hidden;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.pj__last i { font-style: normal; color: var(--sb-ink-3, #767f8c); }
/*
 * 「누가」와 「언제」는 테를 둘러 따로 세웁니다. 한 줄의 글로 흘려 두면 이름·한 일·
 * 시각이 한 문장으로 뭉쳐 읽는 사람이 어디까지가 사람 이름인지 짚어야 합니다.
 * 누르는 것은 카드 하나이므로 이 조각들은 span 입니다. 버튼 안의 버튼이 되면
 * 무엇을 누른 것인지 화면 낭독기가 말할 수 없습니다.
 */
.pj__meta { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 5px; }
.pj__chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px;
  border: 1px solid var(--sb-line, #e4e7ec); border-radius: 999px;
  background: var(--sb-fill, #f8f9fb); font-size: 11px; line-height: 1.4;
  color: var(--sb-ink-2, #5b6472); white-space: nowrap; max-width: 100%;
}
.pj__chip b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.pj__chip::before { content: attr(data-ico); flex: none; color: var(--sb-ink-3, #767f8c); }
.pj__t { font-family: var(--sb-mono, monospace); font-size: 10.5px; }
/*
 * 「⋮」. 카드 오른쪽 위에 앉습니다.
 *
 * 평소에는 흐리게 두고 카드에 마우스를 올리거나 초점이 잡히면 진해집니다. 늘 진하면
 * 카드마다 점 셋이 두 열로 늘어서서, 정작 봐야 할 프로젝트 이름보다 먼저 눈에 걸립니다.
 * 다만 아예 숨기지는 않습니다 — 마우스가 없는 화면에서는 올릴 수가 없습니다.
 */
.pj__more {
  position: absolute; top: 7px; right: 7px; z-index: 1;
  width: 24px; height: 24px; display: grid; place-items: center; padding: 0;
  font: inherit; font-size: 15px; line-height: 1; cursor: pointer;
  background: none; border: 1px solid transparent; border-radius: var(--sb-r, 6px);
  color: var(--sb-ink-3, #767f8c);
}
.pj__slot:hover .pj__more, .pj__more:focus-visible, .pj__more[aria-expanded="true"] {
  color: var(--sb-ink, #111318); border-color: var(--sb-line, #e4e7ec);
  background: var(--sb-panel, #fff);
}
.pj__more:focus-visible { outline: 2px solid var(--sb-accent, #1a56db); outline-offset: 1px; }
/*
 * 「⋮」 자리를 비워 둡니다. 이름이 길면 글자가 그 밑으로 들어갑니다.
 * 메뉴가 없는 카드(각 화면 앞의 문)는 그대로 두어야 하므로 .pj__slot 안에서만 좁힙니다.
 */
.pj__slot .pj__card { padding-right: 36px; }
.pj__menu {
  position: absolute; top: 33px; right: 7px; z-index: 2; min-width: 150px;
  display: grid; padding: 4px; background: var(--sb-panel, #fff);
  border: 1px solid var(--sb-line, #e4e7ec); border-radius: var(--sb-r, 6px);
  box-shadow: var(--sb-sh-lg, 0 12px 34px -10px rgba(17,19,24,.22));
}
.pj__mi {
  padding: 8px 10px; text-align: left; font: inherit; font-size: 12.5px; cursor: pointer;
  background: none; border: 0; border-radius: 4px; color: var(--sb-ink, #111318);
  white-space: nowrap;
}
.pj__mi:hover { background: var(--sb-fill, #f8f9fb); }
.pj__mi:focus-visible { outline: 2px solid var(--sb-accent, #1a56db); outline-offset: -2px; }
/* 되돌릴 수 없는 줄. 지우기가 이것을 씁니다 */
.pj__mi--no { color: var(--sb-no, #b42318); }
.pj__mi--no:hover { background: var(--sb-no-soft, #fef3f2); }
/*
 * 막힌 줄. 흐리게 두고 커서를 바꿉니다.
 *
 * 숨기지 않습니다. 숨기면 사람은 이 기능이 없는 줄로 알고 찾아다니고, 감독에게 부탁할
 * 일이라는 것도 모릅니다. project.js 의 paintDanger 가 같은 판단을 합니다. 왜 막혔는지는
 * title 로 답니다.
 */
.pj__mi:disabled { color: var(--sb-ink-3, #767f8c); cursor: default; background: none; }
.pj__none { grid-column: 1 / -1; padding: 15px 13px; background: var(--sb-panel, #fff);
  border: 1px dashed var(--sb-line, #e4e7ec); border-radius: 9px;
  font-size: 12.5px; line-height: 1.6; color: var(--sb-ink-3, #767f8c); }
.pj__new { display: flex; gap: 7px; margin-top: 14px; flex-wrap: wrap; }
.pj__in {
  flex: 1 1 200px; min-width: 0; padding: 9px 11px; font: inherit; font-size: 13px;
  border: 1px solid var(--sb-line, #e4e7ec); border-radius: var(--sb-r, 6px);
  background: var(--sb-panel, #fff); color: var(--sb-ink, #111318);
}
.pj__in:focus { outline: 2px solid var(--sb-accent, #1a56db); outline-offset: -1px; }
.pj__go, .pj__skip {
  padding: 9px 14px; font: inherit; font-size: 13px; font-weight: 500;
  border-radius: var(--sb-r, 6px); cursor: pointer;
}
.pj__go { background: var(--sb-accent, #1a56db); border: 1px solid var(--sb-accent, #1a56db); color: #fff; }
.pj__go:disabled { opacity: .45; cursor: default; }
.pj__skip { background: none; border: 1px solid var(--sb-line, #e4e7ec); color: var(--sb-ink-2, #5b6472); }
.pj__skip:hover { color: var(--sb-accent, #1a56db); border-color: var(--sb-accent, #1a56db); }
.pj__note { margin: 13px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--sb-ink-3, #767f8c); }
`

let styled = false
function injectCss(doc) {
  if (styled) return
  styled = true
  const el = doc.createElement('style')
  el.id = 'projectsCss'
  el.textContent = CSS
  doc.head.appendChild(el)
}

/** actor id → 이름. 명부를 못 받으면 데모 계정, 그것도 없으면 id 를 그대로 씁니다 */
const nameOf = (id, who) => who?.(id)?.name || DEMO_USERS.find((u) => u.id === id)?.name || id || '알 수 없음'

/* ══ 카드의 「⋮」 메뉴 ═════════════════════════════ */

/*
 * 지금 열려 있는 메뉴. 한 번에 하나만 엽니다.
 *
 * 카드가 열두 장 깔린 화면에서 메뉴 셋이 겹쳐 떠 있으면 어느 것이 어느 판의 것인지
 * 알 수 없습니다. 모듈 바깥에 두는 이유는 다른 카드의 「⋮」를 눌러 여는 길이 이 값을
 * 봐야 앞의 것을 닫을 수 있기 때문입니다.
 */
let openMenu = null

/** 열려 있는 메뉴를 닫습니다. 여러 번 불러도 됩니다 */
function shutMenu() {
  if (!openMenu) return
  const { box, trigger, off } = openMenu
  // 먼저 비웁니다. off 안의 리스너가 이 함수를 다시 부를 수 있습니다
  openMenu = null
  off?.()
  box.remove()
  trigger.setAttribute('aria-expanded', 'false')
}

/**
 * 카드 하나의 메뉴를 엽니다.
 *
 * 메뉴 자체는 열 때 만들고 닫을 때 버립니다. 카드마다 미리 붙여 두면 프로젝트 스무
 * 개에 안 보이는 버튼이 예순 개 서고, 화면 낭독기는 그것을 다 읽습니다.
 *
 * @param {HTMLElement} slot - 카드가 든 자리(.pj__slot)
 * @param {HTMLElement} trigger - 「⋮」 버튼
 * @param {Array} items - {label, on, danger, disabled, why}
 */
function popMenu(slot, trigger, items) {
  // 같은 「⋮」를 다시 누르면 닫습니다. 열고 닫는 것이 한 버튼이어야 합니다
  const again = openMenu?.trigger === trigger
  shutMenu()
  if (again) return

  const doc = slot.ownerDocument
  const box = doc.createElement('div')
  box.className = 'pj__menu'
  box.setAttribute('role', 'menu')
  for (const it of items) {
    const b = doc.createElement('button')
    b.type = 'button'
    b.className = `pj__mi${it.danger ? ' pj__mi--no' : ''}`
    b.setAttribute('role', 'menuitem')
    b.textContent = it.label
    if (it.disabled) {
      b.disabled = true
      // 왜 막혔는지. 이것이 없으면 흐린 줄만 보고 고장 난 것으로 읽힙니다
      if (it.why) b.title = it.why
    } else {
      b.onclick = () => { shutMenu(); it.on?.() }
    }
    box.append(b)
  }
  slot.append(box)
  trigger.setAttribute('aria-expanded', 'true')
  openMenu = { box, trigger }

  /*
   * 첫 줄에 초점을 둡니다. 키보드로 「⋮」에 와서 엔터를 누른 사람은 다음 탭이 메뉴
   * 안쪽으로 들어가기를 기대합니다. 막힌 줄은 초점을 받지 않으므로 건너뜁니다.
   */
  box.querySelector('.pj__mi:not(:disabled)')?.focus()

  /*
   * 바깥을 누르거나 Esc 를 누르면 닫습니다. 창을 세우지 않는 메뉴라서 배경을 덮는
   * 것이 없고, 문서 쪽에서 받아야 합니다.
   *
   * 리스너를 걷는 길(off)을 openMenu 에 같이 담습니다. once 로 걸면 메뉴 안쪽을 누른
   * 클릭에도 소진되어 두 번째 바깥 클릭이 듣지 않고, 그때부터 이 메뉴는 닫히지 않습니다.
   *
   * 여는 자리에서 곧바로 걸어 둡니다. 미루지 않는 이유는 메뉴를 여는 클릭에서 이미
   * stopPropagation 을 했기 때문입니다 — 그 클릭은 여기까지 올라오지 않습니다.
   */
  const onDocClick = (e) => {
    if (!box.contains(e.target) && e.target !== trigger) shutMenu()
  }
  const onKey = (e) => {
    if (e.key !== 'Escape') return
    shutMenu()
    // 초점을 「⋮」로 되돌립니다. 메뉴가 사라진 자리에 초점이 남으면 탭이 처음으로 갑니다
    trigger.focus()
  }
  doc.addEventListener('click', onDocClick, true)
  doc.addEventListener('keydown', onKey)
  openMenu.off = () => {
    doc.removeEventListener('click', onDocClick, true)
    doc.removeEventListener('keydown', onKey)
  }
}

/**
 * 카드 목록을 그립니다. 프로젝트 보드와 홈이 같은 모양을 씁니다.
 *
 * @param {HTMLElement} mount
 * @param {Array} rows - list() 의 결과
 * @param {object} o
 * @param {(row: object) => void} [o.onPick] - 없으면 읽기만 하는 목록입니다
 * @param {string} [o.current] - 지금 보고 있는 보드. 그 카드에 표시를 답니다
 * @param {Function} [o.who] - actor id → {name}
 * @param {string} [o.none] - 비었을 때의 한 줄
 * @param {number} [o.nowMs]
 * @param {(row: object) => Array} [o.menu] - 카드마다 「⋮」 메뉴에 세울 줄들.
 *        {label, on, danger, disabled, why} 의 배열입니다. 빈 배열을 주면 「⋮」를 달지
 *        않습니다. 아예 주지 않으면 카드는 예전 그대로입니다
 */
export function paintCards(mount, rows, {
  onPick, current, who, none = '아직 프로젝트가 없습니다.', nowMs, menu,
} = {}) {
  if (!mount) return
  injectCss(mount.ownerDocument || document)
  // 다시 그리면 앞의 카드가 사라집니다. 그 카드에 걸려 있던 메뉴도 같이 접습니다
  shutMenu()
  mount.textContent = ''
  mount.className = 'pj__list'
  if (!rows?.length) {
    const p = mount.ownerDocument.createElement('div')
    p.className = 'pj__none'
    p.textContent = none
    mount.append(p)
    return
  }
  for (const r of rows) {
    const doc = mount.ownerDocument
    const el = doc.createElement(onPick ? 'button' : 'div')
    el.className = 'pj__card'
    el.dataset.board = r.boardId
    if (onPick) {
      el.type = 'button'
      el.onclick = () => onPick(r)
    }
    if (current && r.boardId === current) el.setAttribute('aria-current', 'true')
    const name = r.name || r.boardId
    /*
     * 카드의 날짜는 「Sep 7」입니다. 목록·표의 「9/7」과 다릅니다.
     *
     * 카드는 한 장씩 따로 서서 옆에 견줄 줄이 없습니다. 「9/7」만 놓고는 9월 7일인지
     * 7월 9일인지 짚어 줄 것이 화면에 없습니다. 표는 여러 줄이 세로로 늘어서 숫자끼리
     * 자리가 맞는 편이 훑기 좋아서 그대로 둡니다(components/history-list.js 의 when).
     */
    const at = when(r.updatedAt, nowMs, 'name')
    /*
     * 한 일은 카드 본문에, 「누가」와 「언제」는 아래 테 두른 조각에 담습니다. 아직 아무
     * 일도 없는 판에는 사람 조각을 달지 않습니다. 없는 사실을 「알 수 없음」으로 적으면
     * 이름을 못 읽은 것처럼 보입니다.
     */
    const chips = [
      r.lastActor ? `<span class="pj__chip" data-ico="◍"><b>${esc(nameOf(r.lastActor, who))}</b></span>` : '',
      at ? `<span class="pj__chip pj__t" data-ico="◷">${esc(at)}</span>` : '',
    ].filter(Boolean).join('')
    el.innerHTML = `<span class="pj__mark" aria-hidden="true">${esc([...name][0] || '·')}</span>
      <span class="pj__name">${esc(name)}</span>
      <span class="pj__open" aria-hidden="true">${onPick ? '→' : ''}</span>
      <span class="pj__last">${r.lastWhat ? esc(r.lastWhat) : '<i>아직 아무 일도 없습니다</i>'}</span>
      <span class="pj__meta">${chips}</span>`

    /*
     * 메뉴를 달지 않으면 카드를 그대로 붙입니다. 겹을 하나 더 두지 않는 이유는 이
     * 함수를 쓰는 자리가 셋이고(홈 · 각 화면 앞의 문 · 검사) 그중 둘은 메뉴가 필요
     * 없기 때문입니다. 필요 없는 곳에 빈 겹을 남기면 격자가 한 칸씩 밀립니다.
     */
    const items = menu?.(r) || []
    if (!items.length) { mount.append(el); continue }

    const slot = doc.createElement('div')
    slot.className = 'pj__slot'
    slot.append(el)

    const more = doc.createElement('button')
    more.type = 'button'
    more.className = 'pj__more'
    more.setAttribute('aria-haspopup', 'menu')
    more.setAttribute('aria-expanded', 'false')
    // 「⋮」는 글자로만 있으면 낭독기가 「세로 생략 부호」로 읽습니다. 어느 판의 것인지도 답니다
    more.setAttribute('aria-label', `${name} 메뉴 열기`)
    more.title = `${name} 메뉴`
    more.textContent = '⋮'
    more.onclick = (ev) => {
      // 카드가 버튼입니다. 여기서 막지 않으면 메뉴를 열려던 클릭이 판을 엽니다
      ev.stopPropagation()
      ev.preventDefault()
      popMenu(slot, more, items)
    }
    slot.append(more)
    mount.append(slot)
  }
}

/**
 * 프로젝트 보드를 띄우고 하나 고르게 합니다. 작업판 앞에 서는 문입니다.
 *
 * 주소에 ?board= 가 이미 있으면 아무것도 띄우지 않고 그 값을 그대로 돌려줍니다. * 카드를 눌러 들어온 사람이나 링크를 받은 사람에게 같은 문을 두 번 열지 않습니다.
 * 그래서 반환을 기다리는 것만으로 두 경우가 다 됩니다.
 *
 * 고르면 그 화면을 ?board= 로 다시 엽니다. 판을 열어 둔 채로 보드만 갈아 끼우지 않는
 * 이유는, 네 화면 모두 boot() 한 번에 보드 하나를 전제로 상태를 세우기 때문입니다
 * (net.connect 의 구독, 로그 재생, Neptune projectId). 새로 여는 편이 안전하고,
 * 무엇보다 주소에 지금 보는 프로젝트가 남아 공유할 수 있습니다.
 *
 * ══ 두 가지 문
 *
 * 홈의 「새로 생성」에서 온 것이면(?new=1) 이름 칸 하나만 냅니다. 예전에는 한 문이
 * 두 일을 다 했습니다. 이미 있는 판의 카드를 먼저 늘어놓고 그 아래에 이름 칸을 두는
 * 모양이었습니다. 그러면 「새로 생성」을 누른 사람에게 기존 판을 열라고 권하는 셈이고,
 * 실제로 그 카드를 눌러 이어서 할 판을 연 사람이 「처음 오셨나요?」를 만나는 자리도
 * 생겼습니다(그 화면은 비어 있는 판을 전제로 그 안내를 띄웁니다). 새로 만드는 길과
 * 이어서 하는 길은 홈에서 이미 갈라져 있으니, 문도 그대로 갈라 둡니다.
 *
 * @param {object} o
 * @param {string} o.step - NAV_TABS 의 id. 고른 뒤 돌아올 화면입니다
 * @param {string} [o.actor] - 새로 만든 카드의 만든 사람
 * @param {Function} [o.who] - actor id → {name}
 * @param {HTMLElement} [o.mount] - 문이 들어갈 자리. 없으면 body 에 붙입니다
 * @param {boolean} [o.fresh] - 새로 만드는 문. 기본은 주소의 ?new=1
 * @returns {Promise<string>} 고른 boardId. 고르기 전에는 해결되지 않습니다
 */
export function pickProject({ step = 'board', actor, who, mount, fresh = wantsNew() } = {}) {
  const chosen = boardParam()
  if (chosen) return Promise.resolve(chosen)

  const doc = document
  injectCss(doc)
  const wrap = doc.createElement('div')
  wrap.className = 'pjwrap'
  wrap.id = 'pjwrap'
  const box = doc.createElement('div')
  box.className = 'pj'
  box.innerHTML = `
    <div class="pj__eyebrow">${esc(navTab(step)?.label || '프로젝트')}</div>
    ${fresh ? `
    <h2 class="pj__h">새 프로젝트 이름을 붙여 주십시오</h2>
    <p class="pj__p">이 이름으로 판이 하나 열립니다. 대본도, 씬별 그림도, 컷도 그 안에 담기고
      팀원들의 작업 상황에도 이 이름으로 뜹니다.</p>` : `
    <h2 class="pj__h">어느 프로젝트를 여시겠습니까?</h2>
    <p class="pj__p">우리 팀이 여기까지 해 둔 것입니다. 카드를 누르면 그 판을 이어서 엽니다.</p>
    <div id="pjList" data-coach="projects"></div>`}
    <form class="pj__new" id="pjNew">
      <input class="pj__in" id="pjName" type="text" maxlength="60" autocomplete="off"
             placeholder="새 프로젝트 이름 · 예: 여름 스튜디오 파일럿" aria-label="새 프로젝트 이름">
      <button class="pj__go" id="pjMake" type="submit">만들어서 열기</button>
      ${fresh ? '' : '<button class="pj__skip" id="pjSkip" type="button">둘러보기</button>'}
    </form>
    <p class="pj__note" id="pjNote"></p>`
  wrap.append(box)
  ;(mount || doc.body).append(wrap)

  const q = (id) => box.querySelector(`#${id}`)
  const note = q('pjNote')

  const open = (boardId) => { location.href = navHref(step, boardId) }

  const paint = (rows) => paintCards(q('pjList'), rows, {
    who,
    onPick: (r) => open(r.boardId),
    none: '아직 만든 프로젝트가 없습니다. 아래에 이름을 적어 첫 판을 여십시오.',
  })

  /*
   * 새로 만드는 문에서는 목록을 아예 읽지 않습니다. 안 보여 줄 것을 읽는 것은 값을
   * 치르는 일이고(배포에서는 AppSync 왕복입니다), 커서를 이름 칸에 먼저 둡니다.
   */
  if (fresh) {
    note.textContent = '이름은 나중에 바꿀 수 없습니다. 팀이 서로 알아볼 만한 것으로 붙이십시오. '
      + '이미 있는 판을 이어서 하시려면 홈의 「프로젝트」에서 여십시오.'
    q('pjName').focus()
  } else {
    list().then((rows) => {
      paint(rows)
      note.textContent = rows.length
        ? `프로젝트 ${rows.length}개. 「둘러보기」는 이름을 붙이지 않은 기본 판을 엽니다.`
        : '이름은 나중에 바꿀 수 없습니다. 팀이 서로 알아볼 만한 것으로 붙이십시오.'
    }).catch((e) => {
      // 목록을 못 읽어도 새로 만드는 길은 살려 둡니다. 여기서 막히면 아무 일도 못 합니다
      paint([])
      note.textContent = `목록을 읽지 못했습니다. ${e.message}. 새로 만드는 것은 됩니다.`
    })
  }

  q('pjNew').onsubmit = async (ev) => {
    ev.preventDefault()
    const name = q('pjName').value.trim()
    if (!name) { q('pjName').focus(); return }
    const btn = q('pjMake')
    btn.disabled = true
    const boardId = newBoardId(name)
    await touch({ boardId, actor, name, what: '프로젝트를 만들었습니다' })
    open(boardId)
  }
  // 「둘러보기」는 새로 만드는 문에는 없습니다. 이름을 붙이러 온 사람의 길이 아닙니다
  const skip = q('pjSkip')
  if (skip) skip.onclick = () => open(DEFAULT_BOARD)

  // 고르면 화면을 다시 엽니다. 그래서 이 약속은 일부러 해결되지 않습니다. // 부르는 쪽의 boot() 이 여기서 멈춰 서고, 작업판은 아직 그려지지 않습니다.
  return new Promise(() => {})
}

