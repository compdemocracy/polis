#!/usr/bin/env bash
# Run ONLY in the offline ARM64 image builder, never by user-data. Dependencies
# must already be installed/pinned. No package repositories or executable fetch.
set -euo pipefail
[ "$(id -u)" = 0 ]
[ "$(uname -m)" = aarch64 ]
for tool in docker dockerd containerd runc skopeo mountpoint nft mkfs.ext4 mount systemctl unshare lsblk swapoff shutdown timeout; do command -v "$tool" >/dev/null; done
[ -x /sbin/ebsnvme-id ]
[ -x /opt/polis-probe/venv/bin/python ]
/opt/polis-probe/venv/bin/python -c 'import sys, boto3, psycopg2; assert sys.version_info[:2] == (3, 12)'
: "${PROBE_RDS_CA:?path to the reviewed RDS CA bundle required}"
# Validate the reviewed CA before writing any boot configuration.
/opt/polis-probe/venv/bin/python - "$(dirname "$0")/ami/rds-ca.json" <<'PYCA'
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
for file in boot_report.py worker.py contracts.py receipt.py roles_census.py roles_queries.py replica.py dns.py provision.py provision_login.py; do install -m 0444 "$(dirname "$0")/$file" "/opt/polis-probe/$file"; done
# Resolver ownership (offline bake).
# AL2023 links resolv.conf to resolved's DHCP-managed uplink file. Writing
# through that link lasts only until renewal. Stop its writer before unlinking;
# networkd still owns addresses/routes, with no per-interface reconfiguration.
systemctl disable --now systemd-resolved
systemctl mask systemd-resolved.service
resolved_enabled="$(systemctl is-enabled systemd-resolved || true)"
resolved_active="$(systemctl is-active systemd-resolved || true)"
[ "$resolved_enabled" = masked ]
[ "$resolved_active" = inactive ]
/opt/polis-probe/venv/bin/python - "$resolved_enabled" "$resolved_active" <<'RESOLVER'
import json, os, re, stat, sys
from pathlib import Path

evidence = os.environ.get('PROBE_BUILD_DIR')
if evidence and (not Path(evidence).is_absolute() or not Path(evidence).is_dir()):
    raise SystemExit('RESOLVER_EVIDENCE_DIR')
resolv = Path('/etc/resolv.conf')
nss = Path('/etc/nsswitch.conf')

def file_state():
    try:
        mode = resolv.lstat().st_mode
    except FileNotFoundError:
        return {'symlink': False, 'regular': False, 'mode': None}
    return {'symlink': stat.S_ISLNK(mode), 'regular': stat.S_ISREG(mode),
            'mode': f'{stat.S_IMODE(mode):04o}'}

before = file_state()
lines = nss.read_text().splitlines(keepends=True)
hosts = [i for i, line in enumerate(lines) if re.match(r'^\s*hosts\s*:', line)]
if len(hosts) != 1:
    raise SystemExit('RESOLVER_NSS_HOSTS')
index = hosts[0]
hosts_before = lines[index].split(':', 1)[1].split('#', 1)[0].split()
if hosts_before != ['files', 'dns']:
    lines[index] = 'hosts: files dns\n'
    nss.write_text(''.join(lines))
# Unlink both live and dangling links; never modify resolved's former target.
resolv.unlink(missing_ok=True)
resolv.write_text('nameserver 127.0.0.1\noptions timeout:2 attempts:2\n')
resolv.chmod(0o644)
if evidence:
    (Path(evidence)/'resolver.json').write_text(json.dumps({
        'before': before, 'after': file_state(),
        'resolved': {'enabled': sys.argv[1], 'active': sys.argv[2]},
        'hosts_before': hosts_before, 'hosts_after': ['files', 'dns'],
    }, sort_keys=True, indent=2)+'\n')
