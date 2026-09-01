// kdh-extract-raw.json → normalizeGraph → deriveEdges → extracted-graph.json
// mock/graph.json 과 얼마나 겹치는지 함께 찍는다.
//   node fixtures/build.mjs        (demo/ 에서. node 22 이상)
import { readFile, writeFile } from 'node:fs/promises'
import { normalizeGraph, validateAgainstCanon } from '../core.js'
import { deriveEdges, edgeKey } from '../graph-schema.js'

const here = new URL('.', import.meta.url)
const read = async (p) => JSON.parse(await readFile(new URL(p, here), 'utf8'))

const raw = await read('kdh-extract-raw.json')
const canon = await read('../mock/graph.json')

const g = normalizeGraph(raw)
const derived = deriveEdges(g.nodes, g.edges)
const out = { nodes: g.nodes, edges: [...g.edges, ...derived] }

const keys = (es) => new Set(es.map(edgeKey))
const canonNodes = new Set(canon.nodes.map((n) => n.id))
const gotNodes = new Set(out.nodes.map((n) => n.id))
const canonKeys = keys(canon.edges)
const gotKeys = keys(out.edges)

const missNodes = [...canonNodes].filter((id) => !gotNodes.has(id))
const extraNodes = [...gotNodes].filter((id) => !canonNodes.has(id))
const missEdges = [...canonKeys].filter((k) => !gotKeys.has(k))
const extraEdges = [...gotKeys].filter((k) => !canonKeys.has(k))

console.log('경고', g.warnings.length)
for (const w of g.warnings) console.log('  -', w)
console.log('노드', out.nodes.length, '(canon', canon.nodes.length, ')')
console.log('엣지', out.edges.length, '명시', out.edges.filter((e) => e.asserted).length,
  '파생', out.edges.filter((e) => !e.asserted).length,
  '(canon', canon.edges.length, canon.edges.filter((e) => e.asserted).length,
  canon.edges.filter((e) => !e.asserted).length, ')')
console.log('빠진 노드', missNodes, '남는 노드', extraNodes)
console.log('빠진 엣지', missEdges)
console.log('남는 엣지', extraEdges)
console.log('파생 태깅', derived.every((e) => e.props?.derived_by) ? 'ok' : 'FAIL',
  derived.map((e) => `${e.s} ${e.p} ${e.o} [${e.props?.derived_by}]`))
console.log('canon 대조', JSON.stringify(validateAgainstCanon(out, canon)))

await writeFile(new URL('extracted-graph.json', here),
  `${JSON.stringify({
    _note: 'fixtures/kdh-synopsis.txt → extractGraphPrompt → (모델 응답 재현: kdh-extract-raw.json) → normalizeGraph + deriveEdges. fixtures/build.mjs 로 다시 만든다. story-graph.html?graph=fixtures/extracted-graph.json 으로 열어 확인한다.',
    ...out,
  }, null, 1)}\n`)
