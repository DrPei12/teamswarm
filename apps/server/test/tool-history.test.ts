import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { hash, type RuntimeStore } from "../src/runtime/store.js";
import { findCompletionsFolds, findMessagesFolds, toolReads, type ToolReadReceipt } from "../src/runtime/tool-history.js";
import type { Attempt } from "../src/runtime/types.js";

function transcript(harness: string, tool: string, text: string) {
  if (harness === "grok") return { title: "use_tool", output: JSON.stringify({ type: "MCP", server_name: "teamswarm", tool_name: tool, output: { OkayOutput: text } }) };
  if (harness === "opencode") return { title: `teamswarm_${tool}`, output: JSON.stringify({ output: text, metadata: { truncated: false } }) };
  return { title: tool, output: text };
}

for (const harness of ["claude-code", "deepseek-harness", "opencode", "grok"]) test(`${harness} issues citations only for completed native calls with intact Team read receipts`, (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE runtime_receipts (scope TEXT, request_id TEXT, digest TEXT, result TEXT);
    CREATE TABLE runtime_events (id TEXT, team_id TEXT, attempt_id TEXT, type TEXT, data TEXT);`);
  const attempt = { turnId: "native-turn", status: "completed", config: { harness } } as Attempt;
  const store = { db, get: (_table: string, team: string, id: string) => {
    assert.equal(team, "team"); assert.equal(id, "old");
    return attempt;
  } } as unknown as RuntimeStore;
  const types = ["team_read_file", "team_context_read", "team_read_artifact", "team_read_artifacts", "team_read_work", "team_write_file"];
  const raw = JSON.stringify({ content: "archived bytes ".repeat(220) });
  const args = { ref: "retained" };
  const frame = { reads: types.map((tool, index) => ({ tool, callId: `team-${index}`, resultSha256: hash(raw), args })) };
  const save = db.prepare("INSERT INTO runtime_receipts VALUES(?,?,?,?)");
  const emit = db.prepare("INSERT INTO runtime_events VALUES(?,?,?,?,?)");
  function event(id: string, tool: string, overrides = {}, team = "team", owner = "old") {
    emit.run(`receipt-${id}`, team, owner, "transcript.item", JSON.stringify({ id: `native-turn:tool:${id}`, kind: "tool",
      status: "completed", ...transcript(harness, tool, raw), ...overrides }));
  }
  for (const [i, tool] of types.entries()) {
    save.run("old", `team-${i}`, hash(JSON.stringify({ name: tool, input: args })), raw);
    event(String(i), tool);
  }
  event("wrong-hash", types[0], { ...transcript(harness, types[0], raw + "modified") });
  event("wrong-tool", "team_list_files");
  event("truncated", types[1], { truncated: true });
  event("failed", types[2], { status: "failed" });
  event("foreign", types[0], {}, "unrelated");
  event("later", types[0], {}, "team", "current");
  event("duplicate", types[0]);
  event("duplicate", types[0], { status: "failed" });
  event("different-turn", types[0], { id: "other:tool:different-turn" });
  assert.deepEqual(toolReads(store, "team", "old", frame), types.slice(0, -1).map((tool, i) => ({
    id: `receipt-${i}`, toolId: String(i), turnId: "native-turn", tool, text: raw, sha256: hash(raw),
  })));
  db.prepare("UPDATE runtime_receipts SET digest=? WHERE request_id=?").run("untrusted", "team-1");
  db.prepare("DELETE FROM runtime_receipts WHERE request_id=?").run("team-2");
  assert.deepEqual(toolReads(store, "team", "old", frame).map(r => r.tool), [types[0], types[3], types[4]]);
  attempt.status = "running";
  assert.deepEqual(toolReads(store, "team", "old", frame), []);
});

test("an in-process Host receipt must match the exact operation even if another tool returned the same bytes", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE runtime_receipts (scope TEXT, request_id TEXT, digest TEXT, result TEXT);
    CREATE TABLE runtime_events (id TEXT, team_id TEXT, attempt_id TEXT, type TEXT, data TEXT);`);
  const attempt = { executor: "teamswarm-host", turnId: "host-turn", status: "completed", config: { harness: "codex" } } as Attempt;
  const store = { db, get: () => attempt } as unknown as RuntimeStore;
  const tool = "team_read_file", args = { path: "fixture.txt" }, raw = JSON.stringify({ text: "receipt ".repeat(400) });
  const sha256 = hash(raw);
  db.prepare("INSERT INTO runtime_receipts VALUES(?,?,?,?)").run("attempt", "verified", hash(JSON.stringify({ name: tool, input: args })), raw);
  const save = db.prepare("INSERT INTO runtime_events VALUES(?,?,?,?,?)");
  for (const operation of ["verified", "not-authorized"]) save.run(operation, "team", "attempt", "transcript.item",
    JSON.stringify({ kind: "tool", id: `host-turn:tool:${operation}`, title: tool, status: "completed", output: raw }));
  assert.deepEqual(toolReads(store, "team", "attempt", { reads: [{ tool, args, callId: "verified", resultSha256: sha256 }] }).map(r => r.toolId), ["verified"]);
});

