#!/usr/bin/env bash
set -euo pipefail
ZIP="${1:-}"; CHK="${2:-${ZIP}.sha256}"; [ -f "$ZIP" ] || exit 1
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$ZIP" "$TMP" <<'PYZIP'
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); n=z.namelist()
assert len(n)==len(set(n))
for p in n: assert not p.startswith('/') and '..' not in p.split('/')
z.extractall(sys.argv[2])
PYZIP
R="$TMP/repo"; [ -f "$R/MANIFEST.json" ] || R="$TMP"; E="$R/validation/expected-files.json"
P=0; F=0; ok(){ P=$((P+1)); }; fl(){ F=$((F+1)); echo "FAIL: $1"; }
[ "$(find "$TMP" -name MANIFEST.json -type f|wc -l)" -eq 1 ] && ok || fl manifest
EXP=$(jq -r '.files[].path' "$E"|sort); ACT=$(cd "$R"&&find . -type f|sed 's#^./##'|sort)
[ -z "$(comm -23 <(printf '%s
' "$EXP") <(printf '%s
' "$ACT"))" ] && ok || fl missing
[ -z "$(comm -13 <(printf '%s
' "$EXP") <(printf '%s
' "$ACT"))" ] && ok || fl unexpected
H=0; Z=0; U=0
while IFS=$'	' read -r f h b c x; do [ -n "$c" ]||U=$((U+1)); [ -s "$R/$f" ]||Z=$((Z+1)); if [ "$x" = SELF_REFERENTIAL_METADATA ]; then jq empty "$R/$f" >/dev/null||H=$((H+1)); else [ "$(sha256sum "$R/$f"|awk '{print $1}')" = "$h" ]||H=$((H+1)); [ "$(stat -c%s "$R/$f")" = "$b" ]||H=$((H+1)); fi; done < <(jq -r '.files[]|[.path,.sha256,(.bytes|tostring),.classification,(.exemption_reason//"")]|@tsv' "$E")
[ "$H" -eq 0 ]&&ok||fl hash; [ "$Z" -eq 0 ]&&ok||fl empty; [ "$U" -eq 0 ]&&ok||fl class
[ -f "$CHK" ] && (cd "$(dirname "$ZIP")"&&sha256sum -c "$(basename "$CHK")" >/dev/null) && ok || fl checksum
echo "Package integrity: PASS=$P FAIL=$F"; [ "$F" -eq 0 ]
