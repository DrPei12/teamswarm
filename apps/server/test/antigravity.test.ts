import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { harnessManifest } from "@team/contracts/harness-catalog";
import { validateManifest } from "../src/runtime/harness/manifest.js";
import { executionConfig } from "../src/runtime/validation.js";
import { executionCompatibility } from "../src/runtime/model-routing.js";
import {
  AntigravityHarness,
  antigravityModels,
  antigravityResult,
  configureAntigravity,
} from "../src/runtime/harness/antigravity.js";

test("Antigravity catalogs native model choices and rejects foreign credentials", async () => {
  validateManifest(harnessManifest("antigravity"));
  const config = executionConfig.parse({
    harness: "antigravity",
    model: "fixture",
    effort: "high",
  });
  assert.deepEqual(executionCompatibility(config), []);
  assert(
    executionCompatibility({
      ...config,
      baseUrl: "https://api.invalid",
      credentialEnv: "TEST_KEY",
      protocol: "chat-completions",
    }).includes("incompatible_protocol"),
  );
  assert(
    executionCompatibility({
      ...config,
      chatgptAccountId: "local-fixture",
      protocol: "responses",
    }).includes("incompatible_protocol"),
  );
  const session = {
    models: {
      currentModelId: "fixture-high",
      availableModels: [
        { modelId: "fixture-low", name: "Fixture Low" },
        { modelId: "fixture-high", name: "Fixture High" },
      ],
    },
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "fixture",
        options: [{ value: "fixture", name: "Fixture" }],
      },
    ],
  };
  const choices = antigravityModels(session);
  assert.equal(choices.length, 1);
  assert.deepEqual(
    choices[0].reasoningEfforts?.map((e) => e.reasoningEffort),
    ["low", "high"],
  );
  assert(choices[0].isDefault);
  await assert.rejects(
    configureAntigravity(
      { config: { ...config, model: "absent" } } as any,
      async () => {
        throw Error("Must not call");
      },
      "session",
      session,
    ),
    /does not offer/,
  );
});

test("Antigravity's reserved terminal error is a failure while ordinary answers are preserved", () => {
  assert.equal(
    antigravityResult({
      status: "completed",
      text: "\n⚠ Agent execution terminated due to error.\n",
    }).status,
    "failed",
  );
  assert.equal(
    antigravityResult({
      status: "completed",
      text: "The log contained: ⚠ Agent execution terminated due to error. It is now resolved.",
    }).status,
    "completed",
  );
  assert.equal(
    antigravityResult({ status: "interrupted", text: "" }).status,
    "interrupted",
  );
});

