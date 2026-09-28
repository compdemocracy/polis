#!/usr/bin/env python3
"""Return credential-filtered bootstrap diagnostics without a repository checkout.

The runner sends this stdlib-only helper over SSM. Raw logs stay on the worker;
bootstrap.log contains the complete filtered log, while stdout carries only a
bounded tail or a digest-bound transport chunk. No environment or shell command
is dumped. Missing/oversized logs are explicit and never silently truncated.
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import math
import os
from pathlib import Path
import re
import sys

LOG = Path("/var/log/polis-ci-userdata.log")
ARTIFACT = Path("/var/log/polis-ci/artifacts/bootstrap.log")
TRANSPORT = Path("/var/log/polis-ci/bootstrap-log.b64")
CHUNK_CHARS = 18000
MAX_CHUNKS = 128
MAX_LOG_BYTES = 64 * 1024 * 1024
TAIL_BYTES = 8000
TAIL_LINES = 80
PREFIX = "p022 bootstrap-log "
STATUS = re.compile(r"^p022 bootstrap result=(ready|failed|timeout)$")
SENSITIVE = re.compile(
    r"(?:authorization|password|passwd|secret|token|api[-_ ]?key|credential)"
    r"[\w -]*\s*[:=]|(?:Bearer|Basic)\s+\S+|"
    r"https?://[^/\s]*@|[?&](?:signature|sig|key|token|x-amz-\w+)=|"
    r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", re.I)
OPAQUE = re.compile(r"[A-Za-z0-9+/=_-]{32,}")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def clean(text: str) -> str:
    # Defense in depth for provider/installer diagnostics. Do not emit even a
    # partial credential-bearing line; also remove multi-line private keys.
    env_values = [v for k, v in os.environ.items()
                  if re.search(r"secret|token|password|credential|api.?key", k, re.I)
                  and len(v) >= 4]
    out = []
    private = False
    for line in text.splitlines():
        line = ANSI.sub("", line)
        line = "".join(c for c in line if c == "\t" or 32 <= ord(c) < 127)
        if "-----BEGIN " in line and "PRIVATE KEY-----" in line:
            private = True
            out.append("[redacted private key]")
        if private:
            if "-----END " in line and "PRIVATE KEY-----" in line:
                private = False
            continue
        if SENSITIVE.search(line) or any(v in line for v in env_values):
            out.append("[redacted credential-bearing line]")
        else:
            out.append(OPAQUE.sub("[redacted opaque value]", line))
    return "\n".join(out) + ("\n" if out else "")


def capture(log=LOG, artifact=ARTIFACT) -> bytes:
    if not log.exists():
        data = b"[bootstrap log unavailable]\n"
    else:
        with log.open("rb") as stream:
            raw = stream.read(MAX_LOG_BYTES + 1)
        if len(raw) > MAX_LOG_BYTES:
            raise ValueError("bootstrap log exceeds transfer input limit; no partial log returned")
        data = clean(raw.decode("utf-8", errors="replace")).encode()
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_bytes(data)
    return data


def tail(data: bytes) -> str:
    # Prefix every line, including empty ones: installer output cannot inject
    # Actions workflow commands. Filtering happens before applying the bound.
    lines = data.decode().splitlines()[-TAIL_LINES:]
    bounded = "\n".join(lines).encode()[-TAIL_BYTES:].decode("utf-8", errors="replace")
    return "\n".join(PREFIX + line for line in bounded.splitlines()) + "\n"


def prepare(log=LOG, artifact=ARTIFACT, transport=TRANSPORT):
    data = gzip.compress(capture(log, artifact), mtime=0)
    encoded = base64.b64encode(data)
    chunks = math.ceil(len(encoded) / CHUNK_CHARS)
    if chunks > MAX_CHUNKS:
        raise ValueError("bootstrap log exceeds transfer budget; no partial log returned")
    transport.parent.mkdir(parents=True, exist_ok=True)
    transport.write_bytes(encoded)
    return {"chunks": chunks, "chars": len(encoded),
            "sha256": hashlib.sha256(data).hexdigest()}


def chunk(index: int, transport=TRANSPORT) -> bytes:
    encoded = transport.read_bytes()
    count = math.ceil(len(encoded) / CHUNK_CHARS)
    if not 1 <= index <= count <= MAX_CHUNKS:
        raise ValueError("invalid bootstrap chunk index")
    return encoded[(index - 1) * CHUNK_CHARS:index * CHUNK_CHARS]


def filter_ssm(text: str) -> str:
    # This dedicated mode does not relax ordinary status/base64 admission.
    output = []
    for line in clean(text).splitlines():
        if STATUS.fullmatch(line):
            output.append(line)
        elif line.startswith(PREFIX):
            output.append("bootstrap | " + line[len(PREFIX):])
    return "\n".join(output) + "\n"


def main():
    ap = argparse.ArgumentParser()
    modes = ap.add_mutually_exclusive_group(required=True)
    modes.add_argument("--tail", action="store_true")
    modes.add_argument("--prepare", action="store_true")
    modes.add_argument("--chunk", type=int)
    modes.add_argument("--filter-ssm", action="store_true")
    args = ap.parse_args()
    if args.filter_ssm:
        # SSM caps stdout at 24,000 characters; reject an unexpected source.
        text = sys.stdin.read(24001)
        if len(text) > 24000:
            raise ValueError("bootstrap SSM output exceeds bound")
        print(filter_ssm(text), end="")
    elif args.tail:
        print(tail(capture()), end="")
    elif args.prepare:
        for k, v in prepare().items():
            print(PREFIX + f"{k}={v}")
    else:
        sys.stdout.buffer.write(chunk(args.chunk))


if __name__ == "__main__":
    main()
