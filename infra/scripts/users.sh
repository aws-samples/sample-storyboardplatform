#!/bin/bash
set -euo pipefail

POOL="${1:?사용법: SB_PW='...' users.sh <UserPoolId>}"
PW="${SB_PW:?SB_PW 환경변수에 비밀번호를 넣어주세요 (8자 이상)}"

people=(
  "u1|김하나|planner|u1@example.com"
  "u2|이도현|artist|u2@example.com"
  "u3|박서준|director|u3@example.com"
  "u4|최유진|reviewer|u4@example.com"
  "u5|정민아|admin|u5@example.com"
)

for row in "${people[@]}"; do
  IFS='|' read -r id name role mail <<< "$row"
  aws cognito-idp admin-create-user \
    --user-pool-id "$POOL" --username "$id" \
    --message-action SUPPRESS \
    --user-attributes Name=name,Value="$name" Name=email,Value="$mail" \
      Name=email_verified,Value=true Name=custom:role,Value="$role" \
    >/dev/null 2>&1 || echo "  (이미 있음: $id)"
  aws cognito-idp admin-set-user-password \
    --user-pool-id "$POOL" --username "$id" --password "$PW" --permanent
  echo "$id  $name  $role  $mail"
done

echo "비밀번호는 SB_PW로 넣은 값입니다. 화면에도, 로그에도 남기지 않습니다."
