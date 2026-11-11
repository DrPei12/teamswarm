import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

test("a packaged desktop reuses only the backend build it was started with", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teamswarm-identity-"));
  const data = path.join(root, "data"), product = path.join(root, "product");
  fs.mkdirSync(data); fs.mkdirSync(product);
  const build = { commit: "fixture", sourceSha256: "a".repeat(64) };
  fs.writeFileSync(path.join(product, "build-identity.json"), JSON.stringify(build));
  fs.writeFileSync(path.join(data, "connection.json"), JSON.stringify({ port: 4390, pid: 123, credentialStore: "desktop-keyring" }));
  fs.writeFileSync(path.join(data, "control.json"), JSON.stringify({ token: "local-fixture-only" }));
  const main = fileURLToPath(new URL("../apps/desktop/main.cjs", import.meta.url));
  const require = createRequire(main);
  let reported = build, offlineHealth = false, authenticated = true;
  const electron = {
    app: { isPackaged: true, setName() {}, setAppUserModelId() {}, setPath() {},
      getPath: () => root, getLocale: () => "en", requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { on() {}, handle() {} }, session: {},
  };
  const context = vm.createContext({
    require: id => id === "electron" ? electron : id.endsWith("platform.cjs") ? { dataDirectory: () => data } : require(id),
    __dirname: path.dirname(main),
    process: { env: { TEAMSWARM_USER_DATA: root }, platform: process.platform, resourcesPath: root },
    setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL, AbortSignal, console,
    fetch: async url => {
      if (url.endsWith("/api/teams")) return { ok: authenticated, json: async () => ({ teams: [] }) };
      if (offlineHealth) throw new Error("Fixture health timeout");
      return { ok: true, json: async () => ({ ok: true, build: reported }) };
    },
  });
  try {
    vm.runInContext(fs.readFileSync(main, "utf8") + "\nglobalThis.check = existingService;", context);
    assert.equal((await context.check()).incompatible, false);
    reported = { commit: "old", sourceSha256: "b".repeat(64) };
    assert.equal((await context.check()).incompatible, true);
    reported = undefined;
    assert.equal((await context.check()).incompatible, true);
    offlineHealth = true;
    assert.equal((await context.check()).incompatible, true);
    offlineHealth = false;
    fs.writeFileSync(path.join(product, "build-identity.json"), JSON.stringify({ sourceSha256: "b".repeat(64) }));
    reported = build;
    assert.equal((await context.check()).incompatible, false, "disk replacement must not relabel a running desktop");
    authenticated = false;
    assert.equal(await context.check(), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the server captures its build identity once and leaves development capacity unclaimed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teamswarm-server-identity-"));
  const directory = path.join(root, "apps/server/dist");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "fixture", type: "module" }));
  const source = fs.readFileSync(new URL("../apps/server/src/version.ts", import.meta.url), "utf8");
  const file = path.join(directory, "version.mjs");
  fs.writeFileSync(file, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  try {
    const development = await import(pathToFileURL(file).href + "?development");
    assert.equal(development.productBuild, null);
    const before = { commit: "before", sourceSha256: "a".repeat(64) };
    fs.writeFileSync(path.join(root, "build-identity.json"), JSON.stringify(before));
    const running = await import(pathToFileURL(file).href + "?running");
    assert.deepEqual(running.productBuild, before);
    fs.writeFileSync(path.join(root, "build-identity.json"), JSON.stringify({ commit: "after", sourceSha256: "b".repeat(64) }));
    assert.deepEqual(running.productBuild, before);
    assert(Object.isFrozen(running.productBuild));
    assert.equal((await import(pathToFileURL(file).href + "?restarted")).productBuild.commit, "after");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
