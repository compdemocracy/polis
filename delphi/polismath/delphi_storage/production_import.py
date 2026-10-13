"""One-shot source census and detached import. Never publishes a result.

Source rows stay in private scratch. SQLite bounds the census memory and sorts
codec keys without converting numbers to floats. The ordinary daemon owns all
queue fences, child exits, result staging and artifact finalization.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
import time
import uuid

from . import codec, legacy_import as legacy, scan_pacing
from .embedding_spool import MAX_DIMS, MAX_SPOOL_BYTES, write_spool

SNAPSHOTS = Path('/import/snapshots')
FAMILY_LIMIT = 64 * 1024 * 1024
BATCH_LIMIT = 256 * 1024 * 1024
MANIFEST_LIMIT = 128 * 1024
FOLLOW_UP = 'follow-up.json'

# The one comment-embeddings family, and the single model migration 000038 seeds
# (model_id 1, 384 dims). The legacy bare name normalizes to the seeded name, so
# both legacy spellings land on the same model; any other string refuses, because
# nothing has admitted it. Kept in step with queue-rs embedding::MODEL_MINILM and
# the migration's seed row.
EMBEDDINGS_FAMILY = 'Delphi_CommentEmbeddings'
SEEDED_EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
EMBEDDING_MODEL_ALIASES = {
    'all-MiniLM-L6-v2': SEEDED_EMBEDDING_MODEL,
    SEEDED_EMBEDDING_MODEL: SEEDED_EMBEDDING_MODEL,
}
# The spool file written beside a conversation's family files, read by the
# detached child and routed by the daemon into pd_embedding_put/close.
EMBEDDING_SPOOL_FILE = 'embeddings.spool'


def embeddings_table_enabled():
    """The one switch, default off. Only the exact string "1" turns it on, so one
    value moves the importer, the daemon (DELPHI_EMBEDDINGS_TABLE in queue-rs) and
    Delphi's Python together. Off is today's codec-family path, unchanged."""
    return os.environ.get('DELPHI_EMBEDDINGS_TABLE') == '1'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _float32_exact(text):
    """(float32 value as a Python float, exact) for one canonical decimal string.

    float32 exact means float(numpy.float32(float(s))) == float(s): the legacy
    MiniLM path printed float32 vectors, so every value must survive narrowing to
    float32 and back with no change. Done with stdlib struct (no numpy), which
    narrows to the same IEEE-754 float32 the table stores."""
    value = float(text)
    try:
        narrowed = struct.unpack('<f', struct.pack('<f', value))[0]
    except (OverflowError, struct.error):
        return None, False
    return narrowed, narrowed == value


def _array_send_real(vector):
    """Reproduce Postgres array_send(real[]) over a one-dimensional float4 array:
    big-endian ndim, has_null, element Oid 700, dim length, lower bound, then each
    element as (length 4, big-endian float32). The set content digest hashes these
    exact bytes, so the importer can recompute what pd_embedding_close stored."""
    out = bytearray()
    out += struct.pack('>iiIii', 1, 0, 700, len(vector), 1)
    for v in vector:
        out += struct.pack('>if', 4, v)
    return bytes(out)


def embedding_content_sha(rows):
    """Reproduce delphi_embedding_sets.content_sha: SHA-256 over one line per row
    in tid order, tid:hex(text_sha):hex(sha256(array_send(embedding))), joined by
    newlines. `rows` is (tid, text_sha bytes, float32 vector), already tid-sorted."""
    lines = ['%d:%s:%s' % (tid, text_sha.hex(), sha(_array_send_real(vector)))
             for tid, text_sha, vector in rows]
    return hashlib.sha256('\n'.join(lines).encode('utf-8')).hexdigest()


def embedding_model_counts(database):
    """{raw model string -> imported-row count} over Delphi_CommentEmbeddings.

    Counts only, never ids; the dry run reports it so an operator sees which model
    strings the source holds before any flag-on import maps and stores them. A row
    whose embedding shape is unreadable is counted under the sentinel '<no model>'.
    """
    counts = {}
    with closing(sqlite3.connect(database)) as db:
        for (wire,) in db.execute(
                "SELECT wire FROM rows WHERE family=? AND disposition='imported'", (EMBEDDINGS_FAMILY,)):
            try:
                model = json.loads(wire)['embedding']['M']['model']['S']
                if not isinstance(model, str):
                    raise TypeError
            except (KeyError, TypeError, ValueError):
                model = '<no model>'
            counts[model] = counts.get(model, 0) + 1
    return counts


def embedding_text_shas(connection, database):
    """{(zid, tid) -> SHA-256 bytes of comments.txt} for every imported embedding.

    A comment's text is its embedding's provenance (text_sha in the row). The read
    is bounded (comments for the conversations that have embeddings, keyed by the
    indexed zid) and happens on a read-only connection the caller opens and closes
    before materialize, so no Postgres connection or lock is held across the slow
    staging work and the server's vote pools are never touched (ops red tape)."""
    with closing(sqlite3.connect(database)) as db:
        zids = [z for (z,) in db.execute(
            "SELECT DISTINCT zid FROM rows WHERE family=? AND disposition='imported' AND zid IS NOT NULL",
            (EMBEDDINGS_FAMILY,))]
    result = {}
    if not zids:
        return result
    connection.set_session(readonly=True)
    with connection, connection.cursor() as cursor:
        cursor.execute('SELECT zid, tid, txt FROM comments WHERE zid = ANY(%s)', (zids,))
        for zid, tid, txt in cursor:
            result[(zid, tid)] = hashlib.sha256(txt.encode('utf-8')).digest()
    return result


