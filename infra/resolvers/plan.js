// updated: 2026-09-03 r6 — 이 줄을 고치면 인라인 코드 문자열이 바뀌어 리졸버가 강제로 갱신된다
//
// plan 을 비동기로 띄운다. AppSync 의 요청 실행 시간 상한은 30초이고 상향이 불가라서
// 느린 모델(Opus 등)을 동기로 기다리면 Execution timeout 이 난다. 그래서
//   1) 여기서 Lambda 를 Event 로 띄우고 jobId 만 즉시 돌려준다 (Bedrock 을 기다리지 않는다)
//   2) Lambda 가 Bedrock 을 끝낸 뒤 결과를 Ops 테이블에 적는다
//   3) 브라우저가 planResult(jobId) 로 받아 간다 — demo/net.js 의 runPlan
// invocationType 이 Event 면 ctx.result 는 null 이다. 그래서 jobId 는 stash 로 넘긴다.
import { util } from '@aws-appsync/utils'

const ROLES = ['planner', 'director']

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if (ROLES.indexOf(claims['custom:role'] || 'reviewer') < 0) util.unauthorized()

  // 지역 변수를 typeof 의 피연산자로 쓰지 않는다. APPSYNC_JS 에서 `typeof input.prompt` 형태가
  // "ReferenceError: input is not defined" 로 죽었다 — 바로 윗줄에서 선언했는데도 그랬다.
  // 값 비교(빈값·length)만으로 같은 검사를 한다. 문자열이 아니면 concat 뒤 길이 검사에서 걸린다.
  // 이름도 인자명(spec)과 겹치지 않게 바꿔 둔다 — 섀도잉 쪽 원인도 같이 지운다.
  // 인자가 이미 객체로 오는 경우도 그대로 받는다. typeof 를 멤버 접근(ctx.args.spec)에 쓰는 것은
  // 위의 지역 변수 사례와 다르다 — 없는 프로퍼티라도 ReferenceError 가 나지 않는다.
  const input = typeof ctx.args.spec === 'string' ? JSON.parse(ctx.args.spec) : ctx.args.spec
  const raw = input.prompt
  const prompt = raw && raw.length ? '' + raw : ''
  if (prompt.length < 8 || prompt.length > 8000) {
    util.error('프롬프트 길이가 8~8000자여야 합니다', 'BadRequest')
  }

  // 결과를 읽을 수 있는 사람을 여기서 못 박는다. planResult 가 같은 값으로 대조한다 —
  // jobId 를 주워도 남의 결과는 못 읽는다.
  const owner = claims['cognito:username'] || claims.sub || ''
  const jobId = util.autoId()
  ctx.stash.jobId = jobId

  // maxTokens·model·think 는 손대지 않고 넘긴다. 클램프와 허용 목록은 Lambda 쪽에 있다 —
  // APPSYNC_JS 에는 Number() 도 없어서 검사를 두 군데 두면 규칙이 어긋나기 쉽다.
  return {
    operation: 'Invoke',
    invocationType: 'Event',
    payload: {
      operation: 'plan',
      payload: {
        jobId,
        owner,
        prompt,
        maxTokens: input.maxTokens,
        model: input.model,
        think: input.think,
      },
    },
  }
}

export function response(ctx) {
  // Event 호출이라 ctx.error 는 Lambda 안에서 난 오류가 아니라 띄우는 데 실패한 것이다
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  // Event 호출이라 ctx.result 는 null 이다. 결과는 Lambda 가 Ops 테이블에 적고
  // 브라우저가 planResult(jobId) 로 받아 간다 — 위 request() 와 짝이다.
  return { jobId: ctx.stash.jobId, status: 'pending' }
}
