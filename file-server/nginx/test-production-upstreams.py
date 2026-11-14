#!/usr/bin/env python3
"""Production upstream availability, without starting containers or reading .env."""
from pathlib import Path
import unittest
import tempfile

from production_upstreams import check, nginx_hosts, web_services

ROOT = Path(__file__).resolve().parents[2]

# Small inputs keep parser tests independent of deployment-file formatting.
HOOK = '''
case "$SERVICE_FROM_FILE" in
  server) ROLE_IMAGES="server nginx-proxy polis-api" ;;
esac
sudo docker run --rm --network host --env-file .env polis-migrate:deploy deploy
worker_daemon() {
  sudo docker run -d worker-image
}
if [ "$SERVICE_FROM_FILE" == "server" ]; then
  "${COMPOSE[@]}" up -d server nginx-proxy --no-build
  if [ "$POLIS_API_START" = 1 ]; then
    "${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate polis-api
  fi
elif [ "$SERVICE_FROM_FILE" == "delphi" ]; then
  sudo docker run -d delphi-image
fi
'''
COMPOSE = '''services:
  server:
    image: node
  nginx-proxy:
    depends_on:
      - "server"
    environment:
      - RUST_API_UPSTREAM=${RUST_API_UPSTREAM:-polis-api:5100}
  polis-api:
    image: rust
'''


