#!/usr/bin/env node
// 세계관 확장 이력(StoryHistory)이 회차를 제대로 세는지 배포 없이 돌려본다.
// graph/index.js 를 그대로 로드하고 Neptune · DynamoDB · Bedrock 만 메모리 스텁으로
// 갈아 끼운다. 프롬프트에 적히는 "총 N회 확장" 이 이 검사가 보는 값이다.
//
//   node infra/scripts/check-history.mjs
//
// AWS 권한이 필요 없다. 네트워크도 쓰지 않는다.
//
// 왜 이 검사가 있나. 챗봇이 "세계관이 몇 번 확장됐어?" 에 답하는 근거가 세 곳에서
// 오기 때문이다 — 서버 이력(putHistory·listHistory) · 브라우저가 이 판에서 센 회차
// (graphData.writebackRounds) · 마지막 한 건(recentWriteback). 한때 마지막 한 건만
// 받았고, 그래서 이력 왕복 한 건이 떨어지자 두 번 붙인 세계관이 "1회 확장" 으로
// 답해지고 첫 회차가 사라졌다. 아래 3번이 그 자리다.
import path from 'node:path'
import Module from 'node:module'
import { createRequire } from 'node:module'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))
const LAMBDA = path.join(HERE, '..', 'graph', 'index.js')

// ── 스텁 ─────────────────────────────────────────────────────────────────────
// Neptune 트래버설은 무엇을 이어 붙여도 되는 체인 하나로 받는다. 이력만 담은
// updateGraph 는 Neptune 을 건드리지 않으므로 이 검사에는 그래프가 필요 없다.
const chain = new Proxy(function () {}, {
  get(t, k) {
    if (k === 'then') return undefined
    if (k === 'toList') return async () => []
    if (k === 'next') return async () => ({ value: 0, done: false })
    if (k === 'hasNext') return async () => false
    if (k === 'iterate') return async () => ({})
    return () => chain
  },
  apply: () => chain,
})

/** 메모리 DynamoDB. 키는 표 이름 + 파티션 + 정렬이다 (실제 표와 같은 짝) */
const rows = new Map()
const rowKey = (table, it) => `${table}|${it.pk ?? it.projectId}|${it.sk ?? it.timestamp}`
/** Bedrock 이 받은 요청. 마지막 프롬프트가 이 검사가 읽는 값이다 */
const sent = []

const stubs = {
  gremlin: {
    process: { statics: chain, P: {} },
    driver: { DriverRemoteConnection: class { close() {} } },
    structure: { Graph: class { traversal() { return { withRemote: () => chain } } } },
  },
  '@aws-sdk/client-bedrock-runtime': {
    BedrockRuntimeClient: class {
      async send(cmd) {
        sent.push(cmd.input)
        return { output: { message: { content: [{ text: '(검사 스텁)' }] } }, usage: {}, stopReason: 'end_turn' }
      }
    },
    ConverseCommand: class { constructor(input) { this.input = input } },
  },
  '@aws-sdk/client-dynamodb': { DynamoDBClient: class {} },
  '@aws-sdk/lib-dynamodb': {
    DynamoDBDocumentClient: {
      from: () => ({
        async send(cmd) {
          if (cmd.kind === 'put') { rows.set(rowKey(cmd.TableName, cmd.Item), cmd.Item); return {} }
          if (cmd.kind === 'query') {
            const want = cmd.ExpressionAttributeValues[':p']
            // 정렬 키가 ISO 시각으로 시작하므로 사전순이 곧 시간순이다 (실제 Query 와 같다)
            const items = [...rows.entries()]
              .filter(([k, it]) => k.startsWith(`${cmd.TableName}|`) && it.projectId === want)
              .map(([, it]) => it)
              .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
            return { Items: items }
          }
          return {}
        },
      }),
    },
    PutCommand: class { constructor(i) { Object.assign(this, i); this.kind = 'put' } },
    QueryCommand: class { constructor(i) { Object.assign(this, i); this.kind = 'query' } },
  },
}

const origLoad = Module._load
Module._load = function (request, ...rest) {
  if (Object.hasOwn(stubs, request)) return stubs[request]
  return origLoad.call(this, request, ...rest)
}

process.env.NEPTUNE_ENDPOINT = 'stub'
process.env.OPS_TABLE = 'Ops'
process.env.HISTORY_TABLE = 'StoryHistory'

const { handler } = createRequire(import.meta.url)(LAMBDA)

// ── 검사에 쓰는 값 ────────────────────────────────────────────────────────────

/** 브라우저의 writebackSummary 가 만드는 모양 그대로 (app/pages/story-graph.js) */
const round = (at, branch, id, name) => ({
  at,
  branch,
  addedNodes: [id],
  addedEdges: [{ s: id, p: 'involves', o: 'char.kaon' }],
  removedEdges: [],
  counts: { addedNodes: 1, addedEdges: 1, removedEdges: 0 },
  ko: { nodes: [`「${name}」 사건`], added: [`가온이 ${name}에 얽힌다`], removed: [] },
})

/** 지난 회차는 줄여 실어 보낸다 (app/domain/graph-writeback.js 의 thinWritebackRound) */
const thin = (wb) => ({ at: wb.at, branch: wb.branch, counts: wb.counts, ko: wb.ko })

const R1 = round('2026-09-08T01:00:00.000Z', '1. 공동도주', 'ev.escape', '공동도주')
const R2 = round('2026-09-08T01:20:00.000Z', '2. 추적자의 그림자', 'ev.shadow', '추적자의 그림자')

