"""Fixed vocabularies the operator accepts from a box's failure records.

The worker exports identifier-shaped tokens; identifier-shaped is not closed. A
hostile container could spell about a hundred characters per run into the class,
role and code fields. This module derives the closed sets from the reviewed source
tree the operator runs from: exception classes actually defined in the image's
source closure, the slugs in the committed capture configs, the all-caps codes the
closure raises, and the source file stems that a raise-origin code may name. The
operator drops anything outside these sets; the record then carries only values
that already exist in reviewed source.
"""
from __future__ import annotations
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLOSURE = (ROOT / 'delphi/polismath/replay', ROOT / 'ci/private_cert/images', ROOT / 'ci/probe_box')
CONFIGS = (ROOT / 'delphi/scripts/certify_datasets.json', ROOT / 'delphi/scripts/certify_datasets.probe.json')

import builtins as _builtins
BUILTIN_EXCEPTIONS = frozenset(n for n in dir(_builtins)
                               if isinstance(getattr(_builtins, n), type) and issubclass(getattr(_builtins, n), BaseException))
PSYCOPG2 = frozenset({'Error', 'InterfaceError', 'DatabaseError', 'DataError', 'OperationalError', 'IntegrityError',
                      'InternalError', 'ProgrammingError', 'NotSupportedError'})
PSYCOPG2_ERRORS = frozenset({'QueryCanceled', 'UndefinedTable', 'UndefinedColumn', 'InsufficientPrivilege',
                             'ReadOnlySqlTransaction', 'SerializationFailure', 'DeadlockDetected', 'LockNotAvailable',
                             'StatementTimeout', 'IdleInTransactionSessionTimeout', 'AdminShutdown', 'CrashShutdown',
                             'CannotConnectNow', 'TooManyConnections', 'OutOfMemory', 'DiskFull', 'ConnectionFailure',
                             'ConnectionException', 'InvalidPassword', 'InvalidAuthorizationSpecification',
                             'DuplicateObject', 'SyntaxError', 'NumericValueOutOfRange', 'DivisionByZero'})
STAGES = frozenset({'images', 'secret', 'reader', 'producer', 'verifier', 'receipt', 'boot'})
LABELS = frozenset({'reader', 'producer', 'verifier'})
RELAY = frozenset({'resolve', 'connect', 'no_tls', 'tls_verify', 'tls', 'io', 'relayed', 'plain_scram'})
REASON_CODES = frozenset(code for _, code in __import__('worker').REASONS)
PHASES = frozenset({'start', 'boot-config', 'firewall', 'dns', 'private-disk', 'container-daemon', 'worker'})
CLASS_LINE = re.compile(r'^class ([A-Za-z_][A-Za-z0-9_]*)\(([A-Za-z_][A-Za-z0-9_.]*)\)', re.M)
# Every all-caps string literal in the closure: the codes it can raise or print.
CODE_LITERAL = re.compile(r"""['"]([A-Z][A-Z0-9_]{1,39})['"]""")
SLUG = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')


def _sources():
    for base in CLOSURE:
        for path in sorted(base.rglob('*.py')):
            if '__pycache__' in path.parts or path.name.startswith('test_'):
                continue
            yield path


def source_stems() -> frozenset:
    return frozenset(p.stem for p in _sources())


def closure_classes() -> frozenset:
    """Exception classes defined in the closure (any class whose base name ends like one)."""
    names = set()
    for path in _sources():
        for name, base in CLASS_LINE.findall(path.read_text(errors='replace')):
            if base.rsplit('.', 1)[-1].endswith(('Error', 'Exception', 'Failure', 'Unsatisfied', 'Unstable', 'Unknown', 'Unavailable')) or name.endswith(('Error', 'Exception', 'Failure', 'Unsatisfied', 'Unstable', 'Unknown')):
                names.add(name)
    return frozenset(names)


def closure_codes() -> frozenset:
    codes = set()
    for path in _sources():
        codes.update(CODE_LITERAL.findall(path.read_text(errors='replace')))
    return frozenset(codes)


def config_slugs() -> frozenset:
    slugs = set()
    for path in CONFIGS:
        try:
            for role in json.loads(path.read_bytes()).get('roles', []):
                slug = role.get('slug')
                if isinstance(slug, str) and SLUG.match(slug):
                    slugs.add(slug)
        except (OSError, ValueError):
            continue
    return frozenset(slugs)


class Vocabulary:
    def __init__(self) -> None:
        self.stems = source_stems()
        self.classes = closure_classes()
        self.codes = closure_codes()
        self.slugs = config_slugs()
        self.origin = re.compile(r'^([A-Z][A-Z0-9_]{0,31})_L(\d{1,5})$')
        self.origin_stems = frozenset(re.sub(r'[^A-Z0-9]', '_', stem.upper())[:32] for stem in self.stems)

    def class_name(self, value: object) -> bool:
        if not isinstance(value, str) or len(value) > 96:
            return False
        module, _, name = value.rpartition('.')
        if name in BUILTIN_EXCEPTIONS:
            return module in ('', 'builtins')
        if name in PSYCOPG2:
            return module in ('', 'psycopg2')
        if name in PSYCOPG2_ERRORS:
            return module == 'psycopg2.errors'
        if name in self.classes:
            parts = module.split('.') if module else []
            return not parts or (parts[-1] in self.stems and all(p in ('polismath', 'replay', 'ci', 'private_cert', 'images', 'probe_box') or p in self.stems for p in parts))
        return False

    def code(self, value: object) -> bool:
        if not isinstance(value, str):
            return False
        if value in self.codes:
            return True
        match = self.origin.match(value)
        return bool(match) and match.group(1) in self.origin_stems

    def slug(self, value: object) -> bool:
        return isinstance(value, str) and value in self.slugs
