"""Every command the package advertises must still resolve.

`[project.scripts]` in pyproject.toml is a dispatch surface of its own: removing
a stage from `run_delphi.py` does not stop the package publishing a console
command for it. Two entry points outlived the stages they pointed at
(`calculate-extremity`, `calculate-priorities`, for the deleted 501/502) and
were only caught in review. This test closes that gap for all of them.

Resolution is checked statically -- the target file is located on disk and its
AST is searched for the named top-level callable -- so nothing here imports
torch, umap or boto3, and the test stays fast and offline.
"""

import ast
import tomllib
from pathlib import Path

import pytest

DELPHI_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = DELPHI_ROOT / "pyproject.toml"

with PYPROJECT.open("rb") as handle:
    SCRIPTS = tomllib.load(handle)["project"]["scripts"]


def _module_path(module: str) -> Path:
    """Resolve a dotted module name to a file, module or package."""
    base = DELPHI_ROOT.joinpath(*module.split("."))
    for candidate in (base.with_suffix(".py"), base / "__init__.py"):
        if candidate.is_file():
            return candidate
    return base.with_suffix(".py")  # reported as missing by the caller


def _top_level_names(tree: ast.Module) -> set[str]:
    names = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names.update(a.asname or a.name.split(".")[0] for a in node.names)
    return names


@pytest.mark.parametrize("command", sorted(SCRIPTS))
def test_advertised_command_resolves(command):
    target = SCRIPTS[command]
    module, _, attribute = target.partition(":")

    path = _module_path(module)
    assert path.is_file(), (
        f"[project.scripts] advertises '{command} = {target}' but "
        f"{path.relative_to(DELPHI_ROOT)} does not exist. Remove the entry "
        "point when you remove the module."
    )

    assert attribute, f"'{command} = {target}' names no callable"
    names = _top_level_names(ast.parse(path.read_text(encoding="utf-8")))
    assert attribute in names, (
        f"[project.scripts] advertises '{command} = {target}' but "
        f"{path.relative_to(DELPHI_ROOT)} defines no top-level '{attribute}'."
    )


def test_retired_stage_commands_are_gone():
    """Stages 501/502 were deleted; their commands must not come back."""
    assert "calculate-extremity" not in SCRIPTS
    assert "calculate-priorities" not in SCRIPTS
