#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os, shutil, stat, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_ROOT = ROOT / ".task3-3-package-out"
PKG_NAME = "task3-3-conversational-runtime-closure-v1"
PKG = OUT_ROOT / PKG_NAME
CLEAN = "af3dec421cbae1cb232d3d4bb213348a34b879fc"
CONTAM = "3ddf3f24d7b0084686cb46193c7c165f3a60af91"

DIRECT = [
    "supabase/functions/_shared/conversation-intelligence.ts",
    "supabase/functions/generate-reply/index.ts",
    "supabase/functions/_shared/escalation-rules.ts",
    "supabase/functions/_shared/escalation-shadow.ts",
    "supabase/functions/widget-live-ai-test/index.ts",
    "src/routes/_authenticated/console.widget-preview.tsx",
    "tests/edge/w3-task3-3-conversation-intelligence.ts",
    "tests/edge/w3-task3-3-conversational-runtime-contract.py",
    "scripts/w3-task3-3-conversational-final-gate.sh",
]
RESTORE = [
    "scripts/w3-task3-3-final-gate.sh",
    "supabase/functions/_shared/conversational-routing.ts",
    "supabase/functions/_shared/escalation-signals.ts",
    "supabase/functions/receive-widget-message/index.ts",
]
DELETE_IF_CONTAMINATED = [
    "supabase/functions/_shared/answerability.ts",
    "supabase/functions/_shared/conversation-continuity.ts",
    "supabase/functions/_shared/customer-response-policy.ts",
    "supabase/functions/_shared/handoff-intent.ts",
    "supabase/functions/_shared/human-control.ts",
    "supabase/functions/_shared/task3-3-round1-closure_test.ts",
    "tests/edge/task3-3-round1-conversational-closure-contract.py",
]
ALL_TOUCH = sorted(set(DIRECT + RESTORE + DELETE_IF_CONTAMINATED))


def run(*args: str) -> bytes:
    return subprocess.check_output(args, cwd=ROOT)


