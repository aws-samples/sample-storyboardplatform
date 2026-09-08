// updated: 2026-09-06 r2 — 이 줄을 고치면 인라인 코드 문자열이 바뀌어 리졸버가 강제로 갱신된다
//
// 세계관 네비게이터 챗봇 질문 하나를 비동기로 띄운다. plan.js 와 같은 패턴이다 —
// AppSync 의 요청 실행 시간 상한이 30초이고 상향이 불가라서 Bedrock 을 동기로 기다릴 수 없다.
//   1) 여기서 Lambda 를 Event 로 띄우고 jobId 만 즉시 돌려준다
//   2) Lambda 가 Bedrock 을 끝낸 뒤 결과를 Ops 테이블에 적는다
//   3) 브라우저가 navigateResult(jobId) 로 받아 간다
// invocationType 이 Event 면 ctx.result 는 null 이다. 그래서 jobId 는 stash 로 넘긴다.
import { util } from '@aws-appsync/utils'

const ROLES = ['planner', 'director']

/** 질문 길이 상한. 프롬프트 본체는 Lambda 가 그래프를 붙여 만든다 */
const QUESTION_MAX = 2000
/**
 * 그래프 JSON 길이 상한. Lambda Event 호출의 페이로드 상한이 256KB 라서
 * 그래프가 너무 크면 호출 자체가 실패한다 — 여기서 먼저 알아볼 수 있는 오류로 튕긴다.
 */
const GRAPH_MAX = 180000

/**
 * AWSJSON 필드 하나를 Lambda 에 넘길 JSON 문자열로 맞춘다.
 *
 * AppSync 는 이 필드를 문자열로 줄 때도 있고 이미 푼 값으로 줄 때도 있다 — plan.js 가
 * spec 에서 겪은 것과 같은 갈림이다. 객체가 온 것을 `'' + v` 로 이으면 graphData 는
 * "[object Object]" 로, 빈 객체는 길이 0 으로 뭉개져 그래프가 소리 없이 사라진다.
 * 그러면 Lambda 는 빈 그래프로 답하고, 모델은 "현재 그래프에 해당 정보가 없습니다"
 * 라고만 말한다. 그래서 문자열이 아닐 때는 여기서 다시 직렬화한다.
 *
 * typeof 는 쓰지 않는다 — 위 request() 의 주석과 같은 이유다. 대신 직렬화한 첫 글자로
 * 가른다: 문자열이었으면 따옴표로 시작한다.
 *
 * @param {*} v - ctx.args 로 온 AWSJSON 필드 값 (문자열 또는 푼 값)
 * @returns {string} JSON 문자열. 값이 없으면 빈 문자열
 */
function jsonText(v) {
  if (v === null || v === undefined) return ''
  const text = JSON.stringify(v)
  return text.charAt(0) === '"' ? '' + v : text
}

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if (ROLES.indexOf(claims['custom:role'] || 'reviewer') < 0) util.unauthorized()

  // plan.js 와 같은 이유로 typeof 를 지역 변수에 쓰지 않는다 — APPSYNC_JS 에서
  // `typeof input.question` 형태가 "ReferenceError: input is not defined" 로 죽었다.
  // 값 비교(빈값·length)만으로 같은 검사를 한다.
  const input = typeof ctx.args.input === 'string' ? JSON.parse(ctx.args.input) : ctx.args.input
  const rawQ = input.question
  const question = rawQ && rawQ.length ? '' + rawQ : ''
  if (question.length < 1 || question.length > QUESTION_MAX) {
    util.error(`질문 길이가 1~${QUESTION_MAX}자여야 합니다`, 'BadRequest')
  }

  // graphData·conversationHistory 는 JSON 문자열로 넘긴다. 내용을 푸는 것은 Lambda 가 한다 —
  // 여기서 풀면 다시 문자열로 만들어 넘겨야 하고, 길이 검사도 문자열 쪽이 맞다.
  const graphData = jsonText(input.graphData)
  if (graphData.length > GRAPH_MAX) {
    util.error('그래프가 너무 큽니다. 노드를 줄여 주세요', 'BadRequest')
  }
  const conversationHistory = jsonText(input.conversationHistory)

  // 결과를 읽을 수 있는 사람을 여기서 못 박는다. navigateResult 가 같은 값으로 대조한다 —
  // jobId 를 주워도 남의 결과는 못 읽는다.
  const owner = claims['cognito:username'] || claims.sub || ''
  const jobId = util.autoId()
  ctx.stash.jobId = jobId

  // model 은 손대지 않고 넘긴다. 허용 목록은 Lambda 쪽에 있다
  return {
    operation: 'Invoke',
    invocationType: 'Event',
    payload: {
      operation: 'navigate',
      payload: {
        jobId,
        owner,
        projectId: input.projectId,
        question,
        graphData,
        conversationHistory,
        model: input.model,
      },
    },
  }
}

export function response(ctx) {
  // Event 호출이라 ctx.error 는 Lambda 안에서 난 오류가 아니라 띄우는 데 실패한 것이다
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  // Event 호출이라 ctx.result 는 null 이다. 결과는 Lambda 가 Ops 테이블에 적고
  // 브라우저가 navigateResult(jobId) 로 받아 간다 — 위 request() 와 짝이다.
  return { jobId: ctx.stash.jobId, status: 'pending' }
}
