import assert from "node:assert/strict";
import {test} from "node:test";
import {NativeUsage} from "../src/runtime/harness/native-usage.js";

test("Missing and partial native usage never becomes measured zero", () => {
  const usage = new NativeUsage();
  assert.equal(usage.observe(undefined), null);
  assert.equal(usage.observe({}), null);
  assert.equal(usage.observe({input_tokens: "", output_tokens: -1}), null);
  const partial = usage.observe({input_tokens: 3}, true)!;
  assert.equal(partial.inputTokens, 3);
  assert.equal(partial.outputTokens, null);
  assert.equal(partial.totalTokens, null);
  assert.equal(partial.cost, null);
  assert.equal(usage.observe({input_tokens: 0, output_tokens: 0}, true)!.inputTokens, 0);
});

test("Cumulative native observations preserve gaps and explicit totals", () => {
  const usage = new NativeUsage();
  assert.equal(usage.observe({input: 10, output: 4, total: 14})!.totalTokens, 14);
  const next = usage.observe({input: 6, total: 8})!;
  assert.equal(next.inputTokens, 16);
  assert.equal(next.outputTokens, null);
  assert.equal(next.totalTokens, 22);
  assert.equal(usage.observe({})!.totalTokens, null);
  assert.equal(usage.observe({input: 1, output: 2, cacheRead: 3, cacheWrite: 4}, true)!.totalTokens, 10);
  const missingFirst = new NativeUsage();
  assert.equal(missingFirst.observe({}), null);
  assert.equal(missingFirst.observe({input: 5, output: 2, total: 7})!.totalTokens, null);
});
