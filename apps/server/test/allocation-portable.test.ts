import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionConfig } from "@team/contracts/runtime";
import type { ExecutionResource } from "@team/contracts/allocation";
import {
  checkExecutionCompatibility,
  migrateLegacyAllocation,
} from "../src/runtime/allocation-contract.js";
import {
  applyPortableImport,
  buildPortablePackage,
  previewPortableImport,
} from "../src/runtime/allocation-portable.js";
import type { PortableImportPreview } from "../src/runtime/allocation-portable.js";
import { executionConfig } from "../src/runtime/validation.js";
import { previewPackage, resourceIssues } from "../../../teamswarm/src/allocation.js";
import { permissionsForAccess, permissionsForMode, permissionsForHarness } from "../../../teamswarm/src/permissions.js";

const config = (patch: Partial<ExecutionConfig> = {}): ExecutionConfig =>
  executionConfig.parse({
    harness: "pi",
    model: "example-model",
    provider: "Example",
    baseUrl: "https://api.example.test/v1",
    credentialEnv: "EXAMPLE_API_KEY",
    ...patch,
  });
/** Local stored edge: carries the owning team. */
const resource = (id = "example", c = config()): ExecutionResource => ({
  id,
  teamId: "local-team",
  version: 1,
  name: "Example",
  description: "",
  config: c,
});
/** Portable edge: the wire resource, which must not carry a team. */
const wire = (id = "example", c = config()) => {
  const { teamId, ...rest } = resource(id, c);
  void teamId;
  return rest;
};
const selection = (key = "default", resourceId = "example", resourceVersion = 1) => ({
  key,
  resourceId,
  resourceVersion,
});
const bundle = () => ({ format: "teamswarm-execution-resources", version: 1,
  resources: [wire()], selections: [selection()] });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isServiceError = (error: unknown, status: number, code?: string): boolean =>
  error instanceof Error &&
  (error as { status?: number }).status === status &&
  (code == null || (error as { code?: string }).code === code);

test("native permissions survive export and the UI accepts the backend package", () => {
  const c = config({ harness: "codex", protocol: "responses", permissions: { harness: "codex", approvalPolicy: "on-request" } });
  const pkg = buildPortablePackage({ resources: [resource("native-policy", c)], selections: [] });
  assert.equal(previewPackage(pkg, []).ok, true);
  assert.deepEqual(pkg.resources[0].config.permissions, c.permissions);
  assert.equal(previewPortableImport(pkg, []).ok, true);
  for (const protocol of ["responses", "anthropic-messages", "chat-completions"] as const) {
    const grok = config({ harness: "grok", protocol });
    assert.deepEqual(resourceIssues(grok), checkExecutionCompatibility(grok));
    assert.deepEqual(resourceIssues(grok), []);
  }
});

test("read-only selection narrows full access and Harness changes preserve native semantics", () => {
  const c = config({ harness: "codex", access: "workspace-write" });
  c.permissions = permissionsForMode(c, "full-access");
  assert.deepEqual(c.permissions, { harness: "codex", approvalPolicy: "never", sandbox: "danger-full-access" });
  const narrowed = { ...c, access: "read-only" as const, permissions: permissionsForAccess(c, "read-only") };
  assert.deepEqual(narrowed.permissions, { harness: "codex", approvalPolicy: "untrusted", sandbox: "read-only" });
  assert.doesNotThrow(() => executionConfig.parse(narrowed));
  assert.deepEqual(permissionsForHarness(c, "claude-code"), { harness: "claude-code", mode: "bypassPermissions" });
  assert.equal(permissionsForHarness(c, "pi"), undefined);
  assert.equal(c.permissions?.harness === "codex" && c.permissions.sandbox, "danger-full-access");
});

