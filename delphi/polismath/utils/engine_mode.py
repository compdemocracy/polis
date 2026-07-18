"""
Engine-mode switch: Clojure-parity warm-start vs improved cold-recompute.

Python's delphi engine does a full COLD recompute on every conv-update tick.
Clojure instead THREADS warm-start state across ticks:

  - PCA :start-vectors — the previous tick's post-normalization unit
    components are fed back in as the power-iteration starting vectors
    (math/src/polismath/math/conversation.clj:381-387 -> pca.clj:86-105).
  - group-k-smoother — {:last-k :last-k-count :smoothed-k} state carried in
    the conv, so the group count K only changes after `:group-k-buffer` (4)
    consecutive ticks agree on a new K (conversation.clj:454-478).

`POLISMATH_ENGINE_MODE` selects between the two families:

  - 'improved'       (default): today's cold-recompute behavior, byte-for-byte.
  - 'clojure-legacy'         : threads the warm-start state described above.

The flag is resolved AT CALL TIME (never cached at import) by the shared
`utils.env_flags.resolve_impl_flag`: unknown values fall back to the default
with a warning so a typo in a deployment env cannot crash the math worker.
This lives in a shared spot (polismath.utils) because the mode cross-cuts both
PCA (conversation._compute_pca) and clustering (conversation._compute_clusters).
"""

from typing import Sequence

from polismath.utils.env_flags import resolve_impl_flag

ENGINE_MODE_ENV_VAR = 'POLISMATH_ENGINE_MODE'
ENGINE_MODE_LEGACY = 'clojure-legacy'   # warm-start parity with Clojure
ENGINE_MODE_IMPROVED = 'improved'       # cold recompute every tick (default)
ENGINE_MODE_DEFAULT = ENGINE_MODE_IMPROVED
ENGINE_MODE_CHOICES: Sequence[str] = (ENGINE_MODE_LEGACY, ENGINE_MODE_IMPROVED)


def resolve_engine_mode() -> str:
    """
    Resolve `POLISMATH_ENGINE_MODE` from the environment, at call time.

    Reuses `utils.env_flags.resolve_impl_flag` so the resolution rules
    (strip + lowercase, unknown -> default with a warning) are identical to
    the PCA-solver switch.

    Returns:
        Either 'improved' (default) or 'clojure-legacy'.
    """
    return resolve_impl_flag(
        ENGINE_MODE_ENV_VAR, ENGINE_MODE_DEFAULT, ENGINE_MODE_CHOICES)
