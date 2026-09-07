/*
 * 모델이 준 텍스트에서 JSON 을 꺼냅니다. 프롬프트로 "JSON 하나만" 을 못 박아도 모델은
 * 코드펜스를 붙이거나 앞에 한 마디를 얹고, 응답 상한에 걸리면 문장 중간에서 끊깁니다.
 *   unfence    → 코드펜스를 벗깁니다
 *   jsonBodies → 앞뒤 설명을 버리고 여는 괄호부터 남깁니다
 *   repairJson → 잘린 자리를 되짚어 열린 괄호를 닫습니다
 */

const FENCE = /```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/

/** ```json … ``` 과 ``` … ``` 을 벗긴다. 닫는 펜스가 없는(잘린) 응답도 앞만 벗겨서 넘긴다 */
export const unfence = (s) => {
  const m = s.match(FENCE)
  if (m) return m[1]
  return s.replace(/```[a-zA-Z]*[ \t]*\r?\n?/, '')
}

/**
 * 앞뒤 설명을 버리고 { … } 또는 [ … ] 만 남긴다. 앞에 붙은 말에도 괄호가 있을 수 있어
 * ("아래와 같습니다 [참고]:") 두 종류를 다 후보로 두고, 먼저 열린 쪽부터 시도한다.
 */
const jsonBodies = (s) => [['{', '}'], ['[', ']']]
  .map(([open, close]) => {
    const a = s.indexOf(open)
    if (a < 0) return null
    const b = s.lastIndexOf(close)
    // 닫는 괄호가 없으면 잘려 온 것이다. 끝까지 넘기고 repairJson 이 닫는다
    return { at: a, body: b > a ? s.slice(a, b + 1) : s.slice(a) }
  })
  .filter(Boolean)
  .sort((x, y) => x.at - y.at)
  .map((c) => c.body)

/** 잘린 JSON 을 살릴 때 되짚어 볼 자리 수. 뒤에서부터 이만큼만 시도한다 */
const REPAIR_TRIES = 80

/**
 * 잘려서 온 JSON 을 살린다. 값 하나가 온전히 끝난 자리까지만 남기고 그 시점에 열려 있던
 * 괄호를 닫는다. 응답이 상한에서 끊겨도 앞쪽 분기까지는 건진다. 뒤는 normalizeStory 가
 * 경고로 남긴다. 문자열 안의 괄호·이스케이프는 세지 않는다.
 *
 * @param {string} s - jsonBody 를 지난 텍스트
 * @returns {*|undefined} 살린 값. 못 살리면 undefined (최상위가 객체·배열이라 값이 될 수 없다)
 */
export const repairJson = (s) => {
  const cuts = []
  const stack = []
  let inStr = false
  let esc = false
  const closers = () => [...stack].reverse().join('')

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { if (inStr) esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); continue }
    if (c === '}' || c === ']') {
      stack.pop()
      cuts.push({ at: i + 1, tail: closers() })
      continue
    }
    // 쉼표 앞은 값 하나가 온전히 끝난 자리다. 꼬리 쉼표도 여기서 같이 걸러진다
    if (c === ',') cuts.push({ at: i, tail: closers() })
  }

  for (let i = cuts.length - 1; i >= 0 && i > cuts.length - 1 - REPAIR_TRIES; i--) {
    try {
      return JSON.parse(s.slice(0, cuts[i].at) + cuts[i].tail)
    } catch {
      // 이 자리로는 안 됐다. 한 칸 더 앞으로 물러난다
    }
  }
  return undefined
}

/**
 * 모델 응답에서 JSON 을 꺼낸다. 코드펜스·앞뒤 설명·잘린 꼬리를 모두 견딘다.
 *
 * @param {string} text - net.plan 이 준 text
 * @returns {Object|Array} 파싱한 값
 * @throws {Error} 여는 괄호조차 없거나, 되짚어도 살리지 못한 경우
 */
export function parseJson(text) {
  const bodies = jsonBodies(unfence(String(text ?? '')))
  if (!bodies.length) throw new Error('기획 결과를 읽지 못했습니다. 다시 시도해 주세요.')
  for (const body of bodies) {
    try {
      return JSON.parse(body)
    } catch {
      // 그대로는 안 됐다. 잘린 자리를 되짚어 본다
    }
    const fixed = repairJson(body)
    if (fixed !== undefined) return fixed
  }
  throw new Error('기획 결과가 깨져서 왔습니다. 다시 시도해 주세요.')
}

/** 응답을 못 읽었을 때 다시 물어보는 횟수 (첫 시도 포함) */
