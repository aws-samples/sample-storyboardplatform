// 커넥터 키를 지운다. admin 만. putConnector 와 같은 판정이다.
import { util } from '@aws-appsync/utils'

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if ((claims['custom:role'] || 'reviewer') !== 'admin') util.unauthorized()

  const input = typeof ctx.args.spec === 'string' ? JSON.parse(ctx.args.spec) : ctx.args.spec

  return {
    operation: 'Invoke',
    payload: { operation: 'remove', payload: { provider: input.provider } },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return JSON.stringify(ctx.result)
}
