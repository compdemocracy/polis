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

    def test_connection_route_switch_matches_selection(self):
        source = (Path(__file__).resolve().parents[1] / 'validate_service.sh').read_text()
        script = source.split("compose exec -T server node -e '")[1].split("\n    ' \"$RUST_API_ROUTES\"")[0]
        connection = 'POLIS_API_CONNECTION_READS'
        version = 'POLIS_API_VERSION_READS'
        cases = [
            ('testConnection', [connection], True),
            ('testConnection', [], False),
            ('testConnection', [connection, 'POLIS_API_VOTES_WRITES'], False),
            ('testConnection', [version], False),
            ('', [], True),
            ('', [connection], False),
            ('pca2', [], True),
            ('pca2', [connection], False),
            ('testConnection,pca2', [connection], True),
            (' pca2, testConnection ', [connection], True),
            ('testConnection,testConnection', [connection], True),
            ('testConnections', [connection], False),
            ('testconnection', [connection], False),
            ('version,testConnection', [version, connection], True),
            ('version,testConnection', [version], False),
            ('version,testConnection', [connection], False),
            ('version', [version, connection], False),
        ]
        for selected, switches, accepted in cases:
            with self.subTest(selected=selected, switches=switches):
                health = dict(status='ok', mathEnv='python', version='2.0.0', commit='a'*40,
                    pools=dict(common=dict(readOnly=True, reachable=True, limit=8,
                        acquireTimeoutMs=2000, statementTimeoutMs=3000, maxLifetimeMs=300000)),
                    routing=dict(configuredRoutes=selected, enabledSwitches=switches))
                fake = 'const health=' + json.dumps(health) + ";" + '''
                    global.fetch=async url=>{
                      if(url.endsWith("/health")) return {status:200,json:async()=>health};
                      return {status:200,headers:{get:()=>"no-store"},text:async()=>"identity"};
                    };
                '''
                result = subprocess.run([shutil.which('node'), '-e', fake + script,
                    selected, 'a'*40, '2.0.0'], capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0 if accepted else 1, result.stderr)

    def check_comments_health(self, selected, switches, accepted, keys=True, mutation=None):
        source = (Path(__file__).resolve().parents[1] / 'validate_service.sh').read_text()
        script = source.split("compose exec -T server node -e '")[1].split("\n    ' \"$RUST_API_ROUTES\"")[0]
        pool = dict(readOnly=True, reachable=True, limit=8, acquireTimeoutMs=2000,
                    statementTimeoutMs=3000, maxLifetimeMs=300000)
        health = dict(status='ok', mathEnv='python', version='2.0.0', commit='a'*40,
                      pools=dict(common=pool),
                      routing=dict(configuredRoutes=selected, enabledSwitches=switches))
        if keys is not None:
            health['participantKeysLoaded'] = keys
        if mutation in pool:
            pool[mutation] = False if isinstance(pool[mutation], bool) else 0
        elif mutation in ('status', 'mathEnv', 'commit', 'version'):
            health[mutation] = ''
        elif mutation == 'routes':
            health['routing']['configuredRoutes'] = 'pca2'
        elif mutation == 'missing-switches':
            del health['routing']['enabledSwitches']
        elif mutation == 'missing-pool':
            del health['pools']['common']
        fake = 'const mode=' + json.dumps(mutation) + ';const health=' + json.dumps(health) + ";" + '''
            global.fetch=async url=>{
              if(mode==="unreachable") throw Error("unreachable");
              if(url.endsWith("/health")) return {
                status:mode==="statusCode"?503:200,json:async()=>health};
              return {status:mode==="bad-version-status"?502:200,
                headers:{get:()=>mode==="cacheable-version"?"public":"no-store"},
                text:async()=>mode==="different-version"&&url.includes("polis-api")?"different":"identity"};
            };
        '''
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Node is required for the deploy health predicate')
        result = subprocess.run([node, '-e', fake + script, selected, 'a'*40, '2.0.0'],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0 if accepted else 1, result.stderr)

    def test_comments_selection_switch_matrix(self):
        from itertools import product

        # Every selector/switch combination, including connection and pca2.
        # pca2 has no handler switch. The process-wide participant switch
        # remains refused, with or without the comments selector.
        names = ('POLIS_API_VERSION_READS', 'POLIS_API_COMMENT_READS',
                 'POLIS_API_PARTICIPANT_READS', 'POLIS_API_CONNECTION_READS')
        for pca, version, comments, connection in product((False, True), repeat=4):
            selected = ','.join(name for name, enabled in zip(
                ('pca2', 'version', 'comments', 'testConnection'),
                (pca, version, comments, connection)) if enabled)
            for flags in product((False, True), repeat=4):
                switches = [name for name, enabled in zip(names, flags) if enabled]
                ver_on, comment_on, participant_on, connection_on = flags
                accepted = (ver_on == version and comment_on == comments and
                            connection_on == connection and not participant_on)
                with self.subTest(selected=selected, switches=switches):
                    self.check_comments_health(selected, switches, accepted)

    def test_participant_switch_refused_with_or_without_comments(self):
        for selected in ('pca2', 'pca2,comments'):
            for keys in (None, False, True, 'true', 1, [], {}):
                for participant in (False, True):
                    switches = ['POLIS_API_COMMENT_READS'] if 'comments' in selected else []
                    if participant:
                        switches.append('POLIS_API_PARTICIPANT_READS')
                    with self.subTest(selected=selected, keys=keys, participant=participant):
                        self.check_comments_health(selected, switches, not participant, keys=keys)

    def test_comments_exact_selector_and_unrelated_switches(self):
        comment = 'POLIS_API_COMMENT_READS'
        for selected in ('comment', 'Comments', 'commentsRead', 'participantComments', 'xcomments'):
            for switches, accepted in (([], True), ([comment], False)):
                with self.subTest(selected=selected, switches=switches):
                    self.check_comments_health(selected, switches, accepted)
        for selected in (' comments ', 'comments,comments', 'pca2,\tcomments\n'):
            with self.subTest(selected=selected):
                self.check_comments_health(selected, [comment], True)
        for extra in ('POLIS_API_NEXT_COMMENT_READS', 'POLIS_API_VOTES_READS',
                      'POLIS_API_VOTES_WRITES', 'POLIS_API_PARTICIPANT_COMMENTS_READS'):
            with self.subTest(extra=extra):
                self.check_comments_health('comments', [comment, extra], False)

    def test_comments_preserve_health_and_version_checks(self):
        mutations = (None, 'statusCode', 'status', 'mathEnv', 'commit', 'version',
                     'routes', 'readOnly', 'reachable', 'limit', 'acquireTimeoutMs',
                     'statementTimeoutMs', 'maxLifetimeMs', 'unreachable',
                     'missing-switches', 'missing-pool', 'bad-version-status',
                     'cacheable-version', 'different-version')
        switches = ['POLIS_API_COMMENT_READS', 'POLIS_API_VERSION_READS']
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.check_comments_health('pca2,version,comments', switches,
                                           mutation is None, mutation=mutation)
