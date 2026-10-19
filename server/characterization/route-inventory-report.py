#!/usr/bin/env python3
"""Render a proposed inventory diff; historical route counts are not assertions."""
import argparse
import json
from pathlib import Path


def render(diff):
    lines = ['Route inventory changes', '']
    for field in ('added', 'retired', 'reactivated'):
        lines.append(f"{field}: " + (', '.join(map(str, diff[field])) or 'none'))
    lines.append(f"retained registration order changed: {diff['reordered']}")
    lines.append('')
    for r in diff['changed']:
        lines.append(f"r{r['id']} {r['method']} {r['path']}: " + ', '.join(r['fields']))
    lines += ['', 'Historical ID migration:']
    lines += [f"r{r['id']} {r['method']} {r['path']} {r['discriminator']}: {r['status']}" for r in diff['migration']]
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('diff', type=Path)
    args = parser.parse_args()
    print(render(json.loads(args.diff.read_text())), end='')
