"""Record a real empty recompute, which makes no priority calls and has no PCA.

Run in the pinned Delphi image:
  python -I make_no_calls.py --delphi /app --commit <sha> --image <digest> --out no-calls.json
This adds a witness without rewriting any existing fixture or generator.
"""
import argparse
import hashlib
import inspect
import json
import platform
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    for name in ('delphi', 'commit', 'image', 'out'):
        ap.add_argument('--' + name, required=True)
    args = ap.parse_args()
    sys.path.insert(0, str(Path(args.delphi).resolve()))
    import numpy
    from polismath.conversation import conversation as cm

    original = cm.priority_metric
    calls = []

    def record(*args):
        result = original(*args)
        calls.append((args, result))
        return result

    cm.priority_metric = record
    try:
        conv = cm.Conversation('empty-fixture', last_updated=1).recompute()
    finally:
        cm.priority_metric = original
    priorities = dict(getattr(conv, 'comment_priorities', {}) or {})
    assert not calls and not priorities and conv.pca is None
    assert conv.rating_mat.size == 0
    header = {
        'rule': 'historical/1',
        'function': 'polismath.conversation.conversation.priority_metric',
        'proves': 'An empty engine recompute has no PCA, priority calls or priorities; this does not describe a nonempty production tick.',
        'source_commit': args.commit,
        'priority_metric_source_sha256': hashlib.sha256(inspect.getsource(original).encode()).hexdigest(),
        'conversation_py_sha256': hashlib.sha256(Path(cm.__file__).read_bytes()).hexdigest(),
        'image': args.image,
        'python': sys.version,
        'numpy': numpy.__version__,
        'platform': platform.platform(),
        'machine': platform.machine(),
        'libc': ' '.join(platform.libc_ver()),
        'generator_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'invocation': list(getattr(sys, 'orig_argv', sys.argv)),
        'engine_settings': 'Conversation defaults; empty recompute returns before PCA and clustering; no random draws or seed required',
    }
    tick = {'tick': 1, 'rows': 0, 'columns': 0, 'previous_groups': 0,
            'current_groups': 0, 'calls': 0, 'cells': [],
            'no_priority_calls': True, 'pca': None, 'priorities': priorities}
    Path(args.out).write_text(json.dumps({'header': header, 'ticks': [tick]},
                                       allow_nan=False, separators=(',', ':')) + '\n')
    print('empty recompute: 1 tick, 0 calls, 0 priorities, no PCA')


if __name__ == '__main__':
    main()
