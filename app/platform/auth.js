
const cfg = window.SB_CONFIG || {}
export const configured = !!(cfg.userPoolId && cfg.clientId)

const EP = `https://cognito-idp.${cfg.region}.amazonaws.com/`
const KEY = 'sb.auth'

const SAY = {
  NotAuthorizedException: '아이디 또는 비밀번호가 맞지 않습니다.',
  UserNotFoundException: '아이디 또는 비밀번호가 맞지 않습니다.',
  UserNotConfirmedException: '계정이 아직 활성화되지 않았습니다. 관리자에게 문의하세요.',
  PasswordResetRequiredException: '비밀번호를 다시 설정해야 합니다. 관리자에게 문의하세요.',
  InvalidPasswordException: '비밀번호가 정책에 맞지 않습니다. 8자 이상, 영문과 숫자를 섞어주세요.',
  TooManyRequestsException: '시도가 너무 많습니다. 잠시 뒤 다시 시도해주세요.',
  LimitExceededException: '시도가 너무 많습니다. 잠시 뒤 다시 시도해주세요.',
}

async function call(action, body) {
  const res = await fetch(EP, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityProviderService.${action}`,
    },
    body: JSON.stringify({ ClientId: cfg.clientId, ...body }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const code = String(json.__type || '').split('#').pop()
    throw Object.assign(new Error(SAY[code] || json.message || '로그인 서버에 연결하지 못했습니다.'), { code })
  }
  return json
}

let tok = null
let store = sessionStorage

;(function restore() {
  for (const s of [sessionStorage, localStorage]) {
    try {
      const raw = s.getItem(KEY)
      if (raw) { tok = JSON.parse(raw); store = s; return }
    } catch {  }
  }
})()

function claims(jwt) {
  try {
    const b = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b.padEnd(Math.ceil(b.length / 4) * 4, '=')), (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch { return {} }
}

function keep(r, fallback) {
  tok = {
    id: r.IdToken,
    access: r.AccessToken,
    refresh: r.RefreshToken || fallback,
    exp: (claims(r.IdToken).exp || 0) * 1000,
  }
  try { store.setItem(KEY, JSON.stringify(tok)) } catch {  }
}

let refreshing = null
function refresh() {
  if (!tok?.refresh) { logout(); return Promise.resolve() }
  refreshing ??= call('InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    AuthParameters: { REFRESH_TOKEN: tok.refresh },
  })
    .then((r) => keep(r.AuthenticationResult, tok.refresh))
    .catch(() => logout())
    .finally(() => { refreshing = null })
  return refreshing
}

export async function idToken() {
  if (!tok) return null
  if (tok.exp - Date.now() < 5 * 60_000) await refresh()
  return tok?.id ?? null
}

export function session() {
  if (!tok?.id) return null
  const c = claims(tok.id)
  if (!c['cognito:username']) return null
  return {
    id: c['cognito:username'],
    name: c.name || c['cognito:username'],
    role: c['custom:role'] || 'reviewer',
    email: c.email || '',
  }
}

let pending = null

export async function login(username, password, remember = false) {
  store = remember ? localStorage : sessionStorage
  const r = await call('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: username.trim(), PASSWORD: password },
  })
  if (r.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    pending = { session: r.Session, username: username.trim(), need: neededAttrs(r) }
    return { challenge: true, need: pending.need }
  }
  if (!r.AuthenticationResult) throw new Error('로그인에 실패했습니다.')
  keep(r.AuthenticationResult)
  return { session: session() }
}

function neededAttrs(r) {
  try { return JSON.parse(r.ChallengeParameters?.requiredAttributes || '[]').map((a) => a.replace('userAttributes.', '')) }
  catch { return [] }
}

export async function setNewPassword(password, attrs = {}) {
  if (!pending) throw new Error('먼저 로그인해주세요.')
  const responses = { USERNAME: pending.username, NEW_PASSWORD: password }
  for (const [k, v] of Object.entries(attrs)) responses[`userAttributes.${k}`] = v
  const r = await call('RespondToAuthChallenge', {
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    Session: pending.session,
    ChallengeResponses: responses,
  })
  if (!r.AuthenticationResult) throw new Error('비밀번호를 바꾸지 못했습니다.')
  keep(r.AuthenticationResult)
  pending = null
  return { session: session() }
}

export function logout() {
  tok = null
  pending = null
  try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY) } catch {  }
}
