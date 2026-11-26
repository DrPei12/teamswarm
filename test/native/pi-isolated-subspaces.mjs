import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../apps/server/src/app.ts";
import { NativeHarness } from "../../apps/server/src/runtime/harness/native.ts";
import { nativeEntry } from "../../apps/server/src/runtime/harness/native-support.ts";
import { packageFor } from "../../apps/server/src/runtime/harness/device-tools.ts";
import { hash } from "../../apps/server/src/runtime/store.ts";
import { autonomousWorkers } from "../../apps/server/test/evidence-fixture.ts";

assert.equal(packageFor(nativeEntry("pi"), "@earendil-works/pi-coding-agent")?.version, "1.3.0");
const root = mkdtempSync(path.join(tmpdir(), "teamswarm-pi-subcommit-"));
const workspace = path.join(root, "project");
mkdirSync(workspace);
const prior = "Existing original text.";
const revised = "Revised by the isolated Pi child.";
const created = "A second file created by the same child.";
const unrelated = "This file was outside the child grant.";
const criterion = "The owned text and its companion match the requested content";
const writePaths = ["owned.txt", "companion.txt"];
writeFileSync(path.join(workspace, "owned.txt"), prior);
writeFileSync(path.join(workspace, "other.txt"), unrelated);
const credentialEnv = "TEAMSWARM_NATIVE_PI_SUBSPACE_FIXTURE";
const environment = { [credentialEnv]: "synthetic-pi-subspace-key", TEAM_HARNESS_HOME: path.join(root, "harnesses") };
const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);

