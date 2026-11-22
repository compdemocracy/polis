"""Image-local step capabilities, generated names, and input type checks.

The optional reference module is installed only in test images. Runtime settings
cannot enable it in the production image.
"""
import hashlib
import json
import os
from pathlib import Path
import sys

REGISTRY_PATH = Path(__file__).resolve().parents[1] / 'polismath/job-models.json'
PRODUCTION = json.loads(REGISTRY_PATH.read_text())
try:
    import graph_test_models as _test_models
except ModuleNotFoundError as error:
    if error.name != 'graph_test_models':
        raise
    _test_models = None
DEFINITIONS = PRODUCTION + (_test_models.definitions() if _test_models else [])
BY_ID = {row['id']: row for row in DEFINITIONS}
BY_MODEL = {row['model']: row for row in DEFINITIONS}


def named(identifier):
    return BY_ID[identifier]['model']


def definition(stage, model):
    result = BY_MODEL.get(model)
    if result is None or result['stage'] != stage:
        raise ValueError('unsupported graph step or model')
    return result


def validate_inputs(frame):
    declared = frame['input']['declared']
    row = definition(frame['stage'], declared['model'])
    artifacts = frame['input']['artifacts']
    if set(artifacts) != {rule['role'] for rule in row['inputs']}:
        raise ValueError('graph input roles differ from model')
    for rule in row['inputs']:
        artifact = artifacts[rule['role']]
        schemas = {r['stage'] + '/1' for r in DEFINITIONS if r['step'] == rule['producer']}
        if artifact.get('schema') not in schemas:
            raise ValueError('graph input producer schema mismatch')
        if hashlib.sha256(artifact['payload'].encode()).hexdigest() != artifact['sha256']:
            raise ValueError('upstream artifact digest mismatch')
    return row


def selected_model(environment, default):
    raw = os.environ.get('DELPHI_EMBED_MODEL_BY_ENV', '')
    if not raw:
        return default
    mapping = json.loads(raw)
    if not isinstance(mapping, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in mapping.items()):
        raise ValueError('embedding environment settings must be an object of model names')
    model = mapping.get(environment, default)
    definition('graph_embed', model)
    return model


def implementations(embedding=None):
    """Only the offline embedding directory actually present is advertised."""
    from delphi_graph_stages import code_digest
    root = Path(__file__).resolve().parents[1]
    adapter_sha = code_digest()
    code = hashlib.sha256(Path(__file__).with_name('job_graph_stage.py').read_bytes()).hexdigest()
    importer_sha = hashlib.sha256((root / 'polismath/delphi_storage/legacy_import.py').read_bytes()).hexdigest()
    result = []
    for row in DEFINITIONS:
        if row['step'] == 'embeddings' and row['adapter'] != 'reference' and row['model'] != embedding:
            continue
        digest = {'numerical': adapter_sha, 'import': importer_sha, 'reference': code}[row['adapter']]
        result.append(dict(step=row['step'], model=row['model'], adapter_sha256=digest))
    return dict(code=code, runtime='python-' + sys.version.split()[0], implementations=result)
