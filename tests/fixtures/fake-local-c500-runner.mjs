import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const taskDir = process.env.OPERATOR_LOCAL_C500_TASK_DIR;
const resultPath = process.env.OPERATOR_LOCAL_C500_RESULT_JSON;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

await wait(250);
await writeFile(path.join(taskDir, 'runner-status.json'), `${JSON.stringify({ progress: 60, stage: 'benchmark', message: 'Correctness passed; benchmark running.' })}\n`, 'utf8');
await wait(450);
await writeFile(resultPath, `${JSON.stringify({
  benchmark: [{ environment: 'C550', metric: 'latency_p50', profile: 'primary', value: 10, unit: 'us', correctness: { passed: true, total: 1, passedCases: 1 } }],
  tracer: { status: 'unavailable' },
  profiler: { status: 'unavailable' },
  environment: { source: 'local-c500', liveHardware: true },
})}\n`, 'utf8');
