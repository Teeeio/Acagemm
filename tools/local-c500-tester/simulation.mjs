import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

process.env.OPERATOR_LOCAL_C500_SIMULATION = '1';
process.env.OPERATOR_LOCAL_C500_MOCK = '1';
process.env.OPERATOR_RUNTIME_MODE = 'reference-fixture';
process.env.OPERATOR_TUI_ANIMATE = '0';
process.env.OPERATOR_TEST_BACKEND = 'local-c500';
process.env.OPERATOR_AUTO_TICK = '1';
process.env.OPERATOR_AUTO_TICK_INTERVAL_MS = '2500';
process.env.OPERATOR_TUI_REFRESH_MS = '2500';
const persistentHome = process.env.LOCAL_C500_TESTER_HOME;
const temporaryHome = persistentHome || await mkdtemp(path.join(os.tmpdir(), 'operator-studio-simulation-'));
process.env.LOCAL_C500_TESTER_HOME = temporaryHome;
try {
  await import('./tui.mjs');
} finally {
  if (!persistentHome) await rm(temporaryHome, { recursive: true, force: true }).catch(() => {});
}
