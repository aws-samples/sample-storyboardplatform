#!/bin/bash
set -uxo pipefail
exec > >(tee -a /var/log/sb-setup.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3-venv python3-pip

install -d -o root -g root /opt/sb /opt/hf
python3 -m venv /opt/sb/venv
/opt/sb/venv/bin/pip install -q --upgrade pip==26.2.1 wheel==0.48.0

/opt/sb/venv/bin/pip install -q \
  torch==2.13.0 torchvision==0.28.0 diffusers==0.39.0 transformers==5.15.0 accelerate==1.14.0 \
  safetensors==0.8.0 sentencepiece==0.2.2 protobuf==7.35.1 \
  pillow==12.3.0 boto3==1.43.70 \
  "pyjwt[crypto]==2.13.0" "uvicorn[standard]==0.52.1" fastapi==0.141.1

aws s3 cp __SERVER_URI__ /opt/sb/server.py

cat > /etc/systemd/system/sb.service <<'SBUNITEOF'
[Unit]
Description=Storyboard image generation
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/sb
Environment=HF_HOME=/opt/hf
Environment=HOME=/opt/sb
Environment=SB_REGION=__REGION__
Environment=SB_BUCKET=__BUCKET__
Environment=SB_POOL=__POOL__
Environment=SB_CLIENT=__CLIENT__
Environment=SB_MODEL=__MODEL__
ExecStart=/opt/sb/venv/bin/uvicorn server:app --host 0.0.0.0 --port 8000 --timeout-keep-alive 75
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SBUNITEOF

cd /opt/sb && HF_HOME=/opt/hf SB_BUCKET=x SB_POOL=x SB_CLIENT=x /opt/sb/venv/bin/python server.py

systemctl daemon-reload
systemctl enable --now sb

cd /opt/sb && HF_HOME=/opt/hf HF_XET_HIGH_PERFORMANCE=1 SB_BUCKET=x SB_POOL=x SB_CLIENT=x \
  nohup /opt/sb/venv/bin/python server.py prefetch >> /var/log/sb-setup.log 2>&1 &

echo "sb: 서비스 시작. 기본 모델(약 26GB)을 받으면 /gen/health의 warm이 true가 된다."
echo "sb: 모델 세 벌(약 67GB) 내려받기는 배경에서 계속된다 — 다 받으면 화면에서 바로 갈아끼운다."
