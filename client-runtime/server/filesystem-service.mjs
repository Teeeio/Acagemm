import { mkdir, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const directoryExists = async (target) => {
  try { return (await stat(target)).isDirectory(); } catch { return false; }
};

const invalidDirectoryName = (name) => !name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name);

export const createFilesystemService = ({ picker, homeDirectory = () => os.homedir() } = {}) => {
  const list = async (requestedPath) => {
    const target = path.resolve(requestedPath || homeDirectory());
    if (!await directoryExists(target)) {
      const error = new Error('目录不存在或当前用户无权访问。');
      error.status = 404;
      error.code = 'DIRECTORY_UNAVAILABLE';
      throw error;
    }
    const entries = await readdir(target, { withFileTypes: true });
    return {
      path: target,
      parent: path.dirname(target) === target ? null : path.dirname(target),
      entries: entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, path: path.join(target, entry.name) }))
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
    };
  };

  return {
    list,
    async select(initialPath) {
      if (!picker?.select) throw new TypeError('Filesystem service requires a directory picker.');
      return picker.select(String(initialPath || ''));
    },
    async create({ parent, name } = {}) {
      const parentPath = path.resolve(String(parent || homeDirectory()));
      const directoryName = String(name || '').trim();
      if (invalidDirectoryName(directoryName)) {
        const error = new Error('文件夹名称不能为空，且不能包含路径分隔符或系统保留字符。');
        error.status = 400;
        error.code = 'DIRECTORY_NAME_INVALID';
        throw error;
      }
      if (!await directoryExists(parentPath)) {
        const error = new Error('父目录不存在或当前用户无权访问。');
        error.status = 404;
        error.code = 'DIRECTORY_PARENT_UNAVAILABLE';
        throw error;
      }
      const target = path.join(parentPath, directoryName);
      await mkdir(target);
      return list(target);
    },
  };
};
