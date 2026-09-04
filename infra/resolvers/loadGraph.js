import { util } from '@aws-appsync/utils'

export function request(ctx) {
  return {
    operation: 'Invoke',
    payload: { operation: 'loadGraph', payload: { projectId: ctx.args.projectId || 'default' } },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return JSON.stringify(ctx.result)
}
