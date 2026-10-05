#!/usr/bin/env bash
# Test TLS certificates for the OIDC simulator and the services that trust it.
#
#   ci/local/certs.sh            writes .simulacrum/certs/{localhost.pem,localhost-key.pem,rootCA.pem}
#
# The CA lives inside the checkout (.simulacrum/ca, CAROOT) and is never installed
# into a system trust store or keychain: Node reads it from NODE_EXTRA_CA_CERTS
# and the containers mount .simulacrum/certs. mkcert comes from PATH, else a
# pinned, checksum-verified v1.4.4 release for this host's OS and architecture
# is downloaded into .check/bin once.
. "$(dirname "$0")/lib.sh"
CHECK_SUITE="${CHECK_SUITE:-certs}"

MKCERT_VERSION=v1.4.4
mkcert_sha256() {
  case "$1" in
    linux-amd64) echo 6d31c65b03972c6dc4a14ab429f2928300518b26503f58723e532d1b0a3bbb52 ;;
    linux-arm64) echo b98f2cc69fd9147fe4d405d859c57504571adec0d3611c3eefd04107c7ac00d0 ;;
    darwin-amd64) echo a32dfab51f1845d51e810db8e47dcf0e6b51ae3422426514bf5a2b8302e97d4e ;;
    darwin-arm64) echo c8af0df44bce04359794dad8ea28d750437411d632748049d08644ffb66a60c6 ;;
    *) return 1 ;;
  esac
}

ensure_mkcert() {
  if command -v mkcert >/dev/null 2>&1; then MKCERT="$(command -v mkcert)"; return; fi
  local os arch platform want bin
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) check_die "no pinned mkcert for $(uname -m); put mkcert on PATH" ;;
  esac
  platform="$os-$arch"
  want="$(mkcert_sha256 "$platform")" || check_die "no pinned mkcert for $platform; put mkcert on PATH"
  bin="$CHECK_ROOT/.check/bin/mkcert"
  if [ ! -x "$bin" ] || [ "$(check_sha256 "$bin")" != "$want" ]; then
    mkdir -p "$CHECK_ROOT/.check/bin"
    check_log "downloading mkcert $MKCERT_VERSION for $platform"
    curl -fsSL -o "$bin.part" \
      "https://github.com/FiloSottile/mkcert/releases/download/$MKCERT_VERSION/mkcert-$MKCERT_VERSION-$platform"
    [ "$(check_sha256 "$bin.part")" = "$want" ] || { rm -f "$bin.part"; check_die "mkcert checksum mismatch"; }
    chmod +x "$bin.part"; mv "$bin.part" "$bin"
  fi
  MKCERT="$bin"
}

ensure_mkcert
export CAROOT="${CAROOT:-$CHECK_ROOT/.simulacrum/ca}"
CERTS="$CHECK_ROOT/.simulacrum/certs"
mkdir -p "$CAROOT" "$CERTS"
# mkcert creates the CA in CAROOT on first use; nothing is installed anywhere.
if [ ! -f "$CERTS/localhost.pem" ] || [ ! -f "$CERTS/rootCA.pem" ] || [ ! -f "$CAROOT/rootCA.pem" ] \
   || ! cmp -s "$CAROOT/rootCA.pem" "$CERTS/rootCA.pem"; then
  (cd "$CERTS" && "$MKCERT" -cert-file localhost.pem -key-file localhost-key.pem \
    localhost 127.0.0.1 ::1 oidc-simulator host.docker.internal)
  cp "$CAROOT/rootCA.pem" "$CERTS/rootCA.pem"
fi
check_log "certificates in $CERTS (CA: $CAROOT; not installed in any trust store)"
