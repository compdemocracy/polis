"""Validation + evaluation of ``delphi/scripts/certify_datasets.json``.

P-022 section A: the selection config is committed BEFORE any candidate output
is inspected, contains only numeric rules over the committed metrics, and never
carries a zid, report id, topic or comment text. This module is the executable
half of that contract:

* :func:`validate_config` — structural validation against
  ``scripts/certify_datasets.schema.json`` (a small, dependency-free Draft-07
  subset interpreter lives in :func:`validate_against_schema`) plus the
  SEMANTIC RULES the schema cannot express.
* :func:`evaluate_predicates` / :func:`sort_key_for` — the pure rule engine the
  survey resolver (``polismath.replay.fixture_survey``) uses to turn rules into
  a ranked candidate list.

SEMANTIC RULES (all enforced by :func:`validate_config`):

1. Every ``metric`` named in a predicate or ``order_by`` key must be a key of
   the config's ``metrics`` block AND a known survey metric.
2. Every ``order_by`` list must END with ``{"metric": "zid", "direction":
   "asc"}`` and must not mention ``zid`` anywhere else — zid ascending is the
   one and only tie-break, and it is applied inside the private selection
   process.
3. Slugs are unique; role names are unique.
4. ``on_missing`` = ``fail_with_synthetic_replacement_offer`` REQUIRES a
   ``synthetic_replacement`` naming an existing generated case id (and the
   plain ``fail`` variant must NOT carry one).
5. Roles are ordered replacement-group-first: no ``group=stress`` role may
   precede a ``group=replacement`` role, because replacement roles are resolved
   first and reserve their conversations.
6. Every ``workloads[].references`` entry, ``small_job_stream`` entry and
   ``cache_cap_plus_one_cohort.touch_after_eviction`` names an existing role
   slug; ``generator_case`` names an existing generated case id.
7. Generated case ids are unique. ``shape = lru-cohort`` requires
   ``cohort_size``; no other shape may carry one.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
DEFAULT_CONFIG_PATH = SCRIPTS_DIR / "certify_datasets.json"
DEFAULT_SCHEMA_PATH = SCRIPTS_DIR / "certify_datasets.schema.json"

#: Metrics the survey computes; the config's ``metrics`` block must be a subset
#: (kept in sync by tests/test_certify_datasets_config.py).
KNOWN_METRICS: frozenset[str] = frozenset({
    "V", "U", "P", "C",
    "revote_share", "density", "matrix_area",
    "mod_out_share", "meta_share",
    "registered_participants", "all_comments",
    "math_eligible_comments", "eligible_participants",
    "banned_voters", "mod_out_or_meta_comments",
    "zid",
})

_OPS = {
    "ge": lambda a, b: a >= b,
    "gt": lambda a, b: a > b,
    "le": lambda a, b: a <= b,
    "lt": lambda a, b: a < b,
    "eq": lambda a, b: a == b,
    "ne": lambda a, b: a != b,
}


class ConfigError(ValueError):
    """Raised for any structural or semantic defect in the selection config."""


# ---------------------------------------------------------------------------
# Minimal JSON Schema (Draft-07 subset) interpreter.
# ---------------------------------------------------------------------------

_SUPPORTED_KEYWORDS = frozenset({
    "$schema", "$id", "$ref", "title", "description", "definitions",
    "type", "const", "enum", "pattern", "minLength",
    "properties", "required", "additionalProperties",
    "items", "minItems", "minimum",
})

_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def _resolve_ref(ref: str, root: dict[str, Any]) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise ConfigError(f"unsupported $ref (only local refs): {ref!r}")
    node: Any = root
    for part in ref[2:].split("/"):
        node = node[part]
    return node


def validate_against_schema(
    instance: Any, schema: dict[str, Any], *, root: dict[str, Any] | None = None,
    path: str = "$", errors: list[str] | None = None,
) -> list[str]:
    """Validate ``instance`` against the Draft-07 SUBSET used by
    ``certify_datasets.schema.json``. Returns a list of human-readable errors
    (empty = valid). Unsupported keywords raise :class:`ConfigError` rather
    than being silently ignored — a schema keyword that does nothing is a
    silent hole in the gate."""
    root = schema if root is None else root
    errors = [] if errors is None else errors

    unsupported = set(schema) - _SUPPORTED_KEYWORDS
    if unsupported:
        raise ConfigError(
            f"schema at {path} uses unsupported keyword(s): {sorted(unsupported)}"
        )

    if "$ref" in schema:
        return validate_against_schema(
            instance, _resolve_ref(schema["$ref"], root),
            root=root, path=path, errors=errors,
        )

    expected_type = schema.get("type")
    if expected_type is not None:
        types = [expected_type] if isinstance(expected_type, str) else list(expected_type)
        for t in types:
            if t not in _TYPE_CHECKS:
                raise ConfigError(f"schema at {path} uses unknown type {t!r}")
        if not any(_TYPE_CHECKS[t](instance) for t in types):
            errors.append(f"{path}: expected type {expected_type}, got {type(instance).__name__}")
            return errors

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: expected const {schema['const']!r}, got {instance!r}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: {instance!r} not in enum {schema['enum']!r}")
    if isinstance(instance, str):
        if "pattern" in schema and not re.search(schema["pattern"], instance):
            errors.append(f"{path}: {instance!r} does not match {schema['pattern']!r}")
        if "minLength" in schema and len(instance) < schema["minLength"]:
            errors.append(f"{path}: shorter than minLength {schema['minLength']}")
    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        if "minimum" in schema and instance < schema["minimum"]:
            errors.append(f"{path}: {instance} < minimum {schema['minimum']}")

    if isinstance(instance, dict):
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}: missing required property {key!r}")
        additional = schema.get("additionalProperties", True)
        for key, value in instance.items():
            child_path = f"{path}.{key}"
            if key in properties:
                validate_against_schema(
                    value, properties[key], root=root, path=child_path, errors=errors)
            elif additional is False:
                errors.append(f"{child_path}: unexpected property")
            elif isinstance(additional, dict):
                validate_against_schema(
                    value, additional, root=root, path=child_path, errors=errors)

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: {len(instance)} items < minItems {schema['minItems']}")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for i, item in enumerate(instance):
                validate_against_schema(
                    item, item_schema, root=root, path=f"{path}[{i}]", errors=errors)

    return errors


# ---------------------------------------------------------------------------
# Semantic validation.
# ---------------------------------------------------------------------------


def _semantic_errors(config: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    declared_metrics = set(config.get("metrics", {}))

    unknown = declared_metrics - KNOWN_METRICS
    if unknown:
        errors.append(
            f"$.metrics: declares metric(s) the survey does not compute: {sorted(unknown)}")

    roles = config.get("roles", [])
    slugs: list[str] = []
    names: list[str] = []
    gen_ids = {c["id"] for c in config.get("generated", {}).get("cases", [])
               if isinstance(c, dict) and "id" in c}

    seen_stress = False
    for i, role in enumerate(roles):
        where = f"$.roles[{i}]({role.get('slug', '?')})"
        slugs.append(role.get("slug"))
        names.append(role.get("role"))

        # Rule 5 — replacement roles must all precede stress roles.
        if role.get("group") == "stress":
            seen_stress = True
        elif seen_stress:
            errors.append(
                f"{where}: group=replacement role appears after a group=stress role; "
                "replacement roles are resolved first and reserve their conversations")

        # Rule 1 — known metrics only.
        for j, pred in enumerate(role.get("predicates", [])):
            metric = pred.get("metric")
            if metric not in declared_metrics:
                errors.append(f"{where}.predicates[{j}]: metric {metric!r} is not declared in $.metrics")
            elif metric not in KNOWN_METRICS:
                errors.append(f"{where}.predicates[{j}]: metric {metric!r} is not a survey metric")

        order_by = role.get("order_by", [])
        for j, key in enumerate(order_by):
            metric = key.get("metric")
            if metric not in declared_metrics:
                errors.append(f"{where}.order_by[{j}]: metric {metric!r} is not declared in $.metrics")

        # Rule 2 — zid ascending is the last and only tie-break.
        if not order_by:
            errors.append(f"{where}.order_by: must not be empty")
        else:
            last = order_by[-1]
            if last.get("metric") != "zid" or last.get("direction") != "asc":
                errors.append(
                    f"{where}.order_by: must end with the zid-ascending tie-break, "
                    f"got {last!r}")
            for j, key in enumerate(order_by[:-1]):
                if key.get("metric") == "zid":
                    errors.append(
                        f"{where}.order_by[{j}]: zid may only appear as the final tie-break")

        # Rule 4 — synthetic replacement offers.
        on_missing = role.get("on_missing")
        replacement = role.get("synthetic_replacement")
        if on_missing == "fail_with_synthetic_replacement_offer":
            if not replacement:
                errors.append(f"{where}: on_missing={on_missing} requires synthetic_replacement")
            elif replacement not in gen_ids:
                errors.append(
                    f"{where}.synthetic_replacement: {replacement!r} is not a generated case id")
        elif replacement is not None:
            errors.append(
                f"{where}: synthetic_replacement is only meaningful with "
                "on_missing=fail_with_synthetic_replacement_offer")

    # Rule 3 — unique slugs / role names.
    for label, values in (("slug", slugs), ("role", names)):
        dupes = sorted({v for v in values if values.count(v) > 1 and v is not None})
        if dupes:
            errors.append(f"$.roles: duplicate {label}(s) {dupes}")

    # Rule 6 — workload references.
    slug_set = {s for s in slugs if s}
    for i, wl in enumerate(config.get("workloads", [])):
        where = f"$.workloads[{i}]({wl.get('id', '?')})"
        refs = list(wl.get("references", [])) + list(wl.get("small_job_stream", []))
        cohort = wl.get("cache_cap_plus_one_cohort")
        if cohort:
            refs.append(cohort.get("touch_after_eviction"))
            if cohort.get("generator_case") not in gen_ids:
                errors.append(
                    f"{where}.cache_cap_plus_one_cohort.generator_case: "
                    f"{cohort.get('generator_case')!r} is not a generated case id")
        for ref in refs:
            if ref not in slug_set:
                errors.append(f"{where}: references unknown role slug {ref!r}")

    # Rule 7 — generated cases.
    cases = config.get("generated", {}).get("cases", [])
    ids = [c.get("id") for c in cases]
    dupes = sorted({v for v in ids if ids.count(v) > 1})
    if dupes:
        errors.append(f"$.generated.cases: duplicate id(s) {dupes}")
    for i, case in enumerate(cases):
        where = f"$.generated.cases[{i}]({case.get('id', '?')})"
        if case.get("shape") == "lru-cohort" and "cohort_size" not in case:
            errors.append(f"{where}: shape=lru-cohort requires cohort_size")
        if case.get("shape") != "lru-cohort" and "cohort_size" in case:
            errors.append(f"{where}: cohort_size is only meaningful for shape=lru-cohort")

    return errors


def load_schema(path: Path | None = None) -> dict[str, Any]:
    return json.loads((path or DEFAULT_SCHEMA_PATH).read_text())


def load_config(path: Path | None = None) -> dict[str, Any]:
    """Load AND validate the selection config. Raises :class:`ConfigError`."""
    path = path or DEFAULT_CONFIG_PATH
    config = json.loads(path.read_text())
    validate_config(config)
    return config


def validate_config(
    config: dict[str, Any], schema: dict[str, Any] | None = None
) -> None:
    """Raise :class:`ConfigError` listing EVERY structural + semantic defect."""
    schema = schema if schema is not None else load_schema()
    errors = validate_against_schema(config, schema)
    errors += _semantic_errors(config)
    if errors:
        raise ConfigError(
            "certify_datasets config is invalid:\n  - " + "\n  - ".join(errors))


# ---------------------------------------------------------------------------
# Pure rule engine — predicates and ordering over a metrics row.
# ---------------------------------------------------------------------------


def evaluate_predicates(
    metrics: dict[str, Any], predicates: Iterable[dict[str, Any]]
) -> bool:
    """AND every predicate over one conversation's metrics row.

    A predicate whose metric is ``None`` (an undefined ratio — e.g. ``density``
    on an empty matrix, per the config's ``null_when``) evaluates FALSE. It is
    never treated as zero and never silently skipped.
    """
    for pred in predicates:
        value = metrics.get(pred["metric"])
        if value is None:
            return False
        if not _OPS[pred["op"]](value, pred["value"]):
            return False
    return True


def sort_key_for(
    metrics: dict[str, Any], order_by: Iterable[dict[str, Any]]
) -> tuple:
    """Build a tuple sort key implementing ``order_by`` under plain ascending
    ``sorted()``. Descending keys are negated; ``None`` metrics sort LAST in
    either direction (they cannot win a rank they are not defined for)."""
    key: list[tuple[int, float]] = []
    for spec in order_by:
        value = metrics.get(spec["metric"])
        if value is None:
            key.append((1, 0.0))
            continue
        value = float(value)
        key.append((0, -value if spec["direction"] == "desc" else value))
    return tuple(key)
