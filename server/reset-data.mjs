import { resetDemoData, workspaceDir } from './state-store.mjs';

await resetDemoData();
console.log(`[operator-studio] demo data reset; workspace: ${workspaceDir}`);
