#!/usr/bin/env bash
# Run ONLY in the offline ARM64 image builder, never by user-data. Dependencies
# must already be installed/pinned. No package repositories or executable fetch.
set -euo pipefail
[ "$(id -u)" = 0 ]
[ "$(uname -m)" = aarch64 ]
for tool in podman nft mkfs.ext4 mount systemctl unshare lsblk swapoff shutdown; do command -v "$tool" >/dev/null; done
[ -x /sbin/ebsnvme-id ]
[ -x /opt/polis-probe/venv/bin/python ]
/opt/polis-probe/venv/bin/python -c 'import sys, boto3, psycopg2; assert sys.version_info[:2] == (3, 12)'
: "${PROBE_RDS_CA:?path to the reviewed RDS CA bundle required}"
# Validate the reviewed CA before writing any boot configuration.
/opt/polis-probe/venv/bin/python - "$(dirname "$0")/layer/lock.json" <<'PYCA'
import hashlib, json, os
from pathlib import Path
import sys
ca = json.loads(Path(sys.argv[1]).read_bytes())['ca']
raw = Path(os.environ['PROBE_RDS_CA']).read_bytes()
if len(raw) != ca['bytes'] or hashlib.sha256(raw).hexdigest() != ca['sha256']:
    raise SystemExit('RDS_CA_PIN_MISMATCH')
PYCA
install -d -m 0755 /opt/polis-probe
install -m 0444 "$PROBE_RDS_CA" /opt/polis-probe/rds-ca.pem
for file in worker.py contracts.py receipt.py replica.py dns.py; do install -m 0444 "$(dirname "$0")/$file" "/opt/polis-probe/$file"; done
# No remote commands, cloud-init, SSM, SSH or serial interactive console.
for unit in cloud-init-local cloud-init cloud-config cloud-final sshd amazon-ssm-agent serial-getty@ttyS0; do systemctl mask "$unit.service"; done
systemctl mask swap.target
printf '* hard core 0\n* soft core 0\n' > /etc/security/limits.d/90-probe-box.conf
printf 'kernel.core_pattern=|/bin/false\nvm.swappiness=0\n' > /etc/sysctl.d/90-probe-box.conf
id private-dns >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin private-dns
private_dns_uid="$(id -u private-dns)"
cat > /opt/polis-probe/firewall.nft <<NFT
table inet probe_box {
 chain output {
  type filter hook output priority -10; policy accept;
  ip daddr 127.0.0.1 accept
  udp dport 53 meta skuid $private_dns_uid accept
  udp dport 53 reject
  tcp dport 53 reject
  ip daddr 169.254.169.254 meta skuid != 0 reject
  ip6 daddr fd00:ec2::254 reject
 }
}
NFT
cat > /etc/systemd/system/polis-probe-dns.service <<'UNIT'
[Unit]
Before=polis-probe-worker.service
[Service]
Type=simple
User=private-dns
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ExecStart=/opt/polis-probe/venv/bin/python /opt/polis-probe/dns.py
Restart=on-failure
StandardOutput=null
StandardError=null
[Install]
WantedBy=multi-user.target
UNIT
cat > /opt/polis-probe/start.sh <<'START'
#!/usr/bin/env bash
set -euo pipefail
# Arm termination before any mount, DNS or supervisor work can fail. EC2's
# independent sweeper enforces absolute admission expiry and missing heartbeat.
shutdown -h +300
trap 'systemctl poweroff' EXIT
swapoff -a
ulimit -c 0
# User-data is JSON only; cloud-init execution is disabled. This step runs
# before any probe or private database access and reads no credential.
/opt/polis-probe/venv/bin/python - <<'BOOT'
import json,sys
from pathlib import Path
sys.path.insert(0,'/opt/polis-probe')
from worker import metadata
b=json.loads(metadata('user-data'))
if set(b)!={'account','region','controlBucket','dnsNames','resolver'}: raise ValueError('BOOT_CONFIG')
Path('/opt/polis-probe/bootstrap.json').write_text(json.dumps(b))
Path('/opt/polis-probe/bootstrap.json').chmod(0o444)
BOOT
nft -f /opt/polis-probe/firewall.nft
printf 'nameserver 127.0.0.1\noptions timeout:2 attempts:2\n' > /etc/resolv.conf
systemctl start polis-probe-dns.service
# Match the EBS launch-template device name, never guess an NVMe disk number.
private_disk=''
for dev in /dev/nvme*n1; do
  if /sbin/ebsnvme-id "$dev" 2>/dev/null | /usr/bin/grep -Eq '^(/dev/)?sdf$'; then private_disk="$dev"; fi
done
[ -n "$private_disk" ]
[ -z "$(lsblk -n -o MOUNTPOINT "$private_disk" | tr -d '[:space:]')" ]
mkfs.ext4 -F "$private_disk" >/dev/null
mkdir -p /probe-work
mount -o nodev,nosuid,noexec "$private_disk" /probe-work
chmod 0700 /probe-work
/opt/polis-probe/venv/bin/python /opt/polis-probe/worker.py
START
chmod 0500 /opt/polis-probe/start.sh
cat > /etc/systemd/system/polis-probe-worker.service <<'UNIT'
[Unit]
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/opt/polis-probe/start.sh
ExecStopPost=/usr/bin/systemctl poweroff
TimeoutStartSec=18000
LimitCORE=0
UMask=0077
StandardOutput=null
StandardError=null
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/polis-probe-{dns,worker}.service
# Do not start either service on the builder.
systemctl enable polis-probe-worker.service
# Only digest-pinned OCI archives are loaded at runtime from the private assets
# bucket. The AMI supervisor and CA bundle are reviewed in the image build.

