/*
 * 세계관 네비게이터 챗봇의 화면. 떠 있는 버튼 하나와 그 위에 열리는 카드 하나다.
 *
 * 이 모듈은 그래프도 네트워크도 모른다. 질문을 받아 onSend 에 넘기고 돌아온 문자열을
 * 말풍선으로 그리는 것만 한다 — 빈 그래프 안내처럼 서버를 부르지 않는 답도 onSend 가
 * 문자열로 돌려주면 그대로 보인다. 그래서 story-graph.html 말고 다른 화면에도 붙는다.
 *
 * 답은 다 받은 뒤에 글자 단위로 흘려 넣는다 (typeInto). 서버 스트리밍이 아니라 화면
 * 효과일 뿐이다 — onSend 는 완성된 문자열 하나를 돌려주면 된다.
 *
 * 대화는 sessionStorage 에 남는다. 새로고침해도 이어지고, 탭을 닫으면 사라진다 —
 * 그래프는 Neptune 에 남지만 대화는 그 판을 보던 그 자리에서만 뜻이 있다.
 * 끌어 맞춘 카드 크기도 같은 자리에 따로 남는다 (HISTORY_KEY · SIZE_KEY).
 *
 * 스타일은 이 파일이 <style> 한 장으로 넣는다. 클래스 이름은 모두 .navigator- 로
 * 시작한다 — story-graph.html 의 짧은 이름들(.card, .btn, .hint)과 부딪히지 않는다.
 * 색은 theme.css 의 --sb-* 를 그대로 쓴다. 화면마다 다시 정의한 별칭(--acc 등)이
 * 아니라 공통 토큰을 집는 이유는, 이 카드가 어느 화면에 붙어도 같은 색이어야 하기 때문이다.
 */

/** 대화가 남는 자리. story-graph.html 의 onSend 가 같은 키를 읽는다 */
export const HISTORY_KEY = 'navigatorHistory'
/**
 * 남겨 두는 턴 수. 한 턴은 질문 하나 + 답 하나라서 메시지로는 그 두 배다.
 * 넘치면 오래된 턴부터 버린다. Lambda 도 받은 것 중 최근 몇 개만 모델에 다시 넣는다.
 */
const TURNS_MAX = 10

const INTRO = `안녕하세요! 세계관 네비게이터입니다. 현재 그래프에 대해 자유롭게 질문하세요.

예시:
• "도현이랑 서진 관계가 뭐야?"
• "아직 회수 안 된 복선 있어?"
• "이 세계관 전체를 요약해줘"`

/** navigate 리졸버가 튕기는 질문 길이. 보내기 전에 여기서 먼저 막는다 */
const QUESTION_MAX = 2000

/** 타이핑 한 틱. 이만큼마다 typeRate 개씩 글자를 흘린다 */
const TYPE_TICK_MS = 20
/**
 * 이미 흘린 글자 수 → 한 틱에 흘릴 글자 수. 글자당 20ms → 10ms → 5ms 로 빨라지는 것과
 * 같은 속도인데, 타이머는 20ms 로 두고 개수를 늘린다 — 5ms 타이머는 브라우저가 지켜
 * 주지 않고(최소 간격·백그라운드 스로틀), 긴 답변에서 타이머만 수천 번 돈다.
 * 한글은 한 글자가 한 음절이라 20ms 면 읽는 속도에 붙는다.
 *
 * @param {number} done - 지금까지 흘린 글자 수
 * @returns {number} 이 틱에 흘릴 글자 수
 */
const typeRate = (done) => (done < 100 ? 1 : done < 500 ? 2 : 4)

/** 움직임을 줄여 달라고 한 판. 타이핑을 건너뛰고 답을 한 번에 놓는다 */
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true

/** 사용자가 끌어 맞춘 카드 크기가 남는 자리. 대화(HISTORY_KEY)와 따로 둔다 */
export const SIZE_KEY = 'navigatorPanelSize'
const DEFAULT_SIZE = { width: 380, height: 520 }
const MIN_W = 280
const MIN_H = 300
/*
 * 위쪽 여유 48 · 104 는 카드가 앉은 자리에서 나온 값이다 (left 24, bottom 80).
 * 오른쪽·위쪽으로 늘리는 것이라 반대편 여백만큼은 늘 남는다 — 화면 밖으로 나가지 않는다.
 */
const maxW = () => Math.max(MIN_W, window.innerWidth - 48)
const maxH = () => Math.max(MIN_H, window.innerHeight - 104)