def _conversation_embedding_spool(db, zid, text_shas, report):
    """One conversation's imported embeddings as a spool, or None if it has none.

    Returns (model, dims, rows, spool_bytes, content_sha) where rows is a tid-sorted
    list of (tid, text_sha bytes, float32 vector). Refuses the whole conversation on
    an unmapped model, a dimension that disagrees with the vector, a value that is
    not float32-exact, or more than one model in the conversation. A comment whose
    text is gone is skipped and counted in `report` (text_missing); its embedding is
    not stored, because without the text there is no provenance to record."""
    model = dims = None
    collected = []
    for (wire,) in db.execute(
            "SELECT wire FROM rows WHERE family=? AND zid=? AND disposition='imported' ORDER BY k",
            (EMBEDDINGS_FAMILY, zid)):
        item = json.loads(wire)
        try:
            tid = int(item['comment_id']['N'])
            embedding = item['embedding']['M']
            raw_model = embedding['model']['S']
            dimensions = int(embedding['dimensions']['N'])
            vector_avs = embedding['vector']['L']
        except (KeyError, TypeError, ValueError):
            raise ValueError('unreadable embedding row')
        normalized = EMBEDDING_MODEL_ALIASES.get(raw_model)
        if normalized is None:
            raise ValueError('unmapped embedding model')
        if dimensions != len(vector_avs) or not 1 <= dimensions <= MAX_DIMS:
            raise ValueError('embedding dimension mismatch')
        if model is None:
            model, dims = normalized, dimensions
        elif normalized != model or dimensions != dims:
            raise ValueError('multiple embedding models in conversation')
        vector = []
        for av in vector_avs:
            narrowed, exact = _float32_exact(av['N'])
            if not exact:
                raise ValueError('embedding value is not float32 exact')
            vector.append(narrowed)
        text_sha = text_shas.get((zid, tid))
        if text_sha is None:
            report['text_missing'] = report.get('text_missing', 0) + 1
            continue
        collected.append((tid, text_sha, vector))
    if model is None:
        return None
    collected.sort(key=lambda entry: entry[0])
    spool_bytes = write_spool(model, dims, collected)
    report['rows'] = report.get('rows', 0) + len(collected)
    report.setdefault('models', {})
    report['models'][model] = report['models'].get(model, 0) + len(collected)
    return model, dims, collected, spool_bytes, embedding_content_sha(collected)


def code_sha():
    return sha(Path(__file__).read_bytes())


def write_private(path, raw):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as f:
        f.write(raw)


def source_client(region, endpoint=None):
    if endpoint:
        return legacy.local_client(endpoint)
    # AWS execution deliberately accepts only EC2 instance-profile credentials.
    # Never fall back to a developer profile, env keys or a mounted credentials file.
    import boto3
    from botocore.config import Config
    session = boto3.Session(region_name=region)
    credentials = session.get_credentials()
    if credentials is None or credentials.method != 'iam-role':
        raise ValueError('instance role required')
    return session.client('dynamodb', config=Config(
        connect_timeout=5, read_timeout=60, retries={'mode': 'standard', 'max_attempts': 5}))


def connect_readonly_source(local=False):
    import psycopg2
    from psycopg2.extensions import parse_dsn
    dsn = os.environ['IMPORT_SOURCE_DATABASE_URL']
    if not local and parse_dsn(dsn).get('sslmode') != 'verify-full':
        raise ValueError('verified source database TLS required')
    connection = psycopg2.connect(dsn, connect_timeout=10)
    connection.set_session(readonly=True)
    return connection


def mapping(connection):
    connection.set_session(readonly=True)
    with connection, connection.cursor() as cursor:
        cursor.execute('SELECT zid FROM conversations')
        conversations = {str(row[0]): row[0] for row in cursor}
        cursor.execute('SELECT report_id,zid FROM reports')
        reports = {}
        for rid, zid in cursor:
            if rid in reports and reports[rid] != zid:
                raise ValueError('ambiguous report binding')
            reports[rid] = zid
    return conversations, reports


def mapping_drift(before, after):
    """Counts of added, removed and re-pointed mapping entries; never ids."""
    result = {}
    for name, old, new in zip(('conversations', 'reports'), before, after):
        result[name] = dict(added=len(new.keys() - old.keys()), removed=len(old.keys() - new.keys()),
                            changed=sum(old[key] != new[key] for key in old.keys() & new.keys()))
    return result


