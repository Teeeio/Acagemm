import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const textFor = ({ goal = '', repository = '' }) => `${goal} ${repository}`.toLowerCase();

const operatorMatches = (operator, text) => [operator.id, operator.name, ...(operator.aliases || [])]
  .filter(Boolean)
  .some((term) => text.includes(String(term).toLowerCase()));

const validateMaterial = async (material) => {
  const sourcePath = material.source_path ? path.resolve(material.source_path) : null;
  const entryPath = sourcePath && material.entry ? path.join(sourcePath, material.entry) : null;
  const entryExists = Boolean(entryPath && existsSync(entryPath));
  let entryText = '';
  if (entryExists) entryText = await readFile(entryPath, 'utf8');
  const entryValid = entryExists && ['get_inputs', 'run', 'reference'].every((name) => new RegExp(`(?:def|async def)\\s+${name}\\s*\\(`).test(entryText));
  const semanticEvidence = Array.isArray(material.semantic_evidence) ? material.semantic_evidence.filter(Boolean) : [];
  const semanticsValid = semanticEvidence.length > 0 || Boolean(material.generated_entry);
  return {
    source_path: sourcePath,
    entry_path: entryPath,
    entry_exists: entryExists,
    entry_valid: entryValid,
    semantics_valid: semanticsValid,
    semantic_evidence: semanticEvidence,
  };
};

const unresolved = ({ repository, reason, operatorId = null, local = null }) => ({
  status: 'needs_human',
  reason,
  source_kind: null,
  repository,
  operator_id: operatorId,
  validation: local,
  research_used: false,
  message: '无法从本地或在线材料验证 operator 语义，已停止。',
});

export const discoverOperatorMaterial = async ({ goal, repository, operatorId = null, registry = { operators: [] }, research = null } = {}) => {
  const text = textFor({ goal, repository });
  const operator = (registry.operators || []).find((item) => item.id === operatorId) || (registry.operators || []).find((item) => operatorMatches(item, text));
  if (operator) {
    const local = { ...operator, source_kind: 'local_registry' };
    const validation = await validateMaterial(local);
    if (validation.entry_valid && validation.semantics_valid) {
      return { ...local, operator_id: local.operator_id || local.id, status: 'resolved', research_used: false, validation };
    }
    if (!research) return unresolved({ repository, reason: 'local_material_invalid', operatorId: operator.id, local: validation });
    const researched = await research({ goal, repository, operator: operator.id, localValidation: validation });
    if (!researched) return unresolved({ repository, reason: 'research_material_missing', operatorId: operator.id, local: validation });
    const remote = { ...researched, operator_id: researched.operator_id || operator.id, source_kind: researched.source_kind || 'online_authoritative' };
    const remoteValidation = await validateMaterial(remote);
    if (!(remoteValidation.entry_valid || remote.generated_entry) || !remoteValidation.semantics_valid) {
      return unresolved({ repository, reason: 'online_material_invalid', operatorId: remote.operator_id, local: remoteValidation });
    }
    return { ...remote, status: 'resolved', research_used: true, validation: remoteValidation };
  }
  if (!research) return unresolved({ repository, reason: 'operator_identity_unresolved' });
  const researched = await research({ goal, repository, operator: null, localValidation: null });
  if (!researched) return unresolved({ repository, reason: 'operator_identity_unresolved' });
  const remote = { ...researched, source_kind: researched.source_kind || 'online_authoritative' };
  const validation = await validateMaterial(remote);
  if (!(validation.entry_valid || remote.generated_entry) || !validation.semantics_valid) return unresolved({ repository, reason: 'online_material_invalid', operatorId: remote.operator_id, local: validation });
  return { ...remote, status: 'resolved', research_used: true, validation };
};
