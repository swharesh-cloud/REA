#!/bin/bash
# Create an always-on AWS server running Liquid Trader. Run it in AWS CloudShell
# (console → the >_ icon), or anywhere the AWS CLI is logged in:
#
#   curl -fsSLO https://raw.githubusercontent.com/swharesh-cloud/REA/claude/liquid-trader-mac/liquid-trader/deploy/aws_launch.sh
#   curl -fsSLO https://raw.githubusercontent.com/swharesh-cloud/REA/claude/liquid-trader-mac/liquid-trader/deploy/aws_userdata.sh
#   bash aws_launch.sh "$(cat ~/.ssh/id_ed25519.pub)"      # your Mac's public key (recommended)
#   bash aws_launch.sh                                    # or: create a new key pair (.pem saved here)
#
# Options (environment variables):
#   AWS_REGION=ap-northeast-1   region (default: CloudShell's current region)
#   LT_INSTANCE_TYPE=t3.micro   1 GB RAM is plenty; ~US$8-10/month incl. disk + IPv4 (free-tier eligible accounts: $0)
#   LT_SSH_CIDR=1.2.3.4/32      who may SSH in (default: anywhere; key-only login, passwords disabled)
#
# Safe to re-run: it reuses the key pair and security group and refuses to start a second server.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PUBKEY="${1:-}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
REGION="${REGION:-us-east-1}"
TYPE="${LT_INSTANCE_TYPE:-t3.micro}"
CIDR="${LT_SSH_CIDR:-0.0.0.0/0}"
NAME="liquid-trader"
AWS=(aws --region "$REGION" --output text)

[[ -f "$HERE/aws_userdata.sh" ]] || { echo "aws_userdata.sh must be next to this script" >&2; exit 1; }
ACCOUNT="$("${AWS[@]}" sts get-caller-identity --query Account)"
echo "AWS account $ACCOUNT, region $REGION, instance type $TYPE"

EXISTING="$("${AWS[@]}" ec2 describe-instances \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,PublicIpAddress]')"
if [[ -n "$EXISTING" ]]; then
  echo "A '$NAME' server already exists: $EXISTING"
  echo "Update it from your Mac with:  ./deploy/deploy.sh ubuntu@<ip>"
  exit 0
fi

# --- SSH key ----------------------------------------------------------------
KEYNAME="$NAME"
if ! "${AWS[@]}" ec2 describe-key-pairs --key-names "$KEYNAME" >/dev/null 2>&1; then
  if [[ -n "$PUBKEY" ]]; then
    TMP="$(mktemp)"; printf '%s\n' "$PUBKEY" > "$TMP"
    "${AWS[@]}" ec2 import-key-pair --key-name "$KEYNAME" --public-key-material "fileb://$TMP" >/dev/null
    rm -f "$TMP"
    echo "Imported your public key as key pair '$KEYNAME'"
  else
    umask 077
    "${AWS[@]}" ec2 create-key-pair --key-name "$KEYNAME" --key-type ed25519 --query KeyMaterial > "$HOME/$KEYNAME.pem"
    chmod 600 "$HOME/$KEYNAME.pem"
    echo "Created key pair '$KEYNAME'. PRIVATE KEY SAVED TO $HOME/$KEYNAME.pem — download it now (Actions → Download file)."
  fi
fi

# --- network: default VPC + SSH-only security group ---------------------------
VPC="$("${AWS[@]}" ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId')"
[[ "$VPC" != "None" && -n "$VPC" ]] || { echo "No default VPC in $REGION. Create one: aws ec2 create-default-vpc" >&2; exit 1; }
SG="$("${AWS[@]}" ec2 describe-security-groups --filters Name=group-name,Values="$NAME-ssh" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId')"
if [[ "$SG" == "None" || -z "$SG" ]]; then
  SG="$("${AWS[@]}" ec2 create-security-group --group-name "$NAME-ssh" --vpc-id "$VPC" \
        --description "Liquid Trader: SSH only (dashboard is reached through an SSH tunnel)" --query GroupId)"
  "${AWS[@]}" ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr "$CIDR" >/dev/null
  echo "Created security group $SG (inbound: SSH from $CIDR only)"
fi

# --- AMI: latest official Ubuntu 24.04 from Canonical --------------------------
ARCH=amd64; [[ "$TYPE" == t4g* || "$TYPE" == *g.* ]] && ARCH=arm64
AMI="$("${AWS[@]}" ssm get-parameter \
  --name "/aws/service/canonical/ubuntu/server/24.04/stable/current/$ARCH/hvm/ebs-gp3/ami-id" --query Parameter.Value)"

# --- launch -----------------------------------------------------------------
CREDIT=(); [[ "$TYPE" == t* ]] && CREDIT=(--credit-specification CpuCredits=standard)  # no surprise burst charges
ID="$("${AWS[@]}" ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --key-name "$KEYNAME" \
  --security-group-ids "$SG" ${CREDIT[@]+"${CREDIT[@]}"} \
  --user-data "file://$HERE/aws_userdata.sh" \
  --metadata-options HttpTokens=required,HttpEndpoint=enabled \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=10,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
  --disable-api-termination \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" "ResourceType=volume,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId')"
echo "Launched $ID — waiting for it to start..."
"${AWS[@]}" ec2 wait instance-running --instance-ids "$ID"

# Static IP so the address never changes after a stop/start
ALLOC="$("${AWS[@]}" ec2 allocate-address --domain vpc \
  --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" --query AllocationId)"
"${AWS[@]}" ec2 associate-address --instance-id "$ID" --allocation-id "$ALLOC" >/dev/null
IP="$("${AWS[@]}" ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp')"

# Auto-recover onto healthy hardware if the underlying host fails
"${AWS[@]}" cloudwatch put-metric-alarm --alarm-name "$NAME-auto-recover" \
  --namespace AWS/EC2 --metric-name StatusCheckFailed_System --statistic Maximum \
  --period 60 --evaluation-periods 2 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --dimensions "Name=InstanceId,Value=$ID" \
  --alarm-actions "arn:aws:automate:$REGION:ec2:recover" >/dev/null 2>&1 \
  && echo "Auto-recovery alarm enabled" || echo "(auto-recovery alarm skipped)"

echo "Waiting for the app to install (2-4 minutes)..."
for i in $(seq 1 60); do
  if "${AWS[@]}" ec2 get-console-output --instance-id "$ID" --latest 2>/dev/null | grep -q "LIQUID-TRADER-READY"; then
    READY=1; break
  fi
  sleep 10
done

cat <<DONE

$( [[ "${READY:-0}" == 1 ]] && echo "✅ Liquid Trader is installed and running 24/7." || echo "⏳ Server is up; the app is still installing (check again in a minute)." )

  Instance:  $ID ($TYPE, $REGION)
  Address:   $IP   (Elastic IP - stays the same)

Next, on your Mac (in the liquid-trader folder):
  ./deploy/deploy.sh ubuntu@$IP          # adds your Liquid API key + phone alerts, moves bots
  ./deploy/dashboard.sh ubuntu@$IP       # opens the dashboard through an SSH tunnel
$( [[ -z "$PUBKEY" ]] && echo "First save the downloaded key:  mv ~/Downloads/$KEYNAME.pem ~/.ssh/ && chmod 600 ~/.ssh/$KEYNAME.pem
and add to ~/.ssh/config:   Host $IP
                              IdentityFile ~/.ssh/$KEYNAME.pem" )

To delete everything later: disable termination protection, terminate $ID, release Elastic IP $ALLOC,
delete alarm $NAME-auto-recover, security group $SG and key pair $KEYNAME.
DONE
