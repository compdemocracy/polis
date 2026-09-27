"""Light-shadow triage selection for the paired battery (box-local).

When a battery job carries `triage_selection` (polis-light-shadow-triage/1),
its reader recomputes the light-shadow classification on its own read-only
snapshot, with the same fixed queries and the same comparison as the daily
compare job, selects the conversations that are NEAR-TIE-CANDIDATE,
HISTORY-DIVERGENCE or FAIL, and extracts them as `triage-NNN` roles for the
standard certified paired replay. Conversation ids stay on this box: the
manifest block and the receipt carry only the counts-only triage report.
"""
from __future__ import annotations
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / 'probe_box'))
from light_shadow import (MS_CEILING, PROD, SIZE_FIELDS, TRIAGE_CAP, TRIAGE_REPORT_SCHEMA, TRIAGE_SELECTED,
                          fail, triage_digest, triage_order, validate_triage_report)
from light_shadow_queries import LIMITS, QUERIES

CANDIDATES = ('NEAR-TIE-CANDIDATE', 'HISTORY-DIVERGENCE')


def fetch(cur, name, params):
    cur.execute(QUERIES[name], params)
    rows = cur.fetchmany(LIMITS[name] + 1)
    if len(rows) > LIMITS[name]:
        fail('TRIAGE_LIMIT')
    return rows


def classify_active(conn, spec, declared=None):
    """Evidence for every conversation either label wrote since the compare window began.

    Runs inside the caller's read-only repeatable-read transaction.
    Returns (evidence rows with zid, {zid: shadow blob}).
    """
    from light_shadow_compare import classify, empty_output
    declared = empty_output() if declared is None else declared
    params = {'prod': PROD, 'shadow': spec['shadow_env'], 'start': spec['window']['start_ms'], 'end': MS_CEILING}
    with conn.cursor() as cur:
        active = [z for z, in fetch(cur, 'active', params)]
        rows = {z: {'prod': None, 'shadow': None} for z in active}
        for zid, env, data in fetch(cur, 'rows', params):
            rows[zid]['prod' if env == PROD else 'shadow'] = data
    evidence = [classify(z, rows[z]['prod'], rows[z]['shadow'], declared) for z in active]
    return evidence, {z: rows[z]['shadow'] for z in active}


def select(evidence, shadows, spec, sizes_by_zid):
    """(chosen zids in selection order, counts-only report)."""
    candidates = [[e['zid'], shadows[e['zid']].get('lastVoteTimestamp'), shadows[e['zid']].get('lastModTimestamp')]
                  for e in evidence if e['outcome'] in CANDIDATES]
    flagged = sorted((e for e in evidence if e['outcome'] in TRIAGE_SELECTED), key=triage_order)
    if not flagged:
        fail('TRIAGE_EMPTY')
    chosen = [e['zid'] for e in flagged[:TRIAGE_CAP]]
    if any(z not in sizes_by_zid for z in chosen):
        fail('TRIAGE_METRICS')
    battery = triage_digest(candidates)
    report = {'schema': TRIAGE_REPORT_SCHEMA, 'source_triage_sha256': spec['triage_sha256'],
              'battery_triage_sha256': battery,
              'match': 'MATCH' if battery == spec['triage_sha256'] else 'CHANGED',
              'compare_count': spec['conversations'], 'battery_count': len(candidates),
              'flagged': len(flagged), 'selected': len(chosen), 'truncated': len(flagged) - len(chosen),
              'cap': TRIAGE_CAP,
              'chosen_entry_sizes': sorted(({k: sizes_by_zid[z][k] for k in SIZE_FIELDS} for z in chosen),
                                           key=lambda r: tuple(r[k] for k in SIZE_FIELDS))}
    return chosen, validate_triage_report(report, spec)


def extract(conn, *, config, spec, payload_root, guard_root):
    """Select and extract the triage roles in ONE read-only repeatable-read transaction."""
    from polismath.replay import fixture_config as fcfg, fixture_extract as fx, fixture_samples as samples
    from polismath.replay import fixture_survey as fs
    guarantee = fs.open_readonly_repeatable_read(conn)
    evidence, shadows = classify_active(conn, spec)
    metrics = {row['zid']: row for row in fs.fetch_metrics(conn)}
    chosen, report = select(evidence, shadows, spec, metrics)
    served_math = fcfg.served_math_options(config)
    tie_key = fx.detect_tie_key(conn)
    roles, provenance = [], []
    for ordinal, zid in enumerate(chosen, 1):
        name = samples.triage_slug(ordinal)
        summary = fx.extract_conversation(
            conn, zid=zid, slug=name, role=name, payload_root=payload_root, guard_root=guard_root,
            dir_name=fx.mint_opaque_dir(name), tie_key=tie_key, measured=metrics[zid],
            capture_served_math=served_math.capture, served_math_envs=served_math.math_envs)
        summary.update(group='triage', rank=None, source='production')
        roles.append(summary)
        provenance.append(dict(role=name, slug=name, dir=summary['dir'], zid=zid))
    return {'roles': roles, 'report': report, 'provenance_rows': provenance,
            'transaction_guarantee': guarantee, 'tie_key': tie_key}
