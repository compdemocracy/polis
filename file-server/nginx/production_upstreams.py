"""Read the checked-in production topology; never execute the deployment hook.

This deliberately accepts the shell/Compose forms used by after_install.sh,
not arbitrary shell or YAML. Changes to those forms must extend this reader.
Nginx variables used as hosts must resolve through a literal set or map;
unknown host expressions are errors, not omitted upstreams.
Only .conf/.template files below the nginx directory are collected. Includes
are not followed: an included file with another extension is outside coverage.
Other *_pass directives are rejected until their address syntax is supported.
The shell reader handles the current line-oriented conditionals and function
definitions; it does not execute shell or trace calls into helper functions.
Startup moved into a helper or a new shell form needs a matching reader change.
"""
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

# No external upstreams are currently needed. Any future exception must name
# the host here and explain why production can reach it without a Compose service.
EXCEPTIONS = {}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def logical_lines(script):
    """Join shell continuations, retaining the first physical line number."""
    pending, start, quote = '', None, None
    for number, line in enumerate(script.splitlines(), 1):
        if start is None:
            start = number
        # A shell comment begins at an unquoted word boundary. Track quotes
        # across physical lines without tokenizing unrelated shell messages.
        boundary, comment, index = True, False, 0
        while index < len(line):
            char = line[index]
            if quote == "'":
                if char == "'":
                    quote = None
            elif char == '\\':
                index += 1
                boundary = False
            elif quote == '"':
                if char == '"':
                    quote = None
            elif char in {'"', "'"}:
                quote = char
                boundary = False
            elif char == '#' and boundary:
                comment = True
                break
            else:
                boundary = char.isspace() or char in ';|&()'
            index += 1
        # An odd trailing backslash count escapes the newline, except in a
        # comment: its newline ends the comment even after a backslash.
        trailing = len(line) - len(line.rstrip('\\'))
        if (trailing % 2 and not comment and quote != "'"
                and not line.lstrip().startswith('#')):
            pending += line[:-1]
            continue
        yield start, pending + line
        pending, start = '', None
    require(start is None, f'incomplete shell continuation at line {start}: {pending}')


def web_lines(script):
    """Yield possible web-role lines, including shared top-level commands."""
    active, conditions, function = True, [], None
    for number, line in logical_lines(script):
        stripped = line.strip()
        if function is not None:
            if re.fullmatch(r'}\s*(?:#.*)?', stripped):
                function = None
            continue
        if re.match(r'^(?:function\s+[a-zA-Z_][a-zA-Z_0-9]*(?:\s*\(\))?'
                    r'|[a-zA-Z_][a-zA-Z_0-9]*\s*\(\))\s*\{', stripped):
            if not re.search(r'[;&]\s*}\s*(?:#.*)?$', stripped):
                function = (number, stripped)
            continue
        if not stripped or stripped.startswith('#'):
            continue
        keyword = stripped.split(None, 1)[0]
        if keyword in {'if', 'elif'}:
            condition = line.split('; then', 1)[0]
            role = re.search(r'"\$SERVICE_FROM_FILE"\s+(==|=|!=)\s+"([a-z-]+)"', condition)
            require('$SERVICE_FROM_FILE' not in condition or role is not None,
                    f'unrecognized role condition at line {number}: {stripped}')
            # Other conditions can take either arm; include both possibilities.
            matches = None if role is None else ((role[2] == 'server') != (role[1] == '!='))
            if keyword == 'if':
                parent, previous, opening = active, False, (number, stripped)
            else:
                require(conditions, f'elif without if at line {number}: {stripped}')
                parent, previous, opening = conditions.pop()
            current = parent and not previous and matches is not False
            if re.search(r'\bfi\s*(?:;|$)', stripped):
                if current:
                    yield number, line
                continue
            conditions.append((parent, previous or matches is True, opening))
            active = current
        elif keyword.rstrip(';') == 'else':
            require(conditions, f'else without if at line {number}: {stripped}')
            parent, previous, _ = conditions[-1]
            active = parent and not previous
        elif keyword.rstrip(';') == 'fi':
            require(conditions, f'fi without if at line {number}: {stripped}')
            active, _, _ = conditions.pop()
        if active:
            yield number, line
    if function is not None:
        number, line = function
        raise ValueError(f'incomplete shell function at line {number}: {line}')
    if conditions:
        number, line = conditions[-1][2]
        raise ValueError(f'incomplete shell conditional at line {number}: {line}')


