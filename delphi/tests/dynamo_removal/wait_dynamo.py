"""Wait for the owned local DynamoDB service, never a default AWS endpoint."""
import time
from polismath.delphi_storage.legacy_import import local_client
client=local_client('http://127.0.0.1:8000')
last=None
for _ in range(60):
    try:
        client.list_tables()
        print('Local DynamoDB ready')
        break
    except Exception as exc:
        last=exc
        time.sleep(1)
else:
    raise RuntimeError('Owned DynamoDB did not become ready') from last
