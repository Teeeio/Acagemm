export const knowledgeDraftWritableFields = Object.freeze(new Set([
  'title', 'conclusion', 'scope', 'hardware', 'operator', 'dtype', 'layout', 'shape', 'runtime',
  'trigger', 'procedure', 'expectedGain', 'validation', 'constraints', 'contraindications',
  'failedAttempts', 'evidenceLevel', 'confidence', 'evidenceRefs', 'sourceMission',
  'sourceCandidate', 'sourceCommit', 'owner',
]));

export const createKnowledgeService = ({ loadState, persistState, guardMutation = () => {}, appendRuntimeEvent, addAuditEvent, now = () => new Date() } = {}) => {
  if (typeof loadState !== 'function' || typeof persistState !== 'function' || typeof appendRuntimeEvent !== 'function' || typeof addAuditEvent !== 'function') {
    throw new TypeError('Knowledge service requires state, guard, event, and audit dependencies.');
  }

  const patchDraft = async (draftId, body = {}) => {
    const state = await loadState();
    guardMutation(state);
    const index = state.knowledgeDrafts.findIndex((draft) => draft.id === draftId);
    if (index === -1) return { statusCode: 404, payload: { error: '知识草稿不存在。' } };
    if (state.publishedAssets.some((asset) => asset.id === draftId) || state.knowledgeMaintenance?.changes?.some((change) => change.draftId === draftId && change.outcome === 'auto_published')) {
      const error = new Error('知识资产已生成固定版本，不能静默修改；请通过新的维护版本修订。'); error.status = 409; error.code = 'KNOWLEDGE_IMMUTABLE'; throw error;
    }
    const unsupportedFields = Object.keys(body).filter((field) => !knowledgeDraftWritableFields.has(field));
    if (unsupportedFields.length) {
      const error = new Error(`知识草稿包含不可修改字段：${unsupportedFields.join('、')}。`); error.status = 400; error.code = 'KNOWLEDGE_PATCH_REJECTED'; throw error;
    }
    state.knowledgeDrafts[index] = { ...state.knowledgeDrafts[index], ...body, id: draftId };
    return { statusCode: 200, state: await persistState(state) };
  };

  const retiredPublish = (batch = false) => ({
    statusCode: 410,
    payload: {
      error: batch
        ? '批量手工发布接口已退役；知识由效果决策触发并按治理策略自动维护。'
        : '手工知识发布接口已退役；知识由效果决策触发并按治理策略自动维护。',
      code: 'KNOWLEDGE_PUBLISH_RETIRED',
    },
  });

  const addReference = async (body = {}) => {
    const state = await loadState();
    guardMutation(state);
    if (!body.assetId || !body.title || !body.version) return { statusCode: 400, payload: { error: '引用知识资产需要 assetId、title 和 version。' } };
    const reference = { assetId: body.assetId, missionId: state.activeMissionId, version: body.version, referencedAt: now().toISOString(), reason: body.reason || '由工程师从组织知识库引用' };
    state.knowledgeReferences = [reference, ...(state.knowledgeReferences || []).filter((item) => !(item.assetId === reference.assetId && item.missionId === reference.missionId))];
    appendRuntimeEvent(state, 'knowledge.referenced', reference, { kind: 'knowledge', mode: 'client' });
    addAuditEvent(state, '知识资产已引用到当前任务', `${body.assetId}@${body.version} · ${body.title}`, 'green', 'BookOpen');
    return { statusCode: 200, state: await persistState(state), reference };
  };

  return Object.freeze({ patchDraft, retiredPublish, addReference });
};
