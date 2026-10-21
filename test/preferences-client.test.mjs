import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = (name) =>
  readFileSync(new URL(`../teamswarm/src/${name}.ts`, import.meta.url), "utf8");
function load(text, globals, dependencies) {
  const exports = {};
  const { outputText } = ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  new Function(...Object.keys(globals), "require", "exports", outputText)(
    ...Object.values(globals),
    (name) => {
      assert.ok(name in dependencies, `Unexpected import: ${name}`);
      return dependencies[name];
    },
    exports,
  );
  return exports;
}
const outbox = load(source("preferences-outbox"), {}, {});
const service = source("service");
function scenario() {
  const values = new Map();
  const storage = {
    get length() {
      return values.size;
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const server = {
    version: 1,
    name: "Draft project",
    theme: "light",
    language: "en",
    teams: [],
    chats: [{ id: "chat", messages: [] }],
    members: [],
    deliveries: [],
    skills: [],
    plugins: [],
    drafts: { chat: { text: "saved text", files: [] } },
    service: { revision: 0 },
  };
  let locked = Promise.resolve();
  const locks = {
    request(_name, callback) {
      const next = locked.then(callback);
      locked = next.catch(() => {});
      return next;
    },
  };
  function tab() {
    let delayed;
    const response = (body) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => structuredClone(body),
    });
    const fetch = async (url, options = {}) => {
      if (url === "/api/product") {
        const snapshot = structuredClone(server);
        if (delayed) {
          const gate = delayed;
          delayed = undefined;
          gate.arrive();
          await gate.wait;
        }
        return response(snapshot);
      }
      assert.equal(url, "/api/product/preferences");
      const patch = JSON.parse(options.body);
      Object.assign(server.drafts, patch.drafts);
      server.service.revision++;
      return response({ revision: server.service.revision });
    };
    const { product } = load(
      service,
      {
        window: {},
        localStorage: storage,
        navigator: { locks },
        fetch,
        AbortSignal,
        location: { hash: "", pathname: "/", search: "" },
        document: { visibilityState: "hidden" },
        history: { replaceState() {} },
        setInterval: () => 1,
        setTimeout: () => 1,
        clearTimeout() {},
      },
      { "./preferences-outbox": outbox, react: { useSyncExternalStore() {} } },
    );
    return {
      product,
      pauseRead() {
        let arrive, release;
        const arrived = new Promise((resolve) => {
          arrive = resolve;
        });
        const wait = new Promise((resolve) => {
          release = resolve;
        });
        delayed = { arrive, wait };
        return { arrived, release };
      },
      edit(text) {
        assert.equal(
          product.update((old) => ({
            ...old,
            drafts: { ...old.drafts, chat: { text, files: [] } },
          })),
          true,
        );
      },
      text: () => product.getSnapshot().workspace.drafts.chat.text,
    };
  }
  return { server, tab };
}

test("a delayed refresh preserves a draft acknowledged by another tab", async () => {
  const { server, tab } = scenario();
  const sender = tab(),
    editor = tab();
  await sender.product.start();
  await editor.product.start();
  editor.edit("edited text");
  const held = editor.pauseRead();
  const refresh = editor.product.refresh();
  await held.arrived;
  await sender.product.flush();
  assert.equal(server.drafts.chat.text, "edited text");
  held.release();
  await refresh;
  assert.equal(editor.text(), "edited text");
  editor.edit(editor.text() + "!");
  await editor.product.flush();
  assert.equal(server.drafts.chat.text, "edited text!");
});

test("a delayed initial snapshot preserves drafts acknowledged while opening a tab", async () => {
  const { tab } = scenario();
  const sender = tab(),
    opening = tab();
  await sender.product.start();
  sender.edit("edited before opening");
  const held = opening.pauseRead();
  const start = opening.product.start();
  await held.arrived;
  await sender.product.flush();
  held.release();
  await start;
  assert.equal(opening.text(), "edited before opening");
});
