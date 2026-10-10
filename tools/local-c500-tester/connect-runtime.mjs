// Reopen a compatible TUI against the original manual owner. Closing this TUI
// never transfers ownership, starts/replaces a Runtime, or reads provider keys.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectRuntimeAttachment} from './runtime-attachment.mjs';

export async function connectRuntime(file,{once=false}={}) {
  const attachment=await inspectRuntimeAttachment(file);
  Object.assign(process.env,attachment.environment);
  const {main}=await import('./tui.mjs');
  await main({args:once?['panel','--once']:[]});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==3&&!(process.argv.length===4&&process.argv[3]==='--once'))throw new Error('Usage: connect-runtime.mjs <host-ready.json> [--once]');
  await connectRuntime(process.argv[2],{once:process.argv[3]==='--once'});
}