def foreground_run(command):
    """Recognize disposable foreground runs; never count them as services."""
    if not command or command[0] != 'run':
        return False
    arguments = iter(command[1:])
    disposable = False
    takes_value = {'--network', '--env-file', '--stop-timeout', '--name', '--entrypoint',
                   '--user', '-u', '--workdir', '-w', '--volume', '-v', '--mount', '--env', '-e',
                   '--pull', '--log-driver', '--log-opt', '--platform', '--add-host', '--label'}
    for word in arguments:
        if word in {'--rm', '--rm=true'}:
            disposable = True
        elif word in {'--init', '-i', '--interactive', '-t', '--tty', '--detach=false'}:
            continue
        elif word in takes_value:
            if next(arguments, None) is None:
                return False
        elif '=' in word and word.split('=', 1)[0] in takes_value:
            continue
        elif word.startswith('-') or word in {';', '&&', '||'}:
            return False
        else:
            # The first non-option is the image; later words are its command,
            # not Docker options (e.g. an application's own --rm flag).
            return disposable
    return False


def command_positions(words):
    """Locate commands in the supported shell forms, excluding their arguments."""
    expecting, wrapper, value = True, None, False
    wrapper_values = {
        'sudo': {'-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt',
                 '-C', '--close-from', '-D', '--chdir', '-R', '--chroot'},
        'env': {'-u', '--unset', '-C', '--chdir'},
        'command': set(),
    }
    # Commands that never run their arguments; after any other command word
    # (exec, nohup, time, timeout, '{', a case pattern) a command may follow.
    inert = {'echo', 'printf', 'ln', 'test', '['}
    for index, word in enumerate(words):
        if word and all(c in '();&|' for c in word):
            # A case pattern ends with ')', and NAME=$(...) can prefix a command.
            expecting = True
            wrapper, value = None, False
            continue
        if not expecting:
            continue
        if value:
            value = False
            continue
        if wrapper and word.startswith('-'):
            if wrapper == 'command' and word in {'-v', '-V'}:
                expecting = False  # A lookup does not execute its argument.
            value = word in wrapper_values[wrapper]
            continue
        if re.match(r'^[a-zA-Z_][a-zA-Z_0-9]*=', word):
            continue
        if word in {'if', 'elif', 'then', 'else', 'do', 'while', 'until', '!'}:
            continue
        executable = os.path.basename(word)
        if executable in wrapper_values:
            wrapper = executable
            continue
        yield index
        expecting, wrapper = executable not in inert, None


