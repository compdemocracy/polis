"""Every script run_delphi.py launches must start the way it is launched.

Running a file as a script puts the file's own folder first on sys.path. When
that folder holds a module named like a standard-library module (today
polismath/types.py and polismath/queue/), the first standard-library import of
that name resolves to the package's file instead and fails with a circular
import. Such launches pass -P (Python's safe-path flag) so the folder is not
added.
"""
import ast
import subprocess
import sys
from pathlib import Path

DELPHI = Path(__file__).resolve().parents[1]


def _shadowed(folder: Path) -> set:
    names = {
        p.stem if p.suffix == ".py" else p.name
        for p in folder.iterdir()
        if (p.suffix == ".py" or p.is_dir()) and not p.name.startswith("_")
    }
    return names & set(sys.stdlib_module_names)


def _python_launches():
    """(flags, script path relative to delphi/) for each python argv list in run_delphi.py."""
    tree = ast.parse((DELPHI / "run_delphi.py").read_text())
    for node in ast.walk(tree):
        if not (isinstance(node, ast.List) and node.elts):
            continue
        head = node.elts[0]
        if not (isinstance(head, ast.Constant) and head.value == "python"):
            continue
        flags = [
            e.value
            for e in node.elts[1:]
            if isinstance(e, ast.Constant) and isinstance(e.value, str) and e.value.startswith("-")
        ]
        script = next((e for e in node.elts[1:] if isinstance(e, ast.JoinedStr)), None)
        if script is None:
            continue
        tail = "".join(v.value for v in script.values if isinstance(v, ast.Constant))
        if tail.endswith(".py"):
            yield flags, tail.lstrip("/")


def test_launches_from_shadowing_folders_use_safe_path():
    launches = list(_python_launches())
    # The parser must see today's launches, or the check below proves nothing.
    assert {rel for _, rel in launches} >= {
        "umap_narrative/run_pipeline.py", "umap_narrative/700_datamapplot_for_layer.py"}
    for flags, rel in launches:
        shadowed = _shadowed(DELPHI / Path(rel).parent)
        if shadowed:
            assert "-P" in flags, (
                f"{rel} runs from a folder that shadows the standard library "
                f"({', '.join(sorted(shadowed))}); launch it with python -P"
            )


def test_math_pipeline_starts_with_safe_path():
    result = subprocess.run(
        [sys.executable, "-P", str(DELPHI / "polismath" / "run_math_pipeline.py"), "--help"],
        capture_output=True,
        text=True,
        cwd=DELPHI,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr[-2000:]
