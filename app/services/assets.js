/*
 * 프로젝트 에셋의 저장소입니다. 배포에서는 AppSync, 로컬에서는 브라우저 저장소이고
 * 두 판의 메서드 이름·인자·반환 모양이 같아서 부르는 쪽은 어디인지 모릅니다.
 * services/projects.js 와 같은 짜임입니다.
 *
 * ══ 이것이 없던 동안 무슨 일이 있었나
 *
 * 대본과 씬은 아무 곳에도 저장되지 않았습니다. story-graph 의 대본 칸은 DOM 의
 * textarea 값이고, key-visual 의 S.script · S.scenes 는 그냥 전역 변수였습니다.
 * 그래서 두 가지가 따라왔습니다.
 *
 *   하나. 새로고침 한 번에 작업이 사라졌습니다. 1·2 단계만 하는 사람은 자기 작업을
 *   이어서 할 수가 없었습니다.
 *
 *   둘. 화면 사이를 사람이 손으로 이었습니다. 스토리 디벨롭에서 만든 대본을 긁어서
 *   키비주얼의 대본 칸에 붙였습니다. step 1-2-3 이 이어진 것처럼 보였던 것은 화면
 *   순서일 뿐이고, 데이터로는 끊겨 있었습니다.
 *
 * 이 파일이 그 두 가지를 함께 없앱니다. 화면들이 같은 자리를 읽고 쓰면 저장이 되면서
 * 동시에 이어집니다.
 *
 * ══ op 로그에 담지 않은 이유
 *
 * op 는 pk=BOARD#<boardId> 에 쌓이고 30일 TTL 이 걸려 있습니다(infra/resolvers/putOp.js).
 * 대본을 거기 담으면 한 달 쉰 프로젝트의 대본이 사라집니다. 그리고 op 는 「무슨 일이
 * 있었나」의 목록이라서 대본을 한 자 고칠 때마다 전문이 한 벌 더 쌓입니다.
 *
 * 그래서 같은 파티션의 sk='ASSET#<kind>' 한 항목에 덮어씁니다. 같은 pk 라서 프로젝트
 * 하나의 에셋 전부가 Query 한 번에 오고, TTL 이 없어서 사라지지 않습니다. 프로젝트
 * 카드가 pk='PROJECTS' 에 TTL 없이 사는 것과 같은 판단입니다.
 *
 * ══ 이력은 남지 않습니다
 *
 * 덮어쓰기라서 두 사람이 같은 에셋을 동시에 저장하면 나중 쪽이 이깁니다. 지금은 그대로
 * 둡니다. 한 프로젝트의 대본을 두 사람이 같은 순간에 다르게 고치는 일은 이 규모에서
 * 드물고, 컷처럼 여러 사람이 동시에 만지는 것은 여전히 op 로그에 있어서 거기서는
 * 필드마다 합쳐집니다(app/domain/panels.js 의 mergeField).
 */

import { assetsClient } from './api.js'
import { isAssetKind, fitsAsset } from '../domain/assets.js'

/**
 * 로컬 모드의 에셋 자리. 프로젝트마다 다릅니다.
 *
 * board.js 의 sb.state.<boardId> 와 같은 규칙입니다. 한 칸에 몰아 두면 A 를 열었다가
 * B 를 열면 A 의 대본이 B 에 나타납니다.
 */
const localKey = (boardId) => `sb.assets.${boardId}`

