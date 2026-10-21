import assert from "node:assert/strict";
import { test } from "node:test";
import { grokPermissionOutcome } from "../src/runtime/harness/grok-permissions.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

test("Grok ACP permits only an exact tool in the current attempt, once", () => {
  const tools = [{ name: "read_fact" }];
  const params = {
    sessionId: "native-session",
    toolCall: {
      rawInput: {
        variant: "UseTool",
        tool_name: "teamswarm__read_fact",
        tool_input: {},
      },
    },
    options: [
      { kind: "allow_always", optionId: "persistent" },
      { kind: "allow_once", optionId: "once" },
    ],
  };
  assert.deepEqual(grokPermissionOutcome(params, "native-session", tools), {
    outcome: "selected",
    optionId: "once",
  });
  for (const changed of [
    { ...params, sessionId: "other-session" },
    {
      ...params,
      toolCall: {
        rawInput: { variant: "UseTool", tool_name: "other__read_fact" },
      },
    },
    {
      ...params,
      toolCall: {
        rawInput: { variant: "UseTool", tool_name: "teamswarm__write_file" },
      },
    },
    {
      ...params,
      toolCall: {
        title: "teamswarm__read_fact",
        rawInput: { variant: "Bash", command: "read_fact" },
      },
    },
    { ...params, options: [{ kind: "allow_always", optionId: "persistent" }] },
    { ...params, options: [{ kind: "allow_once" }] },
    { ...params, toolCall: null },
    null,
  ])
    assert.deepEqual(grokPermissionOutcome(changed, "native-session", tools), {
      outcome: "cancelled",
    });
  assert.deepEqual(grokPermissionOutcome(params, "native-session", []), {
    outcome: "cancelled",
  });
  assert.deepEqual(grokPermissionOutcome(params, "", tools), {
    outcome: "cancelled",
  });
});

test("Grok native ACP permissions honor the attempt access without persistent grants", () => {
  const request = (variant: string) => ({
    sessionId: "native-session",
    toolCall: { rawInput: { variant, command: "node verify.mjs" } },
    options: [{ kind: "allow_once", optionId: "once" }],
  });
  const allowed = { outcome: "selected", optionId: "once" };
  const denied = { outcome: "cancelled" };
  for (const variant of ["ReadFile", "Grep", "ListDir"]) {
    assert.deepEqual(
      grokPermissionOutcome(
        request(variant),
        "native-session",
        [],
        "read-only",
      ),
      allowed,
    );
    assert.deepEqual(
      grokPermissionOutcome(
        request(variant),
        "native-session",
        [],
        "workspace-write",
      ),
      allowed,
    );
  }
  for (const variant of ["Bash", "SearchReplace", "Write"]) {
    assert.deepEqual(
      grokPermissionOutcome(
        request(variant),
        "native-session",
        [],
        "read-only",
      ),
      denied,
    );
    assert.deepEqual(
      grokPermissionOutcome(
        request(variant),
        "native-session",
        [],
        "workspace-write",
      ),
      allowed,
    );
    assert.deepEqual(
      grokPermissionOutcome(
        request(variant),
        "different-session",
        [],
        "workspace-write",
      ),
      denied,
    );
    assert.deepEqual(
      grokPermissionOutcome(
        {
          ...request(variant),
          options: [{ kind: "allow_always", optionId: "forever" }],
        },
        "native-session",
        [],
        "workspace-write",
      ),
      denied,
    );
  }
  for (const variant of [
    "UseTool",
    "Read",
    "Glob",
    "Edit",
    "ApplyPatch",
    "WebSearch",
    "Subagent",
    "Unknown",
    undefined,
  ])
    assert.deepEqual(
      grokPermissionOutcome(
        request(variant as string),
        "native-session",
        [],
        "workspace-write",
      ),
      denied,
    );
});

