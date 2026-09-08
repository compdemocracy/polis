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

_DIGEST_HEADER = "use anyhow::Result;\nuse serde_json::Value;\nuse sha2::{Digest, Sha256};\n\n"


def _locked_versions(store):
    """Pin the probe's serde_json/anyhow/sha2 to the coordinator's EXACT lock
    entries, so the probe's serde encoder (and its transitive zmij float
    formatter) cannot drift from the production digest. Returns None if the lock
    is absent (falls back to caret ranges)."""
    lock = store.parents[1] / "Cargo.lock"
    if not lock.exists():
        return None
    want = {}
    name = None
    for line in lock.read_text().splitlines():
        line = line.strip()
        if line.startswith('name = "'):
            name = line.split('"')[1]
        elif line.startswith('version = "') and name in ("serde_json", "anyhow"):
            want[name] = line.split('"')[1]
        elif line.startswith('version = "') and name == "sha2" and "sha2" not in want:
            # store.rs uses sha2 0.10.x; take the first (0.10) entry.
            v = line.split('"')[1]
            if v.startswith("0.10"):
                want["sha2"] = v
    return want if {"serde_json", "anyhow", "sha2"} <= set(want) else None


def _cargo_toml(store):
    pinned = _locked_versions(store)
    if pinned:
        deps = (f'anyhow = "={pinned["anyhow"]}"\n'
                f'sha2 = "={pinned["sha2"]}"\n'
                f'serde_json = {{ version = "={pinned["serde_json"]}", '
                f'features = ["float_roundtrip"] }}\n')
    else:
        deps = ('anyhow = "1"\nsha2 = "0.10"\n'
                'serde_json = { version = "1", features = ["float_roundtrip"] }\n')
    return ('[package]\nname = "p045-digest-probe"\nversion = "0.0.0"\n'
            'edition = "2024"\n[dependencies]\n' + deps)


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
    """Build the standalone Rust digest probe.

    SKIP only when a prerequisite is genuinely ABSENT (cargo not installed, or
    store.rs missing). Once cargo and store.rs are present, a source/marker
    incompatibility, a build failure, or a missing output binary is a test
    FAILURE — a broken digest oracle must not masquerade as an unavailable
    toolchain."""
    cargo = _find_cargo()
    store = _find_store_rs()
    if cargo is None:
        pytest.skip("cargo not found (set P045_CARGO or install the toolchain)")
    if store is None:
        pytest.skip("coordinator-rs/src/store.rs not found")
    src = store.read_text()
    start = src.find("pub fn digest(")
    end = src.find("/// Exact worker output")
    if start == -1 or end == -1 or end <= start:
        pytest.fail("store.rs digest source markers not found — the digest oracle "
                    "changed shape; the parity test must be updated, not skipped")
    d = tmp_path_factory.mktemp("digest-probe")
    (d / "src").mkdir()
    (d / "src" / "digest.rs").write_text(_DIGEST_HEADER + src[start:end])
    (d / "src" / "main.rs").write_text(_MAIN_RS)
    (d / "Cargo.toml").write_text(_cargo_toml(store))
    build = subprocess.run(
        [cargo, "build", "--offline", "--quiet", "--manifest-path", str(d / "Cargo.toml")],
        env=_cargo_env(), capture_output=True, text=True)
    if build.returncode != 0:
        pytest.fail(f"cargo is present but the digest probe failed to build "
                    f"(exit {build.returncode}); this is a digest-oracle regression, "
                    f"not a missing toolchain:\n{build.stderr.strip()[-600:]}")
    binary = d / "target" / "debug" / "p045-digest-probe"
    if not binary.exists():
        pytest.fail("cargo reported success but produced no probe binary")
    return binary


def _rust_digests(binary, values):
    inp = "".join(json.dumps(v) + "\n" for v in values)
    return subprocess.check_output([str(binary)], input=inp, text=True).splitlines()


