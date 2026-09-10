#!/usr/bin/env bash
# Run ONLY in the offline ARM64 image builder, never by user-data. Dependencies
# must already be installed/pinned. No package repositories or executable fetch.
set -euo pipefail
[ "$(id -u)" = 0 ]
[ "$(uname -m)" = aarch64 ]
: "${PRIVATE_CERT_BOOTSTRAP:?path to public bootstrap JSON required}"
for tool in podman nft python3 mkfs.ext4 mount systemctl; do command -v "$tool" >/dev/null; done
python3 -c 'import boto3, cryptography'
install -d -m 0755 /opt/polis-private
install -m 0444 "$PRIVATE_CERT_BOOTSTRAP" /opt/polis-private/bootstrap.json
for file in worker.py control.py dns.py; do install -m 0444 "$(dirname "$0")/$file" "/opt/polis-private/$file"; done
# No remote commands, cloud-init, SSM, SSH or serial interactive console.
for unit in cloud-init-local cloud-init cloud-config cloud-final sshd amazon-ssm-agent serial-getty@ttyS0; do systemctl mask "$unit.service"; done
systemctl mask swap.target
printf '* hard core 0\n* soft core 0\n' > /etc/security/limits.d/90-private-cert.conf
printf 'kernel.core_pattern=|/bin/false\nvm.swappiness=0\n' > /etc/sysctl.d/90-private-cert.conf
id private-dns >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin private-dns
private_dns_uid="$(id -u private-dns)"
cat > /opt/polis-private/firewall.nft <<NFT
table inet private_cert {
 chain output {
  type filter hook output priority -10; policy accept;
  ip daddr 127.0.0.1 accept
  udp dport 53 meta skuid $private_dns_uid ip daddr 10.253.0.2 accept
  udp dport 53 reject
  tcp dport 53 reject
  ip daddr 169.254.169.254 meta skuid != 0 reject
  ip6 daddr fd00:ec2::254 reject
 }
}
NFT
cat > /etc/systemd/system/polis-private-dns.service <<'UNIT'
[Unit]
Before=polis-private-worker.service
[Service]
Type=simple
User=private-dns
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ExecStart=/usr/bin/python3 /opt/polis-private/dns.py
Restart=on-failure
StandardOutput=null
StandardError=null
[Install]
WantedBy=multi-user.target
UNIT
cat > /opt/polis-private/start.sh <<'START'
#!/usr/bin/env bash
set -euo pipefail
# Arm termination before any mount, DNS or supervisor work can fail. EC2's
# independent sweeper enforces absolute admission expiry and missing heartbeat.
shutdown -h +720
trap 'systemctl poweroff' EXIT
swapoff -a
ulimit -c 0
nft -f /opt/polis-private/firewall.nft
printf 'nameserver 127.0.0.1\noptions timeout:2 attempts:2\n' > /etc/resolv.conf
systemctl start polis-private-dns.service
# Match the EBS launch-template device name, never guess an NVMe disk number.
private_disk=''
for dev in /dev/nvme*n1; do
  if /sbin/ebsnvme-id "$dev" 2>/dev/null | /usr/bin/grep -Eq '^(/dev/)?sdf$'; then private_disk="$dev"; fi
done
[ -n "$private_disk" ]
[ -z "$(lsblk -n -o MOUNTPOINT "$private_disk" | tr -d '[:space:]')" ]
mkfs.ext4 -F "$private_disk" >/dev/null
mkdir -p /private-cert
mount -o nodev,nosuid,noexec "$private_disk" /private-cert
chmod 0700 /private-cert
python3 /opt/polis-private/worker.py
START
chmod 0500 /opt/polis-private/start.sh
cat > /etc/systemd/system/polis-private-worker.service <<'UNIT'
[Unit]
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/opt/polis-private/start.sh
ExecStopPost=/usr/bin/systemctl poweroff
TimeoutStartSec=43200
LimitCORE=0
UMask=0077
StandardOutput=null
StandardError=null
[Install]
WantedBy=multi-user.target
UNIT
systemctl enable polis-private-worker.service
# Images must have been podman-loaded in the builder from verified OCI archives.
# AMI snapshots and package/image attestation are produced by the existing
# private image-builder operator, not by this script or the runtime role.

# Hash the actual installed bytes, after all generated files. The later signed
# admission binds this lock. Never bake a not-yet-assigned AMI ID.
python3 - <<'PYLOCK'
import hashlib, json
from pathlib import Path
root = Path('/opt/polis-private')
names = ['bootstrap.json', 'control.py', 'dns.py', 'start.sh', 'firewall.nft']
lock = {n: hashlib.sha256((root/n).read_bytes()).hexdigest() for n in names}
raw = json.dumps(lock, sort_keys=True, separators=(',', ':')).encode()
(root/'runtime-lock.json').write_bytes(raw)
(root/'runtime-lock.json').chmod(0o444)
print(json.dumps({'runtimeSha256': hashlib.sha256(raw).hexdigest(),
                  'supervisorSha256': hashlib.sha256((root/'worker.py').read_bytes()).hexdigest()}))
PYLOCK
