import { readFile, readdir } from 'node:fs/promises';
export const readLinuxProcessIdentity = async (pid, { read = readFile } = {}) => {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('Positive PID required.');
  const [boot, stat] = await Promise.all([read('/proc/sys/kernel/random/boot_id', 'utf8'), read('/proc/' + pid + '/stat', 'utf8')]);
  const end = stat.lastIndexOf(')');
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || fields.length < 20 || !/^\d+$/.test(fields[19])) throw new Error('Invalid Linux process identity.');
  const identity = { pid, bootId: boot.trim(), startTicks: fields[19], groupId: Number(fields[2]), sessionId: Number(fields[3]), state: fields[0] };
  if (!identity.bootId || !Number.isInteger(identity.groupId) || !Number.isInteger(identity.sessionId)) throw new Error('Incomplete Linux process identity.');
  return identity;
};
export const sameLinuxProcess = (a, b) => Boolean(a && b && a.pid === b.pid && a.bootId === b.bootId && a.startTicks === b.startTicks);
export const inspectLinuxIdentity = async (identity, { readIdentity = readLinuxProcessIdentity } = {}) => {
  try { const current = await readIdentity(identity.pid); return { state: sameLinuxProcess(identity, current) && current.state !== 'Z' ? 'active' : 'reused', current }; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return { state: 'absent' }; return { state: 'unknown', code: error.code || null }; }
};
export const inspectLinuxGroup = async (groupId, { signal = process.kill, list = readdir, readIdentity = readLinuxProcessIdentity } = {}) => {
  if (!Number.isInteger(groupId) || groupId <= 0) return { confirmed: false, state: 'unknown' };
  try { signal(-groupId, 0); }
  catch (error) { if (error.code === 'ESRCH') return { confirmed: true, state: 'absent', activeProcessCount: 0 }; return { confirmed: false, state: 'unknown', code: error.code || null }; }
  try {
    let members = 0, active = 0;
    for (const name of await list('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let item;
      try { item = await readIdentity(Number(name)); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
      if (item.groupId === groupId) { members++; if (item.state !== 'Z') active++; }
    }
    return members && active === 0 ? { confirmed: true, state: 'zombies_only', activeProcessCount: 0 }
      : { confirmed: false, state: active ? 'active' : 'unknown', activeProcessCount: active };
  } catch (error) { return { confirmed: false, state: 'unknown', code: error.code || null }; }
};
