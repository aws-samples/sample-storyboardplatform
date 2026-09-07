import { util } from '@aws-appsync/utils'

/*
 * 프로젝트 카드 목록.
 *
 * 카드는 pk='PROJECTS' 한 자리에 모여 있어서 Query 한 번으로 다 읽는다. op 처럼
 * pk=BOARD#<id> 로 흩어져 있으면 목록을 뽑으려고 테이블을 Scan 해야 했다.
 *
 * sk 는 P#<boardId> 라서 정렬 순서가 보드 이름 순이다. 최근에 손댄 것을 먼저 보이는
 * 일은 부르는 쪽(app/projects.js)에서 updatedAt 으로 세운다. 워크숍 규모에서 카드는
 * 수십 장이고, 그 정렬만을 위해 GSI 를 하나 더 세우지 않는다.
 */
export function request(ctx) {
  return {
    operation: 'Query',
    query: {
      expression: '#pk = :pk AND begins_with(#sk, :sk)',
      expressionNames: { '#pk': 'pk', '#sk': 'sk' },
      expressionValues: util.dynamodb.toMapValues({ ':pk': 'PROJECTS', ':sk': 'P#' }),
    },
    scanIndexForward: true,
    limit: 200,
    nextToken: ctx.args.nextToken,
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return { items: ctx.result.items, nextToken: ctx.result.nextToken }
}
