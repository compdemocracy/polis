"""Layer pin refusal and archive controls; actual native checks run in the builder."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import ssl
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parent/'layer'


def module(name):
    spec = importlib.util.spec_from_file_location('probe_layer_'+name, HERE/(name+'.py'))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


build, runtime = module('build'), module('runtime')


class LayerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.lock = json.loads((HERE/'lock.json').read_text())

    def pin(self, raw=b'public package'):
        return dict(filename='package.whl', url='https://files.pythonhosted.org/package.whl',
                    bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())

    def test_reviewed_lock_and_requirements_agree(self):
        build.validate(self.lock)
        w = self.lock['wheel']
        self.assertEqual((HERE/'requirements.lock').read_text(), f"psycopg2-binary=={w['version']} --hash=sha256:{w['sha256']}\n")

    def test_wrong_runtime_origin_or_architecture_refuses(self):
        mutations = [('runtime','image','public.ecr.aws/lambda/python:3.12-arm64'),
                     ('runtime','python','3.13'),('runtime','architecture','x86_64'),
                     ('runtime','config_sha256',''),('wheel','filename','../../x.whl'),
                     ('wheel','url','https://unreviewed.invalid/package.whl'),
                     ('wheel','sha256','0'),('wheel','bytes',True),
                     ('ca','url','https://unreviewed.invalid/ca.pem'),('ca','certificates',0)]
        for group,key,value in mutations:
            with self.subTest(group=group,key=key):
                changed = copy.deepcopy(self.lock);changed[group][key]=value
                with self.assertRaises(ValueError):build.validate(changed)

    def test_unknown_lock_field_refuses(self):
        self.lock['override']='mutable'
        with self.assertRaisesRegex(ValueError,'LOCK_FIELDS'):build.validate(self.lock)

    def test_cached_inputs_are_verified_without_network(self):
        pin=self.pin();(self.root/pin['filename']).write_bytes(b'public package')
        with patch.object(build.urllib.request,'urlopen',side_effect=AssertionError('network forbidden')):
            self.assertEqual(build.acquire(self.root,pin,offline=True).read_bytes(),b'public package')

    def test_corrupt_cache_is_never_silently_replaced(self):
        pin=self.pin();(self.root/pin['filename']).write_bytes(b'forged package')
        with patch.object(build.urllib.request,'urlopen',side_effect=AssertionError('no replacement')):
            with self.assertRaisesRegex(ValueError,'CACHED_INPUT_MISMATCH'):build.acquire(self.root,pin)

    def test_symlink_cache_refuses(self):
        pin=self.pin();(self.root/'target').write_bytes(b'public package')
        (self.root/pin['filename']).symlink_to(self.root/'target')
        with self.assertRaisesRegex(ValueError,'INPUT_SYMLINK'):build.acquire(self.root,pin,offline=True)

    def test_offline_missing_input_refuses(self):
        with self.assertRaisesRegex(ValueError,'OFFLINE_INPUT_MISSING'):build.acquire(self.root,self.pin(),offline=True)

    def test_remote_wrong_digest_or_size_leaves_no_file(self):
        for raw in (b'forged package',b'x'*100):
            with patch.object(build.urllib.request,'urlopen',return_value=io.BytesIO(raw)):
                with self.assertRaisesRegex(ValueError,'DOWNLOADED_INPUT_MISMATCH'):build.acquire(self.root,self.pin())
            self.assertEqual(list(self.root.iterdir()),[])

    def test_native_header_requires_linux_arm64(self):
        raw=bytearray(20);raw[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',raw,18,183)
        runtime.elf_arm64(raw)
        for forged in (b'\xcf\xfa\xed\xfe'+bytes(20),raw[:18]+b'\x3e\x00',raw[:5]+b'\x02'+raw[6:]):
            with self.assertRaises(ValueError):runtime.elf_arm64(forged)

    def test_archive_is_independent_of_order_mtime_and_permissions(self):
        roots=[self.root/'a',self.root/'b']
        for i,root in enumerate(roots):
            (root/'python').mkdir(parents=True)
            for name in (['b.py','a.py'] if i else ['a.py','b.py']):
                p=root/'python'/name;p.write_text(name);p.chmod(0o600 if i else 0o744)
                os.utime(p,(100+i,200+i))
            (root/'rds-ca.pem').write_bytes(b'public test bytes')
            runtime.pack(root,self.root/f'{i}.zip')
        self.assertEqual((self.root/'0.zip').read_bytes(),(self.root/'1.zip').read_bytes())
        with zipfile.ZipFile(self.root/'0.zip') as archive:
            self.assertIn('python/',archive.namelist())
            self.assertIn('rds-ca.pem',archive.namelist())
            self.assertTrue(all(i.date_time==runtime.ZIP_TIME for i in archive.infolist()))

    def test_archive_rejects_bytecode_symlinks_and_nonregular_files(self):
        for kind in ('bytecode','symlink','fifo'):
            root=self.root/kind;root.mkdir()
            if kind=='bytecode':(root/'code.pyc').write_bytes(b'cached')
            elif kind=='symlink':(root/'link').symlink_to('/not-a-layer-member')
            else:os.mkfifo(root/'pipe')
            with self.assertRaises(ValueError):runtime.pack(root,self.root/f'{kind}.zip')

    def test_archive_paths_cannot_escape(self):
        for name in ('/absolute','../parent','python/../x','python//x','python\\x','x\x00y',''):
            with self.assertRaises(ValueError):runtime.safe_name(name)

    def test_invalid_ca_and_private_key_material_refuse(self):
        bad=[b'not a certificate',b'-----BEGIN CERTIFICATE-----\nPRIVATE KEY',
             b'-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----']
        for raw in bad:
            with self.assertRaises((ValueError,ssl.SSLError)):runtime.ca_count(raw,1)


class PublishCommandTests(unittest.TestCase):
    def setUp(self):
        self.publisher=module('publish_command')
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.lock=json.loads((HERE/'lock.json').read_text())
        self.raw=b'fixture-archive'
        self.lock['archive_sha256']=hashlib.sha256(self.raw).hexdigest()
        self.recipe=self.root/'recipe';self.recipe.mkdir()
        for n in ('build.py','runtime.py','requirements.lock'):(self.recipe/n).write_bytes((HERE/n).read_bytes())
        (self.recipe/'lock.json').write_text(json.dumps(self.lock))
        (self.root/'provision_login.py').write_bytes((HERE.parent/'provision_login.py').read_bytes())
        self.patch=patch.object(self.publisher,'HERE',self.recipe);self.patch.start();self.addCleanup(self.patch.stop)
        self.artifact=self.root/'artifact with spaces';self.artifact.mkdir()
        (self.artifact/self.lock['archive']).write_bytes(self.raw)
        sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
        self.receipt=dict(schema='polis-probe-login-layer-build/1',published=False,zip_sha256=self.lock['archive_sha256'],
            zip_bytes=len(self.raw),lock_sha256=sha(self.recipe/'lock.json'),runtime_image=self.lock['runtime']['image'],
            runtime_image_id='sha256:'+self.lock['runtime']['config_sha256'],
            source_sha256={n:sha(self.recipe/n) for n in ('build.py','runtime.py','requirements.lock','lock.json')},
            handler_sha256=sha(self.root/'provision_login.py'),native_check=dict(zip_sha256=self.lock['archive_sha256'],
                architecture='aarch64',python='3.12.14',psycopg2=self.lock['wheel']['version'],handler_import=True,
                ca_certificates=self.lock['ca']['certificates']))
        self.save()

    def save(self):
        (self.artifact/'build-receipt.json').write_text(json.dumps(self.receipt))

    def test_printed_command_preserves_paths_and_profile_without_execution(self):
        import shlex
        with patch.object(os,'system',side_effect=AssertionError('execution forbidden')):
            text,_=self.publisher.command(self.artifact,'profile with spaces','us-east-1','test-layer')
        args=shlex.split(text)
        self.assertEqual(args[:3],['aws','lambda','publish-layer-version'])
        self.assertEqual(args[args.index('--profile')+1],'profile with spaces')
        self.assertEqual(args[args.index('--zip-file')+1],'fileb://'+str(self.artifact.resolve()/self.lock['archive']))
        self.assertEqual(args[args.index('--compatible-architectures')+1],'arm64')

    def test_modified_zip_cannot_produce_publication_command(self):
        (self.artifact/self.lock['archive']).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'ZIP_SHA256_MISMATCH'):
            self.publisher.command(self.artifact,'profile','us-east-1','test-layer')

    def test_missing_native_proof_or_source_drift_refuses(self):
        self.receipt['native_check']['handler_import']=False;self.save()
        with self.assertRaisesRegex(ValueError,'NATIVE_CHECK_REQUIRED'):
            self.publisher.command(self.artifact,'profile','us-east-1','test-layer')
        self.receipt['native_check']['handler_import']=True;self.save()
        (self.recipe/'runtime.py').write_text('changed')
        with self.assertRaisesRegex(ValueError,'BUILD_SOURCE_CHANGED'):
            self.publisher.command(self.artifact,'profile','us-east-1','test-layer')


if __name__=='__main__':unittest.main()
