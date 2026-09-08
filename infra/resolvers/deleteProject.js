// updated: 2026-09-08 r1. 이 줄을 고치면 인라인 코드 문자열이 바뀌어 리졸버가 강제로 갱신된다
//
// 프로젝트 하나를 지운다. 카드 · 에셋 · op 로그 · Neptune 그래프 전부다.
//
// ══ 왜 감독만인가
//
// 다른 일은 되돌릴 수 있다. 대본을 잘못 만들면 다시 만들고, 그래프를 잘못 저장하면
// saveGraph 가 덮어쓴다. 지우기에는 그 자리가 없다. 그래서 만드는 권한이 가장 넓은
// 기획도 빼고, 팀에서 그 결정을 하는 한 사람에게만 둔다.
//
// 화면 쪽의 짝은 app/domain/permissions.js 의 JOB_ROLES.deleteProject 다. 한쪽만
// 고치면 버튼은 열려 있는데 여기서 튕기거나(더 나쁘게는) 될 일을 화면이 막는다.
// app/test.html 이 두 곳을 맞대어 본다.
//
// ══ 왜 DynamoDB 데이터소스가 아니라 Lambda 인가
//
// 지울 것이 몇 개인지 모른다. op 는 한 판에 수백 줄이 되고(컷·댓글·명부), JS 리졸버는
// 한 번에 한 요청만 보내고 그 안에서 돌 수 없다. BatchDeleteItem 한 번은 25건이라
// 그것을 넘는 판은 반쯤만 지워진다. 카드는 사라졌는데 주소로 열면 컷이 그대로 있고
// 아무 화면에서도 그것을 다시 지울 수 없는 상태다 — 지우지 않은 것보다 나쁘다.
// GraphFn 은 Query → BatchWrite 를 다 지울 때까지 돈다.
//
// ══ plan 과 달리 Event 가 아니다
//
// 동기로 기다린다(invocationType 을 주지 않으면 RequestResponse 다). 지우기는 결과를
// 봐야 하는 일이라서다. 「지웠습니다」와 「340줄 중 몇 줄이 남았습니다」는 사람이 다음에
// 할 일이 다르다. AppSync 의 30초 상한에 걸리면 브라우저는 오류를 받지만 Lambda 는
// 계속 돌아 끝을 낸다(카드는 그쪽이 마지막에 지운다). 그때 목록을 새로 읽으면 사라져
// 있으므로, 화면은 실패했을 때도 목록을 다시 읽는다.
import { util } from '@aws-appsync/utils'

// 감독만. app/domain/permissions.js 의 JOB_ROLES.deleteProject 와 같은 값이어야 한다
const ROLES = ['director']

export function request(ctx) {
  const claims = ctx.identity?.claims || {}
  if (ROLES.indexOf(claims['custom:role'] || 'reviewer') < 0) util.unauthorized()

  const raw = ctx.args.boardId
  const boardId = raw && raw.length ? '' + raw : ''
  if (!boardId.length) util.error('어느 프로젝트인지 없습니다', 'BadRequest')

  return {
    operation: 'Invoke',
    payload: {
      operation: 'deleteProject',
      // Neptune 의 projectId 는 보드 id 를 그대로 쓴다(app/services/graph.js). 그래도
      // 따로 넘겨 둔다. 그쪽 규칙이 바뀌어도 여기를 고치면 된다
      payload: { boardId, projectId: boardId },
    },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  const r = ctx.result || {}
  const d = r.deleted || {}
  /*
   * 지운 수를 세어 돌려준다. 화면이 「op 340줄과 에셋 3개를 지웠습니다」로 적는다.
   * left 가 0 이 아니면 다 못 지운 것이고, 그때 카드는 일부러 남아 있다.
   */
  return {
    boardId: r.boardId || ctx.args.boardId,
    ops: d.ops || 0,
    assets: d.assets || 0,
    card: (d.card || 0) > 0,
    left: r.left || 0,
    graph: r.graph || 'skipped',
  }
}
