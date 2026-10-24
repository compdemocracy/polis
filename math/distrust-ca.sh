#!/bin/sh
# Remove the four alternate anchors identified in the October 2026 CA disclosure.
set -eu
listing=$(mktemp)
aliases=$(mktemp)
trap 'rm -f "$listing" "$aliases"' EXIT
list_blocked() {
  keytool -J-Duser.language=en -list -v -cacerts -storepass changeit > "$listing"
  grep -q '^Alias name:' "$listing"
  awk '
    /^Alias name:/ {alias=substr($0,13)}
    /SHA256:/ {
      hash=$0; sub(/^.*SHA256: */,"",hash); gsub(/:/,"",hash)
      if (hash == "86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B" ||
          hash == "D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4" ||
          hash == "7DD78D5F4F13459A83DFF9ABBBA62EDBAF6F2D102BF257FD712F4D9F2746ED8D" ||
          hash == "F2EDAAFF3D9B701FB4D14C9F285F8C0BAD90FC3BCC1FA07D47F4718EDABA34A5") print alias
    }' "$listing"
}
list_blocked > "$aliases"
while IFS= read -r alias; do
  keytool -delete -cacerts -storepass changeit -alias "$alias"
done < "$aliases"
list_blocked > "$aliases"
test ! -s "$aliases"
