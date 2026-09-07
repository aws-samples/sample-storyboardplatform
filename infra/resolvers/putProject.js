import { util } from '@aws-appsync/utils'

/*
 * 프로젝트 카드 한 장을 앉히거나 마지막 손길만 고친다.
 *
 * PutItem 이 아니라 UpdateItem 이다. 두 사람이 같은 보드를 열고 있으면 나중에 저장한
 * 쪽이 앞사람의 이름을 덮어쓴다. 이름·만든 사람·만든 시각은 if_not_exists 로 한 번만
 * 박고, 그 뒤 호출은 마지막 손길(updatedAt·lastActor·lastWhat)만 바꾼다.
 *
 * putOp.js 와 달리 ttl 을 걸지 않는다. op 는 30일 뒤에 사라져도 되지만 프로젝트 이름이
 * 사라지면 카드가 이름 없는 보드가 된다.
 */
export function request(ctx) {
  const { boardId, name, actor, what, ts } = ctx.args
  return {
    operation: 'UpdateItem',
    key: util.dynamodb.toMapValues({ pk: 'PROJECTS', sk: `P#${boardId}` }),
    update: {
      expression: [
        'SET #boardId = :boardId',
        '#name = if_not_exists(#name, :name)',
        '#createdAt = if_not_exists(#createdAt, :ts)',
        '#createdBy = if_not_exists(#createdBy, :actor)',
        '#updatedAt = :ts',
        '#lastActor = :actor',
        '#lastWhat = :what',
      ].join(', '),
      expressionNames: {
        '#boardId': 'boardId',
        '#name': 'name',
        '#createdAt': 'createdAt',
        '#createdBy': 'createdBy',
        '#updatedAt': 'updatedAt',
        '#lastActor': 'lastActor',
        '#lastWhat': 'lastWhat',
      },
      // 이름을 주지 않은 호출(손길만 고치는 쪽)이 처음으로 카드를 만들 수도 있다.
      // 그때 name 이 비면 Project.name 이 non-null 이라 응답이 깨지므로 boardId 를 넣어 둔다.
      expressionValues: util.dynamodb.toMapValues({
        ':boardId': boardId,
        ':name': name || boardId,
        ':ts': ts,
        ':actor': actor,
        ':what': what || '',
      }),
    },
  }
}

export function response(ctx) {
  if (ctx.error) util.error(ctx.error.message, ctx.error.type)
  return ctx.result
}
