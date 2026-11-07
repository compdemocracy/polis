#!/usr/bin/env python3
"""Check literal host-port inputs without executing workflows or launchers.

Scan every workflow (all environment levels, run assignments and service
publications), every ci/local and conformance shell launcher, and shell helpers
under scripts and server/characterization. Also scan Makefile and test Compose
interpolation defaults. Dynamic inputs remain the launchers' runtime checks.
Container listeners, negative test cases and application configuration are not
host defaults. Keep the extraction forms covered by tests when adding syntax.
"""
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from host_ports import environment, published

NAME = r"(?:[A-Z][A-Z0-9_]*_PORT|P027_PORT_MIN|P027_PORT_MAX|[A-Z0-9_]*DATABASE_URL[A-Z0-9_]*|[A-Z0-9_]*PG_ADMIN_URL)"
ASSIGNMENT = re.compile(rf"(?<![\w$])({NAME})[\"']?\s*(?:\?=|:=|=|:)\s*([\"']?)([^\s\"',}}]+)")
DEFAULT = re.compile(rf"\$\{{({NAME}):[-=]([^{{}}]+)\}}")
DYNAMIC = re.compile(r"\$|`|\{\{")


def inputs(text):
    """Yield (line, name, literal) including defaults embedded in URLs."""
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("#"):
            continue
        defaults = list(DEFAULT.finditer(line))
        for match in defaults:
            name, value = match.groups()
            if not DYNAMIC.search(value):
                yield number, name, value
        for match in ASSIGNMENT.finditer(line):
            name, _, value = match.groups()
            if re.search(r"(?:^|\s)(?:-e|--env)\s+[\"']?$", line[:match.start()]):
                continue  # docker's container environment, not the host shell
            # A parameter expansion is handled above, not as an assignment.
            if match.start() >= 2 and line[match.start()-2:match.start()] == "${":
                continue
            if not DYNAMIC.search(value):
                yield number, name, value


def publications(text):
    """GitHub service ports: short syntax, inline or block sequence."""
    indent = None
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        level = len(line) - len(line.lstrip())
        match = re.match(r"ports:\s*(.*)", stripped)
        if match:
            indent = level
            tail = match[1].split(" #", 1)[0].strip()
            if tail:
                if not (tail.startswith("[") and tail.endswith("]")):
                    raise ValueError(f"line {number}: ports: use an explicit list of host publications")
                for item in tail[1:-1].split(","):
                    if item.strip():
                        yield number, item.strip().strip("\"'")
            continue
        if indent is not None:
            if level < indent or (level == indent and not stripped.startswith("-")):
                indent = None
            elif stripped.startswith("-"):
                yield number, stripped[1:].strip().split(" #", 1)[0].strip("\"'")


def check_input(name, value):
    environment({name: value}, [name])


def check_publication(value):
    # GitHub requires short syntax: [host-ip:]host:container[/protocol].
    parts = value.split(":")
    if len(parts) < 2:
        raise ValueError("ports: an explicit host publication is required")
    published(parts[-2], "ports")


def candidates(root):
    """Use Git's tracked and nonignored untracked files, never a tree walk."""
    try:
        top = subprocess.check_output(["git", "-C", str(root), "rev-parse", "--show-toplevel"],
                                      stderr=subprocess.DEVNULL, text=True).strip()
        if Path(top).resolve() != root:
            raise ValueError("host-port scan requires the checkout root")
        names = subprocess.check_output(
            ["git", "-C", str(root), "ls-files", "-co", "--exclude-standard", "-z"],
            stderr=subprocess.DEVNULL).decode().split("\0")
    except (OSError, subprocess.CalledProcessError, UnicodeError):
        raise ValueError("host-port scan could not list checkout files") from None
    workflows, launchers = [], []
    for name in sorted(set(names) - {""}):
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("host-port scan received a path outside the checkout")
        workflow = (relative.parent == Path(".github/workflows") and
                    relative.suffix in (".yml", ".yaml"))
        launcher = (name == "Makefile" or relative.match("*compose*.yml") or
                    (relative.suffix == ".sh" and str(relative.parent) in
                     ("ci/local", "scripts", "queue-rs/polis-api/conformance")) or
                    (name.startswith("server/characterization/") and relative.suffix == ".sh"))
        if not (workflow or launcher):
            continue
        path = root / relative
        # Do not follow file or directory links, including links outside the
        # checkout. Diagnostics name only the repository entry, never its target.
        if any(p.is_symlink() for p in (path, *path.parents) if p != root and root in p.parents):
            raise ValueError(f"{name}: host-port input must not be a symbolic link")
        if path.is_file():  # A tracked file deleted from the working tree is absent.
            (workflows if workflow else launchers).append(path)
    return workflows, launchers


def scan(root):
    root = Path(root).resolve()
    workflows, launchers = candidates(root)
    records, errors = [], []
    for path in [*workflows, *sorted(launchers)]:
        relative = str(path.relative_to(root))
        text = path.read_text()
        # Compose files contribute interpolation defaults only: service env
        # values describe container listeners, not host publications.
        found = list(inputs(text))
        if "compose" in path.name:
            found = [(n, k, v) for n, k, v in found
                     if any(m[1] == k and m[2] == v for m in DEFAULT.finditer(text.splitlines()[n-1]))]
        for line, name, value in found:
            records.append((relative, line, name, value))
            try:
                if "compose" in path.name and name.endswith("_PORT"):
                    published(value, name)
                else:
                    check_input(name, value)
            except ValueError as error:
                errors.append(f"{relative}:{line}: {name}: {error}")
        if path in workflows:
            try:
                for line, value in publications(text):
                    records.append((relative, line, "ports", value))
                    try:
                        check_publication(value)
                    except ValueError as error:
                        errors.append(f"{relative}:{line}: ports: {error}")
            except ValueError as error:
                errors.append(f"{relative}: {error}")
    return workflows, launchers, records, errors


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
    try:
        workflows, launchers, records, errors = scan(root)
    except ValueError as error:
        raise SystemExit(str(error)) from None
    workflow_inputs = sum(p.startswith(".github/workflows/") for p, *_ in records)
    print(f"Host inputs: {len(workflows)} workflows / {workflow_inputs} inputs; "
          f"{len(launchers)} launcher/Compose files / {len(records)-workflow_inputs} inputs")
    if errors:
        raise SystemExit("\n".join(errors))
    print("All literal host inputs satisfy the shared rule")


if __name__ == "__main__":
    main()