test("export keeps only id/version/name/description/config and strips teamId", () => {
  const wide = resource("example", config({ harness: "opencode" })) as
    ExecutionResource & { teamId: string; secretField?: string };
  wide.secretField = "should-never-be-exported";
  const pkg = buildPortablePackage({ resources: [wide], selections: [selection()] });
  assert.equal(pkg.format, "teamswarm-execution-resources");
  assert.equal(pkg.version, 1);
  assert.deepEqual(Object.keys(pkg).sort(), ["format", "resources", "selections", "version"]);
  assert.deepEqual(Object.keys(pkg.resources[0]).sort(),
    ["config", "description", "id", "name", "version"]);
  assert.equal(JSON.stringify(pkg).includes("local-team"), false);
  assert.equal(JSON.stringify(pkg).includes("should-never-be-exported"), false);
  // The wire package round trips through JSON unchanged.
  assert.deepEqual(clone(pkg), pkg);
});

test("one model binds many Harnesses and one Harness saves many models", () => {
  const pkg = buildPortablePackage({
    resources: [
      resource("pi-edge", config({ harness: "pi", model: "example-model" })),
      resource("opencode-edge", config({ harness: "opencode", model: "example-model" })),
      resource("pi-second", config({ harness: "pi", model: "second-model" })),
    ],
    selections: [selection("pi", "pi-edge"), selection("oc", "opencode-edge", 1)],
  });
  const harnesses = (model: string) =>
    [...new Set(pkg.resources.filter((r) => r.config.model === model).map((r) => r.config.harness))].sort();
  const models = (harness: string) =>
    [...new Set(pkg.resources.filter((r) => r.config.harness === harness).map((r) => r.config.model))].sort();
  assert.deepEqual(harnesses("example-model"), ["opencode", "pi"]);
  assert.deepEqual(models("pi"), ["example-model", "second-model"]);
  assert.equal(pkg.selections.length, 2);
});

test("export refuses incompatible configs and secrets that cannot travel", () => {
  assert.throws(() =>
    buildPortablePackage({ resources: [resource("bad", config({ harness: "codex", protocol: "anthropic-messages", effort: "high" }))], selections: [] }),
    (error) => isServiceError(error, 400, "incompatible_resource"));
  const crossProtocol = buildPortablePackage({ resources: [resource("bridge", config({ harness: "codex", protocol: "chat-completions" }))], selections: [] });
  assert.equal(previewPortableImport(crossProtocol, []).ok, true);
  assert.throws(() =>
    buildPortablePackage({ resources: [resource("bad", config({ credentialEnv: null }))], selections: [] }),
    (error) => isServiceError(error, 400, "incompatible_resource"));
  // Pi chat-completions now supports explicit effort; OpenCode still rejects it.
  assert.equal(checkExecutionCompatibility(config({ harness: "opencode", effort: "high" })).includes("unsupported_effort"), true);
  assert.equal(checkExecutionCompatibility(config({ harness: "codex", effort: "high" })).includes("unsupported_effort"), false);
  // Literal secrets, native paths and session-ish fields are not part of the
  // execution grammar, so nothing that carries them can be exported at all.
  // `model` is intentionally free text: a secret pasted there is not
  // syntactically detectable, which is why only real fields are asserted here.
  // Rejection is asserted by behaviour, not by layer: the shared execution
  // grammar refuses these before the exporter ever sees them.
  for (const patch of [
    { baseUrl: "C:/apps/model" } as Partial<ExecutionConfig>,
    { baseUrl: "https://user:pass@api.example.test/v1" } as Partial<ExecutionConfig>,
    { baseUrl: "https://api.example.test/v1?key=x" } as Partial<ExecutionConfig>,
    { baseUrl: "file:///example" } as Partial<ExecutionConfig>,
  ]) {
    assert.throws(() =>
      buildPortablePackage({ resources: [resource("bad", config(patch))], selections: [] }));
  }
  assert.throws(() => buildPortablePackage({ resources: [], selections: [{ key: "x", resourceId: "absent", resourceVersion: 1 }] }),
    (error) => isServiceError(error, 400, "invalid_package"));
});

