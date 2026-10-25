#!/usr/bin/env python3
"""Prepare Polis promotion PRs and review packets; publish only by explicit command."""
import argparse
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SEMVER = r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
BEGIN = '<!-- polis-release-plan -->'
END = '<!-- /polis-release-plan -->'
MIRRORS = ('VERSION', 'polis-cli/Cargo.toml', 'polis-cli/Cargo.lock')
# REST calls publication may still make after the live notes check: the
# environment, approvals, release list, tag object and ref, and about twelve
# gh release calls (create, eight uploads, edit), with margin.
PUBLICATION_CALLS = 50


def run(argv, *, cwd=ROOT, data=None):
    return subprocess.run(list(map(str, argv)), cwd=cwd, input=data, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout.strip()


def git(*args):
    return run(['git', *args])


def sha(value):
    if not re.fullmatch(r'[0-9a-f]{40}', value):
        raise ValueError('A full lowercase commit SHA is required')
    return value


def repository(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', value):
        raise ValueError('Expected owner/repository')
    return value


def api(repo, path, *, data=None, missing=False, method="POST"):
    argv = ['gh', 'api', f'repos/{repository(repo)}/{path}']
    if data is not None:
        argv += ['--method', method, '--input', '-']
    try:
        return json.loads(run(argv, data=None if data is None else json.dumps(data)))
    except subprocess.CalledProcessError as error:
        if missing and 'HTTP 404' in (error.stderr or ''):
            return None
        raise


def pages(repo, path):
    result = []
    for page in range(1, 1001):
        rows = api(repo, f'{path}{"&" if "?" in path else "?"}per_page=100&page={page}')
        if not isinstance(rows, list):
            raise ValueError('Expected a paginated list')
        result.extend(rows)
        if len(rows) < 100:
            return result
    raise ValueError('Pagination ceiling reached; refusing incomplete release notes')


def remote_head(branch):
    lines = git('ls-remote', 'origin', f'refs/heads/{branch}').splitlines()
    if len(lines) != 1:
        raise ValueError(f'Missing remote {branch} branch')
    return sha(lines[0].split()[0])


def tags():
    result = {}
    for name in git('for-each-ref', '--format=%(refname:strip=2)', 'refs/tags').splitlines():
        if re.fullmatch('v' + SEMVER, name):
            result[name] = sha(git('rev-parse', '--verify', f'refs/tags/{name}^{{commit}}'))
    return result


def check_remote_tags(local):
    refs = {}
    peeled = {}
    for line in git('ls-remote', '--tags', 'origin').splitlines():
        commit, ref = line.split()
        name = ref.removeprefix('refs/tags/')
        if name.endswith('^{}'):
            peeled[name[:-3]] = commit
        else:
            refs[name] = commit
    actual = {n: peeled.get(n, c) for n, c in refs.items() if re.fullmatch('v' + SEMVER, n)}
    if actual != local:
        raise ValueError('Remote release tags changed; refresh the checkout and prepare again')


@contextmanager
def compute_view(inventory):
    """Read original objects through an isolated tag view, including on a retry.

    The pending tag is omitted only after its exact target has been checked.
    No original ref is removed or changed; the temporary bare repo is discarded.
    """
    if git('rev-parse', '--is-shallow-repository') != 'false' or git('replace', '-l'):
        raise ValueError('Complete, unreplaced history is required')
    objects = (ROOT / git('rev-parse', '--git-path', 'objects')).resolve()
    with tempfile.TemporaryDirectory(prefix='polis-release-') as directory:
        bare = Path(directory)
        run(['git', 'init', '--bare', '--quiet', bare])
        (bare / 'objects/info/alternates').write_text(str(objects) + '\n')
        for name, commit in inventory.items():
            run(['git', '-C', bare, 'update-ref', 'refs/tags/' + name, commit])
        yield bare


def compute(tool, stable, candidate, *, pending=None):
    inventory = tags()
    check_remote_tags(inventory)
    if pending:
        tag, commit = pending
        if tag in inventory:
            if inventory[tag] != commit:
                raise ValueError('Release tag points to a different commit')
            inventory = {n: c for n, c in inventory.items() if n != tag}
    with compute_view(inventory) as repo:
        plan = json.loads(run([tool, 'plan', '--repo', repo, '--stable', sha(stable),
                               '--candidate', sha(candidate), '--rule', 'effective-selection', '--json']))
    if (plan['schema'] != 'polis.release-plan/1' or plan['kind'] != 'promotion'
            or not plan['new_number'] or plan['candidate_commit'] != candidate
            or plan['previous_stable_commit'] != stable):
        raise ValueError('Unexpected compute-tool plan')
    return plan


def markdown(value):
    value = ' '.join(str(value).split())
    return re.sub(r'([\\`*_{}\[\]()<>#!|])', r'\\\1', value)


def plan_section(plan):
    migrations = '\n'.join('- `' + name + '`' for name in plan['release_lines']) or '- none'
    return (f'{BEGIN}\n### Release plan\n\nVersion: **{plan["version"]}**\n\n'
            f'Reason: {markdown(plan["reason"])}\n\n'
            f'Previous stable: `{plan["previous_stable_commit"]}`\n\n'
            f'Candidate: `{plan["candidate_commit"]}`\n\n'
            f'release.txt additions:\n{migrations}\n\n'
            'Merge the reviewed version preparation into edge, then refresh this plan '
            'for the resulting edge SHA before merging the promotion with a merge commit.\n'
            f'{END}')


def replace_section(body, section):
    if BEGIN not in body and END not in body:
        return body.rstrip() + '\n\n' + section + '\n'
    if body.count(BEGIN) != 1 or body.count(END) != 1 or body.index(BEGIN) > body.index(END):
        raise ValueError('Ambiguous release-plan markers in PR body')
    return body[:body.index(BEGIN)] + section + body[body.index(END) + len(END):]


def mirror_changes(root, version):
    if not re.fullmatch(SEMVER, version):
        raise ValueError('Invalid computed version')
    cargo = (root / MIRRORS[1]).read_text()
    cargo, count = re.subn(r'(\[workspace\.package\]\nversion = ")[^"\n]+',
                           lambda m: m[1] + version, cargo)
    if count != 1:
        raise ValueError('Unrecognized Cargo workspace mirror')
    lock = (root / MIRRORS[2]).read_text()
    for name in ('polis', 'polis-client'):
        lock, count = re.subn(r'(\[\[package\]\]\nname = "' + name + r'"\nversion = ")[^"\n]+',
                             lambda m: m[1] + version, lock)
        if count != 1:
            raise ValueError('Unrecognized Cargo lock mirror')
    return dict(zip(MIRRORS, (version + '\n', cargo, lock)))


def upsert_pr(repo, head, base, title, section, *, draft=False):
    found = pages(repo, f'pulls?state=open&base={base}&head={repo.split("/")[0]}:{head}')
    if len(found) > 1:
        raise ValueError('Multiple open PRs for this branch')
    if found:
        pr = found[0]
        # Update the PR through the issue endpoint, preserving all non-plan prose.
        api(repo, f'issues/{pr["number"]}', data={'body': replace_section(pr.get('body') or '', section)}, method='PATCH')
        return pr
    return api(repo, 'pulls', data={'head': head, 'base': base, 'title': title,
                                  'body': section, 'draft': draft})


def prepare(repo, tool, candidate, *, open_pr=False):
    sha(candidate)
    stable = remote_head('stable')
    if remote_head('edge') != candidate or git('rev-parse', 'HEAD') != candidate:
        raise ValueError('Candidate must be the checked-out current edge head')
    plan = compute(tool, stable, candidate)
    if not open_pr:
        return plan
    # Validate every mirror before --write changes VERSION. Keep the local
    # preparation and the review PR on the same version, without resolving deps.
    changes = mirror_changes(ROOT, plan['version'])
    # --write is deliberately explicit and runs before any PR/ref mutation.
    written = json.loads(run([tool, 'plan', '--repo', ROOT, '--stable', stable,
                              '--candidate', candidate, '--rule', 'effective-selection', '--json', '--write']))
    if written != plan:
        raise ValueError('Plan moved before VERSION write')
    for path, content in changes.items():
        (ROOT / path).write_text(content)
    entries = []
    for path, content in changes.items():
        if git('show', f'{candidate}:{path}') + '\n' != content:
            entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'content': content})
    if remote_head('edge') != candidate or remote_head('stable') != stable:
        raise ValueError('Branches moved; no preparation PR was written')
    if entries:
        branch = f'polis-release/prepare-{stable[:12]}-{candidate[:12]}'
        tree = api(repo, 'git/trees', data={'base_tree': plan['candidate_tree'], 'tree': entries})['sha']
        existing = api(repo, f'git/ref/heads/{branch}', missing=True)
        if existing:
            current = api(repo, 'git/commits/' + existing['object']['sha'])
            if current['tree']['sha'] != tree or [p['sha'] for p in current['parents']] != [candidate]:
                raise ValueError('Preparation branch changed; refusing to overwrite it')
        else:
            commit = api(repo, 'git/commits', data={'message': f'Prepare Polis {plan["version"]}',
                                                   'tree': tree, 'parents': [candidate]})['sha']
            api(repo, 'git/refs', data={'ref': 'refs/heads/' + branch, 'sha': commit})
        upsert_pr(repo, branch, 'edge', f'Prepare Polis {plan["version"]}', plan_section(plan))
    promotion = upsert_pr(repo, 'edge', 'stable', f'Promote edge to stable: Polis {plan["version"]}',
                          plan_section(plan), draft=True)
    return dict(plan=plan, promotion=promotion['html_url'], preparation_needed=bool(entries))


