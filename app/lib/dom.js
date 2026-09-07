
const parser = new DOMParser()

export function setHtml(el, html) {
  if (!html) return el.replaceChildren()
  el.replaceChildren(...parser.parseFromString(String(html), 'text/html').body.childNodes)
}

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
