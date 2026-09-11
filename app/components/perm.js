/**
 * 권한 한 벌. 네 화면이 같은 표를 나눠 씁니다.
 *
 * domain/panels.js 가 「무엇을 누가 하는가」의 기본값을 코드로 못 박아 두었습니다(ACTIONS.roles,
 * ART_ROLES, PLAN_ROLES, ADMIN_VIEW_ROLES). 여기 있는 것은 그 위에 얹는 손질입니다.
 * 감독이 역할별로 켜고 끄고, 사람 하나에게만 예외를 줄 수 있습니다. 기본값을 고치지
 * 않으므로 손질을 지우면 언제든 panels.js 의 값으로 돌아갑니다.
 *
 * 보관은 칸 하나가 한 줄입니다. `role:director:approve` 처럼 열쇠를 만들고 { on, ts } 를
 * 둡니다. 통째로 한 덩어리에 넣으면 두 사람이 서로 다른 칸을 만져도 나중 것이 앞 것을
 * 덮습니다.
 *
 * 이 파일이 보드 밖에 사는 이유는, 권한을 봐야 하는 자리가 보드에만 있지 않기 때문입니다.
 * 감독은 스토리 디벨롭·대본화·키비주얼 화면에서도 이 표를 열어야 합니다. 그래서 모양(CSS)
 * 까지 이 파일이 들고 있습니다. 보드의 스타일이 없는 화면에서도 표가 표로 보여야 합니다.
 * 색은 공통 토큰(app/components/theme.css 의 --sb-*)에서 받고, 그 파일이 없으면 뒤의 기본값으로
 * 떨어집니다. nav-tabs.js 와 같은 방식입니다.
 *
 * 「권한 관리」 자체는 손질 대상이 아닙니다. 그것까지 끌 수 있으면 아무도 다시 켤 수 없습니다.
 */

import {
  ACTIONS, TRANSITIONS, STATUS, ROLES,
  canEditContent, ART_ROLES, PLAN_ROLES, ADMIN_VIEW_ROLES,
} from '../domain/panels.js'
import { JOB_ROLES } from '../domain/permissions.js'
import { esc, setHtml } from '../lib/dom.js'
import { josa } from '../lib/josa.js'
import { opsClient } from '../services/api.js'
import { session } from '../services/auth.js'

/*
 * server 가 있는 일은 서버가 Cognito 역할(custom:role)로 막는 일입니다. 이 표는 화면의
 * 손질이고 서버는 이 표를 읽지 않으므로, 서버 목록 밖의 역할에는 「허용」을 줄 수 없습니다 —
 * 줄 수 있는 것처럼 보여 주면 켜 놓고 눌렀을 때 서버가 튕겨서 표가 거짓말이 됩니다.
 * 그 칸은 「역할 고정」으로 잠그고, 허용하려면 관리자가 역할을 바꾸라고 말합니다.
 *   art   → infra/gpu/server.py ART_ROLES · infra/resolvers/genConnector.js ROLES
 *   plan  → infra/resolvers/plan.js · navigate.js · saveGraph.js · updateGraph.js ROLES
 *   grant → infra/resolvers/putOp.js (member.role 은 admin 만)
 */
export const CAPS = {
  ...Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, {
    label: v.label, group: '컷 진행', roles: v.roles,
    note: `${Object.entries(TRANSITIONS[k] || {}).map(([f, t]) => `${STATUS[f].label}→${STATUS[t].label}`).join(', ')}`,
  }])),
  edit: {
    label: '내용 편집',
    group: '컷 내용',
    // 기본값을 domain/panels.js 에서 되읽습니다. 여기에 역할 이름을 다시 적으면 두 곳이 갈라집니다
    roles: Object.keys(ROLES).filter((r) => canEditContent(r, { status: 'draft' })),
    // 「그림 만들기」가 여기 적혀 있었습니다. 그 일은 아래 art 로 갈라졌습니다(board.js 의 artOk)
    note: '구도 이름·작업 지시. 승인된 컷은 역할과 무관하게 잠깁니다',
  },
  art: { label: '이미지 만들기', group: '컷 내용', roles: ART_ROLES, server: JOB_ROLES.gen, note: '컷·구도 그리기, 스케치 올리기, 모델 고르기' },
  plan: { label: '기획 도구', group: '도구', roles: PLAN_ROLES, server: JOB_ROLES.plan, note: '이야기 기획, 컷을 대본으로, 대본 불러오기, 관계 그래프' },
  admin: { label: '관리 화면', group: '도구', roles: ADMIN_VIEW_ROLES, note: '로그와 기여도' },
  grant: { label: '역할 바꾸기', group: '도구', roles: ['admin'], server: ['admin'], note: '팀원의 역할을 다른 역할로 바꿉니다' },
}