def notes_data(repo, previous, stable, source):
    commits = git('rev-list', '--reverse', f'{previous}..{source}').splitlines()
    all_commits = set(commits + [stable])
    promotion = [p for p in pages(repo, f'commits/{stable}/pulls')
                 if p.get('merged_at') and p.get('merge_commit_sha') == stable
                 and p.get('base', {}).get('ref') == 'stable']
    if len(promotion) != 1:
        raise ValueError('Expected exactly one merged stable promotion PR')
    chosen, direct, seen = {}, [], set()
    for commit in commits:
        matches = [p for p in pages(repo, f'commits/{commit}/pulls')
                   if p.get('merged_at') and p.get('merge_commit_sha') in all_commits
                   and p['number'] != promotion[0]['number']]
        if len(matches) != 1:
            direct.append({'commit': commit, 'title': git('show', '-s', '--format=%s', commit)})
            continue
        pr = matches[0]
        if pr['number'] in seen:
            continue
        seen.add(pr['number'])
        # Only reserved preparation branches need a file lookup. Ordinary PRs
        # remain in the notes even when they happen to change only metadata.
        if pr.get('head', {}).get('ref', '').startswith('polis-release/prepare-'):
            paths = [f['filename'] for f in pages(repo, f'pulls/{pr["number"]}/files')]
            if paths and set(paths) <= set(MIRRORS):
                continue
        chosen[pr['number']] = {'number': pr['number'], 'title': pr['title'], 'merged_at': pr['merged_at']}
    return {'promotion': promotion[0]['number'],
            'prs': sorted(chosen.values(), key=lambda p: (p['merged_at'], p['number'])),
            'direct_commits': direct}