for (const harness of ["messages", "opencode", "grok"] as const) test(`${harness} folds by verified tool type and keeps the stub byte-stable across later turns`, () => {
  const raw = "a large archived artifact ".repeat(250);
  const values = [{ id: "valid", actual: "team_read_artifact", receipt: "team_read_artifact" },
    { id: "wrong-type", actual: "team_read_work", receipt: "team_context_read" },
    { id: "write", actual: "team_write_file", receipt: "team_read_file" },
    { id: "reused", actual: "team_read_work", receipt: "team_read_work" }] as const;
  const receipts: ToolReadReceipt[] = values.map(({ id, receipt }) => ({ id: `${id}-citation`, turnId: "earlier", toolId: id, sha256: hash(raw), tool: receipt }));
  const call = (id: string, tool: string) => harness === "messages"
    ? { role: "assistant", content: [{ type: "tool_use", id, name: `mcp__teamswarm__${tool}`, input: {} }] }
    : { role: "assistant", tool_calls: [{ id, type: "function", function: harness === "opencode"
        ? { name: `teamswarm_${tool}`, arguments: "{}" }
        : { name: "use_tool", arguments: JSON.stringify({ tool_name: `teamswarm__${tool}` }) } }] };
  const output = (id: string) => harness === "messages" ? { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: raw }] }] }
    : { role: "tool", tool_call_id: id, content: harness === "grok" ? JSON.stringify(raw) : raw };
  const earlier = [{ role: "user", content: "Earlier turn" }, ...values.flatMap(({ id, actual }) => [call(id, actual), output(id)])];
  const current = [{ role: "user", content: "Current turn" }, call("reused", "team_read_work"), output("reused"), call("new", "team_read_work"), output("new")];
  const wire = [...earlier, ...current];
  const possible = [...receipts, { id: "current-citation", turnId: "current", toolId: "new", tool: "team_read_work" as const, sha256: hash(raw) }];
  const bound = new Map([[0, "earlier"], [earlier.length, "current"]]);
  const choose = (messages: unknown[], boundaries: Map<number, string>) => harness === "messages"
    ? findMessagesFolds(messages, boundaries, possible) : findCompletionsFolds(messages, boundaries, possible, harness);
  const first = choose(wire, bound);
  assert.deepEqual([...first.keys()], ["valid"]);
  assert.equal(first.get("valid")?.text, "Read: tool-result:valid-citation");
  const later = choose([...wire, { role: "user", content: "Later turn" }], new Map([...bound, [wire.length, "later"]]));
  assert.deepEqual(later.get("valid"), first.get("valid"));
  assert.equal(later.get("new")?.text, "Read: tool-result:current-citation");
});