/** 서버가 이 역할에게 이 일을 막는가. 표로는 못 여는 칸입니다 */
export const serverFixed = (cap, role) => !!CAPS[cap]?.server && !CAPS[cap].server.includes(role)
const FIXED_WHY = (cap, role) => `「${CAPS[cap].label}」${josa(CAPS[cap].label, '은', '는')} 서버가 역할로 고정한 일입니다. `
  + `${CAPS[cap].server.map((r) => ROLES[r] || r).join('·')}만 할 수 있고, ${ROLES[role] || role}에게는 이 표로 열 수 없습니다. `
  + '허용하려면 관리자가 역할을 바꿔야 합니다'

export const CAP_GROUPS = ['컷 진행', '컷 내용', '도구']

/** 권한 관리를 할 수 있는 역할. 여기는 손질 대상이 아니라 코드에 둡니다 */
export const PERM_ROLES = ['director', 'admin']
export const mayManagePerms = (role) => PERM_ROLES.includes(role)

/** 막힌 일을 눌렀을 때 하는 말. 화면마다 다르게 적으면 같은 상황이 다른 일처럼 읽힙니다 */
export const ASK = '감독에게 요청하세요'

export const permKey = (scope, who, cap) => (scope === 'user' ? `user:${who}:${cap}` : `role:${who}:${cap}`)

/**
 * op 로그에서 권한 표를 접어 냅니다. 보드 밖의 화면이 씁니다.
 *
 * 보드(board.js 의 applyOp)는 손질한 사람이 감독인지까지 봅니다. 여기서는 보지 않습니다.
 * 이 표를 읽는 화면에는 역할 명부가 없고, 무엇보다 이것은 보여 주기 위한 사본입니다.
 * 실제로 판을 움직이는 검사는 보드가 합니다.
 */
export function permsFromOps(ops) {
  const out = {}
  for (const op of ops || []) {
    if (op.kind !== 'perm.set' || !CAPS[op.cap] || !op.who) continue
    const key = permKey(op.scope, op.who, op.cap)
    if (out[key] && out[key].ts > op.ts) continue
    out[key] = { on: op.on === null || op.on === undefined ? null : !!op.on, ts: op.ts }
  }
  return out
}

/**
 * op 로그에서 사람 명부를 접어 냅니다. 이름과 역할이 없는 사람도(로그에 흔적만 있는
 * 사람도) 목록에 둡니다. 「사람별 예외」에서 고를 수 있어야 하기 때문입니다.
 */
export function membersFromOps(ops) {
  const out = {}
  const row = (id) => (out[id] ??= { id, name: id, role: 'reviewer' })
  for (const op of ops || []) {
    if (op.actor) row(op.actor)
    if (op.kind === 'member.set' && op.member?.id) {
      const m = row(op.member.id)
      if (op.member.name) m.name = op.member.name
      if (op.member.role) m.role = op.member.role
    } else if (op.kind === 'member.role' && op.userId) {
      row(op.userId).role = ROLES[op.role] ? op.role : 'reviewer'
    }
  }
  return out
}

/**
 * 권한을 묻는 한 벌. 화면마다 표를 어디에 들고 있는지가 달라서 함수로 받습니다.
 *
 * @param {object} o
 * @param {object|Function} o.perms - 손질 표. 바뀌는 것이면 함수로 줍니다
 * @param {(id: string) => string} o.roleOf - 사람 id → 역할
 * @param {(id: string) => string} [o.nameOf] - 사람 id → 이름. 이유 문장에 씁니다
 * @param {string|Function} [o.meId] - 지금 보고 있는 사람. 이유 문장의 「나」입니다
 */
