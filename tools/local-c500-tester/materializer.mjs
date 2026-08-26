import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';

const defaultShapePlan = () => ({
  generated_by: 'local-c500-materializer',
  cases: [{ name: 'representative_default', batch: 1, seq_len: 128, head_dim: 128, dtype: 'float16', reason: 'no authoritative shape was available; representative shape selected' }],
});

export const materializeOperatorMaterial = async ({ material, workspaceRoot, operatorDir }) => {
  if (!material || material.status !== 'resolved') return { status: 'needs_human', reason: 'material_not_resolved' };
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(operatorDir, { recursive: true });
  if (material.source_path && existsSync(material.source_path)) await cp(material.source_path, operatorDir, { recursive: true, force: true });
  const entryPath = path.join(operatorDir, material.entry || 'run.py');
  if (!existsSync(entryPath) && material.generated_entry) await writeFile(entryPath, `${material.generated_entry.trim()}\n`, 'utf8');
  if (!existsSync(entryPath)) return { status: 'needs_human', reason: 'generated_entry_missing' };
  const entryText = await readFile(entryPath, 'utf8');
  if (!['get_inputs', 'run', 'reference'].every((name) => new RegExp(`(?:def|async def)\\s+${name}\\s*\\(`).test(entryText))) return { status: 'needs_human', reason: 'generated_entry_structural_validation_failed' };
  const shapePlan = material.shapePlan || defaultShapePlan();
  const provenance = {
    source_kind: material.source_kind,
    operator_id: material.operator_id,
    source_path: material.source_path || null,
    semantic_evidence: material.semantic_evidence || [],
    research_used: material.research_used === true,
    assumptions: material.assumptions || [],
  };
  await writeFile(path.join(operatorDir, 'shape-plan.json'), `${JSON.stringify(shapePlan, null, 2)}\n`, 'utf8');
  await writeFile(path.join(operatorDir, 'source-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
  await writeFile(path.join(operatorDir, 'metadata.json'), `${JSON.stringify({ operator_id: material.operator_id, entry: path.basename(entryPath), backend: material.backend || 'triton' }, null, 2)}\n`, 'utf8');
  return { status: 'validated', entry: entryPath, operatorDir, shapePlan, provenance };
};
