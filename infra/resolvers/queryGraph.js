import { util } from '@aws-appsync/utils'

export function request(ctx) {
  return {
    operation: 'Invoke',
    payload: { operation: 'queryGraph', payload: spec(ctx) },
  }
}

// AWSJSON 인자는 문자열로 올 때도 있고 이미 파싱된 객체로 올 때도 있다. 객체를
// JSON.parse 에 넣으면 APPSYNC_JS 는 던지지 않고 빈 값을 돌려준다 — 그래서 payload 가
// 조용히 비어 나갔다. plan.js 와 같은 가드를 쓴다.
const spec = (ctx) => (typeof ctx.args.spec === 'string' ? JSON.parse(ctx.args.spec) : ctx.args.spec)

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return JSON.stringify(ctx.result)
}
