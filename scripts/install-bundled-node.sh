#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION='24.19.0'
NODE_PLATFORM='linux-x64'
EXPECTED_SHA256='14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ARCHIVE="$PROJECT_ROOT/vendor/node/node-v${NODE_VERSION}-${NODE_PLATFORM}.tar.xz"
INSTALL_BASE="${OPERATOR_BUNDLED_NODE_HOME:-$PROJECT_ROOT/.local-c500-node}"
INSTALL_DIR="$INSTALL_BASE/node-v${NODE_VERSION}-${NODE_PLATFORM}"

fail() {
  printf 'Bundled Node install failed: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == 'Linux' ]] || fail 'this package supports Linux only'
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "unsupported architecture $(uname -m); expected x86_64" ;;
esac
[[ -f "$ARCHIVE" ]] || fail "archive is missing: $ARCHIVE"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
else
  fail 'sha256sum or shasum is required'
fi
[[ "$actual_sha256" == "$EXPECTED_SHA256" ]] || fail "archive checksum mismatch: $actual_sha256"

if [[ -x "$INSTALL_DIR/bin/node" ]]; then
  installed_version="$($INSTALL_DIR/bin/node --version)"
  [[ "$installed_version" == "v$NODE_VERSION" ]] || fail "existing install has unexpected version: $installed_version"
else
  [[ ! -e "$INSTALL_DIR" ]] || fail "existing incomplete install must be removed manually: $INSTALL_DIR"
  mkdir -p "$INSTALL_BASE"
  temporary_dir="$(mktemp -d "$INSTALL_BASE/.node-install.XXXXXX")"
  cleanup() {
    if [[ -n "${temporary_dir:-}" && -d "$temporary_dir" ]]; then
      rm -rf -- "$temporary_dir"
    fi
  }
  trap cleanup EXIT
  tar -xJf "$ARCHIVE" -C "$temporary_dir" --strip-components=1
  [[ -x "$temporary_dir/bin/node" ]] || fail 'archive did not contain bin/node'
  extracted_version="$($temporary_dir/bin/node --version)"
  [[ "$extracted_version" == "v$NODE_VERSION" ]] || fail "archive contains unexpected version: $extracted_version"
  mv -- "$temporary_dir" "$INSTALL_DIR"
  temporary_dir=''
  trap - EXIT
fi

printf 'Bundled Node installed: %s\n' "$INSTALL_DIR"
printf 'node: %s\n' "$($INSTALL_DIR/bin/node --version)"
npm_version="$($INSTALL_DIR/bin/node "$INSTALL_DIR/lib/node_modules/npm/bin/npm-cli.js" --version)"
printf 'npm:  %s\n' "$npm_version"
printf '\nUse it without changing the system Node:\n'
printf '  bash scripts/with-bundled-node.sh npm ci\n'
printf '  bash scripts/with-bundled-node.sh npm run tester:c500\n'