const hostRequests = new Map();
const host = {
  id: "codex", capabilities: { fixture: true },
  async inspect() { return { available: true }; },
  execute(request) {
    request.onSession(randomUUID(), { fixture: true });
    request.onTurn(randomUUID());
    return new Promise(resolve => hostRequests.set(JSON.parse(request.input).work.id, { request, resolve }));
  },
  async interrupt() { for (const { resolve } of hostRequests.values()) resolve({ status: "interrupted", text: "Stopped fixture." }); },
  async close() { await this.interrupt(); },
};
const service = createApp({ dataDir: path.join(root, "data"), harnesses: [host, new NativeHarness("pi")] });
autonomousWorkers(service.runtime);
const store = service.runtime.store;
const responses = { root: 0, child: 0 };
const failures = [];
let selected, team, submissionId;
const send = (res, name, args) => {
  const isTool = args !== undefined;
  const id = randomUUID();
  const chunk = (delta, finish_reason, extra = {}) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1,
    model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(chunk(isTool ? { role: "assistant", tool_calls: [{ index: 0, id: "call_" + id, type: "function",
    function: { name, arguments: JSON.stringify(args) } }] } : { role: "assistant", content: name }, null) +
    chunk({}, isTool ? "tool_calls" : "stop", { usage: { prompt_tokens: 300, completion_tokens: 15, total_tokens: 315 } }) + "data: [DONE]\n\n");
};
const next = (body, response) => {
  const tools = body.tools.map(tool => tool.function.name);
  const toolResult = body.messages.filter(message => message.role === "tool").at(-1)?.content;
  const decoded = () => JSON.parse(toolResult);
  assert(!tools.some(name => ["bash", "powershell", "edit", "write", "read", "tool_call", "team_preview_start"].includes(name)));
  if (tools.includes("team_pi_delegate")) {
    assert(!tools.includes("team_subspace_prepare") && !tools.includes("team_subspace_submit"));
    switch (++responses.root) {
      case 1: return send(response, "team_pi_delegate", { task: "Change the owned text and create the companion.", paths: writePaths });
      case 2: {
        const receipt = decoded();
        submissionId = receipt.id;
        assert.match(receipt.summary, /only the two assigned/);
        assert.deepEqual(receipt.files.sort((a, b) => a.path.localeCompare(b.path)), [
          { path: "companion.txt", before: null, after: hash(created) },
          { path: "owned.txt", before: hash(prior), after: hash(revised) },
        ]);
        const work = store.get("works", team.id, selected.id);
        assert.equal(readFileSync(path.join(work.workspace, "owned.txt"), "utf8"), prior);
        const attempt = store.get("attempts", team.id, work.attemptId);
        assert(attempt.nativeNodes.some(node => node.threadId === receipt.childId && node.status === "completed" && node.runtimeClosed));
        return send(response, "team_pi_delegate", { task: "This overlaps the uncommitted child.", paths: ["owned.txt"] });
      }
      case 3:
        assert.match(toolResult, /overlapping path/);
        return send(response, "team_subspace_commit", { id: submissionId });
      case 4:
        assert.deepEqual(decoded().appliedPaths.sort(), ["companion.txt", "owned.txt"]);
        assert.equal(decoded().state, "committed");
        assert.equal(readFileSync(path.join(workspace, "owned.txt"), "utf8"), prior);
        return send(response, "team_submit_result", { summary: "Committed both scoped files.", files: writePaths, usedArtifactIds: [],
          selfChecks: [{ criterion, evidence: "The subcommit returned both expected hashes.", evidenceEventIds: [] }] });
      case 5:
        assert(decoded().some(entry => entry.path === "owned.txt" && entry.sha256 === hash(revised)));
        return send(response, "The two files are ready.");
      default: throw Error("Unexpected root model step.");
    }
  }
  assert.deepEqual([...tools].sort(), ["team_edit_file", "team_read_file", "team_subspace_submit", "team_write_file"]);
  assert(!JSON.stringify(body.messages).includes("Parent-only instructions marker."));
  assert.equal(body.max_tokens, 4096);
  for (const tool of body.tools.filter(tool => tool.function.name !== "team_subspace_submit"))
    assert.deepEqual(tool.function.parameters.properties.path.enum, [...writePaths].sort());
  switch (++responses.child) {
    case 1: return send(response, "team_read_file", { path: "other.txt" });
    case 2:
      assert.match(toolResult, /other.txt/);
      assert(!toolResult.includes(unrelated));
      return send(response, "team_read_file", { path: "owned.txt" });
    case 3: {
      const read = decoded();
      assert.equal(read.text, prior);
      assert.equal(read.sha256, hash(prior));
      return send(response, "team_edit_file", { path: "owned.txt", expectedSha256: read.sha256, oldText: prior, newText: revised });
    }
    case 4:
      assert.equal(decoded().sha256, hash(revised));
      return send(response, "team_write_file", { path: "companion.txt", expectedSha256: null, text: created });
    case 5:
      assert.equal(decoded().sha256, hash(created));
      return send(response, "team_subspace_submit", {});
    case 6:
      assert.equal(decoded().state, "submitted");
      return send(response, "I changed only the two assigned files.");
    default: throw Error("Unexpected child model step.");
  }
};
const provider = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer " + environment[credentialEnv]);
    assert.equal(req.headers["x-teamswarm-pi-actor"], undefined);
    next(JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString("utf8")), res);
  } catch (error) {
    failures.push(error);
    if (!res.headersSent) res.writeHead(500);
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
}).listen(0, "127.0.0.1");
const directFetch = globalThis.fetch;
const wait = async (inspect, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (failures.length) throw failures[0];
    const value = inspect();
    if (value) return value;
    if (Date.now() > deadline) throw Error("Timed out while waiting for native Pi subcommit.");
    await new Promise(resolve => setTimeout(resolve, 15));
  }
};
try {
  await once(provider, "listening");
  globalThis.fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin === "https://api.deepseek.com")
      return directFetch(`http://127.0.0.1:${provider.address().port}${target.pathname}`, init);
    assert.equal(target.hostname, "127.0.0.1", "No request may reach an external upstream.");
    return directFetch(input, init);
  };
  team = service.store.createTeam("Isolated Pi", "");
  const chat = service.store.createConversation(team.id, "Scoped subcommit", null);
  store.configure(team.id, { workspace, config: { harness: "codex", model: null, access: "read-only" }, maxConcurrent: 3,
    timeoutSeconds: 45 }, 0);
  let hostWork;
  service.store.recordMessage(team.id, chat.id, "Change the two assigned text files.", randomUUID(), message => {
    hostWork = store.enqueueHost(team.id, chat.id, message.id, true, false);
  });
  service.runtime.pump();
  const hostCall = await wait(() => hostRequests.get(hostWork.id));
  const hostTool = (name, input) => hostCall.request.onTool(name, input, randomUUID());
  await hostTool("team_define_requirements", { content: "Change the assigned text and create its companion.", affectedWorkIds: [] });
  const config = { harness: "pi", model: "deepseek-flash", protocol: "chat-completions", baseUrl: "https://api.deepseek.com/v1",
    credentialEnv, access: "workspace-write", permissions: { harness: "pi", tools: ["read", "write", "edit", "bash"] } };
  const member = await hostTool("team_add_member", { name: "Pi worker", responsibility: "Assign and combine child changes", config });
  selected = await hostTool("team_delegate", {
    memberId: member.id, title: "Produce the two assigned files", instructions: "Parent-only instructions marker. Delegate and commit both assigned files.",
    acceptanceCriteria: [criterion], acceptanceEvidence: [{ criterion, evidenceType: "review_judgment" }], verification: "self-check",
    workspaceMode: "isolated", isolatedSubspaces: true, writePaths, inputArtifactIds: [], dependsOn: [],
  });
  const terminal = await wait(() => {
    const work = store.get("works", team.id, selected.id);
    return !["waiting", "queued", "running", "stopping"].includes(work.status) && work;
  });
  const attempt = store.get("attempts", team.id, terminal.attemptId);
  const events = [];
  let cursor = 0;
  for (;;) {
    const page = store.events(team.id, cursor, 50);
    if (!page.length) break;
    cursor = page.at(-1).sequence;
    events.push(...page.filter(event => event.attemptId === attempt.id));
  }
  assert.equal(terminal.status, "self_checked", JSON.stringify({ work: terminal.error, attempt: attempt.error,
    events: events.filter(event => event.attemptId === attempt.id).slice(-20).map(event => [event.type, event.data]) }));
  assert.equal(terminal.publication?.state, "published");
  assert.equal(readFileSync(path.join(workspace, "owned.txt"), "utf8"), revised);
  assert.equal(readFileSync(path.join(workspace, "companion.txt"), "utf8"), created);
  assert.equal(readFileSync(path.join(workspace, "other.txt"), "utf8"), unrelated);
  assert.equal(attempt.actual.nativeSourceAccess, "read-only");
  assert.equal(attempt.actual.nativeCommands, false);
  assert.deepEqual(responses, { root: 5, child: 6 });
  const subcommit = events.find(event => event.type === "subspace.committed" && event.data.id === submissionId);
  assert(subcommit?.data.threadId && subcommit?.data.turnId);
  const childReceipts = events.filter(event => event.type === "subagent.model.request" && event.data.status === "prepared");
  assert.equal(childReceipts.length, responses.child);
  assert(childReceipts.every(event => event.data.nativeThreadId === subcommit.data.threadId && event.data.nativeTurnId === subcommit.data.turnId));
  assert.equal(service.runtime.models.state().routes, 0);
  console.log(JSON.stringify({ status: terminal.status, publication: terminal.publication.state, responses,
    nativeRuntime: "Pi 1.3.0", checkedGateway: true, upstream: "loopback-only", noNativeCommands: true }));
} finally {
  await service.close();
  globalThis.fetch = directFetch;
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
