import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { CodexHarness } from "../src/runtime/harness/codex.js";
import { NativeHarness } from "../src/runtime/harness/native.js";
import { codexPermissionOptions } from "../src/runtime/permission-options.js";
import type { Harness, HarnessRequest, NativeQuestion, Work } from "../src/runtime/types.js";

const questions: NativeQuestion[] = [
  { question: "Which format?", header: "Format", options: [{ label: "JSON", description: "Structured" }, { label: "Text" }] },
  { question: "Which checks?", multiSelect: true, options: [{ label: "Lint" }, { label: "Unit" }] },
];

test("Claude offers AskUserQuestion only with an answer channel and returns the user's choices", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-question-claude-"));
  const entry = path.join(root, "fixture.js"), log = path.join(root, "wire.jsonl");
  writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
  const keys = ["TEAM_CLAUDE_CODE_BIN", "TEAM_HARNESS_HOME", "TEST_QUESTION_KEY"];
  const previous = keys.map(k => process.env[k]);
  process.env.TEAM_CLAUDE_CODE_BIN = entry; process.env.TEAM_HARNESS_HOME = root; process.env.TEST_QUESTION_KEY = "fixture";
  writeFileSync(entry, `
const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv,memory:process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY})+'\\n');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');const tools=process.argv[process.argv.indexOf('--tools')+1];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');
 if(r.type==='user'&&!tools.includes('AskUserQuestion')){send({type:'result',is_error:false,result:'No question'});process.exit(0);}
 if(r.type==='user')send({type:'control_request',request_id:'ask-original',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',tool_use_id:'toolu_ask',input:{questions:${JSON.stringify(questions)}}}});
 if(r.type==='control_response'){send({type:'result',is_error:false,result:'Answered'});process.exit(0);}
});`);
  const harness = new NativeHarness("claude-code");
  const request = (mode: "default" | "dontAsk", onQuestion?: HarnessRequest["onQuestion"]): HarnessRequest => ({
    workspace: root, config: { harness: "claude-code", model: "fixture", provider: "fixture", baseUrl: "https://fixture.invalid", credentialEnv: "TEST_QUESTION_KEY", effort: null, access: "read-only", permissions: { harness: "claude-code", mode } },
    instructions: "Isolated fixture", input: "Isolated fixture", tools: [], onSession() {}, onTurn() {}, onEvent() {}, onTool: async () => ({}), onQuestion,
  });
  const wire = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  try {
    let asked: NativeQuestion[] = [];
    assert.equal((await harness.execute(request("default", async input => { asked = input.questions; assert.equal(input.nativeId, "toolu_ask"); return [["JSON"], ["Lint", "Unit"]]; }))).status, "completed");
    let lines = wire();
    const args: string[] = lines[0].args;
    assert.equal(args.includes("--bare"), false, "--bare removes AskUserQuestion");
    assert(args.includes("--setting-sources"), "Local settings, hooks and slash commands stay isolated without --bare");
    assert.equal(lines[0].memory, "1");
    assert.match(args[args.indexOf("--tools") + 1], /,AskUserQuestion$/);
    assert.doesNotMatch(args[args.indexOf("--allowedTools") + 1], /AskUserQuestion/, "Pre-allowed questions would be answered without the user");
    assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], "stdio");
    assert.deepEqual(asked.map(q => [q.question, q.allowOther, q.multiSelect ?? false]), [["Which format?", true, false], ["Which checks?", true, true]]);
    assert.equal(lines.at(-1).response.request_id, "ask-original");
    assert.deepEqual(lines.at(-1).response.response, { behavior: "allow", updatedInput: { questions, answers: { "Which format?": "JSON", "Which checks?": "Lint, Unit" } } });

    writeFileSync(log, "");
    assert.equal((await harness.execute(request("default", async () => null))).status, "completed");
    lines = wire();
    assert.equal(lines.at(-1).response.response.behavior, "deny");
    assert.match(lines.at(-1).response.response.message, /did not answer/);

    for (const [mode, onQuestion] of [["dontAsk", async () => null], ["default", undefined]] as const) {
      writeFileSync(log, "");
      assert.equal((await harness.execute(request(mode, onQuestion))).status, "completed");
      const quiet: string[] = wire()[0].args;
      assert(quiet.includes("--bare"), `${mode} without an answer channel keeps the minimal mode`);
      assert.doesNotMatch(quiet[quiet.indexOf("--tools") + 1], /AskUserQuestion/);
    }
  } finally {
    await harness.close(); keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Codex routes requestUserInput to the user and never forwards secret questions", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-question-codex-"));
  const entry = path.join(root, "fixture.js"), log = path.join(root, "wire.jsonl");
  writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
  const previous = process.env.TEAM_CODEX_BIN;
  process.env.TEAM_CODEX_BIN = entry;
  const ask = (secret: boolean) => ({ id: "fmt", header: "Format", question: "Which format?", isOther: true, isSecret: secret, options: [{ label: "JSON", description: "Structured" }, { label: "Text", description: "Plain" }] });
  writeFileSync(entry, `
const fs=require('node:fs'); const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');let secret=false;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');
 if(r.id===801){ send({method:'turn/completed',params:{threadId:'session',turn:{id:'turn',status:'completed'}}});return; }
 if(r.id===undefined)return;
 send({id:r.id,result:r.method==='thread/start'?{thread:{id:'session'},model:'fixture',sandbox:{type:'readOnly'}}:r.method==='turn/start'?{turn:{id:'turn'}}:{}});
 if(r.method==='turn/start'){secret=r.params.input.some(i=>String(i.text).includes('secret'));setTimeout(()=>send({id:801,method:'item/tool/requestUserInput',params:{threadId:'session',turnId:'turn',itemId:'ask',questions:[secret?${JSON.stringify(ask(true))}:${JSON.stringify(ask(false))}]}}),15);}
});`);
  try {
    for (const secret of [false, true]) {
      const harness = new CodexHarness(); let asked: NativeQuestion[] | undefined;
      const request: HarnessRequest = {
        workspace: root, config: { harness: "codex", model: "fixture", provider: null, baseUrl: null, credentialEnv: null, effort: null, access: "read-only" },
        instructions: "Test fixture", input: secret ? "secret fixture" : "Test fixture", tools: [], onSession() {}, onTurn() {}, onEvent() {}, onTool: async () => ({}),
        onQuestion: async input => { asked = input.questions; assert.equal(input.nativeId, "ask"); return [["Custom answer"]]; },
      };
      try {
        assert.equal((await harness.execute(request)).status, "completed");
        const answer = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).findLast(r => r.id === 801).result;
        if (secret) {
          assert.equal(asked, undefined);
          assert.deepEqual(answer, { answers: {} });
        } else {
          assert.deepEqual(asked, [{ id: "fmt", question: "Which format?", header: "Format", allowOther: true, options: [{ label: "JSON", description: "Structured" }, { label: "Text", description: "Plain" }] }]);
          assert.deepEqual(answer, { answers: { fmt: { answers: ["Custom answer"] } } });
        }
      } finally { await harness.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.TEAM_CODEX_BIN; else process.env.TEAM_CODEX_BIN = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a native question waits for the user's answer, rejects choices it did not offer and ends with its turn", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-question-runtime-"));
  const received: (string[][] | null)[] = [];
  const release = new Map<string, () => void>();
  const harness: Harness = {
    id: "codex", capabilities: { resume: true, fixture: true }, permissionOptions: () => codexPermissionOptions,
    inspect: async () => ({ available: true }), validateConfig() {},
    async execute(r) {
      const session = randomUUID();
      r.onSession(session); r.onTurn(randomUUID());
      const stopped = new Promise<null>(resolve => release.set(session, () => resolve(null)));
      const answers = await Promise.race([r.onQuestion!({ nativeId: "ask", tool: "AskUserQuestion", questions }), stopped]);
      received.push(answers);
      return answers ? { status: "completed", text: `Chose ${answers.flat().join(", ")}` } : { status: "interrupted", text: "" };
    },
    async interrupt(session) { release.get(session)?.(); },
    async close() { for (const done of release.values()) done(); },
  };
  const service = createApp({ dataDir: path.join(root, "data"), harnesses: [harness] });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const call = async (url: string, method = "GET", body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api${url}`, {
      method, headers: { authorization: `Bearer ${service.controlToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const until = async <T>(read: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> => {
    for (let i = 0; i < 250; i++) {
      const value = await read();
      if (value !== undefined) return value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  try {
    const team = (await call("/product/teams", "POST", { name: "Questions", clientRequestId: randomUUID() })).body as { id: string; mainChatId: string };
    const store = service.runtime.store;
    const ask = async () => {
      let work!: Work;
      service.store.recordMessage(team.id, team.mainChatId, "Synthetic request", randomUUID(), message => {
        work = store.enqueueHost(team.id, team.mainChatId, message.id, true);
      });
      const question = await until(async () => (await call(`/teams/${team.id}/approvals`)).body.find((a: any) => a.kind === "question"), "the question");
      return { work, question };
    };
    const answer = (id: string, body: unknown) => call(`/teams/${team.id}/approvals/${id}`, "POST", body);
    const ended = (work: Work) => until(() => ["queued", "waiting", "running", "stopping"].includes(store.get<Work>("works", team.id, work.id).status) ? undefined : true, "the turn to end");

    const first = await ask();
    assert.deepEqual(first.question.questions, questions);
    assert.equal(first.question.tool, "AskUserQuestion");
    for (const body of [
      { accepted: true },
      { accepted: true, answers: [["JSON"]] },
      { accepted: true, answers: [["YAML"], ["Lint"]] },
      { accepted: true, answers: [["JSON", "Text"], ["Lint"]] },
      { accepted: true, answers: [["JSON"], ["Lint", "Lint"]] },
    ]) assert.equal((await answer(first.question.id, body)).status, 400, JSON.stringify(body));
    const accepted = await answer(first.question.id, { accepted: true, answers: [["JSON"], ["Unit", "Lint"]] });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, "accepted");
    await ended(first.work);
    assert.deepEqual(received.at(-1), [["JSON"], ["Unit", "Lint"]]);
    assert.equal((await answer(first.question.id, { accepted: true, answers: [["Text"], ["Lint"]] })).status, 409, "An answered question cannot be answered again");

    const second = await ask();
    assert.equal((await answer(second.question.id, { accepted: false })).body.status, "declined");
    await ended(second.work);
    assert.equal(received.at(-1), null);

    const third = await ask();
    await service.runtime.stop(team.id, third.work.id);
    await ended(third.work);
    assert.equal((await call(`/teams/${team.id}/approvals`)).body.some((a: any) => a.kind === "question"), false);
    const late = await answer(third.question.id, { accepted: true, answers: [["JSON"], ["Lint"]] });
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, "question_expired");
    const events = store.db.prepare("SELECT type, data FROM runtime_events WHERE team_id=? AND type LIKE 'question.%' ORDER BY rowid").all(team.id)
      .map(row => [row.type, JSON.parse(String(row.data)).state ?? null]);
    assert.deepEqual(events, [["question.requested", null], ["question.resolved", "answered"], ["question.requested", null], ["question.resolved", "declined"], ["question.requested", null], ["question.resolved", "cancelled"]]);
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
