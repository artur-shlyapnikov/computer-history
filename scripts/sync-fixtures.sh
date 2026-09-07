#!/bin/bash
# Verifies (and repairs) the Swift↔TS fixture-sharing symlink:
#   apps/recorder-macos/Fixtures -> ../../packages/protocol/fixtures
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SWIFT_FIXTURES="$REPO_ROOT/apps/recorder-macos/Fixtures"
TS_FIXTURES="$REPO_ROOT/packages/protocol/fixtures"
SYMLINK_TARGET="../../packages/protocol/fixtures"

fail() {
    echo "fixtures: ERROR: $1" >&2
    exit 1
}

hash_tree() {
    # Deterministic per-file SHA-256 manifest of every .json fixture.
    (
        cd "$1"
        find . -type f -name '*.json' -print0 | LC_ALL=C sort -z |
            while IFS= read -r -d '' file; do
                printf '%s  %s\n' "$file" "$(shasum -a 256 "$file" | cut -d' ' -f1)"
            done | shasum -a 256 | cut -d' ' -f1
    )
}

if [ ! -d "$TS_FIXTURES" ]; then
    fail "canonical fixture dir missing: $TS_FIXTURES"
fi

if [ -L "$SWIFT_FIXTURES" ]; then
    if [ "$(readlink "$SWIFT_FIXTURES")" != "$SYMLINK_TARGET" ]; then
        rm "$SWIFT_FIXTURES"
        ln -s "$SYMLINK_TARGET" "$SWIFT_FIXTURES"
        echo "fixtures: repaired symlink"
    fi
elif [ ! -e "$SWIFT_FIXTURES" ]; then
    ln -s "$SYMLINK_TARGET" "$SWIFT_FIXTURES"
    echo "fixtures: created missing symlink apps/recorder-macos/Fixtures"
else
    fail "$SWIFT_FIXTURES exists and is not a symlink; refusing to overwrite"
fi

[ -d "$SWIFT_FIXTURES/" ] || fail "symlink does not resolve to a directory"

HASH="$(hash_tree "$TS_FIXTURES")"
echo "fixtures: in sync ($HASH)"
