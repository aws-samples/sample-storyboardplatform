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
  /*
   * 따옴표·괄호로 감싼 말이 자주 옵니다 — 「전신」, (씬 2) 같은 것들. 마지막 글자를 그대로
   * 보면 그 닫는 기호를 읽고 받침이 있는 쪽으로 잘못 고릅니다(「전신」를). 감싼 것을
   * 벗기고 안의 마지막 글자를 봅니다
   */
  const ch = String(word ?? '').trim().replace(/[\s"'’”」』〉》>)\]}】·.,!?…]+$/, '').slice(-1)
  const code = ch ? ch.codePointAt(0) : 0
  if (code < 0xac00 || code > 0xd7a3) return withJong
  const jong = (code - 0xac00) % 28
  /*
   * 으로/로 에는 규칙이 하나 더 있습니다. 받침이 ㄹ(8번)이면 「로」입니다 — 서울로,
   * 서울으로가 아닙니다. domain/permissions.js:83 이 같은 규칙을 따로 갖고 있으므로,
   * 여기가 이것을 모르면 같은 말에 두 화면이 다른 답을 냅니다
   */
  if (jong === 8 && withJong === '으로') return noJong
  return jong ? withJong : noJong
}
