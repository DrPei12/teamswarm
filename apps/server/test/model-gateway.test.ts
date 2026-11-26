import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ModelGateway } from "../src/runtime/model-gateway.js";
import { executionConfig, toolSpecs, tools as teamTools } from "../src/runtime/validation.js";
import { CodexHarness } from "../src/runtime/harness/codex.js";
import { NativeHarness } from "../src/runtime/harness/native.js";
import { resolveConnection } from "../src/runtime/connections.js";
import { decodeRequest, encodeResponse, chatGPTPayload, requestOptions, flattenToolNamespaces, WireStream } from "../src/runtime/model-wire.js";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { Harness, HarnessRequest } from "../src/runtime/types.js";
import { tagModelTurn } from "../src/runtime/harness/model-turn.js";

function respond(res:ServerResponse, model:string, value:string|{name:string;arguments:Record<string,unknown>}, complete=true, metadata=false, finalDelayMs=0){
  res.writeHead(200,{"content-type":"text/event-stream"});
  const id="resp_fixture", itemId=typeof value==="string"?"msg_fixture":"fc_fixture";
  let sequence = 0;
  const send=(type:string,fields:unknown)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:sequence++,...fields as object})}\n\n`);
  send("response.created",{response:{id,object:"response",created_at:Math.floor(Date.now()/1000),model,status:"in_progress",output:[],error:null,incomplete_details:null}});
  if(metadata)send("response.metadata",{metadata:{source:"subscription-fixture"}});
  let item:any;
  if(typeof value==="string"){
    item={id:itemId,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:value,annotations:[]}]};
    send("response.output_item.added",{output_index:0,item:{...item,status:"in_progress",content:[]}});
    send("response.content_part.added",{output_index:0,content_index:0,item_id:itemId,part:{type:"output_text",text:"",annotations:[]}});
    send("response.output_text.delta",{output_index:0,content_index:0,item_id:itemId,delta:value});
    send("response.output_text.done",{output_index:0,content_index:0,item_id:itemId,text:value});
    send("response.content_part.done",{output_index:0,content_index:0,item_id:itemId,part:item.content[0]});
  }else{
    item={id:itemId,type:"function_call",call_id:"call_fixture",name:value.name,arguments:JSON.stringify(value.arguments),status:"completed"};
    send("response.output_item.added",{output_index:0,item:{...item,arguments:"",status:"in_progress"}});
    send("response.function_call_arguments.delta",{output_index:0,item_id:itemId,delta:item.arguments});
    send("response.function_call_arguments.done",{output_index:0,item_id:itemId,arguments:item.arguments});
  }
  send("response.output_item.done",{output_index:0,item});
  const finish = () => {
  if(complete)send("response.completed",{response:{id,object:"response",created_at:Math.floor(Date.now()/1000),model,status:"completed",output:[item],error:null,incomplete_details:null,usage:{input_tokens:20,output_tokens:5,total_tokens:25,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}});
  res.end();
  };
  if(finalDelayMs) setTimeout(finish, finalDelayMs); else finish();
}
async function setup(action:(body:any,res:ServerResponse)=>void){
  const directory=mkdtempSync(path.join(process.cwd(),".test-model-route-"));
  const requests:any[]=[], errors: unknown[] = [];
  const upstream=createServer(async(req,res)=>{
    try {
    if (req.method === "GET") { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify({object:"list",data:[{id:"gpt-test",object:"model",created:0,owned_by:"fixture"}]})); return; }
    const parts:Buffer[]=[];for await(const part of req)parts.push(part);
    const body=JSON.parse(Buffer.concat(parts).toString()); requests.push(body);
    assert.equal(req.headers.authorization ?? `Bearer ${req.headers["x-api-key"]}`,"Bearer fixture-key");action(body,res);
    } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end("Fixture failure"); }
  });
  await new Promise<void>(r=>upstream.listen(0,"127.0.0.1",r));
  process.env.TEAM_GATEWAY_TEST_KEY="fixture-key";
  const gateway=new ModelGateway(directory);
  const config=executionConfig.parse({harness:"claude-code",model:"gpt-test",protocol:"responses",baseUrl:`http://127.0.0.1:${(upstream.address() as any).port}/v1`,credentialEnv:"TEAM_GATEWAY_TEST_KEY"});
  return {directory,requests,gateway,config,close:async()=>{await gateway.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));delete process.env.TEAM_GATEWAY_TEST_KEY;rmSync(directory,{recursive:true,force:true});assert.deepEqual(errors, [], "The fixture server must complete every request without handler errors");}};
}
for (const harness of ["opencode", "grok"] as const) test(`${harness} folds only an exact earlier tool result in the admitted chat session`, async () => {
  const f = await setup((_body, response) => response.writeHead(200, { "content-type": "application/json" }).end("{}"));
  try {
    const grok = harness === "grok";
    const lease = await f.gateway.lease({ ...f.config, harness, protocol: "chat-completions" }, undefined,
      grok ? "grok-chat-completions" : "chat-completions");
    const session = randomUUID(), old = randomUUID(), current = randomUUID();
    const text = JSON.stringify({ content: "Observed earlier bytes".repeat(220) });
    const changed = text + " different bytes";
    lease.session(session, f.directory);
    lease.bindNativeTurn(current, session);
    lease.bindPriorToolReads(() => ["old-read", "raw-read", "changed-read", "duplicate-read", "other-tool", "current-read"].map(toolId => ({
      id: toolId + "-receipt", turnId: toolId === "current-read" ? current : old, toolId, sha256: createHash("sha256").update(text).digest("hex"),
    })));
    const calls = (...ids: string[]) => ({ role: "assistant", tool_calls: ids.map(id => ({ id, type: "function", function: grok
      ? { name: "use_tool", arguments: JSON.stringify({ tool_name: id === "other-tool" ? "teamswarm__team_state" : "teamswarm__team_read_file" }) }
      : { name: id === "other-tool" ? "teamswarm_team_state" : "teamswarm_team_read_file", arguments: "{}" } })) });
    const wrap = (content: string) => grok ? JSON.stringify(content) : content;
    const output = (id: string, content = text) => ({ role: "tool", tool_call_id: id, content: wrap(content) });
    const query = (content: string, turn: string) => ({ role: "user", content: grok
      ? "<user_query>\n" + tagModelTurn(content, turn) + "\n</user_query>" : tagModelTurn(content, turn) });
    const response = await fetch(lease.config.baseUrl + "/chat/completions", { method: "POST", headers: {
      authorization: "Bearer " + lease.token, "content-type": "application/json",
      ...(grok ? { "x-grok-session-id": session, "x-grok-turn-idx": "2" } : { "x-opencode-session-id": session }),
    }, body: JSON.stringify({ model: "gpt-test", messages: [
      query("Previous input", old),
      ...(grok ? [{ role: "user", content: "<system-reminder>\nTools connected.\n</system-reminder>" }] : []),
      calls("old-read", "raw-read", "changed-read", "duplicate-read", "other-tool"),
      output("old-read"), { ...output("raw-read"), content: text },
      output("changed-read", changed), output("duplicate-read"), output("other-tool"),
      query("Current input", current), calls("current-read", "duplicate-read"),
      output("current-read"), output("duplicate-read"),
    ] }) });
    const returned = await response.text();
    assert.equal(response.status, 200, returned);
    const tools = f.requests[0].messages.filter((item: { role: string }) => item.role === "tool");
    assert.deepEqual(tools.map((item: { content: string }) => item.content),
      ["Read: tool-result:old-read-receipt", "Read: tool-result:raw-read-receipt", wrap(changed), wrap(text), wrap(text), wrap(text), wrap(text)]);
    await lease.release();
  } finally { await f.close(); }
});

for (const harness of ["deepseek-harness", "pi", "claude-code", "opencode"] as const)
  test(`${harness} does not forward unregistered probe requests`, async () => {
    const f = await setup((_body, res) => res.writeHead(200).end("{}"));
    try {
      const lease = await f.gateway.lease({ ...f.config, harness, nativeReadProbes: true });
      const session = randomUUID();
      lease.session(session, f.directory);
      const response = await fetch(lease.config.baseUrl + "/chat/completions", { method: "POST", headers: {
        authorization: "Bearer " + lease.token, "content-type": "application/json", [`x-${harness}-session-id`]: session,
      }, body: JSON.stringify({ model: f.config.model, messages: [] }) });
      assert.equal(response.status, 403);
      assert.equal(f.requests.length, 0);
      await lease.release();
    } finally { await f.close(); }
  });

test("scoped DeepSeek model requests reject foreign actors before reaching the upstream", async () => {
  const f = await setup((body, response) => respond(response, body.model, "Observed scope"));
  try {
    const root = randomUUID(), child = randomUUID();
    const lease = await f.gateway.lease({ ...f.config, harness: "deepseek-harness", nativeReadProbes: true, access: "read-only" });
    lease.session(root, f.directory);
    const lifetime = new AbortController();
    lease.bindNativeSessionScope(async id => id === child && !lifetime.signal.aborted ? {
      sessionId: root, threadId: child, parentThreadId: root, turnId: child + ":1", signal: lifetime.signal,
    } : undefined);
    const facts: Array<{ nativeThreadId?: string; parentThreadId?: string; nativeTurnId?: string }> = [];
    lease.observe(receipt => facts.push(receipt));
    const send = (id: string) => fetch(lease.config.baseUrl + "/messages", { method: "POST", headers: {
      "x-api-key": lease.token, "content-type": "application/json", "x-deepseek-harness-session-id": id,
    }, body: JSON.stringify({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "Confirm the scoped reply" }] }) });
    const foreign = await send(randomUUID());
    assert.equal(foreign.status, 403);
    assert.equal(f.requests.length, 0);
    const allowed = await send(child);
    assert.match(await allowed.text(), /Observed scope/);
    assert(facts.length && facts.every(fact => fact.nativeThreadId === child && fact.nativeTurnId === child + ":1" && fact.parentThreadId === root));
    lifetime.abort();
    const late = await send(child);
    assert.equal(late.status, 403);
    assert.equal(f.requests.length, 1);
    await lease.release();
  } finally { await f.close(); }
});

