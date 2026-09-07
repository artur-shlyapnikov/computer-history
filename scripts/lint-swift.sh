#!/bin/sh
# Swift hardening gate: strict-concurrency build with warnings-as-errors,
# unit tests, and format linting. Exits non-zero on any violation.
set -eu
cd "$(dirname "$0")/../apps/recorder-macos"

echo "== swift build (-warnings-as-errors)"
if ! swift build -c debug -Xswiftc -warnings-as-errors > /dev/null; then
  echo "ERROR: swift build failed; last 50 lines:" >&2
  swift build -c debug -Xswiftc -warnings-as-errors 2>&1 | tail -n 50 >&2 || true
  exit 1
fi

echo "== swiftformat --lint"
swiftformat --lint . --cache ignore

echo "== swiftlint"
swiftlint lint --strict --quiet --disable-sourcekit

echo "== swift test"
test_log="$(mktemp "${TMPDIR:-/tmp}/lint-swift-test.XXXXXX")"
trap 'rm -f "$test_log"' EXIT

# swift-testing intermittently segfaults at teardown AFTER all tests pass
# (Apple async-runner bug, signal 11). Retry exactly once, and only when the
# crash signature is present AND no real test failures are reported.
run_swift_test() {
  set +e
  swift test > "$test_log" 2>&1
  run_swift_test_status=$?
  set -e
}

run_swift_test
if [ "$run_swift_test_status" -ne 0 ] \
  && grep -Eq 'unexpected signal code|signal: 11' "$test_log" \
  && ! grep -Eq '✘|[1-9][0-9]* +(tests? +)?failed|Test run with .* failed' "$test_log"
then
  echo "== swift-testing teardown segfault (environmental), retrying once"
  run_swift_test
fi
cat "$test_log"
exit "$run_swift_test_status"
