// 커넥터 잡 하나의 결과를 읽는다. planResult.js 와 같은 구조, 키만 GEN# 이다.
//
// 아직 안 끝났으면 항목이 없고, 그때는 오류가 아니라 {status:"pending"} 을 돌려준다.
// Lambda 는 성공이든 실패든 반드시 한 건 적는다.
import { util } from '@aws-appsync/utils'

const ROLES = ['artist', 'planner']

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if (ROLES.indexOf(claims['custom:role'] || 'reviewer') < 0) util.unauthorized()

  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({ pk: `GEN#${ctx.args.jobId}`, sk: 'RESULT' }),
    consistentRead: true,
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)

  const item = ctx.result
  if (!item) return JSON.stringify({ status: 'pending' })

  // 잡을 띄운 사람과 지금 읽는 사람이 같은지 대조한다. planResult 와 같다
  const claims = ctx.identity?.claims || {}
  const me = claims['cognito:username'] || claims.sub || ''
  if (item.owner && item.owner !== me) util.unauthorized()

  return item.body
}