def web_services(script, compose):
    # Inspect the image case and actual startup separately: pulling an image
    # alone does not mean a service runs. Rust is conditional on route selection.
    images = re.findall(r'^\s*server\) ROLE_IMAGES="([a-z0-9 -]+)" ;;$', script, re.M)
    if len(images) != 1:
        candidates = [f'line {number}: {line.strip()}'
                      for number, line in enumerate(script.splitlines(), 1)
                      if re.match(r'^\s*server\)', line)]
        location = ('at ' + '; '.join(candidates) if candidates
                    else '(no server) case line found)')
        raise ValueError(f'unrecognized web ROLE_IMAGES assignment {location}')
    images = set(images[0].split())
    started = set()
    for number, line in web_lines(script):
        # Unrelated shell text (including multi-line messages) needs no lexer.
        if not re.search(r'\bdocker\b', line) and '${COMPOSE[@]}' not in line:
            continue
        location = f'line {number}: {line.strip()}'
        try:
            lexer = shlex.shlex(line, posix=True, punctuation_chars='();&|')
            lexer.whitespace_split = True
            words = list(lexer)
        except ValueError as error:
            raise ValueError(f'shell tokenization failed at {location}: {error}') from error
        for index in command_positions(words):
            word = os.path.basename(words[index])
            if word not in {'docker', 'docker-compose'}:
                continue
            command = words[index + 1:]
            # Array definitions and substitutions terminate at shell punctuation.
            stop = next((i for i, token in enumerate(command)
                         if token and all(c in '();&|' for c in token)), len(command))
            command = command[:stop]
            if word == 'docker':
                options = {'--context', '-c', '--host', '-H', '--config', '--log-level', '-l',
                           '--tlscacert', '--tlscert', '--tlskey'}
                while command and command[0].startswith('-'):
                    option = command[0]
                    if option in options:
                        require(len(command) >= 2 and not command[1].startswith('-'),
                                f'missing Docker option value at {location}')
                        command = command[2:]
                    elif '=' in option and option.split('=', 1)[0] in options:
                        require(option.split('=', 1)[1], f'missing Docker option value at {location}')
                        command = command[1:]
                    elif option in {'--debug', '-D', '--tls', '--tlsverify',
                                    '--version', '-v', '--help'}:
                        # Docker can still run a subcommand after lookup options.
                        command = command[1:]
                    else:
                        raise ValueError(f'unrecognized Docker option {option!r} at {location}')
            if word == 'docker-compose' or (word == 'docker' and command[:1] == ['compose']):
                if word == 'docker':
                    command = command[1:]
                # Global options precede the Compose subcommand.
                options = {'-f', '--file', '--profile', '--env-file', '-p',
                           '--project-name', '--project-directory'}
                while command:
                    if command[0] in options:
                        require(len(command) >= 2,
                                f'missing Compose option value at {location}')
                        command = command[2:]
                    elif '=' in command[0] and command[0].split('=', 1)[0] in options:
                        command = command[1:]
                    else:
                        break
                require(command[:1] in ([], ['config']),
                        f'unrecognized direct Compose command at {location}; use ${{COMPOSE[@]}}')
                continue
            if word != 'docker':
                continue
            if command[:1] == ['container']:
                command = command[1:]
            if command[:1] in (['run'], ['start']):
                require(foreground_run(command), f'unrecognized direct container startup at {location}')
        if '${COMPOSE[@]}' not in words:
            continue
        command = words[words.index('${COMPOSE[@]}') + 1:]
        if command in (['--profile', 'rust-api', 'down'], ['config', '--quiet']):
            continue
        require(command and command[0] == 'up', f'unrecognized web Compose command at {location}')
        for word in command[1:]:
            if word in {'-d', '--no-deps', '--no-build', '--force-recreate', 'then', ';'}:
                continue
            require(re.fullmatch(r'[a-z][a-z0-9-]*', word), f'unrecognized startup argument {word!r} at {location}')
            started.add(word)
    require(started == images, f'web image/start mismatch: images={sorted(images)}, started={sorted(started)}')
    # Service names are two-space keys under services, not similarly indented
    # networks/volumes. Reject alternative formatting rather than infer a name.
    section = re.search(r'^services:\n(.*?)(?=^[^\s#]|\Z)', compose, re.M | re.S)
    require(section is not None, 'missing Compose services block')
    services = dict(re.findall(r'^  ([a-z][a-z0-9-]*):\n(.*?)(?=^  [^\s#]|\Z)', section[1], re.M | re.S))
    require(started <= services.keys(), f'web services absent from Compose: {sorted(started - services.keys())}')
    # Current dependencies use short list syntax. Every dependency of a web
    # service must already be in the explicit start list (no implicit additions).
    for name in started:
        dependencies = re.findall(r'^    depends_on:\n((?:^      .*\n)+)', services[name], re.M)
        require(len(dependencies) == len(re.findall(r'^    depends_on:', services[name], re.M)),
                f'unrecognized Compose dependency syntax for {name}')
        for deps in dependencies:
            names = set()
            for line in deps.splitlines():
                match = re.fullmatch(r'      - ["\']?([a-z][a-z0-9-]*)["\']?', line)
                require(match is not None, f'unrecognized Compose dependency for {name}: {line}')
                names.add(match[1])
            require(names <= started, f'Compose dependencies not explicitly started for {name}: {sorted(names - started)}')
    return started


