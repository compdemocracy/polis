"""Boundary tests for explicit test-harness host publications."""
import importlib.util
from contextlib import contextmanager
import unittest
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

from host_ports import database_port, environment, port, published


class HostPortsTest(unittest.TestCase):
    def test_allowed_endpoints_and_usual_allocations(self):
        for value in (1, 80, 443, 20000, 29999, 32767):
            with self.subTest(value=value):
                self.assertEqual(port(str(value)), value)

    def test_refuses_ephemeral_and_nonexplicit_ports(self):
        for value in (0, -1, 32768, 49152, 65535, 65536, "", "auto", "1.5", " 80"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                port(value)

    def test_publication_ranges(self):
        published("1-32767")
        published("20000-20002")
        for value in ("0", "32767-32768", "30000-20000", "20000-20001-20002", ""):
            with self.subTest(value=value), self.assertRaises(ValueError):
                published(value)

    def test_environment_and_database_loopback(self):
        environment({"POLIS_RECOVERY_PG_PORT": "20000",
                     "TEST_DATABASE_URL": "postgresql://postgres@127.0.0.1:20000/test"},
                    ["POLIS_RECOVERY_PG_PORT", "TEST_DATABASE_URL"])
        for update in ({"P027_PORT_MAX": "32768"}, {"P027_HTTP_PORT": "0"},
                       {"TEST_DATABASE_URL": "postgresql://postgres@localhost:20000/test"},
                       {"TEST_DATABASE_URL": "postgresql://postgres@[::1]:20000/test"},
                       {"TEST_DATABASE_URL": "postgresql://postgres@127.0.0.1:32768/test"}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                environment(update, update)

    def test_database_port_does_not_select_development_database(self):
        self.assertEqual(database_port(20000), 20000)
        for value in (5432, 0, 32768):
            with self.subTest(value=value), self.assertRaises(ValueError):
                database_port(value)
        # Fixed Compose publications still include the ordinary database port.
        published("5432")
        for url in ("postgresql://postgres@127.0.0.1/test",
                    "postgresql://postgres@127.0.0.1:5432/test"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                environment({"TEST_DATABASE_URL": url}, ["TEST_DATABASE_URL"])

    def test_unrelated_environment_is_not_a_launcher_input(self):
        env = {"REVIEW_UNRELATED_PORT": "40000",
               "DATABASE_URL": "postgresql://postgres@localhost:5432/polis-dev",
               "P027_HTTP_PORT": "20000"}
        environment(env, ["P027_HTTP_PORT"])
        environment(env, [])
        with self.assertRaises(ValueError):
            environment(env, ["REVIEW_UNRELATED_PORT"])
        with self.assertRaises(ValueError):
            environment(env, ["DATABASE_URL"])

    def test_cli_requires_explicit_environment_names(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("host_ports.py")), "env"],
                                text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("env requires explicit variable names", result.stderr)

    def test_client_launcher_ignores_unrelated_ports_and_database(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            bins = Path(tmp)
            for name, body in {"node": "echo v24.22.1", "npm": "echo npm-reached; exit 73"}.items():
                tool = bins / name
                tool.write_text("#!/bin/sh\n" + body + "\n")
                tool.chmod(0o755)
            env = dict(os.environ, PATH=str(bins) + os.pathsep + os.environ["PATH"],
                       REVIEW_UNRELATED_PORT="40000",
                       DATABASE_URL="postgresql://postgres@localhost:5432/polis-dev")
            result = subprocess.run(["bash", str(root / "ci/local/client-admin.sh")],
                                    env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 73, result.stderr)
            self.assertIn("npm-reached", result.stdout)


class HostInputScanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location(
            "scan_host_ports", cls.root / "ci/local/scan-host-ports.py")
        cls.scan = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.scan)

    @contextmanager
    def repository(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            # An empty disposable Git repository; no real index or ref changes.
            (root / ".git/objects").mkdir(parents=True)
            (root / ".git/refs").mkdir()
            (root / ".git/HEAD").write_text("ref: refs/heads/test\n")
            (root / "Makefile").touch()
            env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
            with patch.dict(os.environ, env, clear=True):
                yield root

    def test_ignored_invalid_compose_is_not_read(self):
        with self.repository() as root:
            (root / ".gitignore").write_text(".ci-out/\n")
            path = root / ".ci-out/old-release/docker-compose.yml"
            path.parent.mkdir(parents=True)
            path.write_text("port: ${TEST_PG_PORT:-55432}\n")
            read_text = Path.read_text

            def read_unless_forbidden(candidate, *args, **kwargs):
                self.assertNotEqual(candidate, path, "ignored file was read")
                return read_text(candidate, *args, **kwargs)

            with patch.object(Path, "read_text", read_unless_forbidden):
                workflows, launchers, records, errors = self.scan.scan(root)
            self.assertNotIn(path, launchers)
            self.assertEqual(errors, [])
            self.assertEqual(records, [])

    def test_untracked_invalid_compose_is_scanned(self):
        with self.repository() as root:
            path = root / "new-stack/docker-compose.yml"
            path.parent.mkdir()
            path.write_text("port: ${TEST_PG_PORT:-55432}\n")
            workflows, launchers, records, errors = self.scan.scan(root)
            self.assertIn(path, launchers)
            self.assertEqual(len(errors), 1, errors)
            self.assertIn("new-stack/docker-compose.yml:1: TEST_PG_PORT:", errors[0])

    def test_external_symlink_is_not_read_or_disclosed(self):
        with self.repository() as root, tempfile.TemporaryDirectory() as outside:
            target = Path(outside) / "external-compose.yml"
            target.write_text("port: ${TEST_PG_PORT:-55432}\n")
            path = root / "docker-compose.yml"
            path.symlink_to(target)
            read_text = Path.read_text

            def read_unless_forbidden(candidate, *args, **kwargs):
                self.assertNotIn(candidate, (path, target), "external file was read")
                return read_text(candidate, *args, **kwargs)

            with patch.object(Path, "read_text", read_unless_forbidden):
                with self.assertRaisesRegex(ValueError, "docker-compose.yml") as error:
                    self.scan.scan(root)
            self.assertNotIn(outside, str(error.exception))

    def test_repository_defaults_and_workflows(self):
        workflows, launchers, records, errors = self.scan.scan(self.root)
        self.assertTrue(workflows)
        self.assertTrue(launchers)
        self.assertTrue(records)
        self.assertEqual(errors, [])

    def test_workflow_levels_and_publication_forms(self):
        text = """env: {P027_HTTP_PORT: '25931'}
 jobs:
  test:
   env:
    POLIS_RECOVERY_PG_PORT: 25432
   services:
    pg:
     ports: ['127.0.0.1:25432:5432']
    other:
     ports:
      - 25433:5432
   steps:
    - env: {P027_CONTROL_PORT: 25932}
      run: P027_HTTP_PORT=25931 true
"""
        self.assertEqual(len(list(self.scan.inputs(text))), 4)
        self.assertEqual(len(list(self.scan.publications(text))), 2)
        for _, key, value in self.scan.inputs(text):
            self.scan.check_input(key, value)
        for _, value in self.scan.publications(text):
            self.scan.check_publication(value)

    def test_moved_workflow_and_launcher_ports_name_the_source(self):
        cases = [
            (".github/workflows/manual.yml", "env:\n  P027_HTTP_PORT: '55931'\n", "P027_HTTP_PORT"),
            (".github/workflows/quoted.yml", "env: {'P027_HTTP_PORT': '55931'}\n", "P027_HTTP_PORT"),
            ("ci/local/admin.sh", 'P2ZERO_PG_ADMIN_URL="${P2ZERO_PG_ADMIN_URL:-postgresql://postgres@127.0.0.1:55931/test}"\n', "P2ZERO_PG_ADMIN_URL"),
            ("ci/local/api.sh", 'export IMPORTANCE_PG_PORT="${IMPORTANCE_PG_PORT:-55463}"\n', "IMPORTANCE_PG_PORT"),
            (".github/workflows/service.yaml", 'services:\n pg:\n  ports: ["55931:5432"]\n', "ports"),
            ("ci/local/api.sh", 'DATABASE_URL=postgresql://postgres@127.0.0.1:55931/test\n', "DATABASE_URL"),
        ]
        for name, text, variable in cases:
            with self.subTest(name=name, variable=variable), self.repository() as root:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
                errors = self.scan.scan(root)[3]
                self.assertEqual(len(errors), 1, errors)
                self.assertIn(name + ":", errors[0])
                self.assertIn(variable, errors[0])

    def test_dynamic_values_and_container_listeners_are_not_host_defaults(self):
        text = '''export P027_HTTP_PORT="$CHOSEN_PORT"
export DATABASE_URL="postgresql://postgres@127.0.0.1:${PG_PORT}/test"
docker run -p "127.0.0.1:$PG_PORT:5432" -e DATABASE_URL=postgresql://postgres@127.0.0.1/test image
# P027_HTTP_PORT=55931 is not an assignment.
'''
        self.assertEqual(list(self.scan.inputs(text)), [])

    def test_no_dynamic_or_unbounded_service_publications(self):
        for value in ("5432", "32767-32768:5432", "0:5432", "${{ env.PG_PORT }}:5432"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.scan.check_publication(value)

    def test_recovery_refuses_bad_port_before_docker(self):
        with tempfile.TemporaryDirectory() as tmp:
            tool = Path(tmp) / "docker"
            tool.write_text("#!/bin/sh\necho docker-reached; exit 73\n")
            tool.chmod(0o755)
            env = dict(os.environ, PATH=tmp + os.pathsep + os.environ["PATH"])
            for value in ("5432", "32768", "55432"):
                with self.subTest(value=value):
                    result = subprocess.run(["make", "test-recovery-up", "RECOVERY_PG_PORT=" + value],
                                            cwd=self.root, env=env, text=True, capture_output=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn("docker-reached", result.stdout + result.stderr)
                    self.assertIn("choose", result.stderr)


if __name__ == "__main__":
    unittest.main()
