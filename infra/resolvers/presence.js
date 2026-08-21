export function request(ctx) {
  const { boardId, actor, body } = ctx.args
  return { payload: { boardId, actor, body } }
}

export function response(ctx) {
  return ctx.result
}