def render_notes(repo, plan, stable, notes):
    previous = plan['previous_tag'] or plan['previous_stable_commit']
    base = f'https://github.com/{repository(repo)}'
    lines = [f'Polis {plan["version"]}', '', f'Previous: {previous}', f'Commit: {stable}',
             f'Promotion: {base}/pull/{notes["promotion"]}',
             'schema: ' + ('yes' if plan['release_lines'] else 'no'), '', 'Migrations:']
    lines += ['- `' + n + '`' for n in plan['release_lines']] or ['none']
    lines += ['', 'Changes:']
    lines += [f'- {markdown(p["title"])} ([PR #{p["number"]}]({base}/pull/{p["number"]}))' for p in notes['prs']]
    if notes['direct_commits']:
        lines += ['', 'Commits without one verified PR association (review explicitly):']
        lines += [f'- {markdown(p["title"])} ([{p["commit"][:12]}]({base}/commit/{p["commit"]}))'
                  for p in notes['direct_commits']]
    lines += ['', f'[Compare]({base}/compare/{previous}...{stable})',
              f'[Migration guide]({base}/blob/{stable}/docs/migrations.md)', '']
    return '\n'.join(lines)


def release_source(repo, tool, stable):
    sha(stable)
    if remote_head('stable') != stable or git('rev-parse', 'HEAD') != stable:
        raise ValueError('Publication requires the checked-out current stable head')
    parents = git('show', '-s', '--format=%P', stable).split()
    if len(parents) != 2:
        raise ValueError('Stable must be a two-parent promotion merge')
    previous, source = parents
    if git('rev-parse', stable + '^{tree}') != git('rev-parse', source + '^{tree}'):
        raise ValueError('Stable merge tree differs from the promoted source')
    version = git('show', stable + ':VERSION')
    if not re.fullmatch(SEMVER, version):
        raise ValueError('Stable VERSION is not canonical')
    tag = 'v' + version
    plan = compute(tool, previous, source, pending=(tag, stable))
    if plan['version'] != version:
        raise ValueError('Stable VERSION differs from the computed promotion number')
    for path, content in mirror_changes(ROOT, version).items():
        if git('show', f'{stable}:{path}') + '\n' != content:
            raise ValueError('Stable version mirrors were not prepared')
    # A canonical release must carry the canonical updater before advertising it.
    updater = git('show', stable + ':polis-cli/crates/polis/src/update.rs')
    if 'strip_prefix("v")' not in updater:
        raise ValueError('The canonical-tag updater must be merged before publication')
    return {'schema': 'polis.publication/1', 'repository': repository(repo), 'stable': stable,
            'tag': tag, 'plan': plan}


