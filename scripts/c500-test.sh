#!/usr/bin/env bash
set -euo pipefail

# Single entry point for a relocated C500 tester checkout. It owns the
# runtime/data paths below and replaces only a recognized Operator Studio
# process on the configured port.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TESTER_HOME="${LOCAL_C500_TESTER_HOME:-$PROJECT_ROOT/.local-c500-production}"
API_PORT="${LOCAL_C500_API_PORT:-4275}"
MODE="${1:-start}"

export LOCAL_C500_TESTER_HOME="$TESTER_HOME"
export LOCAL_C500_API_PORT="$API_PORT"
export OPERATOR_RUNTIME_MODE="${OPERATOR_RUNTIME_MODE:-claude-code}"
export CLAUDE_COMMAND="${CLAUDE_COMMAND:-claude}"
export OPERATOR_TEST_BACKEND="local-c500"
export OPERATOR_AUTO_TICK="1"

die() {
  printf '[c500-test] ERROR: %s\n' "$*" >&2
  exit 1
}

run_npm() {
  bash "$PROJECT_ROOT/scripts/with-bundled-node.sh" npm "$@"
}

ensure_dependencies() {
  bash "$PROJECT_ROOT/scripts/install-bundled-node.sh" >/dev/null
  if [[ ! -f "$PROJECT_ROOT/node_modules/ink/package.json" ]]; then
    printf '[c500-test] Installing locked dependencies...\n'
    run_npm ci
  fi
}

runtime_identity() {
  node --input-type=module -e '
    const port = Number(process.env.LOCAL_C500_API_PORT || 4275);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (!response.ok) process.exit(0);
      const body = await response.json();
      const bridge = body.__bridge || {};
      if (body.service === "operator-studio-client-runtime") {
        process.stdout.write(`${body.service}|${bridge.pid || ""}|${bridge.port || ""}\n`);
      } else {
        process.stdout.write(`other|${bridge.pid || ""}|${bridge.port || ""}\n`);
      }
    } catch { /* no service on this port */ }
  ' 2>/dev/null || true
}

stop_previous_runtime() {
  local identity service pid port attempt
  identity="$(runtime_identity)"
  [[ -z "$identity" ]] && return 0
  IFS='|' read -r service pid port <<<"$identity"
  if [[ "$service" != 'operator-studio-client-runtime' || "$port" != "$API_PORT" || ! "$pid" =~ ^[0-9]+$ || "$pid" -le 0 ]]; then
    die "port $API_PORT is occupied by an unrecognized process; inspect with: ss -ltnp | grep :$API_PORT"
  fi
  printf '[c500-test] Stopping previous Operator Studio runtime (pid %s)...\n' "$pid"
  kill "$pid" 2>/dev/null || true
  for attempt in $(seq 1 50); do
    [[ -z "$(runtime_identity)" ]] && return 0
    sleep 0.1
  done
  die "previous runtime pid $pid did not stop"
}

case "$MODE" in
  stop)
    ensure_dependencies
    stop_previous_runtime
    ;;
  verify)
    ensure_dependencies
    run_npm run verify:local-c500-release
    run_npm run test:local-c500-e2e
    ;;
  doctor)
    ensure_dependencies
    run_npm run tester:c500:doctor
    ;;
  mock)
    ensure_dependencies
    export OPERATOR_LOCAL_C500_MOCK=1
    export OPERATOR_LOCAL_C500_MOCK_SCENARIO="${OPERATOR_LOCAL_C500_MOCK_SCENARIO:-mla-three-round}"
    stop_previous_runtime
    run_npm run tester:c500
    ;;
  start)
    ensure_dependencies
    unset OPERATOR_LOCAL_C500_MOCK OPERATOR_LOCAL_C500_MOCK_SCENARIO
    stop_previous_runtime
    run_npm run tester:c500
    ;;
  *)
    die "usage: bash scripts/c500-test.sh {verify|doctor|start|mock|stop}"
    ;;
esac
