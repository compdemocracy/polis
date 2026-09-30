"""Package the reader's counts as evidence; no database driver, connection or export."""
from __future__ import annotations
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'probe_box'))
from backfill_verify import assess, decode, encoded, fail


def produce(projection, spec):
    return assess(projection, spec)


def main():
    if sys.argv[1:] != ['produce']:
        fail('VERIFY_ACTION')
    # The producer never sees /job; the run-spec reaches it through the
    # supervisor's selection context, as it reached the reader.
    context = json.loads(Path('/selection/context.json').read_bytes())
    projection = decode(Path('/input/projection.json').read_bytes())
    Path('/output/evidence.json').write_bytes(encoded(produce(projection, context['run_spec'])))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('VERIFY_PRODUCER_FAILED') from None
