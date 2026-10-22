"""Run native-verifier checks in an unmodified final image, offline."""
import os
from pathlib import Path
import subprocess
import tempfile
from check_trust import HERE


def run_native(image, executable, *args, extra_mount=None):
    command = ['docker', 'run', '--rm', '--network=none',
               '-v', f'{HERE}:/audit:ro']
    if extra_mount:
        command += ['-v', f'{extra_mount}:/control:ro']
    command += ['--entrypoint', executable, image, *args]
    subprocess.run(command, check=True)


def node(image):
    with tempfile.TemporaryDirectory(prefix='polis-tls-control-') as tmp:
        path = Path(tmp)
        openssl = os.environ.get('OPENSSL', 'openssl')

        def generate(*args):
            result = subprocess.run([openssl, *args], cwd=path, capture_output=True, text=True)
            if result.returncode:
                raise ValueError(result.stderr)

        generate('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
                 '-subj', '/CN=Local trust test root', '-keyout', 'root.key', '-out', 'root.pem',
                 '-addext', 'basicConstraints=critical,CA:TRUE')
        for name, subject, extensions, issuer in [
            ('intermediate', 'Local trust test intermediate',
             'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n', 'root'),
            ('leaf', 'localhost',
             'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n', 'intermediate'),
        ]:
            (path / 'extensions').write_text(extensions)
            generate('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', f'/CN={subject}',
                     '-keyout', f'{name}.key', '-out', f'{name}.csr')
            generate('x509', '-req', '-in', f'{name}.csr', '-CA', f'{issuer}.pem',
                     '-CAkey', f'{issuer}.key', '-set_serial', '1', '-days', '2',
                     '-extfile', 'extensions', '-out', f'{name}.pem')
        # Generated keys exist only in this temporary mount and are removed on exit.
        run_native(image, 'node', '--expose-internals', '/audit/check-node.cjs', '/control', extra_mount=tmp)
