import { util } from '@aws-appsync/utils'

export function request(ctx) {
  return {
    operation: 'Invoke',
    payload: { operation: 'queryGraph', payload: JSON.parse(ctx.args.spec) },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return JSON.stringify(ctx.result)
}
