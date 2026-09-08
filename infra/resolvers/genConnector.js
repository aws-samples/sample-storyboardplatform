// 커넥터 모델로 한 장 만든다. plan.js 와 같은 비동기 잡 방식이다.
//
// 밖의 제공자는 느리다 — 그림도 십수 초, 영상은 몇 분이다. AppSync 의 30초 상한을
// 넘기니 동기로 기다릴 수 없다. Lambda 를 Event 로 띄우고 jobId 만 돌려준 뒤,
// 브라우저가 genResult(jobId) 로 받아 간다.
//
// 그림 만들기는 아티스트와 기획만. infra/gpu/server.py 의 ART_ROLES 와 같은 규칙이다.
import { util } from '@aws-appsync/utils'

const ROLES = ['artist', 'planner']

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if (ROLES.indexOf(claims['custom:role'] || 'reviewer') < 0) util.unauthorized()

  const input = typeof ctx.args.spec === 'string' ? JSON.parse(ctx.args.spec) : ctx.args.spec
  const raw = input.model
  const model = raw && raw.length ? '' + raw : ''
  if (!model.length) util.error('모델을 골라야 합니다', 'BadRequest')

  const owner = claims['cognito:username'] || claims.sub || ''
  const jobId = util.autoId()
  ctx.stash.jobId = jobId

  // kind·strength·seed 는 손대지 않고 넘긴다. 자르기는 Lambda 쪽에 있다
  return {
    operation: 'Invoke',
    invocationType: 'Event',
    payload: {
      operation: 'gen',
      payload: {
        jobId,
        owner,
        model,
        prompt: input.prompt,
        kind: input.kind,
        init: input.init,
        strength: input.strength,
        seed: input.seed,
      },
    },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return { jobId: ctx.stash.jobId, status: 'pending' }
}