test("preview maps versions and never throws for arbitrary unknown input", () => {
  const junk: unknown[] = [undefined, null, 0, "", "text", [], { format: "other" },
    { format: "teamswarm-execution-resources" },
    { ...bundle(), version: 9 }, { ...bundle(), version: "1" }, { ...bundle(), resources: "nope" },
    { ...bundle(), selections: [{ key: "", resourceId: 1 }] }, bundle()];
  for (const value of junk) {
    let preview: PortableImportPreview | undefined;
    assert.doesNotThrow(() => {
      preview = previewPortableImport(value, [resource()]);
    });
    assert.ok(preview, JSON.stringify(value));
    const seen = preview as PortableImportPreview;
    assert.ok(Array.isArray(seen.errors) && Array.isArray(seen.conflicts));
    assert.ok(Array.isArray(seen.plan));
    assert.equal(typeof seen.ok, "boolean");
    if (!seen.ok) assert.ok(seen.errors.length > 0, JSON.stringify(value));
  }
  // Prototype-less input and throwing getters are contained too.
  const clean = previewPortableImport(JSON.parse(JSON.stringify(bundle())), []);
  assert.equal(clean.ok, true);
  assert.doesNotThrow(() => previewPortableImport(Object.create(null) as unknown, []));
  assert.doesNotThrow(() => previewPortableImport({ format: "teamswarm-execution-resources", version: 1, resources: [], get selections() { throw new Error("boom"); } }, []));
  const fresh = previewPortableImport(bundle(), []);
  assert.equal(fresh.ok, true);
  assert.deepEqual(fresh.errors, []);
  assert.deepEqual(fresh.conflicts, []);
  assert.deepEqual(fresh.plan, [{ id: "example", fromVersion: 0, toVersion: 1, action: "create" }]);
});

test("preview reports package-internal failures with stable codes", () => {
  const cases: [unknown, string][] = [
    [{ ...bundle(), version: 2 }, "unknown_version"],
    [(() => { const p = bundle(); delete (p as { version?: unknown }).version; return p; })(), "missing_version"],
    [{ ...bundle(), resources: [wire(), wire()] }, "duplicate_resource"],
    [{ ...bundle(), resources: [{ ...wire(), config: { ...config(), credentialEnv: null } }] }, "missing_configuration"],
    [{ ...bundle(), resources: [wire("example", config({ harness: "codex", protocol: "chat-completions", credentialEnv: null }))] }, "missing_configuration"],
    [{ ...bundle(), resources: [wire("example", config({ harness: "pi", effort: "higher" }))] }, "unsupported_effort"],
    [{ ...bundle(), resources: [wire("example", config({ harness: "codex", thinkingFormat: "qwen" }))] }, "unsupported_thinking_format"],
    [{ ...bundle(), token: "not-a-real-secret" }, "invalid_package"],
    [{ ...bundle(), resources: [{ ...wire(), config: { ...config(), baseUrl: "https://user:pass@api.example.test" } }] }, "invalid_package"],
    [{ ...bundle(), resources: [{ ...wire(), config: { ...config(), baseUrl: "C:/keys" } }] }, "invalid_package"],
    [{ ...bundle(), resources: [{ ...wire(), config: { ...config(), sessionFile: "s.json" } }] }, "invalid_package"],
  ];
  for (const [value, code] of cases) {
    const preview = previewPortableImport(value, []);
    assert.equal(preview.ok, false, `${code}: ${JSON.stringify(preview.errors)}`);
    assert.ok(preview.issues.includes(code as never), `${code} not in ${preview.issues.join(",")} | ${preview.errors.join(" ; ")}`);
  }
});

test("a local-shaped resource is rejected as a wire resource, never silently accepted", () => {
  // The package is a wire format: team ownership is local state and must be
  // stripped by the exporter, so a package that still carries teamId is
  // malformed rather than quietly normalized.
  const leaked = previewPortableImport({ ...bundle(), resources: [resource()] }, []);
  assert.equal(leaked.ok, false);
  assert.ok(leaked.issues.includes("invalid_package"), leaked.issues.join(","));
  assert.match(leaked.errors.join(" "), /teamId/);
});

