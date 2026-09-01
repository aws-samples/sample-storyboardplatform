
// 관계 그래프의 어휘와 파생 규칙.
//
// 여기서 다루는 것은 mock/graph.json 과 똑같은 모양의 관계 그래프다.
//   노드  {id, kind, name, props}
//   엣지  {s, p, o, asserted, derived?, props}
// 스키마 선언·공리·추론기가 있는 진짜 온톨로지는 별도 Python PoC(issue #1) 쪽이고,
// 이 파일은 그 대신 스토리 씨앗을 찾는 데 필요한 만큼만 패턴으로 훑는다.

/**
 * 엣지 술어(p) 어휘. mock/graph.json 과 mock/stories.json 의 역기입 엣지에서
 * 실제로 쓰이는 값들이다. 여기 없는 술어는 normalizeGraph 가 떨어뜨린다.
 * dir: 'out' 은 단방향, 'sym' 은 양방향으로 읽는 관계.
 */
const RELS = {
  // 소속과 역할
  member_of: { desc: '소속 (캐릭터 → 집단)', dir: 'out' },
  mentor_of: { desc: '가르침 (스승 → 제자)', dir: 'out' },
  manages: { desc: '관리 (캐릭터 → 집단·캐릭터)', dir: 'out' },
  maintains: { desc: '유지·관리 (집단 → 장소·사물)', dir: 'out' },
  serves: { desc: '섬김·계약 (캐릭터 → 캐릭터·집단)', dir: 'out' },
  kin_of: { desc: '친족. props.type 에 parent/child/sibling/spouse', dir: 'out' },
  // 감정
  loves: { desc: '애정. 단방향이다. 반대 방향은 별개 엣지', dir: 'out' },
  drawn_to: { desc: '끌림. loves 보다 약한 단계', dir: 'out' },
  rival_of: { desc: '적대·경쟁', dir: 'sym' },
  distrusts: { desc: '불신', dir: 'out' },
  estranged_from: { desc: '멀어짐·의절', dir: 'sym' },
  protects: { desc: '보호', dir: 'out' },
  targets: { desc: '표적 지정 (가해자 → 대상)', dir: 'out' },
  deceives: { desc: '속임', dir: 'out' },
  // 비밀
  conceals: { desc: '은폐 (비밀을 가진 쪽 → 비밀)', dir: 'out' },
  knows: { desc: '알고 있음 (캐릭터 → 비밀·사건)', dir: 'out' },
  hidden_from: { desc: '숨겨짐 (비밀 → 모르는 캐릭터)', dir: 'out' },
  reveals: { desc: '폭로 (캐릭터 → 비밀)', dir: 'out' },
  concerns: { desc: '무엇에 관한 비밀인가 (비밀 → 캐릭터·사건)', dir: 'out' },
  remembers: { desc: '기억 (캐릭터 → 사건·인물)', dir: 'out' },
  // 사건과 인과
  participated_in: { desc: '참여 (캐릭터 → 사건)', dir: 'out' },
  caused: { desc: '인과 (사건 → 사건·상태)', dir: 'out' },
  enabled: { desc: '가능케 함. caused 보다 약한 인과', dir: 'out' },
  resolves: { desc: '해소 (사건 → 사건·갈등)', dir: 'out' },
  weakened_by: { desc: '약화됨 (대상 → 원인)', dir: 'out' },
  dissolving: { desc: '해체 중 (집단·결계 → 상태)', dir: 'out' },
  withdraws_from: { desc: '이탈 (캐릭터 → 집단·장소)', dir: 'out' },
  uses: { desc: '사용 (캐릭터 → 사물)', dir: 'out' },
  calls_true_name: { desc: '참이름 호명 (캐릭터 → 캐릭터)', dir: 'out' },
  // 장소
  located_in: { desc: '위치 (무엇 → 장소)', dir: 'out' },
  last_seen_in: { desc: '마지막 목격 장소 (캐릭터 → 장소)', dir: 'out' },
  passes_through: { desc: '통과 (캐릭터 → 장소)', dir: 'out' },
  performs_at: { desc: '공연 (캐릭터·집단 → 장소)', dir: 'out' },
  // 파생 전용 — 텍스트에서 직접 뽑지 않고 deriveEdges 가 만든다
  has_leverage_over: { desc: '약점을 쥠. 파생 전용', dir: 'out', derivedOnly: true },
  unrequited_love: { desc: '짝사랑당함. 파생 전용', dir: 'out', derivedOnly: true },
  potential_rival_of: { desc: '잠재 적대. 파생 전용', dir: 'out', derivedOnly: true },
  threatens: { desc: '간접 위협. 파생 전용', dir: 'out', derivedOnly: true },
}