def oversize_summary(oversized):
    """Counts and byte sizes of the families past the staging bounds; never ids.

    `families` covers the per-family bound; the key "batch" covers the
    whole-conversation bound. `conversations` counts distinct conversations
    past either bound.
    """
    families = {}
    for entry in oversized:
        name = entry['family'] or 'batch'
        bucket = families.setdefault(name, dict(conversations=0, bytes_max=0, bytes_total=0))
        bucket['conversations'] += 1
        bucket['bytes_max'] = max(bucket['bytes_max'], entry['bytes'])
        bucket['bytes_total'] += entry['bytes']
    return dict(conversations=len({entry['zid'] for entry in oversized}), families=families,
                family_limit=FAMILY_LIMIT, batch_limit=BATCH_LIMIT)


def staging(bundles, oversized):
    """Per-conversation staged size and bound status, plus the aggregate, for the report."""
    per_zid = {bundle['zid']: dict(bytes=bundle['bytes'], within_bound=True, oversized_families={},
                                   batch_over_bound=False) for bundle in bundles}
    for entry in oversized:
        state = per_zid[entry['zid']]
        state['within_bound'] = False
        if entry['family'] is None:
            state['batch_over_bound'] = True
        else:
            state['oversized_families'][entry['family']] = entry['bytes']
    return dict(conversations=per_zid, totals=oversize_summary(oversized))


def rebind_additions(database, before, after, allowed_missing=(), *, validate_schema=True, skipped=()):
    """Bind a finished census to a mapping that only gained entries since it was read.

    Conversations and reports created during a long census are accepted. A row
    already bound cannot change binding, because every entry it resolved through
    is unchanged; a row left unbound may now bind to a new entry. The census is
    reopened as a resume, which re-derives every row's binding from its exact
    source bytes and recomputes the summary without reading the source (every
    family is already finished; no client is passed). A removed conversation or
    report, or a report bound to a different conversation, still refuses.
    """
    drift = mapping_drift(before, after)
    if any(entry['removed'] or entry['changed'] for entry in drift.values()):
        raise ValueError('source identity mapping changed')
    return census(None, database, *after, allowed_missing, validate_schema=validate_schema,
                  resume=True, skipped=skipped)


def mapping_additions(before, after):
    """Conversations and reports present in `after` but not `before`: the mid-run additions.

    Returns their identities (sorted zids, and each new report_id to its zid).
    Rebinding re-derives the binding of rows already scanned, so a conversation
    that appeared mid-run with rows read before it did is counted under it in
    this run. The additions returned here are the superset that a follow-up pass
    covers; see `write_follow_up`.
    """
    (before_conversations, before_reports), (after_conversations, after_reports) = before, after
    conversations = sorted(after_conversations[key] for key in after_conversations.keys() - before_conversations.keys())
    reports = {rid: after_reports[rid] for rid in sorted(after_reports.keys() - before_reports.keys())}
    return dict(conversations=conversations, reports=reports)


def write_follow_up(attempt, before, after):
    """Record the mid-run additions privately so a follow-up pass re-imports them.

    Rebinding reclassifies rows already scanned for a conversation that appeared
    during the run, but a conversation whose result rows are written after this
    run's scan has passed their page is accepted with nothing to bind and would
    otherwise be missed silently. Every mid-run addition's identity is written
    here, on the private import mount only (never a relayed channel), so a later
    run imports anything this run could not see; re-importing a conversation
    already imported in this run is idempotent. Returns counts only.
    """
    additions = mapping_additions(before, after)
    write_private(attempt / FOLLOW_UP, legacy.json_bytes(
        dict(schema='polis-production-import-follow-up/1', **additions)))
    return dict(conversations=len(additions['conversations']), reports=len(additions['reports']))


def bind(item, conversations, reports):
    candidates = set()
    for name, sep in [('zid', None), ('conversation_id', None), ('zid_tick', ':'),
                      ('zid_tick_gid', ':'), ('zid_topic_jobid', '#')]:
        if name in item:
            value = item[name].get('S', item[name].get('N'))
            if not isinstance(value, str):
                return None
            value = value.split(sep, 1)[0] if sep else value
            if value not in conversations:
                return None
            candidates.add(conversations[value])
    for name in ('report_id', 'rid_section_model'):
        if name in item:
            value = item[name].get('S')
            if not isinstance(value, str):
                return None
            rid = value.split('#', 1)[0] if name == 'rid_section_model' else value
            if rid not in reports:
                return None
            candidates.add(reports[rid])
    return next(iter(candidates)) if len(candidates) == 1 else None


PROGRESS_SCHEMA = (
    'CREATE TABLE rows(family TEXT, k BLOB, zid INTEGER, disposition TEXT, wire BLOB, PRIMARY KEY(family,k))',
    'CREATE TABLE census_meta(name TEXT PRIMARY KEY, value TEXT NOT NULL)',
    # One row per family: scanning (with the next ExclusiveStartKey), done or missing.
    'CREATE TABLE scan_progress(family TEXT PRIMARY KEY, state TEXT NOT NULL, start TEXT)',
    'CREATE TABLE scan_tokens(family TEXT, token TEXT, PRIMARY KEY(family,token))',
)


