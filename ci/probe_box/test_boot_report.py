"""Early boot evidence must not depend on importing the worker."""
import json
from pathlib import Path
import subprocess
import sys
import shlex
import tempfile
import unittest
from unittest.mock import Mock, patch

import boot_report

KEY = 'arn:aws:kms:us-east-1:111111111111:key/11111111-1111-1111-1111-111111111111'
IDENTITY = dict(accountId='111111111111', region='us-east-1', instanceId='i-00000000000000001')
CONFIG = dict(mode='worker', account=IDENTITY['accountId'], region=IDENTITY['region'],
              controlBucket='public-fixture-control', controlKey=KEY,
              ec2Url='https://public-fixture.ec2.vpce.amazonaws.com',
              dnsNames=['public-fixture.ec2.vpce.amazonaws.com'], resolver='10.0.0.2')


class BootReportTests(unittest.TestCase):
    def test_import_is_independent_of_worker_and_sdk(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'boot_report.py').write_bytes(Path(boot_report.__file__).read_bytes())
            code="import sys; sys.path.insert(0,sys.argv[1]); import boot_report; assert 'worker' not in sys.modules; assert 'boto3' not in sys.modules"
            p=subprocess.run([sys.executable,'-I','-B','-c',code,tmp],capture_output=True,timeout=10)
            self.assertEqual(p.returncode,0,p.stderr)

    def test_shell_reports_actual_worker_import_failure_before_poweroff(self):
        bake=Path(boot_report.__file__).with_name('bake.sh').read_text()
        start=bake.split("<<'START'\n",1)[1].split('\nSTART',1)[0]
        trap=next(line for line in start.splitlines() if line.startswith("trap 'rc=$?"))
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'worker.py').write_text('import missing_public_fixture_module\n')
            script='set -e\nBOOT_PHASE=worker\nboot_failure() { echo "$BOOT_PHASE:nonzero"; }\nsystemctl() { echo "$*"; }\n'+trap+'\n'
            script+=shlex.quote(sys.executable)+' -I -B '+shlex.quote(str(root/'worker.py'))+' 2>/dev/null\n'
            result=subprocess.run(['bash','-c',script],capture_output=True,text=True,timeout=5)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stdout,'worker:nonzero\npoweroff\n')
        # Bootstrap metadata and failure reporting share no worker import.
        self.assertNotIn('from worker import',start)
        self.assertIn('from boot_report import metadata, validate_bootstrap',start)

    def invoke(self, phase='worker', status='nonzero', s3_error=False, tag_error=False, config=None, sink=None):
        import boto3
        s3,ec2=sink if sink is not None else Mock(),Mock()
        if s3_error:s3.put_object.side_effect=RuntimeError('private text')
        if tag_error:ec2.create_tags.side_effect=RuntimeError('private text')
        def metadata(path):
            return json.dumps(IDENTITY if path.startswith('dynamic/') else config or CONFIG).encode()
        with patch.object(boot_report,'metadata',side_effect=metadata), \
             patch.object(boto3,'client',side_effect=lambda service,**kw:s3 if service=='s3' else ec2):
            boot_report.report(phase,status)
        return s3,ec2

    def test_closed_record_has_required_key_and_independent_tag(self):
        s3,ec2=self.invoke()
        kw=s3.put_object.call_args.kwargs
        self.assertEqual(kw['SSEKMSKeyId'],KEY)
        self.assertEqual(kw['ServerSideEncryption'],'aws:kms')
        self.assertEqual(kw['IfNoneMatch'],'*')
        self.assertEqual(json.loads(kw['Body']),dict(schema='polis-probe-boot-failure/2',phase='worker',exit='nonzero'))
        self.assertTrue(kw['Key'].startswith('heartbeats/boot/'))
        ec2.create_tags.assert_called_once_with(Resources=[IDENTITY['instanceId']],Tags=[{'Key':'polis-probe-pulse','Value':'boot-failure:worker:nonzero'}])

    def test_existing_worker_failure_survives_boot_report(self):
        import worker
        from test_run import S3
        s3=S3()
        key=f"heartbeats/boot/arn:aws:ec2:{IDENTITY['region']}:{IDENTITY['accountId']}:instance/{IDENTITY['instanceId']}.json"
        diagnostics=worker.Diagnostics()
        diagnostics.bind(s3,CONFIG['controlBucket'],key,KEY)
        diagnostics.fail(ValueError('BOOT_BINDING'))
        first=s3.objects[CONFIG['controlBucket'],key]
        self.assertEqual(json.loads(first)['schema'],'polis-probe-failure/1')
        with patch.object(s3,'put_object',wraps=s3.put_object) as put:
            _,ec2=self.invoke(sink=s3)
        put.assert_called_once()
        self.assertEqual(put.call_args.kwargs['IfNoneMatch'],'*')
        self.assertEqual(s3.objects[CONFIG['controlBucket'],key],first)
        self.assertEqual(len(s3.puts),1)  # the second request was refused
        ec2.create_tags.assert_called_once()

    def test_second_boot_report_preserves_first_report(self):
        from test_run import S3
        s3=S3()
        self.invoke(phase='dns',sink=s3)
        first=dict(s3.objects)
        self.assertEqual(len(first),1)
        self.invoke(phase='worker',sink=s3)
        self.assertEqual(s3.objects,first)
        self.assertEqual(len(s3.puts),1)

    def test_s3_failure_still_tags(self):
        s3,ec2=self.invoke(s3_error=True)
        s3.put_object.assert_called_once();ec2.create_tags.assert_called_once()

    def test_tag_failure_still_writes_s3(self):
        s3,ec2=self.invoke(tag_error=True)
        s3.put_object.assert_called_once();ec2.create_tags.assert_called_once()

    def test_unknown_phase_or_exit_exports_nothing(self):
        for phase,status in [('private data','nonzero'),('worker','private data'),('worker','0')]:
            s3,ec2=self.invoke(phase,status)
            s3.put_object.assert_not_called();ec2.create_tags.assert_not_called()

    def test_bad_key_and_identity_refused(self):
        for change in ({'controlKey':'wrong'},{'controlKey':KEY.replace('111111111111','222222222222')},{'account':'222222222222'}):
            s3,ec2=self.invoke(config={**CONFIG,**change})
            s3.put_object.assert_not_called();ec2.create_tags.assert_not_called()

    def test_worker_startup_exception_reports_before_poweroff(self):
        import worker
        d=worker.Diagnostics()
        with patch.object(worker,'Diagnostics',return_value=d),patch.object(worker,'run',side_effect=RuntimeError('private')), \
             patch.object(worker.subprocess,'run') as run:
            worker.main()
        self.assertEqual(run.call_args_list[0].args[0], [sys.executable,str(worker.ROOT/'boot_report.py'),'worker','nonzero'])
        self.assertEqual(run.call_args_list[0].kwargs['timeout'],30)
        self.assertEqual(run.call_args_list[1].args[0],['systemctl','poweroff'])

    def test_bound_but_unwritable_sink_still_uses_boot_fallback(self):
        import worker
        d=worker.Diagnostics(); sink=Mock(); sink.put_object.side_effect=RuntimeError('private')
        d.bind(sink,'public-fixture-control','heartbeat',KEY)
        with patch.object(worker,'Diagnostics',return_value=d),patch.object(worker,'run',side_effect=RuntimeError('private')), \
             patch.object(worker.subprocess,'run') as run:
            worker.main()
        self.assertEqual(run.call_args_list[0].args[0][-3:],[str(worker.ROOT/'boot_report.py'),'worker','nonzero'])
        self.assertEqual(run.call_args_list[-1].args[0],['systemctl','poweroff'])

    def test_reporter_timeout_does_not_prevent_poweroff(self):
        import worker
        with patch.object(worker,'run',side_effect=RuntimeError('private')), \
             patch.object(worker.subprocess,'run',side_effect=[subprocess.TimeoutExpired('report',30),None]) as run:
            worker.main()
        self.assertEqual(run.call_args.args[0],['systemctl','poweroff'])

    def test_v2_operator_reads_s3_and_persists_terminal_tag(self):
        import run as operator
        from test_run import session_setup,encoded
        from test_boundaries import job
        for channel in ('s3','tag'):
            x,c,e,s,i=session_setup();x.start(job());i['State']['Name']='terminated'
            record={'schema':'polis-probe-boot-failure/2','phase':'boot-config','exit':'nonzero'}
            if channel=='s3':
                s.objects['control','heartbeats/boot/arn:aws:ec2:us-east-1:111111111111:instance/i-test.json']=encoded(record)
            else:
                i['Tags'].append({'Key':'polis-probe-pulse','Value':'boot-failure:boot-config:nonzero'})
            expected={'stage':'boot','phase':'boot-config','exit':'nonzero'}
            self.assertEqual(x.status(job()['run_id'])['failure'],expected)
            if channel=='tag':
                i['Tags']=[t for t in i['Tags'] if t['Key']!='polis-probe-pulse']
                self.assertEqual(x.status(job()['run_id'])['failure'],expected)

    def test_pulsed_then_killed_preserves_last_stage_over_boot_fallback(self):
        import worker
        from test_run import session_setup,encoded
        from test_boundaries import job
        for channel in ('s3','tag','both'):
            with self.subTest(channel=channel):
                x,c,e,s,i=session_setup();x.start(job())
                arn='arn:aws:ec2:us-east-1:111111111111:instance/i-test'
                key='heartbeats/'+job()['run_id']+'/'+arn+'.json'
                diagnostics=worker.Diagnostics()
                diagnostics.bind(s,'control',key,KEY)
                diagnostics.enter('producer','execute')
                for _ in range(3):
                    c.now+=60
                    diagnostics.pulse()
                pulse=json.loads(s.objects['control',key])
                self.assertEqual(pulse['pulse'],3)
                # SIGKILL cannot call Diagnostics.fail; the shell writes only
                # its coarse worker/nonzero marker after the last real pulse.
                i['State']['Name']='terminated'
                if channel in ('tag','both'):
                    i['Tags'].append({'Key':'polis-probe-pulse','Value':'boot-failure:worker:nonzero'})
                if channel in ('s3','both'):
                    s.objects['control','heartbeats/boot/'+arn+'.json']=encoded(
                        {'schema':'polis-probe-boot-failure/2','phase':'worker','exit':'nonzero'})
                result=x.status(job()['run_id'])
                self.assertEqual(result['failure'],pulse)
                self.assertTrue(result['complete'])
                self.assertFalse(result['passed'])
                self.assertEqual(x.active()[0]['phase'],'CLEAN')
                # Disposal/status rereads retain the actual stage too.
                self.assertEqual(x.status(job()['run_id'])['failure'],pulse)

    def test_saved_pulse_survives_mailbox_loss_and_boot_fallback(self):
        from test_run import session_setup,encoded,Unknown
        from test_boundaries import job
        x,c,e,s,i=session_setup();x.start(job())
        arn='arn:aws:ec2:us-east-1:111111111111:instance/i-test'
        key='heartbeats/'+job()['run_id']+'/'+arn+'.json'
        pulse={'stage':'producer','phase':'execute','pulse':31}
        s.objects['control',key]=encoded(pulse)
        with self.assertRaisesRegex(Unknown,'TERMINATION_PENDING'):
            x.status(job()['run_id'],cancel=True)
        del s.objects['control',key]
        i['State']['Name']='terminated'
        i['Tags'].append({'Key':'polis-probe-pulse','Value':'boot-failure:worker:nonzero'})
        s.objects['control','heartbeats/boot/'+arn+'.json']=encoded(
            {'schema':'polis-probe-boot-failure/2','phase':'worker','exit':'nonzero'})
        self.assertEqual(x.status(job()['run_id'])['failure'],pulse)

    def test_real_bash_console_emits_only_closed_phase_exit_tokens(self):
        bake=Path(boot_report.__file__).with_name('bake.sh').read_text()
        start=bake.split("<<'START'\n",1)[1].split('\nSTART',1)[0]
        console_function=start[start.index('boot_console() {'):start.index('boot_failure() {')]
        with tempfile.TemporaryDirectory() as tmp:
            console=Path(tmp)/'console'
            # Redirect only the device; execute the actual baked function.
            function=console_function.replace('/dev/console',shlex.quote(str(console)))
            for phase in sorted(boot_report.PHASES):
                for status in ('entry','nonzero'):
                    with self.subTest(phase=phase,status=status):
                        script=f'set -euo pipefail\n{function}\nBOOT_PHASE={phase}\nboot_console {status}\n'
                        result=subprocess.run(['bash','-c',script],capture_output=True,text=True,timeout=5)
                        self.assertEqual(result.returncode,0,result.stderr)
                        self.assertEqual(result.stdout+result.stderr,'')
                        self.assertEqual(console.read_text(),f'POLIS_PROBE_BOOT/1 {phase} {status}\n')
            for phase,status in [('private text','nonzero'),('dns','private text')]:
                console.write_text('unchanged')
                script=f'set -euo pipefail\n{function}\nBOOT_PHASE={shlex.quote(phase)}\nboot_console {shlex.quote(status)}\n'
                result=subprocess.run(['bash','-c',script],capture_output=True,text=True,timeout=5)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(result.stdout+result.stderr,'')
                self.assertEqual(console.read_text(),'unchanged')

    def test_terminal_tag_cannot_be_liveness_or_carry_free_text(self):
        import run as operator
        for value in ('boot-failure:worker:nonzero','boot-failure:private:nonzero','boot-failure:worker:private'):
            i={'Tags':[{'Key':'polis-probe-pulse','Value':value}]}
            self.assertIsNone(operator.clean_pulse_tag(i))
            self.assertEqual(operator.clean_boot_tag(i) is not None,value=='boot-failure:worker:nonzero')
        good={'Key':'polis-probe-pulse','Value':'boot-failure:worker:nonzero'}
        self.assertIsNone(operator.clean_boot_tag({'Tags':[good,good]}))

    def test_boot_record_is_exact_and_closed(self):
        import run as operator
        good={'schema':'polis-probe-boot-failure/2','phase':'worker','exit':'nonzero'}
        self.assertEqual(operator.clean_boot_failure(good),{'stage':'boot','phase':'worker','exit':'nonzero'})
        for change in ({'extra':'private'},{'phase':'private'},{'exit':'private'},{'schema':'wrong'}):
            self.assertIsNone(operator.clean_boot_failure({**good,**change}))
