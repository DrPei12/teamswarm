import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { setup, until } from "./helpers/service-fixture.js";
import { NativeHarness } from "../src/runtime/harness/native.js";
import { CodexHarness } from "../src/runtime/harness/codex.js";
import {
  executionConfig,
  tools,
  toolSpecs,
} from "../src/runtime/validation.js";
import { DevelopmentWorkingCopy } from "../src/runtime/services/development-project.js";
import { MemberWorkspaces } from "../src/runtime/member-workspaces.js";
import type { Harness, Work } from "../src/runtime/types.js";
import type { ManagedService } from "@team/contracts/services";

// Deterministic CLI fixture for lifecycle races; actual framework evidence is
// recorded separately under .local/dev-service-acceptance.
function developmentFixture(f: Awaited<ReturnType<typeof setup>>) {
  const modules = path.join(f.root, "dependencies", "node_modules");
  const pkg = path.join(modules, "vite");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "vite",
      version: "0.0.0-fixture",
      type: "module",
      bin: { vite: "cli.js" },
    }),
  );
  writeFileSync(
    path.join(pkg, "cli.js"),
    `import http from 'node:http';import fs from 'node:fs';const port=Number(process.argv[process.argv.indexOf('--port')+1]);http.createServer((q,r)=>r.end(fs.readFileSync('state.txt'))).listen(port,'127.0.0.1');`,
  );
  for (const [work, marker] of [
    [f.a, "A_COPY"],
    [f.b, "B_COPY"],
  ] as const) {
    writeFileSync(
      path.join(work.workspace!, "package.json"),
      JSON.stringify({
        name: "lifecycle-fixture",
        type: "module",
        scripts: { dev: "vite" },
      }),
    );
    writeFileSync(path.join(work.workspace!, "state.txt"), marker);
    symlinkSync(
      modules,
      path.join(work.workspace!, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  return {
    framework: "vite" as const,
    script: "dev",
    ready: { path: "/", contains: "A_COPY" },
  };
}
const execution = { harness: "pi", boundary: "device-account" as const };

test("a resource-notice conversation reuses its own isolated copy and rejects another member's copy", async () => {
  const f = await setup();
  try {
    const run = f.store.get<any>("runs", f.team.id, f.b.runId);
    const member = f.store.get<any>("members", f.team.id, f.b.memberId);
    const interaction = f.store.createWork(
      run,
      member.id,
      "Resource notice",
      "Read the resource notice",
      [],
      [],
      [],
    );
    interaction.workspaceMode = "isolated";
    interaction.threadId = f.b.threadId ?? f.b.id;
    interaction.interaction = { messageIds: [], resumeFromWorkId: f.b.id };
    const workspaces = new MemberWorkspaces(f.store, f.runtime.history);
    workspaces.prepare(interaction, member, run);
    assert.equal(interaction.workspace, f.b.workspace);
    assert.match(
      readFileSync(path.join(interaction.workspace!, "index.html"), "utf8"),
      /Worker B/,
    );
    const wrong = {
      ...interaction,
      workspace: undefined,
      threadId: f.a.threadId ?? f.a.id,
      interaction: { messageIds: [], resumeFromWorkId: f.a.id },
    };
    assert.throws(() => workspaces.prepare(wrong, member, run), /own member/);
  } finally {
    await f.close();
  }
});

test(
  "user reopening uses the current source after its original readiness text has changed",
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      const development = developmentFixture(f);
      const first = await f.runtime.services.start(
        f.a,
        { name: "Reopen fixture", directory: ".", development, execution },
        randomUUID(),
      );
      writeFileSync(path.join(f.a.workspace!, "state.txt"), "A_UPDATED");
      await until(
        () =>
          readFileSync(
            path.join(first.runtimeDirectory!, "state.txt"),
            "utf8",
          ) === "A_UPDATED",
      );
      const stopped = await f.runtime.services.stop(
        f.team.id,
        first.id,
        first.version,
        "user",
      );
      const reopened = await f.runtime.services.restart(
        f.team.id,
        stopped.id,
        stopped.version,
      );
      assert.equal(reopened.status, "running");
      assert.notEqual(reopened.id, first.id);
      assert.equal(await (await fetch(reopened.url!)).text(), "A_UPDATED");
    } finally {
      await f.close();
    }
  },
);
async function runLaunch(prefix: string[]) {
  return new Promise<ManagedService>((resolve, reject) => {
    const child = spawn(prefix[0], prefix.slice(1), {
      stdio: "pipe",
      windowsHide: true,
    });
    let output = "",
      errors = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (errors += data));
    child.once("error", reject);
    child.once("close", (code) =>
      code ? reject(new Error(errors || output)) : resolve(JSON.parse(output)),
    );
  });
}