const clampSize = ({ width, height }) => ({
  width: Math.min(maxW(), Math.max(MIN_W, Math.round(width) || DEFAULT_SIZE.width)),
  height: Math.min(maxH(), Math.max(MIN_H, Math.round(height) || DEFAULT_SIZE.height)),
})

const CSS = `
.navigator-fab {
  position: fixed; bottom: 24px; left: 24px; z-index: 1000;
  width: 48px; height: 48px; border-radius: 50%;
  border: 1px solid var(--sb-accent, #1a56db); background: var(--sb-accent, #1a56db);
  color: #fff; font-size: 20px; line-height: 1; cursor: pointer;
  box-shadow: var(--sb-sh-lg, 0 12px 34px -10px rgba(17,19,24,.22));
  display: flex; align-items: center; justify-content: center;
  transition: transform .12s ease, filter .12s ease;
}
.navigator-fab:hover { filter: brightness(1.08); }
.navigator-fab:active { transform: scale(.94); }
.navigator-fab:focus-visible { outline: 2px solid var(--sb-accent-ink, #1543ad); outline-offset: 2px; }

/*
 * 크기는 JS 가 인라인으로 잡는다 (끌어 맞춘 값 · sessionStorage 복원 · 화면 크기 클램프).
 * 여기 380x520 은 JS 가 값을 넣기 전 한 프레임의 기본값이다. max-height 를 두면
 * 인라인 height 를 이겨서 끌어 늘린 크기와 offsetHeight 가 어긋난다 — 그래서 두지 않고
 * 상한은 maxH() 한 곳에서만 본다.
 */
.navigator-panel {
  position: fixed; bottom: 80px; left: 24px; z-index: 999;
  width: 380px; height: 520px;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--sb-panel, #fff); color: var(--sb-ink, #111318);
  border: 1px solid var(--sb-line, #e4e7ec); border-radius: var(--sb-r-lg, 10px);
  box-shadow: var(--sb-sh-lg, 0 12px 34px -10px rgba(17,19,24,.22));
  font-family: var(--sb-sans, system-ui, sans-serif); font-size: 14px; line-height: 1.65;
}
.navigator-panel[hidden] { display: none; }

/*
 * 크기 조절 손잡이. 카드는 bottom·left 가 못 박혀 있으니 위로 끌면 높이가, 오른쪽으로
 * 끌면 너비가 자란다. 평소에는 보이지 않고 손이 닿을 때만 살짝 뜬다 — 밝은 카드라서
 * 흰 덮개만으로는 표가 나지 않아 옅은 파란 선을 같이 둔다.
 * touch-action:none 은 손가락으로 끌 때 화면이 같이 스크롤되지 않게 한다.
 */
.navigator-resize { position: absolute; z-index: 2; background: transparent; touch-action: none; }
.navigator-resize:hover, .navigator-resize--on {
  background: rgba(255,255,255,.15);
  box-shadow: inset 0 0 0 1px var(--sb-accent-line, #c7d6f7);
}
.navigator-resize-top { top: 0; left: 0; right: 0; height: 6px; cursor: ns-resize; }
.navigator-resize-right { top: 0; right: 0; bottom: 0; width: 6px; cursor: ew-resize; }
/* 코너는 두 손잡이가 겹치는 자리다. 위에 얹어 대각선이 먼저 잡히게 한다 */
.navigator-resize-corner { top: 0; right: 0; width: 14px; height: 14px; z-index: 3; cursor: nesw-resize; }

.navigator-head {
  display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
  padding: 10px 10px 10px 14px;
  border-bottom: 1px solid var(--sb-line, #e4e7ec); background: var(--sb-fill, #f8f9fb);
}
.navigator-title { font-size: 14px; font-weight: 700; letter-spacing: -.01em; margin-right: auto; }
.navigator-btn {
  border: 1px solid var(--sb-line, #e4e7ec); background: var(--sb-panel, #fff);
  color: var(--sb-ink-2, #5b6472); border-radius: var(--sb-r, 6px);
  font: inherit; font-size: 12px; padding: 3px 8px; cursor: pointer;
}
.navigator-btn:hover { background: var(--sb-fill-2, #f1f3f6); color: var(--sb-ink, #111318); }
.navigator-btn--icon { padding: 3px 7px; font-size: 13px; }

.navigator-log {
  flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain;
  padding: 14px; display: flex; flex-direction: column; gap: 10px;
}
.navigator-msg {
  max-width: 85%; padding: 8px 11px; border-radius: 12px;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.navigator-msg--user {
  align-self: flex-end; background: var(--sb-accent, #1a56db); color: #fff;
  border-bottom-right-radius: 4px;
}
.navigator-msg--bot {
  align-self: flex-start; background: var(--sb-fill-2, #f1f3f6); color: var(--sb-ink, #111318);
  border-bottom-left-radius: 4px;
}
.navigator-msg--err {
  align-self: flex-start; background: var(--sb-no-soft, #fef3f2); color: var(--sb-no, #b42318);
  border: 1px solid var(--sb-no-line, #f3c6c1); border-bottom-left-radius: 4px;
}

/* 기다리는 중. 점 세 개가 차례로 밝아진다 */
.navigator-dots { display: inline-flex; gap: 3px; margin-left: 4px; vertical-align: middle; }
.navigator-dots i {
  width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: .3;
  animation: navigator-blink 1.2s infinite;
}
.navigator-dots i:nth-child(2) { animation-delay: .2s; }
.navigator-dots i:nth-child(3) { animation-delay: .4s; }
@keyframes navigator-blink { 0%, 60%, 100% { opacity: .3 } 30% { opacity: 1 } }
@media (prefers-reduced-motion: reduce) {
  .navigator-dots i { animation: none; opacity: .6 }
}

.navigator-form {
  flex: 0 0 auto; display: flex; gap: 8px; padding: 10px;
  border-top: 1px solid var(--sb-line, #e4e7ec); background: var(--sb-fill, #f8f9fb);
}
.navigator-in {
  flex: 1 1 auto; min-width: 0; font: inherit; color: inherit;
  padding: 7px 10px; border: 1px solid var(--sb-line, #e4e7ec);
  border-radius: var(--sb-r, 6px); background: var(--sb-panel, #fff);
}
.navigator-in:focus { outline: none; border-color: var(--sb-accent, #1a56db); }
.navigator-send {
  flex: 0 0 auto; border: 1px solid var(--sb-accent, #1a56db);
  background: var(--sb-accent, #1a56db); color: #fff;
  border-radius: var(--sb-r, 6px); font: inherit; font-weight: 600;
  padding: 7px 14px; cursor: pointer;
}
.navigator-send:hover { filter: brightness(1.08); }
.navigator-send:disabled, .navigator-in:disabled { opacity: .55; cursor: default; filter: none; }

/*
 * 좁은 화면에서는 카드를 테두리 쪽으로 더 붙인다. 너비·높이는 여기서 잡지 않는다 —
 * JS 가 넣는 인라인 크기가 이기고, maxW()·maxH() 가 화면 안에 들어오도록 잘라 준다.
 */
@media (max-width: 560px) {
  .navigator-panel { left: 12px; bottom: 76px; }
  .navigator-fab { bottom: 16px; left: 16px; }
}
`

