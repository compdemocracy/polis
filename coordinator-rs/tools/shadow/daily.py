"""Closed daily shadow accounting and exact served-byte comparison.

Private bodies and binding manifests never enter the exported receipt. Production
collection must supply actual consumed-cut and computing-child evidence.
"""
from __future__ import annotations
from collections import Counter
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import tempfile
import zlib

ROUTES=('PCA2_FULL','PCA2_SUBSET','PARTICIPANT_MAPPING','COMMENT_MATH','REPORT_READ')
VERDICTS=('EXACT','UNORDERED_QUERY_RESIDUAL','ENGINE_DIFFERENCE','INCOMPLETE','LEGACY_EMPTY_DEFECT')
MAX_BODY=8*1024*1024
SHA=re.compile(r'[a-f0-9]{64}')


# This standalone tool shares the package's schedule loader without importing
# the numerical engine or requiring an editable Delphi installation.
_spec = importlib.util.spec_from_file_location("polis_empty_output",
    Path(__file__).resolve().parents[3] / "delphi/polismath/empty_output.py")
_empty = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_empty)


def strict_json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value: raise ValueError('SHADOW_DUPLICATE_JSON')
            value[key] = item
        return value
    def nonfinite(_): raise ValueError('SHADOW_NONFINITE_JSON')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite)


def at_path(value, path):
    for key in path.split('.'):
        if type(value) is not dict or key not in value: raise ValueError('SHADOW_EMPTY_CONTRACT')
        value = value[key]
    return value


def empty_binding(cut_bytes, bundle_bytes):
    """Call only after cut/history, retained bridge and reader-view admission.

    A zero-looking response is not proof of zero input. The actual admitted
    source and complete Python math payload must both satisfy the contract.
    """
    source = strict_json(cut_bytes)
    if source['votes'] != []: return None
    main = strict_json(bundle_bytes)['payloads']['main']
    for path, expected in _empty.empty_contract().items():
        if canonical(at_path(main, path)) != canonical(expected):
            raise ValueError('SHADOW_EMPTY_CONTRACT')
    return _empty.contract_sha256()


def legacy_empty_difference(a, b, route, binding):
    if binding is None or route['class'] not in ('PCA2_FULL', 'PCA2_SUBSET'): return False
    try:
        left, right = strict_json(a), strict_json(b)
    except (ValueError, UnicodeError):
        return False
    if type(left) is not dict or type(right) is not dict: return False
    declared = _empty.empty_contract()
    # Every exposed contract value must be exact. A subset route may omit
    # fields, but only the full, admitted backing row can authorize this path.
    for path, expected in declared.items():
        try: value = at_path(right, path)
        except ValueError:
            if route['class'] == 'PCA2_FULL': return False
            continue
        if canonical(value) != canonical(expected): return False
    changed = False
    for path in _empty.legacy_absent_keys():
        keys = path.split('.')
        lparent, rparent = left, right
        for key in keys[:-1]:
            # A missing parent is not a declared missing leaf; comps and other
            # PCA fields have no exemption in the committed schedule.
            if type(lparent.get(key)) is not dict or type(rparent.get(key)) is not dict: break
            lparent, rparent = lparent[key], rparent[key]
        else:
            key = keys[-1]
            if key not in lparent and key in rparent:
                lparent[key] = rparent[key]
                changed = True
    # Only named omissions are repaired. No numeric tolerance, dropped fields,
    # timestamp exception, arbitrary array sort or present-value substitution.
    return changed and canonical(left) == canonical(right)


def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()


def closed(value,keys):
    if type(value) is not dict or set(value)!=set(keys):raise ValueError('SHADOW_SCHEMA')


def number(value,maximum=10**9):
    if type(value) is not int or not 0<=value<=maximum:raise ValueError('SHADOW_COUNT')


