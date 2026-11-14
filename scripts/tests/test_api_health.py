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

    def check_shadow(self, health, accepted, code=200, unreachable=False, url_seen=None, comments=None):
        # comments: the hook's third argument, "1" when commentsShadow is
        # selected and "0" when it is not; None leaves it out, as before the
        # comment shadow existed.
        fake = ('global.fetch=async()=>{throw Error("unreachable")};' if unreachable else
                'global.fetch=async url=>{if(url!=="http://polis-api-shadow:5101/health")throw Error(url);'
                'return {status:' + str(code) + ',json:async()=>(' + json.dumps(health) + ')}};')
        arguments = ['a'*40, '2.0.0'] + ([] if comments is None else [comments])
        result = subprocess.run([shutil.which('node'), '-e', fake + self.shadow_script(), *arguments],
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

    # The comment shadow (commentsShadow): the same service's /health gains
    # one key, postComments, exactly when the comment observer is built.
    # Selected, it must be there in observe mode, never enabled, with its two
    # read-only pools and no other, room for 8 observations and 64 waiting
    # read-backs and a cap within 6 copies a second. Not selected, it must be
    # absent. Everything required of the vote observer stays required.
    def comments_section(self):
        pool = dict(readOnly=True, reachable=True, limit=2, available=2, acquireTimeoutMs=100,
                    statementTimeoutMs=100, maxLifetimeMs=300000)
        return dict(enabled=False, mode='observe', observed=0, wouldServe=0, wouldAnswer=0,
                    wouldHandBack=0, wouldFail=0, unknown=0, shed=0, notObserved=0,
                    readbackOwn=0, readbackOther=0, readbackAbsent=0, textDifferent=0,
                    voteSame=0, voteAmbiguous=0, voteDifferent=0, voteAbsent=0,
                    inFlight=0, capacity=8, maxPerSecond=5, readbackWaiting=0, readbackCapacity=64,
                    pools=dict(reads=dict(pool), readback=dict(pool, limit=1, available=1)))

    def comments_health(self):
        health = self.shadow_health()
        # The observer reports it after postVotes; the key's place is not checked.
        return dict(role=health['role'], status=health['status'], version=health['version'],
                    commit=health['commit'], postVotes=health['postVotes'],
                    postComments=self.comments_section(), shadow=health['shadow'])

    def test_comment_observer_is_built_exactly_when_selected(self):
        # Every pairing of what the route list says with what the service
        # reports. The hook passes "1" or "0"; anything else is not selected.
        for argument, selected in ((None, False), ('0', False), ('1', True), ('', False),
                                   ('observe', False), ('true', False), ('01', False)):
            for built in (False, True):
                health = self.comments_health() if built else self.shadow_health()
                with self.subTest(argument=argument, built=built):
                    self.check_shadow(health, selected == built, comments=argument)

    def test_comment_observer_health_accepts_observe_mode_only(self):
        self.check_shadow(self.comments_health(), True, comments='1')
        busy = self.comments_health()
        busy['postComments'].update(observed=220, wouldServe=40, wouldAnswer=3, wouldHandBack=170,
                                    shed=7, readbackOwn=38, voteSame=37, inFlight=8, readbackWaiting=64)
        busy['postVotes'].update(observed=11000, wouldServe=10500)
        self.check_shadow(busy, True, comments='1')
        for rate in (1, 2, 6):
            health = self.comments_health()
            health['postComments']['maxPerSecond'] = rate
            with self.subTest(rate=rate):
                self.check_shadow(health, True, comments='1')
        self.check_shadow(self.comments_health(), False, code=503, comments='1')
        self.check_shadow(self.comments_health(), False, unreachable=True, comments='1')

    def test_comment_observer_health_refusals(self):
        def mutated(change):
            health = self.comments_health()
            change(health)
            return health
        comments = lambda h: h['postComments']
        pools = lambda h: h['postComments']['pools']
        cases = {
            'absent': lambda h: h.pop('postComments'),
            'null': lambda h: h.update(postComments=None),
            'empty': lambda h: h.update(postComments={}),
            'a word': lambda h: h.update(postComments='observe'),
            'enabled': lambda h: comments(h).update(enabled=True),
            'enabled missing': lambda h: comments(h).pop('enabled'),
            'enabled string': lambda h: comments(h).update(enabled='false'),
            'enabled null': lambda h: comments(h).update(enabled=None),
            'mode live': lambda h: comments(h).update(mode='live'),
            'mode off': lambda h: comments(h).update(mode='off'),
            'mode missing': lambda h: comments(h).pop('mode'),
            'pools missing': lambda h: comments(h).pop('pools'),
            'no pools': lambda h: comments(h).update(pools={}),
            'writer pool': lambda h: pools(h).update(writer=dict(readOnly=False)),
            'notification pool': lambda h: pools(h).update(notifications=dict(readOnly=False)),
            'a third read-only pool': lambda h: pools(h).update(other=dict(readOnly=True, reachable=True)),
            'reads missing': lambda h: pools(h).pop('reads'),
            'readback missing': lambda h: pools(h).pop('readback'),
            'reads writable': lambda h: pools(h)['reads'].update(readOnly=False),
            'readback writable': lambda h: pools(h)['readback'].update(readOnly=False),
            'reads unreachable': lambda h: pools(h)['reads'].update(reachable=False),
            'readback unreachable': lambda h: pools(h)['readback'].update(reachable=False),
            'capacity 7': lambda h: comments(h).update(capacity=7),
            'capacity 32': lambda h: comments(h).update(capacity=32),
            'capacity string': lambda h: comments(h).update(capacity='8'),
            'capacity missing': lambda h: comments(h).pop('capacity'),
            'read-back room 63': lambda h: comments(h).update(readbackCapacity=63),
            'read-back room 256': lambda h: comments(h).update(readbackCapacity=256),
            'read-back room missing': lambda h: comments(h).pop('readbackCapacity'),
            'rate zero': lambda h: comments(h).update(maxPerSecond=0),
            'rate above 6': lambda h: comments(h).update(maxPerSecond=7),
            'rate 25': lambda h: comments(h).update(maxPerSecond=25),
            'rate string': lambda h: comments(h).update(maxPerSecond='5'),
            'rate fraction': lambda h: comments(h).update(maxPerSecond=2.5),
            'rate missing': lambda h: comments(h).pop('maxPerSecond'),
            # What is required of the vote observer and the service stays required.
            'status': lambda h: h.update(status='degraded'),
            'role main': lambda h: h.update(role='main'),
            'vote mode off': lambda h: h['postVotes'].update(mode='off'),
            'vote enabled': lambda h: h['postVotes'].update(enabled=True),
            'vote reads missing': lambda h: h['postVotes']['pools'].pop('reads'),
            'vote writer pool': lambda h: h['postVotes']['pools'].update(writer=dict(readOnly=False)),
            'not listening': lambda h: h['shadow'].update(listening=False),
            'vote rate above 25': lambda h: h['shadow'].update(maxPerSecond=26),
            'version': lambda h: h.update(version='2.0.1'),
            'commit': lambda h: h.update(commit='b'*40),
        }
        for name, change in cases.items():
            with self.subTest(case=name):
                self.check_shadow(mutated(change), False, comments='1')

    def test_comment_observer_is_refused_in_any_form_when_not_selected(self):
        forms = {
            'observe': self.comments_section(),
            'off': dict(self.comments_section(), mode='off'),
            'enabled': dict(self.comments_section(), enabled=True, mode='live'),
            'empty': {},
            'null': None,
            'false': False,
        }
        for argument in (None, '0'):
            for name, section in forms.items():
                health = self.shadow_health()
                health['postComments'] = section
                with self.subTest(argument=argument, form=name):
                    self.check_shadow(health, False, comments=argument)

    def test_vote_only_shadow_validates_as_before_the_comment_shadow(self):
        # The health body the vote shadow serves today, with the argument the
        # hook now passes for a route list without commentsShadow: every
        # verdict of the vote shadow's tests holds.
        self.check_shadow(self.shadow_health(), True, comments='0')
        self.check_shadow(self.shadow_health(), False, code=503, comments='0')
        for change in (lambda h: h.update(status='degraded'), lambda h: h['postVotes'].update(mode='off'),
                       lambda h: h['postVotes']['pools'].pop('readback'),
                       lambda h: h['shadow'].update(maxPerSecond=26), lambda h: h.update(commit='b'*40)):
            health = self.shadow_health()
            change(health)
            self.check_shadow(health, False, comments='0')


class ReadShadowHealthCheck(unittest.TestCase):
    """The read shadow (votesReadShadow, commentsReadShadow,
    nextCommentShadow): its own service's /health, fetched from the server
    container. The shadow role with no observer at all, listening, exactly
    the lanes whose selectors are named (the hook's last three arguments),
    each in observe mode and never enabled, with its route's selector, room
    for 8 copies, a cap within 10 a second and exactly its route's
    read-only, reachable pools; and the release's identity."""
    LANES = {'getVotes': ('votesReadShadow', ('reads', 'auth')),
             'getComments': ('commentsReadShadow', ('reads', 'count')),
             'getNextComment': ('nextCommentShadow', ('reads',))}

    def script(self):
        source = (Path(__file__).resolve().parents[1] / 'validate_service.sh').read_text()
        body = source.split('read_lanes_ready() {')[1]
        return body.split("compose exec -T server node -e '")[1].split("\n    ' \"$(sed")[0]

    def lane(self, key):
        selector, pools = self.LANES[key]
        pool = dict(readOnly=True, reachable=True, limit=1, available=1, acquireTimeoutMs=15,
                    statementTimeoutMs=50, maxLifetimeMs=300000)
        return dict(enabled=False, mode='observe', selector=selector, observed=0, wouldServe=0, wouldAnswer=0,
                    wouldHandBack=0, wouldFail=0, shed=0, inFlight=0, capacity=8, maxPerSecond=5,
                    pools={name: dict(pool) for name in pools})

    def health(self, lanes=('getVotes', 'getComments', 'getNextComment')):
        body = dict(role='shadow', status='ok', version='2.0.0', commit='a' * 40,
                    postVotes=dict(enabled=False, mode='off', observed=0, wouldServe=0, wouldHandBack=0,
                                   wouldFail=0, shed=0, notObserved=0, readbackSame=0, readbackAmbiguous=0,
                                   readbackDifferent=0, readbackAbsent=0, pools={}))
        for key in lanes:
            body[key] = self.lane(key)
        body['shadow'] = dict(listening=True, address='0.0.0.0:5102', inFlight=0, capacity=32, maxPerSecond=1,
                              readbackWaiting=0, headRefused=0, bodyUnread=0)
        return body

    def check(self, health, accepted, named='111', code=200, unreachable=False):
        fake = ('global.fetch=async()=>{throw Error("unreachable")};' if unreachable else
                'global.fetch=async url=>{if(url!=="http://polis-api-shadow-reads:5102/health")throw Error(url);'
                'return {status:' + str(code) + ',json:async()=>(' + json.dumps(health) + ')}};')
        result = subprocess.run([shutil.which('node'), '-e', fake + self.script(), 'a' * 40, '2.0.0', *named],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0 if accepted else 1, result.stderr)

    def test_exactly_the_named_lanes_are_accepted(self):
        from itertools import product
        keys = list(self.LANES)
        for named in product('01', repeat=3):
            for built in product((False, True), repeat=3):
                lanes = [key for key, on in zip(keys, built) if on]
                accepted = [n == '1' for n in named] == list(built) and '1' in named
                with self.subTest(named=named, built=built):
                    self.check(self.health(lanes), accepted, named=''.join(named))

    def test_a_busy_service_is_accepted(self):
        health = self.health()
        health['getVotes'].update(observed=900, wouldServe=500, wouldHandBack=380, shed=20, inFlight=8)
        health['getNextComment'].update(maxPerSecond=10)
        health['getComments'].update(maxPerSecond=1)
        self.check(health, True)
        self.check(self.health(), False, code=503)
        self.check(self.health(), False, unreachable=True)

    def test_refusals(self):
        def mutated(change):
            health = self.health()
            change(health)
            return health
        cases = {
            'status': lambda h: h.update(status='degraded'),
            'role main': lambda h: h.update(role='main'),
            'role missing': lambda h: h.pop('role'),
            'the vote observer': lambda h: h['postVotes'].update(mode='observe'),
            'the vote writer': lambda h: h['postVotes'].update(enabled=True, mode='live'),
            'vote observer pools': lambda h: h['postVotes'].update(pools=dict(reads=dict(readOnly=True))),
            'vote pools missing': lambda h: h['postVotes'].pop('pools'),
            'postVotes missing': lambda h: h.pop('postVotes'),
            'the comment observer': lambda h: h.update(postComments=dict(enabled=False, mode='observe')),
            'the identity observer': lambda h: h.update(postVotesIdentity=dict(mode='observe')),
            'not listening': lambda h: h['shadow'].update(listening=False),
            'no lane': lambda h: h.pop('shadow'),
            'vote lane rate zero': lambda h: h['shadow'].update(maxPerSecond=0),
            'vote lane rate above 25': lambda h: h['shadow'].update(maxPerSecond=26),
            'version': lambda h: h.update(version='2.0.1'),
            'commit': lambda h: h.update(commit='b' * 40),
            'commit empty': lambda h: h.update(commit=''),
        }
        for key in self.LANES:
            lane = lambda h, key=key: h[key]
            pools = lambda h, key=key: h[key]['pools']
            cases.update({
                f'{key} enabled': lambda h, lane=lane: lane(h).update(enabled=True),
                f'{key} enabled string': lambda h, lane=lane: lane(h).update(enabled='false'),
                f'{key} mode live': lambda h, lane=lane: lane(h).update(mode='live'),
                f'{key} mode off': lambda h, lane=lane: lane(h).update(mode='off'),
                f'{key} another selector': lambda h, lane=lane: lane(h).update(selector='votesShadow'),
                f'{key} capacity 7': lambda h, lane=lane: lane(h).update(capacity=7),
                f'{key} capacity missing': lambda h, lane=lane: lane(h).pop('capacity'),
                f'{key} rate zero': lambda h, lane=lane: lane(h).update(maxPerSecond=0),
                f'{key} rate above 10': lambda h, lane=lane: lane(h).update(maxPerSecond=11),
                f'{key} rate string': lambda h, lane=lane: lane(h).update(maxPerSecond='5'),
                f'{key} rate fraction': lambda h, lane=lane: lane(h).update(maxPerSecond=2.5),
                f'{key} pools missing': lambda h, lane=lane: lane(h).pop('pools'),
                f'{key} no pools': lambda h, lane=lane: lane(h).update(pools={}),
                f'{key} a writer pool': lambda h, pools=pools: pools(h).update(writer=dict(readOnly=False, reachable=True)),
                f'{key} another read-only pool': lambda h, pools=pools: pools(h).update(other=dict(readOnly=True, reachable=True)),
                f'{key} reads missing': lambda h, pools=pools: pools(h).pop('reads'),
                f'{key} reads writable': lambda h, pools=pools: pools(h)['reads'].update(readOnly=False),
                f'{key} reads unreachable': lambda h, pools=pools: pools(h)['reads'].update(reachable=False),
                f'{key} null': lambda h, key=key: h.update({key: None}),
                f'{key} a word': lambda h, key=key: h.update({key: 'observe'}),
            })
        for name, change in cases.items():
            with self.subTest(case=name):
                self.check(mutated(change), False)


class WriteShadowHasNoReadLanes(unittest.TestCase):
    """The write shadows' service never holds a read lane: its /health with
    a read lane's key is refused, whatever the route list says."""

    def test_a_read_lane_in_the_write_shadows_service_is_refused(self):
        case = DeployHealthCheck()
        for key in ('getVotes', 'getComments', 'getNextComment'):
            for comments in ('0', '1'):
                health = case.comments_health() if comments == '1' else case.shadow_health()
                health[key] = ReadShadowHealthCheck().lane(key)
                with self.subTest(key=key, comments=comments):
                    fake = ('global.fetch=async url=>{if(url!=="http://polis-api-shadow:5101/health")throw Error(url);'
                            'return {status:200,json:async()=>(' + json.dumps(health) + ')}};')
                    result = subprocess.run([shutil.which('node'), '-e', fake + case.shadow_script(),
                                             'a' * 40, '2.0.0', comments], capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, 1, result.stderr)
