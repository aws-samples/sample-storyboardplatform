/*
 * 홈. 다섯 단계를 순서대로 보여주고 고르게 합니다.
 *
 * 단계 목록을 여기서 따로 적지 않고 nav-tabs.js 의 NAV_TABS 를 그대로 씁니다. 그래야
 * 홈과 각 화면 상단의 탭 바가 어긋나지 않습니다 — 순서를 바꾸거나 단계를 늘릴 때
 * 고칠 곳이 한 곳이면 됩니다. navHref 를 쓰는 이유도 같습니다. 아직 화면이 없는
 * 단계(번역)의 주소를 여기서 다시 판단하지 않습니다.
 *
 * 로그인은 각 화면과 같은 auth.js 를 씁니다. 토큰이 sessionStorage 나 localStorage 에
 * 담기고 같은 오리진의 다른 화면이 그것을 읽으므로, 여기서 한 번 통과하면 보드나
 * 키비주얼이 다시 묻지 않습니다.
 *
 * SB_CONFIG 가 없는 로컬 모드에서는 로그인 문을 띄우지 않습니다. 그 모드는 Cognito 가
 * 없는 상태로 화면만 보는 용도이고, 보드도 같은 조건에서 로그인을 건너뜁니다
 * (demo/app.js 의 boot 이 configured 로 갈라지는 것과 같습니다).
 */
import { NAV_TABS, navHref, isSoonTab } from './nav-tabs.js'
import { configured, session, logout } from './auth.js'
import { showLogin } from './login.js'
import { setHtml } from './dom.js'

const byId = (id) => document.getElementById(id)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/* 단계 다섯. 번호는 NAV_TABS 순서에서 나옵니다 — 별도로 적어 두면 어긋납니다 */
function paintSteps() {
  setHtml(byId('steps'), NAV_TABS.map((t, i) => {
    const n = String(i + 1).padStart(2, '0')
    const soon = isSoonTab(t.id)
    const inner = `
      <span class="step__n" aria-hidden="true">${n}</span>
      <span class="step__body">
        <span class="step__label">${esc(t.label)}</span>
        <span class="step__desc">${esc(t.desc)}</span>
      </span>
      ${soon
        ? '<span class="step__soon">준비 중</span>'
        : '<span class="step__arrow" aria-hidden="true">→</span>'}`
    /*
     * 준비 중인 단계는 <a> 가 아니라 <span> 으로 둡니다. 링크로 두면 눌러서 "준비
     * 중입니다" 안내만 보러 다른 화면까지 다녀오게 됩니다 — 여기서 이미 준비 중이라고
     * 적혀 있으니 그럴 이유가 없습니다.
     */
    return `<li class="step${soon ? ' step--soon' : ''}">${soon
      ? `<span class="step__go" aria-disabled="true">${inner}</span>`
      : `<a class="step__go" href="${esc(navHref(t.id))}">${inner}</a>`}</li>`
  }).join(''))
}

function paintMe() {
  const s = configured ? session() : null
  const box = byId('meBox')
  if (!s) { box.hidden = true; return }
  box.hidden = false
  byId('meWho').textContent = `${s.name} · ${s.id}`
}

async function boot() {
  byId('env').textContent = configured ? '배포' : '로컬'
  paintSteps()

  byId('foot').innerHTML = configured
    ? '단계를 눌러 들어갑니다. 상단 탭으로도 서로 오갈 수 있습니다.'
    : '로컬 모드입니다 — 로그인 없이 화면만 봅니다. 실시간 협업과 그림 생성은 배포에서 동작합니다.'

  byId('meOut').onclick = () => { logout(); location.reload() }

  if (!configured) return

  // 이미 로그인돼 있으면 문을 띄우지 않습니다. 아니면 여기서 받습니다
  if (!session()) await showLogin(byId('gate'))
  paintMe()
}

boot()
