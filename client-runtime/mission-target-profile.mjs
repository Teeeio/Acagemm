// Explicit optimization intent, not an execution capability or hardware evidence.
// This pure contract can be used on a client with no GPU or backend connection.
export const MISSION_TARGET_PROFILE_VERSION = 'operator-studio.mission-target-profile/v1';
const backendNames = new Set(['local-shared-gpu', 'local-c500', 'local-c550', 'local-cpu', 'mock', 'simulation']);
const error = (message) => Object.assign(new Error(message), { code: 'MISSION_TARGET_PROFILE_INVALID', status: 400 });
const plain = (value, fields) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw error('目标配置必须是普通对象。');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!fields.includes(key) || !descriptor.enumerable || !('value' in descriptor)) throw error('目标配置包含不支持的字段。');
  }
};
const identifier = (value, label) => {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/u.test(value.trim())) throw error(`${label} 需为 1—64 位架构标识（字母开头，可含数字、点、下划线和连字符）。`);
  return value.trim().toLowerCase();
};

export const normalizeMissionTargetProfile = (value, hardware) => {
  if (value === undefined || value === null) return null;
  plain(value, ['schemaVersion', 'hardware', 'architecture', 'source']);
  if (value.schemaVersion !== undefined && value.schemaVersion !== MISSION_TARGET_PROFILE_VERSION) throw error('目标配置版本不受支持。');
  if (value.source !== undefined && value.source !== 'user-declared') throw error('手动目标配置不能声明为实际硬件观察或执行端认证。');
  if (!Array.isArray(hardware) || hardware.length !== 1) throw error('声明目标架构时必须明确选择一个目标硬件。');
  const owner = identifier(hardware[0], '目标硬件');
  if (backendNames.has(owner)) throw error('执行后端名称不能用作硬件身份。');
  if (value.hardware !== undefined && identifier(value.hardware, '目标硬件') !== owner) throw error('目标架构配置的硬件与 Mission 不一致。');
  const architecture = identifier(value.architecture, '目标架构');
  if (backendNames.has(architecture)) throw error('执行后端名称不能用作目标架构。');
  if (/^sm\d+[a-z]?$/u.test(architecture) && owner !== 'nvidia-gpu') throw error('SM 架构仅能配置到 NVIDIA 目标；切换硬件后请重新确认架构。');
  return { schemaVersion: MISSION_TARGET_PROFILE_VERSION, source: 'user-declared', hardware: owner, architecture };
};

// Suggestions are identifiers, not an availability/driver/device support claim.
// Custom identifiers keep other vendors and future targets configurable offline.
export const missionArchitectureSuggestions = (hardware) => String(hardware).toLowerCase() === 'nvidia-gpu'
  ? ['', 'sm80', 'sm86', 'sm89', 'sm90', 'sm100'] : [''];