export function permModel({ perms, roleOf, nameOf = (id) => id, meId = null }) {
  const table = () => (typeof perms === 'function' ? perms() : perms) || {}
  const self = () => (typeof meId === 'function' ? meId() : meId)

  /** 손질 한 칸. 없거나 지워졌으면 null (= 기본값) */
  const cell = (scope, who, cap) => {
    const c = table()[permKey(scope, who, cap)]
    return c && c.on !== null && c.on !== undefined ? c : null
  }

  /** 역할까지만 본 값. 역할 표가 이것을 보여 줍니다. 서버가 고정한 칸은 손질이 있어도 막음입니다 */
  const mayRole = (cap, role) => {
    if (serverFixed(cap, role)) return false
    const r = cell('role', role, cap)
    return r ? r.on : !!CAPS[cap]?.roles.includes(role)
  }

  /** 이 사람이 이것을 할 수 있는가. 서버 고정 → 사람 예외 → 역할 손질 → panels.js 기본값 순서입니다 */
  const may = (cap, who = self()) => {
    if (!CAPS[cap]) return false
    if (serverFixed(cap, roleOf(who))) return false
    const u = cell('user', who, cap)
    if (u) return u.on
    return mayRole(cap, roleOf(who))
  }

  /** 왜 못 하는지 사람 말로. 막힌 버튼의 title 과 알림에 그대로 씁니다 */
  const whyNot = (cap, who = self()) => {
    const spec = CAPS[cap]
    if (!spec) return '알 수 없는 권한입니다'
    const role = roleOf(who)
    if (serverFixed(cap, role)) return FIXED_WHY(cap, role)
    if (cell('user', who, cap)) {
      return `${who === self() ? '나에게' : `${nameOf(who) || '이 사람'}에게`}만 따로 `
        + `「${spec.label}」${josa(spec.label, '을', '를')} 막아 두었습니다. 감독이 권한 관리에서 풉니다`
    }
    if (cell('role', role, cap)) {
      return `권한 관리에서 ${ROLES[role] || role}의 「${spec.label}」${josa(spec.label, '을', '를')} `
        + '꺼 두었습니다. 감독이 다시 켤 수 있습니다'
    }
    return `「${spec.label}」${josa(spec.label, '은', '는')} ${spec.roles.map((r) => ROLES[r] || r).join('·')}의 일입니다. `
      + `${ROLES[role] || role}에게는 기본값으로 없습니다`
  }

  /**
   * 역할 표의 한 칸이 왜 막혀 있는지. whyNot 과 갈라 두는 이유는, 역할 표에는 「나」가
   * 없기 때문입니다. 손으로 끈 칸과 기본값으로 없는 칸은 다른 말을 해야 합니다.
   */
  const whyNotRole = (cap, role) => {
    const spec = CAPS[cap]
    if (!spec) return '알 수 없는 권한입니다'
    if (serverFixed(cap, role)) return FIXED_WHY(cap, role)
    if (cell('role', role, cap)) {
      return `권한 관리에서 ${ROLES[role] || role}의 「${spec.label}」${josa(spec.label, '을', '를')} 꺼 두었습니다`
    }
    return `「${spec.label}」${josa(spec.label, '은', '는')} ${spec.roles.map((r) => ROLES[r] || r).join('·')}의 일입니다. `
      + `${ROLES[role] || role}에게는 기본값으로 없습니다`
  }

  /** 손댄 칸 목록. 되돌리기 버튼과 「n칸 손질」 표시가 이것을 셉니다 */
  const changed = () => Object.entries(table()).filter(([key, v]) => {
    if (!v || v.on === null || v.on === undefined) return false
    // 서버 고정 칸에 남은 옛 손질은 아무 힘이 없습니다. 「n칸 손질」에 세지 않습니다
    const [scope, who, cap] = key.split(':')
    return !serverFixed(cap, scope === 'user' ? roleOf(who) : who)
  })

  /**
   * 칸 하나를 뒤집는 op 를 만듭니다. 뒤집은 값이 기본값과 같아지면 손질을 지웁니다 —
   * 표에 손댄 표시만 남으면 나중에 무엇이 기본값과 다른지 알 수 없습니다.
   * 보내는 일은 부르는 쪽이 합니다. 보드는 emit, 다른 화면은 opsClient 로 보냅니다.
   */
  const toggle = (scope, who, cap) => {
    if (!CAPS[cap] || !who) return null
    const role = scope === 'user' ? roleOf(who) : who
    // 서버가 고정한 칸은 뒤집을 것이 없습니다. op 를 만들면 표만 「허용」이 되고 서버는 그대로 튕깁니다
    if (serverFixed(cap, role)) return null
    const base = scope === 'user' ? mayRole(cap, role) : CAPS[cap].roles.includes(role)
    const cur = cell(scope, who, cap)
    const want = !(cur ? cur.on : base)
    return { kind: 'perm.set', scope, who, cap, on: want === base ? null : want }
  }

  return { cell, mayRole, may, whyNot, whyNotRole, changed, toggle, roleOf, nameOf, meId: self }
}