def bind_cut(directory, sequence, raw):
    """First binding wins. A retry can only reuse byte-identical captured input."""
    number(sequence)
    if not isinstance(raw,bytes) or not raw or len(raw)>MAX_BODY:raise ValueError('SHADOW_CUT')
    root=Path(directory)
    if root.is_symlink():raise ValueError('SHADOW_PATH')
    root.mkdir(mode=0o700,parents=True,exist_ok=True)
    target=root/f'cut-{sequence}.bin'
    digest=hashlib.sha256(raw).hexdigest()
    # Link publication is atomic and never replaces a pre-existing binding.
    with tempfile.NamedTemporaryFile(dir=root,delete=False) as out:
        temp=Path(out.name);out.write(raw);out.flush();os.fsync(out.fileno())
    try:
        temp.chmod(0o400)
        try:os.link(temp,target)
        except FileExistsError:
            if target.is_symlink() or target.read_bytes()!=raw:raise ValueError('SHADOW_CUT_REBOUND')
        fd=os.open(root,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
    finally:temp.unlink()
    return target,digest


def verify_cut(path,digest):
    p=Path(path)
    if p.is_symlink() or not SHA.fullmatch(digest) or hashlib.sha256(p.read_bytes()).hexdigest()!=digest:
        raise ValueError('SHADOW_CUT_CHANGED')


def admit_pair(left,right,expected):
    """Private collector bindings: no wall-clock/tick-number pairing fallback."""
    fields=('host','cut','history','lifecycle','node_build','node_dependencies','node_settings','namespace','engine','computing_pid','parent_pid','runtime','bundle','read_only')
    for row,engine in ((left,'clojure'),(right,'python')):
        closed(row,fields)
        if row['engine']!=engine or row['host']!=expected['host']:raise ValueError('SHADOW_HOST')
        for key in ('cut','history','node_build','node_dependencies','node_settings'):
            if not SHA.fullmatch(str(row[key])) or row[key]!=expected[key]:raise ValueError('SHADOW_BINDING')
        lifecycle = 'warm-continuation/1' if engine == 'clojure' else 'poller-rebuild-prefix/1'
        if row['lifecycle']!=lifecycle or row['read_only'] is not True:raise ValueError('SHADOW_ADMISSION')
        if not SHA.fullmatch(str(row['bundle'])):raise ValueError('SHADOW_BUNDLE')
        if row['namespace']!=expected[engine+'_namespace']:raise ValueError('SHADOW_NAMESPACE')
        if type(row['computing_pid']) is not int or row['computing_pid']<=0 or row['computing_pid']==row['parent_pid']:
            raise ValueError('SHADOW_CHILD')
        runtime=row['runtime'];closed(runtime,('observed','threads','kernel','libraries'))
        if runtime['observed'] is not True or runtime['threads']!=1 or not runtime['libraries'] or runtime!=expected[engine+'_runtime']:
            raise ValueError('SHADOW_RUNTIME')
    if left['namespace']==right['namespace']:raise ValueError('SHADOW_NAMESPACE')


def admit_route(route,manifest):
    """Exact private route inventory; GET is necessary but not sufficient."""
    closed(route,('class','method','path','request_sha256','query_sha256','unordered'))
    if route['class'] not in ROUTES or route['method']!='GET' or route not in manifest:
        raise ValueError('SHADOW_ROUTE')
    if (not SHA.fullmatch(str(route['request_sha256'])) or not SHA.fullmatch(str(route['query_sha256']))
            or type(route['unordered']) is not bool or not isinstance(route['path'],str)
            or not route['path'].startswith('/api/v3/') or '\r' in route['path'] or '\n' in route['path']):
        raise ValueError('SHADOW_ROUTE')
    if route['unordered'] and route['class']!='COMMENT_MATH':raise ValueError('SHADOW_ROUTE')


def body(response):
    closed(response,('status','complete','content_type','etag','cache_control','vary','encoding','body','full_body'))
    if response['complete'] is not True or type(response['status']) is not int:raise ValueError('SHADOW_RESPONSE')
    if not isinstance(response['body'],bytes) or len(response['body'])>MAX_BODY:raise ValueError('SHADOW_BODY')
    if response['encoding']=='identity':return response['body']
    if response['encoding']!='gzip':raise ValueError('SHADOW_ENCODING')
    dec=zlib.decompressobj(16+zlib.MAX_WBITS)
    raw=dec.decompress(response['body'],MAX_BODY+1)
    if len(raw)>MAX_BODY or not dec.eof or dec.unused_data or dec.unconsumed_tail:raise ValueError('SHADOW_BODY')
    return raw


def rows(raw):
    """Preserve row spelling and separator whitespace; no value normalization."""
    text=raw.decode('utf-8');decoder=json.JSONDecoder()
    if not text.startswith('[') or not text.endswith(']'):raise ValueError('SHADOW_ORDER')
    i=1;parts=[];gaps=[]
    while i<len(text)-1:
        start=i
        while i<len(text)-1 and text[i].isspace():i+=1
        gaps.append(text[start:i])
        if text[i]==']':break
        _,end=decoder.raw_decode(text,i);parts.append(text[i:end]);i=end
        start=i
        while i<len(text)-1 and text[i].isspace():i+=1
        gaps.append(text[start:i])
        if text[i]==']':break
        if text[i]!=',':raise ValueError('SHADOW_ORDER')
        i+=1
    if i!=len(text)-1:raise ValueError('SHADOW_ORDER')
    return Counter(parts),gaps


def compare(left,right,route,full_pair=None,*,empty_contract_sha256=None):
    try:
        if route['class'] not in ROUTES:raise ValueError('SHADOW_ROUTE')
        if empty_contract_sha256 is not None and empty_contract_sha256 != _empty.contract_sha256():
            raise ValueError('SHADOW_EMPTY_CONTRACT')
        a,b=body(left),body(right)
        full_verdict = 'EXACT'
        if left['status']==304 or right['status']==304:
            if (left['status']!=304 or right['status']!=304 or a or b or full_pair is None
                    or left['full_body'] is None or right['full_body'] is None):return 'INCOMPLETE'
            # References are private SHA-256 bindings to the actual admitted full
            # responses; caller must additionally bind them to this route/cut.
            fa,fb=full_pair
            if (fa['status']!=200 or fb['status']!=200
                    or left['full_body']!=hashlib.sha256(body(fa)).hexdigest()
                    or right['full_body']!=hashlib.sha256(body(fb)).hexdigest()):return 'INCOMPLETE'
            full_verdict = compare(fa,fb,route,empty_contract_sha256=empty_contract_sha256)
            if full_verdict not in ('EXACT', 'LEGACY_EMPTY_DEFECT'): return full_verdict
        for key in ('status','content_type','etag','cache_control','vary'):
            if left[key]!=right[key]:return 'ENGINE_DIFFERENCE'
        if a==b:return full_verdict
        if (left['status'] == right['status'] == 200
                and isinstance(left['content_type'], str)
                and left['content_type'].split(';',1)[0].strip().lower() == 'application/json'
                and legacy_empty_difference(a,b,route,empty_contract_sha256)):
            return 'LEGACY_EMPTY_DEFECT'
        if (route.get('unordered') is True and route['class']=='COMMENT_MATH'
                and isinstance(left['content_type'],str)
                and left['content_type'].split(';',1)[0].strip().lower()=='application/json'):
            try:
                if rows(a)==rows(b):return 'UNORDERED_QUERY_RESIDUAL'
            except (ValueError,UnicodeError):pass
        return 'ENGINE_DIFFERENCE'
    except (ValueError,UnicodeError,zlib.error,KeyError,TypeError):return 'INCOMPLETE'


def receipt_verdict(v):
    """Derive a verdict; callers must still validate all closed fields/counts."""
    if not v['admission']['input'] or v['windows']['incomplete']:
        return 'INCOMPLETE'
    if any(row['ENGINE_DIFFERENCE'] for row in v['routes'].values()):
        return 'ENGINE_DIFFERENCE'
    complete = (all(v['admission'].values()) and v['seconds']==86400
        and v['windows']['expected']>0 and v['windows']['incomplete']==0
        and sum(row['expected'] for row in v['routes'].values())>0
        and all(row['expected']==row['observed'] and row['INCOMPLETE']==0 for row in v['routes'].values())
        and v['observer']['expected']>0
        and v['observer']['expected']==v['observer']['observed']
        and v['observer']['alarms']==0 and v['observer']['unresolved']==0
        and v['delivery']=='CONFIRMED' and v['cleanup']!='UNRESOLVED')
    return 'PASS' if complete else 'INCOMPLETE'


def validate_receipt(v):
    fields=('schema','run','window','seconds','build','policy','admission','windows','residuals','routes','observer','delivery','cleanup','verdict')
    closed(v, fields + (('empty_contract',) if 'empty_contract' in v else ()))
    if v['schema']!='polis-shadow-receipt/1' or not re.fullmatch(r'[a-f0-9]{32}',str(v['run'])):raise ValueError('SHADOW_RECEIPT')
    number(v['window'],36500);number(v['seconds'],86400)
    for key in ('build','policy'):
        if not SHA.fullmatch(str(v[key])):raise ValueError('SHADOW_RECEIPT')
    closed(v['admission'],('host','runtime','input','collector','clojure_serving'))
    if any(type(x) is not bool for x in v['admission'].values()):raise ValueError('SHADOW_RECEIPT')
    closed(v['windows'],('expected','bound','incomplete'))
    for x in v['windows'].values():number(x)
    if v['windows']['bound']+v['windows']['incomplete']!=v['windows']['expected']:raise ValueError('SHADOW_ACCOUNTING')
    closed(v['residuals'],('cut-unbound-late-row',))
    number(v['residuals']['cut-unbound-late-row'])
    if v['residuals']['cut-unbound-late-row']>v['windows']['incomplete']:raise ValueError('SHADOW_ACCOUNTING')
    if v['admission']['input'] and v['windows']['incomplete']:raise ValueError('SHADOW_INPUT')
    closed(v['routes'],ROUTES)
    for row in v['routes'].values():
        verdicts = VERDICTS if 'LEGACY_EMPTY_DEFECT' in row else VERDICTS[:-1]
        closed(row,('expected','observed',*verdicts))
        for x in row.values():number(x)
        if sum(row.get(k,0) for k in VERDICTS)!=row['observed'] or row['observed']>row['expected']:raise ValueError('SHADOW_ACCOUNTING')
    defects = sum(row.get('LEGACY_EMPTY_DEFECT', 0) for row in v['routes'].values())
    if defects:
        if v.get('empty_contract') != _empty.contract_sha256(): raise ValueError('SHADOW_EMPTY_CONTRACT')
    elif 'empty_contract' in v: raise ValueError('SHADOW_EMPTY_CONTRACT')
    if any(v['routes'][name].get('LEGACY_EMPTY_DEFECT',0) for name in ROUTES if name not in ('PCA2_FULL','PCA2_SUBSET')):
        raise ValueError('SHADOW_EMPTY_ROUTE')
    closed(v['observer'],('expected','observed','alarms','unresolved'))
    for x in v['observer'].values():number(x)
    if v['observer']['observed']>v['observer']['expected']:raise ValueError('SHADOW_ACCOUNTING')
    if v['delivery'] not in ('PENDING','CONFIRMED','FAILED','UNCERTAIN') or v['cleanup'] not in ('RETAINED','CLEAN','UNRESOLVED'):raise ValueError('SHADOW_RECEIPT')
    # An unbound input is never an engine failure, even if diagnostic bodies differ.
    expected=receipt_verdict(v)
    if v['verdict']!=expected:raise ValueError('SHADOW_VERDICT')
    if len(canonical(v))>16384:raise ValueError('SHADOW_LIMIT')
    return v


def publish(client,bucket,key,kms_key,receipt):
    """Publish a pending receipt once; reconcile lost ACK by byte identity.

    Confirmation is a separate local closed delivery record. The uploaded object
    cannot truthfully contain its own future acknowledgement. Never overwrite or
    silently retry an uncertain write.
    """
    validate_receipt(receipt)
    if receipt['delivery']!='PENDING':raise ValueError('SHADOW_DELIVERY')
    raw=canonical(receipt)
    try:
        client.put_object(Bucket=bucket,Key=key,Body=raw,IfNoneMatch='*',ServerSideEncryption='aws:kms',SSEKMSKeyId=kms_key)
    except Exception:
        try:
            remote=client.get_object(Bucket=bucket,Key=key)['Body'].read(len(raw)+1)
        except Exception:return 'UNCERTAIN'
        return 'CONFIRMED' if remote==raw else 'FAILED'
    return 'CONFIRMED'


def summarize_windows(receipts):
    """Acceptance accounting counts unknown cuts separately from bound windows."""
    result={key:0 for key in ('daily_receipts','PASS','ENGINE_DIFFERENCE','INCOMPLETE','bound_cuts','incomplete_cuts','cut-unbound-late-row','LEGACY_EMPTY_DEFECT')}
    seen=set()
    for receipt in receipts:
        validate_receipt(receipt)
        identity=(receipt['run'],receipt['window'])
        if identity in seen:raise ValueError('SHADOW_DUPLICATE_WINDOW')
        seen.add(identity)
        result['daily_receipts']+=1
        result[receipt['verdict']]+=1
        result['LEGACY_EMPTY_DEFECT'] += sum(row.get('LEGACY_EMPTY_DEFECT',0) for row in receipt['routes'].values())
        result['bound_cuts']+=receipt['windows']['bound']
        result['incomplete_cuts']+=receipt['windows']['incomplete']
        result['cut-unbound-late-row']+=receipt['residuals']['cut-unbound-late-row']
    return result
