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

    WRITER_COUNTERS = ('served', 'handedBack', 'durableAcceptedWithDegradedFollowOn', 'unknown',
                       'writerAcquireAlarmHits', 'inFlight', 'notificationsInFlight',
                       'notificationDropped')

    def writer_health(self, enabled):
        return dict(enabled=enabled, **{key: 0 for key in self.WRITER_COUNTERS})

    def check_vote_health(self, selected, switches, accepted, writer='switch', mutation=None):
        # writer='switch': the process reports its writer enabled exactly when
        # the writer's switch is on, as polis-api does; None omits the section.
        source = (Path(__file__).resolve().parents[1] / 'validate_service.sh').read_text()
        script = source.split("compose exec -T server node -e '")[1].split("\n    ' \"$RUST_API_ROUTES\"")[0]
        pool = dict(readOnly=True, reachable=True, limit=8, acquireTimeoutMs=2000,
                    statementTimeoutMs=3000, maxLifetimeMs=300000)
        health = dict(status='ok', mathEnv='python', version='2.0.0', commit='a'*40,
                      pools=dict(common=pool),
                      routing=dict(configuredRoutes=selected, enabledSwitches=switches))
        if writer == 'switch':
            writer = self.writer_health('POLIS_API_POST_VOTES' in switches)
        if writer is not None:
            health['postVotes'] = writer
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

    def test_vote_writer_selection_switch_matrix(self):
        from itertools import product

        # Every combination of the write selector with comments, pca2 and the
        # vote read selector. Only the writer's own switch is newly accepted;
        # the vote read switch stays refused, with or without either selector.
        names = ('POLIS_API_POST_VOTES', 'POLIS_API_COMMENT_READS', 'POLIS_API_VOTES_READS')
        for pca, comments, post, reads in product((False, True), repeat=4):
            selected = ','.join(name for name, enabled in zip(
                ('pca2', 'comments', 'postVotes', 'votesRead'),
                (pca, comments, post, reads)) if enabled)
            for flags in product((False, True), repeat=3):
                switches = [name for name, enabled in zip(names, flags) if enabled]
                post_on, comment_on, reads_on = flags
                accepted = post_on == post and comment_on == comments and not reads_on
                with self.subTest(selected=selected, switches=switches):
                    self.check_vote_health(selected, switches, accepted)

    def test_vote_writer_reports_itself_exactly_when_selected(self):
        post = ['POLIS_API_POST_VOTES']
        self.check_vote_health('postVotes', post, True)
        busy = self.writer_health(True)
        busy.update(served=7, handedBack=3, unknown=1, inFlight=2, notificationDropped=12345)
        self.check_vote_health('postVotes', post, True, writer=busy)
        refused = [None, self.writer_health(False), dict(self.writer_health(True), enabled='true'),
                   dict(self.writer_health(True), enabled=1)]
        for key in self.WRITER_COUNTERS:
            for value in (None, -1, 1.5, '0', True, 2**53):
                bad = self.writer_health(True)
                if value is None:
                    del bad[key]
                else:
                    bad[key] = value
                refused.append(bad)
        for writer in refused:
            with self.subTest(writer=writer):
                self.check_vote_health('postVotes', post, False, writer=writer)
        # Unselected, the writer must not report itself enabled.
        for selected in ('', 'pca2', 'pca2,comments'):
            switches = ['POLIS_API_COMMENT_READS'] if 'comments' in selected else []
            for writer, accepted in ((None, True), (self.writer_health(False), True),
                                     (self.writer_health(True), False)):
                with self.subTest(selected=selected, writer=writer):
                    self.check_vote_health(selected, switches, accepted, writer=writer)

    def test_vote_writer_exact_selector_and_unrelated_switches(self):
        post = 'POLIS_API_POST_VOTES'
        for selected in ('postvotes', 'PostVotes', 'votes', 'postVote', 'postVotesWrite',
                         'xpostVotes', 'votesRead'):
            for switches, accepted in (([], True), ([post], False)):
                with self.subTest(selected=selected, switches=switches):
                    self.check_vote_health(selected, switches, accepted)
        for selected in (' postVotes ', 'postVotes,postVotes', 'pca2,\tpostVotes\n'):
            with self.subTest(selected=selected):
                self.check_vote_health(selected, [post], True)
        for extra in ('POLIS_API_VOTES_READS', 'POLIS_API_VOTES_WRITES',
                      'POLIS_API_NEXT_COMMENT_READS', 'POLIS_API_TOPIC_SELECTION_WRITES',
                      'POLIS_API_POST_TREEVITE_WAVES', 'POLIS_API_PARTICIPANT_READS'):
            with self.subTest(extra=extra):
                self.check_vote_health('postVotes', [post, extra], False)

    def test_vote_writer_preserves_health_and_version_checks(self):
        mutations = (None, 'statusCode', 'status', 'mathEnv', 'commit', 'version',
                     'routes', 'readOnly', 'reachable', 'limit', 'acquireTimeoutMs',
                     'statementTimeoutMs', 'maxLifetimeMs', 'unreachable',
                     'missing-switches', 'missing-pool', 'bad-version-status',
                     'cacheable-version', 'different-version')
        switches = ['POLIS_API_COMMENT_READS', 'POLIS_API_POST_VOTES', 'POLIS_API_VERSION_READS']
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.check_vote_health('pca2,version,comments,postVotes', switches,
                                       mutation is None, mutation=mutation)

    # The vote shadow (votesShadow): its own service's /health, fetched from
    # the server container. Observe mode only, never enabled, two read-only
    # pools and no writer, listening, the release's identity, and a rate cap
    # within 25 copies a second.
    def shadow_script(self):
        source = (Path(__file__).resolve().parents[1] / 'validate_service.sh').read_text()
        body = source.split('shadow_ready() {')[1]
        return body.split("compose exec -T server node -e '")[1].split("\n    ' \"$(sed")[0]

    def shadow_health(self):
        pool = dict(readOnly=True, reachable=True, limit=2, available=2, acquireTimeoutMs=100,
                    statementTimeoutMs=100, maxLifetimeMs=300000)
        return dict(role='shadow', status='ok', version='2.0.0', commit='a'*40,
                    postVotes=dict(enabled=False, mode='observe', observed=0, wouldServe=0,
                                   wouldHandBack=0, wouldFail=0, shed=0, notObserved=0,
                                   readbackSame=0, readbackAmbiguous=0, readbackDifferent=0,
                                   readbackAbsent=0,
                                   pools=dict(reads=dict(pool), readback=dict(pool, limit=1, available=1))),
                    shadow=dict(listening=True, address='0.0.0.0:5101', inFlight=0, capacity=32,
                                maxPerSecond=8, readbackWaiting=0, headRefused=0, bodyUnread=0))

    def check_shadow(self, health, accepted, code=200, unreachable=False, url_seen=None):
        fake = ('global.fetch=async()=>{throw Error("unreachable")};' if unreachable else
                'global.fetch=async url=>{if(url!=="http://polis-api-shadow:5101/health")throw Error(url);'
                'return {status:' + str(code) + ',json:async()=>(' + json.dumps(health) + ')}};')
        result = subprocess.run([shutil.which('node'), '-e', fake + self.shadow_script(), 'a'*40, '2.0.0'],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0 if accepted else 1, result.stderr)

    def test_shadow_health_accepts_observe_mode_only(self):
        self.check_shadow(self.shadow_health(), True)
        busy = self.shadow_health()
        busy['postVotes'].update(observed=1200, wouldServe=900, shed=12)
        busy['shadow'].update(inFlight=31, maxPerSecond=25)
        self.check_shadow(busy, True)
        self.check_shadow(self.shadow_health(), False, code=503)
        self.check_shadow(self.shadow_health(), False, unreachable=True)

    def test_shadow_health_refusals(self):
        def mutated(change):
            health = self.shadow_health()
            change(health)
            return health
        votes = lambda h: h['postVotes']
        pools = lambda h: h['postVotes']['pools']
        cases = {
            'status': lambda h: h.update(status='degraded'),
            'role main': lambda h: h.update(role='main'),
            'role missing': lambda h: h.pop('role'),
            'enabled': lambda h: votes(h).update(enabled=True),
            'enabled missing': lambda h: votes(h).pop('enabled'),
            'enabled string': lambda h: votes(h).update(enabled='false'),
            'mode live': lambda h: votes(h).update(mode='live'),
            'mode off': lambda h: votes(h).update(mode='off'),
            'mode missing': lambda h: votes(h).pop('mode'),
            'writer pool': lambda h: pools(h).update(writer=dict(readOnly=False)),
            'notification pool': lambda h: pools(h).update(notifications=dict(readOnly=False)),
            'reads missing': lambda h: pools(h).pop('reads'),
            'readback missing': lambda h: pools(h).pop('readback'),
            'reads writable': lambda h: pools(h)['reads'].update(readOnly=False),
            'readback writable': lambda h: pools(h)['readback'].update(readOnly=False),
            'reads unreachable': lambda h: pools(h)['reads'].update(reachable=False),
            'readback unreachable': lambda h: pools(h)['readback'].update(reachable=False),
            'not listening': lambda h: h['shadow'].update(listening=False),
            'no lane': lambda h: h.pop('shadow'),
            'rate zero': lambda h: h['shadow'].update(maxPerSecond=0),
            'rate above 25': lambda h: h['shadow'].update(maxPerSecond=26),
            'rate string': lambda h: h['shadow'].update(maxPerSecond='8'),
            'rate fraction': lambda h: h['shadow'].update(maxPerSecond=2.5),
            'rate missing': lambda h: h['shadow'].pop('maxPerSecond'),
            'version': lambda h: h.update(version='2.0.1'),
            'commit': lambda h: h.update(commit='b'*40),
            'commit empty': lambda h: h.update(commit=''),
        }
        for name, change in cases.items():
            with self.subTest(case=name):
                self.check_shadow(mutated(change), False)

