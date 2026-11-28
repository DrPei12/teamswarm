import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnOwned, confirmOwnedExit, ownedWindowsExitEvidence, requestOwnedJobStop, sampleWindowsProcesses, stopProcessGroup } from "../src/runtime/harness/owned-process.js";
import { terminateNative } from "../src/runtime/harness/native-support.js";
import { RetainedProcess } from "../src/runtime/harness/retained-process.js";
import { darwinPressure, parseDarwinVmStat } from "../src/runtime/harness/darwin-supervisor.js";
import { processStartedAfterFile } from "../src/runtime/process-identity.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } };
async function expectGone(pid: number) { for(let i=0;i<100 && !gone(pid);i++) await sleep(20); assert.ok(gone(pid), `Owned PID ${pid} remains`); }

test("POSIX spawn failures reject instead of emitting an unhandled service error", {skip:process.platform==="win32"}, async () => {
  await assert.rejects(spawnOwned(path.join(tmpdir(),randomUUID()),[],{}),{code:'ENOENT'});
  await assert.rejects(spawnOwned(tmpdir(),[],{}),{code:'EACCES'});
});

test("owned process preserves arguments, streams and exit status for 32 concurrent commands", {timeout:30000}, async () => {
  await Promise.all(Array.from({length:32},async (_,i) => {
    const value = `${i}: spaces 中文 ' \" trailing\\`;
    const child=await spawnOwned(process.execPath,["-e","let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify([process.argv[1],s]));process.stderr.write('error:'+process.argv[1]);process.exitCode=7})",value],{});
    let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);
    const close=new Promise(resolve=>child.once("close",resolve));child.stdin.end(`input:${i}`);
    assert.equal(await close,7);assert.deepEqual(JSON.parse(out),[value,`input:${i}`]);assert.equal(err,`error:${value}`);
  }));
});

test("a reused retained process settles to its current owner after an initially uncertain exit", async () => {
  const child = await spawnOwned(process.execPath, ["-e", "process.stdin.resume()"], {});
  const events: Array<{ owner: string; type: string }> = [];
  let confirmations = 0;
  const worker = new RetainedProcess(child, undefined, "binding", event => events.push({ owner: "first", type: event.type }),
    async owned => ++confirmations > 1 && await confirmOwnedExit(owned));
  worker.observeFromAttempt(event => events.push({ owner: "current", type: event.type }));
  assert.equal(await worker.close("workflow_complete"), false);
  assert.equal(await worker.reconcileExit(), true);
  assert.equal(await worker.reconcileExit(), true);
  assert.deepEqual(events, [
    { owner: "current", type: "resource.unconfirmed" },
    { owner: "current", type: "resource.released" },
  ]);
});

for(const mode of ["exit","cancel"] as const) test(`Windows Job reclaims detached descendants on root ${mode}`, {skip:process.platform!=="win32",timeout:15000}, async () => {
  const script=`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});c.unref();console.log(c.pid);${mode==="exit"?"setTimeout(()=>process.exit(0),100)":"setInterval(()=>{},1000)"}`;
  const child=await spawnOwned(process.execPath,["-e",script],{});
  let output=""; const close=new Promise(resolve=>child.once("close",resolve));
  child.stdout.on("data",b=>output+=b);child.stderr.on("data",()=>{});
  for(let i=0;i<100 && !output.includes("\n");i++)await sleep(20);
  const pid=Number(output.trim());assert.ok(pid>0);
  if(mode==="cancel")assert.equal(await terminateNative(child),true);
  await close;await expectGone(pid);
});

test("Windows verifies that an explicitly stopped Job is empty without stopping a sibling Job", {skip:process.platform!=="win32", timeout:20000}, async () => {
  const script = `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});child.unref();console.log(child.pid);setInterval(()=>{},1000);`;
  const roots = await Promise.all([1,2].map(async () => {
    const processHandle = await spawnOwned(process.execPath,["-e",script],{},true);
    let marker = "";
    processHandle.stdout.on("data", value => { marker += value; });
    processHandle.stderr.resume();
    const exited = new Promise(resolve => processHandle.once("close", resolve));
    return { processHandle, exited, marker: () => marker };
  }));
  try {
    for (let tries=0; roots.some(root=>!root.marker().includes("\n")) && tries<200; tries++) await sleep(20);
    const descendants = roots.map(root=>Number(root.marker().trim()));
    assert(descendants.every(pid=>Number.isSafeInteger(pid)&&pid>0&&!gone(pid)));
    assert(requestOwnedJobStop(roots[0].processHandle));
    await roots[0].exited;
    assert.equal(await confirmOwnedExit(roots[0].processHandle),true);
    assert(gone(descendants[0]));
    assert(!gone(descendants[1]));
    assert(requestOwnedJobStop(roots[1].processHandle));
    await roots[1].exited;
    assert.equal(await confirmOwnedExit(roots[1].processHandle),true);
    assert(gone(descendants[1]));
  } finally {
    for (const root of roots) if (root.processHandle.exitCode===null && root.processHandle.signalCode===null) {
      if (!requestOwnedJobStop(root.processHandle)) root.processHandle.kill();
      await root.exited;
    }
  }
});

