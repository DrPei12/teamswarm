import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'darwin');
const product = path.resolve(process.argv[2] ?? '.');
const ownedModule = pathToFileURL(path.join(product, 'apps/server/dist/runtime/harness/owned-process.js')).href;
const darwinModule = pathToFileURL(path.join(product, 'apps/server/dist/runtime/harness/darwin-supervisor.js')).href;
const { darwinSupervisor, sampleDarwinProcesses, spawnDarwinOwned } = await import(darwinModule);
assert(await darwinSupervisor(), 'The packaging test requires the native macOS supervisor.');
const owns = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
const siblingExit = once(sibling, 'exit');
let owner;
let ownerExit;
try {
  const rootScript = `const {spawn}=require('node:child_process');
    const escaped=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    escaped.once('spawn',()=>{escaped.unref();console.log(JSON.stringify([process.pid,escaped.pid]));});setInterval(()=>{},1000);`;
  const ownerScript = `import {spawnOwned} from ${JSON.stringify(ownedModule)};
    const root=await spawnOwned(process.execPath,['-e',${JSON.stringify(rootScript)}],{});
    root.stdout.pipe(process.stdout);root.stderr.pipe(process.stderr);`;
  owner = spawn(process.execPath, ['--input-type=module', '-e', ownerScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  ownerExit = once(owner, 'exit');
  let output = '', stderr = '';
  owner.stdout.on('data', chunk => { output += chunk; });
  owner.stderr.on('data', chunk => { stderr += chunk; });
  for (let i = 0; !output.includes('\n') && i < 150 && owner.exitCode === null; ++i) await delay(50);
  assert(output.includes('\n'), stderr || 'The test root did not start its detached child.');
  const pids = JSON.parse(output.trim());
  assert.equal(pids.length, 2);
  assert(pids.every(pid => Number.isSafeInteger(pid) && pid > 1 && owns(pid)));
  const sample = await sampleDarwinProcesses(process.pid);
  assert.equal(sample.supervision, 'native');
  assert(sample.availablePhysical <= sample.totalPhysical);
  assert(sample.processes.some(group => group.pid === pids[1] && group.privateBytes > 0));

  owner.kill('SIGKILL');
  assert.deepEqual(await ownerExit, [null, 'SIGKILL']);
  for (let i = 0; pids.some(owns) && i < 150; ++i) await delay(50);
  assert(pids.every(pid => !owns(pid)), 'The supervisor did not reap every owned process after the service crashed.');
  assert(owns(sibling.pid), 'An unrelated process must survive the cleanup.');

  let fallback;
  const processHandle = await spawnDarwinOwned(process.execPath, ['-e', 'console.log("fallback");process.stdin.resume()'], {},
    value => { fallback = value; }, async () => undefined);
  let printed = '';
  processHandle.stdout.on('data', value => { printed += value; });
  processHandle.stderr.resume();
  try {
    for (let i = 0; !printed.includes('fallback') && i < 60; ++i) await delay(50);
    assert.match(printed, /fallback/);
  } finally { fallback.control.end('S\n'); }
  await fallback.exited;
  assert.equal(await fallback.evidence, false, 'Process-group-only fallback cannot confirm escape cleanup.');
  console.log(JSON.stringify({ passed: true, parentCrash: true, detachedChild: true, independentProcess: true, nativeSampling: true, noCompilerFallback: true }));
} finally {
  if (owner?.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
  if (ownerExit) await ownerExit;
  if (sibling.exitCode === null && sibling.signalCode === null) sibling.kill('SIGTERM');
  await siblingExit;
}