test(
  "Grok worker authorizes the attempt MCP call and separates progress from its final answer",
  { timeout: 120000 },
  async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "teamswarm-grok-worker-test-"),
    );
    const fixture = path.join(root, "acp-fixture.mjs");
    writeFileSync(
      fixture,
      String.raw`
    import readline from 'node:readline';
    import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
    writeFileSync(new URL('./argv.json',import.meta.url),JSON.stringify(process.argv.slice(2)));
    writeFileSync(new URL('./requests.jsonl',import.meta.url),'');
    const profile=JSON.parse(readFileSync(process.argv[process.argv.indexOf('--agent-profile')+1],'utf8').split('\n')[1]);
    const scenario=process.env.TEAMSWARM_TEST_CATALOG_CASE;
    const catalog=(modelChange=false)=>{
      const mode=scenario?.startsWith('model-') ? (modelChange ? scenario.slice(6) : '') : scenario;
      if(mode==='absent') return;
      let tools=profile.tools.map(name=>name==='run_terminal_cmd'?'run_terminal_command':name);
      if(mode==='valid-without-write') tools=tools.filter(name=>name!=='write');
      if(mode==='unexpected-write') tools.push('write');
      if(mode==='missing-shell') tools=tools.filter(name=>name!=='run_terminal_command');
      if(mode==='missing-editor') tools=tools.filter(name=>name!=='search_replace');
      if(mode==='missing') tools=undefined;
      if(mode==='nonarray') tools={read_file:true};
      if(mode==='nonstring') tools=[...tools,42];
      if(mode==='empty') tools=[];
      if(mode==='incomplete') tools=['read_file'];
      if(mode==='unknown') tools.push('workflow');
      const event={sessionUpdate:'available_commands_update',_meta:{tools}};
      if(mode==='other-session') send({method:'session/update',params:{sessionId:'another-session',update:event}});
      else update(event);
    };
    const send=value=>console.log(JSON.stringify({jsonrpc:'2.0',...value}));
    const update=value=>send({method:'session/update',params:{sessionId:'fixture-session',update:value}});
    let promptId, loaded=false;
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const message=JSON.parse(line);
      if(message.method) appendFileSync(new URL('./requests.jsonl',import.meta.url),JSON.stringify(message)+'\n');
      if(message.method==='initialize') send({id:message.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
      else if(message.method==='session/new') {if(scenario==='valid-sync') catalog();send({id:message.id,result:{sessionId:'fixture-session'}});if(scenario!=='valid-sync') setTimeout(catalog,20);}
      else if(message.method==='session/load') {
        loaded=true;
        if(scenario==='valid-sync') catalog();
        update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD ANSWER'}});
        send({id:message.id,result:{}});
        if(scenario!=='valid-sync') setTimeout(catalog,20);
      }
      else if(message.method==='session/set_model') {send({id:message.id,result:{}});setTimeout(()=>catalog(true),20);}
      else if(message.method==='session/prompt') {
        if(loaded) {
          send({method:'session/update',params:{sessionId:'another-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'WRONG SESSION'}}}});
          update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'RESUMED ANSWER'}});
          send({id:message.id,result:{stopReason:'end_turn'}});
          update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'LATE UPDATE'}});
          return;
        }
        promptId=message.id;
        update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Checking the tool.'}});
        update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'Read fact'});
        send({id:'permission-1',method:'session/request_permission',params:{sessionId:'fixture-session',toolCall:{rawInput:{variant:'UseTool',tool_name:'teamswarm__read_fact'}},options:[{kind:'allow_once',optionId:'once'}]}});
      } else if(message.id==='permission-1') {
        const permitted=message.result?.outcome?.outcome==='selected' && message.result.outcome.optionId==='once';
        if(permitted) update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ANSWER'}});
        send({id:promptId,result:{stopReason:permitted?'end_turn':'cancelled'}});
      }
    });
  `,
    );
    const spec = path.join(root, "request.json");
    const config = {
      entry: fixture,
      home: root,
      workspace: root,
      bridge: "http://127.0.0.1:1/unused-fixture",
      instructions: "fixture",
      input: "fixture",
      config: { access: "read-only" },
      tools: [{ name: "read_fact" }],
    };
    const worker = fileURLToPath(
      new URL("../src/runtime/harness/grok-worker.ts", import.meta.url),
    );
    try {
      const cases = [
        ...["missing-shell", "missing-editor"].flatMap((scenario) =>
          [false, true].map((resume) => ({
            access: "workspace-write",
            resume,
            scenario,
          })),
        ),
        ...[false, true].map((resume) => ({
          access: "workspace-write",
          resume,
          scenario: "valid-without-write",
        })),
        ...["read-only", "workspace-write"].flatMap((access) =>
          [false, true].map((resume) => ({
            access,
            resume,
            scenario: "valid",
          })),
        ),
        ...["valid-sync", "model-valid"].flatMap((scenario) =>
          [false, true].map((resume) => ({
            access: "read-only",
            resume,
            scenario,
          })),
        ),
        ...[
          "absent",
          "missing",
          "nonarray",
          "nonstring",
          "empty",
          "incomplete",
          "unknown",
          "unexpected-write",
          "other-session",
          "model-unknown",
          "model-missing",
          "model-absent",
        ].flatMap((scenario) =>
          [false, true].map((resume) => ({
            access: "read-only",
            resume,
            scenario,
          })),
        ),
      ];
      for (const { access, resume, scenario } of cases) {
        if (resume)
          writeFileSync(
            path.join(root, "native-session.json"),
            JSON.stringify("fixture-session"),
          );
        writeFileSync(
          spec,
          JSON.stringify({
            ...config,
            config: {
              access,
              ...(scenario.startsWith("model-")
                ? { model: "fixture-model" }
                : {}),
            },
            resume,
          }),
        );
        const child = spawn(
          process.execPath,
          ["--import", "tsx", worker, spec],
          {
            windowsHide: true,
            stdio: "pipe",
            env: { ...process.env, TEAMSWARM_TEST_CATALOG_CASE: scenario },
          },
        );
        const timer = setTimeout(() => child.kill(), 15000);
        let output = "",
          error = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          error += chunk;
        });
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        }).finally(() => clearTimeout(timer));
        assert.equal(code, 0, error);
        const argv: string[] = JSON.parse(
          readFileSync(path.join(root, "argv.json"), "utf8"),
        );
        assert.equal(argv[0], "agent");
        assert.ok(argv.includes("--no-leader"));
        const profile = JSON.parse(
          readFileSync(argv[argv.indexOf("--agent-profile") + 1], "utf8").split(
            "\n",
          )[1],
        );
        assert.deepEqual(
          profile.tools,
          access === "read-only"
            ? ["read_file", "grep", "list_dir"]
            : [
                "read_file",
                "grep",
                "list_dir",
                "write",
                "search_replace",
                "run_terminal_cmd",
              ],
        );
        assert.equal(profile.injectDefaultTools, false);
        assert.equal(profile.agentsMd, false);
        assert.equal(profile.permissionMode, "default");
        const messages = output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const requests = readFileSync(path.join(root, "requests.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(
          requests.find(
            (request) =>
              request.method === (resume ? "session/load" : "session/new"),
          )?.params._meta.systemPromptOverride,
          "fixture",
        );
        if (
          ![
            "valid",
            "valid-sync",
            "model-valid",
            "valid-without-write",
          ].includes(scenario)
        ) {
          assert.equal(
            messages.find((message) => message.type === "result")?.status,
            "failed",
            `${scenario}, resume=${resume}: ${output}`,
          );
          assert.match(
            messages.find((message) => message.type === "result")?.error,
            /native tool profile/,
          );
          assert.ok(
            !requests.some((request) => request.method === "session/prompt"),
            `${scenario} must fail before sending a model prompt`,
          );
          continue;
        }
        assert.ok(
          !messages.some(
            (message) =>
              message.type === "grok.event" &&
              message.event.content?.text === "OLD ANSWER",
          ),
        );
        assert.ok(
          !messages.some(
            (message) =>
              message.type === "grok.event" &&
              ["WRONG SESSION", "LATE UPDATE"].includes(
                message.event.content?.text,
              ),
          ),
        );
        if (!resume)
          assert.ok(
            messages.some(
              (message) =>
                message.type === "grok.event" &&
                message.event.content?.text === "Checking the tool.",
            ),
          );
        assert.deepEqual(
          messages.find((message) => message.type === "result"),
          {
            type: "result",
            status: "completed",
            text: resume ? "RESUMED ANSWER" : "ANSWER",
          },
        );
      }
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
);
