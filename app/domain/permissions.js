/*
 * 「이 일을 누가 할 수 있나」를 한 곳에 모읍니다.
 *
 * 서버가 역할을 보고 튕기는 자리가 여럿인데(infra/resolvers/ 의 ROLES), 화면은 그것을
 * 모르고 버튼을 열어 두었습니다. 그래서 권한이 없는 사람이 누르면 서버가 조용히 거부하고,
 * 화면은 그 사유를 삼킨 채 「받지 못했습니다. 다시 시도해 주세요」 로 안내했습니다. 다시
 * 눌러도 같은 자리에서 같이 막히므로, 고칠 수 없는 것을 고칠 수 있는 것처럼 말한 셈입니다.
 *
 * 여기의 표는 서버의 허용 목록과 짝이 맞아야 합니다(리졸버들과 infra/gpu/server.py 의
 * ART_ROLES). 한쪽만 고치면 화면이 「됩니다」라고 해 놓고 서버가 튕기거나(더 나쁩니다),
 * 될 일을 화면이 미리 막습니다. app/test.html 이 두 곳을 맞대어 봅니다.
 */

import { ART_ROLES, PLAN_ROLES, ROLES } from './panels.js'

/**
 * 일감마다 서버가 허용하는 역할.
 *
 * 짝이 되는 서버 쪽 자리를 옆에 적어 둡니다. 그쪽을 고치면 여기도 고쳐야 합니다.
 *
 * 목록을 새로 적지 않고 panels.js 의 것을 씁니다. 같은 목록을 두 번 적어 두면 한쪽만
 * 고쳐지고, 그 어긋남은 「버튼은 열려 있는데 서버가 튕긴다」로만 드러납니다.
 */
export const JOB_ROLES = {
  // infra/resolvers/plan.js · planResult.js — 대본에서 그래프 뽑기, 이야기 기획
  plan: PLAN_ROLES,
  // infra/resolvers/navigate.js · navigateResult.js — 세계관 네비게이터 챗봇
  navigate: PLAN_ROLES,
  // infra/resolvers/saveGraph.js · updateGraph.js — 그래프를 Neptune 에 쓰기
  saveGraph: PLAN_ROLES,
  // infra/resolvers/putAsset.js — 프로젝트 에셋 담기. 리뷰어만 막습니다
  putAsset: ['planner', 'artist', 'director', 'admin'],
  // infra/gpu/server.py 의 ART_ROLES — 키 비주얼 생성. AppSync 가 아니라 GPU 서버가 봅니다
  gen: ART_ROLES,
  /*
   * infra/resolvers/deleteProject.js — 프로젝트를 지웁니다. 에셋과 op 로그가 함께 갑니다.
   *
   * 여기만 한 역할입니다. 다른 일은 되돌릴 수 있습니다. 대본을 잘못 만들면 다시 만들고,
   * 그래프를 잘못 저장하면 다시 저장합니다. 지우기는 되돌릴 자리가 없어서, 팀에서 그
   * 결정을 하는 한 사람에게 둡니다. 기획을 넣지 않은 것도 그 이유입니다 — 기획은 만드는
   * 권한이 가장 넓은 역할이라 무엇이든 다시 만들 수 있지만, 지운 것은 못 만듭니다.
   */
  deleteProject: ['director'],
}

/** 일감의 사람이 읽을 이름. 오류 문장에 그대로 들어갑니다 */
export const JOB_NAMES = {
  plan: '그래프 추출과 이야기 기획',
  navigate: '세계관 네비게이터',
  saveGraph: '그래프 저장',
  putAsset: '작업물 저장',
  gen: '키 비주얼 생성',
  deleteProject: '프로젝트 삭제',
}

/**
 * 역할 이름을 사람이 읽는 말로. 모르는 역할은 그대로 돌려줍니다.
 *
 * 이름표는 panels.js 의 ROLES 를 그대로 씁니다. 여기 한 벌 더 적어 두면 한쪽에서만
 * 역할 이름이 바뀌어 같은 화면에 「감독」과 「디렉터」가 같이 나옵니다.
 */
export const roleName = (role) => ROLES[role] || role || '알 수 없음'

