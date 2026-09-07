/*
 * 모델이 준 그래프·스토리 JSON 을 믿을 수 있는 모양으로 만드는 규칙입니다.
 * DOM 도 네트워크도 건드리지 않습니다. graph-schema.js 의 어휘만 봅니다.
 */

import { GRAPH_SCHEMA, romanizeId, edgeKey } from './graph-schema.js'
import { clip, asList, secsOf } from '../lib/guards.js'

const KIND_OK = new Set(GRAPH_SCHEMA.nodeKinds)
const REL_OK = new Set(GRAPH_SCHEMA.edgeRels)
const DERIVED_ONLY = new Set(GRAPH_SCHEMA.derivedRels)

const asProps = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {})

/** 문자열을 노드 id 모양([a-z0-9_])으로 만든다. 한국어면 로마자로 옮긴다. */
const asId = (v) => {
  const raw = String(v ?? '').trim()
  if (!raw) return ''
  const slug = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return (slug || romanizeId(raw)).slice(0, 48)
}

const tensionOf = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100))
}

/**
 * 모델이 뽑아온 그래프 JSON을 검사하고 app-walkthrough/data/graph.json 모양으로 맞춘다.
 * 여기를 통과한 것만 판에 올린다. 잘못된 입력이 보드 상태를 더럽히면 안 된다.
 *
 * 하는 일
 *   - nodes/edges 배열이 아니면 빈 배열로 두고 경고를 남긴다
 *   - 노드는 name 필수, kind 는 GRAPH_SCHEMA.nodeKinds 안의 값만 남긴다
 *   - id 가 없으면 이름의 로마자로 만들고, 겹치면 뒤에 번호를 붙인다
 *   - 같은 id 가 두 번 오면 처음 것을 남기고 props 만 합친다
 *   - 엣지는 s/o 가 실제 노드를 가리켜야 한다. 이름으로 왔으면 id 로 옮긴다
 *   - p 는 GRAPH_SCHEMA.edgeRels 안의 값만, 파생 전용 술어는 asserted:false 로 내린다
 *
 * @param {Object} raw - 모델이 준 {nodes, edges}
 * @param {Object} [opts]
 * @param {number} [opts.maxNodes=300] 노드 상한
 * @param {number} [opts.maxEdges=900] 엣지 상한
 * @returns {{nodes: Array, edges: Array, warnings: Array<string>}}
 */