test("development policies reject read-only, missing shell and unverified adapters", () => {
  const pi = new NativeHarness("pi");
  const config = executionConfig.parse({
    harness: "pi",
    model: "fixture",
    permissions: { harness: "pi", tools: ["powershell"] },
  });
  assert.equal(pi.serviceExecution(config).boundary, "device-account");
  assert.throws(
    () => pi.serviceExecution({ ...config, access: "read-only" }),
    /verified/,
  );
  assert.throws(
    () =>
      pi.serviceExecution({
        ...config,
        permissions: { harness: "pi", tools: ["read"] },
      }),
    /verified/,
  );
  assert.equal((new CodexHarness() as Harness).serviceExecution, undefined);
});

test("model tool schemas omit unsupported regex while runtime checks still enforce valid paths and topics", () => {
  const text = JSON.stringify(toolSpecs);
  assert.ok(!text.includes("(?!"));
  const topic = tools.team_host_note.schema.shape.topic;
  assert.equal(topic.parse("项目/接口-v2"), "项目/接口-v2");
  assert.throws(() => topic.parse("bad topic!"));
  const ready = tools.team_preview_prepare.schema.shape.development.shape.ready;
  assert.equal(ready.parse({ path: "/", contains: "A" }).path, "/");
  assert.throws(() =>
    ready.parse({ path: "//external.example", contains: "A" }),
  );
});

test(
  "native launch tickets start no process until invoked, reuse one launch and revoke with work",
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      const development = developmentFixture(f);
      const launch = await f.runtime.services.prepare(
        f.a,
        { name: "Development fixture", directory: ".", development, execution },
        () => {
          if (
            f.store.get<Work>("works", f.team.id, f.a.id).status ===
            "interrupted"
          )
            throw new Error("Work ended.");
        },
      );
      assert.equal(f.runtime.services.list(f.team.id).length, 0);
      const service = await runLaunch(launch.commandPrefix);
      assert.equal(service.id, (await runLaunch(launch.commandPrefix)).id);
      await f.runtime.stop(f.team.id, f.a.id);
      await assert.rejects(runLaunch(launch.commandPrefix), /ended/);
      await assert.rejects(fetch(service.url!));
    } finally {
      await f.close();
    }
  },
);