def directives(text):
    # Braces inside ${variables} and quoted tokens are not block delimiters.
    pattern = r'''\s+|\#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]|(?:\$\{[^}]+\}|\\.|[^\s{};"'\#])+'''
    tokens = []
    pos = 0
    for match in re.finditer(pattern, text):
        require(match.start() == pos, 'unrecognized nginx token')
        pos = match.end()
        token = match[0]
        if token.isspace() or token.startswith('#'):
            continue
        if token[:1] in {'"', "'"}:
            token = token[1:-1]
        tokens.append(token)
    require(pos == len(text), 'unrecognized nginx trailing text')
    stack, words, result = [], [], []
    for token in tokens:
        if token == '{':
            require(words, 'nginx block without header')
            stack.append(tuple(words))
            words = []
        elif token == '}':
            require(stack and not words, 'unbalanced nginx block')
            stack.pop()
        elif token == ';':
            require(words, 'empty nginx directive')
            result.append((tuple(stack), words))
            words = []
        else:
            words.append(token)
    require(not stack and not words, 'incomplete nginx configuration')
    return result


def nginx_hosts(documents, sources=None):
    """Resolve hosts, optionally recording config files along each reference."""
    rows = [(name, *row) for name, text in documents.items() for row in directives(text)]
    variables, pools, targets = {}, {}, []
    for name, stack, words in rows:
        if stack and stack[-1][0] == 'upstream':
            pool = stack[-1][1]
            pools.setdefault(pool, [])
            if words[0] == 'server':
                require(len(words) >= 2, 'upstream server without address')
                pools[pool].append((words[1], name))
                targets.append((words[1], name))
        if stack and stack[-1][0] == 'map':
            variable = stack[-1][-1]
            if words[0] not in {'hostnames', 'volatile', 'include'}:
                require(len(words) == 2, 'unrecognized nginx map value')
                variables.setdefault(variable, set()).add((words[1], name))
        if words[0] == 'set':
            require(len(words) == 3, 'unrecognized nginx set')
            variables.setdefault(words[1], set()).add((words[2], name))
        require(not words[0].endswith('_pass') or words[0] == 'proxy_pass',
                f'unsupported nginx upstream directive: {words[0]}')
        if words[0] == 'proxy_pass':
            require(len(words) == 2 and re.match(r'https?://', words[1]), 'unrecognized proxy_pass')
            targets.append((re.sub(r'^https?://', '', words[1]), name))

    def resolve(value, origins, seen=frozenset()):
        if not value:
            return set()  # Empty map default selects the Node fallback.
        # Request suffixes after a resolved host do not determine its identity.
        value = re.split(r'[/ ?]', value, maxsplit=1)[0]
        match = re.match(r'^\$(?:\{(\w+)\}|(\w+))', value)
        if match:
            key = '$' + (match[1] or match[2])
            suffix = value[match.end():]
            require(not suffix or suffix in {'$request_uri', '$uri'} or re.fullmatch(r':\d+(?:\$request_uri|\$uri)?', suffix),
                    f'unrecognized variable host suffix: {value}')
            require(key in variables and key not in seen, f'unresolved nginx host: {key}')
            return set().union(*(resolve(v, origins | {name}, seen | {key}) for v, name in variables[key]))
        # Ports may be rendered defaults; unresolved variables anywhere in the
        # authority are errors. Unix sockets require an explicit implementation.
        require(re.fullmatch(r'[A-Za-z0-9._-]+(?::\d+)?', value), f'unresolved nginx address: {value}')
        host = value.split(':')[0]
        if host in pools:
            require(host not in seen and pools[host], f'empty or circular upstream: {host}')
            return set().union(*(resolve(v, origins | {name}, seen | {host}) for v, name in pools[host]))
        if sources is not None:
            sources.setdefault(host, set()).update(origins)
        return {host}

    return set().union(*(resolve(value, {name}) for value, name in targets))


