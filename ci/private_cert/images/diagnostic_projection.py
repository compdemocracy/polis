"""Receipt diagnostics projected solely from independently compared entries."""
from polismath.replay.diagnostics import ordered
from polismath.replay import fixture_samples

ROLE_RECIPES = {
    ("large-shape-rank-16", "uniform6"): "large-r16-uniform6",
    ("large-shape-rank-8", "uniform8"): "large-r8-uniform8",
    ("large-shape-rank-4", "uniform8"): "large-r4-uniform8",
    ("large-shape-rank-2", "uniform8"): "large-r2-uniform8",
    ("large-shape-rank-1", "uniform6"): "large-r1-uniform6",
    ("revote-heavy", "uniform6"): "revote-uniform6",
    ("banned-participant", "uniform6"): "banned-uniform6",
    ("small-mix", "uniform6"): "smallmix-uniform6",
    ("mid-mix", "uniform6"): "midmix-uniform6",
    ("zero-vote", "single-cut"): "zero-empty",
    ("moderation-heavy", "single-cut-mod"): "modheavy-single",
    ("meta-rich-cold", "single-cut-mod"): "meta-single",
    ("mid-mix", "uniform6-restart3"): "midmix-restart3",
    ("meta-rich-warm", "uniform6-mod"): "meta-uniform6",
    ("public-medium", "uniform8"): "public-vw-uniform8",
    ("public-medium", "front-loaded6"): "public-vw-front6",
    ("public-medium", "single-cut"): "public-vw-single",
    ("public-small", "uniform8"): "public-biodiversity-uniform8",
    ("public-medium", "every-vote-56"): "public-vw-every56",
    ("public-medium", "uniform8-restart4"): "public-vw-restart4",
}

ROLE_RECIPES = {(role, schedule + "-clojure-legacy"): token
                for (role, schedule), token in ROLE_RECIPES.items()}


def recipe_token(entry):
    if (entry.role in {fixture_samples.slug(i) for i in range(1, 21)}
            and entry.dataset == entry.role and entry.schedule_id == fixture_samples.SCHEDULE_ID):
        return "sample-uniform6"
    try:
        return ROLE_RECIPES[entry.role, entry.schedule_id]
    except (KeyError, TypeError):
        raise ValueError("DIAGNOSTIC_RECIPE") from None


def comparison_diagnostics(strict, metric):
    rows = list(metric.get("diagnostics", []))
    if metric.get("status") == "STEP_COUNT_MISMATCH" or strict.get("step_count_mismatch"):
        rows.append(dict(checkpoint=0, family="meta", kind="shape", magnitude="not-applicable"))
    numeric = {(d["checkpoint"], d["family"]) for d in rows if d["kind"] == "numeric-tolerance"}
    for ordinal, step in enumerate(strict["per_step"]):
        if not step["match"]:
            categories = step.get("diagnostics") or [
                dict(family="meta", kind="shape", magnitude="not-applicable")]
            # At the exported family/checkpoint resolution, a strict numeric
            # token names only failures not already named by symmetric G12.
            rows.extend(dict(checkpoint=ordinal, **row) for row in categories
                        if row["kind"] != "strict-tolerance" or (ordinal, row["family"]) not in numeric)
    return ordered(rows)


def bounded_diagnostics(entries):
    """Reserve one tuple per failed entry before allocating remaining slots."""
    if not 1 <= len(entries) <= 256:
        raise ValueError("DIAGNOSTIC_ENTRIES")
    rows = [ordered(e["diagnostics"]) for e in entries]
    for e, ds in zip(entries, rows):
        if bool(ds) != (e["verdict"] == "FAIL") or any(d["checkpoint"] >= e["checks"] for d in ds):
            raise ValueError("DIAGNOSTIC_VERDICT")
    kept = [ds[:1] for ds in rows]
    remaining = 256 - sum(map(len, kept))
    for i, ds in enumerate(rows):
        extra = ds[1:1 + min(7, remaining)]
        kept[i].extend(extra)
        remaining -= len(extra)
    return [dict(diagnostics=keep, diagnostics_truncated=len(keep) != len(all_rows))
            for keep, all_rows in zip(kept, rows)]
