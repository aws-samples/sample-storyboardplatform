// 커넥터 키를 넣는다. admin 만.
//
// 동기 호출이다(Event 가 아니다). 키를 넣은 사람은 그 키가 먹는지 그 자리에서 알아야
// 한다. Lambda 가 제공자를 한 번 찔러 보고 통과할 때만 저장한다. probe 는 목록 조회
// 한 번이라 AppSync 의 30초 상한 안에 넉넉히 들어온다.
//
// 키는 여기서만 서버로 올라가고, 다시는 내려오지 않는다. 응답은 끝 네 글자뿐이다.
import { util } from '@aws-appsync/utils'

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if ((claims['custom:role'] || 'reviewer') !== 'admin') util.unauthorized()

  const input = typeof ctx.args.spec === 'string' ? JSON.parse(ctx.args.spec) : ctx.args.spec

  return {
    operation: 'Invoke',
    payload: {
      operation: 'put',
      payload: {
        provider: input.provider,
        key: input.key,
        secret: input.secret,
        owner: claims['cognito:username'] || claims.sub || '',
      },
    },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return JSON.stringify(ctx.result)
}
