"""Bind selection to supervisor input and the independently shipped config."""
import copy
import json
import re
from pathlib import Path
from polismath.replay import fixture_config

PROBE_CONFIG_PATH = Path(__file__).resolve().parents[3] / "delphi/scripts/certify_datasets.probe.json"


def resolve(config, context):
    if (type(context) is not dict or set(context) - {"representative_selection"} != {"run_id"}
            or type(context["run_id"]) is not str or re.fullmatch(r"[a-f0-9]{32}", context["run_id"]) is None):
        raise ValueError("SELECTION_CONTEXT")
    result = copy.deepcopy(config)
    if "representative_selection" in context:
        override = context["representative_selection"]
        if (type(override) is not dict or set(override) != {"seed_source", "seed"}
                or override["seed_source"] != "config" or "representative_selection" not in result):
            raise ValueError("SELECTION_CONTEXT")
        result["representative_selection"] = {
            k: v for k, v in result["representative_selection"].items() if k not in ("seed_source", "seed")}
        result["representative_selection"].update(override)
    fixture_config.validate_config(result)
    source = fixture_config.representative_seed_source(result)
    seed = fixture_config.representative_seed(result, run_id=context["run_id"])
    if source is not None:
        # Existing extraction/manifest APIs consume a frozen config. Both
        # images independently verify these exact resolved config bytes.
        result["representative_selection"].update(seed_source="config", seed=seed)
    return result, source


def from_job(job):
    return {k: job[k] for k in ("run_id", "representative_selection") if k in job}


def admit(config, context):
    expected, source = resolve(json.loads(PROBE_CONFIG_PATH.read_bytes()), context)
    if config != expected:
        raise ValueError("SELECTION_CONFIG_BINDING")
    return source