/* ── 표 ─────────────────────────────────────────────────────────────────────── */

const cellHtml = (scope, who, cap, on, set, edit, why, fixed = false) => (fixed ? `
  <button class="pm__cell" data-pscope="${scope}" data-pwho="${esc(who)}" data-pcap="${cap}"
    data-on="0" data-set="0" data-fixed="1" disabled title="${esc(why)}">역할 고정</button>` : `
  <button class="pm__cell" data-pscope="${scope}" data-pwho="${esc(who)}" data-pcap="${cap}"
    data-on="${on ? 1 : 0}" data-set="${set ? 1 : 0}" ${edit ? '' : 'disabled'}
    title="${esc(`${on ? '할 수 있습니다' : why}${set ? ' · 기본값에서 손질한 칸입니다' : ''}`)}">${on ? '허용' : '막음'}</button>`)

function roleTable(m, edit) {
  const roles = Object.keys(ROLES)
  return `
    <table class="pm__tbl">
      <thead><tr><th>할 수 있는 일</th>${roles.map((r) => `<th>${esc(ROLES[r])}</th>`).join('')}</tr></thead>
      <tbody>
        ${CAP_GROUPS.map((g) => `
          <tr><td colspan="${roles.length + 1}" class="pm__grp">${esc(g)}</td></tr>
          ${Object.entries(CAPS).filter(([, c]) => c.group === g).map(([k, c]) => `
            <tr>
              <td class="pm__cap"><b>${esc(c.label)}</b><span>${esc(c.note || '')}</span></td>
              ${roles.map((r) => `<td>${cellHtml('role', r, k, m.mayRole(k, r),
    !!m.cell('role', r, k), edit, m.whyNotRole(k, r), serverFixed(k, r))}</td>`).join('')}
            </tr>`).join('')}`).join('')}
      </tbody>
    </table>
    <p class="pm__note">테두리가 도드라진 칸은 기본값에서 손질한 것입니다. 다시 눌러 기본값으로 되돌립니다.
      「역할 고정」은 서버가 로그인 역할로 막는 일이라 이 표로는 열 수 없습니다 — 허용하려면 관리자가 그 사람의 역할을 바꿔야 합니다.
      승인된 컷은 여기서 무엇을 켜도 잠긴 채로 있습니다 — 그것은 권한이 아니라 이야기의 규칙입니다.</p>`
}

