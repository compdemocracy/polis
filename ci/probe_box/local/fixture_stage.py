"""Public-only stages for testing worker plumbing; no science admission claim."""
import hashlib
import fcntl
import struct
import json
import os
import socket
from pathlib import Path
import sys


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def main():
    assert os.getuid() == 65534
    assert not Path('/probe-work/docker.sock').exists()
    assert not Path('/var/run/docker.sock').exists()
    # Linux can expose DOWN tunnel devices in a network=none namespace.
    # Require only loopback UP and no IPv4 route, not an exact device census.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        up = {name for _, name in socket.if_nameindex()
              if struct.unpack_from('H', fcntl.ioctl(sock, 0x8913,
                  struct.pack('256s', name.encode())), 16)[0] & 1}
    assert up <= {'lo'}, sorted(up)
    assert len(Path('/proc/net/route').read_text().splitlines()) == 1
    action = sys.argv[1]
    if action in ('read', 'fail'):
        import psycopg2
        # Produce a real class + closed reason through last_exception_token.
        conn = psycopg2.connect(service='probe', connect_timeout=5)
        with conn, conn.cursor() as cur:
            cur.execute("SELECT current_user, current_setting('default_transaction_read_only'), 42")
            assert cur.fetchone() == ('polis_probe_reader', 'on', 42)
        conn.close()
        if action == 'fail':
            raise FileNotFoundError('No such file or directory: public-fixture-only')
        Path('/output/value.json').write_bytes(encoded({'value':42}))
        Path('/output/inputs.json').write_bytes(b'{}')
    elif action == 'produce':
        assert json.loads(Path('/input/value.json').read_bytes()) == {'value':42}
        Path('/output/value.json').write_bytes(encoded({'value':84}))
    elif action == 'verify':
        assert json.loads(Path('/input/value.json').read_bytes()) == {'value':42}
        assert json.loads(Path('/evidence/value.json').read_bytes()) == {'value':84}
        job = json.loads(Path('/job/job.json').read_bytes())
        receipt = dict(schema='polis-probe-receipt/1',run_id=job['run_id'],job_sha256=hashlib.sha256(encoded(job)).hexdigest(),
            verdict='PASS',entries=[dict(verdict='PASS',checks=2,worst_absolute=0,worst_relative=0,outliers=0,nonfinite=0)],
            controls=dict(passed=1,expected=1),selection=None,
            digests={k:(job[k]['image'].split('@sha256:')[1] if k in ('producer','verifier') else hashlib.sha256(b'public-fixture').hexdigest())
                for k in ('producer','verifier','inputs','recordings','policy')})
        Path('/verdict/receipt.json').write_bytes(encoded(receipt))
    else:
        raise ValueError('FIXTURE_ACTION')


if __name__ == '__main__':
    main()
