// GPU 켜고 끄기. 커넥터 Lambda 의 power 오퍼레이션을 동기로 부른다.
//
// 역할은 여기서도 보고 Lambda 에서도 본다. 리뷰어만 막는다 — 기획·아티스트·감독·관리자는 다 누른다.
// 저녁에 꺼진 GPU 를 아침까지 기다리지 않게 하려는 단추라, 승인만 하는 감독도 켤 수 있어야 한다.
// domain/permissions.js 의 power 와 같은 표다.
import { util } from '@aws-appsync/utils'

const ROLES = ['planner', 'artist', 'director', 'admin']

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  const role = claims['custom:role'] || 'reviewer'
  if (ROLES.indexOf(role) < 0) util.unauthorized()
  const input = typeof ctx.args.spec === 'string' ? JSON.parse(ctx.args.spec) : ctx.args.spec
  return {
    operation: 'Invoke',
    payload: {
      operation: 'power',
      payload: { action: input.action, role, who: claims['cognito:username'] || claims.sub || '' },
    },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return JSON.stringify(ctx.result)
}
