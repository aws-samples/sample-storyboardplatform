// plan 잡 하나의 결과를 읽는다. Ops 테이블(OpsDs)에 앉는다.
//
// 브라우저가 이걸 폴링한다 (demo/net.js 의 runPlan). 아직 안 끝났으면 항목이 없고,
// 그때는 오류가 아니라 {status:"pending"} 을 돌려준다 — 부르는 쪽이 계속 물어보게.
//
// Lambda 는 성공이든 실패든 반드시 항목을 적는다. 안 적으면 브라우저가 120초를 꽉 기다린다.
import { util } from '@aws-appsync/utils'

const ROLES = ['planner', 'director']

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if (ROLES.indexOf(claims['custom:role'] || 'reviewer') < 0) util.unauthorized()

  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({ pk: `PLAN#${ctx.args.jobId}`, sk: 'RESULT' }),
    // 방금 적힌 결과를 놓치지 않는다. 폴링이라 최종적 일관성으로도 결국 오지만,
    // 한 번 더 도는 것보다 강한 일관성 읽기 한 번이 싸다
    consistentRead: true,
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)

  const item = ctx.result
  if (!item) return JSON.stringify({ status: 'pending' })

  // jobId 는 추측하기 어렵지만(autoId), 그것만으로 남의 결과를 막지는 않는다.
  // 잡을 띄운 사람과 지금 읽는 사람이 같은지 대조한다.
  const claims = ctx.identity?.claims || {}
  const me = claims['cognito:username'] || claims.sub || ''
  if (item.owner && item.owner !== me) util.unauthorized()

  // body 는 Lambda 가 적은 JSON 문자열이다. 그대로 내보내면 net.js 의 parseField 가 푼다
  return item.body
}
