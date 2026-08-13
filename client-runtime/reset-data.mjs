import { resetDemoData } from './state-store.mjs';

const state = await resetDemoData();
console.log(`[operator-studio] demo data reset; workspace: ${state.workflowRecovery.worktree.path}`);