export function normalizeGraph(raw, { maxNodes = 300, maxEdges = 900 } = {}) {
  const warnings = []
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (!raw || typeof raw !== 'object') warnings.push('그래프가 객체가 아닙니다. 빈 그래프로 둡니다')
  const rawNodes = src.nodes ?? src.entities
  const rawEdges = src.edges ?? src.relations ?? src.links
  if (!Array.isArray(rawNodes)) warnings.push('nodes 배열이 없습니다')
  if (!Array.isArray(rawEdges)) warnings.push('edges 배열이 없습니다')

  const nodes = []
  const byId = new Map()
  const byName = new Map()
  for (const n of asList(rawNodes)) {
    if (!n || typeof n !== 'object') { warnings.push('노드가 객체가 아닙니다. 버립니다'); continue }
    const name = clip(n.name ?? n.label, 60)
    const kind = clip(n.kind ?? n.type, 20)
    if (!name) { warnings.push(`이름 없는 노드를 버립니다 (id=${clip(n.id, 40) || '없음'})`); continue }
    if (!KIND_OK.has(kind)) {
      warnings.push(`${name}: 모르는 kind "${kind || '없음'}". 노드를 버립니다`)
      continue
    }
    const props = asProps(n.props ?? n.attrs)
    const given = asId(n.id)
    let id = given
    if (!id) {
      id = asId(name) || `n${nodes.length + 1}`
      let seq = 2
      while (byId.has(id)) id = `${asId(name) || 'n'}_${seq++}`
      warnings.push(`${name}: id 가 없어 "${id}" 로 만들었습니다. 통용 표기와 다를 수 있습니다`)
    }
    const prev = byId.get(id)
    if (prev) {
      prev.props = { ...props, ...prev.props }
      warnings.push(`중복 id "${id}" (${prev.name} / ${name}). 처음 것만 남기고 props 를 합칩니다`)
      continue
    }
    if (nodes.length >= maxNodes) { warnings.push(`노드가 ${maxNodes}개를 넘어 나머지를 잘랐습니다`); break }
    const node = { id, kind, name, props }
    nodes.push(node)
    byId.set(id, node)
    if (!byName.has(name)) byName.set(name, id)
  }

  // 이름·로마자로 들어온 참조를 id 로 되돌리기 위한 색인
  const alias = new Map()
  for (const [name, id] of byName) {
    alias.set(name, id)
    const rom = romanizeId(name)
    if (rom && !byId.has(rom)) alias.set(rom, id)
  }
  const refOf = (v) => {
    const raw = String(v ?? '').trim()
    if (byId.has(raw)) return raw
    const id = asId(raw)
    if (byId.has(id)) return id
    const hit = alias.get(raw) ?? alias.get(id) ?? ''
    if (hit) warnings.push(`"${raw}" 는 id 가 아니라 이름입니다. "${hit}" 로 읽었습니다`)
    return hit
  }

  const edges = []
  const seen = new Set()
  for (const e of asList(rawEdges)) {
    if (!e || typeof e !== 'object') { warnings.push('엣지가 객체가 아닙니다. 버립니다'); continue }
    const sRaw = e.s ?? e.from ?? e.subject
    const oRaw = e.o ?? e.to ?? e.object
    const s = refOf(sRaw)
    const o = refOf(oRaw)
    const p = clip(e.p ?? e.rel ?? e.pred, 40).toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    const label = `${clip(sRaw, 40) || '없음'} ${p || '?'} ${clip(oRaw, 40) || '없음'}`
    if (!REL_OK.has(p)) { warnings.push(`${label}: 모르는 술어. 엣지를 버립니다`); continue }
    if (!s || !o) { warnings.push(`${label}: 없는 노드를 가리킵니다. 엣지를 버립니다`); continue }
    if (s === o) { warnings.push(`${label}: 자기 자신을 가리킵니다. 엣지를 버립니다`); continue }
    const key = edgeKey({ s, p, o })
    if (seen.has(key)) { warnings.push(`${label}: 같은 엣지가 두 번 왔습니다. 처음 것만 남깁니다`); continue }
    if (edges.length >= maxEdges) { warnings.push(`엣지가 ${maxEdges}개를 넘어 나머지를 잘랐습니다`); break }
    seen.add(key)

    const props = asProps(e.props)
    const t = tensionOf(props.tension ?? e.tension)
    if (t === null) delete props.tension
    else props.tension = t
    if (e.cause && !props.cause) props.cause = clip(e.cause, 200)

    let asserted = e.asserted === undefined ? !e.derived : !!e.asserted
    let derived = clip(e.derived, 40) || null
    if (DERIVED_ONLY.has(p) && asserted) {
      warnings.push(`${label}: 파생 전용 술어라 asserted:false 로 내립니다`)
      asserted = false
      derived = derived || 'unknown'
    }
    const edge = { s, p, o, asserted }
    if (derived) edge.derived = derived
    if (Object.keys(props).length) edge.props = props
    edges.push(edge)
  }

  return { nodes, edges, warnings }
}

/** 노드 props 중 어긋나면 사실이 깨지는 키. t 와 kin 종류는 서사가 갈린다 */
const CANON_KEYS = { t: 'error', claim: 'warn', age: 'warn' }

/**
 * 새로 뽑은 그래프가 이미 확립된 그래프와 어긋나지 않는지 본다.
 * 예: 기존이 A kin_of B (sibling) 인데 새로 A kin_of B (parent) 로 오면 conflict.
 *
 * @param {Object} newGraph - 새로 추출한 {nodes, edges}
 * @param {Object} existingGraph - 이미 확립된 {nodes, edges}
 * @returns {{conflicts: Array<{level: string, kind: string, msg: string}>, compatible: boolean}}
 *          compatible 은 level 'error' 인 항목이 하나도 없을 때만 true
 */
