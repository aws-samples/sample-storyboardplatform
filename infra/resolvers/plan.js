import { util } from '@aws-appsync/utils'

const ROLES = ['planner', 'director']
const MODEL = 'us.anthropic.claude-sonnet-5'
const SYSTEM = '당신은 광고·단편 영상의 콘티 기획자다. 요청받은 JSON 하나만 출력한다. 설명·머리말·코드펜스를 붙이지 않는다.'

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if (ROLES.indexOf(claims['custom:role'] || 'reviewer') < 0) util.unauthorized()

  const spec = JSON.parse(ctx.args.spec)
  const prompt = typeof spec.prompt === 'string' ? spec.prompt : ''
  if (prompt.length < 8 || prompt.length > 8000) {
    util.error('프롬프트 길이가 8~8000자여야 합니다', 'BadRequest')
  }
  const want = Number(spec.maxTokens)
  const maxTokens = Math.min(4000, Math.max(300, Number.isFinite(want) ? Math.round(want) : 2000))

  const body = {
    system: [{ text: SYSTEM }],
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens },
  }
  if (spec.think !== true) body.additionalModelRequestFields = { thinking: { type: 'disabled' } }

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
