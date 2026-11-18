"""Production refusal and producer-schema checks use fresh interpreter imports."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import shutil
import tempfile
import unittest

SCRIPTS=Path(__file__).resolve().parents[2]/'scripts'

# Copy only production modules: the suite may itself be running in a test image.
_PRODUCTION = tempfile.TemporaryDirectory(prefix='graph-production-')
_ROOT = Path(_PRODUCTION.name)
for name in ('scripts', 'polismath', 'umap_narrative'):
    shutil.copytree(SCRIPTS.parent / name, _ROOT / name,
                    ignore=shutil.ignore_patterns('__pycache__', 'graph_test_models.py', 'job-test-models.json'))
PRODUCTION_SCRIPTS = _ROOT / 'scripts'

def isolated(script):
    return subprocess.run([sys.executable,'-I','-c',f'import sys; sys.path.insert(0,{str(PRODUCTION_SCRIPTS)!r});\n'+script],capture_output=True,text=True)

class RegistryBoundary(unittest.TestCase):
    def test_production_has_no_reference_models_or_adapter(self):
        result=isolated("import graph_registry as r; assert r._test_models is None; assert len(r.DEFINITIONS)==6; assert not any(x['model'].startswith('local-') for x in r.DEFINITIONS)")
        self.assertEqual(result.returncode,0,result.stderr)
    def test_unknown_model_refuses(self):
        result=isolated("import graph_registry as r; r.definition('graph_embed','typo')")
        self.assertNotEqual(result.returncode,0)
        self.assertIn('unsupported graph step or model',result.stderr)
    def test_reference_execution_refuses_in_production(self):
        code=hashlib.sha256((SCRIPTS/'job_graph_stage.py').read_bytes()).hexdigest()
        inp=dict(schema='polis-job-input/1',declared=dict(mode='full',code=code,runtime='python-'+sys.version.split()[0],model='local-token-count/1'),artifacts={})
        wire=json.dumps(inp)
        frame=dict(schema='polis-job-stage-frame/1',stage='graph_embed',input_json=wire,input_sha256=hashlib.sha256(wire.encode()).hexdigest())
        result=isolated(f'import job_graph_stage as s; s.run({frame!r})')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('unsupported graph step or model',result.stderr)
    def test_wrong_input_producer_schema_refuses(self):
        script="""import graph_registry as r
r.validate_inputs({'stage':'graph_topics','input':{'declared':{'model':r.named('TfidfKeywords')},'artifacts':{'clusters':{'schema':'graph_embed/1','payload':'{}','sha256':'x'}}}})
"""
        result=isolated(script)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('producer schema mismatch',result.stderr)
    def test_image_reports_no_embedding_without_local_weights(self):
        result=isolated("import json, graph_registry as r; print(json.dumps(r.implementations()))")
        self.assertEqual(result.returncode,0,result.stderr)
        values=json.loads(result.stdout)['implementations']
        self.assertFalse(any(v['step']=='embeddings' for v in values))
        self.assertEqual(len(values),4)
    def test_environment_selection_is_explicit(self):
        script="""import os, json, graph_registry as r
original=r.named('Granite')
assert r.selected_model('shadow-example',original)==original
os.environ['DELPHI_EMBED_MODEL_BY_ENV']=json.dumps({'shadow-example':r.named('MiniLm')})
assert r.selected_model('shadow-example',original)==r.named('MiniLm')
assert r.selected_model('other',original)==original
"""
        result=isolated(script)
        self.assertEqual(result.returncode,0,result.stderr)

if __name__=='__main__':unittest.main()