test("Windows Job startup is withheld if its ownership cannot be recorded", {skip:process.platform!=="win32",timeout:15000}, async () => {
  const marker = path.join(tmpdir(),"teamswarm-never-start-"+randomUUID());
  let child: Awaited<ReturnType<typeof spawnOwned>> | undefined;
  await assert.rejects(spawnOwned(process.execPath,["-e",`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],{}, {
    beforeStart: process => { child = process; throw new Error("No startup journal"); },
  }), /No startup journal/);
  assert(child);
  assert(!existsSync(marker));
  assert.equal(await ownedWindowsExitEvidence(child),"windows-job-not-started");
});

test("Windows pipe failure before the startup grant rejects only that owned process", {skip:process.platform!=="win32",timeout:15000}, async () => {
  const marker = path.join(tmpdir(),"teamswarm-broken-pipe-"+randomUUID());
  let child: Awaited<ReturnType<typeof spawnOwned>> | undefined;
  const fault = Object.assign(new Error("read ENOTCONN"), { code:"ENOTCONN" });
  await assert.rejects(spawnOwned(process.execPath,["-e",`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],{}, {
    beforeStart: process => { child = process; process.stdout.emit("error",fault); },
  }), {code:"ENOTCONN"});
  assert(child);
  assert(!existsSync(marker));
  assert.equal(await ownedWindowsExitEvidence(child),"windows-job-not-started");
});

