import assert from "node:assert/strict";
import { test } from "node:test";
import { hostConnections, hostDirectChoice, hostModelChoices, resolveHostModel } from "../../../teamswarm/src/hostModelCatalog.ts";

const api = { id: "official-api", name: "Configured API", kind: "api", enabled: true, subscriptionHarness: null,
  credentialEnv: "TEST_KEY", endpoints: { responses: "https://example.test/v1" }, models: ["shared-model"] };
const privateCli = { id: "dev-grok", name: "Grok", kind: "subscription", enabled: false, subscriptionHarness: "grok",
  credentialEnv: null, endpoints: {}, models: [] };
const capabilities = { version: 2, enabledHarnesses: ["codex", "claude-code", "grok", "antigravity"], connections: [api, privateCli] };
const response = (model) => ({ model, name: model });
const savedAccount = { id: "test-account", connected: true };

test("Host offers connected sources together while honoring team disablement", () => {
  const connections = hostConnections(capabilities, [savedAccount]);
  const models = hostModelChoices(connections, {
    "chatgpt:test-account": { authenticated: true, models: [response("shared-model")] },
    "claude-code": { authenticated: true, models: [response("claude-model")] },
    antigravity: { authenticated: null, available: true, models: [response("gemini-model")] },
    grok: { authenticated: true, models: [response("grok-model")] },
    codex: { authenticated: false, models: [response("signed-out")] },
  });
  assert.deepEqual(models.map(m => m.model), ["shared-model", "shared-model", "claude-model", "gemini-model"]);
  assert.notEqual(models[0].key, models[1].key);
  assert.deepEqual(models.filter(hostDirectChoice).map(m => m.connection.id), ["official-api", "host-account:test-account"]);
  assert(!hostConnections({ ...capabilities, inheritsDefaults: false }, [savedAccount]).some(c => c.chatgptAccountId));
});

test("a selection binds its own source without reusing credentials from the prior model", async () => {
  const base = { harness: "claude-code", access: "read-only", model: "old", chatgptAccountId: "old-account", nativeReadProbes: true };
  const connections = hostConnections(capabilities, [savedAccount]);
  const models = hostModelChoices(connections, {
    "chatgpt:test-account": { authenticated: true, models: [response("shared-model")] },
    "claude-code": { authenticated: true, models: [response("claude-model")] },
  });
  const resolve = async (connection, harness, model, access) => ({ harness, model, access,
    provider: connection.name, baseUrl: connection.endpoints.responses, protocol: "responses", credentialEnv: connection.credentialEnv });
  const [apiChoice, chatgptChoice, cliChoice] = models;
  const direct = await resolveHostModel(base, apiChoice.model, apiChoice, resolve);
  assert.equal(direct.baseUrl, api.endpoints.responses);
  assert.equal(direct.credentialEnv, api.credentialEnv);
  assert.equal(direct.chatgptAccountId, null);
  const account = await resolveHostModel(direct, chatgptChoice.model, chatgptChoice, resolve);
  assert.equal(account.chatgptAccountId, savedAccount.id);
  assert.equal(account.protocol, "responses");
  assert.equal(account.credentialEnv, null);
  const cli = await resolveHostModel(account, cliChoice.model, cliChoice, resolve);
  assert.equal(cli.harness, "claude-code");
  assert.equal(cli.baseUrl, null);
  assert.equal(cli.chatgptAccountId, null);
  assert.equal(cli.access, "read-only");
});
