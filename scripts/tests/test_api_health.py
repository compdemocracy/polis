"""Execute the deploy hook's real JavaScript health predicate with fake replies."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest


class DeployHealthCheck(unittest.TestCase):
    def test_response_matrix(self):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Node is required for the deploy health predicate')
        source = (Path(__file__).resolve().parents[1] / 'validate_service.sh').read_text()
        script = source.split("compose exec -T server node -e '")[1].split("\n    ' \"$RUST_API_ROUTES\"")[0]
        mutations = [None, 'statusCode', 'status', 'mathEnv', 'commit', 'version',
                     'routes', 'switch', 'readOnly', 'reachable', 'limit',
                     'acquireTimeoutMs', 'statementTimeoutMs', 'maxLifetimeMs', 'unreachable']
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                pool = dict(readOnly=True, reachable=True, limit=8, acquireTimeoutMs=2000,
                            statementTimeoutMs=3000, maxLifetimeMs=300000)
                health = dict(status='ok', mathEnv='python', version='2.0.0', commit='a'*40,
                              pools=dict(common=pool), routing=dict(configuredRoutes='', enabledSwitches=[]))
                code = 200
                if mutation == 'statusCode': code = 503
                elif mutation == 'routes': health['routing']['configuredRoutes'] = 'pca2'
                elif mutation == 'switch': health['routing']['enabledSwitches'] = ['POLIS_API_VOTES_WRITES']
                elif mutation in pool: pool[mutation] = False if isinstance(pool[mutation], bool) else 0
                elif mutation in health: health[mutation] = ''
                fake = ('global.fetch=async()=>{throw Error("unreachable")};' if mutation == 'unreachable' else
                        'global.fetch=async()=>({status:' + str(code) + ',json:async()=>(' + json.dumps(health) + ')});')
                result = subprocess.run([node, '-e', fake + script, '', 'a'*40, '2.0.0'], capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0 if mutation is None else 1, result.stderr)

    def test_version_route_switch_and_identity(self):
        source = (Path(__file__).resolve().parents[1] / 'validate_service.sh').read_text()
        script = source.split("compose exec -T server node -e '")[1].split("\n    ' \"$RUST_API_ROUTES\"")[0]
        for case in ('ok', 'missing-switch', 'extra-switch', 'different-bytes', 'bad-status', 'cacheable', 'unreachable'):
            with self.subTest(case=case):
                health = dict(status='ok', mathEnv='python', version='2.0.0', commit='a'*40,
                    pools=dict(common=dict(readOnly=True, reachable=True, limit=8,
                        acquireTimeoutMs=2000, statementTimeoutMs=3000, maxLifetimeMs=300000)),
                    routing=dict(configuredRoutes='version', enabledSwitches=['POLIS_API_VERSION_READS']))
                if case == 'missing-switch': health['routing']['enabledSwitches'] = []
                if case == 'extra-switch': health['routing']['enabledSwitches'].append('POLIS_API_VOTES_WRITES')
                fake = 'const mode=' + json.dumps(case) + ';const health=' + json.dumps(health) + ";" + '''
                    global.fetch=async url=>{
                      if(url.endsWith("/health")) return {status:200,json:async()=>health};
                      if(mode==="unreachable") throw Error("unreachable");
                      return {status:mode==="bad-status"?502:200,
                        headers:{get:()=>mode==="cacheable"?"public":"no-store"},
                        text:async()=>mode==="different-bytes"&&url.includes("polis-api")?"different":"identity"};
                    };
                '''
                result = subprocess.run([shutil.which('node'), '-e', fake + script, 'version', 'a'*40, '2.0.0'], capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0 if case == 'ok' else 1, result.stderr)