ATTEMPT_COMPLETE = 'complete'


def pacing_arguments(parser):
    """Shared CLI bounds for every census Scan (no DescribeTable discovery)."""
    parser.add_argument('--max-read-units-per-second', type=float,
                        default=scan_pacing.DEFAULT_MAX_READ_UNITS_PER_SECOND,
                        help='ceiling on consumed read units per second across all tables')
    parser.add_argument('--scan-page-limit', type=int, default=scan_pacing.DEFAULT_PAGE_LIMIT)
    parser.add_argument('--max-throttle-retries', type=int,
                        default=scan_pacing.DEFAULT_MAX_THROTTLE_RETRIES,
                        help='consecutive throttled attempts per page before pausing for --resume')
    parser.add_argument('--resume', action='store_true',
                        help='continue the single incomplete attempt from its scan checkpoints')


def pacer_from(args):
    return scan_pacing.ScanPacer(args.max_read_units_per_second, page_limit=args.scan_page_limit,
                                 max_throttle_retries=args.max_throttle_retries)


def attempt_directory(scratch, prefix, resume):
    """A new private attempt, or the one incomplete attempt to continue."""
    if not resume:
        attempt = scratch / (prefix + uuid.uuid4().hex)
        attempt.mkdir(mode=0o700)
        return attempt
    candidates = [p for p in scratch.iterdir()
                  if re.fullmatch(re.escape(prefix) + '[0-9a-f]{32}', p.name)
                  and not p.is_symlink() and p.is_dir() and not (p / ATTEMPT_COMPLETE).exists()]
    if len(candidates) != 1:
        raise ValueError('exactly one incomplete attempt required to resume')
    attempt = candidates[0]
    # Only the census databases carry progress; later outputs are rebuilt from them.
    for derived in ('snapshot', 'report.jsonl', FOLLOW_UP):
        path = attempt / derived
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
    return attempt


def finish_attempt(attempt):
    write_private(attempt / ATTEMPT_COMPLETE, b'')


def _start_key(raw):
    """Decode a checkpointed LastEvaluatedKey; source keys are only S/N."""
    value = json.loads(raw)
    if (not isinstance(value, dict) or not value or not all(
            isinstance(k, str) and isinstance(v, dict) and len(v) == 1 and
            next(iter(v)) in ('S', 'N') and isinstance(next(iter(v.values())), str)
            for k, v in value.items())):
        raise ValueError('invalid scan checkpoint')
    return value


def _open_census(database, conversations, reports, resume):
    """New census database, or an existing checkpoint bound to the same mapping."""
    binding = sha(legacy.json_bytes(dict(conversations=conversations,
                                         reports=sorted(reports.items()))))
    existing = Path(database).exists()
    if existing and not resume:
        raise ValueError('census database already exists')
    db = sqlite3.connect(database)
    if not existing:
        for statement in PROGRESS_SCHEMA:
            db.execute(statement)
        db.execute("INSERT INTO census_meta VALUES('binding',?)", (binding,))
        db.commit()
        return db
    try:
        row = db.execute("SELECT value FROM census_meta WHERE name='binding'").fetchone()
    except sqlite3.DatabaseError:
        db.close()
        raise ValueError('census checkpoint unreadable') from None
    if row is None:
        db.close()
        raise ValueError('census checkpoint unreadable')
    if row[0] != binding:
        # Conversations may be created while a paused census waits. Rows keep
        # their exact source bytes, so re-derive every binding under the new
        # mapping rather than mixing two mappings in one census.
        updates = []
        for family, key, wire in db.execute('SELECT family,k,wire FROM rows'):
            item = {k: codec._decode_av(v) for k, v in json.loads(wire).items()}
            updates.append((*_classify(family, item, conversations, reports), family, key))
        db.executemany('UPDATE rows SET zid=?,disposition=? WHERE family=? AND k=?', updates)
        db.execute("UPDATE census_meta SET value=? WHERE name='binding'", (binding,))
        db.commit()
    return db


def _classify(family, item, conversations, reports):
    zid = bind(item, conversations, reports)
    disposition = ('archived' if family in legacy.CONTROL_FAMILIES else
                   'quarantined' if zid is None or legacy.has_nul(item) else 'imported')
    return zid, disposition


