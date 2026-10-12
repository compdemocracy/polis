#!/usr/bin/env bash
# Public-repo hygiene guard.
#
# Usage: scripts/check-public-hygiene.sh <base-ref>
#
# Scans the lines ADDED by `git diff <base-ref>...HEAD` and the messages of the
# commits in <base-ref>..HEAD for references to private working material
# (internal paths, local home directories, internal tracker ids and names).
# Prints every hit as `file:line: text` or `commit <sha>: text` and exits 1 if
# any hit is not listed, as an exact line, in scripts/public-hygiene-allowlist.txt.
# Exits 0 when there is no unlisted hit, 2 on a usage or git error.
#
# Hosted CI runs this same script (.github/workflows/public-hygiene.yml); run it
# locally before pushing:  scripts/check-public-hygiene.sh origin/edge
#
# The patterns below are written with bracket fragments so this file never
# matches itself.

set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <base-ref>" >&2
  exit 2
fi
base="$1"

root="$(git rev-parse --show-toplevel)"
allowlist_rel="scripts/public-hygiene-allowlist.txt"
allowlist="$root/$allowlist_rel"

if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
  echo "error: base ref '$base' is not a commit here (fetch it, or check out with full history)" >&2
  exit 2
fi

# Matched case-insensitively.
ci_pattern='agent-cont[e]xt|cost-reducti[o]n/|polis-ast[r]a|polis-clau[d]e|\bast[r]a\b|02-find[i]ngs|04-pl[a]ns|not[e]s/(ops|topics)|dock[e]t|#1[0-9]{3}\b|synth[e]tic'
# Matched case-sensitively: a macOS home directory. The lower-case form is an
# API path in this product and is not a hit.
cs_pattern='/U[s]ers/'

tab="$(printf '\t')"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Each candidate is "<location><TAB><text>"; only the text is matched.
match() {
  { grep -iE "${tab}.*(${ci_pattern})" "$1" || true
    grep -E "${tab}.*(${cs_pattern})" "$1" || true
  } | sort -u
}

# 1. Lines added by the diff, as "path:line<TAB>text". The allowlist itself is
#    skipped: its entries are hits by construction.
git diff --no-color --no-ext-diff --unified=0 "${base}...HEAD" \
  | awk -v skip="$allowlist_rel" '
      /^diff --git / { inhdr = 1; file = ""; next }
      inhdr && /^\+\+\+ / {
        file = substr($0, 5)
        if (file == "/dev/null") file = ""
        else sub(/^b\//, "", file)
        next
      }
      /^@@ / {
        inhdr = 0
        split($0, f, " ")
        n = f[3]; sub(/^\+/, "", n); sub(/,.*/, "", n)
        line = n + 0
        next
      }
      inhdr { next }
      /^\+/ {
        if (file != "" && file != skip) print file ":" line "\t" substr($0, 2)
        line++
      }
    ' > "$tmp/added"

# 2. Commit messages in the range, as "commit <sha><TAB>text".
: > "$tmp/messages"
for sha in $(git rev-list "${base}..HEAD"); do
  git log -1 --format=%B "$sha" | awk -v s="$sha" '{ print "commit " s "\t" $0 }' >> "$tmp/messages"
done

cat "$tmp/added" "$tmp/messages" > "$tmp/candidates"
match "$tmp/candidates" > "$tmp/hits"

# 3. Drop hits whose text is an exact allowlisted line.
touch "$tmp/allow"
[ -f "$allowlist" ] && cp "$allowlist" "$tmp/allow"
awk -F '\t' '
  NR == FNR { ok[$0] = 1; next }
  {
    text = substr($0, index($0, "\t") + 1)
    if (!(text in ok)) print
  }
' "$tmp/allow" "$tmp/hits" > "$tmp/new"

added=$(wc -l < "$tmp/added" | tr -d ' ')
total=$(wc -l < "$tmp/hits" | tr -d ' ')
new=$(wc -l < "$tmp/new" | tr -d ' ')

if [ "$new" -gt 0 ]; then
  echo "public-repo hygiene: $new new private reference(s) since $base:"
  sed "s/${tab}/: /" "$tmp/new"
  echo
  echo "Remove them. If a line is genuinely public, add its exact text to $allowlist_rel."
  exit 1
fi

echo "public-repo hygiene: clean ($added added line(s) scanned, $total allowlisted hit(s), base $base)"
