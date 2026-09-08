<#
  Windows Job Object process helper for the local execution adapter.

  The helper intentionally has no Mission/workflow knowledge.  It starts one
  process suspended, puts it in a Job Object with KILL_ON_JOB_CLOSE, and only
  then resumes it.  If this helper is killed, closing its job handle tears down
  the complete process tree.  The JSON protocol is deliberately tiny so Node
  can invoke this script without installing a compiler or native package.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [ValidateSet('start', 'terminate')] [string] $Action,
  [string] $Config,
  [string] $JobName
)

$ErrorActionPreference = 'Stop'

if (-not ('Acagemm.JobRunner' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Acagemm {
  public static class JobRunner {
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint WAIT_OBJECT_0 = 0x00000000;
    const uint INFINITE = 0xffffffff;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int JobObjectExtendedLimitInformation = 9;
    const uint GENERIC_WRITE = 0x40000000;
    const uint FILE_SHARE_READ = 1;
    const uint FILE_SHARE_WRITE = 2;
    const uint CREATE_ALWAYS = 2;
    const uint OPEN_EXISTING = 3;
    const uint FILE_ATTRIBUTE_NORMAL = 0x80;
    const uint HANDLE_FLAG_INHERIT = 1;
    const uint DUPLICATE_SAME_ACCESS = 2;

    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {
      public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public int dwX; public int dwY; public int dwXSize; public int dwYSize;
      public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
      public int dwFlags; public short wShowWindow; public short cbReserved2;
      public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
      public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
      public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
      public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
    [DllImport("kernel32.dll")]
    static extern uint GetLastError();
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoType, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr procAttrs, IntPtr threadAttrs,
      bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr attrs, uint disposition,
      uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DeleteFileW(string name);

    static void Fail(string operation) { throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed"); }
    static IntPtr FileHandle(string path, bool input) {
      var h = CreateFileW(path, input ? 0x80000000u : GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        IntPtr.Zero, input ? OPEN_EXISTING : CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
      if (h == new IntPtr(-1)) Fail("CreateFile " + path);
      if (!SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) { CloseHandle(h); Fail("SetHandleInformation"); }
      return h;
    }
    static string Quote(string s) { return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

    public static string Start(string app, string args, string cwd, string jobName, string stdoutPath, string stderrPath) {
      var job = CreateJobObjectW(IntPtr.Zero, jobName);
      var createError = GetLastError();
      if (job == IntPtr.Zero) Fail("CreateJobObject");
      // CreateJobObjectW opens an existing named Job when the name collides
      // and reports ERROR_ALREADY_EXISTS. Never attach a new runner to an
      // existing Job: doing so would make cancellation of one task affect
      // another task that owns the same name.
      if (createError == 183) {
        CloseHandle(job);
        throw new Win32Exception(183, "CreateJobObject name already exists");
      }
      var limit = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      var size = Marshal.SizeOf(limit); var ptr = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limit, ptr, false);
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)size)) Fail("SetInformationJobObject");
      } finally { Marshal.FreeHGlobal(ptr); }
      IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
      PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
      try {
        input = FileHandle("NUL", true); output = FileHandle(stdoutPath, false); error = FileHandle(stderrPath, false);
        var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.dwFlags = (int)STARTF_USESTDHANDLES;
        si.hStdInput = input; si.hStdOutput = output; si.hStdError = error;
        var cmd = new StringBuilder(Quote(app) + (String.IsNullOrWhiteSpace(args) ? "" : " " + args));
        if (!CreateProcessW(app, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
          IntPtr.Zero, cwd, ref si, out pi)) Fail("CreateProcess");
        if (!AssignProcessToJobObject(job, pi.hProcess)) { TerminateProcessSafe(pi.hProcess); Fail("AssignProcessToJobObject"); }
        if (ResumeThread(pi.hThread) == 0xffffffff) { TerminateProcessSafe(pi.hProcess); Fail("ResumeThread"); }
        CloseHandle(pi.hThread); pi.hThread = IntPtr.Zero;
        var wait = WaitForSingleObject(pi.hProcess, INFINITE); if (wait != WAIT_OBJECT_0) Fail("WaitForSingleObject");
        uint code; if (!GetExitCodeProcess(pi.hProcess, out code)) Fail("GetExitCodeProcess");
        var result = "{\"jobName\":\"" + Escape(jobName) + "\",\"pid\":" + pi.dwProcessId + ",\"exitCode\":" + code + ",\"release\":\"confirmed\"}";
        CloseHandle(pi.hProcess); pi.hProcess = IntPtr.Zero; CloseHandle(job); job = IntPtr.Zero; return result;
      } finally {
        if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread); if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
        if (input != IntPtr.Zero) CloseHandle(input); if (output != IntPtr.Zero) CloseHandle(output); if (error != IntPtr.Zero) CloseHandle(error);
        if (job != IntPtr.Zero) CloseHandle(job);
      }
    }
    static string Escape(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }
    static void TerminateProcessSafe(IntPtr p) { if (p != IntPtr.Zero) TerminateProcess(p, 1); }
    public static void Terminate(string jobName, uint code) {
      // Request only query + terminate rights. Asking for ALL_ACCESS makes a
      // cross-process open fail under ordinary (non-admin) user tokens even
      // when the caller owns the Job.
      var job = OpenJobObjectW(0x0000000Cu, false, jobName); if (job == IntPtr.Zero) Fail("OpenJobObject");
      try { if (!TerminateJobObject(job, code)) Fail("TerminateJobObject"); } finally { CloseHandle(job); }
    }
  }
}
"@
}

if ($Action -eq 'start') {
  if (-not $Config) { throw 'Config is required for start.' }
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines($Config, [Text.Encoding]::UTF8)) {
    $parts = $line.Split('=', 2)
    if ($parts.Length -eq 2) { $values[$parts[0]] = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1])) }
  }
  $cfg = [pscustomobject]$values
  $argText = [string]$cfg.arguments
  $result = [Acagemm.JobRunner]::Start([string]$cfg.filePath, $argText, [string]$cfg.cwd,
    [string]$cfg.jobName, [string]$cfg.stdoutPath, [string]$cfg.stderrPath)
  [Console]::Out.WriteLine($result)
  exit 0
}

if (-not $JobName) { throw 'JobName is required for terminate.' }
[Acagemm.JobRunner]::Terminate($JobName, 1)
$safeJobName = $JobName.Replace('\', '\\').Replace('"', '\"')
[Console]::Out.WriteLine('{"jobName":"' + $safeJobName + '","terminated":true}')
exit 0
