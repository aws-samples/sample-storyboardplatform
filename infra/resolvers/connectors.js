// 커넥터 목록. 어떤 제공자가 붙어 있고 어떤 모델을 고를 수 있는지만 돌려준다.
//
// 역할 검사를 하지 않는다. 그림판이 모델 목록을 채우려면 아티스트도 읽어야 한다.
// 키는 이 경로로 절대 나가지 않는다 — Lambda 는 설정 여부와 시각만 만들어 준다.
// 키를 넣고 지우는 것은 putConnector·deleteConnector 이고 그쪽은 admin 만 통과한다.
import { util } from '@aws-appsync/utils'

export function request() {
  return {
    operation: 'Invoke',
    payload: { operation: 'list', payload: {} },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return JSON.stringify(ctx.result)
}
