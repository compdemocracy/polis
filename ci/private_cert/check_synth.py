#!/usr/bin/env python3
"""Compare full synth templates; do not normalize away any resource fields."""
import argparse
import hashlib
import json
from pathlib import Path


def compare(base, off):
    a, b = json.loads(base.read_bytes()), json.loads(off.read_bytes())
    changed = sorted(k for k in a['Resources'].keys() | b['Resources'].keys() if a['Resources'].get(k) != b['Resources'].get(k))
    receipt = {'baseResources': len(a['Resources']), 'offResources': len(b['Resources']), 'changedResources': changed,
               'wholeTemplateEqual': a == b, 'baseSha256': hashlib.sha256(base.read_bytes()).hexdigest(),
               'offSha256': hashlib.sha256(off.read_bytes()).hexdigest()}
    if changed or a != b:
        raise ValueError('Default-off changed the existing template')
    return receipt


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('base', type=Path); p.add_argument('off', type=Path)
    args = p.parse_args()
    print(json.dumps(compare(args.base, args.off), indent=2))
