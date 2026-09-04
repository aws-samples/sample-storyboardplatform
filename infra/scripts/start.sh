#!/bin/bash
# 관계 그래프(Neptune) 클러스터를 다시 켠다. 엔드포인트와 데이터는 세우기 전과 같다.
# available 이 되기 전까지 graph Lambda 는 연결 오류를 낸다 — 몇 분 기다려라.
set -euo pipefail

CLUSTER="${SB_NEPTUNE_CLUSTER:-storyboarddemo-graph}"
REGION="${AWS_REGION:-ap-northeast-2}"

aws neptune start-db-cluster --db-cluster-identifier "$CLUSTER" --region "$REGION" \
  --query 'DBCluster.[DBClusterIdentifier,Status]' --output text

echo "켜는 중입니다. 상태 확인:"
echo "  aws neptune describe-db-clusters --db-cluster-identifier $CLUSTER --region $REGION \\"
echo "    --query 'DBClusters[0].Status' --output text"
