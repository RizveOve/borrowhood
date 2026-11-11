#!/bin/bash
# Deploys BorrowHood to AWS from your computer. Run from anywhere in the repo:  deploy/aws/deploy.sh
#   1. creates or updates the CloudFormation stack (template.yaml)
#   2. uploads the frontend files to S3 and clears the CloudFront cache
#   3. updates the app on the EC2 instance through SSM (no SSH)
# Needs the AWS CLI v2, logged in to your account. Settings come from deploy/aws/config.env.
set -euo pipefail
cd "$(dirname "$0")/../.."
CONFIG=deploy/aws/config.env
[ -f "$CONFIG" ] || { echo "Copy deploy/aws/config.example.env to $CONFIG and fill it in first."; exit 1; }
# shellcheck source=/dev/null
source "$CONFIG"
STACK=${STACK:-borrowhood}
BRANCH=${BRANCH:-main}
export AWS_REGION=${AWS_REGION:-eu-north-1} AWS_DEFAULT_REGION=${AWS_REGION:-eu-north-1}
: "${ALERT_EMAIL:?Set ALERT_EMAIL in $CONFIG}" "${ADMIN_EMAIL:?Set ADMIN_EMAIL in $CONFIG}"
command -v aws >/dev/null || { echo "Install the AWS CLI v2 first: https://aws.amazon.com/cli/"; exit 1; }

# The instance downloads the code from GitHub, so the S3 files and the server must come from the same pushed commit.
git fetch -q origin "$BRANCH"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH")" ] && [ "${FORCE:-}" != 1 ]; then
  echo "Your checkout is not the same commit as origin/$BRANCH. Push (or check out $BRANCH) first, or run with FORCE=1."
  exit 1
fi

output() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

params=(
  "AlertEmail=$ALERT_EMAIL" "AdminEmail=$ADMIN_EMAIL"
  "InstanceType=${INSTANCE_TYPE:-t4g.micro}" "SeedDemo=${SEED_DEMO:-0}"
  "RepoUrl=$(git remote get-url origin)" "Branch=$BRANCH"
  "DomainName=${DOMAIN_NAME:-}" "CertificateArn=${CERTIFICATE_ARN:-}" "HostedZoneId=${HOSTED_ZONE_ID:-}"
  "MailDomain=${MAIL_DOMAIN:-}" "SesFrom=${SES_FROM:-}"
  "CloudFrontPrefixListId=$(aws ec2 describe-managed-prefix-lists \
     --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
     --query 'PrefixLists[0].PrefixListId' --output text)"
)
if aws cloudformation describe-stacks --stack-name "$STACK" >/dev/null 2>&1; then
  NEW=0 # AmiId and OriginSecret keep their current values, so the instance is never replaced by accident
else
  NEW=1
  params+=(
    "AmiId=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)"
    "OriginSecret=$(openssl rand -hex 32)"
  )
  echo "Creating stack $STACK in $AWS_REGION. CloudFront takes 5-10 minutes the first time."
fi

aws cloudformation deploy --stack-name "$STACK" --template-file deploy/aws/template.yaml \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides "${params[@]}"

# Monthly cost budget, created once (the Budgets API is global, and CloudFormation can't create budgets
# in every region). It counts usage before credits, so the alerts show how fast the credits are going.
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
if ! aws budgets describe-budget --region us-east-1 --account-id "$ACCOUNT" --budget-name "$STACK-monthly" >/dev/null 2>&1; then
  alert() { echo "{\"Notification\":{\"NotificationType\":\"$1\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":$2,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$ALERT_EMAIL\"}]}"; }
  aws budgets create-budget --region us-east-1 --account-id "$ACCOUNT" \
    --budget "{\"BudgetName\":\"$STACK-monthly\",\"BudgetType\":\"COST\",\"TimeUnit\":\"MONTHLY\",\"BudgetLimit\":{\"Amount\":\"${MONTHLY_BUDGET:-10}\",\"Unit\":\"USD\"},\"CostTypes\":{\"IncludeCredit\":false,\"IncludeRefund\":false}}" \
    --notifications-with-subscribers "[$(alert ACTUAL 50),$(alert FORECASTED 100)]"
  echo "Created a \$${MONTHLY_BUDGET:-10}/month budget with alerts to $ALERT_EMAIL."
fi

echo "Uploading frontend files..."
npm run build --silent
FRONTEND=$(output FrontendBucket)
aws s3 sync public "s3://$FRONTEND" --delete --exclude 'stock/*' --cache-control 'public, max-age=86400' --only-show-errors
aws s3 sync public/stock "s3://$FRONTEND/stock" --delete --cache-control 'public, max-age=604800' --only-show-errors
aws cloudfront create-invalidation --distribution-id "$(output DistributionId)" --paths '/*' >/dev/null

INSTANCE=$(output InstanceId)
if [ "$NEW" = 0 ]; then
  echo "Updating the app on $INSTANCE..."
  CMD="set -e; cd /opt/borrowhood; git fetch -q --depth 1 origin $BRANCH; git reset -q --hard FETCH_HEAD; STACK=$STACK AWS_REGION=$AWS_REGION bash deploy/aws/setup.sh"
  ID=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment "Deploy BorrowHood" \
    --parameters "{\"commands\":[\"$CMD\"]}" --query Command.CommandId --output text)
  while :; do
    STATUS=$(aws ssm get-command-invocation --command-id "$ID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
    case $STATUS in
      Success) break ;;
      Failed | Cancelled | TimedOut)
        aws ssm get-command-invocation --command-id "$ID" --instance-id "$INSTANCE" --query '[StandardOutputContent, StandardErrorContent]' --output text
        echo "Update failed ($STATUS)."; exit 1 ;;
    esac
    sleep 5
  done
fi

SITE=$(output SiteUrl)
echo "Waiting for $SITE ..."
for _ in $(seq 120); do curl -fs "$SITE/health" >/dev/null && break; sleep 5; done
curl -fs "$SITE/health" >/dev/null || { echo "The site is not answering yet. Check the logs in CloudWatch: /$STACK/app"; exit 1; }

cat <<EOF

BorrowHood is live: $SITE
Admin login:    $ADMIN_EMAIL
Admin password: aws ssm get-parameter --name /$STACK/secrets/ADMIN_PASSWORD --with-decryption --query Parameter.Value --output text
Server shell:   aws ssm start-session --target $INSTANCE
EOF
[ "$NEW" = 1 ] && echo "Check $ALERT_EMAIL and confirm the AWS Notification subscription to get alerts."
aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?starts_with(OutputKey, 'Dkim')].OutputValue" --output text \
  | tr '\t' '\n' | sed '/^$/d; 1s/^/\nAdd these DNS records at your registrar so SES can send email:\n/'
