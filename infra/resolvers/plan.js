import { util } from '@aws-appsync/utils'

const ROLES = ['planner', 'director']
// 리전마다 접두사가 다르다. us.* 는 미국 리전 전용이라 ap-northeast-2 에는 없다 —
// global.* 는 어느 리전에서나 호출된다. 리전을 옮기면 여기도 같이 확인해야 한다.
const MODEL = 'global.anthropic.claude-sonnet-4-6'
const SYSTEM = '당신은 광고·단편 영상의 콘티 기획자다. 요청받은 JSON 하나만 출력한다. 설명·머리말·코드펜스를 붙이지 않는다.'

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if (ROLES.indexOf(claims['custom:role'] || 'reviewer') < 0) util.unauthorized()

  /*
   * AWSJSON 인자는 런타임이 이미 파싱해서 객체로 넘겨준다. 여기서 JSON.parse 를
   * 다시 부르면 던지는데, 이 런타임은 그 예외를 삼키고 선언만 무효화해버린다.
   * 그러면 다음 줄에서 「spec is not defined」라는 엉뚱한 ReferenceError 가 나서
   * 원인을 찾기 어렵다. 실제로 그 증상으로 기획 기능이 죽어 있었다.
   *
   * evaluate-code 는 컨텍스트를 주는 대로 믿기 때문에 문자열을 넣으면 통과한다 —
   * 즉 이 버그는 evaluate-code 로 잡히지 않는다. 실호출로만 드러난다.
   * 문자열로 오는 경우(로컬 도구·직접 호출)도 있으니 양쪽을 모두 받는다.
   */
  const raw = ctx.args.spec
  const req = typeof raw === 'string' ? JSON.parse(raw) : raw
  const prompt = typeof req.prompt === 'string' ? req.prompt : ''
  if (prompt.length < 8 || prompt.length > 8000) {
    util.error('프롬프트 길이가 8~8000자여야 합니다', 'BadRequest')
  }
  // AppSync JS 런타임에는 Number() 가 없다(INVALID_FUNCTION_INVOCATION). 단항 + 로 강제한다.
  const want = +req.maxTokens
  const maxTokens = Math.min(4000, Math.max(300, Number.isFinite(want) ? Math.round(want) : 2000))

  const body = {
    system: [{ text: SYSTEM }],
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens },
  }
  if (req.think !== true) body.additionalModelRequestFields = { thinking: { type: 'disabled' } }

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

  // body 는 Bedrock 이 준 HTTP 응답 본문, 즉 진짜 문자열이다. 이 parse 는 맞다.
  const out = JSON.parse(body)
  const content = (out.output && out.output.message && out.output.message.content) || []
  let text = ''
  for (const c of content) if (typeof c.text === 'string') text += c.text
  /*
   * 객체를 그대로 돌려준다. JSON.stringify 를 하면 안 된다.
   *
   * 이 필드는 AWSJSON 이고 그 스칼라는 값을 스스로 직렬화한다. 여기서 문자열로
   * 만들어 주면 그 문자열을 한 번 더 감싸서 이중 인코딩된다. 그러면 net.js 의
   * JSON.parse 한 번으로는 객체가 아니라 문자열이 나오고, .text 가 undefined 가
   * 되어 화면에는 「프롬프트를 읽지 못했습니다」로 보인다 — 모델은 정상 응답했는데도.
   *
   * 요청 쪽의 함정과 뿌리가 같다: AWSJSON 은 경계에서 알아서 변환한다.
   * 들어올 때 이미 파싱되어 있고, 나갈 때 알아서 직렬화한다. 양쪽 다 손대지 않는다.
   */
  return { text, usage: out.usage, stop: out.stopReason }
}
