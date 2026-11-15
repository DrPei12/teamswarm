import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createApp } from "../../src/app.js";
import { executionConfig } from "../../src/runtime/validation.js";
import type {
  Harness,
  HarnessRequest,
  Run,
  Work,
} from "../../src/runtime/types.js";
import type { ManagedService } from "@team/contracts/services";

class IdleFixture implements Harness {
  id = "codex";
  capabilities = { fixture: true };
  async inspect() {
    return {};
  }
  async execute(request: HarnessRequest) {
    request.onSession(randomUUID(), {});
    request.onTurn(randomUUID());
    return { status: "completed" as const, text: "Fixture" };
  }
  async interrupt() {}
  async close() {}
}

export async function setup(options: { webDistDir?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-preview-"));
  const project = path.join(root, "project");
  mkdirSync(project);
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const service = createApp({
    dataDir: path.join(root, "data"),
    harnesses: [new IdleFixture()],
    webDistDir: options.webDistDir,
    apiPort: address.port,
  });
  server.on("request", service.app);
  const runtime = service.runtime,
    store = runtime.store;
  const team = service.store.createTeam("Preview team", "");
  const chat = service.store.createConversation(team.id, "预览交接", null)!;
  const config = executionConfig.parse({ harness: "codex", model: "fixture" });
  store.configure(
    team.id,
    {
      workspace: project,
      config,
      timeoutSeconds: 60,
      maxWorksPerRun: 20,
      maxTurnsPerWork: 3,
    },
    0,
  );
  const message = service.store.recordMessage(
    team.id,
    chat.id,
    "检查前端预览并交接给另一位成员",
    randomUUID(),
  )!.message;
  const host = store.enqueueHost(team.id, chat.id, message.id);
  const run = store.get<Run>("runs", team.id, host.runId);
  run.state = "paused";
  store.save("runs", run);
  host.kind = "collaboration";
  store.setStatus(host, "waiting");
  const branch = runtime.history.forRun(run);
  function worker(name: string) {
    const member = store.createMember(
      team.id,
      name,
      "Check frontend",
      config,
      branch.id,
    );
    const work = store.createWork(
      run,
      member.id,
      name,
      "Preview the assigned copy",
      [],
      [],
      [],
    );
    const workspace = path.join(project, name);
    mkdirSync(workspace);
    writeFileSync(
      path.join(workspace, "index.html"),
      `<html><h1>${name} working copy</h1><script src="app.js"></script></html>`,
    );
    writeFileSync(
      path.join(workspace, "app.js"),
      `document.body.dataset.owner=${JSON.stringify(name)};`,
    );
    writeFileSync(path.join(workspace, ".env"), "PREVIEW_SECRET=not-served");
    work.workspace = workspace;
    work.workspaceMode = "isolated";
    store.save("works", work);
    store.setStatus(work, "waiting");
    return work;
  }
  const a = worker("Worker A"),
    b = worker("Worker B");
  let modelCalls = 0;
  runtime.models.brief = async (_config, prompt) => {
    modelCalls++;
    assert.ok(!prompt.includes(root));
    return {
      text: '{"text":"检查交接后的页面"}',
      model: "fixture-mini",
      usage: { totalTokens: 25 },
    };
  };
  const original = runtime.catalog.capabilities.combinations.bind(
    runtime.catalog.capabilities,
  );
  runtime.catalog.capabilities.combinations = (id) => [
    {
      id: "suggestion-fixture",
      teamId: id,
      version: 1,
      name: "Fixture",
      description: "Protocol fixture",
      config: {
        ...config,
        model: "fixture-mini",
        baseUrl: "http://127.0.0.1:1/v1",
        protocol: "responses",
        credentialEnv: "TEST_PREVIEW_KEY",
      },
    },
    ...original(id),
  ];
  const base = `http://127.0.0.1:${address.port}/api`;
  async function api(
    route: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) {
    return fetch(base + route, {
      method,
      headers: {
        authorization: `Bearer ${service.controlToken}`,
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  return {
    root,
    service,
    runtime,
    store,
    team,
    a,
    b,
    host,
    api,
    origin: base.slice(0, -4),
    get modelCalls() {
      return modelCalls;
    },
    start: () =>
      runtime.services.start(
        a,
        { name: "前端预览", directory: "." },
        randomUUID(),
      ),
    async close() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    },
  };
}

export async function until(check: () => boolean) {
  const expires = Date.now() + 6000;
  while (!check()) {
    if (Date.now() > expires) throw new Error("Condition did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