test("preview reports reference and target conflicts as conflicts", () => {
  const internal: [unknown, string][] = [
    [{ ...bundle(), selections: [selection("x", "absent", 1)] }, "unknown_resource"],
    [{ ...bundle(), selections: [selection("x", "example", 2)] }, "version_conflict"],
    [{ ...bundle(), selections: [selection(), selection()] }, "duplicate_selection"],
  ];
  for (const [value, code] of internal) {
    const preview = previewPortableImport(value, []);
    assert.equal(preview.ok, false);
    assert.ok(preview.conflicts.includes(code), `${code} not in ${preview.conflicts.join(",")}`);
    assert.equal(preview.conflictDetails.length, preview.conflicts.length);
    assert.ok(preview.conflictDetails.every((detail) => detail.error === code));
  }
  // A malformed package never inspects the local collection.
  const malformed = previewPortableImport({ ...bundle(), version: 2 }, [resource()]);
  assert.deepEqual(malformed.conflicts, []);
  assert.equal(malformed.ok, false);
});

test("preview separates reusable targets from conflicting local versions", () => {
  const same = previewPortableImport(bundle(), [resource()]);
  assert.equal(same.ok, true);
  assert.deepEqual(same.conflicts, []);
  assert.deepEqual(same.plan, [{ id: "example", fromVersion: 1, toVersion: 1, action: "reuse" }]);

  const drifted = { ...bundle(), resources: [wire("example", config({ model: "newer-model" }))] };
  const preview = previewPortableImport(drifted, [resource()]);
  assert.equal(preview.ok, false);
  assert.deepEqual(preview.conflicts, ["version_conflict"]);
  assert.equal(preview.conflictDetails[0].id, "example");
  assert.equal(preview.conflictDetails[0].resourceVersion, 1);
  // Same identity, different content never maps onto the stored version.
  assert.deepEqual(preview.plan, [{ id: "example", fromVersion: 1, toVersion: 2, action: "bump" }]);
});

test("apply imports atomically, reuses repeats and never half-writes on failure", () => {
  const now = "2026-10-15T12:00:00.000Z";
  const existing: ExecutionResource[] = [resource("kept", config({ model: "kept-model" }))];
  const snapshot = clone(existing);
  const first = applyPortableImport(bundle(), existing, now);
  assert.equal(first.resources.length, 2);
  const added = first.resources.find((r) => r.id === "example");
  assert.equal(added?.version, 1);
  assert.deepEqual(first.plan, [{ id: "example", fromVersion: 0, toVersion: 1, action: "create" }]);
  assert.deepEqual(existing, snapshot); // input collection untouched

  const second = applyPortableImport(bundle(), first.resources, now);
  assert.equal(second.resources.length, first.resources.length); // no duplicate resource
  assert.deepEqual(second.plan, [{ id: "example", fromVersion: 1, toVersion: 1, action: "reuse" }]);

  // Every rejection happens before any value is handed back, and the local
  // collection the caller passed in is byte-identical afterwards.
  assert.throws(() => applyPortableImport(bundle(), existing, "not-a-timestamp"),
    (error) => isServiceError(error, 400, "invalid_timestamp"));
  assert.throws(() => applyPortableImport({ ...bundle(), version: 2 }, existing, now),
    (error) => isServiceError(error, 400, "invalid_package"));
  assert.throws(() => applyPortableImport({ ...bundle(), resources: [{ ...wire(), config: { ...config(), credentialEnv: null } }] }, existing, now),
    (error) => isServiceError(error, 400, "invalid_package"));
  // Same id, different content at the same version: refused, never overwritten.
  assert.throws(() => applyPortableImport({ ...bundle(), resources: [wire("example", config({ model: "different" }))] }, [resource()], now),
    (error) => isServiceError(error, 409, "version_conflict"));
  assert.deepEqual(existing, snapshot);

  // First import creates at the local version, so re-running with the same
  // package is a reuse of the identical content, never an overwrite.
  const created = applyPortableImport(bundle(), [resource("kept", config({ model: "kept-model" }))], now);
  assert.equal(created.resources.find((r) => r.id === "example")?.version, 1);
});