def census(client, database, conversations, reports, allowed_missing=(), *, validate_schema=True,
           pacer=None, resume=False, skipped=()):
    """Read every page of every known family; keep all rows, including unmapped.

    The read-only report uses Scan alone and validates row keys with the codec.
    Import/apply callers retain the table-schema preflight by default.
    Every Scan goes through `pacer` (eventually consistent, limited, metered,
    throttle backoff). Rows and the next ExclusiveStartKey commit together per
    page in `database`, so with `resume=True` an interrupted or paused census
    continues from its last committed page instead of starting over.
    A family in `skipped` is never read at all (not even one Scan) and is
    reported under `skipped`; use it for a source table that is deliberately
    excluded from the import, such as one outside this role's read permission.
    """
    pacer = pacer or scan_pacing.ScanPacer()
    db = _open_census(database, conversations, reports, resume)
    try:
        progress = {family: (state, start) for family, state, start in
                    db.execute('SELECT family,state,start FROM scan_progress')}
        missing = []
        for family, definition in sorted(codec.FAMILIES.items()):
            state, start = progress.get(family, ('scanning', None))
            if family in skipped:
                if state not in ('scanning', 'skipped') or start is not None:
                    raise ValueError('skipped family was already scanned')
                db.execute('INSERT OR REPLACE INTO scan_progress VALUES(?,?,NULL)', (family, 'skipped'))
                db.commit()
                continue
            if state == 'skipped':
                raise ValueError('previously skipped family must stay skipped on resume')
            if state == 'missing':
                if family not in allowed_missing:
                    raise ValueError('unapproved missing source table')
                missing.append(family)
                continue
            if state == 'done':
                continue
            start = _start_key(start) if start else None
            if validate_schema:
                try:
                    description = client.describe_table(TableName=family)['Table']
                except client.exceptions.ResourceNotFoundException:
                    if family not in allowed_missing:
                        raise ValueError('unapproved missing source table') from None
                    db.execute('INSERT OR REPLACE INTO scan_progress VALUES(?,?,NULL)', (family, 'missing'))
                    db.commit()
                    missing.append(family)
                    continue
                keys = description['KeySchema']
                types = {a['AttributeName']: a['AttributeType'] for a in description['AttributeDefinitions']}
                actual = [(k['AttributeName'], types[k['AttributeName']]) for k in
                          sorted(keys, key=lambda k: k['KeyType'] != 'HASH')]
                if actual != definition['key']:
                    raise ValueError('source key schema mismatch')
            while True:
                args = dict(TableName=family)
                if start:
                    args['ExclusiveStartKey'] = start
                try:
                    response = pacer.scan(client, **args)
                except client.exceptions.ResourceNotFoundException:
                    if validate_schema:
                        raise  # Preserve the checked importer's failure after its preflight.
                    # A table lost mid-scan must never become a successful partial census.
                    stored = db.execute('SELECT COUNT(*) FROM rows WHERE family=?', (family,)).fetchone()[0]
                    if start or stored:
                        raise ValueError('source table disappeared during scan') from None
                    if family not in allowed_missing:
                        raise ValueError('unapproved missing source table') from None
                    db.execute('INSERT OR REPLACE INTO scan_progress VALUES(?,?,NULL)', (family, 'missing'))
                    db.commit()
                    missing.append(family)
                    break
                for item in response.get('Items', []):
                    wire = codec.encode_item(family, item).encode('utf-8')
                    key = codec.dumps([json.loads(wire)[name] for name, _ in definition['key']]).encode('utf-8')
                    zid, disposition = _classify(family, item, conversations, reports)
                    try:
                        db.execute('INSERT INTO rows VALUES(?,?,?,?,?)', (family, key, zid, disposition, wire))
                    except sqlite3.IntegrityError:
                        raise ValueError('duplicate source key during scan') from None
                start = response.get('LastEvaluatedKey')
                if start:
                    token = sha(legacy.json_bytes({k: str(v) for k, v in sorted(start.items())}))
                    try:
                        db.execute('INSERT INTO scan_tokens VALUES(?,?)', (family, token))
                    except sqlite3.IntegrityError:
                        raise ValueError('repeated source continuation') from None
                    checkpoint = ('scanning', json.dumps(start, sort_keys=True))
                else:
                    checkpoint = ('done', None)
                # The page's rows and its continuation commit atomically.
                db.execute('INSERT OR REPLACE INTO scan_progress VALUES(?,?,?)', (family, *checkpoint))
                db.commit()
                if not start:
                    break
        counts = {family: dict(source=0, imported=0, archived=0, quarantined=0)
                  for family in codec.FAMILIES}
        for family, disposition, count in db.execute(
                'SELECT family,disposition,COUNT(*) FROM rows GROUP BY family,disposition'):
            counts[family]['source'] += count
            counts[family][disposition] += count
        inventory = {}
        for family in sorted(codec.FAMILIES):
            h = hashlib.sha256((codec.header(family) + '\n').encode())
            for (wire,) in db.execute('SELECT wire FROM rows WHERE family=? ORDER BY k', (family,)):
                h.update(wire + b'\n')
            inventory[family] = h.hexdigest()
    finally:
        db.close()
    skipped = sorted(skipped)
    return dict(counts=counts, inventory=inventory, missing=missing, skipped=skipped,
                source_sha256=sha(legacy.json_bytes(dict(inventory=inventory, missing=missing,
                                                          skipped=skipped))))