test(
  "Antigravity configures each native turn, resumes its session and denies read-only native mutation",
  { timeout: 45000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "teamswarm-agy-"));
    const savedBin = process.env.TEAM_ANTIGRAVITY_BIN,
      savedHome = process.env.TEAM_HARNESS_HOME;
    const trace = path.join(root, "requests.jsonl"),
      entry = path.join(root, "fixture.mjs");
    process.env.TEAM_ANTIGRAVITY_BIN = entry;
    process.env.TEAM_HARNESS_HOME = path.join(root, "state");
    fs.writeFileSync(
      entry,
      `
    import { createInterface } from "node:readline";
    import { appendFileSync } from "node:fs";
    const trace=${JSON.stringify(trace)};
    const options=[
      {id:"model",category:"model",currentValue:"fixture",options:[{value:"fixture",name:"Fixture"}]},
      {id:"thought_level",category:"thought_level",currentValue:"low",options:[{value:"low",name:"Low"},{value:"high",name:"High"}]},
      {id:"mode",currentValue:"default",options:[{value:"plan",name:"Plan"},{value:"default",name:"Default"}]}
    ];
    const send=m=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",...m})+"\\n");
    const info=()=>({sessionId:"native-fixture",configOptions:options});
    const update=update=>send({method:"session/update",params:{sessionId:"native-fixture",update}});
    let pending;
    const finish=text=>{
      update({sessionUpdate:"agent_message_chunk",content:{type:"text",text}});
      update({sessionUpdate:"usage_update",used:4000,size:1000000});
      send({id:pending.id,result:{stopReason:"end_turn"}});
    };
    appendFileSync(trace,JSON.stringify({argv:process.argv.slice(2)})+"\\n");
    createInterface({input:process.stdin}).on("line",line=>{
      const m=JSON.parse(line);appendFileSync(trace,JSON.stringify(m)+"\\n");
      if(m.method==="initialize")send({id:m.id,result:{protocolVersion:1,agentInfo:{version:"1.5.4"},agentCapabilities:{loadSession:true}}});
      else if(m.method==="session/new"||m.method==="session/load")send({id:m.id,result:info()});
      else if(m.method==="session/set_config_option"){options.find(o=>o.id===m.params.configId).currentValue=m.params.value;send({id:m.id,result:info()});}
      else if(m.method==="session/prompt"){
        pending=m;
        if(m.params.prompt.some(p=>p.text.includes("INJECT_FAILURE"))) {
          update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Partial public work. "}});
          finish("⚠ Agent execution terminated due to error.");
        } else if(options.find(o=>o.id==="mode").currentValue==="plan")
          send({id:900,method:"session/request_permission",params:{sessionId:"native-fixture",toolCall:{toolCallId:"write",title:"Edit file"},options:[{kind:"allow_once",optionId:"allow"}]}});
        else finish("NATIVE_FIXTURE_OK");
      }else if(m.id===900){if(m.result.outcome.outcome!=="cancelled")throw Error("Read-only mutation was allowed");finish("READ_ONLY_ENFORCED");}
    });
  `,
    );
    const harness = new AntigravityHarness();
    const events: any[] = [],
      actual: any[] = [];
    let session: string | undefined,
      permissionCalls = 0;
    const base = executionConfig.parse({
      harness: "antigravity",
      model: "fixture",
      effort: "high",
      access: "workspace-write",
      permissions: { harness: "antigravity", mode: "bypassPermissions" },
    });
    const make = (config = base, resume = session) => ({
      config,
      workspace: root,
      isolatedWorkspace: true,
      tools: [],
      instructions: "Synthetic fixture",
      input: "fixture",
      sessionId: resume,
      onSession(id: string, value: any) {
        session = id;
        actual.push(value);
      },
      onTurn() {},
      onDispatch() {},
      onEvent(event: any) {
        events.push(event);
      },
      onTool: async () => ({}),
      onPermission: async () => {
        permissionCalls++;
        return "allow" as const;
      },
    });
    try {
      const first = await harness.execute(make());
      assert.equal(first.status, "completed");
      assert.equal(first.text, "NATIVE_FIXTURE_OK");
      const native = session;
      const second = await harness.execute(make());
      assert.equal(second.status, "completed");
      assert.equal(session, native);
      assert.equal(actual.at(-1).effort, "high");
      assert.equal(actual.at(-1).model, "fixture");
      assert(
        events.some(
          (e) => e.type === "context.usage" && e.data.inputTokens === 4000,
        ),
      );
      assert(
        events.some(
          (e) => e.type === "transcript.item" && e.data.phase === "final",
        ),
      );
      const failed = await harness.execute({
        ...make(),
        sessionId: undefined,
        input: "INJECT_FAILURE",
      });
      assert.equal(failed.status, "failed");
      assert(failed.text.startsWith("Partial public work."));
      const readOnly = executionConfig.parse({
        ...base,
        access: "read-only",
        permissions: { harness: "antigravity", mode: "plan" },
      });
      const third = await harness.execute({
        ...make(readOnly),
        sessionId: undefined,
      });
      assert.equal(third.text, "READ_ONLY_ENFORCED");
      assert.equal(permissionCalls, 0);
      assert.deepEqual(
        actual
          .filter((value) => value.nativeSession)
          .map((value) => value.nativeSession),
        ["unconfirmed", "inherited", "unconfirmed", "unconfirmed"],
      );
      assert.equal(
        events.filter((event) => event.type === "session.native").length,
        4,
      );
      const log = fs
        .readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      assert(log.some((x) => x.method === "session/load"));
      assert(
        log.some((x) => x.argv?.includes("--dangerously-skip-permissions")),
      );
      assert(
        !log
          .filter((x) => x.argv)
          .at(-1)
          .argv.includes("--dangerously-skip-permissions"),
      );
    } finally {
      await harness.close();
      if (savedBin === undefined) delete process.env.TEAM_ANTIGRAVITY_BIN;
      else process.env.TEAM_ANTIGRAVITY_BIN = savedBin;
      if (savedHome === undefined) delete process.env.TEAM_HARNESS_HOME;
      else process.env.TEAM_HARNESS_HOME = savedHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
