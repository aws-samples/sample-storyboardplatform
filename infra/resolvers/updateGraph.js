import { util } from '@aws-appsync/utils'

// 역기입도 기획·연출만. saveGraph 와 같은 판정이다
const ROLES = ['planner', 'director']

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if (ROLES.indexOf(claims['custom:role'] || 'reviewer') < 0) util.unauthorized()

  return {
    operation: 'Invoke',
    payload: { operation: 'updateGraph', payload: spec(ctx) },
  }
}

// AWSJSON 인자는 문자열로 올 때도 있고 이미 파싱된 객체로 올 때도 있다. 객체를
// JSON.parse 에 넣으면 APPSYNC_JS 는 던지지 않고 빈 값을 돌려준다. plan.js 와 같은 가드다.
const spec = (ctx) => (typeof ctx.args.spec === 'string' ? JSON.parse(ctx.args.spec) : ctx.args.spec)

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return JSON.stringify(ctx.result)
}
