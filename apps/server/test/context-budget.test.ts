import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planContext } from '../src/runtime/context-budget.js';

test('required context may use spare input space while preserving output, tool and system reserves', () => {
  const config = {harness:'fixture', model:null, provider:null, baseUrl:null, credentialEnv:null, effort:null, access:'read-only' as const};
  const options = {overheadTokens:16815};
  const base = planContext(config, options);
  const required = planContext(config, {...options, requiredInputTokens:2700});
  assert.ok(base.inputTokens < 2700);
  assert.equal(required.inputTokens, 2700);
  const maximum = required.windowTokens - required.outputReserve - required.toolReserve - options.overheadTokens;
  assert.equal(planContext(config, {...options, requiredInputTokens:100000}).inputTokens, maximum);
  const occupied = planContext(config, {...options, requiredInputTokens:2700, observation:{inputTokens:19000}});
  assert.ok(occupied.inputTokens <= occupied.windowTokens - occupied.outputReserve - occupied.toolReserve - occupied.occupiedTokens);
});
