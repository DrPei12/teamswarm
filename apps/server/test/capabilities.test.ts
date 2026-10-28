import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { executionConfig } from "../src/runtime/validation.js";
import { capabilitiesInput } from "../src/runtime/capabilities.js";
import { checkResource, deriveResource } from "../src/runtime/resource-control.js";
import { checkExecutionCompatibility, canReuseNativeSession } from "../src/runtime/allocation-contract.js";
import {
  deleteResource,
  resolveExecution,
  setHostAllocation,
} from "../src/runtime/allocation.js";
import type {
  Harness,
  HarnessRequest,
  HarnessResult,
  Member,
  Work,
} from "../src/runtime/types.js";

class Fixture implements Harness {
  capabilities = { resume: true };
  requests: HarnessRequest[] = [];
  action: (r: HarnessRequest) => Promise<HarnessResult> = async () => ({
    status: "completed",
    text: "fixture",
  });
  constructor(readonly id: string) {}
  async inspect() {
    return { id: this.id, installed: true, authenticated: true };
  }
  validateConfig() {}
  async execute(r: HarnessRequest) {
    this.requests.push(r);
    r.onSession(r.sessionId ?? randomUUID());
    r.onTurn(randomUUID());
    return this.action(r);
  }
  async interrupt() {}
  async close() {}
}
async function setup() {
  const root = mkdtempSync(path.join(process.cwd(), ".test-capabilities-"));
  mkdirSync(path.join(root, "project"));
  const fixtures = [
    "codex",
    "claude-code",
    "grok",
    "pi",
    "opencode",
    "deepseek-harness",
  ].map((id) => new Fixture(id));
  const service = createApp({
    dataDir: path.join(root, "data"),
    harnesses: fixtures,
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const request = async (
    route: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) => {
    const r = await fetch(
      `http://127.0.0.1:${(server.address() as any).port}/api${route}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${service.controlToken}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return { status: r.status, body: (await r.json()) as any };
  };
  const team = (await request("/teams", { name: "Capabilities fixture" })).body;
  await request(
    `/teams/${team.id}/runtime`,
    {
      expectedVersion: 0,
      workspace: path.join(root, "project"),
      config: { harness: "codex", access: "workspace-write" },
    },
    "PUT",
  );
  const chat = (
    await request(`/teams/${team.id}/conversations`, { title: "Capabilities" })
  ).body;
  const branch = service.runtime.history.forConversation(team.id, chat.id);
  return {
    root,
    service,
    fixtures,
    team,
    chat,
    branch,
    request,
    async close() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const apiConnection = {
  id: "qwen",
  name: "My Qwen",
  kind: "api",
  enabled: true,
  subscriptionHarness: null,
  endpoints: {
    responses: "https://provider.example/v1",
    "chat-completions": "https://provider.example/v1",
    "anthropic-messages": "https://provider.example/anthropic",
  },
  credentialEnv: "CAPABILITY_TEST_KEY",
  models: ["qwen-code", "qwen-fast"],
};

test("independent ChatGPT connection reaches catalog, selection, checking and frozen execution",async()=>{
  const a=await setup();
  try{
    const runtime=a.service.runtime, id=a.team.id, accountId=randomUUID();
    const seed=runtime.catalog.capabilities.read(id);
    runtime.catalog.capabilities.save(id,capabilitiesInput.parse({preferences:seed.preferences,expectedVersion:0,
      enabledHarnesses:["codex","claude-code","grok","pi","opencode","deepseek-harness"],
      connections:[{id:"chatgpt",name:"ChatGPT",kind:"subscription",enabled:true,subscriptionHarness:null,chatgptAccountId:accountId,endpoints:{},credentialEnv:null,models:["gpt-model","gpt-model-small"]}]}));
    const resources=runtime.catalog.capabilities.combinations(id);
    assert.equal(resources.length,12);
    for(const resource of resources)assert.deepEqual(checkExecutionCompatibility(resource.config),[]);
    const resource=resources.find(r=>r.config.harness==="claude-code")!;
    const selection={resourceId:resource.id,resourceVersion:resource.version,reason:"Use Claude tools with ChatGPT"};
    setHostAllocation({store:runtime.store,catalog:runtime.catalog},id,a.branch.id,1,selection);
    const checked=await checkResource(runtime,id,resource.id,resource.version);
    assert.equal(checked.configurationValid,true);assert.equal(checked.authenticated,false);
    assert.equal(checked.connection,"chatgpt");assert.deepEqual(checked.models,[]);
    const derived=deriveResource(runtime,id,{sourceResourceId:resource.id,expectedResourceVersion:resource.version,name:"Small GPT",model:"gpt-model-small",effort:"high",reason:"Short task"});
    assert.equal(derived.config.chatgptAccountId,accountId);
    const posted=await a.request(`/teams/${id}/conversations/${a.chat.id}/messages`,{content:"Use the selected model.",clientRequestId:randomUUID()});
    assert.equal(posted.status,200);
    const work=runtime.store.get<Work>("works",id,posted.body.workId);
    const host=runtime.store.list<Member>("members",id).find(m=>m.kind==="host")!;
    const resolved=resolveExecution({store:runtime.store,catalog:runtime.catalog},id,host,work);
    assert.equal(resolved.conflict,null);assert.equal(resolved.config.harness,"claude-code");assert.equal(resolved.config.chatgptAccountId,accountId);
    assert.equal(canReuseNativeSession(resolved.config,{...resolved.config}),true);
    assert.equal(canReuseNativeSession(resolved.config,{...resolved.config,chatgptAccountId:randomUUID()}),false);
  }finally{await a.close();}
});

test("Legacy migration preserves models on distinct endpoints and the native default", async () => {
  const a = await setup();
  try {
    const c = a.service.runtime.catalog,
      id = a.team.id;
    for (const [url, model] of [
      ["https://a.example/v1", "m1"],
      ["https://b.example/v1", "m2"],
      ["https://b.example/v1", "m3"],
    ])
      c.put(id, model, {
        expectedVersion: 0,
        name: model,
        description: "",
        config: executionConfig.parse({
          harness: "pi",
          provider: "Same",
          credentialEnv: "CAPABILITY_TEST_KEY",
          baseUrl: url,
          model,
        }),
      });
    c.put(id, "native-model", {
      expectedVersion: 0,
      name: "Native",
      description: "",
      config: executionConfig.parse({
        harness: "codex",
        model: "native-model",
      }),
    });
    for (const [baseUrl, model] of [
      ["https://a.example/v1", "m1"],
      ["https://b.example/v1", "m2"],
    ])
      c.put(id, `responses-${model}`, {
        expectedVersion: 0,
        name: model,
        description: "",
        config: executionConfig.parse({
          harness: "codex",
          provider: "Same",
          credentialEnv: "CAPABILITY_TEST_KEY",
          baseUrl,
          model,
          protocol: "responses",
        }),
      });
    const seed = c.capabilities.read(id);
    assert.deepEqual(
      seed.connections.find((x) =>
        Object.values(x.endpoints).includes("https://b.example/v1"),
      )?.models,
      ["m2", "m3"],
    );
    assert.deepEqual(
      seed.connections.find((x) => x.kind === "subscription")?.models,
      [],
    );
    c.capabilities.save(id, { ...seed, expectedVersion: 0 });
    for (const resource of c.legacyResources(id))
      assert(c.capabilities.allowed(id, resource.config), resource.name);
  } finally {
    await a.close();
  }
});

test("Removing an endpoint removes authorization for that protocol even if another protocol uses the same URL", async () => {
  const a = await setup();
  try {
    const c = a.service.runtime.catalog,
      id = a.team.id,
      seed = c.capabilities.read(id);
    c.capabilities.save(
      id,
      capabilitiesInput.parse({
        preferences: seed.preferences,
        expectedVersion: 0,
        enabledHarnesses: ["codex", "pi"],
        connections: [
          {
            ...apiConnection,
            endpoints: { "chat-completions": "https://provider.example/v1" },
          },
        ],
      }),
    );
    assert(
      !c.capabilities.allowed(
        id,
        executionConfig.parse({
          harness: "codex",
          model: "qwen-code",
          baseUrl: "https://provider.example/v1",
          protocol: "responses",
          credentialEnv: "CAPABILITY_TEST_KEY",
        }),
      ),
    );
    assert(
      c.capabilities.allowed(
        id,
        executionConfig.parse({
          harness: "pi",
          model: "qwen-code",
          baseUrl: "https://provider.example/v1",
          protocol: "chat-completions",
          credentialEnv: "CAPABILITY_TEST_KEY",
        }),
      ),
    );
  } finally {
    await a.close();
  }
});

test("Host retains its selected connection for coordination when the user disables it for new selections", async () => {
  const a = await setup();
  try {
    const rt = a.service.runtime,
      id = a.team.id,
      seed = rt.catalog.capabilities.read(id);
    rt.catalog.capabilities.save(id, { ...seed, expectedVersion: 0 });
    const response = await a.request(
      `/teams/${id}/conversations/${a.chat.id}/messages`,
      { content: "Start.", clientRequestId: randomUUID() },
    );
    let work = rt.store.get<Work>("works", id, response.body.workId);
    const until = Date.now() + 5000;
    while (
      !["submitted", "failed"].includes(work.status) &&
      Date.now() < until
    ) {
      await new Promise((r) => setTimeout(r, 10));
      work = rt.store.get<Work>("works", id, work.id);
    }
    assert.equal(work.status, "submitted");
    const host = rt.store
        .list<Member>("members", id)
        .find((m) => m.kind === "host")!,
      resource = rt.catalog.resources(id).find((r) => r.id.startsWith("cap_"))!;
    setHostAllocation(
      { store: rt.store, catalog: rt.catalog },
      id,
      a.branch.id,
      1,
      {
        resourceId: resource.id,
        resourceVersion: resource.version,
        reason: "Task fit",
      },
    );
    const before = rt.catalog.capabilities.read(id);
    rt.catalog.capabilities.save(id, {
      ...before,
      expectedVersion: before.version,
      connections: before.connections.map((c) => ({ ...c, enabled: false })),
    });
    const updated = rt.store.get<Member>("members", id, host.id),
      resolved = resolveExecution(
        { store: rt.store, catalog: rt.catalog },
        id,
        updated,
        work,
      );
    assert.equal(resolved.conflict, null);
    assert.equal(resolved.config.harness, "codex");
    assert.equal(resolved.selection?.resourceId, resource.id);
    assert.equal(
      rt.catalog.memberExecution(id, a.branch.id, updated).selectionRetained,
      true,
    );
    const overridden = resolveExecution(
      { store: rt.store, catalog: rt.catalog },
      id,
      updated,
      {
        ...work,
        selection: {
          resourceId: "cap_missing-other",
          resourceVersion: 1,
          reason: "Different task selection",
        },
      },
    );
    assert.match(overridden.conflict!, /no longer exists/);
    assert.throws(() =>
      rt.catalog.capabilities.assertAllowed(id, resolved.config),
    );
  } finally {
    await a.close();
  }
});

test("Large model catalogs stay outside mandatory Host context", async () => {
  const a = await setup();
  try {
    const c = a.service.runtime.catalog,
      id = a.team.id,
      seed = c.capabilities.read(id);
    c.capabilities.save(
      id,
      capabilitiesInput.parse({
        enabledHarnesses: seed.enabledHarnesses,
        preferences: seed.preferences,
        expectedVersion: 0,
        connections: Array.from({ length: 60 }, (_, i) => ({
          ...apiConnection,
          id: `connection-${i}`,
          models: Array.from(
            { length: 100 },
            (_, n) => `m${n}-` + "x".repeat(190),
          ),
        })),
      }),
    );
    const summary = c.capabilities.summary(id);
    assert(Buffer.byteLength(JSON.stringify(summary)) < 20000);
    assert.equal(summary.connections.length, 60);
    assert.equal(summary.connections[0].modelCount, 100);
  } finally {
    await a.close();
  }
});

test("Migrates legacy connections without mutating resources; saved independent choices produce compatible shared combinations", async () => {
  const a = await setup();
  try {
    const c = a.service.runtime.catalog,
      id = a.team.id;
    c.put(id, "original", {
      expectedVersion: 0,
      name: "Existing Qwen",
      description: "keep",
      config: executionConfig.parse({
        harness: "pi",
        model: "qwen-code",
        baseUrl: "https://provider.example/v1",
        credentialEnv: "CAPABILITY_TEST_KEY",
        protocol: "chat-completions",
      }),
    });
    const seed = c.capabilities.read(id);
    assert.equal(seed.version, 0);
    assert.equal(seed.connections.length, 2);
    assert.equal(c.resources(id).length, 2);
    const input = capabilitiesInput.parse({
      expectedVersion: 0,
      enabledHarnesses: [
        "codex",
        "claude-code",
        "grok",
        "pi",
        "opencode",
        "deepseek-harness",
      ],
      connections: [
        ...seed.connections.filter((x) => x.kind === "subscription"),
        apiConnection,
      ],
      preferences: {
        priority: "economy",
        preferSubscription: true,
        instructions: "Avoid needless coordination.",
      },
    });
    const saved = c.capabilities.save(id, input);
    assert.equal(saved.version, 1);
    assert.equal(
      c.legacyResources(id).find((x) => x.id === "original")?.description,
      "keep",
    );
    const derived = c.resources(id).filter((x) => x.id.startsWith("cap_"));
    assert.equal(derived.length, 13);
    assert.equal(new Set(derived.map((r) => r.id)).size, 13);
    assert.equal(
      derived.find(
        (x) =>
          x.config.harness === "claude-code" && x.config.model === "qwen-code",
      )?.config.protocol,
      "anthropic-messages",
    );
    const chosen = derived.find((x) => x.config.harness === "pi")!;
    assert.throws(() =>
      deleteResource(
        { store: a.service.runtime.store, catalog: c },
        id,
        chosen.id,
      ),
    );
    const stable = c.resources(id).map((x) => [x.id, x.version]);
    c.capabilities.save(id, {
      ...input,
      expectedVersion: 1,
      preferences: { ...input.preferences, priority: "quality" },
    });
    assert.deepEqual(
      c.resources(id).map((x) => [x.id, x.version]),
      stable,
      "Preference changes do not invalidate execution selections",
    );
    assert.throws(
      () => c.capabilities.save(id, input),
      (e: any) => e.code === "version_conflict",
    );
    assert.equal(c.capabilities.read(id).version, 2);
  } finally {
    await a.close();
  }
});

test("Disabling a Harness blocks new member execution and custom selections while preserving frozen attempts", async () => {
  const a = await setup();
  try {
    const rt = a.service.runtime,
      id = a.team.id,
      seed = rt.catalog.capabilities.read(id);
    rt.catalog.capabilities.save(
      id,
      capabilitiesInput.parse({
        expectedVersion: 0,
        enabledHarnesses: ["codex", "pi"],
        connections: [...seed.connections, apiConnection],
        preferences: seed.preferences,
      }),
    );
    const resource = rt.catalog
      .resources(id)
      .find((x) => x.config.harness === "pi")!;
    const member = rt.store.createMember(
      id,
      "Worker",
      "Read",
      resource.config,
      a.branch.id,
    );
    const work = {
      teamId: id,
      memberId: member.id,
      kind: "production",
      interaction: null,
    } as unknown as Work;
    assert.equal(
      resolveExecution(
        { store: rt.store, catalog: rt.catalog },
        id,
        member,
        work,
      ).conflict,
      null,
    );
    const snapshot = structuredClone(resource.config),
      before = rt.catalog.capabilities.read(id);
    rt.catalog.capabilities.save(id, {
      ...before,
      expectedVersion: before.version,
      enabledHarnesses: ["codex"],
    });
    assert.match(
      resolveExecution(
        { store: rt.store, catalog: rt.catalog },
        id,
        member,
        work,
      ).conflict!,
      /no longer enabled/,
    );
    assert.throws(
      () => rt.catalog.capabilities.assertAllowed(id, resource.config),
      (e: any) => e.code === "capability_disabled",
    );
    assert.deepEqual(snapshot, resource.config);
    assert(
      !rt.catalog
        .list(id, a.branch.id, {
          kind: "resources",
          query: "",
          offset: 0,
          limit: 30,
        })
        .items.some((r: any) => r.harness === "pi"),
    );
  } finally {
    await a.close();
  }
});

test("Host receives separate capabilities and preferences and cannot bypass disabled Harness through explicit config", async () => {
  const a = await setup();
  try {
    const rt = a.service.runtime,
      id = a.team.id,
      seed = rt.catalog.capabilities.read(id);
    rt.catalog.capabilities.save(id, {
      ...seed,
      expectedVersion: 0,
      preferences: {
        priority: "quality",
        preferSubscription: false,
        instructions: "Prioritize careful diagnosis.",
      },
    });
    let checked = false;
    let failure: unknown;
    a.fixtures[0].action = async (r) => {
      try {
        const input = JSON.parse(r.input);
        assert.equal(
          input.current.allocation.userCapabilities.preferences.instructions,
          "Prioritize careful diagnosis.",
        );
        const count = rt.store.list<Member>("members", id).length;
        await assert.rejects(
          r.onTool(
            "team_add_member",
            {
              name: "No",
              responsibility: "No",
              config: {
                harness: "pi",
                model: "qwen-code",
                access: "read-only",
              },
            },
            randomUUID(),
          ),
          (e: any) => e.code === "capability_disabled",
        );
        assert.equal(rt.store.list<Member>("members", id).length, count);
        checked = true;
        return { status: "completed", text: "checked" };
      } catch (e) {
        failure = e;
        return { status: "failed", text: "", error: String(e) };
      }
    };
    const sent = await a.request(
      `/teams/${id}/conversations/${a.chat.id}/messages`,
      {
        content: "Review available capabilities.",
        clientRequestId: randomUUID(),
      },
    );
    assert.equal(sent.status, 200);
    const start = Date.now();
    while (!checked && !failure && Date.now() - start < 8000)
      await new Promise((r) => setTimeout(r, 20));
    if (failure) throw failure;
    assert(checked);
  } finally {
    await a.close();
  }
});

test("Model catalog reads the configured provider, filters invalid rows, and does not expose credentials", async () => {
  const a = await setup();
  let observed = false;
  const provider = createServer((req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer private-fixture-key");
    observed = true;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          { id: "qwen-code" },
          { id: "qwen-code" },
          { id: 7 },
          { id: "other-model" },
        ],
      }),
    );
  });
  provider.listen(0, "127.0.0.1");
  await new Promise<void>((r) => provider.once("listening", r));
  process.env.CAPABILITY_TEST_KEY = "private-fixture-key";
  try {
    const r = await a.request(`/teams/${a.team.id}/model-catalog`, {
      endpoints: {
        responses: `http://127.0.0.1:${(provider.address() as any).port}/v1`,
      },
      credentialEnv: "CAPABILITY_TEST_KEY",
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.models, ["qwen-code", "other-model"]);
    assert(observed);
    assert(!JSON.stringify(r.body).includes("private-fixture-key"));
    const invalid = await a.request(
      `/teams/${a.team.id}/capabilities`,
      {
        expectedVersion: 0,
        enabledHarnesses: ["codex"],
        connections: [{ ...apiConnection, credentialEnv: null }],
        preferences: {
          priority: "balanced",
          preferSubscription: true,
          instructions: "",
        },
      },
      "PUT",
    );
    assert.equal(invalid.status, 400);
    assert.equal(
      a.service.runtime.catalog.capabilities.read(a.team.id).version,
      0,
    );
  } finally {
    delete process.env.CAPABILITY_TEST_KEY;
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
    await a.close();
  }
});
