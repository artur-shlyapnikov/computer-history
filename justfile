# Computer History task runner. Single source of truth stays in package.json
# scripts; recipes below are thin `pnpm` / script wrappers plus the few gaps
# package.json doesn't cover (fmt, clean, ci, setup, doctor).
set shell := ["bash", "-uceo", "pipefail"]
set dotenv-load

recorder_dir := "apps/recorder-macos"

# List available recipes.
default:
    @just --list

# ---- setup ----

# First-time setup: dependencies + fixture symlink.
[group('setup')]
setup: install fixtures-sync

# Install workspace dependencies. Extra args forwarded (e.g. `just install -- --frozen-lockfile`).
[group('setup')]
install *args:
    pnpm install {{ args }}

# Verify/repair the Swift<->TS fixture symlink.
[group('setup')]
fixtures-sync:
    pnpm fixtures:sync

# ---- check ----

# Full gate: build + typecheck + eslint + swift gate + tests (mirrors CI).
[group('check')]
verify:
    pnpm verify

# Conventional alias used by CONTRIBUTING.md.
[group('check')]
check: verify

# Exact CI reproduction: frozen install + verify.
[group('check')]
ci:
    pnpm install --frozen-lockfile
    pnpm verify

# Typecheck all TS packages (implies build).
[group('check')]
typecheck:
    pnpm typecheck

# Type-aware eslint over TS + repo root.
[group('check')]
lint:
    pnpm lint

# Strict Swift gate: warnings-as-errors build + swiftformat + swiftlint + tests.
[group('check')]
lint-swift:
    pnpm lint:swift

# Run all package tests. Extra args forwarded (e.g. `just test -- --watch`).
[group('check')]
test *args:
    pnpm test {{ args }}

# Check formatting without writing (swiftformat lint).
[group('check')]
fmt-check:
    swiftformat --lint {{ recorder_dir }} --cache ignore

# ---- run ----

# Compile TS packages.
[group('run')]
build:
    pnpm build

# Rebuild, then run the daemon from compiled dist. Extra args forwarded.
[group('run')]
daemon *args: build
    pnpm daemon {{ args }}

# Build the menu-bar recorder. Extra args forwarded (e.g. `just app -- -c release`).
[group('run')]
app *args:
    cd {{ recorder_dir }} && swift build {{ args }}

# ---- maint ----

# Format Swift in place (swiftformat).
[group('maint')]
fmt:
    swiftformat {{ recorder_dir }}

# Remove build outputs only (dist, tsbuildinfo, Swift .build). Never touches node_modules or data.
[group('maint')]
clean:
    rm -rf packages/protocol/dist apps/daemon/dist {{ recorder_dir }}/.build
    find packages apps -name '*.tsbuildinfo' -delete

# Print toolchain versions (mirrors the CI "Tool versions" step).
[group('maint')]
doctor:
    just --version
    node --version
    pnpm --version
    swift --version
    xcodebuild -version
    swiftformat --version
    swiftlint version
