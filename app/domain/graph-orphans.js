
// 역기입이 판에 남기는 섬 노드를 막는 자리.
//
// 분기의 역기입은 노드와 엣지를 따로 적는다 (writeback.nodes / writeback.edges). 모델이
// 노드만 적고 그것을 이을 엣지를 빠뜨리면, 판에 아무것과도 닿지 않은 구슬이 하나 뜬다.
// 화면에서는 NEW 뱃지가 붙은 채 떠다니고, 탐지기는 그 노드를 영원히 못 본다.
// 엣지가 없으면 어떤 패턴에도 걸리지 않기 때문이다.
//
// 세 겹으로 막는다. 첫 겹은 프롬프트(story.js 의 branchRules), 둘째 겹은 여기서 찾는 것,
// 셋째 겹은 여기서 잇는 것이다. 찾고 거부하지 않는 이유는, 역기입을 통째로 버리면 그 분기의
// 사건이 사라지기 때문이다. 사람이 고칠 수 있게 이어 두고 무엇을 이었는지 경고로 남긴다.

import { edgeKey } from './graph-schema.js'
import { predicateToKo } from './graph-ko.js'
import { josa } from '../lib/josa.js'

const asList = (v) => (Array.isArray(v) ? v : [])

/**
 * 고립 노드를 이을 때 kind 별로 고르는 술어. 어휘(GRAPH_SCHEMA.rels)가 정한 방향을 지킨다.
 * 값은 (기준 인물 id, 새 노드 id) 를 받아 삼항을 만든다.
 *
 * 고른 술어는 셋 중 가장 약한 주장이다. 이 사람이 그 자리에 있었다(participated_in),
 * 이 비밀은 그 사람에 관한 것이다(concerns) 처럼 뒤 회차에서 뒤집지 않아도 되는 것만 쓴다.
 */
export const ORPHAN_LINK = {
  Event: (who, id) => ({ s: who, p: 'participated_in', o: id }),
  Secret: (who, id) => ({ s: id, p: 'concerns', o: who }),
  Character: (who, id) => ({ s: who, p: 'remembers', o: id }),
  Faction: (who, id) => ({ s: who, p: 'member_of', o: id }),
  Location: (who, id) => ({ s: who, p: 'last_seen_in', o: id }),
  Object: (who, id) => ({ s: who, p: 'uses', o: id }),
}

/** 판에 붙은 엣지 수. 자동 연결의 기준 인물을 고를 때 쓴다 */
const degree = (store, id) => store.getEdgesFrom(id).length + store.getEdgesTo(id).length

/**
 * 고립 노드를 이어 붙일 기준 인물을 고른다. 씨앗의 초점 인물 → 이 역기입이 이미
 * 건드린 인물 → 판에서 가장 많이 얽힌 인물 순이다. 판에 인물이 없으면 빈 문자열이다.
 *
 * @param {Object} store - GraphStore
 * @param {Object|null} seed - 이 분기를 만든 씨앗 {focus}
 * @param {Array} edges - 이 역기입이 넣기로 한 엣지
 * @returns {string} 기준 인물의 노드 id. 못 찾으면 빈 문자열
 */
export function anchorFor(store, seed, edges) {
  const isChar = (id) => store.getNode(id)?.kind === 'Character'
  const focus = asList(seed?.focus).filter(isChar)
  if (focus.length) return focus[0]
  for (const e of asList(edges)) {
    for (const id of [e.s, e.o]) if (isChar(id)) return id
  }
  const chars = store.getNodes({ kind: 'Character' })
  if (!chars.length) return ''
  return [...chars].sort((a, b) => degree(store, b.id) - degree(store, a.id))[0].id
}

/**
 * 역기입에서 어떤 엣지와도 닿지 않는 새 노드를 찾아 기존 인물에 이어 준다.
 * store 는 읽기만 한다. 이을 엣지를 돌려주고, 얹는 것은 부르는 쪽이 한다.
 *
 * @param {Object} store - GraphStore
 * @param {Array} nodes - 이 역기입이 새로 만드는 노드 [{id, kind, name, props}]
 * @param {Array} edges - 이 역기입이 넣기로 한 엣지 [{s, p, o, ...}]
 * @param {Object|null} [seed] - 이 분기를 만든 씨앗. focus 를 기준 인물로 먼저 본다
 * @returns {{edges: Array, warnings: Array<string>, notices: Array<string>}}
 *          새로 만든 연결 엣지와 무엇을 이었는지. notices 는 warnings 와 같은 문장이지만
 *          「사람에게 보여도 되는 것」으로 갈라 둔 자리다. 역기입 경고 대부분은 id 를 새로
 *          지었다거나 어휘에 없는 술어가 왔다는 개발자용 말이고 화면에 올릴 수 없다.
 *          자동 연결만은 작가가 알아야 한다. 판에 없던 관계가 하나 생기기 때문이다
 */
export function autoConnectOrphans(store, nodes, edges, seed = null) {
  const warnings = []
  const notices = []
  // 같은 문장을 두 곳에 남긴다. warnings 는 로그로 가고 notices 는 화면으로 간다
  const both = (msg) => { warnings.push(msg); notices.push(msg) }
  if (!store?.getNode) return { edges: [], warnings, notices }

  const linked = new Set()
  for (const e of asList(edges)) { linked.add(e.s); linked.add(e.o) }
  const orphans = asList(nodes).filter((n) => !linked.has(n.id))
  if (!orphans.length) return { edges: [], warnings, notices }

  const anchor = anchorFor(store, seed, edges)
  const keys = new Set(asList(edges).map(edgeKey))
  const out = []
  for (const n of orphans) {
    const make = ORPHAN_LINK[n.kind]
    // 판에 인물이 하나도 없으면 이을 상대가 없다. 빈 판의 첫 노드라 섬이라 부를 것도 없다
    if (!anchor || !make) {
      both(`"${n.name}"${josa(n.name, '과', '와')} 이어 줄 인물을 찾지 못했습니다.`
        + ' 관계도에 따로 떨어져 표시됩니다')
      continue
    }
    const e = make(anchor, n.id)
    if (keys.has(edgeKey(e))) continue
    keys.add(edgeKey(e))
    const who = store.getNode(anchor).name
    const cause = `고립된 ${n.name}${josa(n.name, '을', '를')} ${who}${josa(who, '과', '와')} 자동으로 이었다`
    out.push({ ...e, asserted: true, props: { cause } })
    const said = predicateToKo(e.s === anchor ? who : n.name, e.p, e.o === anchor ? who : n.name)
    both(`"${n.name}"${josa(n.name, '이', '가')} 기존 인물과 연결이 없어 `
      + `"${said}"${josa(said, '으로', '로')} 자동 연결했습니다`)
  }
  return { edges: out, warnings, notices }
}

/**
 * 판에 떠 있는 섬 노드를 센다. 역기입 뒤에 판이 성한지 보는 자리다.
 *
 * @param {Object} graph - {nodes, edges} (GraphStore.toJSON())
 * @returns {Array<Object>} 어떤 엣지에도 닿지 않은 노드
 */
export function islandNodes(graph) {
  const touched = new Set()
  for (const e of asList(graph?.edges)) { touched.add(e.s); touched.add(e.o) }
  return asList(graph?.nodes).filter((n) => !touched.has(n.id))
}