function userTable(m, edit, who, team) {
  const role = m.roleOf(who)
  return `
    <label class="pm__row"><span class="pm__lab">사람</span>
      <select class="pm__sel" data-puser="1">${team.map((u) =>
    `<option value="${esc(u.id)}" ${u.id === who ? 'selected' : ''}>${esc(u.name)} · ${esc(ROLES[u.role] || u.role)}</option>`).join('')}</select></label>
    <p class="pm__why">${esc(m.nameOf(who) || who)}${josa(m.nameOf(who) || who, '은', '는')} ${esc(ROLES[role] || role)}입니다.
      아래에서 뒤집은 칸만 이 사람에게 따로 적용되고, 나머지는 역할의 값을 따릅니다.</p>
    <table class="pm__tbl">
      <thead><tr><th>할 수 있는 일</th><th style="width:92px">${esc(ROLES[role] || role)} 기본</th><th style="width:92px">이 사람</th><th>왜</th></tr></thead>
      <tbody>
        ${Object.entries(CAPS).map(([k, c]) => {
    const base = m.mayRole(k, role)
    const on = m.may(k, who)
    return `
          <tr>
            <td class="pm__cap"><b>${esc(c.label)}</b><span>${esc(c.note || '')}</span></td>
            <td class="pm__base">${serverFixed(k, role) ? '역할 고정' : base ? '허용' : '막음'}</td>
            <td>${cellHtml('user', who, k, on, !!m.cell('user', who, k), edit, m.whyNot(k, who), serverFixed(k, role))}</td>
            <td class="pm__reason">${on ? '' : esc(m.whyNot(k, who))}</td>
          </tr>`
  }).join('')}
      </tbody>
    </table>`
}

/**
 * 권한 판 한 장. 보드의 관리 화면과 다른 화면들의 창이 같은 것을 씁니다.
 *
 * @param {object} m - permModel
 * @param {object} o
 * @param {'role'|'user'} o.tab - 역할별 · 사람별
 * @param {string} o.who - 사람별에서 고른 사람
 * @param {boolean} o.edit - 고칠 수 있는가(감독·관리자)
 * @param {Array<{id: string, name: string, role: string}>} o.team - 고를 수 있는 사람들
 */
export function panelHtml(m, { tab = 'role', who = null, edit = false, team = [] }) {
  const n = m.changed().length
  const pick = team.some((u) => u.id === who) ? who : (team[0]?.id ?? m.meId())
  const blocked = Object.keys(CAPS).filter((k) => !m.may(k))
  return `
    <p class="pm__why">${edit
    ? `역할과 사람마다 무엇을 할 수 있는지 여기서 정합니다. 바꾸면 모두에게 곧 반영됩니다.${
      n ? ` 지금 <b>${n}칸</b>이 기본값과 다릅니다.` : ' 지금은 모두 기본값입니다.'}`
    : `${esc(ROLES[m.roleOf(m.meId())] || '이 역할')}${
      josa(ROLES[m.roleOf(m.meId())] || '이 역할', '은', '는')} 이 표를 고칠 수 없습니다. 바꾸려면 ${ASK}.${
      n ? ` 지금 ${n}칸이 기본값과 다릅니다.` : ''}`}</p>
    <h3 class="pm__h">내가 할 수 있는 일</h3>
    <ul class="pm__me">${Object.entries(CAPS).map(([k, c]) =>
    `<li data-can="${m.may(k) ? 1 : 0}" title="${esc(m.may(k) ? '할 수 있습니다' : m.whyNot(k))}">${esc(c.label)}</li>`).join('')}</ul>
    ${blocked.length ? `<p class="pm__note">막힌 것에 마우스를 올리면 왜 막혔는지 나옵니다. 필요하면 ${ASK}.</p>` : ''}
    <div class="pm__tabs" role="group" aria-label="권한 표">
      <button class="pm__tab" data-ptab="role" data-on="${tab === 'role' ? 1 : 0}">역할별</button>
      <button class="pm__tab" data-ptab="user" data-on="${tab === 'user' ? 1 : 0}">사람별 예외</button>
    </div>
    ${tab === 'role' ? roleTable(m, edit) : userTable(m, edit, pick, team)}
    ${edit && n ? `<div class="pm__acts">
      <button class="pm__btn" data-preset="1">${n}칸 모두 기본값으로</button></div>` : ''}`
}

/* ── 모양 ───────────────────────────────────────────────────────────────────── */

