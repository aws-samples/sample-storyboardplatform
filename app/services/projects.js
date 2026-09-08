/*
 * 프로젝트 카드의 저장소입니다. 배포에서는 AppSync, 로컬에서는 브라우저 저장소이고
 * 두 판의 메서드 이름·인자·반환 모양이 같아서 부르는 쪽은 어디인지 모릅니다.
 *
 * ══ 왜 op 로그에 같이 담지 않는가
 *
 * op 는 pk=BOARD#<boardId> 로 보드마다 흩어져 있습니다. 즉 「보드가 몇 개 있나」를
 * 물으려면 테이블 전체를 훑어야 합니다(Query 가 아니라 Scan). 게다가 op 에는 30일
 * TTL 이 걸려 있어서(infra/resolvers/putOp.js), 한 달 쉰 프로젝트는 이름까지 사라져
 * 카드가 빈칸이 됩니다.
 *
 * 그래서 카드는 같은 테이블의 pk='PROJECTS' 한 자리에 모으고 TTL 을 걸지 않습니다.
 * 테이블을 새로 만들지 않은 것은 이것이 같은 사실의 색인이기 때문입니다.
 *
 * ══ 카드의 「마지막 손길」은 사본입니다
 *
 * lastWhat·lastActor 는 op 로그에서 온 것을 카드에 적어 둔 사본입니다. 카드 스무 장을
 * 그리려고 보드 스무 개의 로그를 다 읽을 수는 없습니다. 사본이 어긋날 수 있다는 뜻이고,
 * 어긋나도 됩니다. 카드는 「여기였다」를 알려 주는 표지이고, 판을 열면 로그가 사실을
 * 말합니다.
 */

import { projectsClient } from './api.js'

/** 로컬 모드의 프로젝트 목록. Cognito·AppSync 가 없을 때만 씁니다 */
const LOCAL_KEY = 'sb.projects.v1'

/**
 * 프로젝트 이름 → 주소에 쓸 id.
 *
 * 한글 이름은 ASCII 로 남는 것이 없어 거의 늘 'p-…' 가 됩니다. 이름을 그대로 id 로
 * 쓰지 않는 이유는 두 가지입니다. 주소가 퍼센트 인코딩으로 뒤덮이고, 같은 이름을 두
 * 번 만들면 두 팀이 한 판을 쓰게 됩니다. 뒤에 붙는 무작위 조각이 그것을 막습니다.
 */
