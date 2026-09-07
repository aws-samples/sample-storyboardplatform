/*
 * 값이 기대한 모양인지 보고, 아니면 안전한 기본값으로 바꿔 주는 것들입니다.
 * 모델 응답과 사용자 입력이 모두 이 문을 지납니다. 규칙도 UI 도 아니어서
 * domain/ 의 여러 파일과 services/planner.js 가 같이 씁니다.
 */

export const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
export const asList = (v) => (Array.isArray(v) ? v : [])
export const secsOf = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 2
  return Math.min(30, Math.max(0.5, Math.round(n * 10) / 10))
}
export const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
export const numOr = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt)
