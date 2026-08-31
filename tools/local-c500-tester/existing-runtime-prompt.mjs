import readline from 'node:readline/promises';

export const promptExistingRuntime = async (conflict, { input = process.stdin, output = process.stdout } = {}) => {
  if (input?.isTTY !== true || output?.isTTY !== true) return 'cancel';
  const lines = [
    '',
    '检测到正在运行的 Operator Studio 实例：',
    `  TUI PID: ${conflict.ownerPid}`,
    `  Runtime PID: ${conflict.runtimePid}`,
    `  模式: ${conflict.executionMode || 'unknown'} / ${conflict.mode || 'unknown'}`,
    '',
    conflict.canReuse
      ? '  [1] 连接旧实例：继续原工作流，并在当前终端打开控制面板'
      : '  [1] 连接旧实例：不可用（运行模式或版本不兼容）',
    '  [2] 停止旧实例：关闭旧 TUI/Runtime，并启动一个新实例',
    '  [q] 取消启动',
    '',
  ];
  output.write(`${lines.join('\n')}\n`);
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const answer = (await rl.question(conflict.canReuse ? '请选择 [1]: ' : '请选择 [2]: ')).trim().toLowerCase();
      if ((answer === '' && conflict.canReuse) || ['1', 'reuse', 'attach'].includes(answer)) return 'reuse';
      if ((answer === '' && !conflict.canReuse) || ['2', 'replace', 'restart'].includes(answer)) return 'replace';
      if (['q', 'quit', 'cancel'].includes(answer)) return 'cancel';
      output.write('无效选择，请输入 1、2 或 q。\n');
    }
  } finally {
    rl.close();
  }
};
