
import { login, setNewPassword } from './auth.js'
import { setHtml } from './dom.js'

const DEMO_PW = window.SB_CONFIG?.demoPw || ''
const DEMO = [
  { id: 'u1', name: '김하나', role: '기획', job: '시나리오를 컷으로 쪼갠다', color: '#E3A93C' },
  { id: 'u2', name: '이도현', role: '아티스트', job: '구도를 그리고 올린다', color: '#4FA97A' },
  { id: 'u3', name: '박서준', role: '감독', job: '피드백하고 승인한다', color: '#7FB3E8' },
  { id: 'u4', name: '최유진', role: '리뷰', job: '메모로 의견을 남긴다', color: '#D69AC9' },
  { id: 'u5', name: '정민아', role: '관리', job: '팀원을 등록하고 역할을 정한다', color: '#C77B62' },
]
const DEMO_BLOCK = `
  <span class="lf__label">데모 계정 — 눌러서 바로 들어가기</span>
  <div class="gate__list">
    ${DEMO.map((u) => `
      <button class="gate__who" type="button" data-demo="${u.id}">
        <span class="gate__dot" style="background:${u.color}"></span>
        <span>
          <span class="gate__name">${u.name}</span><br>
          <span class="gate__role">${u.role} · ${u.id}</span>
        </span>
        <span class="gate__job">${u.job}</span>
      </button>`).join('')}
  </div>
  <div class="lf__or">직접 입력</div>`

export function showLogin(gate) {
  setHtml(gate, `
    <form class="gate__card" id="loginForm" autocomplete="on">
      <div class="gate__eyebrow">여름 스튜디오 · 콘티 보드</div>
      <h2 class="gate__title">로그인</h2>
      <p class="gate__sub">등록된 팀원만 들어올 수 있습니다. 같은 보드를 함께 보고, 서로의 작업이 실시간으로 보입니다.</p>
      ${DEMO_BLOCK}
      <label class="lf">
        <span class="lf__label">이메일 또는 아이디</span>
        <input type="text" id="lgId" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required>
      </label>
      <label class="lf">
        <span class="lf__label">비밀번호</span>
        <input type="password" id="lgPw" name="password" autocomplete="current-password" required>
      </label>
      <label class="lf lf--check">
        <input type="checkbox" id="lgKeep">
        <span>이 브라우저에 로그인 유지</span>
      </label>

      <button class="btn btn--solid btn--wide" id="lgGo" type="submit">로그인</button>
      <p class="lf__why" id="lgWhy" role="alert" aria-live="polite"></p>
      <p class="lf__note">${DEMO_PW ? '데모 계정을 누르면 바로 들어갑니다.' : '데모 계정을 누르면 아이디가 채워집니다. 비밀번호는 관리자에게 받은 값을 넣어주세요.'}
        탭마다 다른 사람으로 들어오면 서로의 작업이 실시간으로 오가는 것을 볼 수 있습니다.</p>
    </form>`)
  gate.hidden = false
  byId('lgId').focus()

  return new Promise((done) => {
    byId('loginForm').addEventListener('click', (e) => {
      const id = e.target.closest('[data-demo]')?.dataset.demo
      if (!id) return
      byId('lgId').value = id
      if (!DEMO_PW) return byId('lgPw').focus()
      byId('lgPw').value = DEMO_PW
      byId('loginForm').requestSubmit()
    })

    byId('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault()
      const id = byId('lgId').value.trim()
      const pw = byId('lgPw').value
      if (!id || !pw) return say('아이디와 비밀번호를 입력해주세요.')

      busy(true)
      try {
        const r = await login(id, pw, byId('lgKeep').checked)
        if (r.challenge) return askNewPassword(gate, id, r.need, done)
        gate.hidden = true
        done(r.session)
      } catch (err) {
        say(err.message)
        byId('lgPw').select()
      } finally {
        busy(false)
      }
    })
  })
}

function askNewPassword(gate, username, need, done) {
  setHtml(gate, `
    <form class="gate__card" id="pwForm">
      <div class="gate__eyebrow">첫 로그인</div>
      <h2 class="gate__title">새 비밀번호를 정해주세요</h2>
      <p class="gate__sub">임시 비밀번호는 이번 한 번만 쓰입니다. 8자 이상, 영문과 숫자를 섞어주세요.</p>
      ${need?.includes('name') ? `
        <label class="lf"><span class="lf__label">이름</span>
          <input type="text" id="pwName" required></label>` : ''}
      <label class="lf">
        <span class="lf__label">새 비밀번호</span>
        <input type="password" id="pwNew" autocomplete="new-password" required>
      </label>
      <label class="lf">
        <span class="lf__label">한 번 더</span>
        <input type="password" id="pwAgain" autocomplete="new-password" required>
      </label>
      <button class="btn btn--solid btn--wide" type="submit">설정하고 들어가기</button>
      <p class="lf__why" id="lgWhy" role="alert" aria-live="polite"></p>
    </form>`)
  byId('pwNew').focus()

  byId('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const pw = byId('pwNew').value
    if (pw.length < 8) return say('8자 이상으로 정해주세요.')
    if (pw !== byId('pwAgain').value) return say('두 비밀번호가 다릅니다.')
    try {
      const attrs = byId('pwName') ? { name: byId('pwName').value.trim() } : {}
      const r = await setNewPassword(pw, attrs)
      gate.hidden = true
      done(r.session)
    } catch (err) {
      say(err.message)
    }
  })
}

const byId = (id) => document.getElementById(id)
const say = (msg) => { const el = byId('lgWhy'); if (el) el.textContent = msg }
function busy(on) {
  const b = byId('lgGo')
  if (!b) return
  b.disabled = on
  document.querySelectorAll('[data-demo]').forEach((x) => { x.disabled = on })
  b.textContent = on ? '확인 중…' : '로그인'
  if (on) say('')
}
