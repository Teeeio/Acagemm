import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildFixedOperatorBaselineRunPy, getFixedOperatorProfile } from '../client-runtime/fixed-operator-profiles.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'fixed-operator-profile-'));
try {
  const source = buildFixedOperatorBaselineRunPy(getFixedOperatorProfile('mla-paged-decode-attention-maca'));
  assert.match(source, /causal": False/);
  assert.doesNotMatch(source, /causal": false/);
  const file = path.join(root, 'run.py');
  await writeFile(file, source, 'utf8');
  const result = spawnSync(process.env.PYTHON || 'python', ['-m', 'py_compile', file], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('[fixed-operator-profile] generated Python metadata is syntax-valid');
