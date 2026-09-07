/*
 * 프로젝트 서랍. 이 프로젝트가 무엇을 들고 있는지 한 화면에 폅니다.
 *
 * ══ 무엇을 고치려고 만든 화면인가
 *
 * 프로젝트에 무엇이 들었는지 볼 자리가 없었습니다. 홈의 카드에는 「마지막에 누가 뭘
 * 했다」한 줄뿐이고(services/projects.js 의 lastWhat), 안의 대본이나 씬은 화면을 하나씩
 * 열어 봐야 알았습니다. 들어가는 길도 step 1-2-3-4 흐름으로만 나 있어서, 이미 만들어 둔
 * 스토리보드가 무엇을 담고 있는지가 특히 보이지 않았습니다.
 *
 * 그래서 프로젝트를 「단계의 흐름」이 아니라 「에셋의 서랍」으로 봅니다. 여섯 줄이 서고,
 * 각 줄은 있으면 요약과 「열기」, 없으면 회색 글씨와 「만들기」입니다. 어느 단계를
 * 거쳤는지는 묻지 않습니다.
 *
 * ══ 빈 칸을 경고로 그리지 않습니다
 *
 * 콘티가 비어 있어도 이 프로젝트는 온전합니다. 대본과 시놉시스만 들고 계속 일하는
 * 사람에게 「4단계까지 못 갔다」고 말하지 않는 것이 이 화면의 핵심입니다. 그래서 빈
 * 줄에는 느낌표도 빨간색도 없습니다.
 *
 * ══ 한 번 읽어 그립니다
 *
 * 에셋은 op 와 같은 pk 에 살아서(services/assets.js) 프로젝트 하나의 여섯 줄이 Query 한
 * 번에 옵니다. 본문까지 통째로 받으므로 대본 미리보기도 다시 읽지 않고 펼칩니다.
 * 요약을 저장해 두지 않는 이유가 이것입니다. 본문이 이미 손에 있으면 요약은 그때
 * 만들면 되고, 저장해 두면 본문과 어긋날 자리가 하나 늘어납니다.
 */
import { ASSET_KINDS, summarize } from '../domain/assets.js'
import { loadAssets } from '../services/assets.js'
import { list as listProjects } from '../services/projects.js'
import { navHref, boardParam } from '../domain/routes.js'
import { configured, session } from '../services/auth.js'
import { showLogin, DEMO_USERS } from '../components/login-form.js'
import { mountBrand } from '../components/brand.js'
import { when } from '../components/history-list.js'
import { esc, setHtml } from '../lib/dom.js'

const byId = (id) => document.getElementById(id)
const say = (t) => { byId('live').textContent = t }

/*
 * 어느 프로젝트인지. 여기서는 boardFromSearch 가 아니라 boardParam 을 씁니다.
 *
 * boardFromSearch 는 주소에 board 가 없으면 기본 보드로 떨어집니다(routes.js). 작업
 * 화면에서는 그게 맞습니다. 무엇이든 하나는 열려 있어야 하니까요. 그런데 이 화면은
 * 「그 프로젝트에 무엇이 있나」를 말하는 자리라서, 어느 프로젝트인지 모르는데 기본
 * 보드의 내용을 보여주면 그것이 거짓이 됩니다. 주소가 말하지 않으면 말하지 않습니다.
 */
const BOARD = boardParam()

/** 프로젝트 카드. 이름과 만든 사람이 여기서 옵니다 */
let card = null
/** kind → { body, actor, updatedAt } */
let assets = {}

/** actor id → 이름. 카드와 에셋에는 id 만 있어서 데모 계정 표로 사람 이름을 찾습니다 */
const NAMES = new Map(DEMO_USERS.map((u) => [u.id, u.name]))
const nameOf = (id) => NAMES.get(id) || id || ''

/* ══ 그리기 ════════════════════════════════════════ */

function paintHead() {
  const title = card?.name || BOARD
  document.title = `${title} · 여름 스튜디오`
  byId('pjName').textContent = title
  if (!card) { byId('pjSub').textContent = ''; return }
  /*
   * 「○○○가 만들었습니다」로 쓰지 않습니다. 이/가는 앞 글자의 받침에 따라 갈리는데
   * 사람 이름이 들어오는 자리라서 하나로 박으면 「이도현가」가 됩니다. 조사를 아예
   * 두지 않는 편이 안전합니다.
   */
  const made = card.createdBy ? `만든 사람 ${nameOf(card.createdBy)}` : ''
  const last = card.updatedAt ? `마지막 손길 ${when(Number(card.updatedAt))}` : ''
  byId('pjSub').textContent = [made, last].filter(Boolean).join(' · ')
}

/**
 * 여섯 줄의 재료. 요약을 한 번만 만듭니다.
 *
 * summarize 를 그리는 곳마다 부르면 같은 본문을 여러 번 훑고, 무엇보다 「있다」의
 * 기준이 여러 곳에 흩어집니다. 여기서 한 번 정하고 아래는 그것만 봅니다.
 */
const rows = () => ASSET_KINDS.map((k) => {
  const got = assets[k.key]
  const sum = summarize(k.key, got?.body)
  return { kind: k, got, sum, none: sum === null }
})

/*
 * 「열기」와 「만들기」가 같은 곳으로 갑니다. 그 에셋을 만드는 화면입니다. 말만 다른
 * 이유는 사람이 하려는 일이 다르기 때문입니다. 있는 것은 보러 가고 없는 것은 만들러
 * 갑니다. 주소에 ?board= 를 늘 답니다. 빼면 그 화면이 「아직 프로젝트를 고르지 않았다」
 * 로 보고 문을 다시 세웁니다(components/project-picker.js 의 pickProject).
 */