export function validateAgainstCanon(newGraph, existingGraph) {
  const conflicts = []
  const put = (level, kind, msg) => conflicts.push({ level, kind, msg })
  const nn = asList(newGraph?.nodes)
  const ne = asList(newGraph?.edges)
  const on = asList(existingGraph?.nodes)
  const oe = asList(existingGraph?.edges)

  const oldById = new Map(on.map((n) => [n.id, n]))
  const oldByName = new Map(on.map((n) => [n.name, n]))

  for (const n of nn) {
    const prev = oldById.get(n.id)
    if (prev) {
      if (prev.kind !== n.kind) put('error', 'node_kind', `${n.id}: 기존 ${prev.kind} 인데 새로 ${n.kind} 로 왔습니다`)
      if (prev.name !== n.name) put('error', 'node_name', `${n.id}: 기존 "${prev.name}" 인데 새로 "${n.name}" 입니다. 다른 인물이 같은 id 를 씁니다`)
      for (const [k, level] of Object.entries(CANON_KEYS)) {
        const a = prev.props?.[k]
        const b = n.props?.[k]
        if (a !== undefined && b !== undefined && String(a) !== String(b)) {
          put(level, `node_${k}`, `${n.name}: ${k} 가 기존 ${a} 인데 새로 ${b} 입니다`)
        }
      }
      continue
    }
    const same = oldByName.get(n.name)
    if (same) put('warn', 'alias_split', `"${n.name}" 이 기존 id "${same.id}" 와 새 id "${n.id}" 로 갈라집니다`)
  }

  const oldEdges = new Map(oe.map((e) => [edgeKey(e), e]))
  const oldPairs = new Map()
  for (const e of oe) oldPairs.set(`${e.s}|${e.o}`, [...(oldPairs.get(`${e.s}|${e.o}`) || []), e])

  for (const e of ne) {
    const prev = oldEdges.get(edgeKey(e))
    if (prev) {
      const a = prev.props?.type
      const b = e.props?.type
      if (a !== undefined && b !== undefined && a !== b) {
        put('error', 'edge_type', `${e.s} ${e.p} ${e.o}: 기존 type "${a}" 인데 새로 "${b}" 입니다`)
      }
      if (prev.asserted === true && e.asserted === false) {
        put('warn', 'edge_downgrade', `${e.s} ${e.p} ${e.o}: 기존은 명시인데 새로 추론으로 왔습니다`)
      }
      continue
    }
    // 같은 두 노드 사이에 서로 못 서는 관계가 붙는 경우
    for (const old of oldPairs.get(`${e.s}|${e.o}`) || []) {
      if ((old.p === 'targets' && e.p === 'protects') || (old.p === 'protects' && e.p === 'targets')) {
        put('warn', 'rel_mutex', `${e.s}→${e.o}: 기존 ${old.p} 와 새 ${e.p} 가 함께 섭니다`)
      }
    }
    // 비밀: 아는 사람과 모르는 사람이 같을 수는 없다
    if (e.p === 'knows' && oldEdges.has(edgeKey({ s: e.o, p: 'hidden_from', o: e.s }))) {
      put('error', 'secret_contradiction', `${e.s} 는 ${e.o} 를 모르는 쪽으로 기록돼 있습니다 (hidden_from)`)
    }
    if (e.p === 'hidden_from' && oldEdges.has(edgeKey({ s: e.o, p: 'knows', o: e.s }))) {
      put('error', 'secret_contradiction', `${e.o} 는 ${e.s} 를 아는 쪽으로 기록돼 있습니다 (knows)`)
    }
  }

  return { conflicts, compatible: !conflicts.some((c) => c.level === 'error') }
}

/**
 * 그래프 여러 조각을 하나로 합친다. 긴 대본을 나눠 추출할 때 쓴다.
 * 노드는 id 기준으로 처음 것을 남기고 props 를 합치고, 엣지는 s·p·o 로 중복을 뺀다.
 *
 * @param {...Object} parts - {nodes, edges} 조각들
 * @returns {{nodes: Array, edges: Array}}
 */
