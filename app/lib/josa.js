/* 한국어 조사 고르기. 인물 이름이 한국어라서 자동 생성 문장에 필요합니다. */

/**
 * 앞말의 받침을 보고 조사를 고른다. 인물 이름이 한국어라서 자동 생성 문장에 필요하다.
 * 한글이 아니면(영문 이름·id) 받침 있는 쪽으로 읽는다.
 *
 * @param {string} word - 조사가 붙을 앞말
 * @param {string} withJong - 받침이 있을 때 (은, 이, 을, 과)
 * @param {string} noJong - 받침이 없을 때 (는, 가, 를, 와)
 * @returns {string} 고른 조사
 */
export function josa(word, withJong, noJong) {
  const ch = String(word ?? '').trim().slice(-1)
  const code = ch ? ch.codePointAt(0) : 0
  if (code < 0xac00 || code > 0xd7a3) return withJong
  return (code - 0xac00) % 28 ? withJong : noJong
}