const CSS = `
.pm__why, .pm__note { font-size: 12px; line-height: 1.6; color: var(--sb-ink-3, #767f8c); margin: 0 0 10px; }
.pm__note { font-size: 11.5px; margin-top: 10px; }
.pm__h { font-size: 12px; margin: 14px 0 6px; color: var(--sb-ink, #111318); }
.pm__me { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; padding: 0; }
.pm__me li { list-style: none; font-size: 11.5px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--sb-line, #e4e7ec); }
.pm__me li[data-can="1"] { border-color: var(--sb-accent, #1a56db); color: var(--sb-accent, #1a56db); }
.pm__me li[data-can="0"] { border-style: dashed; color: var(--sb-bad, #b42318); }
.pm__tabs { display: flex; gap: 4px; margin: 14px 0 8px; }
.pm__tab {
  padding: 5px 11px; font: inherit; font-size: 12px; cursor: pointer;
  background: var(--sb-panel, #fff); color: var(--sb-ink-3, #767f8c);
  border: 1px solid var(--sb-line, #e4e7ec); border-radius: 999px;
}
.pm__tab[data-on="1"] { background: var(--sb-accent, #1a56db); border-color: var(--sb-accent, #1a56db); color: #fff; }
.pm__tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.pm__tbl th, .pm__tbl td { border-bottom: 1px solid var(--sb-line, #e4e7ec); padding: 6px 8px; text-align: left; vertical-align: middle; }
.pm__tbl th { font-size: 11px; color: var(--sb-ink-3, #767f8c); font-weight: 600; }
.pm__grp { font-size: 10.5px; color: var(--sb-ink-3, #767f8c); background: var(--sb-fill, #f8f9fb); }
.pm__cap b { display: block; font-size: 12px; }
.pm__cap span { color: var(--sb-ink-3, #767f8c); font-size: 10.5px; }
.pm__base, .pm__reason { font-size: 11px; color: var(--sb-ink-3, #767f8c); }
.pm__cell {
  width: 100%; padding: 5px 6px; border: 1px solid var(--sb-line, #e4e7ec); border-radius: 6px;
  background: var(--sb-panel, #fff); color: var(--sb-ink-3, #767f8c);
  font: 600 11px/1.4 inherit; cursor: pointer;
}
.pm__cell[data-on="1"] { background: var(--sb-accent, #1a56db); border-color: var(--sb-accent, #1a56db); color: #fff; }
.pm__cell[data-on="0"] { background: var(--sb-fill, #f8f9fb); color: var(--sb-bad, #b42318); border-style: dashed; }
/* 기본값에서 손댄 칸은 눈에 띄어야 합니다. 무엇을 되돌리면 되는지 바로 보입니다 */
.pm__cell[data-set="1"] { outline: 2px solid var(--sb-bad, #b42318); outline-offset: 1px; }
.pm__cell:disabled { cursor: not-allowed; opacity: .6; }
/* 서버가 역할로 고정한 칸. 막음(빨강 점선)과 달리 「누가 잠갔다」가 아니라 「여기서는 못 연다」입니다 */
.pm__cell[data-fixed="1"] { background: var(--sb-fill, #f8f9fb); color: var(--sb-ink-3, #767f8c); border-style: solid; opacity: .8; cursor: help; }
.pm__row { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
.pm__lab { font-size: 11.5px; color: var(--sb-ink-3, #767f8c); }
.pm__sel, .pm__btn {
  font: inherit; font-size: 12px; padding: 5px 9px; border-radius: 6px;
  border: 1px solid var(--sb-line, #e4e7ec); background: var(--sb-panel, #fff); color: var(--sb-ink, #111318);
}
.pm__btn { cursor: pointer; }
.pm__acts { margin-top: 12px; }

/* 보드 밖의 화면에서 이 표를 띄우는 창. 보드에서는 관리 화면 안에 들어가므로 쓰지 않습니다 */
.pmdlg {
  width: min(1040px, 94vw); max-height: 88vh; padding: 0; overflow: hidden;
  border: 1px solid var(--sb-line, #e4e7ec); border-radius: 12px;
  background: var(--sb-panel, #fff); color: var(--sb-ink, #111318);
  font: inherit; box-shadow: 0 24px 60px rgba(16, 24, 40, .22);
}
.pmdlg::backdrop { background: rgba(16, 24, 40, .45); }
.pmdlg__bar {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  border-bottom: 1px solid var(--sb-line, #e4e7ec); background: var(--sb-fill, #f8f9fb);
}
.pmdlg__bar h2 { font-size: 14px; margin: 0; }
.pmdlg__bar .pm__btn { margin-left: auto; }
.pmdlg__body { padding: 14px 16px 20px; overflow: auto; max-height: calc(88vh - 52px); }

/*
 * 권한 때문에 막힌 것. 눌러도 아무 일이 없으면 고장으로 읽히므로, 막힌 자리는
 * 「감독에게 요청하세요」를 띄웁니다. select 는 readonly 가 없어서 disabled 로 두는데
 * 그러면 클릭조차 오지 않아, 감싼 쪽이 클릭을 받게 pointer-events 를 끕니다.
 */
[data-nope] { cursor: not-allowed; }
[data-nope] select:disabled, [data-nope] button:disabled, [data-nope] input:disabled { pointer-events: none; }
[data-nope][aria-disabled="true"] { opacity: .5; }
`

