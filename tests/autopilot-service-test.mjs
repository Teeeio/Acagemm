import assert from 'node:assert/strict';
import { createAutopilotService } from '../client-runtime/application/autopilot-service.mjs';
const service = createAutopilotService({ advance: async (state) => ({ state, action: 'none' }) });
assert.deepEqual(await service.advance({ id: 'state' }), { state: { id: 'state' }, action: 'none' });
console.log('[autopilot-service] application boundary contract passed');