def materialize(database, root, summary, oversized=None, *, embeddings_table=False,
                text_shas=None, embedding_report=None):
    """Bounded family files per conversation, plus exact private control/quarantine archive.

    The bounds mirror the destination's per-run result contract: one family's
    wire and one run's batch, as the queue daemon and the Postgres result
    functions accept them. They are not a disk budget. With `oversized=None`
    (the importer's apply path) the first family or conversation past a bound
    refuses before anything is admitted. A dry run passes a list instead: every
    family is staged in full, each one past a bound is appended to the list as
    {zid, family, bytes, rows} (family None for the whole-conversation batch
    bound), and staging continues.

    With `embeddings_table` (the flag on), Delphi_CommentEmbeddings leaves the
    codec family: the family file is written empty (header only) and the rows go
    to a per-conversation binary spool (``embeddings.spool``), with the model
    mapped, every value checked float32-exact and the comment text's SHA-256 from
    ``text_shas``. The 64 MiB family bound no longer touches embeddings, so the
    two production conversations that exceeded it stage; the manifest records the
    spool so the detached child re-emits it and the daemon routes it through
    pd_embedding_put/close. Flag off, this family stages like every other one and
    every byte below is identical to today.
    """
    report = embedding_report if embedding_report is not None else {}
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    db = sqlite3.connect(database)
    bundles = []
    for (zid,) in db.execute("SELECT DISTINCT zid FROM rows WHERE disposition='imported' ORDER BY zid"):
        directory = root / str(zid)
        directory.mkdir(mode=0o700)
        families, total, rows = {}, 0, 0
        embeddings_descriptor = None
        # Explicit empty families prevent accidentally inheriting older result rows.
        for family in sorted(set(codec.FAMILIES) - legacy.CONTROL_FAMILIES):
            spool_family = embeddings_table and family == EMBEDDINGS_FAMILY
            path = directory / (family + '.jsonl')
            h, size, count = hashlib.sha256(), 0, 0
            with path.open('xb') as f:
                head = (codec.header(family) + '\n').encode()
                f.write(head); h.update(head); size += len(head)
                if not spool_family:
                    for (wire,) in db.execute("SELECT wire FROM rows WHERE family=? AND zid=? AND disposition='imported' ORDER BY k", (family, zid)):
                        f.write(wire + b'\n'); h.update(wire + b'\n'); size += len(wire) + 1; count += 1
                        if size > FAMILY_LIMIT and oversized is None:
                            raise ValueError('conversation family exceeds staged storage bound')
            if size > FAMILY_LIMIT:
                if oversized is None:
                    raise ValueError('conversation family exceeds staged storage bound')
                oversized.append(dict(zid=zid, family=family, bytes=size, rows=count))
            total += size
            rows += count
            if total > BATCH_LIMIT and oversized is None:
                raise ValueError('conversation exceeds staged batch bound')
            families[family] = dict(sha256=h.hexdigest(), bytes=size, rows=count)
            if spool_family:
                built = _conversation_embedding_spool(db, zid, text_shas or {}, report)
                if built is not None:
                    model, dims, spool_rows, spool_bytes, content = built
                    write_private(directory / EMBEDDING_SPOOL_FILE, spool_bytes)
                    embeddings_descriptor = dict(file=EMBEDDING_SPOOL_FILE, sha256=sha(spool_bytes),
                                                 model=model, dims=dims, rows=len(spool_rows),
                                                 content_sha=content)
        if total > BATCH_LIMIT:
            oversized.append(dict(zid=zid, family=None, bytes=total, rows=rows))
        manifest = dict(schema='polis-production-import/1', zid=zid, families=families,
                        source_sha256=summary['source_sha256'], adapter_sha256=code_sha())
        if embeddings_table:
            manifest['embeddings_table'] = True
            if embeddings_descriptor is not None:
                manifest['embeddings'] = embeddings_descriptor
        raw = legacy.json_bytes(manifest)
        digest = sha(raw)
        write_private(directory / 'manifest.json', raw)
        destination = root / digest
        directory.rename(destination)
        bundles.append(dict(digest=digest, zid=zid, bytes=total))
    archives = {}
    for disposition in ('archived', 'quarantined'):
        for family in sorted(codec.FAMILIES):
            path = root / (disposition + '-' + family + '.jsonl')
            h, count = hashlib.sha256(), 0
            with path.open('xb') as f:
                head = (codec.header(family) + '\n').encode(); f.write(head); h.update(head)
                for (wire,) in db.execute('SELECT wire FROM rows WHERE family=? AND disposition=? ORDER BY k', (family, disposition)):
                    f.write(wire + b'\n'); h.update(wire + b'\n'); count += 1
            archives[path.name] = dict(sha256=h.hexdigest(), rows=count)
    db.close()
    write_private(root / 'inventory.json', legacy.json_bytes(dict(summary=summary, bundles=bundles, archives=archives)))
    return bundles


