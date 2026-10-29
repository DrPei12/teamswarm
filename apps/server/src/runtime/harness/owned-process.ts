import { createHash } from "node:crypto";
import { execFile, spawn, type SpawnOptionsWithoutStdio, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A small bridge to Windows Job Objects. It forwards the existing protocol pipes.
// Filesystem/network permissions remain the responsibility of the native harness.
const windowsSource = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
class OwnedProcess {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public int size; public string reserved,desktop,title; public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
 [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong reads,writes,other,readBytes,writeBytes,otherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Entry { public uint size,usage,pid; public IntPtr heap; public uint module,threads,parent; public int priority; public uint flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string executable; }
 [StructLayout(LayoutKind.Sequential)] struct Memory { public uint length,load; public ulong totalPhysical,availablePhysical,totalCommit,availableCommit,totalVirtual,availableVirtual,extended; }
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref Startup startup,out ProcessInfo info);
 [DllImport("kernel32",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [DllImport("kernel32",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimit value,int size);
 [DllImport("kernel32",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32")] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32")] static extern IntPtr GetStdHandle(int id);
 [DllImport("kernel32")] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32",CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot,ref Entry entry);
 [DllImport("kernel32",CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot,ref Entry entry);
 [DllImport("kernel32")] static extern bool GlobalMemoryStatusEx(ref Memory memory);
 static string Quote(string value) { var b=new StringBuilder("\""); int slashes=0; foreach(char c in value) { if(c=='\\') { slashes++; continue; } if(c=='"') { b.Append('\\',slashes*2+1); b.Append(c); } else { b.Append('\\',slashes); b.Append(c); } slashes=0; } b.Append('\\',slashes*2); return b.Append('"').ToString(); }
 static int Run(string[] args) {
  IntPtr job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
  var limit=new ExtendedLimit(); limit.basic.flags=0x2000;
  if(!SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(typeof(ExtendedLimit)))) { CloseHandle(job); throw new System.ComponentModel.Win32Exception(); }
  var startup=new Startup(); startup.size=Marshal.SizeOf(typeof(Startup)); startup.flags=0x100|1;
  startup.input=GetStdHandle(-10);startup.output=GetStdHandle(-11);startup.error=GetStdHandle(-12);
  foreach(var handle in new[]{startup.input,startup.output,startup.error}) if(!SetHandleInformation(handle,1,1)) { CloseHandle(job); throw new System.ComponentModel.Win32Exception(); }
  var command=new StringBuilder(); for(int i=2;i<args.Length;i++) { if(i>2)command.Append(' ');command.Append(Quote(args[i])); }
  ProcessInfo info;
  if(!CreateProcess(args[2],command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref startup,out info)) { CloseHandle(job);throw new System.ComponentModel.Win32Exception(); }
  try {
   if(!AssignProcessToJobObject(job,info.process)) { TerminateProcess(info.process,125);throw new System.ComponentModel.Win32Exception(); }
   IntPtr parent=OpenProcess(0x100000,false,UInt32.Parse(args[1]));
   if(parent==IntPtr.Zero) { TerminateJobObject(job,125);throw new System.ComponentModel.Win32Exception(); }
   ThreadPool.QueueUserWorkItem(delegate { WaitForSingleObject(parent,0xffffffff);TerminateJobObject(job,137);CloseHandle(parent); });
   if(ResumeThread(info.thread)==0xffffffff) { TerminateProcess(info.process,125);throw new System.ComponentModel.Win32Exception(); }
   WaitForSingleObject(info.process,0xffffffff);uint code;GetExitCodeProcess(info.process,out code);return unchecked((int)code);
  } finally { CloseHandle(info.thread);CloseHandle(info.process);CloseHandle(job); }
 }
 static int Sample(string[] args) {
  var roots=new HashSet<uint>(); for(int i=1;i<args.Length;i++)roots.Add(UInt32.Parse(args[i]));
  var parents=new Dictionary<uint,uint>(); var snapshot=CreateToolhelp32Snapshot(2,0);
  if(snapshot==new IntPtr(-1))throw new System.ComponentModel.Win32Exception();
  try { var e=new Entry();e.size=(uint)Marshal.SizeOf(typeof(Entry));if(Process32First(snapshot,ref e))do { parents[e.pid]=e.parent; } while(Process32Next(snapshot,ref e)); } finally {CloseHandle(snapshot);}
  var own=new HashSet<uint>(roots);bool changed=true;while(changed){changed=false;foreach(var p in parents)if(own.Contains(p.Value)&&own.Add(p.Key))changed=true;}
  var memory=new Memory();memory.length=(uint)Marshal.SizeOf(typeof(Memory));if(!GlobalMemoryStatusEx(ref memory))throw new System.ComponentModel.Win32Exception();
  var output=new StringBuilder(); output.Append("{\"totalPhysical\":").Append(memory.totalPhysical).Append(",\"availablePhysical\":").Append(memory.availablePhysical).Append(",\"totalCommit\":").Append(memory.totalCommit).Append(",\"availableCommit\":").Append(memory.availableCommit).Append(",\"systemProcessCount\":").Append(parents.Count).Append(",\"processes\":[");bool first=true;
  int samplerPid=Process.GetCurrentProcess().Id;
  foreach(uint pid in own) { if(pid==(uint)samplerPid)continue; try { using(var p=Process.GetProcessById((int)pid)){
    long started=p.StartTime.ToUniversalTime().Ticks,working=p.WorkingSet64,committed=p.PrivateMemorySize64,cpu=(long)p.TotalProcessorTime.TotalMilliseconds;
    if(!first)output.Append(',');first=false;
    output.Append("{\"pid\":").Append(pid).Append(",\"parentPid\":").Append(parents.ContainsKey(pid)?parents[pid]:0).Append(",\"identity\":\"windows:").Append(started).Append("\",\"workingSet\":").Append(working).Append(",\"privateBytes\":").Append(committed).Append(",\"cpuMilliseconds\":").Append(cpu).Append('}');
  } }catch(ArgumentException){}catch(System.ComponentModel.Win32Exception){}catch(InvalidOperationException){} }
  Console.WriteLine(output.Append("]}").ToString());return 0;
 }
 static int Main(string[] args) { try { if(args.Length<1)return 125;if(args[0]=="sample")return Sample(args);if(args[0]=="run"&&args.Length>=3)return Run(args);return 125; } catch(Exception e){Console.Error.WriteLine("TeamSwarm process group: "+e.Message);return 125;} }
}`;

let bridge: Promise<string> | undefined;
const groups = new WeakMap<ChildProcessWithoutNullStreams, { cleanup?: Promise<boolean> }>();
async function stopProcessGroup(pid: number): Promise<boolean> {
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  for (let i = 0; i < 40; i++) {
    try { process.kill(-pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}
/** Check the group owned by this handle, including descendants of an exited root. */
export async function confirmOwnedExit(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  const group = groups.get(child);
  if (!group || !child.pid || (child.exitCode === null && child.signalCode === null)) return false;
  if (process.platform === "win32") return true;
  return group.cleanup ??= stopProcessGroup(child.pid);
}
function windowsBridge(): Promise<string> {
  return bridge ??= (async () => {
    const digest = createHash("sha256").update(windowsSource).digest("hex");
    const directory = path.join(tmpdir(), "teamswarm-process", digest);
    mkdirSync(directory, { recursive: true });
    const executable = path.join(directory, "owned-process.exe");
    const receipt = path.join(directory, "sha256");
    if (existsSync(executable) && existsSync(receipt) &&
      createHash("sha256").update(readFileSync(executable)).digest("hex") === readFileSync(receipt, "utf8")) return executable;
    const source = path.join(directory, "owned-process.cs");
    writeFileSync(source, windowsSource);
    const compiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const temporary = path.join(directory, `owned-${process.pid}-${Date.now()}.exe`);
    await new Promise<void>((resolve, reject) => execFile(compiler,
      ["/nologo", "/optimize+", "/target:exe", `/out:${temporary}`, source],
      { windowsHide: true, timeout: 30000 }, (error, stdout) => error ? reject(new Error(`Process supervisor unavailable: ${stdout || error.message}`)) : resolve()));
    try { renameSync(temporary, executable); }
    catch (error) {
      if (!existsSync(executable) || !existsSync(receipt) ||
        createHash("sha256").update(readFileSync(executable)).digest("hex") !== readFileSync(receipt, "utf8")) throw error;
      unlinkSync(temporary);
    }
    writeFileSync(receipt, createHash("sha256").update(readFileSync(executable)).digest("hex"));
    return executable;
  })().catch(error => { bridge = undefined; throw error; });
}

export async function spawnOwned(command: string, args: string[], options: SpawnOptionsWithoutStdio): Promise<ChildProcessWithoutNullStreams> {
  if (process.platform === "win32") {
    // The helper creates the target suspended, binds it to a Job, then resumes it.
    // Terminating the helper closes the last Job handle and terminates descendants.
    const child = spawn(await windowsBridge(), ["run", String(process.pid), command, ...args], { ...options, windowsHide: true, stdio: "pipe" });
    groups.set(child, {});
    return child;
  }
  const child = spawn(command, args, { ...options, detached: true, stdio: "pipe" });
  const group: { cleanup?: Promise<boolean> } = {};
  groups.set(child, group);
  child.once("exit", () => { if (child.pid) group.cleanup ??= stopProcessGroup(child.pid); });
  return child;
}

export interface ProcessSample {
  totalPhysical: number; availablePhysical: number; availableCommit?: number; totalCommit?: number;
  systemProcessCount?: number; cpuCores?: number; cpuBusyPercent?: number; cpuModel?: string;
  processCoverage?: "descendants" | "unavailable";
  processes: { pid: number; parentPid: number; identity: string; workingSet: number; privateBytes: number; cpuMilliseconds?: number }[];
}
export async function sampleWindowsProcesses(root: number): Promise<ProcessSample> {
  const executable = await windowsBridge();
  return new Promise((resolve, reject) => execFile(executable, ["sample", String(root)],
    { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error); else try { resolve(JSON.parse(stdout)); } catch(error) { reject(error); }
    }));
}