/** 스타일은 한 번만 넣는다. 같은 화면에 두 번 마운트해도 규칙이 겹치지 않게 */
function injectCss() {
  if (document.getElementById('navigator-chat-css')) return
  const style = document.createElement('style')
  style.id = 'navigator-chat-css'
  style.textContent = CSS
  document.head.appendChild(style)
}

/**
 * 남아 있는 대화를 읽는다. 깨져 있으면 빈 대화로 시작한다 — 여기서 던지면
 * 챗봇이 아예 열리지 않는다.
 *
 * @returns {Array<{role: string, content: string}>}
 */
export function readHistory() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter((m) => m && typeof m.content === 'string' && m.content)
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
  } catch {
    return []
  }
}

/** 최근 TURNS_MAX 턴만 남기고 적는다. sessionStorage 가 막혀 있어도 대화는 계속된다 */
function writeHistory(list) {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-TURNS_MAX * 2)))
  } catch (err) {
    console.warn('[navigator] 대화를 저장하지 못했다', err.message)
  }
}

/**
 * 남아 있는 카드 크기를 읽는다. 없거나 깨져 있으면 기본값이다.
 * @returns {{width: number, height: number}}
 */
export function readPanelSize() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(SIZE_KEY) || 'null')
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_SIZE }
    return clampSize({ width: Number(raw.width), height: Number(raw.height) })
  } catch {
    return { ...DEFAULT_SIZE }
  }
}