const localAll = (boardId) => {
  try {
    const v = JSON.parse(localStorage.getItem(localKey(boardId)) || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

/*
 * 로컬 모드의 put. AppSync 쪽 putAsset.js 와 같은 규칙을 지킵니다. 같은 kind 를 다시
 * 쓰면 덮어씁니다. 두 곳의 규칙이 다르면 로컬에서 되던 것이 배포에서 다르게 돌아
 * 읽는 사람이 헷갈립니다.
 *
 * 저장소가 꽉 차는 것은 삼킵니다. 대본 전문이 들어오므로 로컬에서는 실제로 찰 수
 * 있습니다. 그때 화면을 멈추기보다 「못 담았다」를 부르는 쪽에 알려 주는 편이 낫습니다.
 */
const localPut = ({ boardId, kind, body, actor, ts }) => {
  const all = localAll(boardId)
  const row = { boardId, kind, body, actor, updatedAt: String(ts) }
  all[kind] = row
  try {
    localStorage.setItem(localKey(boardId), JSON.stringify(all))
  } catch (e) {
    throw new Error(`브라우저 저장소가 꽉 찼습니다. ${e.name}`)
  }
  return row
}

/**
 * 에셋 저장소. 배포에서는 AppSync, 로컬에서는 브라우저 저장소입니다.
 * @returns {{mode: string, list: Function, put: Function}}
 */
export function store() {
  const net = assetsClient()
  if (net) return { mode: 'aws', list: net.list, put: net.put }
  return {
    mode: 'local',
    list: async (boardId) => Object.values(localAll(boardId)),
    put: async (o) => localPut({ ...o, ts: o.ts ?? Date.now() }),
  }
}

/**
 * 프로젝트 하나의 에셋 전부. kind → { body, actor, updatedAt } 입니다.
 *
 * 못 읽으면 빈 객체입니다. 던지지 않습니다. 서랍은 「무엇이 들었는지」를 보여주는
 * 화면이고, 읽지 못한 것은 「아직 없음」으로 그려도 사람이 다시 눌러 볼 수 있습니다.
 * 못 읽은 것을 없는 것으로 그리는 것이 거짓이 될 자리는 저장할 때입니다. 그래서
 * put 은 반대로 실패를 그대로 던집니다.
 *
 * @param {string} boardId
 * @returns {Promise<Object<string, {body: *, actor: string, updatedAt: string}>>}
 */
export async function loadAssets(boardId) {
  if (!boardId) return {}
  let rows = []
  try {
    rows = await store().list(boardId)
  } catch (e) {
    console.warn('[assets] 에셋을 읽지 못했습니다', e.message)
    return {}
  }
  const out = {}
  for (const r of rows) {
    // 모르는 kind 는 버립니다. 종류를 지운 뒤에 남은 항목이 서랍에 이름 없는 줄로 서면
    // 사람은 그것이 무엇인지 알 수 없고 지울 수도 없습니다
    if (!isAssetKind(r?.kind)) continue
    out[r.kind] = { body: r.body, actor: r.actor, updatedAt: r.updatedAt }
  }
  return out
}

/**
 * 에셋 하나만 읽습니다. 없으면 null 입니다.
 *
 * 한 종류만 필요한 화면이 씁니다(키비주얼이 대본을 받아 갈 때). 저장소가 kind 하나만
 * 집어 오는 길을 따로 두지 않은 이유는, 한 프로젝트의 에셋이 여섯 항목뿐이라 통째로
 * 읽는 것과 값이 거의 같기 때문입니다. 길을 하나 더 두면 배포할 리졸버가 하나 늘고
 * 두 길의 동작이 어긋날 자리가 생깁니다.
 *
 * @param {string} boardId
 * @param {string} kind
 * @returns {Promise<*|null>} 본문. 없으면 null
 */
export async function loadAsset(boardId, kind) {
  const all = await loadAssets(boardId)
  return all[kind]?.body ?? null
}

/**
 * 에셋 하나를 저장합니다.
 *
 * projects.js 의 touch 와 달리 실패를 삼키지 않고 던집니다. 그쪽은 목록에 보이는 한
 * 줄이라 못 붙어도 사실이 남아 있지만, 이쪽은 사실 그 자체입니다. 「저장했습니다」라고
 * 말한 뒤에 대본이 없으면 사람은 그 다음에야 알게 됩니다.
 *
 * 너무 큰 본문은 서버에 보내지 않고 여기서 막습니다. 자르지 않습니다. 조용히 자르면
 * 대본이 반토막인 것을 아무도 모릅니다(domain/assets.js 의 fitsAsset).
 *
 * @param {object} o
 * @param {string} o.boardId
 * @param {string} o.kind - ASSET_KINDS 의 key
 * @param {*} o.body - 본문. 문자열이거나 객체입니다
 * @param {string} [o.actor]
 * @returns {Promise<object>} 저장한 행
 */
export async function saveAsset({ boardId, kind, body, actor } = {}) {
  if (!boardId) throw new Error('어느 프로젝트인지 모릅니다')
  if (!isAssetKind(kind)) throw new Error(`모르는 에셋 종류입니다: ${kind}`)

  const fit = fitsAsset(body)
  if (!fit.ok) throw new Error(fit.why)

  return store().put({ boardId, kind, body, actor: actor || 'local', ts: Date.now() })
}
