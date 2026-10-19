#!/usr/bin/env python3
"""Seeded generated CLI sequences against Node and the Rust switches.

One disposable stack (the CLI differential's), three phases of the same
generated step list: A with every route on Node, B with every merged Rust
route switched on, and A2 (A prime) on Node again. A2 is the A/A control: a
difference between A and A2 is harness or Node nondeterminism, reported under
its own verdict and exit code, never as Rust evidence. A difference between A
and B where A2 equals A is attributed to the switch.

Each step runs the real CLI binary (a fixture-ids build) as one actor with
its own POLIS_CONFIG_DIR, after /begin with a seed derived from the run seed,
and drains asynchronous effects before the next step. Steps are compared as
the fixed-scenario loop compares them: the parsed --json envelope and the exit
code, object key order ignored. At the end of each phase every public table is
digested. Reports name commands, generated inputs and differing paths, never
response values or credentials. A failure prints the seed and the step list;
the same seed and step count regenerate the same list.

known-differences.json holds the polis-api README's known differences (each
counted, with a bound) and the harness residuals: Node or Postgres
nondeterminism the fixture does not fix, reported by name and never counted as
a switch difference. Exit: 0 equal; 1 a difference attributed to the switch
(or a failed Rust-only contract, or a database difference outside the
residuals); 2 A/A noise only; 4 known differences over their bound; 3 harness
error or failed cleanup.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT / 'polis-cli/tests/differential'))
from harness import (Cli, Stack, differences, load_routes, route_lines, routing_counts,  # noqa: E402
                     run_phases, rust_only_checks)
import generator  # noqa: E402

DEFAULT_STEPS = 40
CLOCK_STRIDE_MS = 10_000  # Above both engines' 3 s math-cache TTL.


def step_clock(seed, index, mode='stepped'):
    # Generated starting rows are at 1700000000000. The seed-specific base is
    # strictly later; every phase uses the same sequence. No wall-clock input.
    base = 1_700_000_010_000 + int(generator.normalize_seed(seed), 16) % 86_400_000
    return base + (index * CLOCK_STRIDE_MS if mode == 'stepped' else 0)

REPLAY = 'bash scripts/test-polis-cli-fuzz.sh --binary BINARY --output OUTPUT --seed {seed} --steps {steps} --clock-mode {clock}'


def login_code(cli, actor, conversation):
    """The returning-invite path: the login code the CLI saved for `actor`."""
    store = cli.workspace / actor / 'credentials'
    if not conversation or not store.is_dir():
        return None
    for path in sorted(store.glob('*.json')):
        try:
            record = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if record.get('origin', '').endswith('#participant=' + conversation) and record.get('participant_login'):
            return record['participant_login']
    return None


def resolve(args, state, cli):
    out = []
    for a in args:
        if a.startswith('@conv:'):
            out.append(state['conv'].get(a[6:], generator.MISSING_CONVERSATION))
        elif a.startswith('@invite:'):
            codes = state['invites'].get(a[8:], [])
            out.append(codes.pop(0) if codes else generator.MISSING_INVITE)
        elif a.startswith('@login:'):
            _, holder, ref = a.split(':')
            out.append(login_code(cli, holder, state['conv'].get(ref)) or generator.MISSING_LOGIN)
        else:
            out.append(a)
    return out


def learn(step, value, state):
    data = value['json'].get('data') if isinstance(value['json'], dict) else None
    if not isinstance(data, dict):
        return
    if step.get('creates') and isinstance(data.get('conversation_id'), str):
        state['conv'][step['creates']] = data['conversation_id']
    if step.get('harvests') and isinstance(data.get('invites'), list):
        state['invites'][step['harvests']] = [i['code'] for i in data['invites']
                                              if isinstance(i, dict) and i.get('status') == 'unused' and isinstance(i.get('code'), str)]


def classify(lines, routes):
    """Per switched route: requests, sole-Rust answers (any status), Rust 200s
    and handoffs to Node, from the test nginx log format."""
    out = {}
    for route, contract in routes.items():
        matched = route_lines('\n'.join(lines), contract)
        if not matched:
            continue
        sole = [ln for ln in matched if len(ln.split()) == 4 and ln.split()[2].endswith(':5100')]
        out[route] = {'requests': len(matched), 'rust_answered': len(sole),
                      'rust_200': sum(ln.split()[3] == '200' for ln in sole),
                      'handoffs': sum(':5100' in ln for ln in matched) - len(sole)}
    return out


def known(step, paths, registry):
    """The registry entry whose CLI predicate covers every differing path, if any."""
    for entry in registry['entries']:
        match = entry.get('cli_match')
        if match and match['command'] == step['command'] and all(re.fullmatch(match['paths_regex'], p) for p in paths):
            return entry['id']
    return None


def residual_split(step, paths, registry):
    """Split differing paths into those a harness residual covers and the rest."""
    covered, rest = {}, []
    for path in paths:
        for entry in registry['harness_residuals']:
            match = entry.get('cli_match')
            if match and match['command'] == step['command'] and re.fullmatch(match['paths_regex'], path):
                covered[entry['id']] = covered.get(entry['id'], 0) + 1
                break
        else:
            rest.append(path)
    return rest, covered


def digest_differences(left, right):
    names = []
    for table in sorted(left.keys() | right.keys()):
        a, b = left.get(table), right.get(table)
        if a == b:
            continue
        if a is None or b is None or a['rows'] != b['rows']:
            names.append(table)
            continue
        names += [table + '.' + c for c in sorted(a['columns'].keys() | b['columns'].keys())
                  if a['columns'].get(c) != b['columns'].get(c)] or [table]
    return names


def identity(stack):
    def out(argv):
        try:
            r = subprocess.run(argv, capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            return None
        return r.stdout.strip() if r.returncode == 0 else None
    images = {name: out(['docker', 'image', 'inspect', '--format', '{{.Id}}', stack.env[name]])
              for name in ['CLI_DIFF_NODE_IMAGE', 'CLI_DIFF_POSTGRES_IMAGE', 'CLI_DIFF_OIDC_IMAGE', 'CLI_DIFF_RUST_IMAGE']}
    return {'source_head': out(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']),
            'source_modified': bool(out(['git', '-C', str(ROOT), 'status', '--porcelain', '--untracked-files=no'])),
            'images': images}


def error_code(value):
    return (value['json'].get('error') or {}).get('code') if isinstance(value['json'], dict) else None


def describe(step):
    return f"{step['index']:>3} {step['actor']:<9} {' '.join(step['args'])}"


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--binary', help='fixture-ids build of the CLI')
    p.add_argument('--output', help='report JSON path')
    p.add_argument('--seed', help='64-bit hex run seed (default: a fresh one, printed)')
    p.add_argument('--steps', type=int, default=DEFAULT_STEPS, help=f'generated steps per phase (default {DEFAULT_STEPS})')
    p.add_argument('--clock-mode', choices=['stepped', 'within-window'], default='stepped',
                   help='expire caches between steps, or deliberately report within-window differences')
    p.add_argument('--print-steps', action='store_true', help='print the generated setups and steps, run nothing')
    args = p.parse_args()
    seed = generator.normalize_seed(args.seed if args.seed else os.urandom(8).hex())
    setups, steps = generator.generate(seed, args.steps)
    if args.print_steps:
        print(generator.dump(setups, steps))
        return 0
    if not args.binary or not args.output:
        p.error('--binary and --output are required to run')
    binary = str(Path(args.binary).resolve()); output = Path(args.output).resolve()
    print(f'fuzz seed={seed} steps={len(steps)} generator={generator.GENERATOR}', file=sys.stderr, flush=True)
    registry = json.loads((HERE / 'known-differences.json').read_text())
    routes = load_routes()
    stack = Stack()
    switch = ','.join(sorted(routes))
    plan = [('A', ''), ('B', switch), ('A2', '')]
    report = {'schema': 'polis-cli-fuzz/1', 'generator': generator.GENERATOR, 'seed': seed,
              'steps_requested': args.steps, 'start': 'generated', 'phases': [n for n, _ in plan],
              'switches': sorted(routes),
              'clock': {'mode': args.clock_mode, 'base_ms': step_clock(seed, 0, args.clock_mode),
                        'stride_ms': CLOCK_STRIDE_MS if args.clock_mode == 'stepped' else 0},
              'comparison': 'CLI --json envelope and exit code per step (object key order ignored); end-of-phase per-table database digests',
              'byte_capture': False, 'identity': identity(stack), 'complete': False}
    started = time.monotonic()
    captured, rust, digests = {}, [], {}
    try:
        stack.up()
        digest_source = (HERE / 'digest.cjs').read_text()
        with tempfile.TemporaryDirectory(prefix='polis-cli-fuzz-') as directory:
            workspace = Path(directory)
            cli = Cli(binary, stack, workspace)
            for phase in run_phases(stack, cli, plan):
                for ref, setup in setups.items():
                    (workspace / f'setup-{ref}.json').write_text(json.dumps(setup, ensure_ascii=False))
                state = {'conv': {'c0': generator.FIXTURE_CONVERSATION}, 'invites': {}}
                values, per_step, seen = [], [], 0
                phase_start = time.monotonic()
                for step in steps:
                    i = step['index']
                    resolved = resolve(step['args'], state, cli)
                    stack.begin(generator.step_seed(seed, i), 'fuzz' + str(i),
                                clock=step_clock(seed, i, args.clock_mode))
                    value = cli.invoke({'command': step['command'], 'args': resolved, 'actor': step['actor']},
                                       fixture_uuid=generator.step_uuid(seed, i))
                    print(f"{phase} {i} {step['command']} exit={value['exit']}", file=sys.stderr, flush=True)
                    stack.barrier(step['command'])
                    # Placeholder values are compared by digest; the report never holds them.
                    value['resolved'] = hashlib.sha256(json.dumps(resolved).encode()).hexdigest()
                    value['artifacts'] = {}
                    learn(step, value, state)
                    values.append(value)
                    if phase == 'B':
                        lines = stack.nginx_log().splitlines()
                        per_step.append(classify(lines[seen:], routes)); seen = len(lines)
                captured[phase] = values
                report[phase + '_seconds'] = round(time.monotonic() - phase_start, 3)
                log = stack.nginx_log()
                report[phase + '_routing'] = {route: routing_counts(route_lines(log, c)) for route, c in routes.items()}
                if phase != 'B':
                    if any(':5100' in ' '.join(ln.split()[2:]) for ln in log.splitlines()):
                        raise RuntimeError('off switch still reached Rust in phase ' + phase)
                else:
                    rust = per_step
                r = stack.dc('exec', '-T', 'server', 'node', '-', input=digest_source, check=False)
                if r.returncode:
                    print(r.stderr, file=sys.stderr)
                    raise RuntimeError('database digest failed')
                digests[phase] = json.loads(r.stdout)
        rows, counts, residual_counts = [], {}, {}
        first = first_harness = None
        for step, a, b, c, served in zip(steps, captured['A'], captured['B'], captured['A2'], rust):
            aa = differences(a, c)
            aa_rest, aa_res = residual_split(step, aa, registry)
            if step.get('contract'):
                checks = rust_only_checks(step, a, b)
                ab = [k for k, ok in checks.items() if not ok]
                ab_rest, ab_res = ab, {}
                verdict = 'harness' if aa_rest else ('rust-only' if not ab else 'rust-only-failed')
            else:
                ab = differences(a, b)
                ab_rest, ab_res = residual_split(step, ab, registry)
                match = known(step, ab_rest, registry) if ab_rest else None
                verdict = ('harness' if aa_rest else 'differ' if ab_rest and not match else 'known' if match
                           else 'residual' if ab_res or aa_res else 'equal')
                if match and not aa_rest:
                    counts[match] = counts.get(match, 0) + 1
            for rid in set(aa_res) | set(ab_res):
                residual_counts.setdefault(rid, {'A/A2': 0, 'A/B': 0})
                residual_counts[rid]['A/A2'] += bool(aa_res.get(rid))
                residual_counts[rid]['A/B'] += bool(ab_res.get(rid))
            if verdict in ('differ', 'rust-only-failed') and first is None:
                first = step['index']
            if verdict == 'harness' and first_harness is None:
                first_harness = step['index']
            rows.append({'index': step['index'], 'kind': step['kind'], 'actor': step['actor'],
                         'command': step['command'], 'args': step['args'],
                         **{k: step[k] for k in ('entry', 'conversation', 'contract', 'text_class') if k in step},
                         'verdict': verdict, 'ab_paths': ab, 'aa_paths': aa,
                         'residuals': sorted(set(aa_res) | set(ab_res)),
                         'exits': {'A': a['exit'], 'B': b['exit'], 'A2': c['exit']},
                         'errors': {'A': error_code(a), 'B': error_code(b), 'A2': error_code(c)},
                         'rust': served})
        over = [e['id'] for e in registry['entries'] if counts.get(e['id'], 0) > e['bound']]
        residual = {col: r['id'] for r in registry['harness_residuals'] for col in r['database_columns']}
        aa_all = digest_differences(digests['A'], digests['A2'])
        ab_all = digest_differences(digests['A'], digests['B'])
        db_aa = [t for t in aa_all if t not in residual]
        db_ab = [t for t in ab_all if t not in residual and t not in aa_all]
        db_residual = {t: {'residual': residual[t], 'A/A2': t in aa_all, 'A/B': t in ab_all}
                       for t in sorted(residual) if t in aa_all or t in ab_all}
        answered = [r for r in rows if any(v['rust_answered'] for v in r['rust'].values())]
        per_route = {}
        for r in rows:
            for route, v in r['rust'].items():
                acc = per_route.setdefault(route, {'requests': 0, 'rust_answered': 0, 'rust_200': 0, 'handoffs': 0})
                for k in acc:
                    acc[k] += v[k]
        verdicts = {}
        for r in rows:
            verdicts[r['verdict']] = verdicts.get(r['verdict'], 0) + 1
        report['setups'] = setups
        report['steps'] = rows
        report['summary'] = {
            'steps': len(rows), 'verdicts': verdicts,
            'known_differences': {e['id']: {'count': counts.get(e['id'], 0), 'bound': e['bound']} for e in registry['entries']},
            'known_over_bound': over,
            'harness_residual_steps': residual_counts,
            'first_differing_step': first, 'first_harness_step': first_harness,
            'database_tables': len(digests['A']), 'database_ab': db_ab, 'database_aa': db_aa,
            'database_residuals': db_residual,
            'rust_answered_steps': len(answered), 'rust_answered_requests': sum(v['rust_answered'] for v in per_route.values()),
            'rust_by_route': per_route,
            'rust_answered_commands': sorted({r['command'] for r in answered}),
        }
        report['complete'] = True
    except subprocess.TimeoutExpired:
        report['harness_error'] = 'local operation exceeded its deadline; arguments withheld'
    except Exception as error:
        report['harness_error'] = str(error)
    finally:
        report['cleanup_passed'] = stack.down()
        report['elapsed_seconds'] = round(time.monotonic() - started, 3)
        s = report.get('summary') or {}
        attributed = bool(s.get('first_differing_step') is not None or s.get('database_ab'))
        noise = bool(s.get('first_harness_step') is not None or s.get('database_aa'))
        report['verdict'] = ('error' if not report['complete'] or not report['cleanup_passed']
                             else 'differ' if attributed else 'known' if s.get('known_over_bound')
                             else 'harness' if noise else 'equal')
        if report['verdict'] != 'equal':
            report['failure'] = {'schema': 'polis-cli-fuzz-failure/1', 'seed': seed, 'generator': generator.GENERATOR,
                                 'steps_requested': args.steps, 'verdict': report['verdict'],
                                 'first_differing_step': s.get('first_differing_step'),
                                 'first_harness_step': s.get('first_harness_step'),
                                 'known_over_bound': s.get('known_over_bound'),
                                 'known_steps': [r['index'] for r in report.get('steps', []) if r['verdict'] == 'known'],
                                 'database_ab': s.get('database_ab'), 'database_aa': s.get('database_aa'),
                                 'replay': REPLAY.format(seed=seed, steps=args.steps, clock=args.clock_mode),
                                 'steps': [describe(x) for x in steps]}
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    if report['verdict'] != 'equal':
        f = report['failure']
        print(f"\nFUZZ {report['verdict'].upper()} seed={seed} steps={args.steps}", file=sys.stderr)
        for key in ('first_differing_step', 'first_harness_step'):
            if f.get(key) is not None:
                row = report['steps'][f[key]]
                print(f"{key}: {describe(steps[f[key]])}\n  verdict={row['verdict']} A/B paths={row['ab_paths']} A/A2 paths={row['aa_paths']}", file=sys.stderr)
        if f.get('known_over_bound'):
            print(f"known differences over their bound: {f['known_over_bound']} at steps {f['known_steps']}", file=sys.stderr)
        if f.get('database_ab') or f.get('database_aa'):
            print(f"database A/B: {f.get('database_ab')}  A/A2: {f.get('database_aa')}", file=sys.stderr)
        if report.get('harness_error'):
            print('harness error: ' + report['harness_error'], file=sys.stderr)
        print('steps:\n' + '\n'.join(f['steps']), file=sys.stderr)
        print('replay: ' + f['replay'], file=sys.stderr)
    print(json.dumps({k: v for k, v in report.items() if k not in ('steps', 'setups', 'failure')}, indent=2, ensure_ascii=False))
    return {'equal': 0, 'differ': 1, 'harness': 2, 'known': 4}.get(report['verdict'], 3)


if __name__ == '__main__':
    sys.exit(main())
