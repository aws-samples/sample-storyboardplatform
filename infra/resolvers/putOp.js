import { util } from '@aws-appsync/utils'

/*
 * op 한 개를 로그에 쌓습니다.
 *
 * ══ TTL 을 걸지 않습니다
 *
 * 전에는 30일 TTL 이 있었습니다. 그런데 이 로그는 「최근 활동 기록」이 아니라 판 그
 * 자체입니다. 배포에서 컷은 op 로그에만 있습니다 — board.js 의 저장은 AWS 모드에서
 * 일찍 돌아서고(keepConti 는 개수만 남깁니다), 화면은 부팅 때 listOps 를 처음부터
 * 다시 재생해 판을 세웁니다. TTL 이 지나면 오래된 op 부터 사라지고, 한 달 쉰 프로젝트를
 * 열면 컷이 조용히 비어 있습니다. 그것도 골고루 비는 것이 아니라 예전에 만든 컷만
 * 사라지고 최근 것만 남아, 남은 op 가 없는 컷을 가리키는 어긋난 판이 됩니다.
 *
 * putAsset.js·putProject.js 가 TTL 을 걸지 않는 것과 같은 판단입니다. 로그가 길어지는
 * 것은 사실이고, 줄여야 할 때는 지우는 것이 아니라 접는 쪽입니다 — 판의 지금 모습을
 * 스냅샷으로 한 항목에 적고 그보다 앞선 op 를 버리는 것입니다. 그때 이 파일과
 * listOps.js 를 같이 고칩니다.
 */

export function request(ctx) {
  const { boardId, id, ts, actor, body } = ctx.args
  guardRole(ctx, body)
  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({ pk: `BOARD#${boardId}`, sk: `OP#${ts}#${id}` }),
    attributeValues: util.dynamodb.toMapValues({ boardId, id, ts, actor, body }),
  }
}

// 자산(asset.*) op 를 보낼 수 있는 역할. domain/permissions.js 의 extract 와 같습니다 — 리뷰어만 막습니다
const ASSET_ROLES = ['planner', 'artist', 'director', 'admin']

function guardRole(ctx, body) {
  const op = JSON.parse(body)
  if (!op) return
  const claims = ctx.identity?.claims || {}
  const meId = claims['cognito:username']
  const myRole = claims['custom:role'] || 'reviewer'
  const isAdmin = myRole === 'admin'

  // 자산은 팀의 것이라 화면이 막는 것만으로는 모자랍니다. op 를 직접 보내는 리뷰어를 여기서 막습니다
  // APPSYNC_JS 에는 String() 이 없다. kind 는 문자열이거나 없다
  const kind = op.kind || ''
  if (kind.indexOf && kind.indexOf('asset.') === 0) {
    if (ASSET_ROLES.indexOf(myRole) < 0) util.unauthorized()
    return
  }
  if (op.kind !== 'member.role' && op.kind !== 'member.set') return

  if (op.kind === 'member.role') {
    if (!isAdmin) util.unauthorized()
    return
  }
  const m = op.member || {}
  if (isAdmin || !m.role) return
  if (m.id !== meId || m.role !== myRole) util.unauthorized()
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return ctx.result
}
