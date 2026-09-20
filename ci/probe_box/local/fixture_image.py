"""The local rehearsal's bash rootfs extended with Python/libpq public stages.

Like rehearsal.py, construct an OCI archive solely from local binaries and
libraries. No registry pulls, project datasets or host credentials enter it.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sysconfig
import tarfile


def archive(directory, role):
    import psycopg2
    files = {Path('/usr/bin/bash'), Path('/usr/bin/python3.12')}
    stdlib = Path(sysconfig.get_path('stdlib'))
    files.update(p for p in stdlib.rglob('*') if p.is_file() and 'site-packages' not in p.parts and '__pycache__' not in p.parts)
    package = Path(psycopg2.__file__).parent
    files.update(p for p in package.rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    files.update(p for p in package.parent.glob('psycopg2_binary.libs/*') if p.is_file())
    for f in list(files):
        if f.suffix == '.so' or '.so.' in f.name or f.name in ('bash', 'python3.12'):
            raw = subprocess.run(['ldd', str(f)], capture_output=True, text=True)
            files.update(Path(s) for s in re.findall(r'(/[\w/+.\-]+)', raw.stdout) if Path(s).is_file())
    layer = io.BytesIO()
    with tarfile.open(fileobj=layer, mode='w') as tar:
        for f in sorted({Path(os.path.normpath(str(p))) for p in files}):
            tar.add(f.resolve(), arcname=str(f).lstrip('/'), recursive=False)
        stage = Path(__file__).with_name('fixture_stage.py').read_bytes()
        entry = tarfile.TarInfo('fixture_stage.py'); entry.size = len(stage); entry.mode = 0o444
        tar.addfile(entry, io.BytesIO(stage))
    layer = layer.getvalue()
    ld = hashlib.sha256(layer).hexdigest()
    config = json.dumps({'architecture':'arm64','os':'linux','config':{
        'Entrypoint':['/usr/bin/bash','-c', 'exec /usr/bin/python3.12 /fixture_stage.py "$@"', role]},
        'rootfs':{'type':'layers','diff_ids':['sha256:'+ld]}}).encode()
    cd = hashlib.sha256(config).hexdigest()
    manifest = json.dumps({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json',
        'config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':'sha256:'+cd,'size':len(config)},
        'layers':[{'mediaType':'application/vnd.oci.image.layer.v1.tar','digest':'sha256:'+ld,'size':len(layer)}]}).encode()
    md = hashlib.sha256(manifest).hexdigest()
    index = json.dumps({'schemaVersion':2,'manifests':[{'mediaType':'application/vnd.oci.image.manifest.v1+json',
        'digest':'sha256:'+md,'size':len(manifest),'annotations':{'org.opencontainers.image.ref.name':'public-fixture'}}]}).encode()
    path = directory/(role+'.oci.tar')
    with tarfile.open(path, 'w') as tar:
        for name, data in [('oci-layout',b'{"imageLayoutVersion":"1.0.0"}'),('index.json',index),
                           ('blobs/sha256/'+md,manifest),('blobs/sha256/'+cd,config),('blobs/sha256/'+ld,layer)]:
            entry = tarfile.TarInfo(name); entry.size = len(data)
            tar.addfile(entry, io.BytesIO(data))
    return path, 'localhost/public-fixture-'+role+'@sha256:'+md
