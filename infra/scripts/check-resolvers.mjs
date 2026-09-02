#!/usr/bin/env node
// AppSync 가 배포 때 돌리는 것과 같은 검사기로 resolvers/*.js 를 미리 돌려본다.
// "The code contains one or more errors" 는 CloudFormation 이 줄 번호를 버리고 주는 말이라,
// 어느 파일 몇 번째 줄이 문제인지는 evaluate-code 로만 알 수 있다.
//
//   node infra/scripts/check-resolvers.mjs
//
// 필요한 권한: appsync:EvaluateCode
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))
const DIR = path.join(HERE, '..', 'resolvers')
const REGION = process.env.AWS_REGION || 'us-east-1'

// evaluate-code 는 컨텍스트를 요구한다. 코드가 실제로 무엇을 하든 상관없다 —
// 문법·미지원 구문 오류는 컨텍스트와 무관하게 그대로 나온다.
const CTX = JSON.stringify({
  arguments: { spec: '{}', boardId: 'demo', id: 'x', ts: '1', actor: 'u1', body: '{}' },
  identity: { claims: { 'custom:role': 'planner', 'cognito:username': 'u1' } },
  source: {},
  result: {},
  stash: {},
  prev: {},
})

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort()
let bad = 0

for (const file of files) {
  const code = fs.readFileSync(path.join(DIR, file), 'utf8')
  for (const fn of ['request', 'response']) {
    if (!new RegExp(`export\\s+function\\s+${fn}\\b`).test(code)) {
      console.log(`✗ ${file} — ${fn}() 가 없다. AppSync 는 두 함수를 모두 요구한다.`)
      bad++
      continue
    }
    let out
    try {
      const r = await run('aws', [
        'appsync', 'evaluate-code',
        '--runtime', 'name=APPSYNC_JS,runtimeVersion=1.0.0',
        '--function', fn,
        '--region', REGION,
        '--code', code,
        '--context', CTX,
        '--output', 'json',
      ], { maxBuffer: 8 * 1024 * 1024 })
      out = JSON.parse(r.stdout)
    } catch (e) {
      console.log(`✗ ${file} ${fn}() — evaluate-code 호출 자체가 실패했다:`)
      console.log(`    ${String(e.stderr || e.message).trim().split('\n').slice(0, 4).join('\n    ')}`)
      bad++
      continue
    }

    const errs = out.error?.codeErrors
    if (errs?.length) {
      bad++
      console.log(`✗ ${file} ${fn}() — 코드 오류 ${errs.length}건:`)
      for (const e of errs) {
        const { line, column } = e.location || {}
        console.log(`    ${line}:${column}  ${e.errorType}  ${e.value}`)
      }
    } else if (out.error?.message) {
      // 런타임 오류(널 참조 등)는 배포를 막지 않는다. 참고로만 보여준다.
      console.log(`· ${file} ${fn}() — 문법은 통과. 런타임 메시지: ${out.error.message}`)
    } else {
      console.log(`✓ ${file} ${fn}()`)
    }
  }
}

console.log(bad ? `\n${bad}건이 배포를 막는다.` : `\n${files.length}개 파일 전부 통과. 배포를 막는 코드 오류는 없다.`)
process.exit(bad ? 1 : 0)
