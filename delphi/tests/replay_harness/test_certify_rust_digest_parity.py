"""P-045 round 6: the bridge's canonical payload digest is a byte-for-byte port
of the ACTUAL Rust ``storage_digest`` (coordinator-rs/src/store.rs).

This builds a tiny STANDALONE Rust probe from the UNCHANGED digest source
extracted from store.rs at test time (so it can never drift from the production
function, and does not require building the whole coordinator crate), then
compares the Rust output to :func:`coordinator_driver._canonical_payload_digest`
on Astra's probe inputs and on the real retained ``vw/single-cut`` blobs. It
skips (naming the reason) only when cargo/the toolchain or store.rs is absent —
the same discipline as the JVM-gated tests.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from polismath.replay import certify as cert
from polismath.replay import coordinator_driver as cd

_MAIN_RS = """\
mod digest;
use anyhow::Result;
use serde_json::Value;
use std::io::{self, BufRead, Write};
fn main() -> Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() { continue; }
        let value: Value = serde_json::from_str(&line)?;
        writeln!(out, "{}", digest::storage_digest(&value)?)?;
    }
    Ok(())
}
"""

_CARGO_TOML = """\
[package]
name = "p045-digest-probe"
version = "0.0.0"
edition = "2024"
[dependencies]
anyhow = "1"
sha2 = "0.10"
serde_json = { version = "1", features = ["float_roundtrip"] }
"""

_DIGEST_HEADER = "use anyhow::Result;\nuse serde_json::Value;\nuse sha2::{Digest, Sha256};\n\n"


def _find_cargo():
    for cand in (os.environ.get("P045_CARGO"),
                 "/private/tmp/p026-toolchain/cargo/bin/cargo",
                 shutil.which("cargo")):
        if cand and Path(cand).exists():
            return cand
    return None


def _find_store_rs():
    for parent in Path(cd.__file__).resolve().parents:
        s = parent / "coordinator-rs" / "src" / "store.rs"
        if s.exists():
            return s
    return None


def _cargo_env():
    env = dict(os.environ)
    home = Path("/private/tmp/p026-toolchain/cargo")
    rustup = Path("/private/tmp/p026-toolchain/rustup")
    if "CARGO_HOME" not in env and home.exists():
        env["CARGO_HOME"] = str(home)
    if "RUSTUP_HOME" not in env and rustup.exists():
        env["RUSTUP_HOME"] = str(rustup)
    return env


@pytest.fixture(scope="module")
def rust_probe(tmp_path_factory):
    cargo = _find_cargo()
    store = _find_store_rs()
    if cargo is None:
        pytest.skip("cargo not found (set P045_CARGO or install the toolchain)")
    if store is None:
        pytest.skip("coordinator-rs/src/store.rs not found")
    src = store.read_text()
    try:
        extract = src[src.index("pub fn digest("):src.index("/// Exact worker output")]
    except ValueError:
        pytest.skip("store.rs digest markers not found")
    d = tmp_path_factory.mktemp("digest-probe")
    (d / "src").mkdir()
    (d / "src" / "digest.rs").write_text(_DIGEST_HEADER + extract)
    (d / "src" / "main.rs").write_text(_MAIN_RS)
    (d / "Cargo.toml").write_text(_CARGO_TOML)
    build = subprocess.run(
        [cargo, "build", "--offline", "--quiet", "--manifest-path", str(d / "Cargo.toml")],
        env=_cargo_env(), capture_output=True, text=True)
    if build.returncode != 0:
        pytest.skip("offline cargo build unavailable: " + build.stderr.strip()[-200:])
    binary = d / "target" / "debug" / "p045-digest-probe"
    if not binary.exists():
        pytest.skip("probe binary not produced")
    return binary


def _rust_digests(binary, values):
    inp = "".join(json.dumps(v) + "\n" for v in values)
    return subprocess.check_output([str(binary)], input=inp, text=True).splitlines()


# Astra's exact reproduction inputs plus a few structural ones.
_PARITY_CASES = [
    {"x": 1}, {"x": 1.0}, {"x": -0.0}, {"x": 1e-7}, {"x": "é"},
    1, 1.0, -0.0, 1e-7, "é", True, False, None,
    [1, 2.0, -0.0], {"a": 1, "b": {"c": 1e-7, "d": "z"}},
    {"z": 1, "a": 2}, {"nl": "a\nb\t\"c\\/", "unicode": "π✓"},
    {"big": 1e20, "small": 1e-20, "neg": -12.34},
]


@pytest.mark.parametrize("i", range(len(_PARITY_CASES)))
def test_digest_parity_on_probe_inputs(rust_probe, i):
    value = _PARITY_CASES[i]
    (rust,) = _rust_digests(rust_probe, [value])
    assert cd._canonical_payload_digest(value) == rust, f"digest mismatch for {value!r}"


def test_rust_normalizes_one_and_one_point_zero_to_same(rust_probe):
    a, b = _rust_digests(rust_probe, [{"x": 1}, {"x": 1.0}])
    assert a == b == cd._canonical_payload_digest({"x": 1})


def _real_recording():
    return cert.st.recording_dir("vw", "single-cut-clojure-legacy")


@pytest.mark.parametrize("rel,pin", [
    ("py/step-000.json", "4b8ef78560ee2daa84cf4fd48da55b56ea902b2dd4edac4d04e9056c9582c83b"),
    ("clj/step-000.blob.json", "acccb9e192e3cd762458d6b5e55fd6c2c1184d01fe3832c6c4e6da229029cb76"),
])
def test_digest_parity_on_real_vw_blobs(rust_probe, rel, pin):
    path = _real_recording() / rel
    if not path.exists():
        pytest.skip(f"real recording {path} not present")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != pin:
        pytest.skip("retained blob differs from the pinned bytes")
    obj = json.loads(raw)
    (rust,) = _rust_digests(rust_probe, [obj])
    assert cd._canonical_payload_digest(obj) == rust


def test_real_py_blob_matches_astra_cited_rust_digest(rust_probe):
    path = _real_recording() / "py/step-000.json"
    if not path.exists():
        pytest.skip("real recording not present")
    obj = json.loads(path.read_bytes())
    (rust,) = _rust_digests(rust_probe, [obj])
    # The digest Astra measured with the standalone store.rs probe (review r5).
    assert rust == "b80bb10831a8de09558a9cdd4cef2c665368d674d13366f77874981bf30e6623"
    assert cd._canonical_payload_digest(obj) == rust