export function mergeGraphs(...parts) {
  const byId = new Map()
  const byKey = new Map()
  for (const g of parts) {
    for (const n of asList(g?.nodes)) {
      const prev = byId.get(n.id)
      if (prev) prev.props = { ...asProps(n.props), ...asProps(prev.props) }
      else byId.set(n.id, { ...n, props: asProps(n.props) })
    }
    for (const e of asList(g?.edges)) {
      const key = edgeKey(e)
      const prev = byKey.get(key)
      if (!prev) byKey.set(key, e)
      else if (!prev.asserted && e.asserted) byKey.set(key, e) // 명시가 추론을 이긴다
    }
  }
  const nodes = [...byId.values()]
  const ids = new Set(byId.keys())
  return { nodes, edges: [...byKey.values()].filter((e) => ids.has(e.s) && ids.has(e.o)) }
}

const BRANCH_IDS = ['A', 'B', 'C', 'D']

/** 역기입 엣지 목록을 정리한다. s·o 는 id 든 이름이든 그대로 둔다. 얹을 때 store 가 옮긴다 */
const wbEdges = (list, warnings, label) => {
  const out = []
  for (const e of asList(list)) {
    if (!e || typeof e !== 'object') { warnings.push(`${label}: 엣지가 객체가 아닙니다. 버립니다`); continue }
    const s = clip(e.s ?? e.from ?? e.subject, 60)
    const o = clip(e.o ?? e.to ?? e.object, 60)
    const p = clip(e.p ?? e.rel ?? e.pred, 40).toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    if (!REL_OK.has(p)) { warnings.push(`${label}: 어휘에 없는 술어 "${p || '없음'}". 엣지를 버립니다`); continue }
    if (!s || !o) { warnings.push(`${label}: ${p} 엣지의 s/o 가 비었습니다. 버립니다`); continue }
    const edge = { s, p, o }
    const note = clip(e.note ?? e.cause, 120)
    if (note) edge.note = note
    const props = asProps(e.props)
    const t = tensionOf(props.tension ?? e.tension)
    if (t === null) delete props.tension
    else props.tension = t
    if (Object.keys(props).length) edge.props = props
    out.push(edge)
  }
  return out
}

/**
 * 모델이 만든 분기 스토리를 검사하고 app-walkthrough/data/stories.json 모양으로 맞춘다.
 * normalizeGraph 와 같은 자리에서 같은 일을 한다: 뷰어에 올릴 수 있는 것만 통과시키고,
 * 버린 것은 warnings 로 남겨 화면에 띄운다.
 *
 * 받아 주는 별칭 (지시서 스키마 ↔ app-walkthrough/data/stories.json 스키마)
 *   label ← title / tone ← subtitle / premise ← summary / outcome ← consequence
 *   writeback.nodes ← add_nodes / writeback.edges ← add_edges / writeback.remove_edges ← remove
 *
 * beats 는 문자열(app-walkthrough/data/stories.json)과 {scene, action, secs, cast} 객체를 모두 받는다.
 * 객체로 온 것은 구조를 지켜 준다. 다음 단계에서 컷으로 펼칠 때 쓴다.
 *
 * @param {Object} raw - 모델이 준 {title, logline, pivot, branches}
 * @param {Object} [opts]
 * @param {number} [opts.maxBranches=4] 분기 상한
 * @param {number} [opts.maxBeats=8] 분기 하나의 비트 상한
 * @returns {{title: string, logline: string, pivot: {title: string, body: string},
 *            branches: Array, warnings: Array<string>}}
 */
