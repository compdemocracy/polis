#!/usr/bin/env python3
"""Process-control tests for the ci/local entry points, with no Docker.

Each test copies the real entry points (and, where named, the real launcher)
into a throwaway Git checkout, puts stub `docker`, `cargo`, `node` and Python
executables first on PATH, and replaces the suites themselves with small
stubs that record how they were called. They check what the entry points
decide (refuse, run, combine, clean up), not the suites.

  python3 ci/tests/test_local_entry_points.py
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PY = sys.executable

DOCKER = f"""#!{PY}
# Docker stand-in: answers the queries the entry points make from a JSON state
# file and logs every call. `fail` lists queries that exit 97 with no output.
import json, os, sys, uuid
path = os.environ["STUB_STATE"]
state = json.load(open(path))
argv = sys.argv[1:]
with open(os.environ["STUB_LOG"], "a") as log:
    log.write(json.dumps(argv) + "\\n")
def save():
    json.dump(state, open(path, "w"))
def fail_if(kind):
    if kind in state["fail"]:
        sys.exit(97)
def project(args):
    for a in args:
        if a.startswith("label=com.docker.compose.project="):
            return a.split("=", 2)[2]
    return None
def words(args):
    out, skip = [], False
    for a in args:
        if skip:
            skip = False
        elif a in ("--format", "-f", "--filter"):
            skip = True
        elif not a.startswith("-"):
            out.append(a)
    return out
if argv[:1] == ["ps"]:
    fail_if("ps")
    name = project(argv)
    if name is not None:
        if name in state["projects"]:
            print("c0ffee")
    else:
        print("\\n".join(state["containers"]))
elif argv[:2] == ["network", "ls"]:
    fail_if("network")
    if project(argv) in state["projects"]:
        print("n0")
elif argv[:2] == ["volume", "ls"]:
    fail_if("volume")
    name = project(argv)
    if name is not None:
        if name in state["projects"]:
            print("v0")
    else:
        print("\\n".join(state["volumes"]))
elif argv[:2] == ["volume", "inspect"]:
    fail_if("volume")
    sys.exit(0 if argv[2] in state["volumes"] else 1)
elif argv[:2] == ["volume", "create"]:
    state["volumes"].append(argv[2]); save(); print(argv[2])
elif argv[:2] == ["volume", "rm"]:
    gone = [v for v in argv[2:] if v in state["volumes"]]
    state["volumes"] = [v for v in state["volumes"] if v not in gone]; save()
    sys.exit(0 if len(gone) == len(argv[2:]) else 1)
elif argv[:2] == ["image", "inspect"]:
    fail_if("image")
    refs = words(argv[2:])
    if any(r not in state["images"] for r in refs):
        sys.exit(1)
    print("\\n".join(state["images"][r] for r in refs))
    # A failure after printing plausible ids, as a broken daemon connection can.
    sys.exit(state.get("inspect_exit", 0))
elif argv[:1] == ["__fail"]:
    state["fail"].append(argv[1]); save()
elif argv[:1] == ["__build"]:
    for image in ("postgres", "delphi"):
        state["images"][f"polis-test-{{image}}:{{argv[1]}}"] = "sha256:" + uuid.uuid4().hex
    save()
elif argv[:1] == ["rm"]:
    state["containers"] = [c for c in state["containers"] if c not in words(argv[1:])]; save()
elif argv[:1] == ["inspect"]:
    sys.exit(0 if words(argv[1:])[-1] in state["containers"] else 1)
"""

TEST_IMAGES = """#!/usr/bin/env bash
# Stand-in for ci/local/test-images.sh: records the call, then tags new images.
set -euo pipefail
echo "test-images $*" >> "$STUB_CALLS"
[ "${STUB_IMAGES_EXIT:-0}" = 0 ] || exit "$STUB_IMAGES_EXIT"
docker __build "$3"
"""

DELPHI_PYTHON = """#!/usr/bin/env bash
# Stand-in for ci/local/delphi-python.sh: replaces its results directory the
# way the real script does, then exits as STUB_SHARD_<I>_EXIT says.
set -euo pipefail
if [ "$1" = combine ]; then
  echo "combine $*" >> "$STUB_CALLS"
  mkdir -p "$DELPHI_CHECK_OUT"
  echo '{"passed": 6}' > "$DELPHI_CHECK_OUT/counts.json"
  exit "${STUB_COMBINE_EXIT:-0}"
