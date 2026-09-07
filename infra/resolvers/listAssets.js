import { util } from '@aws-appsync/utils'

/*
 * 프로젝트 하나의 에셋 전부.
 *
 * 에셋은 op 와 같은 pk=BOARD#<boardId> 에 살고 sk 만 'ASSET#' 으로 시작합니다. 그래서
 * begins_with 한 번으로 그 프로젝트의 에셋만 옵니다. 서랍 화면이 여섯 줄을 그리려고
 * 여섯 번 읽지 않습니다.
 *
 * limit 을 두지 않고 종류 수만큼(지금 여섯)만 옵니다. putAsset.js 가 kind 마다 한
 * 항목을 덮어쓰기 때문입니다. 종류를 열 개로 늘려도 열 항목입니다. 나중에 이력을
 * 쌓는 쪽으로 바꾸면(sk = ASSET#<kind>#<ts>) 여기에 limit 과 nextToken 이 필요해집니다.
 *
 * body 가 대본 전문일 수 있어서 응답이 큽니다. 서랍은 그래도 통째로 받습니다. 요약만
 * 받아서 그리면 「열기」를 누를 때 또 읽어야 하고, 그 사이에 다른 사람이 고치면 요약과
 * 본문이 다른 것을 가리킵니다. 한 번 읽어 둔 것으로 그리고 여는 편이 단순합니다.
 */
export function request(ctx) {
  return {
    operation: 'Query',
    query: {
      expression: '#pk = :pk AND begins_with(#sk, :sk)',
      expressionNames: { '#pk': 'pk', '#sk': 'sk' },
      expressionValues: util.dynamodb.toMapValues({
        ':pk': `BOARD#${ctx.args.boardId}`,
        ':sk': 'ASSET#',
      }),
    },
    scanIndexForward: true,
    nextToken: ctx.args.nextToken,
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return { items: ctx.result.items, nextToken: ctx.result.nextToken }
}
