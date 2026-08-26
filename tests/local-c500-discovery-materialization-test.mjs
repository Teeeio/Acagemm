import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverOperatorMaterial } from '../tools/local-c500-tester/source-discovery.mjs';
import { materializeOperatorMaterial } from '../tools/local-c500-tester/materializer.mjs';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'local-c500-discovery-'));
const localSource = path.join(tempDir, 'local-source');
const onlineSource = path.join(tempDir, 'online-source');
const outputDir = path.join(tempDir, 'mission');

try {
  await mkdir(localSource, { recursive: true });
  await writeFile(path.join(localSource, 'run.py'), 'def get_inputs(): return {}\ndef run(inputs): return []\ndef reference(inputs): return []\n', 'utf8');

  const local = await discoverOperatorMaterial({
    goal: 'optimize vector_add on local C500',
    repository: 'local-demo',
    registry: { operators: [{ id: 'vector_add', aliases: ['vector add'], source_path: localSource, entry: 'run.py', semantic_evidence: ['run.py'] }] },
  });
  assert.equal(local.status, 'resolved');
  assert.equal(local.source_kind, 'local_registry');
  assert.equal(local.operator_id, 'vector_add');
  assert.equal(local.validation.entry_valid, true);

  const invalid = await discoverOperatorMaterial({
    goal: 'optimize flashinfer paged_attention on local C500',
    repository: 'flashinfer',
    registry: { operators: [{ id: 'flashinfer_paged_attention', aliases: ['flashinfer', 'paged_attention'], source_path: path.join(tempDir, 'missing'), entry: 'run.py' }] },
    research: async () => ({
      operator_id: 'flashinfer_paged_attention',
      source_kind: 'online_authoritative',
      source_path: onlineSource,
      entry: 'run.py',
      semantic_evidence: ['authoritative test', 'API docs'],
      generated_entry: 'def get_inputs(): return {}\ndef run(inputs): return []\ndef reference(inputs): return []\n',
    }),
  });
  assert.equal(invalid.status, 'resolved');
  assert.equal(invalid.source_kind, 'online_authoritative');
  assert.equal(invalid.research_used, true);

  const materialized = await materializeOperatorMaterial({
    material: invalid,
    workspaceRoot: outputDir,
    operatorDir: path.join(outputDir, 'operator'),
  });
  assert.equal(materialized.status, 'validated');
  assert.equal(materialized.entry, path.join(outputDir, 'operator', 'run.py'));
  assert.equal(materialized.shapePlan.cases.length > 0, true);
  assert.equal(materialized.provenance.source_kind, 'online_authoritative');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

process.stdout.write('[local-c500-discovery] local-first research and materialization passed\n');
