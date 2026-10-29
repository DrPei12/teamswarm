import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelAccess, TeamCapabilities } from "@team/contracts/allocation";
import {
  modelChoices,
  chooseModel,
  selectedModelChoice,
  switchHarness,
} from "../../../teamswarm/src/modelCatalog.js";
import { resolveConnection } from "../src/runtime/connections.js";
import { executionConfig } from "../src/runtime/validation.js";

const apiConnection = (id: string, models: string[]): ModelAccess => ({
  id,
  name: id,
  kind: "api",
  enabled: true,
  subscriptionHarness: null,
  models,
  credentialEnv: `TEST_${id.toUpperCase()}`,
  endpoints: {
    "chat-completions": `https://${id}.example/v1`,
    "anthropic-messages": `https://${id}.example/anthropic`,
  },
});
const connections: ModelAccess[] = [
  apiConnection("primary", ["qwen-plus", "deepseek-chat"]),
  apiConnection("secondary", ["qwen-plus"]),
  { ...apiConnection("disabled", ["hidden-model"]), enabled: false },
  {
    id: "native",
    name: "Claude account",
    kind: "subscription",
    enabled: true,
    subscriptionHarness: "claude-code",
    endpoints: {},
    credentialEnv: null,
    models: ["claude-test"],
  },
];
const capabilities: TeamCapabilities = {
  version: 1,
  enabledHarnesses: ["grok", "claude-code", "codex"],
  connections,
  preferences: {
    priority: "balanced",
    preferSubscription: false,
    instructions: "",
  },
};
const config = executionConfig.parse({
  harness: "grok",
  access: "workspace-write",
});
const resolve = async (
  connection: Pick<
    ModelAccess,
    "name" | "endpoints" | "credentialEnv" | "models"
  >,
  harness: string,
  model: string,
  access: "read-only" | "workspace-write",
) =>
  resolveConnection(
    { ...connection, credentialEnv: connection.credentialEnv! },
    harness,
    model,
    access,
  ).config;

test("Grok exposes configured models across vendors and retains duplicate model connections", async () => {
  const choices = modelChoices(capabilities, {}, "grok");
  assert.deepEqual(
    choices.map((c) => c.model),
    ["qwen-plus", "deepseek-chat", "qwen-plus", "claude-test"],
  );
  assert.equal(choices.filter((c) => c.model === "qwen-plus").length, 2);
  assert.equal(new Set(choices.map((c) => c.key)).size, 4);
  assert.equal(choices[0].unavailable, undefined);
  assert.equal(choices[3].unavailable, "Requires claude-code");
  const selected = await chooseModel(config, "qwen-plus", choices[2], resolve);
  assert.equal(selected.harness, "grok");
  assert.equal(selected.provider, "secondary");
  assert.equal(selected.credentialEnv, "TEST_SECONDARY");
  assert.equal(selected.baseUrl, "https://secondary.example/v1");
  assert.equal(selected.protocol, "chat-completions");
  assert.equal(selectedModelChoice(choices, selected)?.key, choices[2].key);
});

test("changing Harness retains an API model and resolves the correct endpoint without old effort", async () => {
  const choices = modelChoices(capabilities, {}, "grok");
  const selected = await chooseModel(config, "qwen-plus", choices[0], resolve);
  const changed = await switchHarness(
    {
      ...selected,
      effort: "high",
      thinkingFormat: "qwen",
      maxOutputTokens: 1000,
    },
    "claude-code",
    connections,
    resolve,
  );
  assert.equal(changed.model, "qwen-plus");
  assert.equal(changed.provider, "primary");
  assert.equal(changed.credentialEnv, "TEST_PRIMARY");
  assert.equal(changed.protocol, "anthropic-messages");
  assert.equal(changed.baseUrl, "https://primary.example/anthropic");
  assert.equal(changed.effort, null);
  assert.equal(changed.thinkingFormat, null);
  const routed = await switchHarness(selected, "codex", connections, resolve);
  assert.equal(routed.harness, "codex");
  assert.equal(routed.model, selected.model);
  assert.equal(routed.protocol, "anthropic-messages");
  assert.equal(selected.harness, "grok");
});

test("incompatible connections remain visible and native selection clears API credentials", async () => {
  const choices = modelChoices(capabilities, {}, "codex");
  assert.equal(choices.length, 4);
  assert.equal(choices[0].unavailable, undefined);
  const routed = await chooseModel({ ...config, harness: "codex" }, "qwen-plus", choices[0], resolve);
  assert.equal(routed.harness, "codex");
  assert.equal(routed.protocol, "anthropic-messages");
  assert.equal(routed.credentialEnv, "TEST_PRIMARY");
  const claudeChoices = modelChoices(capabilities, {}, "claude-code");
  const native = await chooseModel(
    {
      ...config,
      harness: "claude-code",
      provider: "old",
      baseUrl: "https://old.example",
      credentialEnv: "OLD_KEY",
      effort: "high",
    },
    "claude-test",
    claudeChoices[3],
    resolve,
  );
  assert.equal(native.model, "claude-test");
  for (const key of [
    "provider",
    "baseUrl",
    "credentialEnv",
    "protocol",
    "effort",
  ] as const)
    assert.equal(native[key], null);
});

test("legacy native directory can replace a manual API connection without leaking its credentials", async () => {
  const choices = modelChoices(
    { ...capabilities, version: 0, connections: [] },
    { grok: { models: [{ model: "grok-test", name: "Grok test" }] } },
    "grok",
  );
  const selected = await chooseModel(
    { ...config, baseUrl: "https://old.example", credentialEnv: "OLD_KEY" },
    "grok-test",
    choices[0],
    resolve,
  );
  assert.equal(selected.credentialEnv, null);
  assert.equal(selected.baseUrl, null);
  assert.equal(selected.model, "grok-test");
});

test("independent subscription choices use their account catalog across Harnesses and preserve saved models", () => {
  const account = { ...connections[3], id: "chatgpt", subscriptionHarness: null,
    chatgptAccountId: "account-one", models: ["gpt-fixture", "saved-unlisted"] };
  const directory = { "chatgpt:account-one": { models: [
    { model: "gpt-fixture", name: "Account model", provider: "OpenAI" },
    { model: "not-selected", name: "Not selected" },
  ] }, codex: { models: [{ model: "gpt-fixture", name: "Wrong account catalog" }] } };
  for (const harness of ["grok", "claude-code", "codex"]) {
    const choices = modelChoices({ ...capabilities, connections: [account] }, directory, harness);
    assert.deepEqual(choices.map(model => model.model), ["gpt-fixture", "saved-unlisted"]);
    assert.equal(choices[0].name, "Account model");
    assert.equal(choices[0].provider, "OpenAI");
    assert.equal(choices[0].unavailable, undefined);
    assert.equal(choices[1].name, "saved-unlisted");
  }
});