export function newBoardId(name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 24)
  const tail = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`
  return `${slug || 'p'}-${tail}`
}

/* ══ 저장소 ════════════════════════════════════════ */

const localList = () => {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

/*
 * 로컬 모드의 put. AppSync 쪽 putProject.js 와 같은 규칙을 지킵니다. 이름은 처음
 * 한 번만 박고, 그 뒤로는 마지막 손길만 고칩니다. 두 곳의 규칙이 다르면 로컬에서
 * 되던 것이 배포에서 다르게 돌아 읽는 사람이 헷갈립니다.
 */
const localPut = ({ boardId, name, actor, what, ts }) => {
  const list = localList()
  const at = list.findIndex((p) => p.boardId === boardId)
  const prev = at < 0 ? null : list[at]
  const row = {
    boardId,
    name: prev?.name || name || boardId,
    createdAt: prev?.createdAt || String(ts),
    createdBy: prev?.createdBy || actor,
    updatedAt: String(ts),
    lastActor: actor,
    lastWhat: what || prev?.lastWhat || '',
  }
  if (at < 0) list.push(row)
  else list[at] = row
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list.slice(-100))) } catch { /* 꽉 찬 저장소 */ }
  return row
}

/*
 * 로컬 모드의 삭제. 배포 쪽 deleteProject.js 와 같은 것을 지웁니다.
 *
 * 배포에서 지우는 세 갈래가 로컬에서는 세 칸입니다. 카드 목록 한 줄(LOCAL_KEY), 에셋
 * (sb.assets.<boardId> — services/assets.js 의 localKey), 보드 상태(sb.state.<boardId> —
 * pages/board.js). 셋을 다 지우지 않으면 같은 이름으로 판을 새로 만들 때 옛 컷이 따라
 * 나옵니다.
 *
 * 세는 것도 배포 쪽과 모양을 맞춥니다. 로컬에는 op 줄이라는 것이 따로 없어서(보드 상태
 * 한 칸에 뭉쳐 있습니다) ops 는 그 칸이 있었으면 1 입니다. 정확한 수를 셀 수 없는
 * 자리이고, 화면은 이 값으로 「무엇을 잃었나」만 말합니다.
 */
const localRemove = (boardId) => {
  const list = localList()
  const at = list.findIndex((p) => p.boardId === boardId)
  const card = at >= 0
  if (card) {
    list.splice(at, 1)
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)) } catch { /* 꽉 찬 저장소 */ }
  }
  let assets = 0
  let ops = 0
  try {
    const kept = localStorage.getItem(`sb.assets.${boardId}`)
    if (kept) {
      const v = JSON.parse(kept)
      assets = v && typeof v === 'object' ? Object.keys(v).length : 0
    }
    localStorage.removeItem(`sb.assets.${boardId}`)
    if (localStorage.getItem(`sb.state.${boardId}`)) ops = 1
    localStorage.removeItem(`sb.state.${boardId}`)
  } catch { /* 못 읽어도 지우기는 끝난 것으로 봅니다 */ }
  return { boardId, ops, assets, card, left: 0, graph: 'skipped' }
}

/**
 * 프로젝트 저장소. 배포에서는 AppSync, 로컬에서는 브라우저 저장소입니다.
 * 두 판의 메서드 이름·인자·반환 모양이 같아서 부르는 쪽은 어디인지 모릅니다.
 *
 * @returns {{mode: string, list: Function, put: Function, remove: Function}}
 */
export function store() {
  const net = projectsClient()
  if (net) return { mode: 'aws', list: net.list, put: net.put, remove: net.remove }
  return {
    mode: 'local',
    list: async () => localList(),
    put: async (o) => localPut({ ...o, ts: o.ts ?? Date.now() }),
    remove: async (boardId) => localRemove(boardId),
  }
}

/**
 * 「누가 마지막으로 뭘 했는지」를 카드에 적어 둡니다.
 *
 * 기록이 화면의 본 일은 아니므로 실패를 던지지 않습니다. op 로그가 이미 사실을 들고
 * 있고, 이것은 목록에 보이는 한 줄입니다. 사실이 남았는데 표지가 못 붙었다고 작업을
 * 멈출 이유가 없습니다.
 *
 * @param {object} o
 * @param {string} o.boardId
 * @param {string} o.actor
 * @param {string} [o.what] - 한 일. history.js 의 what 과 같은 문장을 넣습니다
 * @param {string} [o.name] - 처음 만들 때만. 이미 있는 카드의 이름은 덮이지 않습니다
 * @returns {Promise<object|null>}
 */
export async function touch({ boardId, actor, what, name } = {}) {
  if (!boardId) return null
  try {
    return await store().put({ boardId, name, actor: actor || 'local', what, ts: Date.now() })
  } catch (e) {
    console.warn('[projects] 카드를 갱신하지 못했다', e.message)
    return null
  }
}

/**
 * 카드 목록. 최근에 손댄 것이 먼저 옵니다.
 *
 * 정렬을 리졸버가 아니라 여기서 하는 이유는 sk 가 P#<boardId> 라서 DynamoDB 가
 * 돌려주는 순서가 이름 순이라는 것입니다. updatedAt 순으로 받으려면 GSI 를 하나 더
 * 세워야 하는데, 카드는 수십 장이라 여기서 세우는 편이 싸고 읽기 쉽습니다.
 *
 * @returns {Promise<Array>}
 */
export async function list() {
  const rows = await store().list()
  return [...rows].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
}

/**
 * 프로젝트 하나를 지웁니다. 카드 · 에셋 · op 로그 · Neptune 그래프 전부입니다.
 *
 * ══ touch 와 달리 실패를 던집니다
 *
 * 그쪽은 목록에 보이는 한 줄이라 못 붙어도 사실이 남습니다. 이쪽은 반대입니다. 못
 * 지웠는데 「지웠습니다」로 넘어가면 목록을 새로 읽을 때 그 프로젝트가 그대로 있고,
 * 사람은 자기가 뭘 잘못 눌렀는지 모릅니다.
 *
 * ══ 권한은 서버가 봅니다
 *
 * 감독만 지울 수 있습니다(infra/resolvers/deleteProject.js 의 ROLES). 여기서 역할을
 * 다시 보지 않는 이유는 이 파일이 세션을 모른다는 것입니다 — 화면이 누르기 전에
 * domain/permissions.js 로 미리 막고, 서버의 거부는 그대로 올라옵니다.
 *
 * @param {string} boardId
 * @returns {Promise<{boardId: string, ops: number, assets: number, card: boolean,
 *   left: number, graph: string}>} 지운 셈. left 가 0 이 아니면 다 못 지웠습니다
 */
export async function remove(boardId) {
  if (!boardId) throw new Error('어느 프로젝트인지 모릅니다')
  return store().remove(boardId)
}

