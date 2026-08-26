import { stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const isDirectory = async (target) => stat(target).then((value) => value.isDirectory()).catch(() => false);

export async function prepareAgentBoundary({ workspace, role, roots }) {
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedRoots = Object.fromEntries(Object.entries(roots || {}).filter(([, target]) => target).map(([name, target]) => [name, path.resolve(target)]));
  if (resolvedRoots.workspace !== resolvedWorkspace) throw new Error('Agent boundary requires roots.workspace to equal cwd.');
  if (!await isDirectory(path.join(resolvedWorkspace, '.git'))) {
    await execFileAsync('git', ['init'], { cwd: resolvedWorkspace, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'Operator Studio Stage Boundary'], { cwd: resolvedWorkspace, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'stage-boundary@local.invalid'], { cwd: resolvedWorkspace, windowsHide: true });
  }
  return {
    role,
    roots: resolvedRoots,
    environment: {
      OPERATOR_AGENT_ROLE: role,
      OPERATOR_AGENT_ROOTS: JSON.stringify(resolvedRoots),
    },
    toolInstruction: [
      'No local shell, command execution, filesystem read, or add-directory tool is exposed in this stage.',
      `The only filesystem root assigned to this Agent is its current workspace (${resolvedWorkspace}).`,
      'Use only evidence embedded in the prompt. If this stage requires a file change, use apply_patch only for a relative path inside the current workspace.',
    ].join('\n'),
  };
}
