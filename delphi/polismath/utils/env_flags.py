"""
Shared resolver for legacy-vs-improved implementation switches.

Pattern for env-var implementation switches (POLISMATH_PCA_IMPL, and
future ones like a k-means solver switch): a
module-level env var name + default + allowed values, resolved by
`resolve_impl_flag` AT CALL TIME (never at import time), so tests and
operators can flip the env var without re-importing. Unknown values fall back
to the default with a warning (defensive: a typo in a deployment env must not
crash the math worker).

This lives in polismath.utils (not pca.py, where it originated) so that
lightweight consumers do not drag in the numpy/pandas pca import chain, and
resolution warnings are logged under this module's logger rather than pca's.
"""

import logging
import os
from typing import Sequence

logger = logging.getLogger(__name__)


def resolve_impl_flag(env_var: str, default: str, choices: Sequence[str]) -> str:
    """
    Resolve a legacy-vs-improved implementation switch from the environment.

    Args:
        env_var: Environment variable name to read (at call time).
        default: Value to use when the variable is unset or invalid.
        choices: Allowed values (lowercase).

    Returns:
        One of `choices`.
    """
    raw = os.environ.get(env_var)
    if raw is None:
        return default
    value = raw.strip().lower()
    if value not in choices:
        logger.warning("%s=%r is not one of %s; falling back to %r",
                       env_var, raw, tuple(choices), default)
        return default
    return value
