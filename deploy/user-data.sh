#!/bin/bash
# EC2 user data for Amazon Linux 2023. Installs Node 22, the app, nginx, and starts BorrowHood.
# Before launching: set REPO_URL, and give the instance an IAM role with access to your S3 bucket + SES.
set -euxo pipefail
REPO_URL="https://github.com/RizveOve/borrowhood.git"
S3_BUCKET="borrowhood-photos-CHANGE-ME"
SES_FROM=""                       # e.g. no-reply@yourdomain.com once verified in SES
REGION="eu-north-1"

dnf install -y nodejs22 git nginx
alternatives --set node /usr/bin/node-22 || true
useradd --system --create-home --home-dir /opt/borrowhood borrowhood || true
git clone "$REPO_URL" /opt/borrowhood/app-src
cp -r /opt/borrowhood/app-src/. /opt/borrowhood/ && rm -rf /opt/borrowhood/app-src
cd /opt/borrowhood
npm ci --omit=dev

PUBLIC_IP=$(TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60") && \
  curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
cat > .env <<ENV
PORT=3000
APP_URL=http://$PUBLIC_IP
APP_TZ=Europe/Oslo
SESSION_SECRET=$(openssl rand -hex 32)
COOKIE_SECURE=0
ADMIN_EMAIL=admin@borrowhood.no
ADMIN_PASSWORD=$(openssl rand -base64 12)
DB_PATH=/opt/borrowhood/data/borrowhood.db
S3_BUCKET=$S3_BUCKET
AWS_REGION=$REGION
SES_FROM=$SES_FROM
ENV
chmod 600 .env
chown -R borrowhood:borrowhood /opt/borrowhood

cat > /etc/nginx/conf.d/borrowhood.conf <<'NGINX'
server {
  listen 80 default_server;
  client_max_body_size 10m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
NGINX
sed -i 's/listen       80 default_server;/listen 80;/; s/listen       \[::\]:80 default_server;/listen [::]:80;/' /etc/nginx/nginx.conf

cp deploy/borrowhood.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now borrowhood nginx
# Admin password: sudo grep ADMIN_PASSWORD /opt/borrowhood/.env
