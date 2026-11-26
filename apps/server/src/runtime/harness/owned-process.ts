import { createHash } from "node:crypto";
import { execFile, spawn, type SpawnOptionsWithoutStdio, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnDarwinOwned, type DarwinOwned } from "./darwin-supervisor.js";

// A small bridge to Windows Job Objects. It forwards the existing protocol pipes.
// Filesystem/network permissions remain the responsibility of the native harness.
const windowsSource = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Microsoft.Win32.SafeHandles;
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
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StartupEx { public Startup startup; public IntPtr attributes; }
 [DllImport("kernel32",EntryPoint="CreateProcessW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessInJob(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupEx startup,out ProcessInfo info);
 [DllImport("kernel32",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes,int count,int flags,ref IntPtr bytes);
 [DllImport("kernel32",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes,uint flags,IntPtr key,IntPtr value,IntPtr bytes,IntPtr previous,IntPtr returned);
 [DllImport("kernel32")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
 [DllImport("kernel32",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
 [DllImport("kernel32",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting value,int size,IntPtr returned);
 [DllImport("kernel32",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref ExtendedLimit value,int size);
 [DllImport("kernel32",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32")] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32")] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
 [StructLayout(LayoutKind.Sequential)] struct StartupRaw { public int size; public IntPtr reserved,desktop,title; public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
 [DllImport("kernel32",EntryPoint="GetStartupInfoW")] static extern void GetStartupInfo(out StartupRaw startup);
 [DllImport("kernel32")] static extern IntPtr GetStdHandle(int id);
 [DllImport("kernel32")] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32",CharSet=CharSet.Unicode)] static extern bool Process32First(IntPtr snapshot,ref Entry entry);
 [DllImport("kernel32",CharSet=CharSet.Unicode)] static extern bool Process32Next(IntPtr snapshot,ref Entry entry);
 [DllImport("kernel32")] static extern bool GlobalMemoryStatusEx(ref Memory memory);
 static string Quote(string value) { var b=new StringBuilder("\""); int slashes=0; foreach(char c in value) { if(c=='\\') { slashes++; continue; } if(c=='"') { b.Append('\\',slashes*2+1); b.Append(c); } else { b.Append('\\',slashes); b.Append(c); } slashes=0; } b.Append('\\',slashes*2); return b.Append('"').ToString(); }
 // Node/libuv on Windows passes extra stdio descriptors in STARTUPINFO's CRT table.
 static FileStream PrivatePipe(int index,FileAccess access) {
  StartupRaw original; GetStartupInfo(out original);
  if(original.reservedPtr==IntPtr.Zero || original.reserved2<4) throw new InvalidOperationException("Missing supervisor pipes.");
  int count=Marshal.ReadInt32(original.reservedPtr);
  if(count<5 || count>64 || original.reserved2<4+count*(1+IntPtr.Size)) throw new InvalidOperationException("Invalid supervisor pipes.");
  var handle=Marshal.ReadIntPtr(original.reservedPtr,4+count+index*IntPtr.Size);
  if(handle==IntPtr.Zero || handle==new IntPtr(-1) || !SetHandleInformation(handle,1,0)) throw new InvalidOperationException("Cannot isolate supervisor pipe.");
  return new FileStream(new SafeFileHandle(handle,true),access,1,false);
 }
 static void Report(FileStream report,int value) { if(report!=null) { report.WriteByte((byte)value); report.Flush(); } }
 static void DrainJob(IntPtr job,FileStream report) {
  Accounting members;
  if(!QueryInformationJobObject(job,1,out members,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
  if(members.active!=0 && !TerminateJobObject(job,137)) throw new System.ComponentModel.Win32Exception();
  for(int i=0;i<200;i++) {
   if(!QueryInformationJobObject(job,1,out members,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
   if(members.active==0) { Report(report,'E'); return; }
   Thread.Sleep(20);
  }
  throw new InvalidOperationException("Owned Windows Job did not report zero active members.");
 }
 static bool CreateVerified(string app,StringBuilder command,Startup startup,IntPtr job,out ProcessInfo info) {
  info=new ProcessInfo(); IntPtr bytes=IntPtr.Zero;
  InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref bytes);
  if(bytes==IntPtr.Zero) return false;
  IntPtr attributes=Marshal.AllocHGlobal(bytes),handles=IntPtr.Zero,jobs=IntPtr.Zero;
  bool initialized=false;
  try {
   if(!InitializeProcThreadAttributeList(attributes,2,0,ref bytes)) return false;
   initialized=true;
   handles=Marshal.AllocHGlobal(3*IntPtr.Size); jobs=Marshal.AllocHGlobal(IntPtr.Size);
   Marshal.WriteIntPtr(handles,0,startup.input);Marshal.WriteIntPtr(handles,IntPtr.Size,startup.output);Marshal.WriteIntPtr(handles,2*IntPtr.Size,startup.error);
   Marshal.WriteIntPtr(jobs,job);
   if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero) ||
      !UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) return false;
   startup.size=Marshal.SizeOf(typeof(StartupEx));
   var extended=new StartupEx {startup=startup,attributes=attributes};
   return CreateProcessInJob(app,command,IntPtr.Zero,IntPtr.Zero,true,0x08080004,IntPtr.Zero,null,ref extended,out info);
  } finally {
   if(initialized)DeleteProcThreadAttributeList(attributes);
   Marshal.FreeHGlobal(attributes);Marshal.FreeHGlobal(handles);Marshal.FreeHGlobal(jobs);
  }
 }
 static int Run(string[] args) {
  bool verified=args[0]=="run-verified";
  var control=verified?PrivatePipe(3,FileAccess.Read):null;
  var report=verified?PrivatePipe(4,FileAccess.Write):null;
  if(verified && control.ReadByte()!='G') { Report(report,'N');return 125; }
  IntPtr job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) { Report(report,'N');throw new System.ComponentModel.Win32Exception(); }
  var limit=new ExtendedLimit(); limit.basic.flags=0x2000;
  if(!SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(typeof(ExtendedLimit)))) { CloseHandle(job); Report(report,'N'); throw new System.ComponentModel.Win32Exception(); }
  var startup=new Startup(); startup.size=Marshal.SizeOf(typeof(Startup)); startup.flags=0x100|1;
  startup.input=GetStdHandle(-10);startup.output=GetStdHandle(-11);startup.error=GetStdHandle(-12);
  foreach(var handle in new[]{startup.input,startup.output,startup.error}) if(!SetHandleInformation(handle,1,1)) { CloseHandle(job); Report(report,'N'); throw new System.ComponentModel.Win32Exception(); }
  var command=new StringBuilder(); for(int i=2;i<args.Length;i++) { if(i>2)command.Append(' ');command.Append(Quote(args[i])); }
  IntPtr parent=OpenProcess(0x100000,false,UInt32.Parse(args[1]));
  if(parent==IntPtr.Zero || WaitForSingleObject(parent,0)!=258) {
   if(parent!=IntPtr.Zero) CloseHandle(parent); CloseHandle(job);Report(report,'N');return 125;
  }
  ProcessInfo info;
  bool created=verified?CreateVerified(args[2],command,startup,job,out info):
   CreateProcess(args[2],command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref startup,out info);
  if(!created) { CloseHandle(parent);CloseHandle(job);Report(report,'N');throw new System.ComponentModel.Win32Exception(); }
  try {
   if(!verified && !AssignProcessToJobObject(job,info.process)) { CloseHandle(parent);TerminateProcess(info.process,125);throw new System.ComponentModel.Win32Exception(); }
   ThreadPool.QueueUserWorkItem(delegate { WaitForSingleObject(parent,0xffffffff);TerminateJobObject(job,137);CloseHandle(parent); });
   if(ResumeThread(info.thread)==0xffffffff) { if(verified)DrainJob(job,report);else TerminateProcess(info.process,125);throw new System.ComponentModel.Win32Exception(); }
   if(verified) {
    int stop=0;
    ThreadPool.QueueUserWorkItem(delegate { try { control.ReadByte(); } catch(IOException) {} finally { Interlocked.Exchange(ref stop,1); } });
    uint status;
    while((status=WaitForSingleObject(info.process,50))==258 && Interlocked.CompareExchange(ref stop,0,0)==0) {}
    if(status!=0 && status!=258) throw new System.ComponentModel.Win32Exception();
    DrainJob(job,report);
   } else WaitForSingleObject(info.process,0xffffffff);
   uint code;GetExitCodeProcess(info.process,out code);return unchecked((int)code);
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
 static int Main(string[] args) { try { if(args.Length<1)return 125;if(args[0]=="sample")return Sample(args);if((args[0]=="run"||args[0]=="run-verified")&&args.Length>=3)return Run(args);return 125; } catch(Exception e){Console.Error.WriteLine("TeamSwarm process group: "+e.Message);return 125;} }
}`;

let bridge: Promise<string> | undefined;
type JobEvidence = "windows-job-empty" | "windows-job-not-started";
type OwnedGroup = { cleanup?: Promise<boolean>; control?: Duplex; evidence?: Promise<JobEvidence | undefined>; darwin?: DarwinOwned };
const groups = new WeakMap<ChildProcessWithoutNullStreams, OwnedGroup>();
const darwinByPid = new Map<number, DarwinOwned>();
/** Private journal metadata; never include the cookie in events or UI responses. */
export function darwinProcessBinding(supervisorPid: number) {
  return darwinByPid.get(supervisorPid)?.binding;
}
function supervisorRoot() {
  // Keep the compiled helper out of the volatile OS temp cleanup path.
  // Runtime cache is per device, not per project/workspace.
  const explicit = process.env.TEAMSWARM_SUPERVISOR_DIR;
  if (explicit && path.isAbsolute(explicit)) return explicit;
  const local = process.env.LOCALAPPDATA;
  if (local) return path.join(local, "TeamSwarm", "process-supervisor");
  return path.join(tmpdir(), "teamswarm-process");
}
export async function stopProcessGroup(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  if (process.platform === "darwin") {
    const owned = darwinByPid.get(pid);
    if (!owned) return false;
    requestOwnedJobStop(owned.child);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([owned.exited.then(() => owned.evidence),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 7000); })]);
    } finally { clearTimeout(timer); }
  }
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code !== "EPERM") return false;
  }
  for (let i = 0; i < 40; i++) {
    try { process.kill(-pid, 0); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return true;
      // Darwin can report EPERM while only unreaped zombies remain in a group.
      // Keep waiting for ESRCH; a permission error alone never confirms exit.
      if (code !== "EPERM") return false;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}
export function requestOwnedJobStop(child: ChildProcessWithoutNullStreams): boolean {
  const control = groups.get(child)?.control;
  if (!control || child.exitCode !== null || child.signalCode !== null) return false;
  if (control.writableEnded) return true;
  if (control.destroyed) return false;
  control.end(process.platform === "darwin" ? "S\n" : "S");
  return true;
}

export async function ownedWindowsExitEvidence(child: ChildProcessWithoutNullStreams): Promise<JobEvidence | undefined> {
  if (child.exitCode === null && child.signalCode === null) return;
  return groups.get(child)?.evidence;
}

/** Check the group owned by this handle, including descendants of an exited root. */
export async function confirmOwnedExit(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  const group = groups.get(child);
  if (!group || !child.pid || (child.exitCode === null && child.signalCode === null)) return false;
  if (process.platform === "win32") return !group.evidence || !!await ownedWindowsExitEvidence(child);
  if (process.platform === "darwin") return group.darwin?.evidence ?? false;
  const cleanup = group.cleanup ??= stopProcessGroup(child.pid);
  const confirmed = await cleanup;
  if (!confirmed && group.cleanup === cleanup) group.cleanup = undefined;
  return confirmed;
}
function windowsBridge(): Promise<string> {
  return bridge ??= (async () => {
    const digest = createHash("sha256").update(windowsSource).digest("hex");
    const directory = path.join(supervisorRoot(), digest);
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

async function supervisorExecutable(): Promise<string> {
  let executable = await windowsBridge();
  if (existsSync(executable)) return executable;
  // A cached helper can disappear after temporary-directory or security cleanup.
  bridge = undefined;
  return windowsBridge();
}

export async function spawnOwned(command: string, args: string[], options: SpawnOptionsWithoutStdio,
    verifyWindowsJob: boolean | { beforeStart: (child: ChildProcessWithoutNullStreams) => void;
      onDenied?: (child: ChildProcessWithoutNullStreams, evidence: JobEvidence | undefined) => void } = false): Promise<ChildProcessWithoutNullStreams> {
  if (process.platform === "win32") {
    const executable = await supervisorExecutable();
    const cwd = typeof options.cwd === "string" && path.isAbsolute(options.cwd) && options.cwd.length >= 248
      ? path.toNamespacedPath(options.cwd) : options.cwd;
    const child = spawn(executable, [verifyWindowsJob ? "run-verified" : "run", String(process.pid), command, ...args], {
      ...options, cwd, windowsHide: true, stdio: verifyWindowsJob ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : "pipe",
    }) as ChildProcessWithoutNullStreams;
    const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); });
    child.once("error", () => { bridge = undefined; });
    let pipeFailure: Error | undefined;
    const watchPipe = (pipe: NodeJS.ReadableStream | NodeJS.WritableStream) => pipe.on("error", (error: Error) => {
      if (pipeFailure) return;
      pipeFailure = error;
      // A broken protocol pipe may leave the target running. Keep recovery within its owned Job.
      if (child.exitCode === null && child.signalCode === null && !requestOwnedJobStop(child)) child.kill();
    });
    for (const pipe of [child.stdin, child.stdout, child.stderr]) watchPipe(pipe);
    if (!verifyWindowsJob) {
      groups.set(child, {});
      await once(child, "spawn");
      if (pipeFailure) { await closed; throw pipeFailure; }
      return child;
    }
    const control = child.stdio[3] as Duplex;
    const proof = child.stdio[4] as Duplex;
    watchPipe(control);
    const evidence = new Promise<JobEvidence | undefined>(resolve => {
      let receipt = "", invalid = false;
      proof.on("data", data => {
        if (invalid || receipt.length + data.length > 1) { invalid = true; return; }
        receipt += data.toString("ascii");
      });
      const finish = () => resolve(!invalid && receipt === "E" ? "windows-job-empty" :
        !invalid && receipt === "N" ? "windows-job-not-started" : undefined);
      proof.once("end", finish);
      proof.once("close", finish);
      proof.once("error", () => resolve(undefined));
    });
    groups.set(child, { control, evidence });
    await once(child, "spawn");
    try {
      if (pipeFailure) throw pipeFailure;
      if (typeof verifyWindowsJob === "object") verifyWindowsJob.beforeStart(child);
      if (pipeFailure) throw pipeFailure;
      control.write("G");
    } catch (error) {
      if (!control.writableEnded) control.end();
      child.stdout.resume(); child.stderr.resume();
      await closed;
      if (typeof verifyWindowsJob === "object") verifyWindowsJob.onDenied?.(child, await evidence);
      throw error;
    }
    return child;
  }
  if (process.platform === "darwin") return spawnDarwinOwned(command, args, options, owned => {
    const { child, control } = owned;
    groups.set(child, { darwin: owned, control });
    const pid = child.pid;
    if (pid) {
      darwinByPid.set(pid, owned);
      child.once("close", () => { if (darwinByPid.get(pid) === owned) darwinByPid.delete(pid); });
    }
  });
  const child = spawn(command, args, { ...options, detached: true, stdio: "pipe" });
  const group: { cleanup?: Promise<boolean> } = {};
  groups.set(child, group);
  child.once("exit", () => { if (child.pid) group.cleanup ??= stopProcessGroup(child.pid); });
  await once(child, "spawn");
  return child;
}

export interface ProcessSample {
  totalPhysical: number; availablePhysical: number; availableCommit?: number; totalCommit?: number;
  systemProcessCount?: number; cpuCores?: number; cpuBusyPercent?: number; cpuModel?: string;
  processCoverage?: "descendants" | "unavailable";
  memoryPressure?: "normal" | "warning" | "critical";
  supervision?: "native" | "degraded";
  swapTotalBytes?: number;
  swapUsedBytes?: number;
  processes: { pid: number; parentPid: number; identity: string; workingSet: number; privateBytes: number; cpuMilliseconds?: number }[];
}
export async function sampleWindowsProcesses(root: number): Promise<ProcessSample> {
  const executable = await supervisorExecutable();
  return new Promise((resolve, reject) => execFile(executable, ["sample", String(root)],
    { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error); else try { resolve(JSON.parse(stdout)); } catch(error) { reject(error); }
    }));
}
