"""Boundary tests for explicit test-harness host publications."""
import unittest
import os
from pathlib import Path
import subprocess
import sys
import tempfile

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


if __name__ == "__main__":
    unittest.main()