test("scoped OpenCode requests bind actual ACP actors and withhold private tool receipts from the provider", async () => {
  const f = await setup((_body, response) => response.writeHead(200, { "content-type": "application/json" }).end("{}"));
  const root = "ses_native-root", child = "ses_native-child", app = "app-session";
  const lifetime = new AbortController();
  const lease = await f.gateway.lease({ ...f.config, harness: "opencode", protocol: "chat-completions",
    nativeReadProbes: true, access: "read-only" });
  try {
    lease.session(app, f.directory);
    const read = "teamswarm_team_read_file";
    const send = async (id: string, parent?: string, name = read) => {
      const response = await fetch(lease.config.baseUrl + "/chat/completions", { method: "POST", headers: {
        authorization: "Bearer " + lease.token, "content-type": "application/json", "x-opencode-session-id": id,
        ...(parent !== undefined ? { "x-opencode-parent-session-id": parent } : {}),
      }, body: JSON.stringify({ model: "gpt-test", max_tokens: 8192,
        messages: [{ role: "user", content: "Read the scoped file" }, { role: "assistant",
          tool_calls: [{ id: "native-read", type: "function", function: { name: read, arguments: JSON.stringify({ path: "one.txt", _teamswarmReceipt: "private-envelope" }) } }] },
          { role: "tool", tool_call_id: "native-read", content: "Project file excerpt" }],
        tools: [{ type: "function", function: { name,
          parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, _teamswarmReceipt: { type: "string" } } } } }],
      }) });
      await response.text();
      return response.status;
    };
    assert.equal(await send(root), 403);
    const accepted: Array<{ nativeThreadId?: string; nativeTurnId?: string; nativeRootSessionId?: string; parentThreadId?: string }> = [];
    lease.observe(receipt => { if (receipt.status === "accepted") accepted.push(receipt); });
    lease.bindNativeSessionScope(async (actor, _signal, parent) => {
      if (actor === root && parent === undefined) return { sessionId: root, threadId: root, turnId: "root-turn" };
      if (actor === child && parent === root && !lifetime.signal.aborted)
        return { sessionId: root, threadId: child, parentThreadId: root, turnId: "child-turn", signal: lifetime.signal };
    });
    assert.equal(await send(app), 403);
    assert.equal(await send(child), 403);
    assert.equal(await send(child, app), 403);
    assert.equal(await send(root, root), 403);
    assert.equal(await send(child, root, "teamswarm_team_list_files"), 403);
    assert.equal(f.requests.length, 0);
    assert.equal(await send(root), 200);
    assert.equal(await send(child, root), 200);
    assert.deepEqual(accepted.map(({ nativeThreadId, nativeTurnId, nativeRootSessionId, parentThreadId }) =>
      [nativeThreadId, nativeTurnId, nativeRootSessionId, parentThreadId]),
      [[root, "root-turn", root, undefined], [child, "child-turn", root, root]]);
    assert.equal(f.requests[0].max_tokens, 8192);
    assert.equal(f.requests[1].max_tokens, 512);
    assert.equal(f.requests[1].messages[1].tool_calls[0].function.arguments, '{"path":"one.txt"}');
    assert(!JSON.stringify(f.requests).includes("_teamswarmReceipt"));
    lifetime.abort();
    assert.equal(await send(child, root), 403);
    assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

test("revoking a Codex child scope discards its admitted partial body and keeps the parent route", { timeout: 6000 }, async () => {
  const f = await setup((body, response) => respond(response, body.model, "parent response"));
  const lease = await f.gateway.lease({ ...f.config, harness: "codex" });
  const child = new AbortController();
  let admitted!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  const headers = (isChild: boolean) => ({
    authorization: "Bearer " + lease.token,
    "content-type": "application/json",
    "x-codex-turn-metadata": JSON.stringify(isChild
      ? { session_id: "root", thread_id: "child", turn_id: "child-turn", parent_thread_id: "root" }
      : { session_id: "root", thread_id: "root", turn_id: "parent-turn" }),
  });
  lease.session("root", f.directory);
  lease.bindRequestScope(scope => {
    if (scope.threadId === "root") return scope.turnId === "parent-turn";
    if (scope.threadId !== "child" || scope.turnId !== "child-turn" || child.signal.aborted) return false;
    admitted();
    return { ...scope, signal: child.signal };
  });
  const request = httpRequest(lease.config.baseUrl + "/responses", {
    method: "POST", headers: { ...headers(true), "content-length": 1000 },
  });
  request.on("error", () => {});
  request.on("response", response => response.resume());
  const closed = new Promise<void>(resolve => request.once("close", () => resolve()));
  try {
    request.write('{"model":');
    await admission;
    child.abort();
    await closed;
    assert.equal(f.requests.length, 0);
    const reply = await fetch(lease.config.baseUrl + "/responses", { method: "POST", headers: headers(false),
      body: JSON.stringify({ model: f.config.model, input: "Parent turn" }) });
    assert.equal(reply.status, 200);
    assert.match(await reply.text(), /parent response/);
    assert.equal(f.requests.length, 1);
  } finally { request.destroy(); await f.close(); }
});

test("revoking a Codex child scope stops its upstream stream before usable output or usage", { timeout: 6000 }, async () => {
  let reached!: (response: ServerResponse) => void;
  const upstream = new Promise<ServerResponse>(resolve => { reached = resolve; });
  const f = await setup((_body, response) => reached(response));
  const child = new AbortController();
  try {
    const lease = await f.gateway.lease({ ...f.config, harness: "codex" });
    lease.session("root", f.directory);
    lease.bindRequestScope(scope => !child.signal.aborted && { ...scope, signal: child.signal });
    const receipts: Array<{ status: string; nativeThreadId?: string }> = [], usage: unknown[] = [];
    lease.observe(receipt => receipts.push(receipt));
    lease.observeUsage(observation => usage.push(observation));
    const client = fetch(lease.config.baseUrl + "/responses", { method: "POST", headers: {
      authorization: "Bearer " + lease.token, "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify({ session_id: "root", thread_id: "child", turn_id: "child-turn", parent_thread_id: "root" }),
    }, body: JSON.stringify({ model: f.config.model, input: "Child turn", stream: true }) });
    const received = client.then(async response => ({ status: response.status, body: await response.text() }), () => undefined);
    const response = await upstream;
    const closed = new Promise<void>(resolve => response.once("close", () => resolve()));
    child.abort();
    await closed;
    const result = await received;
    assert.notEqual(result?.status, 200);
    assert.doesNotMatch(result?.body ?? "", /response\.completed/);
    assert.deepEqual(receipts.map(item => [item.status, item.nativeThreadId]), [["prepared", "child"]]);
    assert.equal(usage.length, 0);
    assert.equal(f.requests.length, 1);
  } finally { child.abort(); await f.close(); }
});

test("retained Grok admits only the latest tagged query and its native session", async () => {
  const f = await setup((_input, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}"));
  const session = randomUUID(), prior = randomUUID(), current = randomUUID();
  const first = await f.gateway.lease({ ...f.config, harness: "grok", protocol: "chat-completions" }, undefined, "grok-chat-completions");
  first.session(session, f.directory);
  const query = (turn: string) => "<user_query>\n" + tagModelTurn("Read the current file.", turn) + "\n</user_query>";
  const call = async (lease: typeof first, content: string, id = session, index = "1") => {
    const response = await fetch(lease.config.baseUrl + "/chat/completions", { method: "POST", headers: {
      authorization: "Bearer " + lease.token, "x-grok-session-id": id, "x-grok-turn-idx": index, "content-type": "application/json",
    }, body: JSON.stringify({ model: f.config.model, messages: [{ role: "user", content },
      { role: "user", content: "<system-reminder>\nThe native tool catalogue is ready.\n</system-reminder>" }] }) });
    await response.text();
    return response.status;
  };
  try {
    first.bindNativeTurn(prior, session);
    assert.equal(await call(first, query(prior), ""), 403);
    assert.equal(await call(first, query(prior), session, ""), 403);
    assert.equal(await call(first, tagModelTurn("Unwrapped request", prior)), 403);
    assert.equal(await call(first, query(prior)), 200);
    await first.release();
    const second = await first.acquire();
    second.bindNativeTurn(current, session);
    assert.equal(await call(second, query(prior), session, "2"), 403);
    assert.equal(await call(second, query(current), "foreign-session", "2"), 403);
    assert.equal(await call(second, query(current), session, "2"), 200);
    assert.equal(f.requests.length, 2);
    assert(f.requests.every(request => request.messages[0].content === "<user_query>\nRead the current file.\n</user_query>"));
    await second.release();
  } finally { await f.close(); }
});

test("retained Messages routes admit only the bound session and latest text turn", async () => {
  const f = await setup((body, res) => respond(res, body.model, "observed response"));
  const prior = randomUUID(), current = randomUUID(), session = randomUUID();
  const first = await f.gateway.lease(f.config, undefined, "messages");
  first.session(session, f.directory);
  const messages = (id: string) => [{ role: "user", content: tagModelTurn("read fixture", id) }];
  const call = (lease: typeof first, body: unknown[], sessionId = session) => fetch(lease.config.baseUrl + "/messages", {
    method: "POST", headers: { "x-api-key": lease.token, "x-claude-code-session-id": sessionId, "content-type": "application/json" },
    body: JSON.stringify({ model: f.config.model, messages: body }),
  });
  const status = async (response: Promise<Response>) => { const value = await response; await value.text(); return value.status; };
  try {
    assert.equal(await status(call(first, messages(prior))), 403);
    first.bindNativeTurn(prior);
    assert.equal(await status(call(first, messages(prior))), 200);
    await first.release();
    const second = await first.acquire();
    assert.equal(await status(call(second, messages(prior))), 403);
    second.bindNativeTurn(current);
    assert.equal(await status(call(second, messages(prior))), 403);
    assert.equal(await status(call(second, messages(current), "foreign-session")), 403);
    assert.equal(await status(call(second, [...messages(current), { role: "user", content: "unbound newer request" }])), 403);
    assert.equal(await status(call(second, [...messages(prior), ...messages(current),
      { role: "assistant", content: [{ type: "tool_use", id: "read-call", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "read-call", content: "current file" }] },
    ])), 200);
    assert.equal(f.requests.length, 2);
    assert(!JSON.stringify(f.requests).includes("teamswarm-turn:"));
    assert(JSON.stringify(f.requests[1]).includes("current file"));
    await second.release();
  } finally { await f.close(); }
});

for (const harness of ["claude-code", "deepseek-harness"] as const)
for (const protocol of ["anthropic-messages", "responses", "chat-completions"] as const)
  test(`${harness} ${protocol} folds only an exact prior read while preserving current tool results`, async () => {
    const f = await setup((body, res) => respond(res, body.model, "verified"));
    const old = randomUUID(), current = randomUUID(), session = randomUUID(), citation = randomUUID();
    const original = JSON.stringify({ path: "prior.txt", text: "old-result".repeat(280) });
    const fresh = "current-file-result";
    const unknown = "unverified-prior-result";
    const digest = (await import("node:crypto")).createHash("sha256").update(original).digest("hex");
    const lease = await f.gateway.lease({ ...f.config, harness, protocol }, undefined, "messages");
    const observed: any[] = [];
    lease.observe(event => observed.push(event));
    lease.session(session, f.directory);
    lease.bindNativeTurn(current);
    lease.bindPriorToolReads(turns => {
      assert.deepEqual(turns, [old]);
      return [
        { id: citation, turnId: old, toolId: "toolu_prior", sha256: digest },
        { id: randomUUID(), turnId: current, toolId: "toolu_fresh", sha256: digest },
        ...["toolu_reused", "toolu_ambiguous", "toolu_ambiguous"].map(toolId => ({ id: randomUUID(), turnId: old, toolId, sha256: digest })),
      ];
    });
    const ask = (turn: string) => ({ role: "user", content: tagModelTurn("Read the project", turn) });
    const call = (id: string) => ({ role: "assistant", content: [
      { type: "tool_use", id, name: "mcp__teamswarm__team_read_file", input: { path: "project.txt" } },
    ] });
    const output = (id: string, text: string) => ({ role: "user", content: [
      { type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] },
    ] });
    try {
      const response = await fetch(lease.config.baseUrl + "/messages", {
        method: "POST", headers: { "x-api-key": lease.token, [`x-${harness}-session-id`]: session, "content-type": "application/json" },
        body: JSON.stringify({
          model: f.config.model, stream: true, max_tokens: 128,
          messages: [ask(old), call("toolu_prior"), output("toolu_prior", original),
            call("toolu_unknown"), output("toolu_unknown", unknown),
            call("toolu_reused"), output("toolu_reused", original), call("toolu_ambiguous"), output("toolu_ambiguous", original),
            ask(current), call("toolu_fresh"), output("toolu_fresh", fresh), call("toolu_reused")],
        }),
      });
      await response.text();
      assert.equal(response.status, 200);
      assert.equal(observed.at(-1).foldedToolResults, 1);
      const payload = JSON.stringify(f.requests.at(-1));
      assert.ok(payload.includes("tool-result:" + citation));
      assert.equal(payload.split("old-result".repeat(280)).length - 1, 2, "Ambiguous calls must retain their original results");
      assert.ok(payload.includes(fresh));
      assert.ok(payload.includes(unknown));
      await lease.release();
    } finally { await f.close(); }
  });

test("an OpenCode route fences late completions and checks the native session independently", async () => {
  const f = await setup((body, res) => respond(res, body.model, "observed response"));
  const oldId = randomUUID(), newId = randomUUID(), owner = randomUUID();
  const native = "ses_" + randomUUID();
  const first = await f.gateway.lease({ ...f.config, harness: "opencode" }, undefined, "chat-completions");
  first.session(owner, f.directory);
  const user = (id: string) => ({ role: "user", content: [{ type: "text", text: tagModelTurn("read the active file", id) }] });
  const call = async (lease: typeof first, messages: unknown[], sessionId = native) => {
    const response = await fetch(lease.config.baseUrl + "/chat/completions", {
      method: "POST", headers: { authorization: "Bearer " + lease.token, "x-opencode-session-id": sessionId, "content-type": "application/json" },
      body: JSON.stringify({ model: f.config.model, messages }),
    });
    await response.text();
    return response.status;
  };
  try {
    first.bindNativeTurn(oldId, native);
    assert.equal(await call(first, [user(oldId)]), 200);
    await first.release();
    const second = await first.acquire();
    assert.equal(await call(second, [user(newId)]), 403);
    second.bindNativeTurn(newId, native);
    assert.equal(await call(second, [user(oldId)]), 403);
    assert.equal(await call(second, [user(newId)], owner), 403);
    assert.equal(await call(second, [user(newId), { role: "user", content: null }]), 403);
    assert.equal(await call(second, [user(oldId), user(newId)]), 200);
    assert.equal(f.requests.length, 2);
    assert(!JSON.stringify(f.requests).includes("teamswarm-turn:"));
    await second.release();
  } finally { await f.close(); }
});

test("Responses connection is selectable independently for all six Harnesses",()=>{
  for(const harness of ["codex","claude-code","pi","grok","deepseek-harness","opencode"]){
    assert.equal(resolveConnection({name:"models",endpoints:{responses:"https://example.com/v1"},credentialEnv:"MODEL_KEY",models:["gpt-test"]},harness,"gpt-test","read-only").config.protocol,"responses");
  }
});

test("selected model effort reaches Responses through every native Harness protocol",async()=>{
  const f=await setup((body,res)=>respond(res,body.model,"effort applied"));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>originalFetch(String(input)==="https://api.openai.com/v1/responses"?f.config.baseUrl+"/responses":input,init);
  f.gateway.accounts.accessToken=async()=>"fixture-key";
  try {
    for(const harness of ["codex","claude-code","grok","pi","opencode","deepseek-harness"]) for (const effort of ["low", "high", null]) {
      const receipts: any[] = [];
      const lease=await f.gateway.lease({...f.config,harness,effort,baseUrl:null,credentialEnv:null,chatgptAccountId:"11111111-1111-4111-8111-111111111111"});
      lease.observe(receipt => receipts.push(receipt));
      const protocol=lease.config.protocol;
      const endpoint=protocol==="responses"?"/responses":protocol==="anthropic-messages"?"/messages":"/chat/completions";
      const body=protocol==="responses"?{model:"gpt-test",input:[{role:"user",content:"Read the message"}],stream:true}
        :{model:"gpt-test",messages:[{role:"user",content:"Read the message"}],max_tokens:128,stream:true};
      const response=await fetch(lease.config.baseUrl+endpoint,{method:"POST",headers:{authorization:"Bearer "+lease.token,"x-api-key":lease.token,"content-type":"application/json"},body:JSON.stringify(body)});
      assert.equal(response.status,200,await response.text());
      assert.equal(f.requests.at(-1).reasoning?.effort,effort ?? undefined,harness);
      assert.equal(receipts.length, 2);
      assert.equal(receipts[0].status, "prepared");
      assert.equal(receipts[1].status, "accepted");
      assert.equal(receipts[1].httpStatus, 200);
      assert.equal(receipts[1].harness, harness);
      assert.equal(receipts[1].nativeProtocol, protocol);
      assert.equal(receipts[1].protocol, "responses");
      assert.equal(receipts[1].model, f.requests.at(-1).model);
      assert.equal(receipts[1].effort, f.requests.at(-1).reasoning?.effort ?? null);
      assert.equal(receipts[1].effortParameter, effort ? "reasoning.effort" : null);
      assert.equal(JSON.stringify(receipts).includes("fixture-key"), false);
      assert.equal(JSON.stringify(receipts).includes("Read the message"), false);
      lease.release();
    }
  }finally{globalThis.fetch=originalFetch;await f.close();}
});

test("warm native sessions reuse their own model transport only while an attempt is active",async()=>{
  const f=await setup((body,res)=>respond(res,body.model,"native reply"));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>originalFetch(String(input)==="https://api.openai.com/v1/responses"?f.config.baseUrl+"/responses":input,init);
  f.gateway.accounts.accessToken=async()=>"fixture-key";
  const transports=new Map<string,{url:string;token:string}>();
  let observer:HarnessRequest["onEvent"]|undefined;
  const turns = new Map<string, string>(); let sequence = 0;
  const call=({url,token}:{url:string;token:string},session?:string,turn?:string)=>fetch(url+"/responses",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json",...(session ? {"x-codex-turn-metadata":JSON.stringify({session_id:session,thread_id:session,turn_id:turn})}: {})},body:JSON.stringify({model:"gpt-test",input:[{role:"user",content:"Continue"}],stream:false})});
  const native={id:"codex",execute:async(r:HarnessRequest)=>{
    observer=r.onEvent;
    r.onEvent({type:"resource.acquired",data:{id:"warm-process",scope:"harness"}});
    const session=r.sessionId??"session-a";
    // The native process keeps the first provider address for a loaded thread.
    if(!transports.has(session))transports.set(session,{url:r.config.baseUrl!,token:r.modelRoute!.token});
    r.onSession(session);
    const turn = `turn-${++sequence}`, previous = turns.get(session); turns.set(session, turn);
    r.modelRoute!.bindRequestScope!(identity => identity.sessionId === session && identity.turnId === turn);
    if (previous) assert.equal((await call(transports.get(session)!,session,previous)).status,403);
    const response=await call(transports.get(session)!,session,turn);
    assert.equal(response.status,200);await response.text();
    return {status:"completed",text:"native reply"};
  },close:async()=>{observer?.({type:"resource.released",data:{id:"warm-process",scope:"harness"}});transports.clear();}} as unknown as Harness;
  const harness=f.gateway.wrap(native);
  const request:HarnessRequest={workspace:f.directory,config:{...f.config,harness:"codex",baseUrl:null,credentialEnv:null,chatgptAccountId:"11111111-1111-4111-8111-111111111111"},instructions:"Fixture",input:"Fixture",tools:[],onSession:()=>{},onTurn:()=>{},onEvent:()=>{},onTool:async()=>{throw Error("No Team tools expected");}};
  try{
    await harness.execute(request);
    const first=transports.get("session-a")!;
    assert.equal((await call(first)).status,403);
    await harness.execute({...request,sessionId:"session-a"});
    assert.deepEqual(transports.get("session-a"),first);
    assert.equal((await call(first)).status,403);
    await harness.execute({...request,sessionId:"session-b"});
    assert.notEqual(transports.get("session-b")!.url,first.url);
    await assert.rejects(harness.execute({...request,sessionId:"session-a",workspace:path.join(f.directory,"other")}),/configuration or workspace changed/);
    await harness.close();
    await harness.execute({...request,sessionId:"session-a"});
    assert.notEqual(transports.get("session-a")!.url,first.url);
    assert.equal((await call(first)).status,403);
    assert.deepEqual(f.gateway.state(),{routes:0,requests:0});
    assert.equal(f.requests.length,4);
  }finally{globalThis.fetch=originalFetch;await harness.close();await f.close();}
});

test("a waiting native process cannot claim CPU against a revoked model lease", async () => {
  const f = await setup(() => assert.fail("no model request before process claim"));
  const wake = Promise.withResolvers<void>();
  let claims = 0;
  const harness = f.gateway.wrap({ id: "claude-code", execute: async (r: HarnessRequest) => {
    const blocked = r.admitProcess!({ id: "owned-group", pid: 42 });
    assert(blocked instanceof Promise);
    await r.modelRoute!.release!();
    wake.resolve(); await blocked;
    r.admitProcess!(); // wake after losing both the process and the route
    return { status: "completed", text: "" };
  } } as Harness);
  try {
    await assert.rejects(harness.execute({ workspace:f.directory, config:f.config, tools:[],
      admitProcess: () => { claims++; return wake.promise; }, onEvent: () => {}, onSession: () => {},
      onTurn: () => {}, onTool: async () => {}, instructions:"", input:"" }), /execution lease has ended/);
    assert.equal(claims, 1); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("model request identities keep child usage outside the root context budget", async () => {
  const f = await setup((body, res) => {
    res.writeHead(200, {"content-type":"text/event-stream"});
    const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    send({id:"fixture",object:"chat.completion.chunk",model:body.model,choices:[{index:0,delta:{role:"assistant",content:"reply"},finish_reason:null}]});
    send({id:"fixture",object:"chat.completion.chunk",model:body.model,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:25,completion_tokens:3,total_tokens:28}});
    res.end("data: [DONE]\n\n");
  });
  const events: any[] = [];
  const native = { id:"codex", async execute(r: HarnessRequest) {
    r.onSession("root", {});
    r.modelRoute!.bindRequestScope!(scope => scope.sessionId === "root" && scope.turnId === "active-turn");
    for (const thread of ["root", "child"]) {
      const response = await fetch(r.config.baseUrl + "/responses", { method:"POST", headers:{ authorization:"Bearer "+r.modelRoute!.token,
        "x-codex-turn-metadata":JSON.stringify({session_id:"root",thread_id:thread,turn_id:"active-turn",...(thread==="child"?{parent_thread_id:"root"}:{})}) },
        body:JSON.stringify({model:r.config.model,input:[{role:"user",content:"Report the observed input"}],stream:true}) });
      assert.equal(response.status,200); await response.text();
    }
    return {status:"completed",text:"reply"};
  }, async close() {} } as unknown as Harness;
  try {
    await f.gateway.wrap(native).execute({workspace:f.directory,config:{...f.config,harness:"codex",protocol:"chat-completions"},instructions:"Fixture",input:"Fixture",tools:[],onSession(){},onTurn(){},onTool:async()=>({}),onEvent:e=>events.push(e)});
    assert.equal(events.filter(e=>e.type==="context.usage").length,1);
    assert.equal(events.filter(e=>e.type==="subagent.usage").length,1);
    assert.equal(events.find(e=>e.type==="subagent.usage").data.nativeThreadId,"child");
    assert.equal(events.filter(e=>e.type==="model.request").length,2,JSON.stringify(events.filter(e=>e.type==="model.request").map(e=>[e.data.status,e.data.fault,e.data.httpStatus,e.data.id])));
    assert.equal(events.filter(e=>e.type==="subagent.model.request").length,2);
  } finally { await f.close(); }
});

test("a child consumes a durable streamed parent prefix before the parent stream fails", { timeout: 10000 }, async () => {
  let parentResponse!: ServerResponse;
  const emit = (response: ServerResponse, type: string, data: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify({type,...data as object})}\n\n`);
  const f = await setup((body, res) => {
    res.writeHead(200, {"content-type":"text/event-stream"});
    emit(res,"message_start",{message:{id:"provider-message",type:"message",role:"assistant",model:body.model,content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}}});
    if (JSON.stringify(body.messages).includes("child continuation")) {
      emit(res,"content_block_start",{index:0,content_block:{type:"text",text:""}});
      emit(res,"content_block_delta",{index:0,delta:{type:"text_delta",text:"child reply"}});
      emit(res,"content_block_stop",{index:0});
      emit(res,"message_delta",{delta:{stop_reason:"end_turn"},usage:{output_tokens:3}});
      emit(res,"message_stop",{});res.end();return;
    }
    parentResponse = res;
    emit(res,"content_block_start",{index:0,content_block:{type:"thinking",thinking:"",signature:""}});
    emit(res,"content_block_delta",{index:0,delta:{type:"thinking_delta",thinking:"fixture note"}});
    emit(res,"content_block_delta",{index:0,delta:{type:"signature_delta",signature:"parent-signature"}});
    emit(res,"content_block_stop",{index:0});
    emit(res,"content_block_start",{index:1,content_block:{type:"tool_use",id:"first_tool",name:"Read",input:{}}});
    emit(res,"content_block_delta",{index:1,delta:{type:"input_json_delta",partial_json:'{"file":"source"}'}});
    emit(res,"content_block_stop",{index:1});
    emit(res,"content_block_start",{index:2,content_block:{type:"tool_use",id:"unfinished_tool",name:"Read",input:{}}});
    emit(res,"content_block_delta",{index:2,delta:{type:"input_json_delta",partial_json:'{"file":'}});
  });
  const config = {...f.config,harness:"codex",protocol:"anthropic-messages" as const};
  const lease = await f.gateway.lease(config); lease.session("root", f.directory);
  const call = (thread: string, input: unknown[]) => fetch(lease.config.baseUrl+"/responses", {method:"POST",headers:{
    authorization:"Bearer "+lease.token,"x-codex-turn-metadata":JSON.stringify({session_id:"root",thread_id:thread,turn_id:"current",...(thread==="root"?{}:{parent_thread_id:"root"})}),
  },body:JSON.stringify({model:config.model,stream:true,input})});
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const parent = await call("root",[{role:"user",content:"parent request"}]); assert.equal(parent.status,200);
    reader = parent.body!.getReader(); const decoder = new TextDecoder(); let buffer=""; const items:any[]=[];
    while (!items.some(item=>item.type==="function_call")) {
      const chunk=await reader.read(); assert.equal(chunk.done,false); buffer+=decoder.decode(chunk.value);
      let end;
      while((end=buffer.indexOf("\n\n"))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const line=frame.split("\n").find(l=>l.startsWith("data: "));if(line){const e=JSON.parse(line.slice(6));if(e.type==="response.output_item.done")items.push(e.item);}}
    }
    const result=await call("child",[{role:"user",content:"parent request"},...items,
      {type:"function_call_output",call_id:items.find(i=>i.type==="function_call").call_id,output:"observed file"},
      {role:"user",content:"child continuation"}]);
    assert.equal(result.status,200);assert.match(await result.text(),/child reply/);
    const inherited = f.requests[1].messages.find((m:any)=>m.role==="assistant");
    assert.equal(inherited.content.find((b:any)=>b.type==="thinking").signature,"parent-signature");
    assert.equal(inherited.content.find((b:any)=>b.type==="tool_use").id,"first_tool");
    const persisted=readdirSync(path.join(f.directory,"model-sessions")).map(file=>readFileSync(path.join(f.directory,"model-sessions",file),"utf8"));
    assert.equal(persisted.length,2);assert(persisted.every(text=>text.includes("parent-signature")&&!text.includes("unfinished_tool")));
    emit(parentResponse,"error",{error:{type:"overloaded_error",message:"Parent stream interrupted"}});parentResponse.end();
    let rest=buffer;
    for(;;){const chunk=await reader.read();if(chunk.done)break;rest+=decoder.decode(chunk.value);}
    assert.match(rest,/event: error/);assert(!rest.includes('"type":"response.completed"'));
  } finally {parentResponse?.end();await reader?.cancel();await f.close();}
});

test("model leases drain old responses before binding the next execution", async () => {
  const f = await setup((body, res) => respond(res, body.model, "second execution"));
  const originalFetch = globalThis.fetch;
  let releaseUpstream!: (response: Response) => void;
  let prepared!: () => void;
  const preparedRequest = new Promise<void>(resolve => { prepared = resolve; });
  const firstReceipts: any[] = [], secondReceipts: any[] = [];
  const first = await f.gateway.lease(f.config);
  let hold = true;
  globalThis.fetch = (input, init) => {
    if (hold && String(input) === f.config.baseUrl + "/responses") {
      hold = false;
      return new Promise<Response>(resolve => { releaseUpstream = resolve; });
    }
    return originalFetch(input, init);
  };
  const call = (lease: typeof first) => originalFetch(lease.config.baseUrl + "/responses", {
    method: "POST", headers: { authorization: "Bearer " + lease.token, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-test", input: "Fixture", stream: false }),
  }).then(response => response.text());
  let firstResponse: Promise<unknown> | undefined;
  try {
    first.observe(receipt => { firstReceipts.push(receipt); if (receipt.status === "prepared") prepared(); });
    firstResponse = call(first).catch(error => error);
    await preparedRequest;
    assert.equal(f.gateway.state().requests, 1);
    const drained = first.release();
    let acquired = false;
    const next = Promise.resolve(first.acquire()).then(lease => {
      acquired = true;
      const current = lease ?? first;
      current.observe(receipt => secondReceipts.push(receipt));
      return current;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(acquired, false);
    releaseUpstream(new Response(JSON.stringify({ id: "old-response", model: "gpt-test", output: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    await firstResponse;
    await drained;
    const second = await next;
    assert.deepEqual(secondReceipts, []);
    assert.equal(f.gateway.state().requests, 0);
    await first.release();
    assert.equal(f.gateway.state().routes, 1);
    await call(second);
    assert.deepEqual(secondReceipts.map(receipt => receipt.status), ["prepared", "accepted"]);
    assert(secondReceipts.every(receipt => !firstReceipts.some(old => old.id === receipt.id)));
    assert.equal(firstReceipts[0].routeGeneration, 1);
    assert.equal(secondReceipts[0].routeGeneration, 2);
    await second.release();
  } finally {
    releaseUpstream?.(new Response("{}", { headers: { "content-type": "application/json" } }));
    await firstResponse;
    globalThis.fetch = originalFetch;
    await f.close();
  }
});

test("releasing a model lease cancels an incomplete request body and permits the next lease", async () => {
  const f = await setup((body, res) => respond(res, body.model, "next request"));
  const first = await f.gateway.lease(f.config);
  const request = httpRequest(first.config.baseUrl + "/responses", {
    method: "POST", headers: { authorization: "Bearer " + first.token, "content-type": "application/json", "content-length": "1000" },
  });
  request.on("error", () => {});
  request.on("response", response => response.resume());
  try {
    request.write('{"model":');
    const deadline = Date.now() + 3000;
    while (!f.gateway.state().requests) {
      assert(Date.now() < deadline, "Request headers must reach the local gateway");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await first.release();
    const second = await first.acquire();
    assert.equal(f.gateway.state().requests, 0);
    assert.equal(f.requests.length, 0);
    await second.release();
  } finally { request.destroy(); await f.close(); }
});

test("a late partial request retains its rejected scope while the next scope binds", { timeout: 5000 }, async () => {
  const f = await setup((body, res) => respond(res, body.model, "current execution"));
  const lease = await f.gateway.lease({ ...f.config, harness: "codex" });
  let entered!: () => void, rejectOld!: (allow: boolean) => void;
  const headersSeen = new Promise<void>(resolve => { entered = resolve; });
  lease.session("root", f.directory);
  lease.bindRequestScope(() => { entered(); return new Promise(resolve => { rejectOld = resolve; }); });
  const old = httpRequest(lease.config.baseUrl + "/responses", { method: "POST", headers: {
    authorization: "Bearer " + lease.token, "content-length": 10000,
    "x-codex-turn-metadata": JSON.stringify({ session_id: "root", thread_id: "root", turn_id: "old" }),
  } });
  old.on("error", () => {}); old.on("response", response => response.resume());
  try {
    old.write('{"model":'); await headersSeen;
    lease.bindRequestScope(scope => scope.turnId === "current");
    rejectOld(false);
    const result = await fetch(lease.config.baseUrl + "/responses", { method: "POST", headers: {
      authorization: "Bearer " + lease.token,
      "x-codex-turn-metadata": JSON.stringify({ session_id: "root", thread_id: "root", turn_id: "current" }),
    }, body: JSON.stringify({ model: "gpt-test", input: "Current execution" }) });
    assert.equal(result.status, 200); await result.text();
    assert.equal(f.requests.length, 1);
  } finally { rejectOld?.(false); old.destroy(); await f.close(); }
});

test("Grok subscription route normalizes metadata events and round-trips native tool results",async()=>{
  const f=await setup((body,res)=>respond(res,body.model,
    body.input.some((v:any)=>v.type==="function_call_output") ? "native command received" : {name:"run_terminal_command",arguments:{command:"node verify.cjs"}},true,true));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>originalFetch(String(input)==="https://api.openai.com/v1/responses"?f.config.baseUrl+"/responses":input,init);
  f.gateway.accounts.accessToken=async()=>"fixture-key";
  try{
    const lease=await f.gateway.lease({...f.config,harness:"grok",baseUrl:null,credentialEnv:null,chatgptAccountId:"11111111-1111-4111-8111-111111111111"});
    assert.equal(lease.config.protocol,"chat-completions");
    const messages:any[]=[{role:"user",content:"Run the command"}];
    const call=()=>fetch(lease.config.baseUrl+"/chat/completions",{method:"POST",headers:{authorization:"Bearer "+lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",stream:true,messages,tools:[{type:"function",function:{name:"run_terminal_command",parameters:{type:"object",properties:{command:{type:"string"}},required:["command"]}}}]})});
    const first=await call();assert.equal(first.status,200);const stream=await first.text();
    assert.ok(!stream.includes("response.metadata"));
    const chunks=stream.split("\n").filter(l=>l.startsWith("data: {")).map(l=>JSON.parse(l.slice(6)));
    const deltas=chunks.flatMap(c=>c.choices?.[0]?.delta?.tool_calls??[]);
    const tool={id:deltas.find(d=>d.id)?.id,type:"function",function:{name:deltas.find(d=>d.function?.name)?.function.name,arguments:deltas.map(d=>d.function?.arguments??"").join("")}};
    assert.ok(tool.id);assert.equal(tool.function.name,"run_terminal_command");assert.equal(JSON.parse(tool.function.arguments).command,"node verify.cjs");
    messages.push({role:"assistant",content:null,tool_calls:[tool]},{role:"tool",tool_call_id:tool.id,content:"NATIVE_RESULT_42"});
    const second=await call();assert.equal(second.status,200);assert.match(await second.text(),/native command received/);
    assert.ok(f.requests[0].input.some((v:any)=>v.type==="additional_tools"));
    assert.ok(f.requests[1].input.some((v:any)=>v.type==="function_call_output"&&v.output==="NATIVE_RESULT_42"));
    lease.release();assert.deepEqual(f.gateway.state(),{routes:0,requests:0});
  }finally{globalThis.fetch=originalFetch;await f.close();}
});

test("ChatGPT requests use the public stateless protocol and supported tool declarations",()=>{
  const payload=chatGPTPayload({model:"fixture",input:[{type:"message",role:"system",content:"instructions"},{role:"user",content:"task"}],
    store:true,stream:false,max_output_tokens:8192,metadata:{user:"native"},temperature:1,top_p:1,prompt_cache_retention:"24h",previous_response_id:"old",
    tools:[{type:"function",name:"Read",parameters:{type:"object",properties:{}}}],tool_choice:{type:"function",name:"Read"}});
  assert.equal(payload.store,false);assert.equal(payload.stream,true);assert.equal(payload.previous_response_id,undefined);
  for(const key of ["max_output_tokens","metadata","temperature","top_p","prompt_cache_retention"])assert.equal(payload[key],undefined);
  assert.equal(payload.input[0].type,"additional_tools");assert.equal(payload.input[0].tools[0].name,"Read");
  assert.equal(payload.input[0].tools[0].strict,false);
  assert.equal(payload.input[1].role,"developer");assert.equal(payload.tools,undefined);
  assert.deepEqual(payload.tool_choice,{type:"function",name:"Read"});assert.ok(payload.include.includes("reasoning.encrypted_content"));
});
test("Claude keeps its native tools and Team schemas through the shared ChatGPT route",async()=>{
  const topic = teamTools.team_host_note.schema.shape.topic;
  for (const value of ["阅读/章节_2", "résumé/٢", "project-notes"]) assert.equal(topic.parse(value), value);
  for (const value of ["", "has spaces", "<script>", "notes😀", "a".repeat(121)]) assert.equal(topic.safeParse(value).success, false);
  const nativeTools = [
    {name:"Read",input_schema:{type:"object",properties:{file_path:{type:"string"}},required:["file_path"]}},
    ...toolSpecs.map(t=>({name:`mcp__teamswarm__${t.name}`,description:t.description,input_schema:t.inputSchema})),
  ];
  const f=await setup((body,res)=>{
    const declarations=body.input.find((v:any)=>v.type==="additional_tools").tools;
    assert.deepEqual(declarations.map((t:any)=>t.name),nativeTools.map(t=>t.name));
    assert(declarations.every((t:any)=>t.strict===false),"Native optional fields must not be made required by Responses defaults");
    const schema=declarations.find((t:any)=>t.name==="mcp__teamswarm__team_host_note").parameters.properties.topic;
    assert.equal(schema.type,"string");assert.equal(schema.maxLength,120);
    assert.equal(schema.pattern,undefined);assert.match(schema.description,/Letters and numbers/);
    if(body.input.some((v:any)=>v.type==="function_call_output")) respond(res,body.model,"native read result received");
    else respond(res,body.model,{name:"Read",arguments:{file_path:"task.txt"}});
  });
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>originalFetch(String(input)==="https://api.openai.com/v1/responses"?f.config.baseUrl+"/responses":input,init);
  f.gateway.accounts.accessToken=async()=>"fixture-key";
  try{
    const lease=await f.gateway.lease({...f.config,baseUrl:null,credentialEnv:null,chatgptAccountId:"11111111-1111-4111-8111-111111111111"});
    assert.equal(lease.config.harness,"claude-code");assert.equal(lease.config.protocol,"anthropic-messages");
    const messages:any[]=[{role:"user",content:"Read task.txt with your native Read tool"}];
    const call=async()=>{
      const response=await fetch(lease.config.baseUrl+"/messages",{method:"POST",headers:{"x-api-key":lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",max_tokens:1000,messages,tools:nativeTools})});
      assert.equal(response.status,200);return await response.json() as any;
    };
    const first=await call();assert.equal(first.stop_reason,"tool_use");assert.equal(first.content[0].name,"Read");
    assert.deepEqual(first.content[0].input,{file_path:"task.txt"});
    messages.push({role:"assistant",content:first.content},{role:"user",content:[{type:"tool_result",tool_use_id:first.content[0].id,content:"NATIVE_READ_42"}]});
    const second=await call();assert.equal(second.content[0].text,"native read result received");
    const result=f.requests[1].input.find((v:any)=>v.type==="function_call_output");
    assert.equal(result.call_id,"call_fixture");assert.equal(result.output,"NATIVE_READ_42");
    lease.release();assert.deepEqual(f.gateway.state(),{routes:0,requests:0});
  }finally{globalThis.fetch=originalFetch;await f.close();}
});

test("Responses preserves native optional fields and explicit strict declarations",()=>{
  const schema={type:"object",properties:{file_path:{type:"string"},pages:{type:"string"}},required:["file_path"]};
  const payload:any={tools:[{type:"function",name:"Read",parameters:schema},{type:"function",name:"Strict",parameters:schema}]};
  requestOptions("responses",{tools:[{name:"Read",input_schema:schema},{type:"function",function:{name:"Strict",parameters:schema,strict:true}}]},payload);
  const converted=chatGPTPayload(payload).input[0].tools;
  assert.equal(converted[0].strict,false);assert.equal(converted[1].strict,true);
  assert.deepEqual(converted[0].parameters.required,["file_path"]);
  assert.deepEqual(converted[0].parameters.properties.pages,{type:"string"});
  assert.deepEqual(schema.required,["file_path"]);
});

test("structured response requests retain schemas across protocols",()=>{
  const schema={type:"object",properties:{answer:{type:"string"}},required:["answer"],additionalProperties:false};
  const payload:any={};requestOptions("responses",{output_config:{format:{type:"json_schema",schema}}},payload);
  assert.deepEqual(payload.text.format.schema,schema);assert.equal(payload.text.format.strict,true);
  const native:any={};requestOptions("anthropic-messages",payload,native);assert.deepEqual(native.output_config.format.schema,schema);
});
test("parallel Responses tools stay in one assistant turn and preserve free-form input",()=>{
  const model:any={id:"model",api:"anthropic-messages",provider:"teamswarm",baseUrl:"http://fixture",input:["text"]};
  const context=decodeRequest("responses",{tools:[{type:"custom",name:"apply_patch",description:"Apply patch"}],input:[
    {type:"function_call",name:"first",call_id:"call_a",arguments:'{"x":1}'},
    {type:"function_call",name:"second",call_id:"call_b",arguments:'{"x":2}'},
    {type:"function_call_output",call_id:"call_a",output:"first-real-result"},
    {type:"function_call_output",call_id:"call_b",output:"second-real-result"},
    {type:"custom_tool_call",name:"apply_patch",call_id:"call_c",input:"*** patch ***"},
    {type:"custom_tool_call_output",call_id:"call_c",output:"patch-applied"},
  ]},model);
  const normalized=transformMessages(context.messages,model);
  assert.equal(normalized.filter(m=>m.role==="toolResult").length,3);
  assert.ok(!JSON.stringify(normalized).includes("No result provided"));
  const last=context.messages.at(-2) as any;
  const output=encodeResponse("responses",last,undefined,new Set(["apply_patch"]));
  assert.equal(output.output[0].type,"custom_tool_call");assert.equal(output.output[0].input,"*** patch ***");
});

test("namespaced functions and custom tools preserve distinct identities through flat protocols and streaming replies", () => {
  const model: any = { id: "model", api: "openai-completions", provider: "teamswarm", input: ["text"] };
  const input: any = { tools: [
    { type: "namespace", name: "source", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
    { type: "namespace", name: "notes", tools: [{ type: "function", name: "read", parameters: { type: "object" } }, { type: "custom", name: "patch" }] },
  ], tool_choice: { type: "function", namespace: "notes", name: "read" }, input: [
    { type: "function_call", namespace: "source", name: "read", call_id: "call-a", arguments: '{}' },
    { type: "function_call_output", call_id: "call-a", output: "source content" },
    { type: "function_call", namespace: "notes", name: "read", call_id: "call-b", arguments: '{}' },
    { type: "function_call_output", call_id: "call-b", output: "note content" },
    { type: "custom_tool_call", namespace: "notes", name: "patch", call_id: "call-c", input: "*** actual patch ***" },
    { type: "custom_tool_call_output", call_id: "call-c", output: "applied" },
  ] };
  const converted = flattenToolNamespaces(input), names = converted.body.tools.map((t: any) => t.name);
  assert.equal(new Set(names).size, 3); assert(names.every((n: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)));
  assert.equal(converted.body.tool_choice.name, names[1]);
  const context = decodeRequest("responses", converted.body, model);
  assert.equal((context.messages[0] as any).content[0].name, names[0]);
  assert.equal((context.messages[2] as any).content[0].name, names[1]);
  const custom = new Set<string>([names[2]]), last = context.messages.at(-2) as any;
  const response = encodeResponse("responses", last, undefined, custom, converted.namespaces);
  assert.equal(response.output[0].namespace, "notes"); assert.equal(response.output[0].name, "patch");
  assert.equal(response.output[0].input, "*** actual patch ***");
  const packets: string[] = [], encoder = new WireStream("responses", p => packets.push(p), custom, converted.namespaces);
  encoder.eventFor({ type: "toolcall_start", contentIndex: 0, partial: last });
  encoder.eventFor({ type: "toolcall_end", contentIndex: 0, partial: last, toolCall: last.content[0] });
  encoder.eventFor({ type: "done", reason: "toolUse", message: last });
  const items = packets.map(p => JSON.parse(p.split("data: ")[1])).flatMap(e => e.item ? [e.item] : e.response?.output ?? []);
  assert(items.every(i => i.name === "patch" && i.namespace === "notes"));
  assert.equal(flattenToolNamespaces({ tools: input.tools.slice().reverse() }).body.tools.at(-1).name, names[0]);
  assert.throws(() => flattenToolNamespaces({ tools: [...input.tools, { type: "function", name: names[0] }] }), /conflicts/);
});

test("native agent messages retain sender, recipient and opaque payload without becoming system instructions", () => {
  const item = { type: "agent_message", author: "/root", recipient: "/root/reader", content: [
    { type: "input_text", text: "Delegated task" }, { type: "encrypted_content", encrypted_content: "opaque-original-payload" },
  ] };
  const context = decodeRequest("responses", { instructions: "Authoritative assignment", input: [item] }, { id: "fixture", api: "openai-completions" } as any);
  assert.equal(context.systemPrompt, "Authoritative assignment");
  assert.equal(context.messages[0].role, "user");
  assert.deepEqual(JSON.parse((context.messages[0].content[0] as any).text), item);
});
test("cancelled requests release capacity while a shared account refresh is pending",async()=>{
  const f=await setup((_body,res)=>res.end());
  let finish!:(key:string)=>void;
  f.gateway.accounts.accessToken=()=>new Promise(r=>{finish=r;});
  try{
    const lease=await f.gateway.lease({...f.config,baseUrl:null,credentialEnv:null,chatgptAccountId:"11111111-1111-4111-8111-111111111111"});
    const controller=new AbortController();
    const request=fetch(lease.config.baseUrl+"/messages",{method:"POST",headers:{"x-api-key":lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",messages:[{role:"user",content:"cancel"}]}),signal:controller.signal}).catch(()=>null);
    for(let i=0;i<100&&!finish;i++)await new Promise(r=>setTimeout(r,5));
    assert.ok(finish);lease.release();
    for(let i=0;i<100&&f.gateway.state().requests;i++)await new Promise(r=>setTimeout(r,5));
    assert.deepEqual(f.gateway.state(),{routes:0,requests:0});controller.abort();await request;finish("unused");
  }finally{await f.close();}
});
test("Claude tool call and result round trip through Responses without a second agent",async()=>{
  const f=await setup((body,res)=>{
    if(body.input.some((v:any)=>v.type==="function_call_output")) respond(res,body.model,"tool result received");
    else respond(res,body.model,{name:"Read",arguments:{file_path:"task.txt"}});
  });
  try{
    const lease=await f.gateway.lease(f.config);
    const call=async(messages:any[])=>{
      const response=await fetch(lease.config.baseUrl+"/messages",{method:"POST",headers:{"x-api-key":lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",max_tokens:1000,messages,tools:[{name:"Read",input_schema:{type:"object",properties:{file_path:{type:"string"}},required:["file_path"]}}]})});
      assert.equal(response.status,200);return await response.json() as any;
    };
    const messages:any[]=[{role:"user",content:"Read task.txt"}];
    const first=await call(messages);
    assert.equal(first.stop_reason,"tool_use");assert.equal(first.content[0].name,"Read");
    assert.deepEqual(first.content[0].input,{file_path:"task.txt"});
    messages.push({role:"assistant",content:first.content},{role:"user",content:[{type:"tool_result",tool_use_id:first.content[0].id,content:"fixed-data-42"}]});
    const final=await call(messages);assert.equal(final.content[0].text,"tool result received");
    const returned=f.requests[1].input.find((v:any)=>v.type==="function_call_output");
    assert.equal(returned.call_id,"call_fixture");assert.equal(returned.output,"fixed-data-42");
    assert.equal(f.requests[0].store,false);assert.equal(f.requests[0].stream,true);
    assert.ok(f.requests[0].include.includes("reasoning.encrypted_content"));assert.equal(f.requests[0].reasoning?.effort,undefined);
    lease.release();assert.deepEqual(f.gateway.state(),{routes:0,requests:0});
  }finally{await f.close();}
});
test("8 members and 32 simultaneous requests retain routing and release all leases",async()=>{
  const f=await setup((body,res)=>setTimeout(()=>respond(res,body.model,body.input.find((v:any)=>v.role==="user").content[0].text),15));
  try{
    const leases=await Promise.all(Array.from({length:8},()=>f.gateway.lease(f.config)));
    await Promise.all(leases.flatMap((lease,member)=>Array.from({length:4},async(_,request)=>{
      const expected=`member-${member}-request-${request}`;
      const r=await fetch(lease.config.baseUrl+"/messages",{method:"POST",headers:{"x-api-key":lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",stream:true,messages:[{role:"user",content:expected}]})});
      assert.equal(r.status,200);const body=await r.text();assert.ok(body.includes(expected));assert.ok(body.includes("message_stop"));
    })));
    const wrong=await fetch(leases[0].config.baseUrl+"/messages",{method:"POST",headers:{"x-api-key":leases[1].token},body:"{}"});assert.equal(wrong.status,403);
    leases.forEach(l=>l.release());assert.deepEqual(f.gateway.state(),{routes:0,requests:0});
  }finally{await f.close();}
});
test("upstream quota failure and truncated streams remain errors",async()=>{
  let status=429;
  const f=await setup((body,res)=>{if(status){res.writeHead(status,{"content-type":"application/json","x-request-id":"quota-request"}).end(JSON.stringify({error:{code:status===429?"subscription_sharing_usage_limit_exceeded":"insufficient_balance",message:"Plan usage exhausted",param:"model"}}));}else respond(res,body.model,"partial",false);});
  try{
    const lease=await f.gateway.lease(f.config);
    const receipts: Array<{ status: string; fault?: string }> = [];
    lease.observe(receipt => receipts.push(receipt));
    const call=()=>fetch(lease.config.baseUrl+"/messages",{method:"POST",headers:{"x-api-key":lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",stream:true,messages:[{role:"user",content:"test"}]})});
    let r=await call();assert.equal(r.status,429);const failure=await r.json() as any;assert.equal(failure.error.code,"subscription_sharing_usage_limit_exceeded");assert.equal(failure.upstream.body.error.param,"model");assert.equal(r.headers.get("x-request-id"),"quota-request");
    assert.equal(receipts.at(-1)?.fault, "provider_rate_limit");
    status=402;
    for (const [endpoint, input] of [["messages", { messages: [{ role: "user", content: "test" }] }], ["responses", { input: "test" }]] as const) {
      const rejected=await fetch(lease.config.baseUrl+"/"+endpoint,{method:"POST",headers:{"x-api-key":lease.token,"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",stream:true,...input})});
      assert.equal(rejected.status,402);
      assert.equal(rejected.headers.get("x-request-id"),"quota-request");
      assert.match(await rejected.text(),/insufficient_balance/);
      assert.deepEqual(receipts.slice(-2).map(receipt => [receipt.status, receipt.fault]), [["prepared", undefined], ["rejected", "provider_quota"]]);
    }
    status=0;r=await call();const body=await r.text();assert.match(body,/event: error/);assert.ok(!body.includes("message_stop"));
    assert.equal(receipts.at(-1)?.fault, undefined);
    assert.equal(f.requests.length,4);lease.release();
  }finally{await f.close();}
});

test("upstream socket failures retain request identity on direct and translated protocols", async () => {
  const f = await setup((_body, res) => res.destroy());
  try {
    for (const wire of ["messages", "responses"]) {
      const lease = await f.gateway.lease(f.config);
      const receipts: Array<{ id: string; status: string; fault?: string }> = [];
      lease.observe(receipt => receipts.push(receipt));
      const input = { model: "gpt-test", stream: true, ...(wire === "messages" ? { messages: [{ role: "user", content: "Read" }] } : { input: "Read" }) };
      const response = await fetch(lease.config.baseUrl + "/" + wire, { method: "POST", headers: { "x-api-key": lease.token, "content-type": "application/json" }, body: JSON.stringify(input) });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).error.code, "upstream_network");
      assert.deepEqual(receipts.map(receipt => [receipt.status, receipt.fault]), [["prepared", undefined], ["rejected", "provider_network"]]);
      assert.equal(receipts[0].id, receipts[1].id);
      await lease.release();
    }
  } finally { await f.close(); }
});
test("an upstream response that disconnects after HTTP 200 remains a provider fault", async () => {
  const f = await setup((_body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": ready\n\n");
    setTimeout(() => res.destroy(), 35);
  });
  try {
    const lease = await f.gateway.lease(f.config);
    const receipts: Array<{ id: string; status: string; fault?: string; httpStatus?: number }> = [];
    lease.observe(receipt => receipts.push(receipt));
    const response = await fetch(lease.config.baseUrl + "/responses", {
      method: "POST", headers: { "x-api-key": lease.token, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, input: "Read" }),
    });
    assert.equal(response.status, 200);
    await response.text().catch(() => undefined);
    assert.deepEqual(receipts.map(r => [r.status, r.fault]), [["prepared", undefined], ["accepted", undefined], ["rejected", "provider_network"]]);
    assert.equal(receipts[2].id, receipts[0].id);
    assert.equal(receipts[2].httpStatus, 200);
    await lease.release();
  } finally { await f.close(); }
});

test("native Claude executes its own Bash tool through the model bridge and resumes",{skip:process.env.TEAM_NATIVE_MODEL_TEST!=="1",timeout:120000},async()=>{
  const f=await setup((body,res)=>{
    const outputs=body.input.filter((v:any)=>v.type==="function_call_output");
    if(outputs.length){assert.match(JSON.stringify(outputs),/MODEL_BRIDGE_NATIVE_42/);respond(res,body.model,"MODEL_BRIDGE_NATIVE_COMPLETE");}
    else respond(res,body.model,{name:"Bash",arguments:{command:"echo MODEL_BRIDGE_NATIVE_42",description:"Print the test marker"}});
  });
  const old=process.env.TEAM_HARNESS_HOME;process.env.TEAM_HARNESS_HOME=path.join(f.directory,"sessions");
  const native=new NativeHarness("claude-code"), harness=f.gateway.wrap(native);
  const events:any[]=[];let session:string|undefined;
  try{
    const request={workspace:f.directory,config:f.config,instructions:"Follow the task. Use Bash when needed.",input:"Print the test marker using Bash and report completion.",tools:[],onSession:(id:string)=>{session=id;},onTurn:()=>{},onEvent:(e:any)=>events.push(e),onTool:async()=>{throw new Error("The Team tool bridge must not run Bash.");}};
    const first=await harness.execute(request);
    assert.equal(first.status,"completed",JSON.stringify({first,events}));assert.match(first.text,/MODEL_BRIDGE_NATIVE_COMPLETE/);assert.ok(session);
    const second=await harness.execute({...request,sessionId:session,input:"Report the previous marker again."});
    assert.equal(second.status,"completed",JSON.stringify({second,events}));assert.match(second.text,/MODEL_BRIDGE_NATIVE_COMPLETE/);
    assert.ok(f.requests.some(r=>r.input.some((v:any)=>v.type==="function_call_output")));
    assert.deepEqual(f.gateway.state(),{routes:0,requests:0});assert.equal(native.resources().length,0);
  }finally{await native.close();if(old===undefined)delete process.env.TEAM_HARNESS_HOME;else process.env.TEAM_HARNESS_HOME=old;await f.close();}
});

for (const id of ["pi", "deepseek-harness", "grok", "opencode", "claude-code"] as const) {
  test(`installed ${id} executes a native command and publishes its own result`, { skip: process.env.TEAM_NATIVE_EXECUTION_TEST !== "1", timeout: 70000 }, async () => {
    const marker = "TEAMSWARM_NATIVE_RESULT_42";
    let nativeTool = "", calls = 0, exitCode = 0;
    const f = await setup((body, res) => {
      if (++calls > 6) { res.writeHead(500); res.end("Fixture request limit"); return; }
      const outputs = body.input.filter((v: any) => v.type === "function_call_output");
      if (outputs.length) { respond(res, body.model, JSON.stringify(outputs).includes(marker) ? "NATIVE_COMMAND_CONFIRMED" : "NATIVE_TOOL_FAILED: " + JSON.stringify(outputs)); return; }
      const names = body.tools?.map((t: any) => t.name) ?? [];
      nativeTool = names.find((n: string) => /^(Bash|bash|powershell|pwsh|run_terminal_command|run_terminal_cmd)$/.test(n)) ?? "";
      if (!nativeTool) { respond(res, body.model, "NO_NATIVE_COMMAND_TOOL: " + names.join(",")); return; }
      const schema = body.tools.find((t: any) => t.name === nativeTool)?.parameters?.properties ?? {};
      const values = { command: `echo ${marker}${exitCode ? "; exit 7" : ""}`, description: "Print a native execution marker", explanation: "Print a native execution marker", timeout: 10000, timeoutMs: 10000, is_background: false };
      respond(res, body.model, { name: nativeTool, arguments: Object.fromEntries(Object.entries(values).filter(([key]) => key in schema)) });
    });
    const old = process.env.TEAM_HARNESS_HOME; process.env.TEAM_HARNESS_HOME = path.join(f.directory, "sessions");
    const native = new NativeHarness(id), harness = f.gateway.wrap(native), events: any[] = [];
    let session = "", turn = "";
    const timeout = setTimeout(() => { if (session) void native.interrupt(session, turn).catch(() => native.close()); }, 45000);
    try {
      const request = { workspace: f.directory, isolatedWorkspace: true, config: { ...f.config, harness: id },
        instructions: "Complete the assigned command using your own native command tool. No delegation.", input: "Print the marker with your native command tool.", tools: [],
        onSession: (v: string) => { session = v; }, onTurn: (v: string) => { turn = v; }, onEvent: (e: any) => events.push(e), onTool: async () => { throw Error("Command reached Team tool bridge"); } };
      const result = await harness.execute(request);
      const evidence = events.filter(e => e.type === "execution.item").map(e => e.data);
      const record = { id, nativeTool, result, evidence, events: events.filter(e => e.type === "native.event") };
      writeFileSync(path.join(process.cwd(), ".local", `native-execution-${id}.json`), JSON.stringify(record, null, 2));
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.match(result.text, /NATIVE_COMMAND_CONFIRMED/);
      assert.equal(evidence.length, 1, `No single normalized command result: ${JSON.stringify(events).slice(-4000)}`);
      assert.match(evidence[0].aggregatedOutput, new RegExp(marker));
      assert.equal(evidence[0].nativeOutcome, "succeeded", JSON.stringify(evidence));
      assert.equal(evidence[0].harness, id);
      exitCode = 7; events.length = 0;
      const failure = await harness.execute(request);
      const failed = events.filter(e => e.type === "execution.item").map(e => e.data);
      writeFileSync(path.join(process.cwd(), ".local", `native-exit-${id}.json`), JSON.stringify({ id, failure, evidence: failed }, null, 2));
      assert.equal(failed.length, 1, JSON.stringify(failure));
      assert.equal(failed[0].nativeOutcome, "failed", JSON.stringify(failed));
      assert.ok(failed[0].exitCode === 7 || id === "claude-code" && failed[0].exitCode === null, JSON.stringify(failed));
      assert.deepEqual(f.gateway.state(), { routes: 0, requests: 0 }); assert.equal(native.resources().length, 0);
    } finally { clearTimeout(timeout); await native.close(); if (old === undefined) delete process.env.TEAM_HARNESS_HOME; else process.env.TEAM_HARNESS_HOME = old; await f.close(); }
  });
}

for (const id of ["claude-code", "opencode", "grok", "deepseek-harness"] as const) {
  test(`installed ${id} native permission request receives a one-time decision`, { skip: process.env.TEAM_NATIVE_PERMISSION_TEST !== "1", timeout: 80000 }, async () => {
    const f = await setup((body, res) => {
      if (body.input.some((v: any) => v.type === "function_call_output")) { respond(res, body.model, "PERMISSION_TURN_DONE"); return; }
      if (!body.tools?.length) { respond(res, body.model, "Native command session"); return; }
      const tool = body.tools.find((v: any) => ["Bash", "bash", "pwsh", "powershell", "run_terminal_cmd", "run_terminal_command"].includes(v.name));
      if (!tool) { writeFileSync(path.join(process.cwd(), ".local", `native-auxiliary-${id}.json`), JSON.stringify(body, null, 2)); respond(res, body.model, "Auxiliary fixture response"); return; }
      const escalation = tool.parameters?.properties?.sandbox_permissions?.enum?.at(-1);
      respond(res, body.model, { name: tool.name, arguments: { command: "node -e \"process.stdout.write('NATIVE_PERMISSION_42')\"", description: "Print the native permission marker",
        ...(id === "deepseek-harness" ? { sandbox_permissions: escalation ?? "require_escalated", justification: "Print a marker to verify native one-time approval routing." } : {}) } });
    });
    const old = process.env.TEAM_HARNESS_HOME; process.env.TEAM_HARNESS_HOME = path.join(f.directory, "sessions");
    const native = new NativeHarness(id), harness = f.gateway.wrap(native);
    let session = "", turn = "";
    const timeout = setTimeout(() => { if (session) void native.interrupt(session, turn).catch(() => native.close()); }, 60000);
    try {
      for (const decision of ["allow", "deny"] as const) {
        const asks: any[] = [], events: any[] = [];
        const config = { ...f.config, harness: id, permissions: id === "claude-code" || id === "grok" ? { harness: id, mode: "default" as const } : id === "deepseek-harness" ? { harness: id, sandbox: "workspace-write" as const, approval: "ask" as const } : { harness: id, permission: { bash: "ask" as const } } };
        const result = await harness.execute({ workspace: f.directory, isolatedWorkspace: true, config, instructions: "Use the native command tool.", input: "Run the marker command.", tools: [],
          onSession: v => { session = v; }, onTurn: v => { turn = v; }, onEvent: e => events.push(e), onTool: async () => { throw Error("Unexpected Team tool"); },
          onPermission: async request => { asks.push(request); return decision; } });
        writeFileSync(path.join(process.cwd(), ".local", `native-permission-${id}-${decision}.json`), JSON.stringify({ asks, result, events }, null, 2));
        assert.equal(result.status, id === "grok" && decision === "deny" ? "interrupted" : "completed", JSON.stringify(result)); assert.equal(asks.length, 1, JSON.stringify(result));
        assert.ok(asks[0].nativeId); assert.ok(JSON.stringify(asks[0]).includes("NATIVE_PERMISSION_42"));
        const commands = events.filter(e => e.type === "execution.item").map(e => e.data);
        if (decision === "allow") assert.ok(commands.some(e => e.nativeOutcome === "succeeded" && e.aggregatedOutput.includes("NATIVE_PERMISSION_42")));
        else assert.ok(!commands.some(e => e.nativeOutcome === "succeeded"));
      }
      assert.equal(native.resources().length, 0);
    } finally { clearTimeout(timeout); await native.close(); if (old === undefined) delete process.env.TEAM_HARNESS_HOME; else process.env.TEAM_HARNESS_HOME = old; await f.close(); }
  });
}

for (const id of ["pi", "deepseek-harness", "grok", "opencode", "claude-code"] as const) {
  test(`installed ${id} cancellation reclaims its running native command`, { skip: process.env.TEAM_NATIVE_CANCEL_TEST !== "1", timeout: 60000 }, async () => {
    const f = await setup((body, res) => {
      if (!body.tools?.length || body.input.some((v: any) => v.type === "function_call_output")) { respond(res, body.model, "Command observation"); return; }
      const tool = body.tools.find((v: any) => ["Bash", "bash", "pwsh", "powershell", "run_terminal_cmd", "run_terminal_command"].includes(v.name));
      if (!tool) { respond(res, body.model, "Auxiliary fixture response"); return; }
      const properties = tool.parameters?.properties ?? {};
      const values = { command: `node -e "require('node:fs').writeFileSync('cancel.pid',String(process.pid));setInterval(()=>{},1000)"`, description: "Wait for cancellation", explanation: "Wait for cancellation", timeout: 60000, timeoutMs: 60000, is_background: false, run_in_background: false };
      respond(res, body.model, { name: tool.name, arguments: Object.fromEntries(Object.entries(values).filter(([key]) => key in properties)) });
    });
    const old = process.env.TEAM_HARNESS_HOME; process.env.TEAM_HARNESS_HOME = path.join(f.directory, "sessions");
    const native = new NativeHarness(id), harness = f.gateway.wrap(native), events: any[] = [];
    let session = "", turn = "", ended = false, pid = 0;
    const request = harness.execute({ workspace: f.directory, isolatedWorkspace: true, config: { ...f.config, harness: id }, instructions: "Run the assigned command in the foreground.", input: "Run the command and wait for it.", tools: [],
      onSession: value => { session = value; }, onTurn: value => { turn = value; }, onTool: async () => { throw Error("Unexpected Team tool"); }, onEvent: event => events.push(event) }).finally(() => { ended = true; });
    try {
      const file = path.join(f.directory, "cancel.pid"), deadline = Date.now() + 40000;
      while (!existsSync(file) && !ended && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(existsSync(file), "The native command must start before cancellation");
      pid = Number(readFileSync(file, "utf8")); assert.ok(pid > 0); process.kill(pid, 0);
      await native.interrupt(session, turn);
      const result = await request;
      writeFileSync(path.join(process.cwd(), ".local", `native-cancel-${id}.json`), JSON.stringify({ result, pid, events }, null, 2));
      assert.equal(result.status, "interrupted", JSON.stringify(result));
      for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch { break; } await new Promise(resolve => setTimeout(resolve, 50)); }
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.ok(events.some(e => e.type === "execution.item" && ["cancelled", "failed"].includes(e.data.nativeOutcome)));
      assert.equal(native.resources().length, 0); assert.deepEqual(f.gateway.state(), { routes: 0, requests: 0 });
    } finally { await native.close(); await request.catch(() => {}); if (old === undefined) delete process.env.TEAM_HARNESS_HOME; else process.env.TEAM_HARNESS_HOME = old; await f.close(); }
  });
}

for (const id of ["deepseek-harness", "claude-code", "pi"] as const) {
  test(`installed ${id} streams public progress before completion and reports Team tools`, { skip: process.env.TEAM_NATIVE_PROGRESS_TEST !== "1", timeout: 70000 }, async () => {
    const marker = "PUBLIC_PROGRESS_42";
    let upstreamFinished = 0, calls = 0, bridged = 0, firstDelta = 0;
    const f = await setup((body, res) => {
      if (++calls > 6) { res.writeHead(500).end("Fixture request limit"); return; }
      const tool = body.tools?.find((t: any) => /(?:^|__)team_state$/.test(t.name));
      if (tool && !body.input.some((v: any) => v.type === "function_call_output"))
        respond(res, body.model, { name: tool.name, arguments: {} });
      else {
        res.once("finish", () => { upstreamFinished = Date.now(); });
        respond(res, body.model, marker, true, false, 1500);
      }
    });
    const old = process.env.TEAM_HARNESS_HOME; process.env.TEAM_HARNESS_HOME = path.join(f.directory, "sessions");
    const native = new NativeHarness(id), harness = f.gateway.wrap(native), events: any[] = [];
    try {
      const result = await harness.execute({ workspace: f.directory, isolatedWorkspace: true,
        config: { ...f.config, harness: id }, instructions: "Call team_state once, then report the result.", input: "Read the team state and report completion.",
        tools: toolSpecs.filter(t => t.name === "team_state"), onSession: () => {}, onTurn: () => {},
        onEvent: e => { events.push(e); if (e.type === "transcript.delta" && !firstDelta) firstDelta = Date.now(); },
        onTool: async (tool: string) => { assert.equal(tool, "team_state"); bridged++; return { status: "ready" }; } });
      writeFileSync(path.join(process.cwd(), ".local", `native-progress-${id}.json`), JSON.stringify({ result, firstDelta, upstreamFinished, bridged, events }, null, 2));
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.match(result.text, new RegExp(marker)); assert.equal(bridged, 1);
      assert.ok(firstDelta > 0 && firstDelta < upstreamFinished, "Public text must arrive before the model stream ends");
      const tools = events.filter(e => e.type === "transcript.item" && e.data.title === "team_state");
      assert.ok(tools.some(e => e.data.status === "running"), "Tool start is visible");
      assert.ok(tools.some(e => e.data.status === "completed"), "Tool result is visible");
      const messages = events.filter(e => e.type === "transcript.item" && e.data.kind === "message" && e.data.status === "completed");
      assert.equal(messages.length, 1); assert.equal(messages[0].data.text, marker);
    } finally { await native.close(); if (old === undefined) delete process.env.TEAM_HARNESS_HOME; else process.env.TEAM_HARNESS_HOME = old; await f.close(); }
  });
}

for (const id of ["deepseek-harness", "pi", "grok", "claude-code", "opencode", "codex"] as const) {
  test(`installed ${id} full access writes and reads beyond its working directory`, { skip: process.env.TEAM_NATIVE_DEVICE_TEST !== "1", timeout: 90000 }, async () => {
    const marker = "DEVICE_ACCESS_PROOF_42"; let calls = 0, nativeTool = "", nativeSnapshot:Record<string,unknown>={};
    const f = await setup((body,res) => {
      if (++calls > 6) { res.writeHead(500).end("Fixture request limit");return; }
      const outputs=body.input.filter((v:any)=>v.type==='function_call_output');
      if(outputs.length){respond(res,body.model,JSON.stringify(outputs).includes(marker)?"DEVICE_ACCESS_CONFIRMED":"FAILED: "+JSON.stringify(outputs));return;}
      const tool=body.tools?.find((t:any)=>/^(Bash|bash|pwsh|powershell|run_terminal_command|run_terminal_cmd|exec_command)$/.test(t.name));
      if(!tool){respond(res,body.model,"NO_COMMAND_TOOL");return;}
      nativeTool=tool.name;const schema=tool.parameters?.properties??{};
      const values={cmd:"node device-check.cjs",yield_time_ms:10000,max_output_tokens:1000,command:"node device-check.cjs",description:"Write and read only the generated sibling proof file",explanation:"Verify explicitly selected full access",timeout:10000,timeoutMs:10000,is_background:false};
      respond(res,body.model,{name:tool.name,arguments:Object.fromEntries(Object.entries(values).filter(([k])=>k in schema))});
    });
    const workspace=path.join(f.directory,"work");mkdirSync(workspace);
    const outside=path.join(f.directory,"device-access-proof.txt");
    writeFileSync(path.join(workspace,"device-check.cjs"),`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(outside)},${JSON.stringify(marker)});process.stdout.write(fs.readFileSync(${JSON.stringify(outside)},'utf8'));`);
    const old=process.env.TEAM_HARNESS_HOME;process.env.TEAM_HARNESS_HOME=path.join(f.directory,"sessions");
    const native=id === "codex" ? new CodexHarness() : new NativeHarness(id),harness=f.gateway.wrap(native),events:any[]=[];
    try {
      const permissions=native.permissionOptions().options.find(o=>o.id==='full-access')!.permissions;
      const result=await harness.execute({workspace,isolatedWorkspace:false,config:{...f.config,harness:id,permissions},instructions:"Perform the single requested local verification command. Do not delegate.",input:"Run node device-check.cjs once. It writes only a generated proof file outside the working directory and reads it back.",tools:[],onSession:(_id,actual)=>{nativeSnapshot=actual;},onTurn:()=>{},onEvent:e=>events.push(e),onTool:async()=>{throw Error("Native command must not use the Team bridge");}});
      writeFileSync(path.join(process.cwd(),'.local',`device-access-${id}.json`),JSON.stringify({result,nativeTool,permissions,nativeSnapshot,events},null,2));
      assert.equal(result.status,'completed',JSON.stringify(result));assert.match(result.text,/DEVICE_ACCESS_CONFIRMED/);
      assert.equal(readFileSync(outside,'utf8'),marker);assert(events.some(e=>e.type==='execution.item'&&(id === 'codex' ? e.data.status === 'completed' && e.data.exitCode === 0 : e.data.nativeOutcome==='succeeded')));
      if(id === 'codex') assert.equal((nativeSnapshot.sandbox as any).type,'dangerFullAccess');
    } finally {await native.close();if(old===undefined)delete process.env.TEAM_HARNESS_HOME;else process.env.TEAM_HARNESS_HOME=old;await f.close();}
  });
}

test("Antigravity streams shared model tools only after the matching user approval", async () => {
  const fixture = await setup((body, res) => {
    const output = body.input.find((item: any) => item.type === "function_call_output");
    respond(res, body.model, output ? "Recorded native output" : { name: "write_file", arguments: { Path: "example.txt", Content: "fixture" } });
  });
  try {
    const lease = await fixture.gateway.lease({ ...fixture.config, harness: "antigravity", permissions: { harness: "antigravity", mode: "default" } });
    const uri = (model: string) => lease.config.baseUrl + "/v1beta/models/" + model + ":streamGenerateContent";
    const post = async (model = "gemini-3.8-flash", extra: object = {}) =>
      fetch(uri(model), {
        method: "POST", headers: { "x-goog-api-key": lease.token, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Write the test file" }] }], ...extra }),
      });
    let approved = false;
    let checked = 0;
    lease.permission(async request => {
      checked++;
      assert.equal(request.tool, "write_file");
      assert.deepEqual(request.input, { Path: "example.txt", Content: "fixture" });
      return approved ? "allow" : "deny";
    });
    assert.equal((await post("gemini-helper")).status, 404);
    assert.equal(fixture.requests.length, 0);
    const refused = await (await post()).text();
    assert.match(refused, /permission_denied/);
    assert.doesNotMatch(refused, /functionCall/);
    assert.equal(checked, 1);
    approved = true;
    const frames = (await (await post()).text()).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    const call = frames.flatMap(frame => frame.candidates[0]?.content?.parts ?? []).find(part => part.functionCall).functionCall;
    assert.equal(call.name, "write_file");
    assert.equal(lease.approved(call.id, call.name, { ...call.args, Path: "different.txt" }), false);
    assert.equal(lease.approved(call.id, call.name, call.args), true);
    assert.equal(lease.approved(call.id, call.name, call.args), false);
    const continued = await (await post(undefined, { contents: [
      { role: "user", parts: [{ text: "Write the test file" }] },
      { role: "model", parts: [{ functionCall: call }] },
      { role: "user", parts: [{ functionResponse: { name: call.name, id: call.id, response: { success: true } } }] },
    ] })).text();
    assert.match(continued, /Recorded native output/);
    assert.match(JSON.stringify(fixture.requests.at(-1)), /function_call_output/);
    lease.release();
    assert.equal((await post()).status, 403);
  } finally { await fixture.close(); }
});


test("Antigravity shares existing Team reads without approving Team mutations or native writes", async () => {
  const fixture = await setup((body, res) => {
    const name = body.input.find((item: any) => item.role === "user").content[0].text;
    respond(res, body.model, { name, arguments: {} });
  });
  try {
    for (const access of ["read-only", "workspace-write"] as const) {
      const lease = await fixture.gateway.lease({
        ...fixture.config, harness: "antigravity", access,
        permissions: access === "read-only" ? { harness: "antigravity", mode: "plan" } : { harness: "antigravity", mode: "teamswarmAuto" },
      });
      const decisions: string[] = [];
      lease.permission(async request => { decisions.push(request.tool); return "deny"; }, [
        { name: "team_state", description: "Inspect current state", inputSchema: { type: "object" } },
        { name: "team_skill_read", description: "Read this Host's authorized Skill", inputSchema: { type: "object" } },
        { name: "team_write_file", description: "Write a file", inputSchema: { type: "object" } },
      ]);
      const ask = async (name: string) => {
        const response = await fetch(lease.config.baseUrl + "/v1beta/models/gemini-3.8-flash:streamGenerateContent", {
          method: "POST", headers: { "x-goog-api-key": lease.token, "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: name }] }] }),
        });
        return response.text();
      };
      for (const name of ["mcp_teamswarm_team_state", "mcp_teamswarm_team_skill_read"]) {
        assert.match(await ask(name), /functionCall/);
      }
      assert.deepEqual(decisions, []);
      for (const name of ["mcp_teamswarm_team_skill_list", "mcp_teamswarm_team_read_file", "mcp_teamswarm_team_write_file", "write_file"]) {
        const blocked = await ask(name);
        assert.match(blocked, /permission_denied/);
        assert.doesNotMatch(blocked, /functionCall/);
      }
      assert.deepEqual(decisions, access === "read-only" ? [] : ["mcp_teamswarm_team_skill_list", "mcp_teamswarm_team_read_file", "mcp_teamswarm_team_write_file", "write_file"]);
      lease.release();
    }
  } finally { await fixture.close(); }
});

test("Antigravity only relays the exposed Host inline tool on a read-only route", async () => {
  const name = "mcp_teamswarm_team_host_inline_edit";
  const input = { sourceMessageId: "current-user-message", edits: [{
    path: "guide.txt", expectedSha256: "0".repeat(64), oldText: "previous", newText: "approved",
  }] };
  const fixture = await setup((body, res) => {
    const requested = body.input.find((item: any) => item.role === "user").content[0].text;
    respond(res, body.model, { name: requested, arguments: input });
  });
  try {
    for (const exposed of [false, true]) {
      const lease = await fixture.gateway.lease({ ...fixture.config, harness: "antigravity", access: "read-only",
        permissions: { harness: "antigravity", mode: "plan" } });
      const denied: string[] = [];
      lease.permission(async () => {
        assert.fail("An inline relay must go directly to the Team tool's own approval.");
      }, exposed ? [{ name: "team_host_inline_edit", description: "Propose a scoped Team text edit", inputSchema: { type: "object" } }] : [],
      tool => denied.push(tool));
      const ask = async (tool: string) => {
        const result = await fetch(lease.config.baseUrl + "/v1beta/models/gemini-3.8-flash:streamGenerateContent", {
          method: "POST", headers: { "x-goog-api-key": lease.token, "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: tool }] }] }),
        });
        return result.text();
      };
      if (!exposed) {
        const refused = await ask(name);
        assert.match(refused, /permission_denied/);
        assert.doesNotMatch(refused, /functionCall/);
        assert.deepEqual(denied, [name]);
      } else {
        const frames = (await ask(name)).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
        const call = frames.flatMap(frame => frame.candidates[0]?.content?.parts ?? []).find(part => part.functionCall).functionCall;
        assert.equal(call.name, name);
        assert.deepEqual(call.args, input);
        assert.equal(lease.approved(call.id + "-other", name, input), false);
        assert.equal(lease.approved(call.id, "write_file", input), false);
        assert.equal(lease.approved(call.id, name, { ...input, sourceMessageId: "different-message" }), false);
        assert.equal(lease.approved(call.id, name, input), true);
        assert.equal(lease.approved(call.id, name, input), false);
        assert.deepEqual(denied, []);
      }
      const other = ["write_file", "run_command", "mcp_teamswarm_team_write_file", name + "_other"];
      for (const tool of other) {
        const refused = await ask(tool);
        assert.match(refused, /permission_denied/);
        assert.doesNotMatch(refused, /functionCall/);
      }
      assert.deepEqual(denied, exposed ? other : [name, ...other]);
      await lease.release();
    }
  } finally { await fixture.close(); }
});

test("model lease approvals and declined state belong to one execution generation", async () => {
  const f = await setup((body, res) => respond(res, body.model, {
    name: "write_file", arguments: { Path: "example.txt", Content: "fixture" },
  }));
  let finishApproval!: (decision: "allow" | "deny") => void;
  let permissionStarted!: () => void;
  const permissionReady = new Promise<void>(resolve => { permissionStarted = resolve; });
  const first = await f.gateway.lease({ ...f.config, harness: "antigravity", permissions: { harness: "antigravity", mode: "default" } });
  const call = (lease: typeof first) => fetch(lease.config.baseUrl + "/v1beta/models/gemini-3.8-flash:streamGenerateContent", {
    method: "POST", headers: { "x-goog-api-key": lease.token, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Write the test file" }] }] }),
  }).then(response => response.text());
  let pending: Promise<string> | undefined;
  try {
    first.permission(async () => {
      permissionStarted();
      return new Promise(resolve => { finishApproval = resolve; });
    });
    pending = call(first);
    await permissionReady;
    await first.release();
    const second = await first.acquire();
    assert.equal(second.declined(), false);
    second.permission(async () => "allow");
    finishApproval("allow");
    await pending;
    const frames = (await call(second)).split("\n").filter(line => line.startsWith("data: "))
      .map(line => JSON.parse(line.slice(6)));
    const grant = frames.flatMap(frame => frame.candidates?.[0]?.content?.parts ?? [])
      .find(part => part.functionCall).functionCall;
    first.rejectGrant(grant.id);
    assert.equal(first.approved(grant.id, grant.name, grant.args), false);
    assert.equal(second.approved(grant.id, grant.name, grant.args), true);
    assert.equal(second.approved(grant.id, grant.name, grant.args), false);
    second.permission(async () => "deny");
    assert.match(await call(second), /permission_denied/);
    assert.equal(second.declined(), true);
    await second.release();
    const third = await second.acquire();
    assert.equal(third.declined(), false);
    await third.release();
  } finally { finishApproval?.("deny"); await pending?.catch(() => {}); await f.close(); }
});

test("a model endpoint admits one next lease and revokes cached leases on disconnect", async () => {
  const f = await setup((body, res) => respond(res, body.model, "fixture"));
  const accountId = "11111111-1111-4111-8111-111111111111";
  f.gateway.accounts.signOut = async () => ({ id: accountId, status: "disconnected" }) as any;
  try {
    const first = await f.gateway.lease({ ...f.config, chatgptAccountId: accountId });
    await first.release();
    const acquisitions = await Promise.allSettled([first.acquire(), first.acquire()]);
    assert.equal(acquisitions.filter(result => result.status === "fulfilled").length, 1);
    const current = acquisitions.find(result => result.status === "fulfilled")!;
    assert.equal(current.status, "fulfilled");
    if (current.status !== "fulfilled") throw Error("Missing acquired lease");
    await current.value.release();
    await f.gateway.disconnect(accountId);
    assert.equal(current.value.valid(), false);
    await assert.rejects(current.value.acquire(), /authorization has ended/);
    assert.deepEqual(f.gateway.state(), { routes: 0, requests: 0 });
  } finally { await f.close(); }
});

test("account disconnect blocks new leases while old requests drain", async () => {
  const f = await setup((body, res) => respond(res, body.model, "fixture"));
  const originalFetch = globalThis.fetch;
  let releaseUpstream!: (response: Response) => void;
  let prepared!: () => void;
  const preparedRequest = new Promise<void>(resolve => { prepared = resolve; });
  const accountId = "11111111-1111-4111-8111-111111111111";
  let signOutCalls = 0;
  f.gateway.accounts.accessToken = async () => "fixture-key";
  f.gateway.accounts.signOut = async () => { signOutCalls++; return { id: accountId } as any; };
  globalThis.fetch = (input, init) => String(input) === "https://api.openai.com/v1/responses"
    ? new Promise<Response>(resolve => { releaseUpstream = resolve; }) : originalFetch(input, init);
  const config = { ...f.config, chatgptAccountId: accountId };
  const first = await f.gateway.lease(config);
  let response: Promise<unknown> | undefined;
  try {
    first.observe(receipt => { if (receipt.status === "prepared") prepared(); });
    response = originalFetch(first.config.baseUrl + "/responses", {
      method: "POST", headers: { authorization: "Bearer " + first.token, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", stream: true, input: "Fixture" }),
    }).then(value => value.text()).catch(error => error);
    await preparedRequest;
    const disconnected = f.gateway.disconnect(accountId);
    const repeated = f.gateway.disconnect(accountId);
    assert.equal(signOutCalls, 0);
    await assert.rejects(f.gateway.lease(config), /authorization has ended/);
    assert.equal(first.valid(), false);
    releaseUpstream(new Response("{}", { headers: { "content-type": "application/json" } }));
    await Promise.all([response, disconnected, repeated]);
    assert.equal(signOutCalls, 1);
    assert.deepEqual(f.gateway.state(), { routes: 0, requests: 0 });
    assert.equal(first.valid(), false);
  } finally {
    releaseUpstream?.(new Response("{}"));
    await response;
    globalThis.fetch = originalFetch;
    await f.close();
  }
});


test("Qwen automatic review withholds native commands and only forwards its registered Team tools", async () => {
  const f = await setup((body, res) => {
    const command = JSON.parse(body.input.find((item: any) => item.role === "user").content[0].text);
    respond(res, body.model, command);
  });
  try {
    const lease = await f.gateway.lease({ ...f.config, harness: "qwen-code",
      access: "workspace-write", permissions: { harness: "qwen-code", approvalMode: "teamswarm-auto" } });
    const denied: unknown[] = [];
    lease.permission(async request => { denied.push(request.input); return "deny"; }, [
      { name: "team_write_file", description: "Create a file", inputSchema: { type: "object" } },
    ]);
    const ask = async (name: string, args: object) => {
      const response = await fetch(lease.config.baseUrl + "/chat/completions", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + lease.token },
        body: JSON.stringify({ model: f.config.model, stream: true,
          messages: [{ role: "user", content: JSON.stringify({ name, arguments: args }) }] }),
      });
      return response.text();
    };
    const ownWrite = await ask("tool_call", { name: "mcp__teamswarm__team_write_file", arguments: { path: "a.txt" } });
    assert.match(ownWrite, /tool_calls/);
    assert.match(ownWrite, /mcp__teamswarm__team_write_file/);
    const shell = await ask("run_shell_command", { command: "echo fixture" });
    assert.match(shell, /permission_denied/);
    assert.doesNotMatch(shell, /tool_calls/);
    const indirect = await ask("tool_call", { name: "mcp__teamswarm__team_delegate", arguments: {} });
    assert.match(indirect, /permission_denied/);
    assert.doesNotMatch(indirect, /tool_calls/);
    const outside = await ask("write_file", { file_path: "../other.txt", content: "fixture" });
    assert.match(outside, /permission_denied/);
    assert.doesNotMatch(outside, /tool_calls/);
    assert.deepEqual(denied, [{ name: "run_shell_command" }, { name: "mcp__teamswarm__team_delegate" },
      { name: "write_file" }]);
    lease.release();
  } finally { await f.close(); }
});
