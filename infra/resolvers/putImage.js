// 자산관리 「올리기」. 그림 한 장을 커넥터 Lambda 가 S3 에 영구 보관하고 주소를 돌려준다.
// 리뷰어만 막는다 — domain/permissions.js 의 extract 와 같은 표(자산을 다루는 사람).
import { util } from '@aws-appsync/utils'

const ROLES = ['planner', 'artist', 'director', 'admin']

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  const role = claims['custom:role'] || 'reviewer'
  if (ROLES.indexOf(role) < 0) util.unauthorized()
  const input = typeof ctx.args.spec === 'string' ? JSON.parse(ctx.args.spec) : ctx.args.spec
  return {
    operation: 'Invoke',
    payload: { operation: 'upload', payload: { data: input.data, name: input.name, role, who: claims['cognito:username'] || claims.sub || '' } },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return JSON.stringify(ctx.result)
}
