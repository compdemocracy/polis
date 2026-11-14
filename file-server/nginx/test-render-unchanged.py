#!/usr/bin/env python3
"""Every selection an earlier renderer knows renders byte for byte as before.

  test-render-unchanged.py BASE [--image IMAGE]

BASE is a git revision of this repository (the commit a change is built on).
Its file-server/nginx/render-rust-api.sh and rust-api/ templates are taken
with `git archive`, and both renderers, BASE's and the working tree's, are
run on the same list of selections: nothing, every route name BASE knows
alone and named twice, every subset of the names that share a path with the
participation routes or with each other, the selections the routing and
shadow tests start, names BASE refuses together, unknown names, and bad
upstream and resolver settings. For each, both renderers must exit alike and
write the same two files, byte for byte. Their error lines must be the same
but for the list of known names, which may only have gained the names in
NEW_NAMES. Neither selection may name a NEW_NAMES selector: what this checks
is that a name nobody has selected changes nothing.

With --image the renderers run in that image (the nginx-proxy image: the
shell, envsubst and awk production renders with); without it, on this host.
"""
import argparse
import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# The names this change adds. A selection that names none of them must render
# what it rendered before.
NEW_NAMES = ('votesReadShadow', 'commentsReadShadow', 'nextCommentShadow')
# Names that share a path or a location with each other or with the
# participation routes: every subset of them is rendered.
CROSSED = ('pca2', 'votesRead', 'postVotes', 'votesShadow', 'comments', 'commentsShadow', 'nextComment',
           'votesFamous', 'reportComments', 'metadataQuery', 'version')
# The selections the routing and shadow tests start, in their spellings.
SPELLED = ('', ' ', ',', ' , ,', 'pca2', 'pca2,votesShadow', 'pca2,votesShadow,commentsShadow',
           'commentsShadow,votesShadow,pca2', 'pca2 votesShadow commentsShadow', 'pca2,\tcomments\n',
           'votesShadow,votesShadow', 'commentsShadow,commentsShadow', 'votesRead,votesShadow',
           'votesShadow,votesRead', 'comments,commentsShadow', 'commentsShadow,comments',
           'votesRead,comments,votesShadow,commentsShadow', 'postVotes,votesShadow', 'votesShadow postVotes',
           'commentsShadow,postVotes,votesShadow', 'commentsShadow,postComments', 'pca2,commentsShadow,postComments',
           'commentsShadow,postVotes', 'pca2,conversationPage,robots,adminPage',
           'pca2,conversationPage,votesRead,comments,nextComment', 'votesRead,postVotes,ptptois',
           'bogus', 'pca2,bogus', 'votesreadshadow', 'VotesReadShadow', 'readShadow', 'votesShadows')
# Settings other than the list that change what the renderer does.
SETTINGS = ({}, {'RUST_API_UPSTREAM': 'not a host'}, {'RUST_API_RESOLVER': 'bad;resolver'},
            {'RUST_API_UPSTREAM': 'polis-api:5199'})

# One render per line of the plan: an id, then the settings as NAME=value
# words (tab separated), with the selection last. The driver runs both
# renderers for every line and leaves, for each, exit status, error output
# and the two files.
DRIVER = r'''#!/bin/sh
set -u
work=$1
while IFS='	' read -r id upstream resolver routes; do
  for tree in base new; do
    out="$work/out/$tree/$id"
    mkdir -p "$out/files"
    (
      [ "$upstream" = "-" ] && unset RUST_API_UPSTREAM || export RUST_API_UPSTREAM="$upstream"
      [ "$resolver" = "-" ] && unset RUST_API_RESOLVER || export RUST_API_RESOLVER="$resolver"
      export RUST_API_ROUTES="$routes"
      export API_SERVER_PORT=5000
      sh "$work/$tree/render.sh" "$out/files" >"$out/stdout" 2>"$out/stderr"
      echo $? >"$out/status"
    )
  done
done <"$work/plan.tsv"
'''


def extract(revision, into):
    archive = subprocess.run(['git', '-C', str(ROOT), 'archive', revision, 'file-server/nginx'],
                             check=True, capture_output=True).stdout
    with tempfile.NamedTemporaryFile(suffix='.tar') as file:
        file.write(archive)
        file.flush()
        with tarfile.open(file.name) as tar:
            tar.extractall(into, filter="data")
    return Path(into) / 'file-server/nginx'


def known_names(renderer):
    """The route names a renderer's case arms accept."""
    return set(re.findall(r'^    ([A-Za-z0-9-]+)\)$', renderer, re.M))


def place(source, work, tree, templates_at):
    """The tree's renderer and templates under work/tree, the renderer reading
    its templates from where they are at render time."""
    (work / tree).mkdir()
    shutil.copytree(source / 'rust-api', work / tree / 'rust-api')
    renderer = (source / 'render-rust-api.sh').read_text()
    assert renderer.count('/etc/nginx/rust-api-templates/') >= 5, 'the renderer\'s template path changed'
    (work / tree / 'render.sh').write_text(
        renderer.replace('/etc/nginx/rust-api-templates/', f'{templates_at}/{tree}/rust-api/'))
    return renderer


