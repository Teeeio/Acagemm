import { appendFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const adoptCandidatePatch = async ({ candidateRoot, iterationRepository, gate, candidate } = {}) => {
  if (gate?.result !== 'adopt' || gate?.publishable !== true) return { adopted: false, reason: 'accept_gate_not_publishable' };
  await rm(iterationRepository, { recursive: true, force: true });
  await mkdir(iterationRepository, { recursive: true });
  await cp(candidateRoot, iterationRepository, { recursive: true, force: true });
  await writeFile(path.join(iterationRepository, 'adoption.json'), `${JSON.stringify({ candidate, gate, adoptedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  return { adopted: true, iterationRepository, candidate, gate };
};

export const rollbackCandidatePatch = async ({ candidateRoot, checkpointRoot } = {}) => {
  await rm(candidateRoot, { recursive: true, force: true });
  await mkdir(candidateRoot, { recursive: true });
  await cp(checkpointRoot, candidateRoot, { recursive: true, force: true });
  return { rolledBack: true, candidateRoot, checkpointRoot };
};

export const recordCandidateExperience = async ({ missionDir, candidate, gate, result, failure = null } = {}) => {
  await mkdir(missionDir, { recursive: true });
  const liveHardware = result?.environment?.liveHardware === true && gate?.publishable === true;
  const experience = {
    candidate_id: candidate?.id || candidate?.candidate_id || null,
    digest: candidate?.digest || candidate?.patchDigest || null,
    status: liveHardware && gate?.result === 'adopt' ? 'validated' : 'simulation',
    disposition: gate?.result || 'reject',
    evidenceLevel: liveHardware ? 'live_hardware' : 'simulation_only',
    failedRules: gate?.failedRules || [],
    failure,
    recordedAt: new Date().toISOString(),
  };
  await appendFile(path.join(missionDir, 'experiences.jsonl'), `${JSON.stringify(experience)}\n`, 'utf8');
  return experience;
};