def read_bundle(digest):
    if not re.fullmatch('[0-9a-f]{64}', digest):
        raise ValueError('invalid snapshot reference')
    root = SNAPSHOTS / digest
    if root.is_symlink() or SNAPSHOTS.is_symlink():
        raise ValueError('snapshot symlink refused')
    raw = legacy.read_regular_file(root / 'manifest.json', MANIFEST_LIMIT)
    if sha(raw) != digest:
        raise ValueError('snapshot digest mismatch')
    manifest = json.loads(raw)
    if (manifest['schema'] != 'polis-production-import/1' or manifest['adapter_sha256'] != code_sha()
            or set(manifest['families']) != set(codec.FAMILIES) - legacy.CONTROL_FAMILIES):
        raise ValueError('snapshot contract mismatch')
    return root, manifest


def execute(frame):
    """Offline child: verifies all bytes and emits files; no database/source credentials.

    With the embeddings table on, the daemon carries ``embeddings_table`` in the
    frame; the manifest records that the snapshot was staged with the flag on and
    (for a conversation that had embeddings) an ``embeddings`` spool descriptor.
    The two must agree, so a snapshot staged one way is never imported the other
    way and embeddings are never silently dropped. When they agree and a spool is
    present, the child re-emits it (bytes digest-checked against the manifest) for
    the daemon to route into pd_embedding_put/close; the codec family is empty."""
    config = frame['input']['declared']['config']
    root, manifest = read_bundle(config['snapshot_ref'])
    if (config.get('production_import_sha256') != code_sha() or manifest['zid'] != frame['zid']
            or config['source_sha256'] != manifest['source_sha256']):
        raise ValueError('detached import identity mismatch')
    if bool(frame.get('embeddings_table')) != bool(manifest.get('embeddings_table')):
        raise ValueError('embeddings table flag mismatch')
    output_root = Path(os.environ['DELPHI_OUTPUT_MANIFEST']).parent
    spool, total = {}, 0
    for family, entry in sorted(manifest['families'].items()):
        raw = legacy.read_regular_file(root / (family + '.jsonl'), FAMILY_LIMIT)
        total += len(raw)
        if total > BATCH_LIMIT or len(raw) != entry['bytes'] or sha(raw) != entry['sha256']:
            raise ValueError('detached source bytes mismatch')
        actual, rows = codec.decode_family(raw)
        if actual != family or len(rows) != entry['rows']:
            raise ValueError('detached source count mismatch')
        for row in rows:
            # Source report ownership is rechecked by M28 at fenced insertion.
            legacy.check_binding(row, frame['zid'], config['report_ids'])
            if legacy.has_nul(row):
                raise ValueError('unquarantined source row')
        path = output_root / (family + '.jsonl')
        write_private(path, raw)
        spool[family] = dict(file=path.name, sha256=sha(raw))
    output = dict(model=legacy.MODEL, source_sha256=manifest['source_sha256'],
                  snapshot_sha256=config['snapshot_ref'], family_spool=spool)
    descriptor = manifest.get('embeddings')
    if descriptor is not None:
        raw = legacy.read_regular_file(root / EMBEDDING_SPOOL_FILE, MAX_SPOOL_BYTES)
        if sha(raw) != descriptor['sha256']:
            raise ValueError('detached embedding spool mismatch')
        write_private(output_root / EMBEDDING_SPOOL_FILE, raw)
        # Exactly the keys the daemon's stage_embeddings re-checks (no content_sha,
        # which stays in the manifest for the importer's post-import verification).
        output['embedding_spool'] = {k: descriptor[k] for k in ('file', 'sha256', 'model', 'dims', 'rows')}
    return output


def specification(bundle, report_ids):
    # Reuse the admitted model and provenance contract, detach only the input bytes.
    worker = Path(__file__).resolve().parents[2] / 'scripts/job_graph_stage.py'
    snapshot = {'texts': ['legacy import']}
    config = dict(snapshot_ref=bundle['digest'], source_sha256=read_bundle(bundle['digest'])[1]['source_sha256'],
                  report_ids=sorted(report_ids), production_import_sha256=code_sha(),
                  importer_sha256=legacy.code_digest(), codec_sha256=legacy.codec_digest())
    return dict(schema='polis-job-graph/1', nodes=[dict(key='legacy_import_' + str(bundle['zid']), stage='graph_narrative',
        **{'class': 'delphi'}, declared=dict(snapshot=dict(data=snapshot, sha256=sha(json.dumps(snapshot).encode())),
        code=sha(worker.read_bytes()), model=legacy.MODEL, runtime='python-' + sys.version.split()[0],
        seed=0, config=config, mode='full', memory_bytes=4294967296, work_units=1), inputs=[], max_attempts=3)])


