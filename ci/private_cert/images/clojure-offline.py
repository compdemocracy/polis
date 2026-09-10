#!/usr/bin/env python3
"""Use the baked resolved Maven closure, never a resolver or network download."""
import os
from pathlib import Path
import sys

if sys.argv[1:2] != ['-M:replay']:
    raise SystemExit('Only the admitted replay alias is available')
# The admitted oracle build must provide exactly one resolved classpath. Source
# and dev/test paths from its build are discarded; only pinned JARs are retained.
paths = list(Path('/opt/oracle-classpath').glob('*.cp'))
if len(paths) != 1:
    raise SystemExit('A single reviewed oracle classpath is required')
jars = []
for item in paths[0].read_text().strip().split(':'):
    if item.startswith('/root/.m2/repository/') and item.endswith('.jar'):
        path = item.replace('/root/.m2/repository/', '/opt/m2/', 1)
        if not Path(path).is_file():
            raise SystemExit('Incomplete offline oracle dependency closure')
        jars.append(path)
if not jars or not Path('src/polismath/math/conversation.clj').is_file():
    raise SystemExit('Missing admitted math source/classpath')
classpath = ':'.join(['src', *jars])
os.execv('/opt/java/openjdk/bin/java', ['java', '-Xmx64g', '-cp', classpath,
         'clojure.main', '-i', 'dev/replay.clj', '-m', 'replay', *sys.argv[2:]])