function paintAssets(list) {
  byId('haveN').textContent = `${list.filter((r) => !r.none).length}/${list.length}`

  setHtml(byId('assets'), list.map(({ kind, got, sum, none }) => {
    const who = none || !got?.updatedAt ? ''
      : `${when(Number(got.updatedAt))} ${nameOf(got.actor)}`

    return `<div class="as ${none ? 'as--none' : ''}">
      <span class="as__name">${esc(kind.label)}</span>
      <span class="as__sum">${none ? '아직 없습니다' : esc(sum)}</span>
      <span class="as__who">${esc(who)}</span>
      <a class="as__go" href="${esc(navHref(kind.step, BOARD))}">${
        esc(none ? kind.make : '열기')}</a>
      ${peek(kind, got, none)}
    </div>`
  }).join(''))
}

/*
 * 대본과 시놉시스는 여기서 바로 펼쳐 읽습니다.
 *
 * 무엇이 들었는지 보러 온 사람에게 가장 자주 필요한 것이 「그 대본이 맞나」입니다.
 * 그것을 확인하려고 편집 화면을 열게 하면 확인만 하려다 실수로 고칩니다. 나머지
 * 넷(그래프·씬·키비주얼·콘티)은 글이 아니라 그림이나 목록이라서 여기서 펼쳐 봐야
 * 읽히지 않습니다. 그것들은 자기 화면에서 봅니다.
 */
function peek(kind, got, none) {
  if (none) return ''
  const b = got.body
  const text = kind.key === 'script' ? String(b ?? '')
    : kind.key === 'synopsis' ? [b?.logline, b?.synopsis].filter(Boolean).join('\n\n')
      : ''
  if (!text.trim()) return ''
  return `<details class="peek">
    <summary>내용 보기</summary>
    <div class="peek__body">${esc(text)}</div>
  </details>`
}

function paintNote(list) {
  byId('assetNote').textContent = list.some((r) => !r.none)
    ? '「열기」는 그 에셋을 만든 화면으로 갑니다. 같은 프로젝트를 이어서 봅니다. '
      + '빈 줄이 있어도 괜찮습니다. 필요한 것만 만들어 두고 쓰셔도 됩니다.'
    : '아직 아무것도 없습니다. 위의 「만들기」 중 하나를 누르면 그 화면에서 이 프로젝트로 '
      + '시작합니다. 어디서부터 시작해도 됩니다.'
}

/**
 * 보여줄 것이 없을 때. 서랍을 접고 이유와 나갈 길을 답니다.
 *
 * why 를 이스케이프하지 않습니다. 부르는 쪽이 넘기는 것은 이미 만들어 둔 조각이고,
 * 그 안에 사람이 넣은 값(프로젝트 이름 같은 것)은 부르는 쪽에서 esc 를 거쳐 옵니다.
 * 여기서 통째로 한 번 더 씌우면 같이 넘어온 링크가 글자로 보입니다.
 *
 * @param {string} why - 이미 이스케이프를 마친 HTML 조각
 */
function paintGone(why) {
  byId('body').hidden = true
  const g = byId('gone')
  g.hidden = false
  setHtml(g, `${why} <a href="/?view=projects">우리 팀 프로젝트로 돌아가기</a>`)
}

/* ══ 시작 ══════════════════════════════════════════ */

async function boot() {
  mountBrand('#brandMount')

  if (!BOARD) {
    byId('pjName').textContent = '프로젝트를 고르지 않았습니다'
    paintGone('주소에 어느 프로젝트인지가 없습니다.')
    return
  }

  // 카드를 읽기 전까지는 boardId 를 걸어 둡니다. 「…」보다는 이것이 사실입니다
  byId('pjName').textContent = BOARD

  if (configured) {
    // 이미 로그인돼 있으면 문을 띄우지 않습니다. 다른 화면과 같은 세션을 씁니다
    if (!session()) await showLogin(byId('gate'))
    const me = session()
    if (me) {
      byId('meBox').hidden = false
      byId('meWho').textContent = `${me.name} · ${me.id}`
    }
  }

  /*
   * 카드와 에셋을 나란히 읽습니다. 카드는 이름을 주고 에셋은 내용을 줍니다. 둘은 서로를
   * 기다릴 필요가 없습니다. 카드를 못 읽어도 에셋은 그립니다(이름 자리에 boardId 가 섭니다).
   */
  const [cards, got] = await Promise.all([
    listProjects().catch((e) => {
      console.warn('[project] 프로젝트 목록을 읽지 못했습니다', e.message)
      return []
    }),
    loadAssets(BOARD),
  ])

  card = cards.find((p) => p.boardId === BOARD) || null
  assets = got
  paintHead()

  if (!card && !Object.keys(assets).length) {
    /*
     * 카드도 없고 에셋도 없습니다. 그래도 「빈 프로젝트」라고 단정하지 않습니다. 컷은
     * 에셋이 아니라 op 로그에 있고 이 화면은 그것을 읽지 않으므로, 콘티만 있는 옛 보드가
     * 여기서는 텅 빈 것으로 보입니다. 그래서 보드를 직접 열어 볼 길을 같이 냅니다.
     */
    paintGone(`「${esc(BOARD)}」로 저장된 에셋을 찾지 못했습니다. `
      + `<a href="${esc(navHref('board', BOARD))}">스토리보드를 직접 열어 보시거나</a>,`)
    return
  }

  const list = rows()
  byId('gone').hidden = true
  byId('body').hidden = false
  paintAssets(list)
  paintNote(list)
  say(`${card?.name || BOARD} 프로젝트를 열었습니다. `
    + `에셋 ${list.filter((r) => !r.none).length}개가 있습니다.`)
}

boot()