RESOLVER
# End resolver ownership.
# No remote commands, cloud-init, SSM, SSH or serial interactive console.
for unit in cloud-init-local cloud-init cloud-config cloud-final sshd amazon-ssm-agent serial-getty@ttyS0; do systemctl mask "$unit.service"; done
systemctl mask swap.target docker.service docker.socket containerd.service
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
# Skopeo may read only a local OCI archive; identity is checked independently by
# worker.py. Every other transport is refused by this baked policy.
cat > /opt/polis-probe/image-policy.json <<'POLICY'
{"default":[{"type":"reject"}],"transports":{"oci-archive":{"":[{"type":"insecureAcceptAnything"}]}}}
POLICY
# Docker 25 uses overlay2 and its own managed containerd. Do not connect to the
# distro containerd socket (which would put image/state data on the root disk).
cat > /opt/polis-probe/docker.json <<'DOCKER'
{"data-root":"/probe-work/container-store","exec-root":"/probe-work/container-run","pidfile":"/probe-work/docker.pid","hosts":["unix:///probe-work/docker.sock"],"group":"root","storage-driver":"overlay2","bridge":"none","iptables":false,"ip6tables":false,"ip-forward":false,"ip-masq":false,"userland-proxy":false,"log-driver":"none"}
DOCKER
dockerd --validate --config-file=/opt/polis-probe/docker.json
cat > /etc/systemd/system/polis-probe-container.service <<'UNIT'
[Unit]
Description=Probe-only Docker on disposable storage
ConditionPathIsMountPoint=/probe-work
PartOf=polis-probe-worker.service
[Service]
Type=notify
ExecStartPre=/usr/bin/mountpoint -q /probe-work
ExecStart=/usr/bin/dockerd --config-file=/opt/polis-probe/docker.json
Environment=DOCKER_TMPDIR=/probe-work/tmp TMPDIR=/probe-work/tmp
Delegate=yes
KillMode=process
TimeoutStartSec=120
LimitCORE=0
UMask=0077
StandardOutput=null
StandardError=null
UNIT
cat > /opt/polis-probe/start.sh <<'START'
#!/usr/bin/env bash
set -euo pipefail
# Install the closed console/remote failure path before arming shutdown.
BOOT_PHASE=start
boot_console() {
  case "$BOOT_PHASE:$1" in
    start:entry|boot-config:entry|firewall:entry|dns:entry|private-disk:entry|container-daemon:entry|worker:entry|start:nonzero|boot-config:nonzero|firewall:nonzero|dns:nonzero|private-disk:nonzero|container-daemon:nonzero|worker:nonzero)
      { printf 'POLIS_PROBE_BOOT/1 %s %s\n' "$BOOT_PHASE" "$1" > /dev/console; } 2>/dev/null || true ;;
  esac
}
boot_failure() {
  boot_console nonzero
  timeout 30 /opt/polis-probe/venv/bin/python /opt/polis-probe/boot_report.py "$BOOT_PHASE" nonzero || true
}
trap 'rc=$?; if [ "$rc" -ne 0 ]; then boot_failure; fi; systemctl poweroff' EXIT
boot_console entry
shutdown -h +720
swapoff -a
ulimit -c 0
# User-data is JSON only; cloud-init execution is disabled. This step runs
# before any probe or private database access and reads no credential.
BOOT_PHASE=boot-config
boot_console entry
/opt/polis-probe/venv/bin/python - <<'BOOT'
import json,sys
from pathlib import Path
sys.path.insert(0,'/opt/polis-probe')
from boot_report import metadata, validate_bootstrap
b=validate_bootstrap(json.loads(metadata('user-data')))
Path('/opt/polis-probe/bootstrap.json').write_text(json.dumps(b))
Path('/opt/polis-probe/bootstrap.json').chmod(0o444)
BOOT
BOOT_PHASE=firewall
boot_console entry
nft -f /opt/polis-probe/firewall.nft
BOOT_PHASE=dns
boot_console entry
# Refuse an image whose resolver ownership has drifted. A masked unit returns
# nonzero from is-enabled; compare its output rather than its exit status.
[ ! -L /etc/resolv.conf ]
[ -f /etc/resolv.conf ]
[ "$(systemctl is-enabled systemd-resolved || true)" = masked ]
[ "$(systemctl is-active systemd-resolved || true)" = inactive ]
printf 'nameserver 127.0.0.1\noptions timeout:2 attempts:2\n' > /etc/resolv.conf
systemctl start polis-probe-dns.service
mode="$(/opt/polis-probe/venv/bin/python -c 'import json; print(json.load(open("/opt/polis-probe/bootstrap.json"))["mode"])')"
if [ "$mode" = provision ]; then
  shutdown -h +15
  /opt/polis-probe/venv/bin/python /opt/polis-probe/provision.py
  exit 0
fi
# Match the EBS launch-template device name, never guess an NVMe disk number.
# The volume is attached at launch but can enumerate after this script starts;
# wait for it rather than fail the boot on a race.
BOOT_PHASE=private-disk
boot_console entry
private_disk=''
for attempt in $(seq 1 60); do
  for dev in /dev/nvme*n1; do
    if /sbin/ebsnvme-id "$dev" 2>/dev/null | /usr/bin/grep -Eq '^(/dev/)?sdf$'; then private_disk="$dev"; fi
  done
  [ -n "$private_disk" ] && break
  sleep 2
done
[ -n "$private_disk" ]
[ -z "$(lsblk -n -o MOUNTPOINT "$private_disk" | tr -d '[:space:]')" ]
mkfs.ext4 -F "$private_disk" >/dev/null
mkdir -p /probe-work
mount -o nodev,nosuid,noexec "$private_disk" /probe-work
chmod 0700 /probe-work
mkdir -m 0700 /probe-work/tmp /probe-work/docker-client
export TMPDIR=/probe-work/tmp DOCKER_CONFIG=/probe-work/docker-client
BOOT_PHASE=container-daemon
boot_console entry
systemctl start polis-probe-container.service
for attempt in $(seq 1 30); do
  docker --host unix:///probe-work/docker.sock info >/dev/null 2>&1 && break
  sleep 2
done
docker --host unix:///probe-work/docker.sock info >/dev/null 2>&1
BOOT_PHASE=worker
boot_console entry
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
TimeoutStartSec=43200
LimitCORE=0
UMask=0077
StandardOutput=null
StandardError=null
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/polis-probe-{dns,container,worker}.service
# Do not start any of these services on the builder.
systemctl enable polis-probe-worker.service
# Only digest-pinned OCI archives are loaded at runtime from the private assets
# bucket. The AMI supervisor and CA bundle are reviewed in the image build.
