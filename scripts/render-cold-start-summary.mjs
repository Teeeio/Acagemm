import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderWorkflowSummary } from '../tools/local-c500-tester/workflow-summary.mjs';

const runRoot = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/render-cold-start-summary.mjs <run-root>');

const state = JSON.parse(await readFile(path.join(runRoot, 'data', 'mock-db.json'), 'utf8'));
const taskRoot = path.join(runRoot, 'local-c500-tasks');
const taskDirectories = (await readdir(taskRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
const tasks = await Promise.all(taskDirectories.map((entry) => readFile(path.join(taskRoot, entry.name, 'task.json'), 'utf8').then(JSON.parse)));
tasks.sort((left, right) => String(left.submittedAt || left.createdAt || '').localeCompare(String(right.submittedAt || right.createdAt || '')));
const reportPath = path.join(runRoot, 'workflow-summary.md');
await writeFile(reportPath, renderWorkflowSummary({ state, tasks, initialization: { codeFiles: 0, sourceEntries: 0 } }), 'utf8');
console.log(reportPath);
