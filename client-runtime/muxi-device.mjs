import { spawnSync } from 'node:child_process';

const DEVICE_PATTERN = /\bC(?:5\d{2}|\d{3,4})\b/i;

export const parseMuxiDevice = (...values) => {
  for (const value of values) {
    const match = String(value || '').match(DEVICE_PATTERN);
    if (match) return match[0].toUpperCase();
  }
  return null;
};

const runProbe = (spawn, command, args) => {
  try {
    const result = spawn(command, args, { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    return result?.status === 0 ? `${result.stdout || ''}\n${result.stderr || ''}` : '';
  } catch {
    return '';
  }
};

export const detectMuxiDevice = (environment = process.env, spawn = spawnSync) => {
  const explicit = parseMuxiDevice(environment.OPERATOR_MUXI_DEVICE);
  if (explicit) return { device: explicit, source: 'explicit' };
  const python = environment.PYTHON || 'python';
  const torchOutput = runProbe(spawn, python, ['-c', 'import torch; print(torch.cuda.get_device_name(torch.cuda.current_device())) if torch.cuda.is_available() else None']);
  const torchDevice = parseMuxiDevice(torchOutput);
  if (torchDevice) return { device: torchDevice, source: 'torch.cuda', detail: torchOutput.trim().split(/\r?\n/)[0] };
  const mxSmiOutput = runProbe(spawn, 'mx-smi', []);
  const mxSmiDevice = parseMuxiDevice(mxSmiOutput);
  if (mxSmiDevice) return { device: mxSmiDevice, source: 'mx-smi' };
  return { device: 'C550', source: 'release-default' };
};
