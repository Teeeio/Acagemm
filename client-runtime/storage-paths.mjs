import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(serverDir, '..');
export const legacyDataDir = path.join(projectRoot, 'data');
export const legacyRuntimeDir = path.join(projectRoot, 'runtime');

export const projectStorageRoot = process.env.OPERATOR_STORAGE_ROOT
  ? path.resolve(process.env.OPERATOR_STORAGE_ROOT)
  : path.join(projectRoot, '.operator-studio-local');

export const usesManagedStorage = !process.env.OPERATOR_DATA_DIR && !process.env.OPERATOR_RUNTIME_DIR;
export const dataDir = process.env.OPERATOR_DATA_DIR
  ? path.resolve(process.env.OPERATOR_DATA_DIR)
  : path.join(projectStorageRoot, 'data');
export const runtimeDir = process.env.OPERATOR_RUNTIME_DIR
  ? path.resolve(process.env.OPERATOR_RUNTIME_DIR)
  : path.join(projectStorageRoot, 'runtime');
