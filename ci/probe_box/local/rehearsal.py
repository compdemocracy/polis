import hashlib, io, json, os, pathlib, re, subprocess, sys, tarfile, time
# Delegate only this test container's private cgroup namespace for nested Docker.
cg=pathlib.Path('/sys/fs/cgroup')
(cg/'init').mkdir(exist_ok=True)
(cg/'init/cgroup.procs').write_text(str(os.getpid()))
(cg/'cgroup.subtree_control').write_text(' '.join('+'+x for x in (cg/'cgroup.controllers').read_text().split()))
sys.path.insert(0, '/source')
import worker
p = pathlib.Path('/probe-work'); (p/'tmp').mkdir(); (p/'client').mkdir()
os.environ.update(TMPDIR=str(p/'tmp'), DOCKER_CONFIG=str(p/'client'))
bake=pathlib.Path('/source/bake.sh').read_text()
root=pathlib.Path('/opt/polis-probe'); root.mkdir(parents=True,exist_ok=True)
for name,marker in [('docker.json','DOCKER'),('image-policy.json','POLICY')]:
    (root/name).write_text(bake.split("<<'"+marker+"'\n")[1].split('\n'+marker)[0])
default_roots=[pathlib.Path(x) for x in ('/var/lib/docker','/var/lib/containerd','/run/containerd')]
def default_inventory():
    return sorted((str(f),hashlib.sha256(f.read_bytes()).hexdigest()) for root in default_roots for f in root.rglob('*') if f.is_file())