def release_packet(repo, tool, stable, *, notes=None):
    result = release_source(repo, tool, stable)
    plan = result['plan']
    if notes is None:
        notes = notes_data(repo, plan['previous_stable_commit'], stable, plan['candidate_commit'])
    result['notes_data'] = notes
    result['notes'] = render_notes(repo, plan, stable, notes)
    return result


def save_packet(packet, directory):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'publication.json').write_text(json.dumps(packet, indent=2, sort_keys=True) + '\n')
    (directory / 'notes.md').write_text(packet['notes'])


def gate(repo, reviewer):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]*', reviewer):
        raise ValueError('Set POLIS_RELEASE_REVIEWER to the designated release approver login')
    env = api(repo, 'environments/release')
    rules = [r for r in env.get('protection_rules', []) if r['type'] == 'required_reviewers']
    if (len(rules) != 1 or [(r['type'], r['reviewer']['login']) for r in rules[0]['reviewers']] != [('User', reviewer)]):
        raise ValueError('release environment must require the designated sole reviewer')
    return env['id']


def approved_run(repo, reviewer, environment_id):
    run_id = os.environ.get('GITHUB_RUN_ID', '')
    if (os.environ.get('GITHUB_ACTIONS') != 'true' or not run_id.isdigit()
            or os.environ.get('GITHUB_RUN_ATTEMPT') != '1'):
        raise ValueError('Publication requires a fresh manually dispatched approved workflow; use printed commands for manual publication')
    history = api(repo, f'actions/runs/{run_id}/approvals')
    if not any(row.get('state') == 'approved' and row.get('user', {}).get('login') == reviewer
               and any(e.get('id') == environment_id for e in row.get('environments', []))
               for row in history):
        raise ValueError('No release approval by the designated reviewer in this run')


