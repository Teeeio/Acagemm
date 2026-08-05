import { spawn } from 'node:child_process';

const processes = [];
const start = (command, args, env) => {
  const child = spawn(command, args, { stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
  processes.push(child);
  child.on('exit', (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
};

start('node', ['server/mock-server.mjs'], { API_PORT: '4174', SERVE_WEB: 'false' });
start('vite', ['--host', '127.0.0.1'], {});

const shutdown = () => {
  for (const child of processes) child.kill();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
