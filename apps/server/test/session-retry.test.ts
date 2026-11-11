import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { codexPermissionOptions } from "../src/runtime/permission-options.js";
import { NativeHarness } from "../src/runtime/harness/native.js";
import type { Attempt, Harness, HarnessRequest, Work } from "../src/runtime/types.js";

type Turn = { resumed: string | undefined; session: string };

/** Commits its identity before "starting", like the native adapters, then follows a script. */
function scriptedHarness(script: ("never-started" | "completed" | "resume-rejected")[], turns: Turn[]): Harness {
  return {
    id: "codex", capabilities: { resume: true, fixture: true }, permissionOptions: () => codexPermissionOptions,
    inspect: async () => ({ available: true }), validateConfig() {},
    async execute(r) {
      const step = script[turns.length];
      const session = r.sessionId ?? randomUUID();
      turns.push({ resumed: r.sessionId, session });
      r.onSession(session, { nativeSession: r.sessionId ? "inherited" : "unconfirmed" });
      r.onTurn(randomUUID());
      if (step === "never-started") return { status: "failed", text: "", error: "spawn helper ENOENT" };
      if (step === "resume-rejected") {
        r.onEvent({ type: "session.native_unavailable", data: {} });
        return { status: "failed", text: "", error: "No conversation found with session ID" };
      }
      r.onEvent({ type: "session.native", data: { nativeSessionId: session } });
      return { status: "completed", text: "Done." };
    },
    async interrupt() {},
    async close() {},
  };
}

test("a retry starts a new native session when the previous one was never established or no longer loads", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-session-retry-"));
  const turns: Turn[] = [];
  const service = createApp({
    dataDir: path.join(root, "data"),
    harnesses: [scriptedHarness(["never-started", "completed", "completed", "resume-rejected", "completed"], turns)],
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const team = (await (await fetch(`http://127.0.0.1:${port}/api/product/teams`, {
      method: "POST",
      headers: { authorization: `Bearer ${service.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Session retry", clientRequestId: randomUUID() }),
    })).json()) as { id: string; mainChatId: string };
    const store = service.runtime.store;
    const turn = async () => {
      let work!: Work;
      service.store.recordMessage(team.id, team.mainChatId, `Synthetic request ${turns.length + 1}`, randomUUID(), (message) => {
        work = store.enqueueHost(team.id, team.mainChatId, message.id, true);
      });
      for (let i = 0; i < 400; i++) {
        const current = store.get<Work>("works", team.id, work.id);
        if (!["queued", "waiting", "running", "stopping"].includes(current.status))
          return store.list<Attempt>("attempts", team.id).filter((a) => a.workId === work.id).at(-1)!;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Fixture turn did not finish");
    };
    const rebuilt = () =>
      store.events(team.id, 0, 5000).filter((e) => e.type === "session.context_rebuilt" &&
        (e.data as { reason?: string }).reason === "native_session_not_established").length;

    const failed = await turn();
    assert.equal(failed.nativeSession, "unconfirmed");
    assert.ok(failed.sessionId, "the identity is still recorded for diagnosis");

    const fresh = await turn();
    assert.equal(turns[1].resumed, undefined, "an identity the Harness never held is not resumed");
    assert.notEqual(fresh.sessionId, failed.sessionId);
    assert.equal(fresh.nativeSession, "confirmed");
    assert.equal(rebuilt(), 1);

    const resumed = await turn();
    assert.equal(turns[2].resumed, fresh.sessionId, "an established session is still resumed");
    assert.equal(resumed.nativeSession, "confirmed");

    const rejected = await turn();
    assert.equal(turns[3].resumed, fresh.sessionId);
    assert.equal(rejected.nativeSession, "lost");

    await turn();
    assert.equal(turns[4].resumed, undefined, "a session the Harness could not load is not offered again");
    assert.equal(rebuilt(), 2);
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude Code reports whether its session exists: evidence on start, unavailable on a rejected resume", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-session-claude-"));
  const entry = path.join(root, "fixture.js");
  writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
  const keys = ["TEAM_CLAUDE_CODE_BIN", "TEAM_HARNESS_HOME", "TEST_SESSION_KEY"];
  const previous = keys.map((k) => process.env[k]);
  process.env.TEAM_CLAUDE_CODE_BIN = entry; process.env.TEAM_HARNESS_HOME = root; process.env.TEST_SESSION_KEY = "fixture";
  writeFileSync(entry, `
const args=process.argv; const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
if(args.includes('--resume')){process.stderr.write('No conversation found with session ID: '+args[args.indexOf('--resume')+1]+'\\n');process.exit(1);}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 if(JSON.parse(line).type==='user'){send({type:'system',subtype:'init',session_id:args[args.indexOf('--session-id')+1],model:'fixture'});send({type:'result',is_error:false,result:'Started'});process.exit(0);}
});`);
  const harness = new NativeHarness("claude-code");
  try {
    const run = async (sessionId?: string) => {
      const events: string[] = []; let bound = "", state: unknown;
      const request: HarnessRequest = {
        workspace: root, config: { harness: "claude-code", model: "fixture", provider: "fixture", baseUrl: "https://fixture.invalid", credentialEnv: "TEST_SESSION_KEY", effort: null, access: "read-only" },
        instructions: "Isolated fixture", input: "Isolated fixture", tools: [], ...(sessionId ? { sessionId } : {}),
        onSession(id, actual) { bound = id; state = actual.nativeSession; }, onTurn() {}, onEvent(e) { events.push(e.type); }, onTool: async () => ({}),
      };
      const result = await harness.execute(request);
      return { result, events, bound, state };
    };
    const started = await run();
    assert.equal(started.result.status, "completed", JSON.stringify(started.result));
    assert.equal(started.state, "unconfirmed");
    assert.ok(started.events.includes("session.native"));
    assert.ok(!started.events.includes("session.native_unavailable"));

    const rejected = await run(started.bound);
    assert.notEqual(rejected.result.status, "completed");
    assert.match(rejected.result.error ?? "", /No conversation found/);
    assert.equal(rejected.state, "inherited");
    assert.ok(rejected.events.includes("session.native_unavailable"));
    assert.ok(!rejected.events.includes("session.native"));
  } finally {
    await harness.close(); keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