def load_publisher():
    spec = importlib.util.spec_from_file_location('publish_cli', ROOT / 'scripts/publish-polis-cli-release.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_packet(packet, repo, tool, *, snapshot_notes=False):
    fresh = release_packet(repo, tool, packet['stable'],
                           notes=packet['notes_data'] if snapshot_notes else None)
    if fresh != packet:
        raise ValueError('Release inputs or notes changed after review; prepare and approve again')


def require_api_budget(packet, *, live_notes):
    """Refuse while nothing is written if the hourly REST budget cannot finish.

    GET /rate_limit does not count against the limit. The live notes check
    needs one call per promoted commit, the promotion lookup and a preparation
    PR file list; publication then needs PUBLICATION_CALLS.
    """
    needed = PUBLICATION_CALLS
    if live_notes:
        plan = packet['plan']
        commits = git('rev-list', '--count',
                      f'{sha(plan["previous_stable_commit"])}..{sha(plan["candidate_commit"])}')
        needed += int(commits) + 2
    core = json.loads(run(['gh', 'api', 'rate_limit']))['resources']['core']
    if core['remaining'] < needed:
        raise ValueError(f'GitHub API budget too low: {core["remaining"]} calls remain, {needed} needed; '
                         'dispatch again after the hourly reset')
    return needed


def tag_annotation(packet):
    """One deterministic annotation for API publication and prepared commands."""
    plan = packet['plan']
    previous = plan['previous_tag'] or plan['previous_stable_commit']
    lines = [f'Polis {plan["version"]}', f'Previous: {previous}',
             f'Stable: {packet["stable"]}', f'Source: {plan["candidate_commit"]}',
             f'Promotion: https://github.com/{repository(packet["repository"])}/pull/{packet["notes_data"]["promotion"]}',
             'schema: ' + ('yes' if plan['release_lines'] else 'no'), 'Migrations:']
    lines += ['- ' + name for name in plan['release_lines']] or ['none']
    return '\n'.join(lines) + '\n'


def verify_tag_annotation(packet):
    """Existing refs are immutable, including a tag with the right peeled target."""
    repo, tag = packet['repository'], packet['tag']
    ref = api(repo, f'git/ref/tags/{tag}')
    if ref['object']['type'] != 'tag':
        raise ValueError('Release tag must be annotated')
    obj = api(repo, 'git/tags/' + sha(ref['object']['sha']))
    if (obj['tag'] != tag or obj['object']['type'] != 'commit'
            or obj['object']['sha'] != packet['stable']
            or obj['message'] != tag_annotation(packet)):
        raise ValueError('Release tag annotation or target differs; never overwrite a tag')


def publication(packet, assets, tool, *, execute=False, reviewer='', snapshot_notes=False):
    repo, tag, commit = packet['repository'], packet['tag'], packet['stable']
    if execute and snapshot_notes:
        raise ValueError('Publication must recheck live release notes')
    if execute:
        require_api_budget(packet, live_notes=True)
    verify_packet(packet, repo, tool, snapshot_notes=snapshot_notes)
    publisher = load_publisher()
    files = publisher.validate(assets, tag, commit)
    if not execute:
        inventory = tags()
        check_remote_tags(inventory)
        if tag in inventory:
            verify_tag_annotation(packet)
        return {'tag': tag, 'stable': commit,
                'assets': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
    environment_id = gate(repo, reviewer)
    approved_run(repo, reviewer, environment_id)
    # The tag endpoint omits drafts, including those left by failed uploads.
    matches = [release for release in pages(repo, 'releases') if release['tag_name'] == tag]
    if len(matches) > 1:
        raise ValueError('Multiple releases for this tag; explicit review/cleanup required')
    existing = matches[0] if matches else None
    if existing:
        if existing['draft'] or existing['prerelease'] or existing['body'] != packet['notes'] or existing['name'] != f'Polis {tag[1:]}':
            raise ValueError('Existing release differs or is a partial draft; explicit review/cleanup required')
        inventory = tags()
        check_remote_tags(inventory)
        if inventory.get(tag) != commit:
            raise ValueError('Existing release is missing its matching immutable tag')
        verify_tag_annotation(packet)
        with tempfile.TemporaryDirectory(prefix='polis-release-verify-') as directory:
            run(['gh', 'release', 'download', tag, '--repo', repo, '--dir', directory])
            remote_files = publisher.validate(Path(directory), tag, commit)
            if {p.name: p.read_bytes() for p in remote_files} != {p.name: p.read_bytes() for p in files}:
                raise ValueError('Published assets differ; never overwrite a release')
        return {'already_published': True}
    # Re-read the remote immediately before the first public write.
    if remote_head('stable') != commit:
        raise ValueError('Stable moved after approval')
    # Refuse before the tag rather than run out between the tag and the uploads.
    require_api_budget(packet, live_notes=False)
    inventory = tags()
    check_remote_tags(inventory)
    if tag not in inventory:
        obj = api(repo, 'git/tags', data={'tag': tag, 'message': tag_annotation(packet),
                                        'object': commit, 'type': 'commit'})
        # Ref creation fails on a collision; never move an existing tag.
        api(repo, 'git/refs', data={'ref': 'refs/tags/' + tag, 'sha': sha(obj['sha'])})
    elif inventory[tag] != commit:
        raise ValueError('Release tag collision')
    else:
        verify_tag_annotation(packet)
    with tempfile.TemporaryDirectory(prefix='polis-release-notes-') as directory:
        notes = Path(directory) / 'notes.md'
        notes.write_text(packet['notes'])
        publisher.publish(assets, tag, commit, repo, notes)
    return {'published': tag}


def commands(packet, assets, tool, packet_path):
    # Printing is the default; values are shell-quoted, never evaluated here.
    repo, tag, commit = packet['repository'], packet['tag'], packet['stable']
    publisher = load_publisher()
    files = publisher.validate(assets, tag, commit)
    rows = ['set -eu', f'# Stable {commit}; review notes.md and all eight checksums first.',
            '# Choose this manual path OR the approved workflow, never both.',
            shlex.join(['python3', 'scripts/polis_release.py', 'verify', '--packet', str(packet_path),
                        '--tool', str(tool), '--assets', str(assets)]),
            '# If this exact annotated tag exists, verification above checks it; omit tag/push.',
            shlex.join(['git', 'tag', '-a', tag, commit, '--cleanup=verbatim', '-m', tag_annotation(packet)]),
            shlex.join(['git', 'push', 'origin', f'refs/tags/{tag}']),
            shlex.join(['gh', 'release', 'create', tag, '--repo', repo, '--verify-tag', '--draft',
                        '--title', f'Polis {tag[1:]}', '--notes-file', str(packet_path.parent / 'notes.md')]),
            shlex.join(['gh', 'release', 'upload', tag, '--repo', repo, *map(str, files)]),
            shlex.join(['gh', 'release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'])]
    return '\n'.join(rows) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'plan', 'source', 'verify', 'commands', 'publish', 'gate'])
    parser.add_argument('--repository', default=os.environ.get('GH_REPO'))
    parser.add_argument('--tool', type=Path)
    parser.add_argument('--candidate')
    parser.add_argument('--stable')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--packet', type=Path)
    parser.add_argument('--assets', type=Path)
    parser.add_argument('--open-pr', action='store_true')
    parser.add_argument('--snapshot-notes', action='store_true',
                        help='Reuse planned notes for preapproval verification only')
    parser.add_argument('--commands-output', type=Path,
                        help='Write manual commands after the same verification')
    parser.add_argument('--reviewer', default=os.environ.get('POLIS_RELEASE_REVIEWER', ''))
    args = parser.parse_args()
    try:
        if args.snapshot_notes and args.action != 'verify':
            raise ValueError('--snapshot-notes is only allowed for verify')
        if args.commands_output is not None and args.action != 'verify':
            raise ValueError('--commands-output is only allowed for verify')
        if args.action == 'gate':
            gate(repository(args.repository or ''), args.reviewer)
            return
        if args.tool is None or not args.tool.is_file():
            raise ValueError('--tool must name a built polis-version binary')
        tool = args.tool.resolve()
        if args.action == 'prepare':
            result = prepare(repository(args.repository or ''), tool, args.candidate or '', open_pr=args.open_pr)
        elif args.action == 'source':
            result = release_source(repository(args.repository or ''), tool, args.stable or '')
        elif args.action == 'plan':
            result = release_packet(repository(args.repository or ''), tool, args.stable or '')
            if args.output is None:
                raise ValueError('--output is required')
            save_packet(result, args.output)
        else:
            if args.packet is None or args.assets is None:
                raise ValueError('--packet and --assets are required')
            packet = json.loads(args.packet.read_text())
            if args.stable is not None and sha(args.stable) != packet['stable']:
                raise ValueError('--stable differs from the reviewed packet')
            if (args.packet.parent / 'notes.md').read_text() != packet['notes']:
                raise ValueError('Packet notes do not match the reviewed JSON')
            if args.action == 'commands':
                verify_packet(packet, packet['repository'], tool)
                print(commands(packet, args.assets, tool, args.packet), end='')
                return
            result = publication(packet, args.assets, tool, execute=args.action == 'publish',
                                 reviewer=args.reviewer, snapshot_notes=args.snapshot_notes)
            if args.commands_output is not None:
                args.commands_output.write_text(commands(packet, args.assets, tool, args.packet))
        print(json.dumps(result, indent=2, sort_keys=True))
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Polis release: {error}\n')


if __name__ == '__main__':
    main()
