import { util } from '@aws-appsync/utils'

// 그래프를 바꾸는 것은 기획·연출만. plan.js 와 같은 판정을 쓴다
const ROLES = ['planner', 'director']

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if (ROLES.indexOf(claims['custom:role'] || 'reviewer') < 0) util.unauthorized()

  return {
    operation: 'Invoke',
    payload: { operation: 'saveGraph', payload: JSON.parse(ctx.args.spec) },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return JSON.stringify(ctx.result)
}