/**
 * 노드 종류. Object 는 mock/stories.json 의 역기입에서 쓰이므로 함께 허용한다.
 */
const KINDS = {
  Character: '인물. 이름으로 불리는 사람·존재',
  Faction: '집단·조직·팀',
  Location: '장소·결계처럼 공간으로 다루는 것',
  Event: '서사를 움직인 사건. props.t 에 상대 시점(현재 0)',
  Secret: '일부만 아는 정보. props.claim 에 그 내용 한 줄',
  Object: '이야기에서 손을 타는 물건',
}

export const GRAPH_SCHEMA = {
  nodeKinds: Object.keys(KINDS),
  nodeKindDesc: KINDS,
  edgeRels: Object.keys(RELS),
  rels: RELS,
  /** 텍스트 추출에서 허용하는 술어 (파생 전용 제외) */
  assertableRels: Object.keys(RELS).filter((p) => !RELS[p].derivedOnly),
  derivedRels: Object.keys(RELS).filter((p) => RELS[p].derivedOnly),
}

const CHO = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h']
const JUNG = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo',
  'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i']
const JONG = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'p', 'l', 'l', 'p', 'l',
  'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't']

/**
 * 한국어 이름을 노드 id 로 쓸 수 있는 로마자 소문자로 바꾼다.
 * 국어의 로마자 표기법을 음절 단위로만 적용한 근사값이다. 널리 쓰이는 표기
 * (셀린 → celine 처럼)와는 어긋날 수 있으므로, 추출 단계에서는 모델이 준 id를
 * 먼저 쓰고 이 함수는 id 가 아예 없을 때의 대체 수단으로만 쓴다.
 *
 * @param {string} name - 노드 이름 (한국어 또는 영문)
 * @returns {string} [a-z0-9_] 로만 이루어진 id 후보. 만들 수 없으면 빈 문자열
 */
export function romanizeId(name) {
  const out = []
  for (const ch of String(name ?? '')) {
    const code = ch.codePointAt(0)
    if (code >= 0xac00 && code <= 0xd7a3) {
      const i = code - 0xac00
      out.push(CHO[Math.floor(i / 588)], JUNG[Math.floor((i % 588) / 28)], JONG[i % 28])
    } else if (/[A-Za-z0-9]/.test(ch)) out.push(ch.toLowerCase())
    else if (/[\s._·-]/.test(ch)) out.push('_')
  }
  return out.join('').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 48)
}

/** 엣지 하나를 식별하는 키. 같은 삼항이 두 번 들어오지 않게 막는 데 쓴다. */
export const edgeKey = (e) => `${e.s}|${e.p}|${e.o}`

const idx = (edges) => {
  const by = {}
  for (const e of edges) (by[e.p] ??= []).push(e)
  return by
}

const num = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt)

/**
 * 명시 엣지에서 파생 엣지를 만든다.
 *
 * 진짜 온톨로지 추론(공리 + 고정점 반복)이 아니다. 스토리 씨앗 탐지에 쓸 만한
 * 파생만 한 번의 패턴 매칭으로 뽑는다. 파생 엣지는 다시 규칙의 입력이 되지 않는다.
 * 규칙:
 *   inverse_affection    A loves B, B→A 애정 없음 → B unrequited_love A
 *   symmetric_kinship    A kin_of B (sibling/spouse) → B kin_of A
 *   secret_leverage      A knows S, C conceals S → A has_leverage_over C
 *   membership_rivalry   A member_of F1, F1 rival_of F2 → A potential_rival_of F2
 *   danger_propagation   A targets B, B protects C → A threatens C
 *   love_chain           A serves B, A loves C → B rival_of C
 *   secret_suspicion     A conceals S, 참여자 없는 현재 사건 E → A participated_in E (의심)
 *
 * @param {Array} nodes - 노드 배열 [{id, kind, name, props}]
 * @param {Array} edges - 명시 엣지 배열 [{s, p, o, ...}]
 * @returns {Array} 파생 엣지 배열. 각 원소는 asserted:false 이고
 *                  props.derived_by 에 규칙 이름이 박힌다.
 *                  이미 있는 엣지(같은 s·p·o)와 겹치는 것은 넣지 않는다.
 */
