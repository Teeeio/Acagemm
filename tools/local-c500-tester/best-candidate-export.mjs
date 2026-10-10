import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertBestCandidateExport } from '../../client-runtime/best-candidate-export.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const child = (root, relative) => {
  const target = path.resolve(root, relative), rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw fail('BEST_EXPORT_PATH_INVALID', '导出路径超出结果包。');
  return target;
};
const decode = file => Buffer.from(file.content, 'base64');
const write = async (root, relative, bytes) => {
  const target = child(root, relative); await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });
};

// The application supplied an accepted immutable bundle, not a live workspace.
export const writeBestCandidateExport = async (document, exportDirectory) => {
  assertBestCandidateExport(document);
  await mkdir(exportDirectory, { recursive: true });
  const prefix = String(document.identity.missionId || 'mission').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const destination = await mkdtemp(path.join(path.resolve(exportDirectory), 'best-' + prefix + '-'));
  await write(destination, 'best-candidate.json', JSON.stringify(document, null, 2) + '\n');
  for (const file of document.bundle.files) await write(destination, 'sources/' + file.path, decode(file));
  await write(destination, 'baseline/oracle.py', decode(document.bundle.baseline));
  await write(destination, 'test-matrix.json', JSON.stringify(document.replay.testMatrix, null, 2) + '\n');
  await write(destination, 'execution-package-input.json', JSON.stringify(document.replay.executionPackage, null, 2) + '\n');
  const guide = [
    '# 已验收最佳候选',
    '',
    'Mission: ' + document.identity.missionId,
    'Candidate: ' + document.identity.candidateId,
    'Frozen manifest: ' + document.identity.manifestDigest,
    'Evidence digest: ' + document.evidenceDigest,
    '',
    'sources/ 是已保留候选的原字节；baseline/oracle.py 是冻结的独立基线。它们不来自当前工作树或末次待测候选。',
    'best-candidate.json 包含原始冻结包、测试/决策回执、形状、正确性容差、业务策略及源码身份；test-matrix.json 供查阅。',
    '',
    '## 离线文件校验',
    '在已安装的 Acagemm 交付目录运行：',
    'node tools/local-c500-tester/replay-best.mjs --validate "' + destination + '"',
    '该命令只验证包和解包文件的身份，不调用模型、不执行算子，不产生新的性能或发布证据。',
    '',
    '## 算子重放',
    '使用本包 sources/、baseline/oracle.py 和原 test-matrix.json；不要借用原作者工作区或其他版本的基线。',
    '本交付只提供离线身份校验 CLI，尚未验证脱离原工作区的算子执行重放入口。',
    'execution-package-input.json 保留原运行回执中的执行包描述，可能为空或含原路径；不能直接作为本地重放请求。',
    '执行重放需从本包源码、独立基线和测试契约构造新的执行包，并明确确认设备与依赖环境。',
    '完整 replay 契约、设备要求与限制见 best-candidate.json 的 replay；本次导出不会启动模型或硬件。',
    '如设备/依赖/测试契约变化，应作为新验证记录，不能将旧回执当作新环境实测。',
    '',
    '该包提供可核实的最佳候选，不授予跨硬件或产品发布资格。',
    '',
  ].join('\n');
  await write(destination, 'REPLAY.md', guide);
  await verifyBestCandidateDirectory(destination);
  return destination;
};

export const verifyBestCandidateDirectory = async directory => {
  const root = path.resolve(directory);
  const document = JSON.parse(await readFile(child(root, 'best-candidate.json'), 'utf8'));
  assertBestCandidateExport(document);
  for (const file of document.bundle.files) {
    const bytes = await readFile(child(root, 'sources/' + file.path));
    if (bytes.length !== file.size || sha(bytes) !== file.digest) throw fail('BEST_EXPORT_SOURCE_CHANGED', '导出源码与已验收候选身份不一致：' + file.path);
  }
  const baseline = await readFile(child(root, 'baseline/oracle.py'));
  if (baseline.length !== document.bundle.baseline.size || sha(baseline) !== document.bundle.baseline.digest) throw fail('BEST_EXPORT_BASELINE_CHANGED', '独立基线与冻结身份不一致。');
  const matrix = JSON.parse(await readFile(child(root, 'test-matrix.json'), 'utf8'));
  if (JSON.stringify(matrix) !== JSON.stringify(document.replay.testMatrix)) throw fail('BEST_EXPORT_TEST_CHANGED', '测试矩阵与冻结契约不一致。');
  const execution = JSON.parse(await readFile(child(root, 'execution-package-input.json'), 'utf8'));
  if (JSON.stringify(execution) !== JSON.stringify(document.replay.executionPackage)) throw fail('BEST_EXPORT_PACKAGE_CHANGED', '执行包输入与冻结描述不一致。');
  return { schemaVersion: document.schemaVersion, identity: document.identity, evidenceDigest: document.evidenceDigest,
    sourceFiles: document.bundle.files.map(file => ({ path: file.path, digest: file.digest })),
    baselineDigest: document.bundle.baseline.digest, paidModelRuns: 0, hardwareRuns: 0,
    validationOnly: true, publicationGranted: false };
};