class ProductionUpstreams(unittest.TestCase):
    def test_repository(self):
        result = check(ROOT)
        self.assertTrue(result['hosts'])
        print(result, flush=True)

    def test_proxy_forms(self):
        docs = {'example.conf': '''
            # proxy_pass http://ignored:80;
            upstream pool { server server:5000; server client-participation-alpha:4321 backup; }
            map $uri $target { default ""; /api polis-api:5100; }
            set $node server:5000;
            location / { proxy_pass "http://pool"; }
            location /api { proxy_pass http://$target$request_uri; }
            location /node { proxy_pass http://$node; }
        '''}
        self.assertEqual(nginx_hosts(docs), {'server', 'client-participation-alpha', 'polis-api'})

    def test_unresolved_hosts_are_errors(self):
        for value in ['http://$unknown', 'http://${UNKNOWN}:80', 'http://unix:/tmp/app.sock:']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                nginx_hosts({'example.conf': f'proxy_pass {value};'})

    def test_every_pool_member_is_checked(self):
        self.assertEqual(nginx_hosts({'a': 'upstream unused { server absent:80; }'}), {'absent'})
        self.assertEqual(nginx_hosts({'a': 'proxy_pass https://outside.example:443/path;'}), {'outside.example'})

    def replace_once(self, text, old, new):
        self.assertEqual(text.count(old), 1, f'mutation needs exactly one occurrence: {old!r}')
        return text.replace(old, new, 1)

    def fixture(self, root):
        (root / 'scripts').mkdir()
        (root / 'scripts/after_install.sh').write_text(HOOK)
        (root / 'docker-compose.yml').write_text(COMPOSE)
        folder = root / 'file-server/nginx'
        (folder / 'rust-api').mkdir(parents=True)
        (folder / 'rust-api/example.location.conf.template').write_text(
            'location /example { proxy_pass http://polis-api:5100; }')
        (folder / 'render-rust-api.sh').write_text('''#!/bin/sh
# /etc/nginx/rust-api-templates/
mkdir -p "$1"
printf 'location /example { proxy_pass http://%s; }' "$RUST_API_UPSTREAM" > "$1/example.conf"
''')

    def test_images_are_not_startup(self):
        self.assertEqual(web_services(HOOK, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})
        changed = self.replace_once(HOOK, 'up -d --no-deps --no-build --force-recreate polis-api',
                                    'up -d --no-deps --no-build --force-recreate server')
        with self.assertRaisesRegex(ValueError, 'image/start'):
            web_services(changed, COMPOSE)
        changed = self.replace_once(COMPOSE, '  polis-api:', '  absent-service:')
        with self.assertRaisesRegex(ValueError, 'Compose'):
            web_services(HOOK, changed)

    def test_changed_startup_syntax_is_not_silently_ignored(self):
        changed = self.replace_once(HOOK, 'up -d server nginx-proxy --no-build', 'up -d $WEB_SERVICES')
        with self.assertRaisesRegex(ValueError, r'line .*\$WEB_SERVICES'):
            web_services(changed, COMPOSE)

    def test_compose_host_default_is_checked(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            changed = self.replace_once(COMPOSE, '${RUST_API_UPSTREAM:-polis-api:5100}',
                                        '${RUST_API_UPSTREAM:-file-server:8080}')
            (root / 'docker-compose.yml').write_text(changed)
            with self.assertRaisesRegex(ValueError, 'file-server'):
                check(root)

    def test_new_dependency_syntax_requires_review(self):
        changed = self.replace_once(COMPOSE, 'depends_on:\n      - "server"', 'depends_on: [file-server]')
        with self.assertRaisesRegex(ValueError, 'dependency'):
            web_services(HOOK, changed)

    def test_flags_can_precede_service_names(self):
        changed = self.replace_once(HOOK, 'up -d server nginx-proxy --no-build',
                                    'up --no-build -d server nginx-proxy')
        self.assertEqual(web_services(changed, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})

    def test_foreground_run_options_can_change(self):
        for command in [
            'docker run --rm --stop-timeout 30 --network host other-image deploy',
            'docker container run --network=host --rm=true other-image deploy',
        ]:
            with self.subTest(command=command):
                changed = self.replace_once(HOOK,
                    'docker run --rm --network host --env-file .env polis-migrate:deploy deploy', command)
                self.assertEqual(web_services(changed, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})

    def test_continued_shell_commands(self):
        for old, new in [
            ('--network host --env-file', '--network host \\\n  --env-file'),
            ('up -d server nginx-proxy --no-build', 'up -d server \\\n  nginx-proxy --no-build'),
        ]:
            with self.subTest(old=old):
                changed = self.replace_once(HOOK, old, new)
                self.assertEqual(web_services(changed, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})
        login = 'aws ecr get-login-password --region us-east-1 \\\n  | sudo docker login --username AWS --password-stdin "$REGISTRY"\n'
        self.assertEqual(web_services(login + HOOK, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})

    def test_multiline_message_does_not_need_shell_tokenization(self):
        message = 'echo "Migration applied.\n  Starting the role\'s services next."\n'
        self.assertEqual(web_services(HOOK + message, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})

    def test_single_line_helper_is_complete(self):
        for definition in [
            'restart_unit() { sudo systemctl restart --no-block "$1"; }',
            'image_ref() { printf "%s" "$1"; } # image lookup',
            'start_worker() { docker run -d worker-image; }',
        ]:
            with self.subTest(definition=definition):
                changed = definition + '\n' + HOOK
                self.assertEqual(web_services(changed, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})

    def test_shared_start_after_single_line_helper_is_not_skipped(self):
        changed = 'image_ref() { printf "%s" "$1"; }\n'
        changed += 'sudo docker run -d file-server-image\n' + HOOK
        with self.assertRaisesRegex(ValueError, 'line 2: sudo docker run -d file-server-image'):
            web_services(changed, COMPOSE)

    def test_shell_errors_name_the_opening_line(self):
        for suffix, message in [
            ('docker run --rm "unfinished\n', 'No closing quotation'),
            ('"${COMPOSE[@]}" up "unfinished\n', 'No closing quotation'),
            ('helper() {\n  echo unfinished\n', 'incomplete shell function'),
            ('if [ "$OPTIONAL" = 1 ]; then\n  echo unfinished\n', 'incomplete shell conditional'),
            ('docker run --rm \\', 'incomplete shell continuation'),
        ]:
            with self.subTest(suffix=suffix):
                with self.assertRaises(ValueError) as caught:
                    web_services(HOOK + suffix, COMPOSE)
                self.assertIn(message, str(caught.exception))
                self.assertIn(f'line {len(HOOK.splitlines()) + 1}:', str(caught.exception))
        changed = 'sudo docker run \\\n  -d image\n' + HOOK
        with self.assertRaisesRegex(ValueError, r'line 1: sudo docker run\s+-d image'):
            web_services(changed, COMPOSE)

    def test_common_foreground_options(self):
        for option in ['--pull never', '--log-driver none', '--log-opt max-size=10m',
                       '--platform linux/arm64', '--add-host example:127.0.0.1', '--label role=migration']:
            with self.subTest(option=option):
                changed = self.replace_once(HOOK, 'run --rm --network', f'run --rm {option} --network')
                self.assertEqual(web_services(changed, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})

    def test_comment_backslash_does_not_continue_to_startup(self):
        for comment in ['# previous form: docker run --rm \\', '  # continued example \\']:
            with self.subTest(comment=comment):
                self.assertEqual(web_services(HOOK + comment, COMPOSE),
                                 {'server', 'nginx-proxy', 'polis-api'})
                changed = comment + '\nsudo docker run -d file-server-image\n' + HOOK
                with self.assertRaisesRegex(ValueError, 'line 2: sudo docker run -d file-server-image'):
                    web_services(changed, COMPOSE)

    def test_background_single_line_helper_does_not_hide_startup(self):
        for definition in ['warm_cache() { sudo systemctl start polis-cache & }',
                           'warm_cache() { sudo systemctl start polis-cache & } # helper']:
            with self.subTest(definition=definition):
                self.assertEqual(web_services(definition + '\n' + HOOK, COMPOSE),
                                 {'server', 'nginx-proxy', 'polis-api'})
                changed = definition + '\nsudo docker run -d file-server-image\n' + HOOK
                with self.assertRaisesRegex(ValueError, 'line 2: sudo docker run -d file-server-image'):
                    web_services(changed, COMPOSE)

    def test_direct_compose_commands_require_the_shared_array(self):
        for executable in ['sudo docker compose', 'docker-compose']:
            for command in ['up -d file-server', '--profile static up -d file-server',
                            'start file-server', 'down']:
                for position in ['shared', 'web']:
                    with self.subTest(executable=executable, command=command, position=position):
                        line = f'{executable} {command}'
                        changed = (line + '\n' + HOOK if position == 'shared' else
                                   self.replace_once(HOOK, '  "${COMPOSE[@]}" up -d server',
                                                     line + '\n  "${COMPOSE[@]}" up -d server'))
                        with self.assertRaises(ValueError) as caught:
                            web_services(changed, COMPOSE)
                        number = changed.splitlines().index(line) + 1
                        self.assertIn(f'line {number}: {line}', str(caught.exception))
                        self.assertIn('direct Compose command', str(caught.exception))
            for command in ['config', 'config --quiet']:
                with self.subTest(executable=executable, command=command):
                    self.assertEqual(web_services(f'{executable} {command}\n' + HOOK, COMPOSE),
                                     {'server', 'nginx-proxy', 'polis-api'})
            changed = self.replace_once(HOOK, '  sudo docker run -d delphi-image',
                                        f'  {executable} up -d delphi-image')
            self.assertEqual(web_services(changed, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})

    def test_compose_binary_paths_are_checked(self):
        for executable in ['sudo /usr/local/bin/docker-compose',
                           '/opt/bin/docker-compose', 'sudo /usr/bin/docker compose']:
            for options in ['', '-f a.yml -f b.yml ', '--profile static ']:
                with self.subTest(executable=executable, options=options):
                    line = f'{executable} {options}up -d file-server'
                    with self.assertRaisesRegex(ValueError, 'direct Compose command at line 1:'):
                        web_services(line + '\n' + HOOK, COMPOSE)
                    changed = self.replace_once(HOOK, '  sudo docker run -d delphi-image', line)
                    self.assertEqual(web_services(changed, COMPOSE),
                                     {'server', 'nginx-proxy', 'polis-api'})

    def test_compose_global_options_before_subcommand(self):
        for executable in ['sudo /usr/local/bin/docker-compose', 'sudo docker compose']:
            for option in ['-f a.yml', '--file a.yml', '--profile rust-api',
                           '--env-file test.env', '-p project', '--project-name project',
                           '--project-directory /tmp/example', '--profile=rust-api']:
                with self.subTest(executable=executable, option=option):
                    config = f'X=$({executable} {option} config --format json | jq .)\n'
                    self.assertEqual(web_services(config + HOOK, COMPOSE),
                                     {'server', 'nginx-proxy', 'polis-api'})
                    with self.assertRaisesRegex(ValueError, 'direct Compose command at line 1:'):
                        web_services(f'{executable} {option} up -d file-server\n' + HOOK, COMPOSE)
            for option in ['-f', '--profile', '--env-file', '-p', '--project-directory']:
                with self.subTest(executable=executable, missing_value=option):
                    with self.assertRaisesRegex(ValueError, 'Compose option.*line 1:'):
                        web_services(f'COMPOSE=({executable} {option})\n' + HOOK, COMPOSE)

    def test_compose_array_definitions(self):
        for executable in ['sudo /usr/local/bin/docker-compose', 'sudo docker compose',
                           'sudo /usr/bin/docker compose']:
            for options in ['', ' -f a.yml -f b.yml', ' --profile rust-api -p example']:
                with self.subTest(executable=executable, options=options):
                    self.assertEqual(web_services(f'COMPOSE=({executable}{options})\n' + HOOK, COMPOSE),
                                     {'server', 'nginx-proxy', 'polis-api'})
                    with self.assertRaisesRegex(ValueError, 'direct Compose command at line 1:'):
                        web_services(f'COMPOSE=({executable}{options}); {executable} up -d file-server\n' + HOOK, COMPOSE)

    def test_compose_binary_lookup(self):
        for executable in ['docker-compose', '/usr/local/bin/docker-compose']:
            for suffix in [' >/dev/null || echo "not installed" >&2', '']:
                with self.subTest(executable=executable, suffix=suffix):
                    self.assertEqual(web_services(f'command -v {executable}{suffix}\n' + HOOK, COMPOSE),
                                     {'server', 'nginx-proxy', 'polis-api'})
            with self.assertRaisesRegex(ValueError, 'direct Compose command at line 1:'):
                web_services(f'command -v {executable} && {executable} up -d file-server\n' + HOOK, COMPOSE)

    def test_trailing_comment_backslash_does_not_hide_startup(self):
        for prefix in ['echo done # note ', 'echo "# quoted" # note ',
                       "echo '# quoted' # note ", 'echo done;# note ',
                       'echo \\#escaped # note ', 'echo word#hash # note ']:
            with self.subTest(prefix=prefix):
                line = prefix + '\\'
                self.assertEqual(web_services(HOOK + line, COMPOSE),
                                 {'server', 'nginx-proxy', 'polis-api'})
                with self.assertRaisesRegex(ValueError, 'direct container startup at line 2:'):
                    web_services(line + '\nsudo docker run -d file-server-image\n' + HOOK, COMPOSE)
        # Quoted, escaped and embedded hashes still permit real continuations.
        for argument in ['"#"', "'#'", r'\#', 'value#hash']:
            with self.subTest(argument=argument):
                line = f'sudo docker run --rm --label {argument} \\\n  -d file-server-image\n'
                with self.assertRaisesRegex(ValueError, 'direct container startup at line 1:'):
                    web_services(line + HOOK, COMPOSE)

    def test_absolute_docker_binary_is_checked(self):
        for executable in ['/usr/bin/docker', 'sudo /usr/local/bin/docker']:
            with self.subTest(executable=executable):
                changed = self.replace_once(HOOK, 'sudo docker run --rm', executable + ' run --rm')
                self.assertEqual(web_services(changed, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})
                for command in ['run -d file-server-image', 'container start file-server']:
                    with self.assertRaisesRegex(ValueError, 'direct container startup at line 1:'):
                        web_services(f'{executable} {command}\n' + HOOK, COMPOSE)

    def test_heredoc_quote_does_not_continue_a_comment_to_startup(self):
        for quote in ['"', "'"]:
            with self.subTest(quote=quote):
                prefix = f'cat <<EOF\nsay {quote}hi\nEOF\n# previous form: docker run --rm \\\n'
                with self.assertRaisesRegex(ValueError, 'direct container startup at line 5:'):
                    web_services(prefix + 'sudo docker run -d file-server-image\n' + HOOK, COMPOSE)

    def test_binary_paths_in_arguments_are_not_commands(self):
        for line in [
            'sudo ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose',
            'echo "using /usr/local/bin/docker-compose" >&2',
            'echo /usr/local/bin/docker-compose up -d file-server',
            'echo sudo docker-compose up -d file-server',
            'env LABEL=docker-compose echo docker-compose up -d file-server',
            'echo docker run -d file-server-image',
        ]:
            with self.subTest(line=line):
                self.assertEqual(web_services(line + '\n' + HOOK, COMPOSE),
                                 {'server', 'nginx-proxy', 'polis-api'})

    def test_commands_after_wrappers_and_shell_operators_are_checked(self):
        for prefix, suffix in [
            ('', ''), ('sudo ', ''), ('env MODE=test ', ''),
            ('sudo -u root env MODE=test ', ''), ('MODE=test ', ''),
            ('command -- ', ''), ('echo done; ', ''), ('echo done && ', ''),
            ('echo done || ', ''), ('echo done | ', ''), ('echo done & ', ''),
            ('(', ')'), ('X=$(', ')'),
            ('if [ "$OPTIONAL" = 1 ]; then ', '; fi'),
        ]:
            for command, message in [
                ('/usr/local/bin/docker-compose up -d file-server', 'direct Compose command'),
                ('/usr/bin/docker run -d file-server-image', 'direct container startup'),
            ]:
                with self.subTest(prefix=prefix, command=command):
                    with self.assertRaisesRegex(ValueError, message + ' at line 1:'):
                        web_services(prefix + command + suffix + '\n' + HOOK, COMPOSE)

    def test_docker_global_options_do_not_hide_compose_startup(self):
        for options in ['--context default', '-c default', '--context=default',
                        '--host unix:///tmp/docker.sock', '-H unix:///tmp/docker.sock',
                        '--config /tmp/config', '--log-level debug', '-l debug',
                        '--context default --host=unix:///tmp/docker.sock']:
            for executable in ['sudo docker', 'env MODE=test /usr/bin/docker']:
                with self.subTest(options=options, executable=executable):
                    prefix = f'{executable} {options} compose -f a.yml '
                    with self.assertRaisesRegex(ValueError, 'direct Compose command at line 1:'):
                        web_services(prefix + 'up -d file-server\n' + HOOK, COMPOSE)
                    self.assertEqual(web_services(prefix + 'config --quiet\n' + HOOK, COMPOSE),
                                     {'server', 'nginx-proxy', 'polis-api'})

    def test_docker_global_options_do_not_hide_container_startup(self):
        for options in ['--context default', '--host=unix:///tmp/docker.sock',
                        '--config /tmp/config --log-level debug']:
            with self.subTest(options=options):
                prefix = f'sudo docker {options} '
                for command in ['run -d file-server-image', 'container start file-server']:
                    with self.assertRaisesRegex(ValueError, 'direct container startup at line 1:'):
                        web_services(prefix + command + '\n' + HOOK, COMPOSE)
                self.assertEqual(web_services(prefix + 'run --rm migration-image\n' + HOOK, COMPOSE),
                                 {'server', 'nginx-proxy', 'polis-api'})

    def test_commands_after_other_prefixes_are_checked(self):
        for prefix, suffix in [
            ('case "$MODE" in on) ', ' ;; esac'),
            ('case "$MODE" in\n  on) ', ' ;;\nesac'),
            ('TAG=$(cat tag) ', ''), ('{ ', '; }'),
            ('exec ', ''), ('nohup ', ''), ('time ', ''), ('timeout 600 ', ''),
            ('nice -n 5 ', ''), ('sudo -nu root ', ''), ('>/dev/null ', ''),
        ]:
            for command, message in [
                ('/usr/local/bin/docker-compose up -d file-server', 'direct Compose command'),
                ('/usr/bin/docker run -d file-server-image', 'direct container startup'),
            ]:
                with self.subTest(prefix=prefix, command=command):
                    number = 2 if '\n' in prefix else 1
                    with self.assertRaisesRegex(ValueError, message + f' at line {number}:'):
                        web_services(prefix + command + suffix + '\n' + HOOK, COMPOSE)

    def test_docker_lookups_start_nothing(self):
        for line in ['sudo docker --version', 'docker -v', 'docker --help >/dev/null']:
            with self.subTest(line=line):
                self.assertEqual(web_services(line + '\n' + HOOK, COMPOSE),
                                 {'server', 'nginx-proxy', 'polis-api'})

    def test_docker_lookup_options_do_not_hide_a_subcommand(self):
        for option in ['--version', '-v', '--help']:
            for command, message in [
                ('run -d file-server-image', 'direct container startup'),
                ('container start file-server', 'direct container startup'),
                ('compose up -d file-server', 'direct Compose command'),
                ('--context default compose up -d file-server', 'direct Compose command'),
            ]:
                with self.subTest(option=option, command=command):
                    with self.assertRaisesRegex(ValueError, message + ' at line 1:'):
                        web_services(f'sudo docker {option} {command}\n' + HOOK, COMPOSE)
            for command in ['run --rm migration-image', 'compose config --quiet']:
                with self.subTest(option=option, command=command):
                    self.assertEqual(web_services(f'docker {option} {command}\n' + HOOK, COMPOSE),
                                     {'server', 'nginx-proxy', 'polis-api'})

    def test_docker_global_options_require_values(self):
        for option in ['--context', '-c', '--host', '-H', '--config', '--log-level', '-l']:
            with self.subTest(option=option):
                with self.assertRaisesRegex(ValueError, 'missing Docker option value at line 1:'):
                    web_services(f'COMPOSE=(sudo docker {option})\n' + HOOK, COMPOSE)

    def test_function_header_spacing_and_keyword(self):
        for header in ['worker_daemon () {', 'worker_daemon\t() {',
                       'function worker_daemon {', 'function worker_daemon() {',
                       'function worker_daemon () {']:
            with self.subTest(header=header):
                changed = self.replace_once(HOOK, 'worker_daemon() {', header)
                self.assertEqual(web_services(changed, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})
                changed += 'sudo docker run -d file-server-image\n'
                with self.assertRaisesRegex(ValueError, 'sudo docker run -d file-server-image'):
                    web_services(changed, COMPOSE)

    def test_role_images_error_names_candidate_lines(self):
        assignment = '  server) ROLE_IMAGES="server nginx-proxy polis-api" ;;'
        for replacement in [assignment.replace('server) ', 'server)  '),
                            assignment + '\n' + assignment, '  server) ;;']:
            with self.subTest(replacement=replacement):
                changed = self.replace_once(HOOK, assignment, replacement)
                with self.assertRaises(ValueError) as caught:
                    web_services(changed, COMPOSE)
                message = str(caught.exception)
                self.assertIn('unrecognized web ROLE_IMAGES assignment', message)
                for number, line in enumerate(changed.splitlines(), 1):
                    if 'server)' in line:
                        self.assertIn(f'line {number}: {line.strip()}', message)
        with self.assertRaisesRegex(ValueError, r'no server\) case line found'):
            web_services('', COMPOSE)

    def test_host_sources_follow_maps_and_pools(self):
        docs = {
            'pool.conf': 'upstream pool { server missing-service:8080; }',
            'map.conf': 'map $uri $target { default ""; /api pool; }',
            'site.conf': 'proxy_pass http://$target;',
            'other.conf': 'proxy_pass http://server:5000;',
        }
        sources = {}
        self.assertEqual(nginx_hosts(docs, sources), {'missing-service', 'server'})
        self.assertEqual(sources['missing-service'], {'pool.conf', 'map.conf', 'site.conf'})
        self.assertEqual(sources['server'], {'other.conf'})

    def test_missing_host_names_the_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            folder = root / 'file-server/nginx'
            (folder / 'extra.conf').write_text('proxy_pass http://missing-service:8080;')
            with self.assertRaises(ValueError) as caught:
                check(root)
            self.assertIn('missing-service', str(caught.exception))
            self.assertIn('file-server/nginx/extra.conf', str(caught.exception))

    def test_other_roles_and_function_definitions_do_not_start_web_services(self):
        changed = self.replace_once(HOOK, '  sudo docker run -d delphi-image',
                                    '  sudo docker start delphi-image')
        self.assertEqual(web_services(changed, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})

    def test_direct_serving_start_names_the_line(self):
        for command in ['sudo docker run -d image', 'docker container start image',
                        'docker run --rm -d image', 'docker run --rm --detach=true image',
                        'docker run image --rm', 'docker run --rm --unknown image',
                        'docker run --rm image; docker run -d serving-image']:
            for position in ['shared', 'web']:
                with self.subTest(command=command, position=position):
                    changed = (command + '\n' + HOOK if position == 'shared' else
                               self.replace_once(HOOK, '  "${COMPOSE[@]}" up -d server',
                                                 command + '\n  "${COMPOSE[@]}" up -d server'))
                    with self.assertRaises(ValueError) as caught:
                        web_services(changed, COMPOSE)
                    self.assertIn(command, str(caught.exception))
                    self.assertRegex(str(caught.exception), r'line \d+:')

    def test_nested_and_alternative_role_branches(self):
        for condition, selected in [('== "server"', True), ('!= "server"', False),
                                    ('== "delphi"', False)]:
            extra = f'''if [ "$SERVICE_FROM_FILE" {condition} ]; then
  if [ "$OPTIONAL" = 1 ]; then
    docker start unexpected-service
  fi
else
  if [ "$OPTIONAL" = 1 ]; then echo "optional"; fi
fi
'''
            with self.subTest(condition=condition):
                if selected:
                    with self.assertRaisesRegex(ValueError, 'docker start unexpected-service'):
                        web_services(HOOK + extra, COMPOSE)
                else:
                    self.assertEqual(web_services(HOOK + extra, COMPOSE), {'server', 'nginx-proxy', 'polis-api'})
        with self.assertRaisesRegex(ValueError, 'docker start shared-service'):
            web_services(HOOK + extra + 'docker start shared-service\n', COMPOSE)

    def test_renderer_error_includes_stderr(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            (root / 'file-server/nginx/render-rust-api.sh').write_text(
                '# /etc/nginx/rust-api-templates/\necho "unknown route(s): example" >&2\nexit 1\n')
            with self.assertRaisesRegex(ValueError, r'unknown route\(s\): example'):
                check(root)

    def test_other_pass_directives_require_an_explicit_reader(self):
        for name in ['grpc_pass', 'uwsgi_pass', 'fastcgi_pass', 'scgi_pass', 'memcached_pass']:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, name):
                nginx_hosts({'example.conf': f'{name} file-server:8080;'})


    # The shadow of the vote writer runs the polis-api image, which the hook
    # pulls once for both services.
    SHADOW_START = ('  if [ "$SHADOW_SELECTED" = 1 ]; then\n'
                    '    "${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate polis-api-shadow\n'
                    '  fi\n')
    SHADOW_COMPOSE = COMPOSE + '  polis-api-shadow:\n    image: rust\n'

    def with_shadow(self):
        return self.replace_once(HOOK, '  fi\nelif', '  fi\n' + self.SHADOW_START + 'elif')

    def test_shadow_runs_the_polis_api_image(self):
        self.assertEqual(web_services(self.with_shadow(), self.SHADOW_COMPOSE),
                         {'server', 'nginx-proxy', 'polis-api', 'polis-api-shadow'})

    def test_shadow_without_its_image_is_refused(self):
        changed = self.replace_once(self.with_shadow(), 'ROLE_IMAGES="server nginx-proxy polis-api"',
                                    'ROLE_IMAGES="server nginx-proxy"')
        changed = self.replace_once(changed, 'up -d --no-deps --no-build --force-recreate polis-api\n',
                                    'up -d --no-deps --no-build --force-recreate server\n')
        with self.assertRaisesRegex(ValueError, 'image/start'):
            web_services(changed, self.SHADOW_COMPOSE)

    def test_another_service_cannot_borrow_an_image(self):
        changed = self.replace_once(self.with_shadow(), 'polis-api-shadow\n', 'polis-api-copy\n')
        compose = self.SHADOW_COMPOSE.replace('polis-api-shadow:', 'polis-api-copy:')
        with self.assertRaisesRegex(ValueError, 'image/start'):
            web_services(changed, compose)

    def test_shadow_absent_from_compose_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'Compose'):
            web_services(self.with_shadow(), COMPOSE)

    def test_repository_shadow_target_is_a_started_web_service(self):
        # The renderer's shadow selection is rendered too, so its literal
        # mirror target is checked against what the hook starts.
        result = check(ROOT)
        self.assertIn('polis-api-shadow', result['hosts'])
        self.assertIn('polis-api-shadow', result['web_services'])
        self.assertGreaterEqual(result['shadow_selections'], 1)

    def test_repository_renders_every_shadow_beside_every_route(self):
        # The vote shadow, the comment shadow and the three read shadows are
        # rendered together, with every route none of them is refused with:
        # the write shadows copy to the one service the hook starts for them,
        # the read shadows to the read shadow service the hook starts.
        result = check(ROOT)
        self.assertEqual(result['shadows'], ['commentsReadShadow', 'commentsShadow', 'nextCommentShadow',
                                             'votesReadShadow', 'votesShadow'])
        self.assertEqual(result['shadow_selections'], 1)
        self.assertIn('polis-api-shadow', result['web_services'])
        self.assertIn('polis-api-shadow-reads', result['hosts'])
        self.assertIn('polis-api-shadow-reads', result['web_services'])

    # The read shadow service runs the polis-api image too.
    READS_START = ('  if [ "$READS_SHADOW_SELECTED" = 1 ]; then\n'
                   '    "${COMPOSE[@]}" up -d --no-deps --no-build --force-recreate polis-api-shadow-reads\n'
                   '  fi\n')
    READS_COMPOSE = SHADOW_COMPOSE + '  polis-api-shadow-reads:\n    image: rust\n'

    def test_read_shadow_runs_the_polis_api_image(self):
        hook = self.replace_once(self.with_shadow(), self.SHADOW_START, self.SHADOW_START + self.READS_START)
        self.assertEqual(web_services(hook, self.READS_COMPOSE),
                         {'server', 'nginx-proxy', 'polis-api', 'polis-api-shadow', 'polis-api-shadow-reads'})
        with self.assertRaisesRegex(ValueError, 'Compose'):
            web_services(hook, self.SHADOW_COMPOSE)

    def test_read_mirror_target_must_be_started(self):
        docs = {'mirror.conf': 'set $polis_shadow_target polis-api-shadow-reads:5102;\n'
                               'limit_req_zone $polis_shadow_name zone=polis_shadow_votesReadShadow:1m rate=4r/s;\n'
                               'location = /_polis_shadow/votesReadShadow { internal; '
                               'set $polis_shadow_name votesReadShadow; '
                               'limit_req zone=polis_shadow_votesReadShadow nodelay; '
                               'proxy_pass http://$polis_shadow_target/api/v3/votes$is_args$args; }'}
        self.assertEqual(nginx_hosts(docs), {'polis-api-shadow-reads'})

    def test_comment_mirror_target_must_be_started(self):
        docs = {'mirror.conf': 'set $polis_shadow_target polis-api-shadow:5101;\n'
                               'limit_req_zone $polis_shadow_name zone=polis_shadow_commentsShadow:1m rate=2r/s;\n'
                               'location = /_polis_shadow/commentsShadow { internal; '
                               'set $polis_shadow_name commentsShadow; '
                               'limit_req zone=polis_shadow_commentsShadow burst=4 nodelay; '
                               'proxy_pass http://$polis_shadow_target/api/v3/comments; }'}
        self.assertEqual(nginx_hosts(docs), {'polis-api-shadow'})

    def test_mirror_target_must_be_started(self):
        docs = {'mirror.conf': 'set $polis_shadow_target polis-api-shadow:5101;\n'
                               'location = /_polis_shadow/votesShadow { internal; '
                               'proxy_pass http://$polis_shadow_target/api/v3/votes; }'}
        self.assertEqual(nginx_hosts(docs), {'polis-api-shadow'})


if __name__ == '__main__':
    unittest.main(verbosity=2)
