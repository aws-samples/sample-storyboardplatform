import { util } from '@aws-appsync/utils'

// 역기입도 기획·연출만. saveGraph 와 같은 판정이다
const ROLES = ['planner', 'director']

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if (ROLES.indexOf(claims['custom:role'] || 'reviewer') < 0) util.unauthorized()

  return {
    operation: 'Invoke',
    payload: { operation: 'updateGraph', payload: JSON.parse(ctx.args.spec) },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return JSON.stringify(ctx.result)
}