export function normalizeStory(raw, { maxBranches = 4, maxBeats = 8 } = {}) {
  const warnings = []
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (src !== raw) warnings.push('스토리가 객체가 아닙니다. 빈 스토리로 둡니다')
  const rawBranches = src.branches ?? src.options ?? src.paths
  if (!Array.isArray(rawBranches)) warnings.push('branches 배열이 없습니다')

  const branches = []
  for (const b of asList(rawBranches)) {
    if (!b || typeof b !== 'object') { warnings.push('분기가 객체가 아닙니다. 버립니다'); continue }
    if (branches.length >= maxBranches) { warnings.push(`분기가 ${maxBranches}개를 넘어 나머지를 잘랐습니다`); break }
    const id = clip(b.id, 2).toUpperCase() || BRANCH_IDS[branches.length] || String(branches.length + 1)
    const label = clip(b.label ?? b.title, 40)
    const premise = clip(b.premise ?? b.summary ?? b.desc, 800)

    const beats = []
    for (const t of asList(b.beats ?? b.cuts)) {
      if (beats.length >= maxBeats) { warnings.push(`${id}: 비트가 ${maxBeats}개를 넘어 나머지를 잘랐습니다`); break }
      if (typeof t === 'string' || typeof t === 'number') {
        const line = clip(t, 400)
        if (line) beats.push(line)
        continue
      }
      if (!t || typeof t !== 'object') { warnings.push(`${id}: 비트가 문자열도 객체도 아닙니다. 버립니다`); continue }
      const action = clip(t.action ?? t.summary ?? t.text, 400)
      if (!action) { warnings.push(`${id}: action 없는 비트를 버립니다`); continue }
      const beat = { action }
      const scene = clip(t.scene, 24)
      if (scene) beat.scene = scene
      const secs = Number(t.secs ?? t.duration)
      if (Number.isFinite(secs) && secs > 0) beat.secs = secsOf(secs)
      const cast = [...new Set(asList(t.cast).map((n) => clip(n, 20)).filter(Boolean))].slice(0, 6)
      if (cast.length) beat.cast = cast
      beats.push(beat)
    }

    const outcome = {}
    for (const [k, v] of Object.entries(asProps(b.outcome ?? b.consequence))) {
      const key = clip(k, 24)
      const val = clip(v && typeof v === 'object' ? Object.values(v).join(' ') : v, 160)
      if (!key || !val) { warnings.push(`${id}: 결과 "${key || k}" 를 읽지 못해 버립니다`); continue }
      outcome[key] = val
    }

    const wb = asProps(b.writeback)
    const nodes = []
    for (const n of asList(wb.nodes ?? wb.add_nodes)) {
      const name = clip(n?.name ?? n?.label, 60)
      const kind = clip(n?.kind ?? n?.type, 20)
      if (!name) { warnings.push(`${id} 역기입: 이름 없는 노드를 버립니다`); continue }
      if (!KIND_OK.has(kind)) {
        warnings.push(`${id} 역기입: 모르는 kind "${kind || '없음'}" (${name}). 노드를 버립니다`)
        continue
      }
      const node = { name, kind }
      const nid = clip(n.id, 48)
      if (nid) node.id = nid
      const t = Number(n.t ?? n.props?.t)
      if (Number.isFinite(t)) node.t = t
      const desc = clip(n.desc ?? n.brief ?? n.props?.desc, 300)
      if (desc) node.desc = desc
      const claim = clip(n.claim ?? n.props?.claim, 300)
      if (claim) node.claim = claim
      nodes.push(node)
    }

    const writeback = {
      nodes,
      edges: wbEdges(wb.edges ?? wb.add_edges, warnings, `${id} 역기입`),
      remove_edges: wbEdges(wb.remove_edges ?? wb.remove ?? wb.removeEdges, warnings, `${id} 역기입 삭제`),
    }

    if (!label && !premise && !beats.length) { warnings.push(`${id}: 빈 분기를 버립니다`); continue }
    if (!label) warnings.push(`${id}: label 이 없어 "분기 ${id}" 로 둡니다`)
    if (!premise) warnings.push(`${id}: 전개 요약(premise)이 없습니다`)
    if (!beats.length) warnings.push(`${id}: 비트가 없습니다`)

    branches.push({
      id,
      label: label || `분기 ${id}`,
      tone: clip(b.tone ?? b.subtitle, 60),
      premise,
      beats,
      outcome,
      writeback,
    })
  }

  if (!branches.length) warnings.push('쓸 수 있는 분기가 하나도 없습니다')

  const pivot = asProps(src.pivot)
  const out = {
    title: clip(src.title, 80),
    logline: clip(src.logline, 400),
    pivot: {
      title: clip(pivot.title ?? src.pivotTitle, 120),
      body: clip(pivot.body ?? pivot.desc ?? src.pivotBody, 800),
    },
    branches,
    warnings,
  }
  const probe = clip(src.probe, 40)
  if (probe) out.probe = probe
  return out
}

