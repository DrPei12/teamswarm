import assert from "node:assert/strict";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { NativeHarness } from "../src/runtime/harness/native.js";
import { spawnOwned } from "../src/runtime/harness/owned-process.js";
import { RetainedProcess } from "../src/runtime/harness/retained-process.js";
import type { HarnessEvent, HarnessResult } from "../src/runtime/types.js";

const workerProgram = `
const { spawn } = require('node:child_process');
console.log('ready');
process.stdin.on('data', bytes => {
  if (String(bytes).trim() !== 'run') return;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  console.log(child.pid);
});
`;

async function setup(t: TestContext) {
  const child = await spawnOwned(process.execPath, ["-e", workerProgram], {}, true);
  const events: HarnessEvent[] = [];
  const resource = new RetainedProcess(child, undefined, "test", event => events.push(event));
  t.after(async () => { await resource.close("test_cleanup", true); });
  const [line] = await once(resource.lines, "line", { signal: AbortSignal.timeout(5000) });
  assert.equal(line, "ready");
  return { child, resource, events };
}

function running(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("Win32 retained-turn audit retires its whole Job without touching a sibling Job", { skip: process.platform !== "win32", timeout: 26000 }, async t => {
  const first = await setup(t);
  const sibling = await setup(t);
  const before = await first.resource.sampleTurnProcesses();
  assert(before);
  assert.equal(await first.resource.auditTurnEnd(before), "clear", JSON.stringify({ before, after: await first.resource.sampleTurnProcesses() }));
  const marker = once(first.resource.lines, "line", { signal: AbortSignal.timeout(5000) });
  first.child.stdin.write("run\n");
  const [pidText] = await marker;
  const pid = Number(pidText);
  assert(Number.isInteger(pid) && pid > 0 && running(pid));
  assert.equal(await first.resource.auditTurnEnd(before), "residual");
  const gone = first.resource.close("turn_residual_process", true);
  assert.equal(first.resource.available, false);
  assert.equal(await gone, true);
  assert.deepEqual(first.events.map(event => [event.type, event.data.reason, event.data.exitEvidence]), [
    ["resource.released", "turn_residual_process", "windows-job-empty"],
  ]);
  assert.equal(running(pid), false);
  assert.equal(sibling.resource.available, true);
  assert.deepEqual(sibling.events, []);
});

test("native pool size, TTL and pressure affect only unclaimed idle workers", { skip: process.platform !== "win32", timeout: 25000 }, async t => {
  const oldest = await setup(t);
  const next = await setup(t);
  const inUse = await setup(t);
  const separateService = await setup(t);
  const harness = new NativeHarness("claude-code");
  const state = harness as unknown as {
    retained: Map<string, RetainedProcess>;
    executions: Map<string, Promise<HarnessResult>>;
  };
  const now = Date.now();
  oldest.resource.idleSince = now - 10000;
  next.resource.idleSince = now - 5000;
  inUse.resource.idleSince = now - 11000;
  state.retained.set("oldest", oldest.resource);
  state.retained.set("next", next.resource);
  state.retained.set("active", inUse.resource);
  state.executions.set("active", Promise.resolve({ status: "completed", text: "" }));
  t.after(async () => { state.executions.clear(); await harness.close(); });

  await harness.maintain({ now, pressure: false, warmIdleMs: 120000, maxWarmProcesses: 1 });
  assert.equal(oldest.events[0]?.data.reason, "idle_pool_limit");
  assert.equal(next.resource.available, true);
  assert.equal(inUse.resource.available, true);
  await harness.maintain({ now: now + 20000, pressure: false, warmIdleMs: 30000 });
  assert.equal(next.resource.available, true);
  await harness.maintain({ now: now + 26000, pressure: false, warmIdleMs: 30000 });
  assert.equal(next.events[0]?.data.reason, "idle_timeout");
  await harness.maintain({ now, pressure: true });
  assert.equal(inUse.resource.available, true);
  assert.equal(separateService.resource.available, true);
  state.executions.delete("active");
  await harness.maintain({ now, pressure: true });
  assert.equal(inUse.events[0]?.data.reason, "memory_pressure");
  assert.equal(separateService.resource.available, true);
});