# Astra's exact reproduction inputs plus structural and integer-boundary ones.
_PARITY_CASES = [
    {"x": 1}, {"x": 1.0}, {"x": -0.0}, {"x": 1e-7}, {"x": "é"},
    1, 1.0, -0.0, 1e-7, "é", True, False, None,
    [1, 2.0, -0.0], {"a": 1, "b": {"c": 1e-7, "d": "z"}},
    {"z": 1, "a": 2}, {"nl": "a\nb\t\"c\\/", "unicode": "π✓"},
    {"big": 1e20, "small": 1e-20, "neg": -12.34}, {"e21": 1e21},
    # serde_json integer-token boundaries: i64/u64 exact, else f64.
    {"x": 2 ** 53 + 1}, {"x": 2 ** 63}, {"x": 2 ** 63 - 1},
    {"x": 2 ** 64 - 1},       # u64::MAX (exact)
    {"x": -(2 ** 63)},        # i64::MIN (exact)
    {"x": 2 ** 64},           # u64::MAX + 1 -> f64
    {"x": 2 ** 64 + 1}, {"x": -(2 ** 63) - 1}, {"x": 10 ** 25 + 1},
    2 ** 64, -(2 ** 63) - 1,
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


# ---------------------------------------------------------------------------
# Round 7 (board [449]): integer boundary digest + fixture fail-vs-skip.
# ---------------------------------------------------------------------------
def test_u64_boundary_matches_astra_cited_digest(rust_probe):
    """{'x': 2**64} takes serde's f64 representation before number(); the ported
    digest must equal the value Astra measured with the standalone store.rs probe."""
    (rust,) = _rust_digests(rust_probe, [{"x": 2 ** 64}])
    assert rust == "eb369f44996329cb7252a3fad311df14e1e46bbc28f56aa15a9baa381ae16f8f"
    assert cd._canonical_payload_digest({"x": 2 ** 64}) == rust


@pytest.mark.parametrize("value", [
    2 ** 64, 2 ** 64 + 1, -(2 ** 63) - 1, 10 ** 25 + 1, 2 ** 53 + 1, 2 ** 63,
    2 ** 64 - 1, -(2 ** 63),
])
def test_integer_boundary_digest_parity(rust_probe, value):
    (rust,) = _rust_digests(rust_probe, [{"x": value}])
    assert cd._canonical_payload_digest({"x": value}) == rust, f"digest mismatch for {value}"


def test_probe_deps_pinned_to_coordinator_lock(rust_probe):
    """The probe's serde/serde_json/zmij resolve to the coordinator's exact lock
    entries (the digest is only as reproducible as its float formatter)."""
    import tomllib

    def versions(lock_path):
        pkgs = tomllib.loads(lock_path.read_text())["package"]
        return {p["name"]: p["version"] for p in pkgs
                if p["name"] in ("serde", "serde_json", "zmij")}

    probe_lock = rust_probe.parents[2] / "Cargo.lock"
    coord_lock = _find_store_rs().parents[1] / "Cargo.lock"
    assert versions(probe_lock) == versions(coord_lock)


def test_fixture_fails_not_skips_on_build_error():
    """Correction 3: with cargo present, a build failure must be a test FAILURE,
    not a skip that hides a broken digest oracle."""
    from types import SimpleNamespace
    from unittest.mock import patch
    import tempfile

    store = _find_store_rs()
    if store is None or _find_cargo() is None:
        pytest.skip("prerequisites genuinely absent")
    with tempfile.TemporaryDirectory(prefix="p045-r7-fixture-") as td:
        factory = SimpleNamespace(mktemp=lambda _: Path(td))
        with patch(__name__ + "._find_cargo", return_value="/present/cargo"), \
             patch(__name__ + "._find_store_rs", return_value=store), \
             patch.object(subprocess, "run",
                          return_value=SimpleNamespace(returncode=101, stderr="error[E0425]")):
            # A build failure must raise Failed (pytest.fail), NOT Skipped.
            with pytest.raises(pytest.fail.Exception):
                rust_probe.__wrapped__(factory)
            with pytest.raises(BaseException) as exc:
                rust_probe.__wrapped__(factory)
            assert not isinstance(exc.value, pytest.skip.Exception)