def check(root):
    root = Path(root)
    services = web_services((root / 'scripts/after_install.sh').read_text(),
                            (root / 'docker-compose.yml').read_text())
    folder = root / 'file-server/nginx'
    paths = sorted(folder.rglob('*.template')) + sorted(folder.rglob('*.conf'))
    require(paths, 'no nginx templates found')
    defaults = {'API_SERVER_PORT': '5000', 'STATIC_FILES_PORT': '8080'}
    upstreams = re.findall(r'^\s*- RUST_API_UPSTREAM=\$\{RUST_API_UPSTREAM:-([^}]+)\}$',
                           (root / 'docker-compose.yml').read_text(), re.M)
    require(len(upstreams) == 1, 'unrecognized Compose Rust upstream default')
    documents = {}
    for path in paths:
        if path == folder / 'rust-api/upstreams.conf.template':
            continue  # Its map placeholders are checked after the real renderer.
        value = path.read_text()
        for key, default in defaults.items():
            value = value.replace('${' + key + '}', default)
        documents[str(path.relative_to(root))] = value
    # Select every route template, which includes the representative Node
    # fallback, simple API, regex API and page forms, and future route templates.
    routes = sorted(p.name.removesuffix('.location.conf.template')
                    for p in (folder / 'rust-api').glob('*.location.conf.template')
                    if p.name != 'node.location.conf.template')
    require(routes, 'no Rust route templates found')
    with tempfile.TemporaryDirectory(prefix='nginx-upstreams-') as temporary:
        temp = Path(temporary)
        # Only relocate the renderer's container-local template directory.
        renderer = (folder / 'render-rust-api.sh').read_text()
        require('/etc/nginx/rust-api-templates/' in renderer, 'renderer template path changed')
        renderer = renderer.replace('/etc/nginx/rust-api-templates/', str(folder / 'rust-api') + '/')
        script = temp / 'render.sh'
        script.write_text(renderer)
        env = {'PATH': os.environ['PATH'], 'RUST_API_ROUTES': ','.join(routes),
               'RUST_API_UPSTREAM': upstreams[0], **defaults}
        result = subprocess.run(['sh', str(script), str(temp / 'rendered')], env=env,
                                capture_output=True, text=True)
        require(result.returncode == 0,
                f'Rust route renderer failed (exit {result.returncode}): {result.stderr.strip()}')
        for path in sorted((temp / 'rendered').glob('*.conf')):
            require(path.stat().st_size > 0, f'empty rendered file: {path.name}')
            documents['rendered/' + path.name] = path.read_text()
    sources = {}
    hosts = nginx_hosts(documents, sources)
    require(hosts, 'no nginx upstream hosts found')
    for host, reason in EXCEPTIONS.items():
        require(reason.strip(), f'exception needs an explanation: {host}')
    missing = hosts - services - EXCEPTIONS.keys()
    details = {host: sorted(sources[host]) for host in sorted(missing)}
    require(not missing, f'nginx upstreams absent from production web role: {sorted(missing)}; configs: {details}')
    return {'hosts': sorted(hosts), 'web_services': sorted(services),
            'source_configs': len(paths), 'rendered_routes': len(routes)}
