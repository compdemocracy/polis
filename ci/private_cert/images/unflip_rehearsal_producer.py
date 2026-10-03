"""The un-flip rehearsal's producer: the engine's cold rebuilds, before and after the flip.

The worker runs this container twice (engine-pre, engine-post), between the
reader's phases. It clears its own non-served label (`probe`) on the copy,
asks the pinned engine to recompute the sample of conversations the reader
chose (two certification conversations and a sample ordered by sha256(zid))
from the copy's votes and convention row, publishing math_main under that
label, and records the sha256 of each math_main.data. Rebuild-to-rebuild: the
post rebuild deletes the pre rows first. Only digests leave this container,
for the verifier on the same box.

The engine entry point is the engine image's own one-shot rebuild command,
ENGINE_COMMAND, run with PGSERVICE=probe and MATH_ENV=probe: it must
recompute exactly the listed conversations cold and publish them under the
label it is given, and nothing else.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'probe_box'))
import unflip_rehearsal as u
import unflip_rehearsal_steps as steps

ENGINE_COMMAND = ['/opt/polis-unflip/engine-rebuild']


def command_rebuild(zids, label):
    with tempfile.NamedTemporaryFile('w', dir='/tmp', suffix='.json', delete=False) as f:
        json.dump(sorted(zids), f)
    env = dict(os.environ, PGSERVICE='probe', MATH_ENV=label)
    subprocess.run(ENGINE_COMMAND + ['--label', label, '--zids-file', f.name], env=env, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def produce(phase, state, *, connect, queries, rebuild):
    which = {'engine-pre': 'pre', 'engine-post': 'post'}.get(phase) or u.fail('UNFLIP_PHASE')
    work = copy.deepcopy(state)
    steps.phase_engine(steps.Copy(connect, u.parse_queries(queries)), work, which, rebuild)
    return u.engine_output(work, which)


def main():
    if sys.argv[1:] != ['produce']:
        u.fail('UNFLIP_ACTION')
    import psycopg2
    phase = json.loads(Path('/selection/phase.json').read_bytes())['phase']
    state = u.decode_state(Path('/input/state.json').read_bytes())
    out = produce(phase, state, connect=lambda: psycopg2.connect(service='probe', connect_timeout=10),
                  queries=u.QUERIES_PATH.read_bytes(), rebuild=command_rebuild)
    Path('/output/engine-' + out['which'] + '.json').write_bytes(u.encoded(out))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('UNFLIP_PRODUCER_FAILED') from None
