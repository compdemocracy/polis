"""Failure injection around the actual reference adapter; never shipped as a worker."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

frame = json.loads(Path(os.environ['DELPHI_FRAME']).read_text())
root = Path(os.environ['GRAPH_PROOF_ROOT'])
counter = root/'starts'/frame['job_id']
counter.parent.mkdir(exist_ok=True)
count = int(counter.read_text())+1 if counter.exists() else 1
counter.write_text(str(count))
control = json.loads((root/'control.json').read_text())
(root/'frames').mkdir(exist_ok=True)
(root/'frames'/f"{frame['job_id']}-{count}.json").write_text(json.dumps(frame,sort_keys=True))
if frame['stage']==control.get('hold_stage'):
    (root/'held-child.json').write_text(json.dumps(dict(pid=os.getpid(),job_id=frame['job_id'])))
    while True:
        time.sleep(.1)
if frame['stage']=='graph_cluster' and control.get('fail_clusters',0)>=count:
    Path(os.environ['DELPHI_OUTPUT_MANIFEST']).with_name('uncommitted-staging.json').write_text('{"unpublished":true}')
    sys.exit(1)
source = Path(os.environ['GRAPH_STAGE_SOURCE'])
spec = importlib.util.spec_from_file_location('graph_stage',source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
manifest = module.run(frame)
Path(os.environ['DELPHI_OUTPUT_MANIFEST']).write_text(json.dumps(manifest,sort_keys=True,separators=(',',':')))
