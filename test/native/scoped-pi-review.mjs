import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeScopedReview } from "../../apps/server/src/runtime/harness/scoped-review-execution.ts";

assert.equal(process.platform, "win32");
const fixture = mkdtempSync(path.join(tmpdir(), "teamswarm-scoped-pi-review-"));
const workspace = path.join(fixture, "candidate");
mkdirSync(workspace);
const inputFile = path.join(workspace, "candidate.txt");
writeFileSync(inputFile, "Frozen candidate version.");
const rootId = randomUUID(), rootTurn = randomUUID();
const tool = name => ({ name, description: name, inputSchema: { type: "object" } });
const parent = { sessionId: rootId, threadId: rootId, turnId: rootTurn };
const child = { ...parent, threadId: randomUUID(), parentThreadId: rootId };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const trace = [];

async function run(harnessId, cancel) {
  const pi = harnessId === "pi";
  const scratch = path.join(fixture, harnessId + (cancel ? "-stopped" : "-passed"));
  const events = [], records = [];
  const controlled = new AbortController();
  let live = true;
  let rebuilds = 0, callbackReads = 0, checks = 0;
  let pending;
  const input = {
    config: { harness: harnessId, model: "deepseek-flash", provider: "DeepSeek", protocol: "chat-completions",
      baseUrl: "https://api.deepseek.com", credentialEnv: "TEAMSWARM_TEST_DEEPSEEK", access: "read-only", nativeReadProbes: true,
      permissions: pi ? { harness: "pi", tools: ["read", "grep", "powershell"] } : { harness: "claude-code", mode: "dontAsk" },
      ...(pi ? { maxOutputTokens: 1234 } : {}) },
    instructions: "Check the frozen candidate.",
    input: "Stale continuation.",
    workspace,
    verificationDirectory: scratch,
    isolatedWorkspace: true,
    executionRequirements: { nativeCommands: true },
    sessionId: "old-session",
    onContextRebuild() { rebuilds++; return "Current candidate context"; },
    assertReadProbeCurrent() { assert.fail("Native child probes must be disabled for the scoped review."); },
    tools: ["team_read_file", "team_accept_work", "team_review_evidence", "team_write_file", "team_pi_probe"].map(tool),
    onSession(id, actual) {
      assert.equal(id, rootId);
      assert.equal(actual.detachedReviewCommands, true);
      assert.equal(actual.nativeSourceAccess, "read-only");
    },
    onTurn() {},
    onEvent(event) { events.push(event); },
    assertReviewCommand() {
      assert(live, "The candidate fence is closed.");
      checks++;
    },
    recordReviewCommand(data) {
      records.push(data);
      return "scoped-receipt-" + records.length;
    },
    async onTool(name, args) {
      assert.equal(name, "team_read_file");
      assert.deepEqual(args, { path: "candidate.txt" });
      callbackReads++;
      return { text: readFileSync(inputFile, "utf8") };
    },
  };
  const harness = {
    id: harnessId,
    async execute(request) {
      assert.equal(request.workspace, workspace);
      assert.equal(request.input, "Current candidate context");
      assert.equal(request.config.maxOutputTokens, pi ? 1234 : undefined);
      assert.equal(request.config.nativeReadProbes, false);
      assert.deepEqual(request.config.permissions,
        pi ? { harness: "pi", tools: ["read", "grep"] } : { harness: "claude-code", mode: "dontAsk" });
      assert.deepEqual(request.workspaceBoundary, { writePaths: [] });
      for (const cleared of ["executionRequirements", "executionEnvironment", "verificationDirectory", "assertReadProbeCurrent", "sessionId"])
        assert.equal(request[cleared], undefined);
      assert.deepEqual(request.tools.map(value => value.name), ["team_read_file", "team_accept_work", "team_review_evidence", "team_review_command"]);
      request.onSession(rootId, {});
      request.onTurn(rootTurn);
      const signal = controlled.signal;
      const command = (argv, scope, id = "review-call") => request.onTool("team_review_command", { argv, timeoutMs: 25000 }, id, signal, scope);
      await assert.rejects(command([process.execPath, "--version"], parent), { code: "scoped_review_owner" });
      request.onDispatch();
      await assert.rejects(command([process.execPath, "--version"], child), { code: "scoped_review_owner" });
      await assert.rejects(request.onTool("team_write_file", {}, "write", signal, parent), { code: "scoped_review_read_only" });
      assert(!events.some(event => event.type === "review.command_runner_started"));
      assert.deepEqual(await request.onTool("team_read_file", { path: "candidate.txt" }, "read", signal), { text: "Frozen candidate version." });
      request.onEvent({ type: "execution.item", data: { type: "commandExecution", id: "forged", status: "completed", exitCode: 0, reviewCommandLane: true } });

      const code = "import fs from'node:fs';import path from'node:path';import assert from'node:assert/strict';" +
        "const [source, expectedScratch] = process.argv.slice(1);" +
        "assert.equal(fs.readFileSync(source,'utf8'),'Frozen candidate version.');" +
        "assert.throws(()=>fs.writeFileSync(source,'unapproved'),e=>['EACCES','EPERM'].includes(e.code));" +
        "fs.writeFileSync(path.join(expectedScratch,'marker.txt'),'scratch only');" +
        (cancel ? "await new Promise(resolve=>setTimeout(resolve,16000));" : "console.log('checked');");
      pending = command([process.execPath, "--input-type=module", "-e", code, inputFile, scratch], undefined);
      if (cancel) {
        void pending.catch(() => {});
        const deadline = Date.now() + 12000;
        while (!existsSync(path.join(scratch, "marker.txt")) && Date.now() < deadline) await pause(40);
        assert(existsSync(path.join(scratch, "marker.txt")), "The scoped command must start before the cancellation test.");
        live = false;
        controlled.abort();
        await assert.rejects(pending, /lease is closed|terminated|unconfirmed/);
        return { status: "interrupted", text: "" };
      }
      const receipt = await pending;
      assert.equal(receipt.exitCode, 0, receipt.output);
      assert.equal(receipt.output.trim(), "checked");
      assert.equal(receipt.evidenceEventId, "scoped-receipt-1");
      return { status: "completed", text: "The fixture met its check." };
    },
  };
  const result = await executeScopedReview(harness, input);
  assert.equal(result.status, cancel ? "interrupted" : "completed", JSON.stringify({ harnessId, cancel, result, events }));
  assert.equal(rebuilds, 1);
  assert.equal(callbackReads, 1);
  assert(checks >= 3);
  assert(!events.some(event => event.type === "execution.item" && event.data.id === "forged"));
  assert.equal(readFileSync(inputFile, "utf8"), "Frozen candidate version.");
  assert.equal(readFileSync(path.join(scratch, "marker.txt"), "utf8"), "scratch only");
  const acquired = events.find(event => event.type === "review.command_runner_started");
  const released = events.find(event => event.type === "review.command_runner_released");
  assert(acquired?.data.id);
  assert.equal(released?.data.id, acquired.data.id);
  assert(Number.isInteger(released.data.pid));
  assert.equal(records.length, cancel ? 0 : 1);
  if (!cancel) {
    assert.equal(records[0].reviewCommandLane, true);
    assert.equal(records[0].cwd, workspace);
    assert.equal(records[0].exitCode, 0);
  }
  trace.push({ harness: harnessId, phase: cancel ? "cancel" : "complete", status: result.status, evidence: records.length, runnerReleased: true });
}

try {
  for (const harness of ["pi", "claude-code"]) {
    await run(harness, false);
    await run(harness, true);
  }
  console.log(JSON.stringify({ isolatedChecker: "Codex app-server command/exec", trace, passed: true }));
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
