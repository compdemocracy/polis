"""
OFFLINE=1 (or true) means the box has no network. For the embedding model
that means the Hugging Face libraries must never reach the hub: the model is
baked into the image (Dockerfile, BAKE_EMBEDDING_MODEL=true) or already in the
cache.

huggingface_hub and transformers read HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE
once, when they are imported. So the flags are set in the environment of the
processes that spawn the pipeline (the job poller and run_delphi.py), before
any child imports them; the embedding engine also loads with
local_files_only, which holds whatever the import order.

Unset or any other value: nothing is changed.
"""

import os
from typing import MutableMapping, Optional

HF_OFFLINE_FLAGS = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}


def is_offline(env: Optional[MutableMapping[str, str]] = None) -> bool:
    """True when OFFLINE is 1 or true (the values the image CMD accepts)."""
    value = (os.environ if env is None else env).get("OFFLINE", "")
    return value.strip().lower() in ("1", "true")


def apply_offline_env(env: Optional[MutableMapping[str, str]] = None) -> bool:
    """With OFFLINE set, set the Hugging Face offline flags in `env`
    (os.environ by default). Returns whether it did."""
    target = os.environ if env is None else env
    if not is_offline(target):
        return False
    target.update(HF_OFFLINE_FLAGS)
    return True