fi
i="${2%/*}"
echo "shard $2" >> "$STUB_CALLS"
rm -rf "$DELPHI_CHECK_OUT"
mkdir -p "$DELPHI_CHECK_OUT"
echo "$2" > "$DELPHI_CHECK_OUT/manifest.json"
eval "rc=\\${STUB_SHARD_${i}_EXIT:-0}"
exit "$rc"
"""

COMBINE_SELF_TEST = f"""#!{PY}
import os, sys
open(os.environ["STUB_CALLS"], "a").write("combine-self-test\\n")
"""

# A launcher stand-in: records its arguments and the variables named in
# STUB_ENV_KEYS, then exits 0.
LAUNCHER = """#!/usr/bin/env bash
name="$(basename "$0")"
{
  printf 'launcher %s' "$name"
  for k in CARGO_TARGET_DIR WRITER_PROOF_ROOT IMPORT_PROOF_ROOT COMPOSE_PROJECT_NAME; do
    if env | grep -q "^$k="; then printf ' %s=%s' "$k" "$(env | sed -n "s/^$k=//p")"
    else printf ' %s-unset' "$k"; fi
  done
  printf '\\n'
} >> "$STUB_CALLS"
if [ "$name" = test-dynamo-writers.sh ] && [ -n "${STUB_CREATE_VOLUME:-}" ]; then
  docker volume create "$STUB_CREATE_VOLUME" >/dev/null
fi
if [ -n "${STUB_THEN_FAIL:-}" ]; then
  docker __fail "$STUB_THEN_FAIL"
