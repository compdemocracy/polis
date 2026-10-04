"""The un-flip rehearsal's verifier: the only container that writes the receipt.

It holds no database driver and no connection. It merges the producer's two
engine outputs into the reader's box-local state, recomputes every assertion
and the verdict from the recordings (pre against post, per case), and writes
the closed receipt (polis-unflip-rehearsal-receipt/1): counts, durations,
digests and fixed names only. The worker validates it again with the closed
decoder before it leaves the box.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'probe_box'))
import unflip_rehearsal as u


def verify(state, engine_docs, job):
    for doc in engine_docs:
        u.merge_engine(state, doc)
    return u.build_receipt(state, job)


def main():
    if sys.argv[1:] != ['verify']:
        u.fail('UNFLIP_ACTION')
    job = json.loads(Path('/job/job.json').read_bytes())
    state = u.decode_state(Path('/input/state.json').read_bytes())
    docs = [json.loads(p.read_bytes()) for p in (Path('/evidence/engine-pre.json'), Path('/evidence/engine-post.json'))
            if p.is_file()]
    Path('/verdict/receipt.json').write_bytes(u.encoded(verify(state, docs, job)))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('UNFLIP_VERIFIER_FAILED') from None
