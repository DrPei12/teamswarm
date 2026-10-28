import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { spawnOwned, sampleWindowsProcesses } from "../src/runtime/harness/owned-process.js";
import { terminateNative } from "../src/runtime/harness/native-support.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } };
async function expectGone(pid: number) { for(let i=0;i<100 && !gone(pid);i++) await sleep(20); assert.ok(gone(pid), `Owned PID ${pid} remains`); }

test("owned process preserves arguments, streams and exit status for 32 concurrent commands", {timeout:30000}, async () => {
  await Promise.all(Array.from({length:32},async (_,i) => {
    const value = `${i}: spaces 中文 ' \" trailing\\`;
    const child=await spawnOwned(process.execPath,["-e","let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify([process.argv[1],s]));process.stderr.write('error:'+process.argv[1]);process.exitCode=7})",value],{});
    let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);
    const close=new Promise(resolve=>child.once("close",resolve));child.stdin.end(`input:${i}`);
    assert.equal(await close,7);assert.deepEqual(JSON.parse(out),[value,`input:${i}`]);assert.equal(err,`error:${value}`);
  }));
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

test("Windows Job reclaims the execution when its owning service dies", {skip:process.platform!=="win32",timeout:15000}, async () => {
  const moduleUrl=new URL("../src/runtime/harness/owned-process.ts",import.meta.url).href;
  const parent=spawn(process.execPath,["--import","tsx","--input-type=module","-e",`import {spawnOwned} from ${JSON.stringify(moduleUrl)};const p=await spawnOwned(process.execPath,['-e',"console.log(process.pid);setInterval(()=>{},1000)"],{});p.stdout.pipe(process.stdout);p.stderr.pipe(process.stderr);`],{stdio:"pipe",windowsHide:true});
  let output="";parent.stdout.on("data",b=>output+=b);parent.stderr.on("data",()=>{});
  for(let i=0;i<200&&!output.includes("\n");i++)await sleep(20);
  const pid=Number(output.trim());assert.ok(pid>0);
  parent.kill();await expectGone(pid);
});

test("Windows memory sampling reports physical and private committed bytes separately",{skip:process.platform!=="win32"},async()=>{
  const sample=await sampleWindowsProcesses(process.pid);
  assert.ok(sample.totalPhysical>sample.availablePhysical);assert.ok(sample.availableCommit!>0);
  assert.ok(sample.totalCommit!>=sample.availableCommit!);assert.ok(sample.systemProcessCount!>=sample.processes.length);
  const own=sample.processes.find(p=>p.pid===process.pid)!;
  assert.ok(own.workingSet>0);assert.ok(own.privateBytes>0);assert.match(own.identity,/^windows:/);
  assert.ok(own.cpuMilliseconds!>=0);
});
