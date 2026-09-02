// updated: 2026-09-02 r3 — 이 줄을 고치면 인라인 코드 문자열이 바뀌어 리졸버가 강제로 갱신된다
import { util } from '@aws-appsync/utils'

const ROLES = ['planner', 'director']
const MODEL = 'us.anthropic.claude-sonnet-5'
const SYSTEM = '당신은 광고·단편 영상의 콘티 기획자다. 요청받은 JSON 하나만 출력한다. 설명·머리말·코드펜스를 붙이지 않는다.'

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
  // APPSYNC_JS 는 Number() 변환 함수를 주지 않는다 (Number.isFinite·isNaN 만 있다).
  // 곱셈으로 강제하면 ToNumber 와 같은 결과가 나온다 — Number() 를 다시 쓰면 배포가 막힌다.
  const want = input.maxTokens * 1
  const maxTokens = Math.min(4000, Math.max(300, Number.isFinite(want) ? Math.round(want) : 2000))

  const body = {
    system: [{ text: SYSTEM }],
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens },
  }
  if (input.think !== true) body.additionalModelRequestFields = { thinking: { type: 'disabled' } }

  return {
    method: 'POST',
    resourcePath: `/model/${MODEL}/converse`,
    params: { headers: { 'Content-Type': 'application/json' }, body },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  const { statusCode, body } = ctx.result
  if (statusCode !== 200) util.error(`Bedrock ${statusCode}: ${body}`, 'BedrockError')

  const out = JSON.parse(body)
  const content = (out.output && out.output.message && out.output.message.content) || []
  let text = ''
  for (const c of content) if (typeof c.text === 'string') text += c.text
  return JSON.stringify({ text, usage: out.usage, stop: out.stopReason })
}
