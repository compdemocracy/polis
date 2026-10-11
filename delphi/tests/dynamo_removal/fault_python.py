#!/usr/local/bin/python
"""CI-only interpreter wrapper: fail the first cluster attempt, execute all others."""
import json,os,runpy,sys
from pathlib import Path
frame=json.loads(Path(os.environ['DELPHI_FRAME']).read_text())
if frame['stage']=='graph_cluster':
    marker=Path('/proof/cluster-failed-once')
    try:
        fd=os.open(marker,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    except FileExistsError:pass
    else:
        os.close(fd)
        print('Injected cluster failure before compute; completed embeddings retained',flush=True)
        sys.exit(73)
sys.argv=sys.argv[1:]
runpy.run_path(sys.argv[0],run_name='__main__')
