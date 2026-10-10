# Knowledge Service Contract

Owns Knowledge draft editing, organization-asset references, and the retired manual-publish policy.

| Method | Input | Output | Stable errors |
|---|---|---|---|
| `patchDraft(draftId, body)` | draft ID and whitelisted fields | persisted state | 404 missing draft, `KNOWLEDGE_IMMUTABLE`, `KNOWLEDGE_PATCH_REJECTED` |
| `addReference(body)` | `assetId`, `title`, `version`, optional `reason` | persisted state and reference DTO | 400 incomplete reference |
| `retiredPublish(batch)` | whether this is batch publication | 410 response | `KNOWLEDGE_PUBLISH_RETIRED` |

Published or automatically maintained knowledge is immutable. References are unique per asset and active Mission, with the newest reference replacing the prior one. Manual publication remains retired because adoption-driven governance is the only production publication path.

The service does not perform adoption, generate knowledge drafts, render TUI output, or bypass evidence policy. Persistence, clocks, runtime events, and audit events are injected.

```bash
npm run test:knowledge-service
npm run test:release
npm run test:module-boundary
```
