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
      'Do not use a local shell, command execution, or add-directory tool in this stage.',
      `The only filesystem root assigned to this Agent is its current workspace (${resolvedWorkspace}).`,
      'Any available filesystem tool may access only relative paths inside the current workspace. Never assume that a requested file already exists.',
      'Use evidence embedded in the prompt. Create missing files with the available file creation or patch tool; use patch/edit operations only for files that already exist or that you created during this turn.',
    ].join('\n'),
  };
}