fi
"""

CARGO = """#!/usr/bin/env bash
# Records the target directory cargo would write to, then fails like a broken build.
if [ -n "${CARGO_TARGET_DIR+x}" ]; then echo "cargo CARGO_TARGET_DIR=$CARGO_TARGET_DIR" >> "$STUB_CALLS"
else echo "cargo CARGO_TARGET_DIR-unset" >> "$STUB_CALLS"; fi
exit 42
"""

ENTRY_POINTS = ["runtime.sh", "delphi-python-tests.sh", "dynamo-writers.sh",
                "polis-cli.sh", "delphi-result-reads.sh", "production-import.sh"]


def write(path: Path, text: str, mode: int = 0o755) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


class Checkout:
    """A throwaway Git checkout with the real entry points and stub suites."""

    def __init__(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="local-entry-points-")).resolve()
        self.root = self.tmp / "checkout"
        self.bin = self.tmp / "bin"
        for name in ENTRY_POINTS:
            write(self.root / "ci/local" / name, (REPO / "ci/local" / name).read_text(), 0o644)
        write(self.root / "ci/local/test-images.sh", TEST_IMAGES)
        write(self.root / "ci/local/delphi-python.sh", DELPHI_PYTHON)
        write(self.root / "ci/tests/test_delphi_python_results.py", COMBINE_SELF_TEST)
        for launcher in ("test-dynamo-writers.sh", "test-polis-cli.sh",
                         "test-delphi-result-reads.sh", "test-production-import.sh"):
            write(self.root / "scripts" / launcher, LAUNCHER)
        (self.root / "queue-rs").mkdir()
        write(self.root / "queue-rs/README", "crate\n", 0o644)
        write(self.root / ".gitignore", ".ci-out/\n__pycache__/\n", 0o644)
        write(self.bin / "docker", DOCKER)
        write(self.bin / "cargo", CARGO)
        write(self.bin / "node", "#!/usr/bin/env bash\necho v24.22.1\n")
        self.state = self.tmp / "docker-state.json"
        self.log = self.tmp / "docker-log.jsonl"
        self.calls = self.tmp / "calls.txt"
        self.set_state(projects=[], containers=[], volumes=[], images={}, fail=[])
        self.git("init", "-q")
        self.commit("start")

    def git(self, *args: str) -> None:
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
                        "-c", "user.name=test", "-c", "user.email=test@example.invalid",
                        *args], cwd=self.root, check=True, stdout=subprocess.DEVNULL)

    def commit(self, message: str) -> None:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)

    def set_state(self, **values) -> None:
        state = json.loads(self.state.read_text()) if self.state.exists() else {}
        state.update(values)
        self.state.write_text(json.dumps(state))

    def docker_state(self) -> dict:
        return json.loads(self.state.read_text())

    def run(self, script: str, **env: str) -> subprocess.CompletedProcess:
        base = {k: v for k, v in os.environ.items()
                if k not in ("COMPOSE_PROJECT_NAME", "CHECK_SOURCE_ROOT", "DELPHI_PYTHON_LEG",
                             "DELPHI_PYTHON_OUT", "CARGO_TARGET_DIR", "POLIS_RECOVERY_PG_PORT",
                             "RESULT_READS_PROJECT", "GITHUB_ACTIONS")}
        base.update(PATH=f"{self.bin}{os.pathsep}{os.environ['PATH']}",
                    STUB_STATE=str(self.state), STUB_LOG=str(self.log), STUB_CALLS=str(self.calls))
        base.update(env)
        return subprocess.run(["bash", script], cwd=self.root, env=base,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def calls_text(self) -> str:
        return self.calls.read_text() if self.calls.exists() else ""

    def reset_calls(self) -> None:
        self.calls.unlink(missing_ok=True)

    def close(self) -> None:
        for path in self.tmp.rglob("*"):
            if path.is_dir() and not path.is_symlink():
                path.chmod(stat.S_IRWXU)
        shutil.rmtree(self.tmp)


class EntryPointTest(unittest.TestCase):
    def setUp(self) -> None:
        self.c = Checkout()

    def tearDown(self) -> None:
        self.c.close()


class DelphiPythonTests(EntryPointTest):
    P = "polis-test-run"
    SCRIPT = "ci/local/delphi-python-tests.sh"

    RUN = "run-1"

    def leg(self, leg: str = "", **env: str) -> subprocess.CompletedProcess:
        if leg:
            env["DELPHI_PYTHON_LEG"] = leg
        env.setdefault("DELPHI_PYTHON_RUN", self.RUN)
        return self.c.run(self.SCRIPT, COMPOSE_PROJECT_NAME=self.P, **env)

    def full_pass(self) -> None:
        r = self.leg()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.c.reset_calls()

    def test_full_run_builds_runs_six_shards_then_combines(self):
        r = self.leg()
        self.assertEqual(r.returncode, 0, r.stdout)
        calls = self.c.calls_text().splitlines()
        self.assertEqual(calls[0], f"test-images build --tag {self.P} --only postgres,delphi")
        self.assertEqual(calls[1:7], [f"shard {i}/6" for i in range(1, 7)])
        self.assertEqual(calls[7], "combine-self-test")
        self.assertTrue(calls[8].startswith("combine combine "), calls[8])
        self.assertEqual(calls[8].split()[2:], [str(self.c.root / ".ci-out" / self.P / f"shard-{i}")
                                                for i in range(1, 7)])

    def test_full_run_runs_every_shard_after_one_fails_and_never_combines(self):
        r = self.leg(STUB_SHARD_3_EXIT="23")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        calls = self.c.calls_text()
        for i in range(1, 7):
            self.assertIn(f"shard {i}/6", calls)
        self.assertNotIn("combine", calls)

    def test_full_run_fails_when_earlier_results_cannot_be_replaced(self):
        # A passing run, then a read-only results directory: nothing of the
        # earlier run can be removed, and shard 3 now fails.
        self.full_pass()
        out = self.c.root / ".ci-out" / self.P
        for path in sorted(out.rglob("*"), reverse=True):
            path.chmod(0o555 if path.is_dir() else 0o444)
        out.chmod(0o555)
        r = self.leg(STUB_SHARD_3_EXIT="23")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("combine", self.c.calls_text())

    def test_failed_image_build_leaves_nothing_to_combine(self):
        self.full_pass()
        r = self.leg("images", STUB_IMAGES_EXIT="17")
        self.assertEqual(r.returncode, 17, r.stdout)
        r = self.leg("combine")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("combine combine", self.c.calls_text())

    def test_refused_shard_rerun_leaves_no_passing_receipt(self):
        self.full_pass()
        self.c.set_state(projects=[f"{self.P}-shard-2"])
        r = self.leg("shard-2")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.c.set_state(projects=[])
        r = self.leg("combine")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("combine combine", self.c.calls_text())

    def test_failed_shard_rerun_leaves_no_passing_receipt(self):
        self.full_pass()
        r = self.leg("shard-5", STUB_SHARD_5_EXIT="9")
        self.assertEqual(r.returncode, 9, r.stdout)
        r = self.leg("combine")
        self.assertNotEqual(r.returncode, 0, r.stdout)

    def test_combine_refuses_results_of_another_source(self):
        self.full_pass()
        write(self.c.root / "queue-rs/README", "changed\n", 0o644)
        r = self.leg("combine")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("combine combine", self.c.calls_text())

    def test_shard_refuses_images_this_run_did_not_build(self):
        self.full_pass()
        subprocess.run([str(self.c.bin / "docker"), "__build", self.P], check=True,
                       env={**os.environ, "STUB_STATE": str(self.c.state), "STUB_LOG": str(self.c.log)})
        r = self.leg("shard-2")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("shard 2/6", self.c.calls_text())
        r = self.leg("combine")
        self.assertNotEqual(r.returncode, 0, r.stdout)

    def test_shard_needs_this_runs_images(self):
        r = self.leg("shard-1")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("shard 1/6", self.c.calls_text())

    def test_a_shard_retried_within_the_run_still_combines(self):
        self.full_pass()
        self.assertEqual(self.leg("shard-4").returncode, 0)
        r = self.leg("combine")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("combine combine", self.c.calls_text())

    def test_legs_one_at_a_time(self):
        for leg in ["images", *[f"shard-{i}" for i in range(1, 7)], "combine"]:
            r = self.leg(leg)
            self.assertEqual(r.returncode, 0, f"{leg}: {r.stdout}")
        self.assertIn("combine combine", self.c.calls_text())

    def test_combine_needs_all_six_shards(self):
        for leg in ["images", *[f"shard-{i}" for i in range(1, 6)]]:
            self.assertEqual(self.leg(leg).returncode, 0)
        r = self.leg("combine")
        self.assertNotEqual(r.returncode, 0, r.stdout)

    def test_results_directory_cannot_leave_ci_out(self):
        outside = self.c.tmp / "outside"
        r = self.leg("images", DELPHI_PYTHON_OUT=str(outside))
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertFalse(outside.exists())

    def test_ci_out_symlink_is_refused(self):
        elsewhere = self.c.tmp / "elsewhere"
        elsewhere.mkdir()
        (self.c.root / ".ci-out").symlink_to(elsewhere)
        r = self.leg("images")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def make_read_only(self, path: Path) -> None:
        for child in sorted(path.rglob("*"), reverse=True):
            child.chmod(0o555 if child.is_dir() else 0o444)
        path.chmod(0o555)

    def test_combine_fails_when_the_source_cannot_be_read(self):
        # git cannot hash a changed tracked file it cannot read; its partial
        # output must not stand in for the clean source.
        self.full_pass()
        readme = self.c.root / "queue-rs/README"
        readme.write_text("changed\n")
        readme.chmod(0)
        r = self.leg("combine")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("combine combine", self.c.calls_text())

    def test_images_fail_when_image_inspection_fails(self):
        self.c.set_state(inspect_exit=97)
        r = self.leg("images")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertFalse((self.c.root / ".ci-out" / self.P / "images.ok").exists())

    def test_shard_fails_when_image_inspection_fails(self):
        self.full_pass()
        self.c.set_state(inspect_exit=97)
        r = self.leg("shard-2")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("shard 2/6", self.c.calls_text())

    def test_combine_refuses_a_run_it_was_not_asked_for(self):
        # The new run cannot remove the old run's receipts; asked to combine
        # the new run, combine must not accept them.
        self.full_pass()
        self.make_read_only(self.c.root / ".ci-out" / self.P)
        self.assertNotEqual(self.leg("images", DELPHI_PYTHON_RUN="run-2").returncode, 0)
        r = self.leg("combine", DELPHI_PYTHON_RUN="run-2")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("combine combine", self.c.calls_text())

    def test_a_job_on_its_own_needs_a_run_id(self):
        self.full_pass()
        r = self.leg("combine", DELPHI_PYTHON_RUN="")
        self.assertEqual(r.returncode, 2, r.stdout)
        self.assertNotIn("combine", self.c.calls_text())

    def test_combine_replaces_a_planted_combined_directory(self):
        self.full_pass()
        outside = self.c.tmp / "outside"
        outside.mkdir()
        combined = self.c.root / ".ci-out" / self.P / "combined"
        shutil.rmtree(combined, ignore_errors=True)
        combined.symlink_to(outside)
        r = self.leg("combine")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse(combined.is_symlink())

    def test_combine_does_not_write_through_a_planted_file_link(self):
        self.full_pass()
        outside = self.c.tmp / "outside.json"
        outside.write_text("preserve me\n")
        combined = self.c.root / ".ci-out" / self.P / "combined"
        combined.mkdir(exist_ok=True)
        (combined / "counts.json").unlink(missing_ok=True)
        (combined / "counts.json").symlink_to(outside)
        r = self.leg("combine")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(outside.read_text(), "preserve me\n")

    def test_unknown_leg_is_refused(self):
        r = self.leg("shard-7")
        self.assertEqual(r.returncode, 2, r.stdout)
        self.assertEqual(self.c.calls_text(), "")


class ProjectCheckTests(EntryPointTest):
    """check_project in ci/local/runtime.sh refuses when Docker cannot answer."""

    def check(self) -> subprocess.CompletedProcess:
        write(self.c.root / "probe.sh", '. ci/local/runtime.sh\ncheck_project polis-probe\necho free\n', 0o644)
        return self.c.run("probe.sh")

    def test_free_project_passes(self):
        r = self.check()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("free", r.stdout)

    def test_occupied_project_is_refused(self):
        self.c.set_state(projects=["polis-probe"])
        self.assertNotEqual(self.check().returncode, 0)

    def test_each_failed_docker_query_is_refused(self):
        for kind in ("ps", "network", "volume"):
            with self.subTest(query=kind):
                self.c.set_state(fail=[kind])
                r = self.check()
                self.assertNotEqual(r.returncode, 0, r.stdout)
                self.assertNotIn("free", r.stdout)


class PolisCliTests(EntryPointTest):
    def test_checks_the_python_its_launcher_runs(self):
        # `python` is 3.12, but the launcher runs `python3`, which is not.
        write(self.c.bin / "python", f"#!/usr/bin/env bash\nexec {PY} -c 'pass'\n")
        write(self.c.bin / "python3", "#!/usr/bin/env bash\necho 'Python 3.9' >&2; exit 1\n")
        r = self.c.run("ci/local/polis-cli.sh")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("launcher", self.c.calls_text())

    def test_does_not_inherit_a_cargo_target_directory(self):
        write(self.c.bin / "python3", "#!/usr/bin/env bash\nexit 0\n")
        r = self.c.run("ci/local/polis-cli.sh", CARGO_TARGET_DIR=str(self.c.tmp / "shared-target"))
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("launcher test-polis-cli.sh CARGO_TARGET_DIR-unset", self.c.calls_text())


class WritersTests(EntryPointTest):
    P = "polis-graph-test-probe"

    def writers(self, **env: str) -> subprocess.CompletedProcess:
        return self.c.run("ci/local/dynamo-writers.sh", COMPOSE_PROJECT_NAME=self.P,
                          POLIS_RECOVERY_PG_PORT="55999", **env)

    def use_real_launcher(self) -> None:
        write(self.c.root / "scripts/test-dynamo-writers.sh",
              (REPO / "scripts/test-dynamo-writers.sh").read_text(), 0o644)

    def test_existing_raw_container_is_refused_and_kept(self):
        # The launcher's cleanup removes these names whatever created them;
        # the real launcher fails at its first cargo command and cleans up.
        self.use_real_launcher()
        self.c.set_state(containers=[f"{self.P}-dynamo"])
        r = self.writers()
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertIn(f"{self.P}-dynamo", self.c.docker_state()["containers"])

    def test_docker_listing_failure_is_refused(self):
        self.c.set_state(fail=["ps"])
        r = self.writers()
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("launcher", self.c.calls_text())

    def test_existing_cargo_volume_is_refused_and_kept(self):
        self.c.set_state(volumes=[f"{self.P}-cargo"])
        r = self.writers()
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("launcher", self.c.calls_text())
        self.assertIn(f"{self.P}-cargo", self.c.docker_state()["volumes"])

    def test_cargo_volume_the_run_created_is_removed(self):
        r = self.writers(STUB_CREATE_VOLUME=f"{self.P}-cargo")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertNotIn(f"{self.P}-cargo", self.c.docker_state()["volumes"])

    def test_proof_logs_and_cargo_output_stay_in_the_checkout(self):
        self.use_real_launcher()
        r = self.writers(CARGO_TARGET_DIR=str(self.c.tmp / "shared-target"))
        self.assertEqual(r.returncode, 42, r.stdout)
        self.assertTrue((self.c.root / ".ci-out" / self.P / "rust.log").exists())
        self.assertFalse((self.c.root / ".writer-proof").exists())
        self.assertIn("cargo CARGO_TARGET_DIR-unset", self.c.calls_text())


    def test_ci_out_symlink_is_refused(self):
        elsewhere = self.c.tmp / "elsewhere"
        elsewhere.mkdir()
        (self.c.root / ".ci-out").symlink_to(elsewhere)
        r = self.writers()
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("launcher", self.c.calls_text())
        self.assertEqual(list(elsewhere.iterdir()), [])


    def test_existing_results_directory_is_refused(self):
        # A link planted in the results directory would make the launcher's
        # `tee` write over a file outside it.
        self.use_real_launcher()
        outside = self.c.tmp / "outside.log"
        outside.write_text("preserve me\n")
        proof = self.c.root / ".ci-out" / self.P
        proof.mkdir(parents=True)
        (proof / "rust.log").symlink_to(outside)
        r = self.writers()
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertEqual(outside.read_text(), "preserve me\n")

    def test_cargo_volume_cleanup_fails_when_docker_cannot_answer(self):
        r = self.writers(STUB_CREATE_VOLUME=f"{self.P}-cargo", STUB_THEN_FAIL="volume")
        self.assertNotEqual(r.returncode, 0, r.stdout)


class ResultReadsTests(EntryPointTest):
    P = "result-reads-probe"

    def reads(self, **env: str) -> subprocess.CompletedProcess:
        return self.c.run("ci/local/delphi-result-reads.sh", RESULT_READS_PROJECT=self.P,
                          RESULT_READS_PG_PORT="55998", RESULT_READS_DYNAMO_PORT="55997", **env)

    def test_existing_raw_container_is_refused(self):
        self.c.set_state(containers=[f"{self.P}-postgres"])
        r = self.reads()
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("launcher", self.c.calls_text())

    def test_does_not_inherit_a_cargo_target_directory(self):
        r = self.reads(CARGO_TARGET_DIR=str(self.c.tmp / "shared-target"))
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("launcher test-delphi-result-reads.sh CARGO_TARGET_DIR-unset", self.c.calls_text())


class ImportTests(EntryPointTest):
    def test_proof_goes_under_ci_out(self):
        p = "polis-import-test-probe"
        r = self.c.run("ci/local/production-import.sh", COMPOSE_PROJECT_NAME=p,
                       POLIS_RECOVERY_PG_PORT="55996")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn(f"IMPORT_PROOF_ROOT={self.c.root}/.ci-out/{p}", self.c.calls_text())


    def test_ci_out_symlink_is_refused(self):
        elsewhere = self.c.tmp / "elsewhere"
        elsewhere.mkdir()
        (self.c.root / ".ci-out").symlink_to(elsewhere)
        r = self.c.run("ci/local/production-import.sh", COMPOSE_PROJECT_NAME="polis-import-test-probe",
                       POLIS_RECOVERY_PG_PORT="55996")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("launcher", self.c.calls_text())
        self.assertEqual(list(elsewhere.iterdir()), [])


    def test_existing_results_directory_is_refused(self):
        p = "polis-import-test-probe"
        proof = self.c.root / ".ci-out" / p
        proof.mkdir(parents=True)
        (proof / "unit.log").symlink_to(self.c.tmp / "outside.log")
        r = self.c.run("ci/local/production-import.sh", COMPOSE_PROJECT_NAME=p,
                       POLIS_RECOVERY_PG_PORT="55996")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertNotIn("launcher", self.c.calls_text())


if __name__ == "__main__":
    unittest.main()
