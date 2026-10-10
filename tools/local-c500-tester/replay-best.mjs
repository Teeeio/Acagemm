import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBestCandidateDirectory } from './best-candidate-export.mjs';
export const main = async (args = process.argv.slice(2)) => {
  if (args.length !== 2 || args[0] !== '--validate') throw Object.assign(new Error('Usage: node tools/local-c500-tester/replay-best.mjs --validate <export-directory>; validates files, never runs hardware.'), { code: 'BEST_REPLAY_USAGE' });
  const started = Date.now(), result = await verifyBestCandidateDirectory(args[1]);
  process.stdout.write(JSON.stringify({ ...result, elapsedMs: Date.now() - started }) + '\n'); return result;
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { process.stderr.write(JSON.stringify({ code: error.code || 'BEST_EXPORT_INVALID', error: error.message }) + '\n'); process.exitCode = 1; }
}
