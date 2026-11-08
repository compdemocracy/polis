"""D05 refuses its entire tunnel window before creating files or starting tools."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "coordinator-rs/tools/d05"))
spec = importlib.util.spec_from_file_location("d05_ports_run", ROOT / "coordinator-rs/tools/d05/run.py")
run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run)


class D05PortsTest(unittest.TestCase):
    def test_last_reader_tunnel_refused_before_output_creation(self):
        with patch.object(Path, "mkdir", side_effect=AssertionError("unvalidated tunnel window")) as mkdir:
            with self.assertRaisesRegex(ValueError, "reader_p2 tunnel port"):
                run.Campaign(Path("unused-output"), "port-window-test", 32756)
            mkdir.assert_not_called()

    def test_highest_allowed_window_reaches_output_creation(self):
        with patch.object(Path, "mkdir", side_effect=FileExistsError("output sentinel")):
            with self.assertRaisesRegex(FileExistsError, "output sentinel"):
                run.Campaign(Path("unused-output"), "port-window-test", 32755)

    def test_validation_uses_the_tunnel_target_sequence(self):
        with patch.object(run, "READER_TARGET_PORTS", (*run.READER_TARGET_PORTS, 5003)):
            with patch.object(Path, "mkdir", side_effect=AssertionError("unvalidated tunnel window")) as mkdir:
                with self.assertRaisesRegex(ValueError, "reader_p2 tunnel port"):
                    run.Campaign(Path("unused-output"), "port-window-test", 32755)
                mkdir.assert_not_called()

    def test_http_tunnel_can_use_the_normal_database_port(self):
        # Only the first port is a PostgreSQL connection; the tunnels carry HTTP.
        with patch.object(Path, "mkdir", side_effect=FileExistsError("output sentinel")):
            with self.assertRaisesRegex(FileExistsError, "output sentinel"):
                run.Campaign(Path("unused-output"), "port-window-test", 5431)
