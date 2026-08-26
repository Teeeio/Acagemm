#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION='24.19.0'
NODE_PLATFORM='linux-x64'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
INSTALL_BASE="${OPERATOR_BUNDLED_NODE_HOME:-$PROJECT_ROOT/.local-c500-node}"
INSTALL_DIR="$INSTALL_BASE/node-v${NODE_VERSION}-${NODE_PLATFORM}"

if [[ ! -x "$INSTALL_DIR/bin/node" ]]; then
  bash "$SCRIPT_DIR/install-bundled-node.sh"
fi

export PATH="$INSTALL_DIR/bin:$PATH"
hash -r
cd -- "$PROJECT_ROOT"

if [[ $# -eq 0 ]]; then
  printf 'node: %s\n' "$(node --version)"
  printf 'npm:  %s\n' "$(npm --version)"
  exit 0
fi

exec "$@"
