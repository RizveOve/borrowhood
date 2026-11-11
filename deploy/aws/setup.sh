#!/bin/bash
# Sets up or updates BorrowHood on the EC2 instance created by template.yaml (Amazon Linux 2023).
# Safe to run again: the user data runs it on first boot, and deploy.sh runs it after pulling new code.
# Needs STACK (the CloudFormation stack name) and AWS_REGION. Runs as root.
set -euo pipefail
: "${STACK:?}" "${AWS_REGION:?}"
export AWS_REGION AWS_DEFAULT_REGION=$AWS_REGION
APP=/opt/borrowhood
DATA=$APP/data
LOGS=/var/log/borrowhood
LITESTREAM_VERSION=v0.3.13
param() { aws ssm get-parameter --name "/$STACK/$1" "${@:2}" --query Parameter.Value --output text; }

# --- Packages, and 1 GB of swap so npm and Node fit on a 0.5-1 GB instance
dnf install -y -q nodejs22 nodejs22-npm nginx amazon-cloudwatch-agent logrotate
alternatives --set node /usr/bin/node-22 2>/dev/null || true
alternatives --set npm /usr/bin/npm-22 2>/dev/null || true
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \
  || { echo "Node 22.13+ is required, found $(node -v)"; exit 1; }
if ! swapon --show | grep -q /swapfile; then
  [ -f /swapfile ] || { dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none; chmod 600 /swapfile; mkswap /swapfile; }
  swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap defaults 0 0' >> /etc/fstab
fi

# --- The app: code is owned by root and read-only to the app; it may only write data/ and its logs
id borrowhood &>/dev/null || useradd --system --no-create-home --shell /sbin/nologin borrowhood
install -d -o borrowhood -g borrowhood -m 750 "$DATA" "$LOGS"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

# --- Settings from SSM Parameter Store. Secrets are created once as SecureStrings and reused.
secret() {
  param "secrets/$1" --with-decryption 2>/dev/null && return
  aws ssm put-parameter --name "/$STACK/secrets/$1" --type SecureString --value "$2" >/dev/null
  param "secrets/$1" --with-decryption
}
SESSION_SECRET=$(secret SESSION_SECRET "$(openssl rand -hex 32)")
ADMIN_PASSWORD=$(secret ADMIN_PASSWORD "$(openssl rand -base64 18 | tr -d '/+=')")
umask 077
{ param config; echo "SESSION_SECRET=$SESSION_SECRET"; echo "ADMIN_PASSWORD=$ADMIN_PASSWORD"; } > "$APP/.env.new"
mv "$APP/.env.new" "$APP/.env" # root-only; systemd reads it before starting the app
umask 022
BUCKET=$(grep '^S3_BUCKET=' "$APP/.env" | cut -d= -f2)
ORIGIN_SECRET=$(param origin-secret)

# --- Litestream: streams every database change to S3, and restores it on a fresh instance
case $(uname -m) in aarch64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac
if ! /usr/local/bin/litestream version 2>/dev/null | grep -q "$LITESTREAM_VERSION"; then
  curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/$LITESTREAM_VERSION/litestream-$LITESTREAM_VERSION-linux-$ARCH.tar.gz" \
    | tar -xz -C /usr/local/bin litestream
fi
cat > /etc/litestream.yml <<EOF
dbs:
  - path: $DATA/borrowhood.db
    replicas:
      - type: s3
        bucket: $BUCKET
        path: litestream/borrowhood.db
        region: $AWS_REGION
        retention: 168h
EOF
runuser -u borrowhood -- /usr/local/bin/litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$DATA/borrowhood.db"

# --- systemd services (sandboxed: the app can't write outside its data and log folders)
cat > /etc/systemd/system/litestream.service <<EOF
[Unit]
Description=Litestream SQLite backup to S3
After=network-online.target
Wants=network-online.target

[Service]
User=borrowhood
Environment=AWS_REGION=$AWS_REGION
ExecStart=/usr/local/bin/litestream replicate -config /etc/litestream.yml
Restart=always
RestartSec=5
StandardOutput=append:$LOGS/litestream.log
StandardError=inherit

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/borrowhood.service <<EOF
[Unit]
Description=BorrowHood web app
After=network-online.target litestream.service
Wants=network-online.target

[Service]
User=borrowhood
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=always
RestartSec=3
StandardOutput=append:$LOGS/app.log
StandardError=inherit
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$DATA $LOGS
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/logrotate.d/borrowhood <<EOF
$LOGS/*.log {
  daily
  rotate 7
  compress
  missingok
  notifempty
  copytruncate
}
EOF

# --- nginx: only accepts requests that came through CloudFront (they carry the origin secret)
sed -i 's/listen       80 default_server;/listen 80;/; s/listen       \[::\]:80 default_server;/listen [::]:80;/' /etc/nginx/nginx.conf
cat > /etc/nginx/conf.d/borrowhood.conf <<EOF
server {
  listen 80 default_server;
  server_name _;
  server_tokens off;
  client_max_body_size 30m;
  gzip on;
  gzip_proxied any;
  gzip_types text/css application/javascript application/json image/svg+xml;

  if (\$http_x_origin_verify != "$ORIGIN_SECRET") { return 403; }

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$http_x_forwarded_for; # CloudFront already put the visitor's IP here
    proxy_set_header X-Forwarded-Proto https;               # CloudFront only accepts HTTPS from visitors
    proxy_set_header X-Origin-Verify "";
  }
}
EOF
nginx -t -q

# --- CloudWatch agent: ships the logs (14-day retention) plus memory and disk metrics
cat > /opt/aws/amazon-cloudwatch-agent/etc/borrowhood.json <<EOF
{
  "agent": { "metrics_collection_interval": 300 },
  "metrics": {
    "append_dimensions": { "InstanceId": "\${aws:InstanceId}" },
    "aggregation_dimensions": [["InstanceId"]],
    "metrics_collected": {
      "mem": { "measurement": ["mem_used_percent"] },
      "disk": { "measurement": ["used_percent"], "resources": ["/"] }
    }
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          { "file_path": "$LOGS/app.log", "log_group_name": "/$STACK/app", "log_stream_name": "{instance_id}/app" },
          { "file_path": "$LOGS/litestream.log", "log_group_name": "/$STACK/app", "log_stream_name": "{instance_id}/litestream" }
        ]
      }
    }
  }
}
EOF
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/borrowhood.json >/dev/null

# --- Start everything
systemctl daemon-reload
systemctl enable -q litestream borrowhood nginx
systemctl restart litestream borrowhood
systemctl reload-or-restart nginx
for _ in $(seq 30); do curl -fs http://127.0.0.1:3000/health >/dev/null && break; sleep 2; done
curl -fs http://127.0.0.1:3000/health >/dev/null || { echo "BorrowHood did not start; see $LOGS/app.log"; tail -20 "$LOGS/app.log"; exit 1; }
echo "BorrowHood is running. Admin password: SSM parameter /$STACK/secrets/ADMIN_PASSWORD"
