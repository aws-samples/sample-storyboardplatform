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

/**
 * 프로젝트 저장소. 배포에서는 AppSync, 로컬에서는 브라우저 저장소입니다.
 * 두 판의 메서드 이름·인자·반환 모양이 같아서 부르는 쪽은 어디인지 모릅니다.
 *
 * @returns {{mode: string, list: Function, put: Function}}
 */
export function store() {
  const net = projectsClient()
  if (net) return { mode: 'aws', list: net.list, put: net.put }
  return {
    mode: 'local',
    list: async () => localList(),
    put: async (o) => localPut({ ...o, ts: o.ts ?? Date.now() }),
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

