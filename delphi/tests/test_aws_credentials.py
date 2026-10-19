"""Credential resolution must not manufacture an identity or mutate the environment."""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boto3
import pytest

from polismath.database.dynamodb import DynamoDBClient


@pytest.fixture
def role_endpoint(monkeypatch, tmp_path):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append(self.path)
            body = json.dumps({
                "AccessKeyId": "generated-role-id",
                "SecretAccessKey": "generated-role-secret",
                "Token": "generated-session-token",
                "Expiration": "2099-01-01T00:00:00Z",
            }).encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
                 "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_WEB_IDENTITY_TOKEN_FILE",
                 "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
                 "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", str(tmp_path / "no-credentials"))
    monkeypatch.setenv("AWS_CONFIG_FILE", str(tmp_path / "no-config"))
    monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
    monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", f"http://127.0.0.1:{server.server_port}/role")
    monkeypatch.setenv("DELPHI_RESULT_BACKEND", "dynamodb")
    monkeypatch.setattr(boto3, "DEFAULT_SESSION", None)
    yield calls
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.mark.parametrize("endpoint", [None, "http://127.0.0.1:9"])
@pytest.mark.parametrize("mode", ["absent", "empty", "environment", "explicit"])
def test_dynamodb_credentials(role_endpoint, monkeypatch, endpoint, mode):
    if mode == "environment":
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "generated-static-id")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "generated-static-secret")
    elif mode == "empty":
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "")
    kwargs = {}
    if mode == "explicit":
        kwargs = {"aws_access_key_id": "generated-explicit-id",
                  "aws_secret_access_key": "generated-explicit-secret"}
    before = dict(os.environ)
    client = DynamoDBClient(endpoint_url=endpoint, **kwargs)
    monkeypatch.setattr(client, "_ensure_tables_exist", lambda: None)
    client.initialize()
    credentials = client.dynamodb.meta.client._request_signer._credentials.get_frozen_credentials()
    assert dict(os.environ) == before
    if mode in ("environment", "explicit"):
        label = "static" if mode == "environment" else "explicit"
        assert credentials.access_key == f"generated-{label}-id"
        assert credentials.secret_key == f"generated-{label}-secret"
        assert not role_endpoint
    else:
        assert credentials.access_key == "generated-role-id"
        assert credentials.token == "generated-session-token"
        assert role_endpoint == ["/role"]
    client.dynamodb.meta.client.close()


@pytest.mark.parametrize("mode", ["absent", "empty", "environment"])
@pytest.mark.parametrize("factory", ["minio", "census"])
def test_script_factories_use_the_chain(role_endpoint, monkeypatch, mode, factory):
    from unittest.mock import Mock

    if mode == "environment":
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "generated-static-id")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "generated-static-secret")
    elif mode == "empty":
        monkeypatch.setenv("AWS_ACCESS_KEY_ID", "")
        monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "")
    before = dict(os.environ)
    if factory == "census":
        from polismath.job_child.census import default_dynamodb
        monkeypatch.setenv("DYNAMODB_ENDPOINT", "http://127.0.0.1:9")
        before = dict(os.environ)
        api = default_dynamodb().meta.client
    else:
        import setup_minio
        real_client = boto3.client
        clients = []

        def capture(*args, **kwargs):
            clients.append(real_client(*args, **kwargs))
            return Mock()

        monkeypatch.setattr(boto3, "client", capture)
        setup_minio.setup_minio_bucket("generated-bucket")
        assert len(clients) == 1
        api = clients[0]
    credentials = api._request_signer._credentials.get_frozen_credentials()
    assert dict(os.environ) == before
    assert credentials.access_key == ("generated-static-id" if mode == "environment" else "generated-role-id")
    assert credentials.token == (None if mode == "environment" else "generated-session-token")
    assert len(role_endpoint) == (0 if mode == "environment" else 1)
    api.close()
