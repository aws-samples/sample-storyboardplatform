// kdh-extract-raw.json → normalizeGraph → deriveEdges → extracted-graph.json
// 같은 폴더의 graph.json 과 얼마나 겹치는지 함께 찍습니다.
//   node app-walkthrough/data/build.mjs        (저장소 루트에서. node 22 이상)
import { readFile, writeFile } from 'node:fs/promises'
import { normalizeGraph, validateAgainstCanon } from '../../app/core.js'
import { deriveEdges, edgeKey } from '../../app/graph-schema.js'

const here = new URL('.', import.meta.url)
const read = async (p) => JSON.parse(await readFile(new URL(p, here), 'utf8'))

const raw = await read('kdh-extract-raw.json')
const canon = await read('graph.json')

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
    _note: 'kdh-synopsis.txt → extractGraphPrompt → (모델 응답 재현: kdh-extract-raw.json) → normalizeGraph + deriveEdges. app-walkthrough/data/build.mjs 로 다시 만듭니다. /story-graph.html?graph=/app-walkthrough/data/extracted-graph.json 으로 열어 확인합니다.',
    ...out,
  }, null, 1)}\n`)