baseline=default_inventory()
subprocess.run(['dockerd','--validate','--config-file='+str(root/'docker.json')],check=True)
with (p/'daemon.log').open('wb') as log:
    daemon=subprocess.Popen(['dockerd','--config-file='+str(root/'docker.json')],stdout=log,stderr=subprocess.STDOUT,env={**os.environ,'DOCKER_TMPDIR':str(p/'tmp')})
    try:
        for _ in range(60):
            if subprocess.run(worker.docker()+['info'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0: break
            if daemon.poll() is not None: raise RuntimeError((p/'daemon.log').read_text())
            time.sleep(0.5)
        else: raise RuntimeError((p/'daemon.log').read_text())
        info=json.loads(subprocess.check_output(worker.docker()+['info','--format','{{json .}}']))
        assert info['DockerRootDir']=='/probe-work/container-store' and info['Driver']=='overlay2'
        # A self-contained public-fixture rootfs: the image contains only bash and
        # its local shared-library dependencies, never project/private data.
        binary='/usr/bin/bash'
        ldd=subprocess.check_output(['ldd',binary],text=True)
        libs=re.findall(r'(/[\w/+.\-]+)',ldd)
        buf=io.BytesIO()
        with tarfile.open(fileobj=buf,mode='w') as tar:
            for file in [binary,*dict.fromkeys(libs)]: tar.add(pathlib.Path(file).resolve(),arcname=file.lstrip('/'),recursive=False)
        layer=buf.getvalue(); ld=hashlib.sha256(layer).hexdigest()
        config=json.dumps({'architecture':'arm64','os':'linux','config':{'Entrypoint':['/usr/bin/bash','-c']},'rootfs':{'type':'layers','diff_ids':['sha256:'+ld]}}).encode()
        cd=hashlib.sha256(config).hexdigest()
        def archive(layer_bytes=layer):
            manifest=json.dumps({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':'sha256:'+cd,'size':len(config)},'layers':[{'mediaType':'application/vnd.oci.image.layer.v1.tar','digest':'sha256:'+ld,'size':len(layer)}]}).encode()
            md=hashlib.sha256(manifest).hexdigest()
            index=json.dumps({'schemaVersion':2,'manifests':[{'mediaType':'application/vnd.oci.image.manifest.v1+json','digest':'sha256:'+md,'size':len(manifest),'annotations':{'org.opencontainers.image.ref.name':'public-fixture'}}]}).encode()
            path=p/('public-fixture-'+hashlib.sha256(layer_bytes).hexdigest()+'.oci.tar')
            with tarfile.open(path,'w') as tar:
                for name,data in [('oci-layout',b'{"imageLayoutVersion":"1.0.0"}'),('index.json',index),('blobs/sha256/'+md,manifest),('blobs/sha256/'+cd,config),('blobs/sha256/'+ld,layer_bytes)]:
                    ti=tarfile.TarInfo(name); ti.size=len(data); tar.addfile(ti,io.BytesIO(data))
            return path,'localhost/public-fixture@sha256:'+md
        archive_path,image=archive()
        image_id=worker.load_image(archive_path,image)
        assert image_id=='sha256:'+cd
        print('PASS: actual pinned Skopeo OCI conversion and Docker 25 config ID admission',flush=True)
        try: worker.load_image(archive_path,'localhost/public-fixture@sha256:'+'0'*64)
        except ValueError as e: assert str(e)=='IMAGE_DIGEST'
        else: raise AssertionError('wrong manifest accepted')
        print('PASS: mismatched manifest rejected',flush=True)
        # Remove imported image first so Docker cannot satisfy a damaged blob
        # from cache. Skopeo must detect its original manifest/layer mismatch.
        subprocess.run(worker.docker()+['image','rm','-f',image_id],check=True,stdout=subprocess.DEVNULL)
        bad_path,bad_image=archive(layer_bytes=b'x'+layer[1:])
        try: worker.load_image(bad_path,bad_image)
        except subprocess.CalledProcessError: pass
        else: raise AssertionError('corrupt layer accepted')
        print('PASS: corrupt layer rejected before execution',flush=True)
        image_id=worker.load_image(archive_path,image)
        # Exercise worker.sandbox exactly, with only resource ceilings lowered
        # to fit the local VM; production flags remain covered by unit tests.
        actual_run=worker.subprocess.run
        def limited(args,**kw):
            args=[{'--memory=112g':'--memory=256m','--memory-swap=112g':'--memory-swap=256m','--cpus=14':'--cpus=1','--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=4g':'--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m'}.get(a,a) for a in args]
            return actual_run(args,**kw)
        worker.subprocess.run=limited
        output=p/'output'; output.mkdir(mode=0o777);output.chmod(0o777)
        inputs=p/'input';inputs.mkdir(); (inputs/'test').write_text('fixed')
        command={'args':['[[ "$EUID" = 65534 ]] && [[ ! -w / ]] && [[ ! -w /input/test ]] && [[ ! -e /var/run/docker.sock ]] && [[ ! -e /probe-work/docker.sock ]] && printf ok > /output/result']}
        worker.sandbox(command,'public-fixture',[(inputs,'/input','ro'),(output,'/output','rw')],time.time()+30,image_id)
        assert (output/'result').read_text()=='ok'
        assert subprocess.check_output(worker.docker()+['ps','-aq']).strip()==b''
        print('PASS: sandbox immutable ID, noexec-backed overlay, nonroot/read-only bind/output and cleanup',flush=True)
        assert default_inventory()==baseline, 'Default daemon roots changed'
        # Docker-managed containerd must use both of the configured roots.
        generated=(p/'container-run/containerd/containerd.toml').read_text()
        assert '/probe-work/container-store/containerd/daemon' in generated
        assert '/probe-work/container-run/containerd/daemon' in generated
        print('PASS: daemon data/temp/state and managed containerd stay on disposable mount',flush=True)
        versions={tool:subprocess.check_output([tool,'--version'],text=True).strip() for tool in ('docker','dockerd','skopeo','containerd','runc')}
        pathlib.Path('/results/runtime-versions.json').write_text(json.dumps(versions,indent=2)+'\n')
    finally:
        for file in p.glob('*.log'): pathlib.Path('/results',file.name).write_bytes(file.read_bytes())
        daemon.terminate()
        try: daemon.wait(timeout=20)
        except subprocess.TimeoutExpired: daemon.kill();daemon.wait()
        pathlib.Path('/results/daemon.log').write_bytes((p/'daemon.log').read_bytes())