let styled = false
/** 권한 표 스타일을 한 번만 꽂습니다 */
export function injectCss(doc = document) {
  if (styled) return
  styled = true
  const el = doc.createElement('style')
  el.id = 'permCss'
  el.textContent = CSS
  doc.head.appendChild(el)
}

/* ── 막힌 자리 ───────────────────────────────────────────────────────────────── */

let watching = false

/**
 * 권한 때문에 막힌 것을 누르면 이유와 「감독에게 요청하세요」를 띄웁니다.
 *
 * 막힌 자리마다 안내를 붙이면 같은 말이 스무 곳에 흩어집니다. 대신 막힌 것에
 * `data-nope="이유"` 만 적어 두고, 문서 하나가 그것을 잡습니다. 잡는 자리를 캡처
 * 단계에 두는 이유는 화면의 본 처리가 먼저 돌아가는 것을 막아야 하기 때문입니다.
 *
 * disabled 를 그대로 쓰지 않습니다. 브라우저가 disabled 요소의 클릭을 아예 보내지
 * 않아서 누른 사람에게 아무 말도 못 합니다. 그래서 겉모습은 aria-disabled 로 두고
 * 막는 일은 여기서 합니다. select 처럼 정말 disabled 여야 하는 것만 감싸는 쪽에
 * data-nope 를 답니다(CSS 의 pointer-events).
 *
 * @param {(msg: string) => void} say - 화면이 쓰는 알림. 보드는 toast 를 넘깁니다
 */
export function watchNope(say) {
  if (watching) return
  watching = true
  injectCss(document)
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-nope]')
    const why = el?.dataset.nope
    if (!why) return
    e.preventDefault()
    e.stopPropagation()
    say(`${why}. ${ASK}.`)
  }, true)
}

/** 막힌 컨트롤에 붙일 속성 한 벌. 화면들이 이것만 끼워 넣으면 됩니다 */
export const nope = (why) => `aria-disabled="true" data-nope="${esc(why)}" title="${esc(`${why}. ${ASK}.`)}"`

/* ── 보드 밖에서 띄우는 창 ───────────────────────────────────────────────────── */

/*
 * 스토리 디벨롭·대본화·키비주얼 화면은 보드의 판(state)을 들고 있지 않습니다. 그래서
 * 여기서 op 로그를 직접 읽어 표를 접어 냅니다. 소켓은 열지 않습니다(opsClient). 이 창은
 * 열 때 한 번 읽고, 고치면 그 op 하나를 보내면 되는 자리입니다.
 */
let dlg = null
const st = { tab: 'role', who: null, ops: [], perms: {}, members: {}, board: null, say: '', me: null }

const uuid = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/** 로그인 전이거나 로컬 모드일 때의 나. ?as=director 로 들어온 사람을 알아봅니다 */
function whoAmI() {
  const s = session()
  if (s) return s
  const asked = new URLSearchParams(location.search).get('as')
  const role = ROLES[asked] ? asked : 'reviewer'
  return { id: asked || 'guest', name: asked || '손님', role }
}

