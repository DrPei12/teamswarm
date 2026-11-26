import assert from "node:assert/strict";
import test from "node:test";
import {
  codexModelCatalog,
  nativeModelInstructions,
} from "../src/runtime/harness/codex-model.js";
import { executionConfig } from "../src/runtime/validation.js";

test("custom native catalogs preserve the selected model and frozen capacity without subscription capabilities", () => {
  const config = executionConfig.parse({
    harness: "codex",
    model: "configured-model",
    baseUrl: "https://provider.invalid/v1",
    credentialEnv: "PRIVATE_CREDENTIAL",
  });
  const [model] = codexModelCatalog(config, {
    preset: "128k",
    rawTokens: 128000,
    usableTokens: 121600,
    modelMaxTokens: null,
    effectivePercent: 95,
    source: "estimate",
    overrideNative: true,
  }).models;
  assert.equal(model.slug, "configured-model");
  assert.equal(model.context_window, 128000);
  assert.equal(model.auto_compact_token_limit, 115200);
  assert.equal(model.max_context_window, undefined);
  assert.deepEqual(model.input_modalities, ["text"]);
  assert.deepEqual(model.supported_reasoning_levels, []);
  assert.equal(model.default_reasoning_level, undefined);
  assert.equal(model.multi_agent_version, "v2");
  assert.equal(
    model.model_messages.instructions_template,
    nativeModelInstructions,
  );
  assert.equal(JSON.stringify(model).includes("PRIVATE_CREDENTIAL"), false);
  assert.equal(JSON.stringify(model).includes("provider.invalid"), false);
  const unknown = codexModelCatalog(config).models[0];
  assert.equal(unknown.context_window, undefined);
  assert.equal(unknown.max_context_window, undefined);
});

test("custom reasoning metadata uses the actual provider contract", () => {
  const config = executionConfig.parse({
    harness: "codex",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com",
    credentialEnv: "PRIVATE_CREDENTIAL",
    effort: "medium",
  });
  const model = codexModelCatalog(config).models[0];
  assert.deepEqual(
    model.supported_reasoning_levels.map((e) => e.effort),
    ["none", "low", "high", "max"],
  );
  assert.equal(model.default_reasoning_level, "high");
  assert.deepEqual(
    codexModelCatalog({ ...config, baseUrl: "https://proxy.invalid/v1" })
      .models[0].supported_reasoning_levels,
    [],
  );
});