/** 끌기를 놓을 때 한 번 적는다. sessionStorage 가 막혀 있어도 이번 판에서는 그대로 쓴다 */
function writePanelSize(size) {
  try {
    sessionStorage.setItem(SIZE_KEY, JSON.stringify(size))
  } catch (err) {
    console.warn('[navigator] 카드 크기를 저장하지 못했다', err.message)
  }
}

/** 마우스든 손가락이든 좌표 한 쌍으로 본다 */
const point = (e) => {
  const t = e.touches?.[0] || e.changedTouches?.[0]
  return { x: t ? t.clientX : e.clientX, y: t ? t.clientY : e.clientY }
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  // 모델이 쓴 글이 그대로 온다. textContent 로만 넣는다 — innerHTML 이면 태그가 실행된다
  if (text !== undefined) n.textContent = text
  return n
}

/**
 * 챗봇을 띄운다. 버튼은 늘 보이고, 카드는 버튼을 눌렀을 때만 열린다.
 *
 * @param {HTMLElement} container - 보통 document.body (position:fixed 라서 어디든 된다)
 * @param {Object} opts
 * @param {Function} opts.onSend - (question: string) => Promise<string>. 답변 텍스트를 돌려준다
 * @returns {{open: Function, close: Function, toggle: Function, destroy: Function}}
 */
