#!/bin/bash
# EC2 user-data (cloud-init): installs Liquid Trader on a fresh Ubuntu 24.04 instance at first boot
# and starts it as a systemd service. Used by aws_launch.sh; you can also paste it into
# "Advanced details → User data" in the EC2 console's Launch Instance wizard.
# Progress: /var/log/liquid-trader-install.log (also shown in EC2 → Get system log).
set -euo pipefail
exec > >(tee -a /var/log/liquid-trader-install.log | logger -t liquid-trader -s 2>/dev/console) 2>&1

REPO="${LT_REPO:-https://github.com/swharesh-cloud/REA.git}"
BRANCH="${LT_BRANCH:-claude/liquid-trader-mac}"

echo "== Liquid Trader install starting =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git python3 >/dev/null

SRC="$(mktemp -d)"
git clone --quiet --depth 1 --filter=blob:none --sparse -b "$BRANCH" "$REPO" "$SRC"
git -C "$SRC" sparse-checkout set liquid-trader
mkdir -p /opt/liquid-trader/app
rm -rf /opt/liquid-trader/app/liquid_trader /opt/liquid-trader/app/deploy
cp -r "$SRC/liquid-trader/liquid_trader" "$SRC/liquid-trader/deploy" /opt/liquid-trader/app/
rm -rf "$SRC"

bash /opt/liquid-trader/app/deploy/server_setup.sh
echo "== LIQUID-TRADER-READY =="
