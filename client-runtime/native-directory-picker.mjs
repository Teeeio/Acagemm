import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';

const run = (execFileImpl, command, args, options = {}) => new Promise((resolve, reject) => {
  execFileImpl(command, args, { ...options, encoding: 'utf8', windowsHide: true }, (error, stdout = '', stderr = '') => {
    if (error) {
      error.stderr = stderr;
      reject(error);
      return;
    }
    resolve(String(stdout).trim());
  });
});

const windowsScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择项目 Git 仓库目录'
$dialog.ShowNewFolderButton = $true
if ($env:OPERATOR_DIRECTORY_INITIAL_PATH -and (Test-Path -LiteralPath $env:OPERATOR_DIRECTORY_INITIAL_PATH -PathType Container)) {
  $dialog.SelectedPath = $env:OPERATOR_DIRECTORY_INITIAL_PATH
}
$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$owner.Show()
$result = $dialog.ShowDialog($owner)
$owner.Close()
$payload = if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  @{ cancelled = $false; path = $dialog.SelectedPath }
} else {
  @{ cancelled = $true; path = $null }
}
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload | ConvertTo-Json -Compress
`;

export const createNativeDirectoryPicker = ({ platform = process.platform, execFileImpl = nodeExecFile, env = process.env } = {}) => ({
  async select(initialPath = '') {
    if (platform === 'win32') {
      const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
      const command = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const output = await run(execFileImpl, command, ['-NoProfile', '-STA', '-Command', windowsScript], {
        env: { ...env, OPERATOR_DIRECTORY_INITIAL_PATH: String(initialPath || '') },
      });
      return JSON.parse(output);
    }

    const error = new Error('当前操作系统暂未提供原生文件夹选择器。');
    error.code = 'NATIVE_DIRECTORY_PICKER_UNAVAILABLE';
    error.status = 501;
    throw error;
  },
});

export const nativeDirectoryPicker = createNativeDirectoryPicker();
