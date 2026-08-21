import { util } from '@aws-appsync/utils'

export function request(ctx) {
  const { boardId, id, ts, actor, body } = ctx.args
  guardRole(ctx, body)
  const day = 24 * 60 * 60
  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({ pk: `BOARD#${boardId}`, sk: `OP#${ts}#${id}` }),
    attributeValues: util.dynamodb.toMapValues({
      boardId,
      id,
      ts,
      actor,
      body,
      ttl: util.time.epochMilliSecondsToSeconds(util.time.nowEpochMilliSeconds()) + 30 * day,
    }),
  }
}

function guardRole(ctx, body) {
  const op = JSON.parse(body)
  if (!op || (op.kind !== 'member.role' && op.kind !== 'member.set')) return

  const claims = ctx.identity?.claims || {}
  const meId = claims['cognito:username']
  const myRole = claims['custom:role'] || 'reviewer'
  const isAdmin = myRole === 'admin'

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
