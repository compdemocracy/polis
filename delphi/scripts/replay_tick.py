"""Replay a published math generation from math_recompute_log.

Prints the math_main blob of --tick (or one field of it) as JSON, recomputed
exactly from the inputs the poller logged (PROPENSITY-LOGGING-DESIGN.md §9).
With --through, prints {tick: blob-or-field} for every logged tick in
[--tick, --through]. Reads math_recompute_log and the votes table only
(DATABASE_URL or --database-url); writes nothing.

Run it inside the image that computed the ticks: a tick logged by another
engine_version (or none) is refused, since an engine change can change the
generation; --allow-engine-mismatch replays anyway.

Exit codes: 0 printed; 3 refused (the reason is printed on stderr: a missing,
unrecorded or malformed tick, a reset tick sequence, another engine version,
a failed restore, or a rebuild whose votes changed since, see the digest
refusal in polismath/replay/tick_replay.py); 2 bad arguments or database error.

    uv run python scripts/replay_tick.py --zid 40523 --math-env prod --tick 1200 \\
        --through 1250 --field comment-priorities
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from polismath.database.postgres import PostgresClient, PostgresConfig
from polismath.poller.compute_tick import RestoreFailed
from polismath.replay.tick_replay import ReplayRefused, TickReplayer
from polismath.utils.serialization import convert_numpy_types


def _client(database_url: str, math_env: str, ssl_mode: str | None = None) -> PostgresClient:
    return PostgresClient(PostgresConfig(url=database_url, math_env=math_env,
                                         ssl_mode=ssl_mode))


def _pick(blob, field):
    if field is None:
        return blob
    if field not in blob:
        raise KeyError(field)
    return blob[field]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--zid", type=int, required=True)
    parser.add_argument("--math-env", default=os.environ.get("MATH_ENV", "dev"),
                        help="label the generations were published under (default: "
                             "$MATH_ENV, else dev)")
    parser.add_argument("--tick", type=int, required=True)
    parser.add_argument("--through", type=int, default=None,
                        help="last tick of a range (inclusive)")
    parser.add_argument("--field", default=None,
                        help="print only this top-level blob key, e.g. comment-priorities")
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    parser.add_argument("--ssl-mode", default=None,
                        help="libpq sslmode (default: $DATABASE_SSL_MODE, else require)")
    parser.add_argument("--allow-engine-mismatch", action="store_true",
                        help="replay ticks logged by another (or an unknown) engine_version")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if not args.database_url:
        print("replay_tick: --database-url or DATABASE_URL is required", file=sys.stderr)
        return 2
    if args.through is not None and args.through < args.tick:
        print("replay_tick: --through is before --tick", file=sys.stderr)
        return 2
    pg = _client(args.database_url, args.math_env, args.ssl_mode)
    try:
        rows = pg.read_recompute_log(args.zid, args.math_env)
        replayer = TickReplayer(rows, lambda: pg.poll_votes(args.zid, None), zid=args.zid,
                                allow_engine_mismatch=args.allow_engine_mismatch)
        try:
            if args.through is None:
                blobs = [(args.tick, replayer.blob(args.tick))]
            else:
                blobs = list(replayer.ticks(args.tick, args.through))
        except (ReplayRefused, RestoreFailed, RecursionError, TypeError, ValueError) as exc:
            print(f"replay_tick: refused: {exc.__class__.__name__}: {exc}", file=sys.stderr)
            return 3
        if args.through is None:
            out = _pick(blobs[0][1], args.field)
        else:
            out = {str(t): _pick(b, args.field) for t, b in blobs}
    except KeyError as exc:
        print(f"replay_tick: the blob has no field {exc}", file=sys.stderr)
        return 2
    finally:
        pg.shutdown()
    print(json.dumps(out, default=convert_numpy_types))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