test("a conflicting import keeps the local version and maps an explicit new one", () => {
  const now = "2026-10-15T12:00:00.000Z";
  const local: ExecutionResource = { ...resource("example"), id: "example", teamId: "local-team", version: 3 };
  const preview = previewPortableImport({ ...bundle(), resources: [wire("example", config({ model: "shifted" }))] }, [local]);
  assert.equal(preview.ok, false);
  assert.deepEqual(preview.plan, [{ id: "example", fromVersion: 3, toVersion: 4, action: "bump" }]);
  assert.throws(() => applyPortableImport({ ...bundle(), resources: [wire("example", config({ model: "shifted" }))] }, [local], now),
    (error) => isServiceError(error, 409, "version_conflict"));

  // An identical-content edge only differs by number: it is reported for review
  // with a mapped version rather than silently applied. The selection must pin
  // that same version, otherwise the package is self-inconsistent and refused.
  const older: ExecutionResource = { ...resource("example"), version: 1 };
  const newer = { ...bundle(), resources: [{ ...wire("example"), version: 4 }], selections: [selection("default", "example", 4)] };
  const previewEdge = previewPortableImport(newer, [older]);
  assert.equal(previewEdge.ok, false);
  assert.deepEqual(previewEdge.conflicts, ["version_conflict"]);
  assert.deepEqual(previewEdge.plan, [{ id: "example", fromVersion: 1, toVersion: 5, action: "bump" }]);
  // A brand new local edge is created explicitly at the packaged version 4.
  const emptyLocal: ExecutionResource[] = [];
  const created = applyPortableImport(newer, emptyLocal, now);
  assert.equal(created.resources.length, 1);
  assert.equal(created.resources[0].version, 4);
});

test("a fully valid package commits in one call and carries credential references only", () => {
  const now = "2026-10-15T12:00:00.000Z";
  const pkg = buildPortablePackage({
    resources: [
      resource("pi-edge", config({ harness: "pi" })),
      resource("oc-edge", config({ harness: "opencode", model: "second-model" })),
    ],
    selections: [selection("pi", "pi-edge"), selection("oc", "oc-edge")],
  });
  const result = applyPortableImport(pkg, [], now);
  assert.equal(result.resources.length, 2);
  assert.deepEqual(result.plan, [
    { id: "pi-edge", fromVersion: 0, toVersion: 1, action: "create" },
    { id: "oc-edge", fromVersion: 0, toVersion: 1, action: "create" },
  ]);
  // Credential references survive; no literal secret or native path does.
  assert.equal(result.resources[0].config.credentialEnv, "EXAMPLE_API_KEY");
  const text = JSON.stringify(result.resources);
  for (const forbidden of ["C:/", "\\\\", "session", "installPath", "apiKey", "token", "sk-"])
    assert.equal(text.includes(forbidden), false, forbidden);
});

test("unknown legacy-shaped configs are never guessed into this format", () => {
  // A bare ExecutionConfig is not a package: it must fail validation rather
  // than be migrated into resources by a guessed format.
  const legacy = config({ harness: "claude-code" });
  const preview = previewPortableImport(legacy, [resource()]);
  assert.equal(preview.ok, false);
  assert.ok(preview.issues.includes("invalid_package"), preview.issues.join(","));
  assert.throws(() => applyPortableImport(clone(legacy), [resource()], "2026-10-15T12:00:00.000Z"),
    (error) => isServiceError(error, 400, "invalid_package"));
  // Bare text/absolute paths and credentialed or fragmented endpoints stay
  // outside the format in every position.
  for (const baseUrl of ["file:///example", "https://api.example.test?key=x", "https://api.example.test#x", "C:/apps/model"])
    assert.equal(previewPortableImport({ ...bundle(), resources: [{ ...wire(), config: { ...config(), baseUrl } }] }, []).ok, false);
  // The legacy migration path stays the contract's job, untouched by this module.
  assert.equal(typeof migrateLegacyAllocation, "function");
});
