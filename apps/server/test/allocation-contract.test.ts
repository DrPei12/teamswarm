import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionConfig } from "@team/contracts/runtime";
import { allocationBoundary, allocationRequest, assessResourceAvailability,
  canReuseNativeSession, checkExecutionCompatibility, effectiveSelection,
  migrateLegacyAllocation, portableAllocationPackage,
  snapshotExecution } from "../src/runtime/allocation-contract.js";
import { resolveConnection } from "../src/runtime/connections.js";
import { executionConfig } from "../src/runtime/validation.js";

const config = (patch: Partial<ExecutionConfig> = {}): ExecutionConfig => executionConfig.parse({
  harness: "pi", model: "example-model", provider: "Example", baseUrl: "https://api.example.test/v1",
  credentialEnv: "EXAMPLE_API_KEY", ...patch,
});
const resource = (id = "example", c = config()) => ({ id, version: 1, name: "Example", description: "", config: c });
const bundle = () => ({ format: "teamswarm-execution-resources", version: 1,
  resources: [resource()], selections: [{ key: "default", resourceId: "example", resourceVersion: 1 }] });

test("all six Harness combinations agree with existing connection resolution", () => {
  const connection = { name: "Example", models: ["example-model"], credentialEnv: "EXAMPLE_API_KEY",
    endpoints: { responses: "https://api.example.test/v1", "chat-completions": "https://api.example.test/v1",
      "anthropic-messages": "https://api.example.test" } };
  for (const harness of ["codex", "claude-code", "deepseek-harness", "pi", "opencode", "grok"]) {
    const resolved = resolveConnection(connection, harness, "example-model", "read-only");
    assert.deepEqual(checkExecutionCompatibility(resolved.config), []);
  }
  for (const harness of ["codex", "claude-code", "deepseek-harness", "pi", "opencode", "grok"]) {
    for (const protocol of ["responses", "chat-completions", "anthropic-messages"] as const) {
      const valid = ["pi", "opencode", "grok"].includes(harness) || protocol === (harness === "codex" ? "responses" : "anthropic-messages");
      assert.equal(checkExecutionCompatibility(config({ harness, protocol })).includes("incompatible_protocol"), !valid);
    }
  }
});
test("static configuration failures never imply runtime availability", () => {
  assert.deepEqual(checkExecutionCompatibility(config({ harness: "toString" })), ["unknown_harness"]);
  assert.ok(checkExecutionCompatibility(config({ credentialEnv: null })).includes("missing_configuration"));
  assert.ok(checkExecutionCompatibility(config({ effort: "high" })).includes("unsupported_effort"));
  assert.ok(checkExecutionCompatibility(config({ harness: "opencode", thinkingFormat: "qwen" })).includes("unsupported_thinking_format"));
  assert.deepEqual(checkExecutionCompatibility(config({ thinkingFormat: "qwen" })), []);
  assert.deepEqual(checkExecutionCompatibility(executionConfig.parse({})), []); // legacy native Codex login
});
test("portable many-to-many edges and labels round trip without credentials", () => {
  const input = bundle();
  input.resources.push(resource("other-harness", config({ harness: "opencode" })), resource("other-model", config({ model: "second-model" })));
  const parsed = portableAllocationPackage.parse(input);
  assert.deepEqual(portableAllocationPackage.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  assert.equal(parsed.resources.length, 3);
  // One model binds many Harnesses; one Harness saves many models: each resource is one edge.
  const harnesses = (model: string) => [...new Set(parsed.resources.filter((r) => r.config.model === model).map((r) => r.config.harness))].sort();
  const models = (harness: string) => [...new Set(parsed.resources.filter((r) => r.config.harness === harness).map((r) => r.config.model))].sort();
  assert.deepEqual(harnesses("example-model"), ["opencode", "pi"]);
  assert.deepEqual(models("pi"), ["example-model", "second-model"]);
});
test("portable rejects unknown versions, duplicate IDs/labels and stale or absent references", () => {
  assert.equal(portableAllocationPackage.safeParse({ ...bundle(), version: 2 }).success, false);
  assert.equal(portableAllocationPackage.safeParse({ ...bundle(), version: undefined }).success, false);
  assert.equal(portableAllocationPackage.safeParse({ ...bundle(), resources: [resource(), resource()] }).success, false);
  assert.equal(portableAllocationPackage.safeParse({ ...bundle(), selections: [bundle().selections[0], bundle().selections[0]] }).success, false);
  for (const selection of [{ key: "x", resourceId: "absent", resourceVersion: 1 }, { key: "x", resourceId: "example", resourceVersion: 2 }])
    assert.equal(portableAllocationPackage.safeParse({ ...bundle(), selections: [selection] }).success, false);
  assert.equal(portableAllocationPackage.safeParse({ ...bundle(), resources: [resource("example", config({ harness: "codex", protocol: "chat-completions" }))] }).success, false);
});
test("portable rejects literal credential fields, executable/native data and unsafe endpoints", () => {
  for (const extra of [{ token: "not-a-real-secret" }, { apiKey: "not-a-real-secret" }, { sessionId: "x" }, { command: "x" }, { installPath: "C:/example" }]) {
    assert.equal(portableAllocationPackage.safeParse({ ...bundle(), ...extra }).success, false);
    assert.equal(portableAllocationPackage.safeParse({ ...bundle(), resources: [{ ...resource(), config: { ...config(), ...extra } }] }).success, false);
  }
  for (const baseUrl of ["https://user:pass@api.example.test", "https://api.example.test?key=x", "file:///example", "https://api.example.test#x"])
    assert.equal(portableAllocationPackage.safeParse({ ...bundle(), resources: [{ ...resource(), config: { ...config(), baseUrl } }] }).success, false);
  for (const credentialEnv of ["literal-secret", "${EXAMPLE_API_KEY}", "C:/keys", ""])
    assert.equal(portableAllocationPackage.safeParse({ ...bundle(), resources: [{ ...resource(), config: { ...config(), credentialEnv } }] }).success, false);
});
test("safe boundary rejects active/recovery/terminal work, stale revisions and escalation", () => {
  const input = { status: "queued" as const, currentRevision: 2, expectedRevision: 2, access: "read-only" as const, maximumAccess: "read-only" as const };
  assert.equal(allocationBoundary(input), null);
  for (const status of ["running", "stopping", "recovery_required"] as const) assert.equal(allocationBoundary({ ...input, status }), "busy");
  for (const status of ["submitted", "self_checked", "accepted", "superseded", "rejected"] as const) assert.equal(allocationBoundary({ ...input, status }), "invalid_state");
  assert.equal(allocationBoundary({ ...input, expectedRevision: 1 }), "version_conflict");
  assert.equal(allocationBoundary({ ...input, access: "workspace-write" }), "access_escalation");
  assert.equal(allocationRequest.safeParse({ expectedRevision: 1, selection: { resourceId: "example", resourceVersion: 1, reason: "explicit choice" } }).success, true);
});
test("Attempt snapshot detaches selection/config; old records do not invent provenance", () => {
  const c = config();
  const selection = { resourceId: "example", resourceVersion: 1, reason: "explicit choice" };
  const snapshot = snapshotExecution(c, selection);
  c.model = "changed"; selection.resourceVersion = 2;
  assert.equal(snapshot.config.model, "example-model"); assert.equal(snapshot.selection?.resourceVersion, 1);
  assert.equal(snapshotExecution(c).selection, null);
  assert.equal(snapshotExecution(executionConfig.parse({})).config.harness, "codex");
});
test("availability is reported truthfully and never fakes success", () => {
  const checkedAt = "2026-10-15T12:00:00.000Z";
  const observed = (patch = {}) => ({ installed: true, credentialPresent: true, checkedAt, config: config(), ...patch });
  assert.equal(assessResourceAvailability(observed()).status, "available");
  assert.equal(assessResourceAvailability(observed({ checkedAt: null })).status, "not_checked");
  assert.equal(assessResourceAvailability(observed({ installed: false })).status, "not_installed");
  assert.equal(assessResourceAvailability(observed({ credentialPresent: false })).status, "missing_credentials");
  // Static incompatibility outranks install/credential observations and keeps the reasons.
  const bad = assessResourceAvailability(observed({ config: config({ harness: "codex", protocol: "chat-completions" }) }));
  assert.equal(bad.status, "incompatible"); assert.deepEqual(bad.issues, ["incompatible_protocol"]);
  assert.equal(assessResourceAvailability(observed({ installed: false, config: config({ credentialEnv: null }) })).status, "incompatible");
});
test("legacy records migrate with defaults and no invented provenance", () => {
  assert.deepEqual(migrateLegacyAllocation({ config: {} }), { config: executionConfig.parse({}), selection: null });
  const stored = { id: "legacy", config: config({ harness: "claude-code" }), selection: null, extra: "ignored" };
  const migrated = migrateLegacyAllocation(stored);
  assert.equal(migrated.selection, null); assert.equal(migrated.config.harness, "claude-code");
  const withSelection = migrateLegacyAllocation({ config: config(), selection: { resourceId: "example", resourceVersion: 3, reason: "kept" } });
  assert.equal(withSelection.selection?.resourceVersion, 3);
  assert.equal(withSelection.selection?.resourceId, "example");
  assert.throws(() => migrateLegacyAllocation({ selection: null }));
});
test("member default only seeds an Attempt; a task selection always wins", () => {
  const member = { resourceId: "member-default", resourceVersion: 1, reason: "member" };
  const task = { resourceId: "task-pin", resourceVersion: 2, reason: "task" };
  assert.deepEqual(effectiveSelection(member, task), { scope: "task", selection: task });
  assert.deepEqual(effectiveSelection(member, null), { scope: "member-default", selection: member });
  assert.deepEqual(effectiveSelection(null, null), { scope: "member-default", selection: null });
  const out = effectiveSelection(member, null); member.resourceVersion = 9;
  assert.equal(out.selection?.resourceVersion, 1); // copied, not aliased
});
test("session config gate never reuses across Harness/model/access/protocol changes", () => {
  const c = config();
  assert.equal(canReuseNativeSession(c, { ...c }), true);
  for (const patch of [{ harness: "opencode" }, { model: "other" }, { access: "read-only" as const }, { protocol: "responses" as const }])
    assert.equal(canReuseNativeSession(c, { ...c, ...patch }), false);
  const deepseek = config({ harness: "deepseek-harness" });
  assert.equal(canReuseNativeSession(deepseek, deepseek), false);
});