/*
 * 조사를 붙입니다. 「네비게이터은」·「리뷰어로」가 아니라 「네비게이터는」·「리뷰어로」로.
 *
 * 앞말의 끝소리에 받침이 있는지로 갈립니다. 한글 음절은 유니코드에서 가나다 순으로
 * 이어져 있어서, 가(0xAC00)부터 센 자리를 28로 나눈 나머지가 종성 번호입니다. 0이면
 * 받침이 없습니다. 표를 두지 않고 이렇게 세는 이유는 일감·역할 이름이 늘어날 때마다
 * 조사를 손으로 적어 두면 새 이름에서 반드시 틀리기 때문입니다.
 *
 * 한글이 아닌 글자로 끝나면(영어·숫자) 받침이 있는 쪽으로 봅니다. 「GPU는」보다
 * 「GPU은」이 어색하지만 무엇을 골라도 어색한 자리이고, 지금 이름들은 모두 한글입니다.
 */
const jong = (word) => {
  const c = String(word || '').trim().slice(-1).charCodeAt(0)
  if (!(c >= 0xac00 && c <= 0xd7a3)) return 1
  return (c - 0xac00) % 28
}
/** 은/는 */
const eun = (word) => (jong(word) ? '은' : '는')
/** (으)로 — 「ㄹ」 받침은 「로」입니다. 「기획으로」·「감독으로」·「서울로」 */
const ro = (word) => {
  const j = jong(word)
  return !j || j === 8 ? '로' : '으로'
}

/**
 * 이 역할이 이 일감을 할 수 있는지.
 *
 * 표에 없는 일감은 막지 않습니다(true). 여기 적히지 않은 일은 서버도 역할을 보지 않는
 * 일이고, 모르는 이름 하나로 되는 일을 막아 버리는 편이 더 나쁩니다.
 *
 * @param {string} job - JOB_ROLES 의 키
 * @param {string} role - custom:role
 */
export function allowed(job, role) {
  const list = Object.prototype.hasOwnProperty.call(JOB_ROLES, job) ? JOB_ROLES[job] : null
  if (!list) return true
  return list.includes(role)
}

/**
 * 권한이 없을 때 화면에 적을 문장. 있으면 null 입니다.
 *
 * 세 가지를 한 문장에 담습니다. 무엇이 안 되는지, 지금 무엇으로 앉아 있는지, 누구면
 * 되는지입니다. 마지막 것이 없으면 사람이 누구에게 물어야 할지 모릅니다.
 *
 * 「다시 시도해 주세요」 같은 말을 붙이지 않습니다. 다시 눌러도 같은 자리에서 막힙니다.
 *
 * @param {string} job - JOB_ROLES 의 키
 * @param {string} role - custom:role
 * @returns {string|null}
 */
export function denyReason(job, role) {
  if (allowed(job, role)) return null
  const what = JOB_NAMES[job] || job
  const need = (JOB_ROLES[job] || []).map(roleName).join('·')
  return `${what}${eun(what)} ${need} 역할만 할 수 있습니다.`
    + ` 지금 ${roleName(role)}${ro(roleName(role))} 로그인해 있어서 권한이 없습니다.`
}

/**
 * 서버가 튕긴 오류가 권한 때문인지.
 *
 * AppSync 의 util.unauthorized() 는 errorType 이 Unauthorized 이고 message 가
 * 「Not Authorized to access <필드> on type <타입>」 입니다. 클라이언트를 지나오는 사이에
 * 모양이 조금씩 달라지므로(services/api.js 가 errors[0] 을 Error 로 옮깁니다) 넉넉하게 봅니다.
 *
 * 이것이 필요한 까닭은 화면이 미리 막는 것만으로는 부족하다는 것입니다. 역할은 관리자가
 * 언제든 바꿀 수 있고, 화면에 열려 있던 탭이 그 뒤로도 남아 있습니다. 그때는 서버의 거부가
 * 유일한 신호입니다.
 *
 * @param {Error|string} err
 */
export function isDenied(err) {
  const s = typeof err === 'string' ? err : `${err?.errorType || ''} ${err?.message || ''}`
  return /unauthorized|not authorized|권한이 없습니다/i.test(s)
}
