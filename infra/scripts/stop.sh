#!/bin/bash
# 관계 그래프(Neptune) 클러스터를 세운다. Provisioned 라서 켜져 있는 동안 시간당 요금이 붙는다.
# 데이터는 그대로 남고, 다시 켜면 같은 엔드포인트로 돌아온다.
#
# 주의: Neptune 은 세워둔 클러스터를 7일 뒤에 자동으로 다시 켠다. 오래 쓰지 않을 거라면
# 매주 다시 세우거나 `npx cdk destroy` 로 지워라.
set -euo pipefail

CLUSTER="${SB_NEPTUNE_CLUSTER:-storyboarddemo-graph}"
REGION="${AWS_REGION:-ap-northeast-2}"

aws neptune stop-db-cluster --db-cluster-identifier "$CLUSTER" --region "$REGION" \
  --query 'DBCluster.[DBClusterIdentifier,Status]' --output text

echo "세우는 중입니다. 몇 분 걸립니다 — scripts/start.sh 로 다시 켭니다."
