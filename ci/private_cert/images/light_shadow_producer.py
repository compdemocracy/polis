"""Classify the reader's snapshot; no database driver, connection or export."""
from __future__ import annotations
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from light_shadow_compare import classify_projection
from light_shadow import decode, encoded, fail, validate_projection, validate_run_spec


def produce(projection, spec):
    validate_projection(projection, validate_run_spec(spec))
    return classify_projection(projection)


def main():
    if sys.argv[1:] != ['produce']:
        fail('SHADOW_ACTION')
    # The producer never sees /job; the run-spec reaches it through the
    # supervisor's selection context, as it reached the reader.
    context = json.loads(Path('/selection/context.json').read_bytes())
    projection = decode(Path('/input/projection.json').read_bytes())
    Path('/output/evidence.json').write_bytes(encoded(produce(projection, context['run_spec'])))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('SHADOW_PRODUCER_FAILED') from None
