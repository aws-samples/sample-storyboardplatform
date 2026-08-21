import { util } from '@aws-appsync/utils'

export function request(ctx) {
  const { boardId, since, nextToken } = ctx.args
  const pk = `BOARD#${boardId}`
  const names = { '#pk': 'pk', '#sk': 'sk' }
  const query = since
    ? {
        expression: '#pk = :pk AND #sk > :sk',
        expressionNames: names,
        expressionValues: util.dynamodb.toMapValues({ ':pk': pk, ':sk': `OP#${since}#` }),
      }
    : {
        expression: '#pk = :pk AND begins_with(#sk, :sk)',
        expressionNames: names,
        expressionValues: util.dynamodb.toMapValues({ ':pk': pk, ':sk': 'OP#' }),
      }

  return { operation: 'Query', query, scanIndexForward: true, limit: 1000, nextToken }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return { items: ctx.result.items, nextToken: ctx.result.nextToken }
}