test(
  "stop preempts pending development handoff and notifies both works once",
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      const development = developmentFixture(f);
      const initial = await f.runtime.services.start(
        f.a,
        { name: "Development fixture", directory: ".", development, execution },
        randomUUID(),
      );
      const offered = await f.runtime.services.handoff(
        f.a,
        initial.id,
        f.b.id,
        initial.version,
      );
      await assert.rejects(
        f.runtime.services.claim(f.b, offered.id, offered.version, {
          path: "/",
          contains: "B_COPY",
        }),
        /execution policy/,
      );
      const claimed = f.runtime.services
        .claim(
          f.b,
          offered.id,
          offered.version,
          { path: "/", contains: "NEVER_READY" },
          execution,
        )
        .then(
          () => null,
          (error) => error,
        );
      await until(
        () => f.runtime.services.list(f.team.id)[0].status === "switching",
      );
      const current = f.runtime.services.list(f.team.id)[0],
        started = Date.now();
      const result = await f.runtime.services.stop(
        f.team.id,
        current.id,
        current.version,
        "user",
      );
      assert.ok(
        Date.now() - started < 5000,
        "Stop must not wait for the compilation deadline",
      );
      assert.equal(result.status, "stopped");
      assert.ok(await claimed);
      await assert.rejects(fetch(initial.url!));
      assert.throws(() => process.kill(initial.nativePid!, 0), {
        code: "ESRCH",
      });
      const notices = f.runtime.correspondence
        .list(f.team.id)
        .filter((message) => message.sourceEventId);
      assert.equal(
        new Set(notices.map((message) => message.sourceEventId)).size,
        1,
      );
      assert.ok(
        notices.some((message) => message.recipientId === f.a.memberId),
      );
      assert.ok(
        notices.some((message) => message.recipientId === f.b.memberId),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "different dependency installations refuse reuse before changing the current server",
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      const development = developmentFixture(f);
      const initial = await f.runtime.services.start(
        f.a,
        { name: "Dependency fixture", directory: ".", development, execution },
        randomUUID(),
      );
      const offered = await f.runtime.services.handoff(
        f.a,
        initial.id,
        f.b.id,
        initial.version,
      );
      unlinkSync(path.join(f.b.workspace!, "node_modules"));
      const second = path.join(f.b.workspace!, "node_modules", "vite");
      mkdirSync(second, { recursive: true });
      writeFileSync(
        path.join(second, "package.json"),
        JSON.stringify({
          name: "vite",
          version: "0.0.0-fixture",
          type: "module",
          bin: { vite: "cli.js" },
        }),
      );
      writeFileSync(
        path.join(second, "cli.js"),
        "throw new Error('B private dependency');",
      );
      await assert.rejects(
        f.runtime.services.claim(
          f.b,
          offered.id,
          offered.version,
          { path: "/", contains: "B_COPY" },
          execution,
        ),
        /dependencies or startup configuration/,
      );
      assert.equal(f.runtime.services.list(f.team.id)[0].status, "running");
      assert.equal(await (await fetch(initial.url!)).text(), "A_COPY");
    } finally {
      await f.close();
    }
  },
);

test(
  "working-copy sync handles file/directory replacement and ignores the previous owner",
  { timeout: 30000 },
  async () => {
    const f = await setup();
    let copy: DevelopmentWorkingCopy | undefined;
    try {
      const development = developmentFixture(f),
        failures: Error[] = [];
      writeFileSync(path.join(f.a.workspace!, "replaced"), "A file");
      mkdirSync(path.join(f.a.workspace!, "former-dir"));
      writeFileSync(path.join(f.a.workspace!, "former-dir/old.txt"), "A child");
      mkdirSync(path.join(f.b.workspace!, "replaced"));
      writeFileSync(path.join(f.b.workspace!, "replaced/child.txt"), "B child");
      writeFileSync(path.join(f.b.workspace!, "former-dir"), "B file");
      copy = new DevelopmentWorkingCopy(
        path.join(f.root, "view"),
        development,
        (error) => failures.push(error),
      );
      await copy.switchTo(f.a.workspace!);
      await copy.switchTo(f.b.workspace!);
      assert.equal(
        readFileSync(path.join(copy.directory, "replaced/child.txt"), "utf8"),
        "B child",
      );
      assert.equal(
        readFileSync(path.join(copy.directory, "former-dir"), "utf8"),
        "B file",
      );
      writeFileSync(path.join(f.a.workspace!, "state.txt"), "A stale");
      writeFileSync(path.join(f.b.workspace!, "state.txt"), "B update");
      await until(
        () =>
          readFileSync(path.join(copy!.directory, "state.txt"), "utf8") ===
          "B update",
      );
      assert.equal(failures.length, 0);
    } finally {
      await copy?.close();
      await f.close();
    }
  },
);