const team = () => {
  const list = Object.values(st.members)
  if (!list.some((u) => u.id === st.me.id)) list.push({ ...st.me })
  return list.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

function model() {
  return permModel({
    perms: () => st.perms,
    roleOf: (id) => st.members[id]?.role || (id === st.me.id ? st.me.role : 'reviewer'),
    nameOf: (id) => st.members[id]?.name || (id === st.me.id ? st.me.name : id),
    meId: () => st.me.id,
  })
}

function paint() {
  if (!dlg?.open) return
  if (dlg.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return
  const m = model()
  const edit = mayManagePerms(m.roleOf(st.me.id))
  setHtml(dlg.querySelector('.pmdlg__body'), `
    ${st.say ? `<p class="pm__why">${esc(st.say)}</p>` : ''}
    ${panelHtml(m, { tab: st.tab, who: st.who, edit, team: team() })}`)
}

async function reload() {
  const client = opsClient(st.board)
  if (!client) {
    st.say = '이 화면은 서버에 붙어 있지 않습니다(로컬 모드). 권한은 기본값으로 보입니다.'
    return
  }
  try {
    st.ops = await client.fetchOps()
    st.perms = permsFromOps(st.ops)
    st.members = membersFromOps(st.ops)
    st.say = ''
  } catch (e) {
    st.say = `권한을 읽지 못했습니다: ${e.message}`
  }
}

async function send(op) {
  const client = opsClient(st.board)
  if (!client) { st.say = '로컬 모드에서는 권한을 바꿀 수 없습니다. 스토리보드 화면에서 바꿔주세요.'; return paint() }
  op.id = uuid()
  op.ts = Date.now()
  op.actor = st.me.id
  st.ops.push(op)
  st.perms = permsFromOps(st.ops)
  paint()
  try {
    await client.sendOp(op)
  } catch (e) {
    st.say = `보내지 못했습니다: ${e.message}`
    paint()
  }
}

function build() {
  injectCss(document)
  dlg = document.createElement('dialog')
  dlg.className = 'pmdlg'
  dlg.id = 'permDlg'
  dlg.setAttribute('aria-label', '권한 관리')
  dlg.innerHTML = `
    <header class="pmdlg__bar">
      <h2>권한 관리</h2>
      <button class="pm__btn" data-pclose="1">닫기</button>
    </header>
    <div class="pmdlg__body"></div>`
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-pclose]')) return dlg.close()
    const tab = e.target.closest('[data-ptab]')?.dataset.ptab
    if (tab) { st.tab = tab; return paint() }
    const cell = e.target.closest('.pm__cell')
    if (cell) {
      const op = model().toggle(cell.dataset.pscope, cell.dataset.pwho, cell.dataset.pcap)
      return op ? send(op) : null
    }
    if (e.target.closest('[data-preset]')) {
      const cells = model().changed()
      if (!cells.length || !confirm(`손질한 ${cells.length}칸을 모두 기본값으로 돌립니다. 계속할까요?`)) return
      for (const [key] of cells) {
        const [scope, who, cap] = key.split(':')
        send({ kind: 'perm.set', scope, who, cap, on: null })
      }
    }
  })
  dlg.addEventListener('change', (e) => {
    if (!e.target.dataset.puser) return
    st.who = e.target.value
    // paint 는 고르는 중에는 물러섭니다. 갈아타려면 select 가 손을 놓아야 합니다
    e.target.blur()
    paint()
  })
  document.body.appendChild(dlg)
}

/**
 * 권한 관리 창을 엽니다. 보드 밖의 화면에서 탭 바의 단추가 이것을 부릅니다.
 * @param {object} o
 * @param {string} o.board - 어느 보드의 권한인가
 */
export async function openPerm({ board } = {}) {
  if (!dlg) build()
  st.board = board || null
  st.me = whoAmI()
  if (!st.who) st.who = st.me.id
  if (!dlg.open) dlg.showModal()
  paint()
  await reload()
  paint()
}