test("Windows launches an owned process in a deeply nested working copy", {skip:process.platform!=="win32",timeout:15000}, async () => {
  const root=mkdtempSync(path.join(tmpdir(),"teamswarm-long-cwd-"));
  const cwd=path.join(root,...Array.from({length:12},(_,i)=>`working-copy-${i}-nested`));
  try {
    assert.ok(cwd.length>260);
    mkdirSync(cwd,{recursive:true});
    writeFileSync(path.join(cwd,"fixture.txt"),"expected working copy");
    const child=await spawnOwned(process.execPath,["-e","console.log(require('node:fs').readFileSync('fixture.txt','utf8'))"],{cwd},true);
    let output="", errors="";
    child.stdout.on("data",b=>output+=b);child.stderr.on("data",b=>errors+=b);
    const [code]=await once(child,"close");
    assert.equal(code,0,errors);assert.equal(output.trim(),"expected working copy");
    assert.equal(await ownedWindowsExitEvidence(child),"windows-job-empty");
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("Windows distinguishes failure to create a target from an empty executed Job", {skip:process.platform!=="win32",timeout:15000}, async () => {
  const child = await spawnOwned(path.join(tmpdir(),randomUUID()+".exe"),[],{},true);
  child.stdout.resume();child.stderr.resume();
  await new Promise(resolve => child.once("close",resolve));
  assert.equal(await ownedWindowsExitEvidence(child),"windows-job-not-started");
  assert.equal(await confirmOwnedExit(child),true);
});

for(const mode of ["exit","cancel"] as const) test(`POSIX group reclaims descendants on root ${mode}`, {skip:process.platform==="win32",timeout:15000}, async () => {
  const script=`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.unref();console.log(c.pid);${mode==="exit"?"setTimeout(()=>process.exit(0),100)":"setInterval(()=>{},1000)"}`;
  const child=await spawnOwned(process.execPath,["-e",script],{});
  let output=""; child.stdout.on("data",b=>output+=b); child.stderr.resume();
  const closed=new Promise(resolve=>child.once("close",resolve));
  try {
    for(let i=0;i<100 && !output.includes("\n");i++)await sleep(20);
    const pid=Number(output.trim());assert.ok(pid>0);
    const stopped=mode==="cancel" ? await terminateNative(child) : (await closed,await confirmOwnedExit(child));
    const processes=spawnSync('ps',['-axo','pid,ppid,pgid,state'],{encoding:'utf8'}).stdout.split('\n').filter(line=>Number(line.trim().split(/\s+/)[2])===child.pid);
    assert.equal(stopped,true,JSON.stringify({root:child.pid,exitCode:child.exitCode,signalCode:child.signalCode,processes}));
    await closed; await expectGone(pid);
  } finally {
    if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}
    child.stdin.destroy();
  }
});

test("Linux group exit confirmation waits through a transient permission response", {skip:process.platform!=="linux",timeout:15000}, async () => {
  const child=await spawnOwned(process.execPath,["-e","console.log('ready');setInterval(()=>{},1000)"],{});
  let ready=false; child.stdout.on('data',()=>{ready=true;}); child.stderr.resume();
  const closed=new Promise(resolve=>child.once('close',resolve));
  const send=process.kill;
  let transient=false;
  try {
    for(let i=0;i<100&&!ready;i++)await sleep(20);
    assert(ready); assert(child.pid);
    process.kill=((pid,signal)=>{
      if(pid===-child.pid!&&signal===0&&!transient){transient=true;throw Object.assign(new Error('Transient group state'),{code:'EPERM'});}
      return send(pid,signal);
    }) as typeof process.kill;
    assert.equal(await stopProcessGroup(child.pid),true);
    assert.equal(transient,true);
    await closed;
  } finally {
    process.kill=send;
    if(child.pid)try{send(-child.pid,'SIGKILL');}catch{}
    child.stdin.destroy();
  }
});

test("Windows Job reclaims the execution when its owning service dies", {skip:process.platform!=="win32",timeout:15000}, async () => {
  const moduleUrl=new URL("../src/runtime/harness/owned-process.ts",import.meta.url).href;
  const parent=spawn(process.execPath,["--import","tsx","--input-type=module","-e",`import {spawnOwned} from ${JSON.stringify(moduleUrl)};const p=await spawnOwned(process.execPath,['-e',"console.log(process.pid);setInterval(()=>{},1000)"],{});p.stdout.pipe(process.stdout);p.stderr.pipe(process.stderr);`],{stdio:"pipe",windowsHide:true});
  let output="";parent.stdout.on("data",b=>output+=b);parent.stderr.on("data",()=>{});
  for(let i=0;i<200&&!output.includes("\n");i++)await sleep(20);
  const pid=Number(output.trim());assert.ok(pid>0);
  parent.kill();await expectGone(pid);
});

test("macOS memory parsing counts reclaimable queues without double-counting subset pages", () => {
  const sample = `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 300.\nPages speculative: 40.\nPages purgeable: 120.`;
  assert.equal(parseDarwinVmStat(sample, 16 * 1024 ** 3), 400 * 16384);
  assert.equal(parseDarwinVmStat(sample, 1024), 1024);
  assert.equal(parseDarwinVmStat('missing pages', 1024), undefined);
  assert.deepEqual([1, 2, 4, 99].map(darwinPressure), ['normal', 'warning', 'critical', undefined]);
});

test("macOS and Windows reject malformed or non-newer process identities", () => {
  const when = Date.parse("2025-06-18T09:10:11.000Z");
  const darwin = `darwin:${when / 1000}.500000`;
  assert.equal(processStartedAfterFile(darwin, when - 2000), true);
  assert.equal(processStartedAfterFile(darwin, when - 500), false);
  assert.equal(processStartedAfterFile("darwin:??", when), false);
  assert.equal(processStartedAfterFile("windows:invalid", when), false);
  const local = new Date(2025, 5, 18, 9, 10, 11).getTime();
  assert.equal(processStartedAfterFile("darwin:{ sec = 1, usec = 0 } :Wed Jun 18 09:10:11 2025", local - 2000), true);
});

test("Windows memory sampling reports physical and private committed bytes separately",{skip:process.platform!=="win32"},async()=>{
  const sample=await sampleWindowsProcesses(process.pid);
  assert.ok(sample.totalPhysical>sample.availablePhysical);assert.ok(sample.availableCommit!>0);
  assert.ok(sample.totalCommit!>=sample.availableCommit!);assert.ok(sample.systemProcessCount!>=sample.processes.length);
  const own=sample.processes.find(p=>p.pid===process.pid)!;
  assert.ok(own.workingSet>0);assert.ok(own.privateBytes>0);assert.match(own.identity,/^windows:/);
  assert.ok(own.cpuMilliseconds!>=0);
});