const NODES = [
  { id: 'char.kaon', kind: 'Character', name: '가온' },
  { id: 'ev.escape', kind: 'Event', name: '공동도주' },
  { id: 'ev.shadow', kind: 'Event', name: '추적자의 그림자' },
]

let projectSeq = 0
/** 검사마다 다른 프로젝트를 쓴다. 앞 검사가 남긴 이력이 섞이지 않게 */
const newProject = () => `check-${++projectSeq}`

/** 역기입 한 회차를 서버 이력에 남긴다 (브라우저의 keepWritebackHistory 가 하는 왕복) */
const writeRound = (projectId, wb) =>
  handler({ operation: 'updateGraph', payload: { projectId, writeback: wb } })

/**
 * 챗봇에 한 번 묻고 프롬프트에 적힌 총 회차 수와 회차 머리글을 읽는다.
 * @param {Object} graphExtra - graphData 에 얹는 것 {recentWriteback?, writebackRounds?}
 */
async function askCount(projectId, graphExtra) {
  sent.length = 0
  await handler({ operation: 'navigate', payload: {
    jobId: `job-${projectId}`,
    owner: 'checker',
    projectId,
    question: '세계관이 몇 번 확장됐어?',
    graphData: JSON.stringify({ nodes: NODES, edges: [], ...graphExtra }),
    conversationHistory: '[]',
    model: 'sonnet-5',
  } })
  const last = sent[sent.length - 1]
  const text = last ? last.messages[last.messages.length - 1].content[0].text : ''
  const total = Number((text.match(/총 (\d+)회 확장되었다/) || [])[1] || 0)
  const heads = [...text.matchAll(/### (\d+)회차 · ([^\n(]+)/g)].map((m) => `${m[1]}:${m[2].trim()}`)
  return { total, heads, text }
}

// ── 검사 ─────────────────────────────────────────────────────────────────────
let bad = 0
const ok = (name, pass, got = '') => {
  if (!pass) bad++
  console.log(`${pass ? '✓' : '✗'} ${name}${pass || !got ? '' : `\n    받은 것: ${got}`}`)
}

// 1. 이력 왕복이 둘 다 성공한 보통의 경우
{
  const p = newProject()
  const a = await writeRound(p, R1)
  const b = await writeRound(p, R2)
  ok('이력 왕복 두 번이 둘 다 남는다', a.historyKept === true && b.historyKept === true,
    JSON.stringify([a.historyKept, b.historyKept]))
  const got = await askCount(p, { recentWriteback: R2, writebackRounds: [thin(R1), thin(R2)] })
  ok('두 번 붙인 세계관은 2회로 센다', got.total === 2, `${got.total}회 · ${got.heads.join(' / ')}`)
  ok('회차마다 붙인 분기 이름이 적힌다',
    got.heads.join('/') === '1:1. 공동도주/2:2. 추적자의 그림자', got.heads.join(' / '))
}

// 2. 서버 이력이 통째로 비었을 때 (이력 표가 없는 배포 · 로컬 판 · 왕복 전부 실패)
{
  const p = newProject()
  const got = await askCount(p, { recentWriteback: R2, writebackRounds: [thin(R1), thin(R2)] })
  ok('서버 이력이 비어도 이 판에서 센 회차로 2회를 답한다', got.total === 2,
    `${got.total}회 · ${got.heads.join(' / ')}`)
  ok('사라진 회차의 내역도 브라우저가 들고 온 것으로 적힌다', got.text.includes('공동도주에 얽힌다'))
}

// 3. 첫 회차의 이력 왕복만 떨어진 경우 — 실제로 겪은 그 자리다
{
  const p = newProject()
  await writeRound(p, R2) // 1회차는 서버에 닿지 못했다
  const alone = await askCount(p, { recentWriteback: R2 })
  ok('마지막 한 건만 보내면 1회로 세어진다 (이력이 붙기 전의 동작)', alone.total === 1,
    `${alone.total}회 · ${alone.heads.join(' / ')}`)
  const got = await askCount(p, { recentWriteback: R2, writebackRounds: [thin(R1), thin(R2)] })
  ok('이 판에서 센 회차를 같이 보내면 2회로 센다', got.total === 2,
    `${got.total}회 · ${got.heads.join(' / ')}`)
  ok('1회차는 사라지지 않는다', got.heads[0] === '1:1. 공동도주', got.heads.join(' / '))
}

// 4. 같은 회차가 서버 이력과 브라우저에서 둘 다 올 때 (보통의 경우가 이렇다)
{
  const p = newProject()
  await writeRound(p, R1)
  await writeRound(p, R2)
  const got = await askCount(p, { recentWriteback: R2, writebackRounds: [thin(R1), thin(R2)] })
  ok('겹치는 회차를 두 번 세지 않는다', got.total === 2, `${got.total}회`)
  ok('겹칠 때는 내역이 많은 쪽(서버 이력)을 적는다',
    got.text.includes('가온이 공동도주에 얽힌다') && !/### 3회차/.test(got.text))
}

// 5. 역기입을 한 적이 없는 판
{
  const p = newProject()
  const got = await askCount(p, {})
  ok('붙인 적이 없으면 누적 이력 블록을 붙이지 않는다',
    got.total === 0 && !got.text.includes('세계관 확장 누적 이력'), `${got.total}회`)
}

console.log(bad ? `\n${bad}건 실패.` : '\n전부 통과. 회차 셈이 서버 이력 · 이 판의 회차 · 마지막 한 건에서 모두 맞다.')
process.exit(bad ? 1 : 0)