def git_bytes(ref: str, path: str) -> bytes | None:
    p = subprocess.run(["git", "show", f"{ref}:{path}"], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return p.stdout if p.returncode == 0 else None


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_bytes(path: Path, data: bytes, mode: int = 0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.chmod(mode)

if OUT_ROOT.exists():
    shutil.rmtree(OUT_ROOT)
PKG.mkdir(parents=True)

# Direct authoritative files from current branch.
for rel in DIRECT:
    src = ROOT / rel
    if not src.is_file() or src.stat().st_size == 0:
        raise SystemExit(f"missing/empty direct file: {rel}")
    write_bytes(PKG / "payload/direct" / rel, src.read_bytes(), 0o755 if rel.endswith(".sh") else 0o644)

# Clean restoration files neutralize the accidental Lovable main edit.
for rel in RESTORE:
    data = git_bytes(CLEAN, rel)
    if data is None or len(data) == 0:
        raise SystemExit(f"clean restore source missing: {rel}")
    write_bytes(PKG / "payload/restore-clean" / rel, data, 0o755 if rel.endswith(".sh") else 0o644)

baseline_hashes: dict[str, dict[str, str | None]] = {"clean": {}, "contaminated": {}}
for rel in ALL_TOUCH:
    c = git_bytes(CLEAN, rel)
    m = git_bytes(CONTAM, rel)
    baseline_hashes["clean"][rel] = sha(c) if c is not None else None
    baseline_hashes["contaminated"][rel] = sha(m) if m is not None else None

final_hashes: dict[str, str | None] = {}
for rel in ALL_TOUCH:
    if rel in DIRECT:
        final_hashes[rel] = sha((PKG / "payload/direct" / rel).read_bytes())
    elif rel in RESTORE:
        final_hashes[rel] = sha((PKG / "payload/restore-clean" / rel).read_bytes())
    else:
        final_hashes[rel] = None

manifest = {
    "package": PKG_NAME,
    "scope": "Task 3.3 conversational runtime closure",
    "authoritative_source": {
        "repository": "ebixsolutions/console-chat-hub",
        "source_branch": "task3-3-conversational-runtime-closure",
        "clean_baseline": CLEAN,
        "allowed_contaminated_baseline": CONTAM,
        "package_marker": "@lovable.dev/vite-tanstack-config=2.13.1",
    },
    "changed_files": [
        {"path": rel, "sha256": final_hashes[rel], "purpose": "Task 3.3 direct full-file replacement"}
        for rel in DIRECT
    ],
    "restore_clean_files": [
        {"path": rel, "sha256": final_hashes[rel], "purpose": "Remove accidental Lovable Chat divergence when applying from contaminated baseline"}
        for rel in RESTORE
    ],
    "delete_if_contaminated": DELETE_IF_CONTAMINATED,
    "baseline_hashes": baseline_hashes,
    "final_hashes": final_hashes,
    "validation": [
        "node --experimental-strip-types tests/edge/w3-task3-3-conversation-intelligence.ts",
        "python3 tests/edge/w3-task3-3-conversational-runtime-contract.py",
        "package marker == 2.13.1",
        "npm run build",
    ],
    "rollback": "apply.command automatically restores the exact pre-apply backup on any failure; rollback.command restores the newest successful-apply backup manually.",
}
(PKG / "MANIFEST.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")

summary = "Task 3.3: close conversational runtime — natural multi-turn context, conservative human handoff, answerability grounding, CE/VIP/emotion advisory handling, and human-control UX."
(PKG / "GITHUB_SUMMARY.txt").write_text(summary + "\n")

readme = f"""# Task 3.3 Conversational Runtime Closure

## Execute
1. Keep the package folder intact.
2. Double-click `apply.command` on macOS.
3. The command only accepts repo `~/Documents/GitHub/console-chat-hub`, branch `main`, package marker `2.13.1`, and exact baseline `{CLEAN}` or `{CONTAM}`.
4. Any preflight mismatch stops before writes. Any post-write validation failure automatically restores the exact backup.

## Validation
`apply.command` verifies baseline hashes, payload/manifest SHA256, expected=actual, missing=0, empty=0, deleted accidental files absent, then runs `npm ci` and `scripts/w3-task3-3-conversational-final-gate.sh` (runtime matrix + source contract + package marker + production build).

## Rollback
A successful apply leaves an exact backup under `.task3-3-backup-*` in the repo root. Double-click `rollback.command` to restore the newest backup. No production data/schema/deploy operation is performed by this package.
"""
(PKG / "README.md").write_text(readme)

apply_cmd = r'''#!/bin/bash
set -euo pipefail
PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$HOME/Documents/GitHub/console-chat-hub"
CLEAN="af3dec421cbae1cb232d3d4bb213348a34b879fc"
CONTAM="3ddf3f24d7b0084686cb46193c7c165f3a60af91"
BACKUP=""
APPLIED=0

fail(){ echo "STOP: $*" >&2; exit 1; }
sha256(){ shasum -a 256 "$1" | awk '{print $1}'; }

[[ -d "$REPO/.git" ]] || fail "repo not found: $REPO"
cd "$REPO"
[[ "$(git branch --show-current)" == "main" ]] || fail "branch must be main"
[[ -z "$(git status --porcelain)" ]] || fail "working tree is not clean"
HEAD_SHA="$(git rev-parse HEAD)"
if [[ "$HEAD_SHA" == "$CLEAN" ]]; then MODE=clean
elif [[ "$HEAD_SHA" == "$CONTAM" ]]; then MODE=contaminated
else fail "unexpected baseline commit: $HEAD_SHA"; fi
node -e "const p=require('./package.json');if(p.devDependencies['@lovable.dev/vite-tanstack-config']!=='2.13.1')process.exit(1)" || fail "package marker is not 2.13.1"

python3 - "$PKG_DIR" "$REPO" "$MODE" <<'PY'
import hashlib,json,sys
from pathlib import Path
pkg,repo,mode=map(Path,sys.argv[1:3])+[None] if False else (Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3])
m=json.loads((pkg/'MANIFEST.json').read_text())
def h(p): return hashlib.sha256(p.read_bytes()).hexdigest()
for group in ('changed_files','restore_clean_files'):
  for item in m[group]:
    root='payload/direct' if group=='changed_files' else 'payload/restore-clean'
    p=pkg/root/item['path']
    assert p.is_file() and p.stat().st_size>0, f"missing/empty payload {item['path']}"
    assert h(p)==item['sha256'], f"manifest payload hash mismatch {item['path']}"
expected=m['baseline_hashes'][mode]
for rel,want in expected.items():
  p=repo/rel
  if want is None:
    assert not p.exists(), f"unexpected pre-existing file {rel}"
  else:
    assert p.is_file(), f"missing baseline file {rel}"
    assert h(p)==want, f"baseline hash mismatch {rel}"
print('PASS preflight: payload hashes + exact baseline hashes')
PY

BACKUP="$REPO/.task3-3-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP/files"
python3 - "$PKG_DIR/MANIFEST.json" "$REPO" "$BACKUP" <<'PY'
import json,shutil,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text()); repo=Path(sys.argv[2]); b=Path(sys.argv[3])
absent=[]
for rel in m['final_hashes']:
 p=repo/rel
 if p.is_file():
  q=b/'files'/rel; q.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(p,q)
 else: absent.append(rel)
(b/'absent-before.txt').write_text('\n'.join(absent)+'\n')
(b/'BASELINE_HEAD.txt').write_text(sys.argv[2]+'\n')
PY

do_rollback(){
  [[ -n "$BACKUP" && -d "$BACKUP" ]] || return 0
  echo "ROLLBACK: restoring $BACKUP"
  python3 - "$PKG_DIR/MANIFEST.json" "$REPO" "$BACKUP" <<'PY'
import json,shutil,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text()); repo=Path(sys.argv[2]); b=Path(sys.argv[3])
absent=set((b/'absent-before.txt').read_text().splitlines())
for rel in m['final_hashes']:
 p=repo/rel; src=b/'files'/rel
 if rel in absent:
  if p.exists(): p.unlink()
 elif src.is_file():
  p.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(src,p)
PY
  git restore -- src/routeTree.gen.ts 2>/dev/null || true
}
trap 'rc=$?; if [[ $APPLIED -eq 1 ]]; then do_rollback; fi; exit $rc' ERR INT TERM

python3 - "$PKG_DIR" "$REPO" "$MODE" <<'PY'
import json,shutil,sys
from pathlib import Path
pkg=Path(sys.argv[1]); repo=Path(sys.argv[2]); mode=sys.argv[3]; m=json.loads((pkg/'MANIFEST.json').read_text())
for item in m['changed_files']:
 rel=item['path']; src=pkg/'payload/direct'/rel; dst=repo/rel
 dst.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(src,dst)
if mode=='contaminated':
 for item in m['restore_clean_files']:
  rel=item['path']; src=pkg/'payload/restore-clean'/rel; dst=repo/rel
  dst.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(src,dst)
 for rel in m['delete_if_contaminated']:
  p=repo/rel
  if p.exists(): p.unlink()
PY
APPLIED=1

python3 - "$PKG_DIR/MANIFEST.json" "$REPO" <<'PY'
import hashlib,json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text()); repo=Path(sys.argv[2])
def h(p): return hashlib.sha256(p.read_bytes()).hexdigest()
missing=[];empty=[];mismatch=[]
for rel,want in m['final_hashes'].items():
 p=repo/rel
 if want is None:
  if p.exists(): mismatch.append(rel+':expected_absent')
 else:
  if not p.is_file(): missing.append(rel)
  elif p.stat().st_size==0: empty.append(rel)
  elif h(p)!=want: mismatch.append(rel)
print(f"expected={len(m['final_hashes'])} actual={len(m['final_hashes'])-len(missing)} missing={len(missing)} empty={len(empty)} hash_mismatch={len(mismatch)}")
assert not missing and not empty and not mismatch, (missing,empty,mismatch)
PY

npm ci
bash scripts/w3-task3-3-conversational-final-gate.sh
git restore -- src/routeTree.gen.ts 2>/dev/null || true

python3 - "$PKG_DIR/MANIFEST.json" "$REPO" <<'PY'
import hashlib,json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text()); repo=Path(sys.argv[2])
def h(p): return hashlib.sha256(p.read_bytes()).hexdigest()
for rel,want in m['final_hashes'].items():
 p=repo/rel
 if want is None: assert not p.exists(), rel
 else: assert p.is_file() and p.stat().st_size>0 and h(p)==want, rel
print('PASS post-validation exact replacement hashes')
PY

trap - ERR INT TERM
APPLIED=0
echo "COMPLETED FUNCTIONAL IMPLEMENTATION"
echo "Backup retained: $BACKUP"
'''
write_bytes(PKG / "apply.command", apply_cmd.encode(), 0o755)

rollback_cmd = r'''#!/bin/bash
set -euo pipefail
REPO="$HOME/Documents/GitHub/console-chat-hub"
[[ -d "$REPO/.git" ]] || { echo "STOP: repo not found" >&2; exit 1; }
cd "$REPO"
BACKUP="$(ls -dt .task3-3-backup-* 2>/dev/null | head -1 || true)"
[[ -n "$BACKUP" && -d "$BACKUP/files" ]] || { echo "STOP: no Task 3.3 backup found" >&2; exit 1; }
ABSENT="$BACKUP/absent-before.txt"
python3 - "$REPO" "$BACKUP" "$ABSENT" <<'PY'
import shutil,sys
from pathlib import Path
repo=Path(sys.argv[1]); b=Path(sys.argv[2]); absent=Path(sys.argv[3])
for src in (b/'files').rglob('*'):
 if src.is_file():
  rel=src.relative_to(b/'files'); dst=repo/rel; dst.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(src,dst)
for rel in absent.read_text().splitlines():
 p=repo/rel
 if p.exists(): p.unlink()
print(f"ROLLBACK restored from {b}")
PY
git restore -- src/routeTree.gen.ts 2>/dev/null || true
'''
write_bytes(PKG / "rollback.command", rollback_cmd.encode(), 0o755)

# Package-internal integrity: expected physical package files are exactly known.
all_files = sorted(str(p.relative_to(PKG)) for p in PKG.rglob("*") if p.is_file())
expected = sorted([
    "MANIFEST.json", "GITHUB_SUMMARY.txt", "README.md", "apply.command", "rollback.command",
    *[f"payload/direct/{x}" for x in DIRECT],
    *[f"payload/restore-clean/{x}" for x in RESTORE],
])
if all_files != expected:
    raise SystemExit(f"package expected!=actual\nexpected={expected}\nactual={all_files}")
if any((PKG / x).stat().st_size == 0 for x in expected):
    raise SystemExit("empty package file")
print(f"PASS package expected={len(expected)} actual={len(all_files)} missing=0 empty=0")
print(PKG)
