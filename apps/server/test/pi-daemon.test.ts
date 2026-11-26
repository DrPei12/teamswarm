import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PiDaemon } from "../src/runtime/harness/pi-daemon.js";
import { spawnOwned } from "../src/runtime/harness/owned-process.js";

test("an unconfirmed Pi exit is never warm and reconciliation releases the same owner exactly once", async () => {
  const child = await spawnOwned(process.execPath, ["-e", "process.stdin.resume()"], { windowsHide: true });
  let checks = 0;
  const receipts: { type: string; id: unknown }[] = [];
  const daemon = new PiDaemon(child, "runtime-a", () => assert.fail("stale attempt received exit"), async () => ++checks > 1);
  daemon.observeFromAttempt(e => receipts.push({ type:e.type, id:e.data.id }));
  assert.equal(await daemon.close(), false);
  assert.equal(daemon.available, false);
  assert.throws(() => daemon.run("late", {}, "", () => {}), /unavailable/);
  assert.equal(await daemon.close(), true);
  assert.equal(await daemon.reconcileExit(), true);
  assert.deepEqual(receipts, ["resource.unconfirmed", "resource.released"].map(type => ({ type, id:daemon.id })));
});

test(
  "Pi process routes interleaved events and cancellation by exact turn",
  { timeout: 15000 },
  async () => {
    const fixture = `
    import { createInterface } from 'node:readline';
    const pending = new Set();
    const send = (turnId,event) => console.log(JSON.stringify({turnId,event}));
    createInterface({input:process.stdin}).on('line',line => {
      const {type,turnId,spec} = JSON.parse(line);
      if (type === 'run') {
        pending.add(turnId);
        send(turnId,{type:'session',id:spec.name});
        if (!spec.wait) setTimeout(() => {
          if (pending.delete(turnId)) send(turnId,{type:'result',status:'completed',text:spec.name});
        },50);
      } else if (type === 'abort' && pending.delete(turnId)) {
        send(turnId,{type:'result',status:'interrupted',text:''});
        send(turnId,{type:'session',id:'late result'});
      }
    });
  `;
    const child = await spawnOwned(
      process.execPath,
      ["--input-type=module", "-e", fixture],
      { windowsHide: true },
    );
    const resources: string[] = [];
    const daemon = new PiDaemon(child, "fixture", (event) =>
      resources.push(event.type),
    );
    const first = randomUUID(),
      second = randomUUID();
    const a: string[] = [],
      b: string[] = [];
    let listening!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      listening = resolve;
    });
    try {
      const running = daemon.run(
        first,
        { name: "first workspace", wait: true },
        "fixture-route-a",
        (event) => {
          a.push(event.id);
          listening();
        },
      );
      const independent = daemon.run(
        second,
        { name: "second workspace" },
        "fixture-route-b",
        (event) => b.push(event.id),
      );
      await dispatched;
      daemon.abort(first);
      assert.equal((await running).status, "interrupted");
      assert.deepEqual(await independent, {
        status: "completed",
        text: "second workspace",
        error: undefined,
      });
      assert.deepEqual(a, ["first workspace"]);
      assert.deepEqual(b, ["second workspace"]);
      assert(daemon.available);
    } finally {
      assert.equal(await daemon.close(), true);
    }
    assert.deepEqual(resources, ["resource.released"]);
  },
);