def import_all(bundles, reports, environment, timeout, scope):
    """Run the actual daemon in a dedicated import environment; never publish."""
    import psycopg2
    from job_graph_client import GraphClient
    if not re.fullmatch('import-[a-z0-9_-]{1,57}', environment):
        raise ValueError('dedicated import environment required')
    if not scope or len(scope) > 128:
        raise ValueError('invalid import scope')
    dsn = os.environ['QUEUE_DATABASE_URL']
    from psycopg2.extensions import parse_dsn
    if os.environ.get('POLIS_JOBS_TRANSPORT', 'tls') != 'loopback' and parse_dsn(dsn).get('sslmode') != 'verify-full':
        raise ValueError('verified queue database TLS required')
    worker_env = {**os.environ, 'QUEUE_ENV': environment, 'POLIS_JOBS_ENABLED': '1',
                  'POLIS_JOBS_WORKER_CLASS': 'delphi', 'POLIS_JOBS_STAGES': 'graph_narrative',
                  'POLIS_JOBS_PYTHON': sys.executable, 'DELPHI_APP_PATH': '/app',
                  'POLIS_JOBS_WORK_DIR': '/import/work', 'POLIS_JOBS_JOURNAL_DIR': '/import/journal'}
    with closing(psycopg2.connect(dsn, connect_timeout=10)) as connection:
        with connection, connection.cursor() as cursor:
            cursor.execute("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR pg_has_role(current_user, 'polis_queue_owner', 'member'), pg_has_role(current_user, 'polis_queue_executor', 'member') FROM pg_roles WHERE rolname=current_user")
            superuser, member = cursor.fetchone()
            if superuser or not member:
                raise ValueError('narrow queue executor login required')
        client = GraphClient(connection, environment)
        # Dedicated environment must not contain unrelated runnable work.
        with connection, connection.cursor() as cur:
            cur.execute('SELECT job_config FROM delphi_result_jobs WHERE env=%s', (environment,))
            if any(row[0].get('production_import_sha256') != code_sha() for row in cur):
                raise ValueError('import environment contains unrelated jobs')
        prepared = []
        for bundle in bundles:
            spec = specification(bundle, [rid for rid, zid in reports.items() if zid == bundle['zid']])
            if len(legacy.json_bytes(spec)) > 900000:
                raise ValueError('import admission exceeds graph input bound')
            prepared.append((bundle, spec))
        admitted = []
        # Daemon logs stay on the private mount; exceptions below contain no data.
        with open('/import/worker.log', 'ab') as log:
            worker = subprocess.Popen(['polis-jobs'], env=worker_env, stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + timeout
                for bundle, spec in prepared:
                    # The queue guard is per environment/scope, so complete and
                    # safely release each import before admitting the next one.
                    # Every conversation retains one common future reader scope.
                    client._call('pd_graph_reconcile')
                    key = 'import-' + sha(legacy.json_bytes(spec))
                    receipt = client.admit(bundle['zid'], scope, key, spec)
                    admitted.append((bundle, receipt))
                    while True:
                        status = client.status(receipt['graph_id'])
                        node = status['nodes'][0]
                        state = node['readiness']['state']
                        if state == 'succeeded':
                            artifact = node['artifact']
                            payload = json.loads(artifact['payload'])
                            if (payload['snapshot_sha256'] != bundle['digest']
                                    or sha(artifact['payload'].encode()) != artifact['content_sha']):
                                raise ValueError('artifact verification failed')
                            root, manifest = read_bundle(bundle['digest'])
                            for family, entry in manifest['families'].items():
                                wire = client._call('pd_result_artifact_wire', artifact['artifact_id'], family)
                                if wire['sha256'] != entry['sha256'] or sha(wire['wire'].encode()) != entry['sha256']:
                                    raise ValueError('destination digest mismatch')
                            descriptor = manifest.get('embeddings')
                            if descriptor is not None:
                                # The set the daemon closed for this artifact must
                                # match the spool exactly: the receipt digest is over
                                # the stored real[] array_send bytes, so an equal sha,
                                # row count and dimension prove the float32 vectors
                                # round-tripped through Postgres with no change.
                                receipt = client._call('pd_embedding_set', artifact['artifact_id'], descriptor['model'])
                                if (receipt is None or receipt.get('sha256') != descriptor['content_sha']
                                        or receipt.get('row_count') != descriptor['rows']
                                        or receipt.get('dims') != descriptor['dims']
                                        or receipt.get('model') != descriptor['model']):
                                    raise ValueError('embedding set verification failed')
                            if client.served(bundle['zid'], scope) is not None:
                                raise ValueError('unexpected published import')
                            break
                        if state in {'dead', 'cancelled', 'parked'} or worker.poll() is not None:
                            raise ValueError('import worker failed')
                        if time.monotonic() >= deadline:
                            raise ValueError('import wait bound exceeded')
                        time.sleep(1)
            finally:
                if worker.poll() is None:
                    worker.terminate()
                    # Let the real daemon drain and confirm exit. Never fabricate completion.
                    worker.wait(timeout=120)
        receipt_path = Path('/import') / ('receipts-' + sha(legacy.json_bytes([r for _, r in admitted])) + '.json')
        if not receipt_path.exists():
            write_private(receipt_path, legacy.json_bytes([r for _, r in admitted]))
    return len(admitted)
