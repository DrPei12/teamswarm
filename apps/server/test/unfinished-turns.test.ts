import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { codexPermissionOptions } from "../src/runtime/permission-options.js";
import type { Harness, Work } from "../src/runtime/types.js";

type Unfinished = {
  attemptId: string;
  request: string;
  status: string;
  cause?: string;
  lastText?: string;
  commands: { total: number; unsuccessful: number; recent: { command: string; status: string; exitCode?: number }[] };
  changedFiles?: string[];
};

/** Works through a script; a stopped turn first reports the commands and file it reached. */
function scriptedHarness(script: ("stopped" | "completed")[], inputs: Record<string, unknown>[]): Harness {
  return {
    id: "codex", capabilities: { resume: true, fixture: true }, permissionOptions: () => codexPermissionOptions,
    inspect: async () => ({ available: true }), validateConfig() {},
    async execute(r) {
      const step = script[inputs.length];
      inputs.push(JSON.parse(r.input));
      r.onSession(r.sessionId ?? randomUUID());
      r.onTurn(randomUUID());
      if (step === "completed") return { status: "completed", text: "Done." };
      for (let i = 1; i <= 8; i++)
        r.onEvent({ type: "transcript.item", data: { id: `cmd-${i}`, kind: "command", text: `fixture-step ${i}`, status: i === 8 ? "failed" : "completed", exitCode: i === 8 ? 2 : 0 } });
      r.onEvent({ type: "transcript.item", data: { id: "file-1", kind: "file", text: "", status: "completed", changes: [{ path: "notes/fixture.md", kind: "add" }] } });
      return { status: "failed", text: "Reached step 8 of the fixture plan.", error: "Execution reached its configured time limit." };
    },
    async interrupt() {},
    async close() {},
  };
}

test("the next Host turn receives the recorded facts of turns that stopped without replying", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-unfinished-turns-"));
  const inputs: Record<string, unknown>[] = [];
  const service = createApp({
    dataDir: path.join(root, "data"),
    harnesses: [scriptedHarness(["stopped", "completed", "completed"], inputs)],
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const team = (await (await fetch(`http://127.0.0.1:${port}/api/product/teams`, {
      method: "POST",
      headers: { authorization: `Bearer ${service.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Unfinished turns", clientRequestId: randomUUID() }),
    })).json()) as { id: string; mainChatId: string };
    const store = service.runtime.store;
    const turn = async (text: string) => {
      let work!: Work;
      service.store.recordMessage(team.id, team.mainChatId, text, randomUUID(), (message) => {
        work = store.enqueueHost(team.id, team.mainChatId, message.id, true);
      });
      for (let i = 0; i < 400; i++) {
        const current = store.get<Work>("works", team.id, work.id);
        if (!["queued", "waiting", "running", "stopping"].includes(current.status)) return current;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Fixture turn did not finish");
    };

    const stopped = await turn("Synthetic request: run the fixture plan");
    assert.equal(stopped.status, "failed");
    assert.equal(inputs[0].unfinishedTurns, undefined, "a first turn has nothing to carry");

    await turn("Synthetic request: continue");
    const carried = inputs[1].unfinishedTurns as Unfinished[];
    assert.equal(carried.length, 1);
    assert.equal(carried[0].attemptId, stopped.attemptId);
    assert.equal(carried[0].request, "Synthetic request: run the fixture plan");
    assert.equal(carried[0].status, "failed");
    assert.equal(carried[0].cause, "Execution reached its configured time limit.");
    assert.equal(carried[0].lastText, "Reached step 8 of the fixture plan.");
    assert.equal(carried[0].commands.total, 8);
    assert.equal(carried[0].commands.unsuccessful, 1);
    assert.equal(carried[0].commands.recent.length, 6, "only the most recent commands are carried");
    assert.deepEqual(carried[0].commands.recent.at(-1), { command: "fixture-step 8", status: "failed", exitCode: 2 });
    assert.deepEqual(carried[0].changedFiles, ["notes/fixture.md"]);
    assert.equal(typeof inputs[1].unfinishedTurnsNote, "string");

    await turn("Synthetic request: anything else");
    assert.equal(inputs[2].unfinishedTurns, undefined, "a delivered reply closes the earlier stopped turns");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
});