export function mountNavigatorChat(container, { onSend } = {}) {
  injectCss()

  const fab = el('button', 'navigator-fab')
  fab.type = 'button'
  fab.textContent = '💬'
  fab.title = '세계관 네비게이터'
  fab.setAttribute('aria-label', '세계관 네비게이터 열기')

  const panel = el('section', 'navigator-panel')
  panel.hidden = true
  panel.setAttribute('aria-label', '세계관 네비게이터')

  const head = el('header', 'navigator-head')
  const title = el('h2', 'navigator-title', '🧭 세계관 네비게이터')
  const resetBtn = el('button', 'navigator-btn', '대화 초기화')
  resetBtn.type = 'button'
  const closeBtn = el('button', 'navigator-btn navigator-btn--icon', '✕')
  closeBtn.type = 'button'
  closeBtn.title = '닫기'
  closeBtn.setAttribute('aria-label', '닫기')
  head.append(title, resetBtn, closeBtn)

  const log = el('div', 'navigator-log')
  log.setAttribute('role', 'log')
  log.setAttribute('aria-live', 'polite')

  const form = el('form', 'navigator-form')
  const input = el('input', 'navigator-in')
  input.type = 'text'
  input.placeholder = '그래프에 대해 물어보세요'
  input.maxLength = QUESTION_MAX
  input.setAttribute('aria-label', '질문')
  const send = el('button', 'navigator-send', '전송')
  send.type = 'submit'
  form.append(input, send)

  // 손잡이는 카드 안에 절대 위치로 앉는다. 머리의 버튼들은 테두리에서 10px 들어와 있어
  // 6px 짜리 손잡이와 겹치지 않는다
  const grip = (cls, axis) => {
    const h = el('div', `navigator-resize ${cls}`)
    h.setAttribute('aria-hidden', 'true')
    h.addEventListener('mousedown', (e) => { if (e.button === 0) startResize(e, axis) })
    h.addEventListener('touchstart', (e) => startResize(e, axis), { passive: false })
    return h
  }

  panel.append(
    grip('navigator-resize-top', 'y'),
    grip('navigator-resize-right', 'x'),
    grip('navigator-resize-corner', 'xy'),
    head, log, form,
  )
  container.append(fab, panel)

  let history = readHistory()
  let busy = false
  let size = readPanelSize()
  let dragging = false
  /** 지금 흘리고 있는 답변. 한 번에 하나만 돈다 — {node, text, timer, done} */
  let typer = null
  /**
   * 대화 초기화를 지난 횟수. 질문을 띄울 때 이 값을 챙겨 두고, 답이 왔을 때 값이
   * 달라져 있으면 그 답은 버린다 — 초기화한 판에 지난 대화가 되살아나지 않게 한다
   */
  let epoch = 0

  const scroll = () => { log.scrollTop = log.scrollHeight }
  /** 바닥에 붙어 있었나. 카드가 커질 때 읽던 자리를 잡아채지 않으려고 본다 */
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 8

  const applySize = () => {
    const stick = atBottom()
    panel.style.width = `${size.width}px`
    panel.style.height = `${size.height}px`
    if (stick) scroll()
  }

  /**
   * 손잡이 하나를 잡았다. bottom·left 는 고정이라 위로 끌면 높이가, 오른쪽으로 끌면
   * 너비가 자란다. 시작 크기에서 움직인 거리를 더하는 방식이라 끌기 중간에 클램프에
   * 걸려도 손과 테두리가 어긋나지 않는다.
   *
   * @param {MouseEvent|TouchEvent} e
   * @param {'x'|'y'|'xy'} axis - 늘릴 방향
   */
  function startResize(e, axis) {
    if (dragging) return
    dragging = true
    const from = point(e)
    const start = { ...size }
    const handle = e.currentTarget
    handle.classList.add('navigator-resize--on')

    // 끌는 동안 글자가 잡히지 않게. 원래 값으로 되돌려 놓는다 — 화면이 body 의
    // user-select 를 따로 쓰고 있을 수 있다
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'

    const move = (ev) => {
      const now = point(ev)
      if (!Number.isFinite(now.x) || !Number.isFinite(now.y)) return
      // 손가락으로 끌 때 화면이 같이 스크롤되는 것을 막는다 (touch-action 이 듣지 않는 판)
      if (ev.cancelable && ev.type === 'touchmove') ev.preventDefault()
      size = clampSize({
        width: axis === 'y' ? start.width : start.width + (now.x - from.x),
        height: axis === 'x' ? start.height : start.height - (now.y - from.y),
      })
      applySize()
    }

    const end = () => {
      dragging = false
      handle.classList.remove('navigator-resize--on')
      document.body.style.userSelect = prevSelect
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', end)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', end)
      window.removeEventListener('touchcancel', end)
      writePanelSize(size)
    }

    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', end)
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', end)
    window.addEventListener('touchcancel', end)
  }

  // 창이 작아지면 카드도 따라 줄인다. 저장된 크기는 그대로 둔다 — 창을 다시 넓히면
  // 다음 열기에서 원래 크기로 돌아온다
  const onWindowResize = () => {
    const next = clampSize(size)
    if (next.width === size.width && next.height === size.height) return
    size = next
    applySize()
  }
  window.addEventListener('resize', onWindowResize)

  const bubble = (who, text) => {
    const cls = who === 'user' ? 'navigator-msg--user'
      : who === 'err' ? 'navigator-msg--err' : 'navigator-msg--bot'
    const node = el('div', `navigator-msg ${cls}`, text)
    log.append(node)
    scroll()
    return node
  }

  /** 기다리는 중 말풍선. 답이 오면 이 칸을 글로 바꿔 끼운다 */
  const thinking = () => {
    const node = bubble('bot', '생각하는 중')
    const dots = el('span', 'navigator-dots')
    dots.append(el('i'), el('i'), el('i'))
    node.append(dots)
    return node
  }

  /**
   * 흘리던 글자를 멈춘다.
   *
   * @param {boolean} finish - true 면 남은 글자를 한 번에 채운다 (카드를 닫을 때 —
   *   다시 열면 답이 온전히 남아 있어야 한다). false 면 버린다 (대화 초기화 · 다 흘린 뒤)
   */
  const stopTyping = (finish) => {
    if (!typer) return
    const t = typer
    typer = null
    clearTimeout(t.timer)
    if (finish) t.node.textContent = t.text
    t.done()
  }

  /**
   * 답변 한 편을 글자 단위로 흘려 넣는다. 다 흘린 뒤에 resolve 한다 — 부르는 쪽(ask)이
   * 그때서야 입력창을 풀고 대화를 남긴다.
   *
   * 글자는 Text 노드의 data 에 이어 붙인다. textContent 로 매번 전체를 다시 넣으면
   * 답변이 길수록 한 틱에 드는 일이 늘어난다. 말풍선의 white-space:pre-wrap 은
   * 그대로라서 줄바꿈도 흘러가는 대로 보인다.
   *
   * @param {HTMLElement} node - 채울 말풍선. 안에 있던 것(생각하는 중 · 점 세 개)은 지운다
   * @param {string} text - 다 받아 둔 답변
   * @returns {Promise<void>} 다 흘렸거나 멈췄을 때
   */
  const typeInto = (node, text) => new Promise((done) => {
    stopTyping(true) // 앞의 답이 흘러가는 중이면 거기까지 끝맺고 이어받는다
    node.textContent = ''
    if (!text || reduceMotion()) {
      node.textContent = text
      return done()
    }
    const chunk = document.createTextNode('')
    node.append(chunk)
    typer = { node, text, timer: 0, done }
    let at = 0
    const step = () => {
      // 읽던 자리를 잡아채지 않는다 — 바닥에 붙어 있었을 때만 따라 내린다
      const stick = atBottom()
      const upto = Math.min(text.length, at + typeRate(at))
      chunk.data += text.slice(at, upto)
      at = upto
      if (stick) scroll()
      if (at >= text.length) return stopTyping(false)
      typer.timer = setTimeout(step, TYPE_TICK_MS)
    }
    step()
  })

  /** 판을 다시 그린다. 대화가 비어 있으면 안내만 놓는다 */
  const draw = () => {
    log.textContent = ''
    if (!history.length) bubble('bot', INTRO)
    else for (const m of history) bubble(m.role === 'user' ? 'user' : 'bot', m.content)
  }

  const lock = (on) => {
    busy = on
    send.disabled = on
    input.disabled = on
  }

  async function ask(question) {
    const era = epoch
    lock(true)
    bubble('user', question)
    const wait = thinking()
    try {
      const answer = String((await onSend?.(question)) ?? '').trim()
      // 기다리는 동안 대화를 초기화했다. 이 답은 갈 자리가 없다
      if (era !== epoch) return
      await typeInto(wait, answer || '(빈 답변이 왔습니다. 다시 물어봐 주세요.)')
      // 오간 한 턴이 다 있을 때만 남긴다 — 실패한 질문을 남기면 다음 질문의
      // 컨텍스트에 답 없는 질문이 섞인다
      if (answer && era === epoch) {
        history = [...history, { role: 'user', content: question }, { role: 'assistant', content: answer }]
          .slice(-TURNS_MAX * 2)
        writeHistory(history)
      }
    } catch (err) {
      console.warn('[navigator] 답변 실패', err)
      if (era !== epoch) return
      wait.remove()
      /*
       * err.retry 가 false 면 「잠시 뒤 다시」를 붙이지 않는다. 권한이 없어 막힌 것처럼
       * 기다려서 바뀌지 않는 실패가 있고, 그때 다시 물어보라고 하면 사람을 같은 자리로
       * 계속 돌려보낸다. 무엇이 안 되고 누구면 되는지는 onSend 를 넘긴 화면이 안다
       * (이 모듈은 네트워크도 로그인도 모른다). 그래서 문장은 그쪽에서 온다.
       */
      bubble('err', err?.retry === false
        ? err.message
        : (err?.message || '답변을 받지 못했습니다. 잠시 뒤 다시 물어봐 주세요.'))
    } finally {
      lock(false)
      scroll()
      if (!panel.hidden) input.focus()
    }
  }

  form.addEventListener('submit', (e) => {
    // input 하나짜리 form 이라 Enter 도 여기로 온다 — 키 처리를 따로 두지 않는다
    e.preventDefault()
    const question = input.value.trim()
    if (!question || busy) return
    input.value = ''
    ask(question)
  })

  resetBtn.onclick = () => {
    epoch += 1
    stopTyping(false) // 흘리던 글자는 버린다. 판을 지우니 남길 곳이 없다
    history = []
    try { sessionStorage.removeItem(HISTORY_KEY) } catch { /* 막혀 있으면 화면만 지운다 */ }
    draw()
    input.focus()
  }

  const setOpen = (on) => {
    // 안 보이는 카드에 타이머를 돌려 두지 않는다. 남은 글자는 한 번에 채워 둔다 —
    // 다시 열었을 때 답이 중간에 끊긴 채로 남아 있으면 안 된다
    if (!on) stopTyping(true)
    // 열 때마다 남아 있는 크기를 다시 읽는다 — 창이 작아져 줄었던 카드가 원래 크기로 돌아온다
    if (on) { size = readPanelSize(); applySize() }
    panel.hidden = !on
    fab.setAttribute('aria-expanded', String(on))
    fab.setAttribute('aria-label', on ? '세계관 네비게이터 닫기' : '세계관 네비게이터 열기')
    if (on) { scroll(); input.focus() }
  }

  fab.onclick = () => setOpen(panel.hidden)
  closeBtn.onclick = () => setOpen(false)
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false) })

  applySize()
  draw()
  setOpen(false)

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(panel.hidden),
    destroy: () => {
      stopTyping(false)
      window.removeEventListener('resize', onWindowResize)
      fab.remove()
      panel.remove()
    },
  }
}
