"""Digest-bound OCI conversion, private daemon and sandbox failure controls."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import worker


class RuntimeTests(unittest.TestCase):
    config = 'sha256:'+'c'*64

    def manifest(self, **changes):
        return dict(schemaVersion=2, mediaType='application/vnd.oci.image.manifest.v1+json',
                    config={'digest': self.config}, layers=[], **changes)

    def load(self, manifest=None, info=None, digest=None):
        raw = json.dumps(manifest or self.manifest()).encode()
        image = 'localhost/probe@sha256:'+(digest or hashlib.sha256(raw).hexdigest())
        info = info or {'Id': self.config, 'Architecture': 'arm64', 'Os': 'linux'}
        with patch.object(worker.subprocess, 'check_output', side_effect=[raw, json.dumps([info]).encode()]) as inspect, \
                patch.object(worker.subprocess, 'run') as copy:
            result = worker.load_image(Path('/probe-work/image.oci.tar'), image)
            return result, inspect.call_args_list, copy.call_args

    def test_oci_manifest_bound_to_loaded_config_without_registry_pull(self):
        result, inspect, copy = self.load()
        self.assertEqual(result, self.config)
        self.assertEqual(inspect[0].args[0], ['skopeo', 'inspect', '--raw', 'oci-archive:/probe-work/image.oci.tar'])
        self.assertEqual(inspect[1].args[0], worker.docker()+['image', 'inspect', self.config])
        argv = copy.args[0]
        self.assertEqual(argv[:6], ['skopeo', '--policy', '/opt/polis-probe/image-policy.json', 'copy',
                                    '--dest-daemon-host', 'unix:///probe-work/docker.sock'])
        self.assertTrue(argv[-1].startswith('docker-daemon:polis-probe-import:'))
        self.assertEqual(copy.kwargs['env']['TMPDIR'], '/probe-work/tmp')
        self.assertTrue(copy.kwargs['check'])

    def test_wrong_manifest_refuses_before_copy(self):
        with patch.object(worker.subprocess, 'check_output', return_value=b'wrong manifest'), \
                patch.object(worker.subprocess, 'run') as copy:
            with self.assertRaisesRegex(ValueError, 'IMAGE_DIGEST'):
                worker.load_image(Path('/probe-work/image.oci.tar'), 'localhost/probe@sha256:'+'0'*64)
            copy.assert_not_called()

    def test_index_and_invalid_config_refuse(self):
        for field, value in [('mediaType', 'application/vnd.oci.image.index.v1+json'),
                             ('schemaVersion', 1), ('config', {'digest': 'sha256:short'})]:
            with self.subTest(field=field):
                m = self.manifest(); m[field] = value
                with self.assertRaisesRegex(ValueError, 'IMAGE_MANIFEST|IMAGE_CONFIG'):
                    self.load(manifest=m)

    def test_loaded_config_id_and_platform_must_match(self):
        for field, value in [('Id', 'sha256:'+'d'*64), ('Architecture', 'amd64'), ('Os', 'windows')]:
            with self.subTest(field=field):
                info = {'Id': self.config, 'Architecture': 'arm64', 'Os': 'linux'}; info[field] = value
                with self.assertRaisesRegex(ValueError, 'IMAGE_CONFIG'):
                    self.load(info=info)

    def test_copy_failure_propagates_without_inspection(self):
        raw = json.dumps(self.manifest()).encode()
        with patch.object(worker.subprocess, 'check_output', return_value=raw) as inspect, \
                patch.object(worker.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'copy')):
            with self.assertRaises(subprocess.CalledProcessError):
                worker.load_image(Path('/probe-work/image.oci.tar'), 'localhost/probe@sha256:'+hashlib.sha256(raw).hexdigest())
            self.assertEqual(inspect.call_count, 1)

    def sandbox(self, state=None, failure=None):
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker, 'SCRATCH', Path(tmp)), \
                patch.object(worker.subprocess, 'run', side_effect=[failure or SimpleNamespace(returncode=0), SimpleNamespace(returncode=0)]) as run, \
                patch.object(worker.subprocess, 'check_output', return_value=json.dumps([{'State': state or {'ExitCode': 0, 'OOMKilled': False}}]).encode()):
            try:
                worker.sandbox({'image': 'unused:mutable', 'args': ['probe']}, 'test',
                               [(Path(tmp)/'input', '/input', 'ro'), (Path(tmp)/'output', '/output', 'rw')],
                               time.time()+30, self.config)
            finally:
                self.assertEqual(run.call_args.args[0][-3:], ['rm', '--force', 'polis-probe-test'])
            return run.call_args_list[0].args[0]

    def test_sandbox_uses_id_and_preserves_limits_and_bind_modes(self):
        argv = self.sandbox()
        for flag in ['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
                     '--security-opt=no-new-privileges', '--user=65534:65534', '--pids-limit=4096',
                     '--memory=112g', '--memory-swap=112g', '--cpus=14', '--ulimit=core=0:0',
                     '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=4g']:
            self.assertIn(flag, argv)
        self.assertEqual(argv[-2:], [self.config, 'probe'])
        self.assertNotIn('unused:mutable', argv)
        binds = [argv[i+1] for i, arg in enumerate(argv) if arg == '--mount']
        self.assertTrue(binds[0].endswith(',readonly'))
        self.assertFalse(binds[1].endswith(',readonly'))
        self.assertTrue(all('bind-propagation=rprivate' in bind for bind in binds))

    def test_failed_oom_and_nonzero_containers_are_removed(self):
        for state in [{'ExitCode': 1}, {'ExitCode': 0, 'OOMKilled': True}]:
            with self.subTest(state=state), self.assertRaisesRegex(ValueError, 'PROBE_EXECUTION_FAILED'):
                self.sandbox(state=state)
        with self.assertRaises(subprocess.TimeoutExpired):
            self.sandbox(failure=subprocess.TimeoutExpired('run', 1))

    def test_sandbox_refuses_mutable_image_before_execution(self):
        with patch.object(worker.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'IMAGE_CONFIG'):
                worker.sandbox({'args': []}, 'test', [], time.time()+1, 'image:latest')
            run.assert_not_called()

    def test_daemon_never_uses_root_disk_system_containerd_or_network(self):
        bake = Path(__file__).with_name('bake.sh').read_text()
        config = json.loads(bake.split("<<'DOCKER'\n")[1].split('\nDOCKER')[0])
        for key in ['data-root', 'exec-root', 'pidfile']:
            self.assertTrue(config[key].startswith('/probe-work/'))
        self.assertEqual(config['hosts'], ['unix:///probe-work/docker.sock'])
        self.assertNotIn('containerd', config)
        self.assertEqual(config['storage-driver'], 'overlay2')
        self.assertEqual(config['bridge'], 'none')
        for key in ['iptables', 'ip6tables', 'ip-forward', 'ip-masq', 'userland-proxy']:
            self.assertIs(config[key], False)
        self.assertEqual(config['log-driver'], 'none')
        self.assertIn('ConditionPathIsMountPoint=/probe-work', bake)
        self.assertLess(bake.index('mount -o nodev,nosuid,noexec'), bake.index('systemctl start polis-probe-container.service'))
        self.assertIn('mask swap.target docker.service docker.socket containerd.service', bake)
        policy = json.loads(bake.split("<<'POLICY'\n")[1].split('\nPOLICY')[0])
        self.assertEqual(policy['default'], [{'type': 'reject'}])
        self.assertEqual(set(policy['transports']), {'oci-archive'})