export function deriveEdges(nodes, edges) {
  const ns = Array.isArray(nodes) ? nodes : []
  const es = (Array.isArray(edges) ? edges : []).filter((e) => e && e.s && e.p && e.o)
  const kindOf = new Map(ns.map((n) => [n.id, n.kind]))
  const has = new Set(es.map(edgeKey))
  const by = idx(es)
  const out = []
  const seen = new Set()

  // rule: 규칙 이름, tag: mock/graph.json 의 derived 값과 같은 계열 이름
  const add = (s, p, o, rule, tag, tension, extra = {}) => {
    if (!s || !o || s === o) return
    const e = { s, p, o }
    const key = edgeKey(e)
    if (has.has(key) || seen.has(key)) return
    seen.add(key)
    out.push({ ...e, asserted: false, derived: tag, props: { ...extra, tension, derived_by: rule } })
  }

  // 1. 짝사랑: 애정이 한쪽으로만 걸려 있으면 받는 쪽에 짝사랑당함을 남긴다
  for (const e of by.loves || []) {
    const back = (by.loves || []).some((x) => x.s === e.o && x.o === e.s)
      || (by.drawn_to || []).some((x) => x.s === e.o && x.o === e.s)
    if (!back) add(e.o, 'unrequited_love', e.s, 'inverse_affection', 'affection', num(e.props?.tension, 0.6))
  }

  // 2. 형제·배우자는 대칭이다. parent/child 는 방향이 뜻을 가지므로 건드리지 않는다
  for (const e of by.kin_of || []) {
    const t = String(e.props?.type || '')
    if (t === 'sibling' || t === 'spouse') {
      add(e.o, 'kin_of', e.s, 'symmetric_kinship', 'kinship', num(e.props?.tension, 0.2), { type: t })
    }
  }

  // 3. 남의 비밀을 아는 사람은 그 비밀을 감춘 사람의 목을 쥔다
  for (const k of by.knows || []) {
    if (kindOf.get(k.o) && kindOf.get(k.o) !== 'Secret') continue
    for (const c of by.conceals || []) {
      if (c.o !== k.o || c.s === k.s) continue
      add(k.s, 'has_leverage_over', c.s, 'secret_leverage', 'secret', 0.9, { secret: k.o })
    }
  }

  // 4. 소속의 적대는 구성원에게 내려온다. 구성원끼리 곱하면 금세 시끄러워지므로
  //    캐릭터 → 상대 집단 한 단계까지만 만든다
  for (const m of by.member_of || []) {
    for (const r of by.rival_of || []) {
      const other = r.s === m.o ? r.o : r.o === m.o ? r.s : null
      if (!other || other === m.s) continue
      add(m.s, 'potential_rival_of', other, 'membership_rivalry', 'membership',
        num(r.props?.tension, 0.5), { via: m.o })
    }
  }

  // 5. 누군가를 노리면 그를 지키는 사람도 위협 범위에 든다
  for (const t of by.targets || []) {
    for (const p of by.protects || []) {
      if (p.s !== t.o) continue
      add(t.s, 'threatens', p.o, 'danger_propagation', 'danger', num(t.props?.tension, 0.7), { via: t.o })
    }
  }

  // 6. 섬기는 자가 사랑하면, 섬김을 받는 쪽에게 그 상대는 경쟁자가 된다
  for (const sv of by.serves || []) {
    for (const lv of by.loves || []) {
      if (lv.s !== sv.s || lv.o === sv.o) continue
      add(sv.o, 'rival_of', lv.o, 'love_chain', 'love_chain',
        Math.min(1, num(sv.props?.tension, 0.5) + 0.25), { via: sv.s })
    }
  }

  // 7. 값이 치러지지 않은 사건 옆에 비밀을 감춘 사람이 있으면 참여를 의심한다.
  //    확정이 아니라 씨앗이다. asserted:false 로 남는다
  const joined = new Set((by.participated_in || []).map((e) => e.o))
  const openEvents = ns.filter((n) => n.kind === 'Event' && !joined.has(n.id) && num(n.props?.t, 0) >= 0)
  for (const ev of openEvents) {
    for (const c of by.conceals || []) {
      add(c.s, 'participated_in', ev.id, 'secret_suspicion', 'secret', 0.85, { secret: c.o })
    }
  }

  return out
}
