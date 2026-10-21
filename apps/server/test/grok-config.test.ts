import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "smol-toml";
import { grokModelConfig } from "../src/runtime/harness/grok-config.js";
import { executionConfig } from "../src/runtime/validation.js";
import { checkExecutionCompatibility } from "../src/runtime/allocation-contract.js";
import { resolveConnection } from "../src/runtime/connections.js";
import { childEnvironment } from "../src/runtime/harness/native-support.js";
import type { HarnessRequest } from "../src/runtime/types.js";

test("Grok selects arbitrary models on every native API protocol with credential references", () => {
  for (const protocol of [
    "chat-completions",
    "responses",
    "anthropic-messages",
  ] as const) {
    const config = executionConfig.parse({
      harness: "grok",
      model: "vendor/model.with-dots",
      baseUrl: "https://example.test/api",
      credentialEnv: "TEST_KEY",
      protocol,
    });
    assert.deepEqual(checkExecutionCompatibility(config), []);
    const parsed = parse(grokModelConfig(config)) as any;
    assert.equal(parsed.models.default, config.model);
    const native = parsed.model[config.model!];
    assert.equal(native.model, config.model);
    assert.equal(native.env_key, "TEST_KEY");
    assert.equal(native.api_key, undefined);
    assert.equal(
      native.api_backend,
      {
        responses: "responses",
        "chat-completions": "chat_completions",
        "anthropic-messages": "messages",
      }[protocol],
    );
    assert.equal(
      native.base_url,
      config.baseUrl + (protocol === "anthropic-messages" ? "/v1" : ""),
    );
    assert.equal(
      resolveConnection(
        {
          name: "Other provider",
          credentialEnv: "TEST_KEY",
          models: [config.model!],
          endpoints: { [protocol]: config.baseUrl! },
        },
        "grok",
        config.model!,
        "read-only",
      ).protocol,
      protocol,
    );
  }
});

test("Custom connections cannot inherit Grok account or endpoint overrides", () => {
  const values = {
    GROK_HOME: "account-home",
    GROK_AUTH_PATH: "account-auth",
    GROK_BASE_URL: "https://account.test",
    XAI_API_HOST: "account.test",
    TEST_CONNECTION_KEY: "test-only",
  };
  const saved = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    const env = childEnvironment({
      config: { credentialEnv: "TEST_CONNECTION_KEY" },
    } as HarnessRequest);
    for (const key of Object.keys(values).filter(
      (key) => key !== "TEST_CONNECTION_KEY",
    ))
      assert.equal(env[key], undefined);
    assert.equal(env.TEST_CONNECTION_KEY, "test-only");
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
