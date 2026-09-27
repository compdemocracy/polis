"""Local configuration and coverage-report entry points, without host writes."""
import io
import xml.etree.ElementTree as ET

import pytest

import configure_instance as resource
import generate_coverage_md as coverage


def test_recognized_environment_does_not_read_instance_file(monkeypatch):
    monkeypatch.setenv("INSTANCE_SIZE", "small")
    monkeypatch.setattr(resource.os.path, "exists", lambda _: pytest.fail("unnecessary host read"))
    assert resource.detect_instance_type() == "small"


def test_unrecognized_environment_falls_back_to_trimmed_instance_file(monkeypatch):
    monkeypatch.setenv("INSTANCE_SIZE", "public-unknown")
    monkeypatch.setattr(resource.os.path, "exists", lambda _: True)
    monkeypatch.setattr("builtins.open", lambda *a, **kw: io.StringIO(" large\n"))
    assert resource.detect_instance_type() == "large"


@pytest.mark.parametrize("case", ["missing", "unknown", "unreadable"])
def test_unavailable_or_unknown_instance_file_selects_default(monkeypatch, case):
    monkeypatch.delenv("INSTANCE_SIZE", raising=False)
    monkeypatch.setattr(resource.os.path, "exists", lambda _: case != "missing")

    def read(*args, **kwargs):
        if case == "unreadable":
            raise PermissionError("public fixture refusal")
        return io.StringIO("public-unknown")

    monkeypatch.setattr("builtins.open", read)
    assert resource.detect_instance_type() == "default"


def test_resource_selection_exports_only_expected_variables(monkeypatch):
    original = dict(resource.os.environ)
    monkeypatch.setattr(resource.os, "environ", dict(original))
    selected = resource.configure_resources("large")
    assert {k: resource.os.environ[k] for k in (
        "INSTANCE_SIZE", "DELPHI_MAX_WORKERS", "DELPHI_WORKER_MEMORY",
        "DELPHI_CONTAINER_MEMORY", "DELPHI_CONTAINER_CPUS"
    )} == {"INSTANCE_SIZE": "large", "DELPHI_MAX_WORKERS": "8",
           "DELPHI_WORKER_MEMORY": "8g", "DELPHI_CONTAINER_MEMORY": "32g",
           "DELPHI_CONTAINER_CPUS": "8"}
    assert selected["max_workers"] == 8
    assert all(resource.os.environ[k] == v for k, v in original.items()
               if k not in {"INSTANCE_SIZE", "DELPHI_MAX_WORKERS", "DELPHI_WORKER_MEMORY",
                            "DELPHI_CONTAINER_MEMORY", "DELPHI_CONTAINER_CPUS"})


def test_coverage_table_sorts_files_and_weights_total_by_statement_count(monkeypatch, capsys):
    tree = ET.ElementTree(ET.fromstring('''<coverage><packages><package><classes>
      <class filename="z.py" line-rate="1"><lines><line hits="1"/></lines></class>
      <class filename="a.py" line-rate="0.5"><lines><line hits="2"/><line hits="0"/></lines></class>
      <class filename="empty.py" line-rate="0"><lines/></class>
      </classes></package><package/></packages></coverage>'''))
    seen = []
    monkeypatch.setattr(coverage.ET, "parse", lambda path: seen.append(path) or tree)
    coverage.main()
    assert seen == ["/app/coverage.xml"]
    assert capsys.readouterr().out.splitlines() == [
        "| File | Stmts | Miss | Cover |", "|------|-------|------|-------|",
        "| a.py | 2 | 1 | 50% |", "| z.py | 1 | 0 | 100% |",
        "| **Total** | **3** | **1** | **67%** |",
    ]


def test_empty_coverage_is_not_reported_as_full_coverage(monkeypatch, capsys):
    tree = ET.ElementTree(ET.fromstring("<coverage><packages/></coverage>"))
    monkeypatch.setattr(coverage.ET, "parse", lambda _: tree)
    coverage.main()
    assert "| **Total** | **0** | **0** | **N/A** |" in capsys.readouterr().out


@pytest.mark.parametrize("case", ["no-packages", "missing", "malformed"])
def test_invalid_coverage_input_exits_nonzero(monkeypatch, capsys, case):
    def parse(_):
        if case == "missing":
            raise FileNotFoundError("public fixture missing")
        if case == "malformed":
            raise ET.ParseError("public malformed fixture")
        return ET.ElementTree(ET.fromstring("<coverage/>"))

    monkeypatch.setattr(coverage.ET, "parse", parse)
    with pytest.raises(SystemExit) as error:
        coverage.main()
    assert error.value.code == 1
    assert capsys.readouterr().err
