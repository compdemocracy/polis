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


if __name__ == '__main__':
    unittest.main(verbosity=2)