def plan(base_names):
    selections = list(SPELLED)
    for name in sorted(base_names):
        selections += [name, f'{name},{name}']
    for size in range(2, len(CROSSED) + 1):
        selections += [','.join(subset) for subset in itertools.combinations(CROSSED, size)]
    everything = sorted(base_names)
    selections.append(','.join(everything))
    selections.append(','.join(n for n in everything if n not in ('postVotes', 'postComments')))
    lines = []
    for settings in SETTINGS:
        for routes in (selections if not settings else SPELLED[:8] + ('pca2,votesShadow,commentsShadow',)):
            assert not any(name in re.split(r'[,\s]+', routes) for name in NEW_NAMES), routes
            lines.append((settings.get('RUST_API_UPSTREAM', '-'), settings.get('RUST_API_RESOLVER', '-'), routes))
    return lines


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('base')
    parser.add_argument('--image')
    arguments = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='render-unchanged-') as temporary:
        work = Path(temporary)
        os.chmod(work, 0o755)
        base_source = extract(arguments.base, work / 'archive')
        templates_at = '/w' if arguments.image else str(work)
        base_renderer = place(base_source, work, 'base', templates_at)
        new_renderer = place(ROOT / 'file-server/nginx', work, 'new', templates_at)
        base_names, new_names = known_names(base_renderer), known_names(new_renderer)
        assert new_names == base_names | set(NEW_NAMES), (sorted(new_names - base_names), sorted(base_names - new_names))
        lines = plan(base_names - {'*'})
        # A tab inside a selection would split the plan's fields: write it
        # as the renderer splits it (a blank), which it treats the same.
        rows = [f'{i}\t{u}\t{r}\t{routes.replace(chr(9), " ").replace(chr(10), " ")}'
                for i, (u, r, routes) in enumerate(lines)]
        (work / 'plan.tsv').write_text('\n'.join(rows) + '\n')
        (work / 'driver.sh').write_text(DRIVER)
        if arguments.image:
            subprocess.run(['docker', 'run', '--rm', '--entrypoint', 'sh', '-v', f'{work}:/w', arguments.image,
                            '/w/driver.sh', '/w'], check=True)
        else:
            subprocess.run(['sh', str(work / 'driver.sh'), str(work)], check=True)
        known = re.compile(r'\(known: [^)]*\)')
        differences, refused, rendered = [], 0, 0
        for index, (upstream, resolver, routes) in enumerate(lines):
            base, new = work / 'out/base' / str(index), work / 'out/new' / str(index)
            label = json.dumps({'routes': routes, 'upstream': upstream, 'resolver': resolver})
            if (base / 'status').read_text() != (new / 'status').read_text():
                differences.append(f'{label}: exit {(base / "status").read_text().strip()} before, '
                                   f'{(new / "status").read_text().strip()} now')
                continue
            for name in ('upstreams.conf', 'locations.conf'):
                before, after = (base / 'files' / name).read_bytes(), (new / 'files' / name).read_bytes()
                if before != after:
                    differences.append(f'{label}: {name} differs ({len(before)} bytes before, {len(after)} now)')
            before_err, after_err = (base / 'stderr').read_text(), (new / 'stderr').read_text()
            listed, old = known.findall(after_err), known.findall(before_err)
            if len(listed) != len(old) or any(set(now[8:-1].split()) != set(was[8:-1].split()) | set(NEW_NAMES)
                                              for now, was in zip(listed, old)):
                differences.append(f'{label}: the known names are not the old ones and {NEW_NAMES}: {listed} {old}')
            if known.sub('(known)', before_err) != known.sub('(known)', after_err):
                differences.append(f'{label}: error output differs: {before_err!r} before, {after_err!r} now')
            if (base / 'stdout').read_bytes() != (new / 'stdout').read_bytes():
                differences.append(f'{label}: standard output differs')
            if (new / 'status').read_text().strip() == '0':
                rendered += 1
            else:
                refused += 1
        if differences:
            print('\n'.join(differences[:40]), file=sys.stderr)
            print(f'FAIL: {len(differences)} of {len(lines)} selections render differently', file=sys.stderr)
            sys.exit(1)
        print(f'ok render unchanged: {len(lines)} selections without a new name ({rendered} rendered, {refused} '
              f'refused), {len(base_names)} names {arguments.base} knows: both renderers exit alike and write the '
              f'same upstreams.conf and locations.conf byte for byte; error output differs only in the list of '
              f'known names, which gained exactly {", ".join(NEW_NAMES)}'
              + (f' (run in {arguments.image})' if arguments.image else ' (run on this host)'), flush=True)


if __name__ == '__main__':
    main()
