import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(serverDir, '..');
export const legacyDataDir = path.join(projectRoot, 'data');
export const legacyRuntimeDir = path.join(projectRoot, 'runtime');

const platformDataRoot = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OperatorStudio')
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'operator-studio');

export const usesManagedStorage = !process.env.OPERATOR_DATA_DIR && !process.env.OPERATOR_RUNTIME_DIR;
export const dataDir = process.env.OPERATOR_DATA_DIR
  ? path.resolve(process.env.OPERATOR_DATA_DIR)
  : path.join(platformDataRoot, 'data');
export const runtimeDir = process.env.OPERATOR_RUNTIME_DIR
  ? path.resolve(process.env.OPERATOR_RUNTIME_DIR)
  : path.join(platformDataRoot, 'runtime');

