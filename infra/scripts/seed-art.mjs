#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const OUT = path.join(HERE, '..', '..', 'demo', 'seed-art.js')
const PW = process.env.SB_PW
if (!PW) { console.error('SB_PW 환경변수에 u2 계정 비밀번호를 넣어주세요.'); process.exit(1) }
<<<<<<< HEAD
const REGION = 'ap-northeast-2'
=======
const REGION = process.env.SB_REGION || 'ap-northeast-2'
>>>>>>> origin/main

const out = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/sb-out.json', 'utf8')).StoryboardDemo
const { Url: url, UserPoolId: pool, ClientId: client } = out

const MINU = '40대 초반 한국인 남자 제빵사, 눈가 주름과 팔자주름, 지친 표정, 마른 체형, '
  + '짧은 검은 머리, 밀가루 묻은 남색 앞치마, 걷어올린 소매'
const JIYEON = '20대 후반 한국인 여자, 단정한 단발, 베이지 트렌치코트, 어깨에 멘 가방, '
  + '출근길 차림, 차분한 표정'
const SLOTS = [
  { id: 'char-1-p1', kind: 'pose', seed: 17, prompt: `${MINU}. 정면 구도, 카메라를 향해 선 자세` },
  { id: 'char-1-p2', kind: 'pose', seed: 17, prompt: `${MINU}. 3/4 측사면 구도, 반죽대 쪽으로 몸을 돌린 자세` },
  { id: 'char-1-p3', kind: 'pose', seed: 17, prompt: `${MINU}. 완전 측면 구도, 어깨선이 낮게 내려간 자세` },
  { id: 'char-2-p1', kind: 'pose', seed: 44, prompt: `${JIYEON}. 정면 구도, 카메라를 향해 선 자세` },
  { id: 'seed-cut-1', kind: 'cut', seed: 3, rough: true, prompt: '새벽 5시, 텅 빈 도시의 좁은 상가 거리. 가로등이 하나씩 꺼진다. 와이드 롱숏' },
  { id: 'seed-cut-2', kind: 'cut', seed: 4, rough: true, prompt: '제빵사의 두 손이 반죽을 치는 클로즈업. 밀가루가 공기 중에 흩날린다' },
  { id: 'seed-cut-3', kind: 'cut', seed: 5, prompt: '어두운 새벽 빵집 내부, 오븐 불빛만 켜져 있다. 혼자 일하는 제빵사의 실루엣. 미디엄 숏' },
  { id: 'seed-cut-6', kind: 'cut', seed: 6, prompt: '빵집 유리문이 열린다. 코트 차림의 젊은 여자가 문을 밀고 들어온다. 뒤에서 새벽빛이 역광으로 들어온다. 미디엄 숏' },
  { id: 'seed-cut-9', kind: 'cut', seed: 9, prompt: '창가 자리에 앉은 젊은 여자의 얼굴 클로즈업. 잔에서 올라온 김이 얼굴 앞을 지난다. 옆에서 아침 빛이 든다' },
]
const ROUGH = '거친 연필 러프 스케치, 빠르게 그린 제스처 선, 미완성, 명암 없음. '

const call = async (host, target, body) => {
  const r = await fetch(host, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
    body: JSON.stringify(body),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(j.message || JSON.stringify(j))
  return j
}

const auth = await call(
  `https://cognito-idp.${REGION}.amazonaws.com/`,
  'AWSCognitoIdentityProviderService.InitiateAuth',
  { AuthFlow: 'USER_PASSWORD_AUTH', ClientId: client, AuthParameters: { USERNAME: 'u2', PASSWORD: PW } },
)
const token = auth.AuthenticationResult?.IdToken
if (!token) throw new Error(`로그인 실패: ${JSON.stringify(auth).slice(0, 200)}`)
console.log(`로그인 u2 · 풀 ${pool}`)

const art = {}
for (const s of SLOTS) {
  const t0 = Date.now()
  const res = await fetch(`${url}/gen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      prompt: (s.rough ? ROUGH : '') + s.prompt,
      kind: s.kind,
      seed: s.seed,
    }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    const why = typeof j?.detail === 'string' ? j.detail.slice(0, 120) : ''
    console.error(`  ${s.id} 실패 ${res.status} ${why}`)
    continue
  }
  art[s.id] = { src: j.url, gen: { model: j.model, seed: j.seed, ms: j.ms }, prompt: s.prompt }
  console.log(`  ${s.id}  ${j.url}  ${j.ms}ms (왕복 ${Date.now() - t0}ms)`)
}

const body = [
  '// scripts/seed-art.mjs가 실제 모델로 만들어 넣은 그림이다. 직접 고치지 마라.',
  '// 비어 있으면 시드 보드는 art.js가 캔버스로 그린 자리표시 그림으로 돌아간다.',
  `export const SEED_ART = ${JSON.stringify(art, null, 2)}`,
  '',
].join('\n')
fs.writeFileSync(OUT, body)
console.log(`\n${Object.keys(art).length}/${SLOTS.length}장 → ${OUT}`)
