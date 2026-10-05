#!/usr/bin/env python3
"""Check that suite-script repository inputs are covered by changed-suites.sh.

Derives each suite script's repository inputs from the script text. Inputs read
only by a program the script calls, and not named in the script, are not seen.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / "ci" / "local"
SELECTOR = LOCAL / "changed-suites.sh"


def suite_names() -> list[str]:
    text = (LOCAL / "suites.sh").read_text()
    names: list[str] = []
    for key in ("CHECK_GATE_SUITES", "CHECK_UNGATED_SUITES", "CHECK_TOOLING_SUITES"):
        match = re.search(rf'^{key}="([^"]*)"', text, re.MULTILINE)
        if not match:
            raise AssertionError(f"missing {key} in suites.sh")
        names.extend(match.group(1).split())
    return list(dict.fromkeys(names))


def tracked_inputs() -> tuple[set[str], set[str]]:
    files = set(
        subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True).splitlines()
    )
    directories: set[str] = set()
    for path in files:
        parts = path.split("/")
        directories.update("/".join(parts[:i]) for i in range(1, len(parts)))
    return files, directories


FILES, DIRECTORIES = tracked_inputs()
TOP_FILES = {path for path in FILES if "/" not in path}
TOP_LEVEL = sorted({path.split("/", 1)[0] for path in FILES if "/" in path}, key=len, reverse=True)
PATH_RE = re.compile(
    rf"(?<![A-Za-z0-9_./-])((?:{'|'.join(map(re.escape, TOP_LEVEL))})/[A-Za-z0-9_./-]+)"
)


def add_if_tracked(found: set[str], path: str) -> None:
    path = path.rstrip(".,:;)'\"`")
    if path in FILES or (ROOT / path).is_file():
        found.add(path)
    elif path in DIRECTORIES or (ROOT / path).is_dir():
        representative = next((item for item in sorted(FILES) if item.startswith(f"{path}/")), None)
        if representative:
            found.add(representative)


def extract_inputs(script: Path) -> set[str]:
    text = script.read_text()
    normalized = text.replace("$CHECK_ROOT/", "").replace("${CHECK_ROOT}/", "")
    normalized = normalized.replace("$CHECK_LOCAL/", "ci/local/").replace("${CHECK_LOCAL}/", "ci/local/")
    found: set[str] = set()

    for match in PATH_RE.finditer(normalized):
        add_if_tracked(found, match.group(1))
    for token in re.split(r"[^A-Za-z0-9_./-]+", normalized):
        token = token.rstrip(".,:;")
        if token.startswith("./"):
            token = token[2:]
        if token in TOP_FILES:
            found.add(token)

    for match in re.finditer(r"\bcheck_npm\s+([A-Za-z0-9_.-]+)", text):
        add_if_tracked(found, match.group(1))
    for match in re.finditer(r'\bcd\s+["\']?([A-Za-z0-9_.-]+)["\']?', normalized):
        add_if_tracked(found, match.group(1))
    for match in re.finditer(r"\bcheck_compose\s+cp\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+)\s", text):
        add_if_tracked(found, match.group(1))
    for match in re.finditer(r"\bfor\s+\w+\s+in\s+([^;\n]+)", text):
        for item in match.group(1).split():
            add_if_tracked(found, item.rstrip("\\"))

    if "check_stack_env" in text:
        found.add("test.env")
    if "check_compose" in text:
        found.add("docker-compose.test.yml")
    if "projection_inventory.py --print-scan-inputs" in text:
        output = subprocess.check_output(
            ["python3", "delphi/scripts/projection_inventory.py", "--print-scan-inputs"],
            cwd=ROOT,
            text=True,
        )
        for path in output.splitlines():
            add_if_tracked(found, path)

    found.discard(script.relative_to(ROOT).as_posix())
    return found


def selected_suites(path: str) -> set[str]:
    output = subprocess.check_output([str(SELECTOR), "--path", path], cwd=ROOT, text=True)
    return set(output.split())


def main() -> None:
    failures: list[str] = []
    checked = 0
    for suite in suite_names():
        script = LOCAL / f"{suite}.sh"
        if not script.is_file():
            failures.append(f"{suite}: missing suite script")
            continue
        inputs = extract_inputs(script)
        if not inputs:
            failures.append(f"{suite}: extracted no repository inputs")
            continue
        for path in sorted(inputs):
            checked += 1
            if suite not in selected_suites(path):
                failures.append(f"{suite}: selector misses {path}")
    if failures:
        raise SystemExit("\n".join(failures))
    print(f"selector coverage: {checked} suite/input pairs passed")


if __name__ == "__main__":
    main()
