"""Version/secret/connection boundary of the instance CLI, without cloud calls."""
import copy
import datetime as dt
import json
import unittest
from unittest.mock import Mock, patch
from provision_login import execute
from worker import absolute_deadline


class ProvisionTests(unittest.TestCase):
    def setup(self):
        boot=dict(adminSecretArn='admin',secretArn='reader',replicaHost='primary.invalid',database='test',
                  owner='polis-probe-login:test',provision=dict(adminVersion='a'*32,readerVersion='b'*32))
        def read(SecretId,VersionId):
            return dict(VersionId=VersionId,SecretString=json.dumps(dict(username='polis_probe_reader' if SecretId=='reader' else 'admin',password='test-only-value')))
        client=Mock();client.get_secret_value.side_effect=read
        return boot,client,Mock()

    def test_exact_version_memory_only_and_tls_connection(self):
        boot,client,connect=self.setup()
        with patch('provision_login.provision') as operation:execute(boot,client,connect)
        self.assertEqual([c.kwargs for c in client.get_secret_value.call_args_list],[dict(SecretId='admin',VersionId='a'*32),dict(SecretId='reader',VersionId='b'*32)])
        self.assertEqual(connect.call_args.kwargs['sslmode'],'verify-full')
        self.assertEqual(connect.call_args.kwargs['sslrootcert'],'/opt/polis-probe/rds-ca.pem')
        operation.assert_called_once_with(connect.return_value,'test-only-value','test','polis-probe-login:test')
        connect.return_value.close.assert_called_once()

    def test_secret_version_mismatch_never_connects(self):
        boot,client,connect=self.setup();client.get_secret_value.side_effect=None
        client.get_secret_value.return_value=dict(VersionId='wrong',SecretString='{}')
        with self.assertRaisesRegex(ValueError,'SECRET_VERSION'):execute(boot,client,connect)
        connect.assert_not_called()

    def test_reader_identity_substitution_never_connects(self):
        boot,client,connect=self.setup()
        def read(SecretId,VersionId):return dict(VersionId=VersionId,SecretString=json.dumps(dict(username='admin',password='test-only-value')))
        client.get_secret_value.side_effect=read
        with self.assertRaisesRegex(ValueError,'READER_SECRET'):execute(boot,client,connect)
        connect.assert_not_called()

    def test_failure_closes_connection(self):
        boot,client,connect=self.setup()
        with patch('provision_login.provision',side_effect=ValueError('FOREIGN_READER_ROLE')):
            with self.assertRaisesRegex(ValueError,'FOREIGN'):execute(boot,client,connect)
        connect.return_value.close.assert_called_once()

    def test_deadline_bound_to_original_admission_not_reconnect(self):
        expiry=dt.datetime.fromtimestamp(4600,dt.timezone.utc).isoformat()
        boot=dict(started=1000,terminateBy=4600,admission=dict(started=1000,expiresAt=expiry))
        self.assertEqual(absolute_deadline(boot,3600),4600)
        for field in ('started','terminateBy','admission-start','expiry','nonfinite'):
            b=copy.deepcopy(boot)
            if field=='started':b['started']+=1
            elif field=='terminateBy':b['terminateBy']+=1
            elif field=='admission-start':b['admission']['started']+=1
            elif field=='expiry':b['admission']['expiresAt']='2030-01-01T00:00:00+00:00'
            else:b['started']=float('nan')
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'DEADLINE_BINDING'):absolute_deadline(b,3600)
