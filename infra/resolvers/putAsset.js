import { util } from '@aws-appsync/utils'

/*
 * 프로젝트 에셋 한 개를 앉힙니다. 대본·시놉시스·그래프·씬·키비주얼·콘티가 그것입니다.
 *
 * ══ 어디에 사는가
 *
 *   pk = BOARD#<boardId>     op 로그와 같은 파티션입니다
 *   sk = ASSET#<kind>        kind 마다 한 항목. 덮어씁니다
 *
 * op 와 같은 pk 를 쓰는 이유는 프로젝트 하나의 에셋 전부를 Query 한 번에 읽기 위해
 * 서입니다. 서랍 화면이 그렇게 읽습니다(listAssets.js).
 *
 * 그런데 그렇게 두면 기존 로그 읽기가 에셋까지 집지 않을지가 문제입니다. listOps.js 는
 * begins_with(sk, 'OP#') 또는 sk > 'OP#<since>#' 로 읽습니다. 'ASSET#' 은 사전순으로
 * 'OP#' 보다 앞이라 두 갈래 모두 에셋을 집지 않습니다. 그래서 로그 쪽에 손댈 것이
 * 없습니다. 다만 반대는 조심해야 합니다. 나중에 sk 접두를 'Z…' 로 시작하는 것을 더하면
 * since 갈래에 걸립니다.
 *
 * ══ PutItem 이고 TTL 이 없습니다
 *
 * putOp.js 는 op 마다 새 항목을 쌓고 30일 TTL 을 걸지만, 에셋은 「지금의 대본」하나라서
 * 덮어씁니다. 그리고 TTL 을 걸지 않습니다. 한 달 쉰 프로젝트를 열었을 때 대본이 사라져
 * 있으면 그 프로젝트는 없어진 것과 같습니다. putProject.js 가 카드에 TTL 을 걸지 않는
 * 것과 같은 판단입니다.
 *
 * 덮어쓰기라서 두 사람이 같은 에셋을 동시에 저장하면 나중 쪽이 이깁니다. 이력은 남지
 * 않습니다. 지금은 그대로 둡니다. 한 프로젝트의 대본을 두 사람이 같은 순간에 다르게
 * 고치는 일은 이 규모에서 드물고, 이력이 필요해지면 sk 에 시각을 붙여 쌓는 쪽으로
 * 바꾸면 됩니다(sk = ASSET#<kind>#<ts>). 그때 이 파일과 listAssets.js 만 고칩니다.
 *
 * ══ 권한
 *
 * 리뷰어는 못 씁니다. 에셋은 작품 그 자체이고, 리뷰어에게 있는 권한은 의견을 남기는
 * 것까지입니다(app/domain/panels.js 의 canEditContent 가 같은 선을 긋습니다).
 */

const ROLES = ['planner', 'artist', 'director', 'admin']

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if (ROLES.indexOf(claims['custom:role'] || 'reviewer') < 0) util.unauthorized()

  const { boardId, kind, body, actor, ts } = ctx.args
  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({ pk: `BOARD#${boardId}`, sk: `ASSET#${kind}` }),
    attributeValues: util.dynamodb.toMapValues({
      boardId,
      kind,
      body,
      actor,
      updatedAt: ts,
    }),
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return ctx.result
}
