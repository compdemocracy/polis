#!/usr/bin/env bash
# Operator-only AL2023 ARM64 builder preparation. No database or account APIs.
set -euo pipefail
[ "$(id -u)" = 0 ]
[ "$(uname -m)" = aarch64 ]
: "${PROBE_RELEASE:?exact AL2023 repository release required}"
[[ "$PROBE_RELEASE" =~ ^2023\.[0-9]+\.[0-9]{8}$ ]]
[ "$(rpm -q --qf '%{VERSION}' system-release)" = "$PROBE_RELEASE" ]
recipe="$(cd -- "$(dirname -- "$0")" && pwd)"
: "${PROBE_BUILD_DIR:?absolute build evidence directory required}"
[[ "$PROBE_BUILD_DIR" = /* ]]
[ ! -e "$PROBE_BUILD_DIR" ]
mkdir -m 0700 "$PROBE_BUILD_DIR"
# This immutable AL2023 release pins the complete RPM dependency resolution.
# Retain exact NEVRAs and checksums as well, before the offline install.
printf '%s\n' "$PROBE_RELEASE" > "$PROBE_BUILD_DIR/release.txt"
rpm -qa --qf '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}\n' | sort > "$PROBE_BUILD_DIR/base-rpms.txt"
# These four NEVRAs were observed in the pinned Amazon repository (BOARD [867]).
# No third-party runtime repository or unversioned runtime fallback.
packages=(docker-25.0.16-1.amzn2023.0.4.aarch64
          containerd-2.2.5-1.amzn2023.0.2.aarch64
          runc-1.3.5-1.amzn2023.0.2.aarch64
          skopeo-2:1.22.2-1.amzn2023.0.1.aarch64 nftables python3.12 python3.12-pip e2fsprogs ec2-utils util-linux shadow-utils)
mkdir "$PROBE_BUILD_DIR/rpms"
dnf -y --releasever="$PROBE_RELEASE" --disablerepo='*' --enablerepo=amazonlinux \
  install --downloadonly --downloaddir="$PROBE_BUILD_DIR/rpms" "${packages[@]}"
shopt -s nullglob
rpms=("$PROBE_BUILD_DIR"/rpms/*.rpm)
[ "${#rpms[@]}" -gt 0 ]
rpmkeys --checksig "${rpms[@]}" > "$PROBE_BUILD_DIR/rpm-signatures.txt"
(cd "$PROBE_BUILD_DIR/rpms" && sha256sum ./*.rpm) > "$PROBE_BUILD_DIR/rpm-sha256.txt"
rpm -qp --qf '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}\n' "${rpms[@]}" | sort > "$PROBE_BUILD_DIR/downloaded-rpms.txt"
# Network repositories disabled; install only the frozen local closure.
# Prevent package scripts or a later boot from starting the default daemons.
systemctl mask docker.service docker.socket containerd.service
dnf -y --disablerepo='*' --setopt=localpkg_gpgcheck=1 install "${rpms[@]}"
rpm -qa --qf '%{NAME}-%{EPOCHNUM}:%{VERSION}-%{RELEASE}.%{ARCH}\n' | sort > "$PROBE_BUILD_DIR/installed-rpms.txt"
python3.12 -m venv /opt/polis-probe/venv
py=/opt/polis-probe/venv/bin/python
"$py" -m pip download --only-binary=:all: --require-hashes \
  --dest "$PROBE_BUILD_DIR/wheels" -r "$recipe/requirements.lock"
"$py" -m pip install --no-index --find-links "$PROBE_BUILD_DIR/wheels" \
  --only-binary=:all: --require-hashes -r "$recipe/requirements.lock"
"$py" -m pip check
"$py" -m pip freeze --all > "$PROBE_BUILD_DIR/python-packages.txt"
"$py" - "$recipe/rds-ca.json" "$PROBE_BUILD_DIR/rds-ca.pem" <<'PY'
import hashlib, json, pathlib, ssl, sys, urllib.request
ca = json.loads(pathlib.Path(sys.argv[1]).read_bytes())['ca']
with urllib.request.urlopen(ca['url'], timeout=60) as response:
    data = response.read(ca['bytes'] + 1)
if len(data) != ca['bytes'] or hashlib.sha256(data).hexdigest() != ca['sha256']:
    raise SystemExit('RDS_CA_PIN_MISMATCH: review new bytes; never update the pin in the builder')
path = pathlib.Path(sys.argv[2]); path.write_bytes(data)
context = ssl.create_default_context(cafile=str(path))
if len(context.get_ca_certs()) != ca['certificates']:
    raise SystemExit('RDS_CA_CERTIFICATE_COUNT')
PY
"$py" - <<'PY' > "$PROBE_BUILD_DIR/native-imports.txt"
import platform, sys, boto3, psycopg2
assert sys.version_info[:2] == (3, 12)
assert platform.machine() == 'aarch64'
print(sys.version)
print('boto3', boto3.__version__)
print('psycopg2', psycopg2.__version__, 'libpq', psycopg2.__libpq_version__)
PY
for tool in docker dockerd containerd runc skopeo mountpoint nft mkfs.ext4 mount systemctl unshare lsblk swapoff shutdown; do command -v "$tool"; done > "$PROBE_BUILD_DIR/tools.txt"
[ -x /sbin/ebsnvme-id ]
# Version queries only: no daemon/image/network execution on the builder.
{
  docker --version
  dockerd --version
  containerd --version
  runc --version
  skopeo --version
} > "$PROBE_BUILD_DIR/runtime-versions.txt"
for unit in docker.service docker.socket containerd.service; do
  [ "$(systemctl is-enabled "$unit" || true)" = masked ]
  [ "$(systemctl is-active "$unit" || true)" = inactive ]
done
# No image pulls, probe start, credentials, or database connection in this phase.
