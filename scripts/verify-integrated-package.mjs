// Verify the packaged service without configuring or invoking a model.
// node scripts/verify-integrated-package.mjs --product <product-or-install-root>
//   [--installer <setup.exe>] [--expected-version <version>]
//   [--data-dir <new-validation-dir>] [--evidence <new.json>]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = randomUUID(), tokens = new Set();
const evidence = {
  schemaVersion: 1, verifier: "integrated-packaged-service", runId,
  startedAt: new Date().toISOString(), passed: false,
  scope: "Packaged Node service, HTTP integration, Web assets and durable restart.",
  checks: [], http: [], processes: [],
};
let active, evidenceFile;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sanitize = (value) => {
  let text = String(value);
  for (const token of tokens) text = text.split(token).join("[redacted]");
  return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
};
const inside = (base, target) => {
  const relative = path.relative(base, target);
  return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
};
function options() {
  const parsed = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    if (!["--product", "--installer", "--expected-version", "--data-dir", "--evidence"].includes(flag) ||
        !process.argv[i + 1] || process.argv[i + 1].startsWith("--") || flag in parsed)
      throw new Error("Use --product <directory> [--installer <file>] [--expected-version <version>] [--data-dir <new validation directory>] [--evidence <new JSON file>].");
    parsed[flag] = flag === "--expected-version" ? process.argv[i + 1] : path.resolve(process.argv[i + 1]);
  }
  assert(parsed["--product"], "--product is required.");
  return parsed;
}
function productRoot(input) {
  const found = [input, path.join(input, "resources/product"), path.join(input, "Contents/Resources/product")].find((candidate) =>
    existsSync(path.join(candidate, "runtime-manifest.json")) && existsSync(path.join(candidate, "scripts/start-product.mjs")));
  assert(found, "The selected directory has no packaged Node service.");
  return realpathSync(found);
}
function prepareDataDirectory(selected) {
  const localValidation = path.join(checkout, ".local/package-verification");
  const allowed = [localValidation];
  if (process.env.LOCALAPPDATA) allowed.push(path.join(process.env.LOCALAPPDATA, "TeamSwarm/validation"));
  const directory = selected ?? path.join(localValidation, "package-" + runId);
  const base = allowed.find((candidate) => inside(candidate, directory));
  assert(base, "Validation data must be a new child of .local/package-verification or LocalAppData/TeamSwarm/validation.");
  assert(!existsSync(directory), "Refusing to reuse an existing data directory; existing databases are never opened.");
  mkdirSync(base, { recursive: true });
  let ancestor = path.dirname(directory);
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolvedBase = realpathSync(base), resolvedAncestor = realpathSync(ancestor);
  assert(resolvedAncestor === resolvedBase || inside(resolvedBase, resolvedAncestor), "Validation path resolves outside its allowed root.");
  mkdirSync(directory, { recursive: true });
  assert(inside(resolvedBase, realpathSync(directory)), "Validation directory escaped its allowed root.");
  return realpathSync(directory);
}
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { sha256: hash.digest("hex"), bytes: statSync(file).size };
}
function filesIn(root, relative) {
  const full = path.join(root, relative);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [relative.replaceAll("\\", "/")];
  return readdirSync(full, { withFileTypes: true }).flatMap((entry) => {
    assert(!entry.isSymbolicLink(), "Packaged code must not depend on an external symlink: " + relative + "/" + entry.name);
    return filesIn(root, path.join(relative, entry.name));
  });
}
async function codeManifest(root) {
  const runtime = JSON.parse(readFileSync(path.join(root, "runtime-manifest.json"), "utf8"));
  const required = ["package.json", runtime.nodeFile, runtime.codexFile, "scripts/start-product.mjs", "apps/server/dist/app.js", "apps/server/dist/runtime/catalog.js", "apps/server/dist/runtime/host-context.js", "apps/server/dist/runtime/collaboration-records.js", "apps/server/dist/runtime/allocation.js", "apps/server/dist/runtime/allocation-portable.js", "apps/server/dist/runtime/harness/session-scope.js", "teamswarm/dist/index.html", "node_modules/express/package.json"];
  for (const file of required) assert(existsSync(path.join(root, file)), "Missing packaged file: " + file);
  const dependencies = Object.keys(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies ?? {})
    .map((name) => "node_modules/" + name + "/package.json");
  for (const file of dependencies) assert(existsSync(path.join(root, file)), "Missing packaged dependency: " + file);
  const paths = [...new Set([...required, ...dependencies, ...["apps/server/dist", "teamswarm/dist", "packages/contracts", "package-lock.json", "runtime-manifest.json"].flatMap((relative) => filesIn(root, relative))])].sort();
  const files = [];
  for (const relative of paths) files.push({ path: relative, ...await hashFile(path.join(root, relative)) });
  const desktopRoot = path.resolve(root, "../.."), desktop = [];
  for (const relative of ["TeamSwarm.exe", "resources/app.asar"])
    if (existsSync(path.join(desktopRoot, relative)))
      desktop.push({ path: relative, ...await hashFile(path.join(desktopRoot, relative)) });
  return { sha256: digest(JSON.stringify({ files, desktop })), files, desktop };
}
async function check(name, action) {
  const result = { name, startedAt: new Date().toISOString(), passed: false };
  evidence.checks.push(result);
  try {
    const detail = await action();
    if (detail !== undefined) result.detail = detail;
    result.passed = true;
    return detail;
  } catch (error) { result.error = sanitize(error.message); throw error; }
  finally { result.finishedAt = new Date().toISOString(); }
}
async function start(root, dataDirectory, label) {
  const runtime = JSON.parse(readFileSync(path.join(root, "runtime-manifest.json"), "utf8"));
  const record = { label, startedAt: new Date().toISOString(), ready: false, stdoutBytes: 0, stderrBytes: 0 };
  evidence.processes.push(record);
  const env = {
    ...process.env, TEAM_API_PORT: "0", TEAM_DATA_DIR: dataDirectory,
    TEAM_HARNESS_HOME: path.join(dataDirectory, "harnesses"),
    TEAM_CODEX_BIN: path.join(root, runtime.codexFile),
    // Configuration fixture only: the reserved .invalid endpoint is never called.
    PACKAGE_VERIFICATION_KEY: "package-verification-fixture-not-a-real-key",
    PATH: [path.join(root, "runtime"), path.join(root, "runtime/codex/codex-path"), process.env.PATH ?? ""].join(path.delimiter),
  };
  // External modules/preloads and credential loaders are outside this package check.
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "TEAM_HARNESS_MODULES", "TEAM_CREDENTIAL_FILES"]) delete env[key];
  const child = spawn(path.join(root, runtime.nodeFile), [path.join(root, "scripts/start-product.mjs"), "--no-open"], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const stdout = createHash("sha256"), stderr = createHash("sha256");
  child.stdout.on("data", (bytes) => { record.stdoutBytes += bytes.length; stdout.update(bytes); });
  child.stderr.on("data", (bytes) => { record.stderrBytes += bytes.length; stderr.update(bytes); });
  const handle = { child, record, exited: false, base: null, token: null };
  active = handle;
  handle.exit = new Promise((resolve) => child.once("close", (code, signal) => {
    handle.exited = true;
    Object.assign(record, { exitCode: code, signal, exitedAt: new Date().toISOString(), stdoutSha256: stdout.digest("hex"), stderrSha256: stderr.digest("hex") });
    resolve({ code, signal });
  }));
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Packaged service did not send ready IPC within 30 seconds.")), 30000);
    const finish = (error, message) => {
      clearTimeout(timer);
      child.off("message", receive); child.off("error", failed); child.off("exit", premature);
      error ? reject(error) : resolve(message);
    };
    const failed = (error) => finish(new Error("Could not launch packaged service: " + (error.code ?? "spawn failure") + "."));
    const premature = (code) => finish(new Error("Packaged service exited before ready IPC (code " + code + ")."));
    const receive = (message) => {
      if (message?.type !== "ready") return;
      if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535 ||
          typeof message.token !== "string" || !/^[a-zA-Z0-9_-]{32,128}$/.test(message.token))
        return finish(new Error("Packaged service sent invalid ready IPC."));
      finish(null, message);
    };
    child.on("message", receive); child.once("error", failed); child.once("exit", premature);
  });
  tokens.add(ready.token); handle.token = ready.token;
  handle.base = "http://127.0.0.1:" + ready.port;
  Object.assign(record, { ready: true, port: ready.port, pid: child.pid, readyAt: new Date().toISOString() });
  return handle;
}
async function request(handle, route, { method = "GET", body, expected = 200, auth = true, cookie, headers = {}, binary = false } = {}) {
  const url = new URL(route, handle.base);
  assert.equal(url.origin, handle.base, "Only the child service's loopback origin can be queried.");
  const response = await fetch(url, {
    method,
    headers: {
      ...(auth ? { authorization: "Bearer " + handle.token } : {}),
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error", signal: AbortSignal.timeout(12000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  evidence.http.push({ phase: handle.record.label, method, path: route, status: response.status, bytes: bytes.length, bodySha256: digest(bytes) });
  let responseCode;
  if (response.status !== expected) {
    try { responseCode = JSON.parse(bytes.toString("utf8"))?.error?.code; } catch {}
  }
  assert.equal(response.status, expected, method + " " + route + ": unexpected HTTP status" +
    (typeof responseCode === "string" && /^[a-z0-9_]+$/.test(responseCode) ? " (" + responseCode + ")" : "") +
    " (body omitted from diagnostics).");
  return { value: binary ? bytes : JSON.parse(bytes.toString("utf8")), response };
}
const api = async (handle, route, options) => (await request(handle, "/api" + route, options)).value;
async function stop(handle) {
  if (!handle) return;
  const requestedAt = Date.now();
  let forced = false;
  if (!handle.exited) {
    if (handle.child.connected) handle.child.send({ type: "shutdown" }, () => {});
    const timer = setTimeout(() => { forced = true; handle.child.kill("SIGKILL"); }, 15000);
    try { await handle.exit; } finally { clearTimeout(timer); }
  }
  let portClosed = null;
  if (handle.base) {
    // A fresh TCP socket avoids mistaking a pooled fetch socket reset for a live port.
    portClosed = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: handle.record.port });
      const finish = (value) => { socket.destroy(); resolve(value); };
      socket.once("connect", () => finish(false));
      socket.once("error", (error) => finish(error.code === "ECONNREFUSED"));
      socket.setTimeout(2000, () => finish(false));
    });
  }
  Object.assign(handle.record, { shutdownRequested: true, forced, shutdownMs: Date.now() - requestedAt, portClosed });
  if (active === handle) active = undefined;
  assert(!forced, "Packaged service needed forced termination instead of graceful shutdown.");
  assert.equal(handle.record.exitCode, 0, "Packaged service did not exit cleanly.");
  assert.equal(portClosed, true, "Closed service's port was not confirmed to reject connections.");
}
async function transportChecks(handle, root, cookieToReuse) {
  assert.equal((await api(handle, "/health", { auth: false })).ok, true);
  await api(handle, "/teams", { auth: false, expected: 401 });
  await api(handle, "/teams", { auth: false, expected: 401, headers: { authorization: "Bearer invalid-verification-token" } });
  const session = await request(handle, "/api/control/session", { method: "POST", body: {} });
  assert.equal(session.value.connected, true);
  const setCookie = session.response.headers.get("set-cookie");
  assert(setCookie && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), "Control session cookie lacks expected protections.");
  const cookie = setCookie.split(";")[0];
  await api(handle, "/teams", { auth: false, cookie });
  if (cookieToReuse) await api(handle, "/teams", { auth: false, cookie: cookieToReuse });
  await api(handle, "/teams", { method: "POST", body: { name: "must-not-create" }, headers: { origin: "https://untrusted.invalid" }, expected: 403 });
  const webFiles = filesIn(root, "teamswarm/dist");
  for (const relative of webFiles) {
    const relativeUrl = relative.slice("teamswarm/dist/".length);
    const route = relativeUrl === "index.html" ? "/" : "/" + relativeUrl.split("/").map(encodeURIComponent).join("/");
    const { value } = await request(handle, route, { auth: false, binary: true });
    assert.equal(digest(value), digest(readFileSync(path.join(root, relative))), "Static asset differs from package: " + relative);
  }
  return { cookie, publicWebAssetCount: webFiles.length };
}
async function createRecords(handle) {
  // The base API leaves runtime settings absent. Product team creation configures a Host.
  const team = await api(handle, "/teams", { method: "POST", body: { name: "Packaged integration verification", purpose: "Isolated HTTP and restart verification; no model task." }, expected: 201 });
  const prefix = "/teams/" + team.id;
  const initial = await api(handle, prefix + "/runtime");
  assert(!initial.settings && initial.works.length === 0 && initial.runs.length === 0);
  const chat = await api(handle, prefix + "/conversations", { method: "POST", body: { title: "Recorded package discussion" }, expected: 201 });
  const messageBody = { content: "保留同一成果的稳定路径，并在版本历史中记录修改；此消息用于安装包持久化验证。", clientRequestId: randomUUID() };
  const messageRoute = prefix + "/conversations/" + chat.id + "/messages";
  const sent = await api(handle, messageRoute, { method: "POST", body: messageBody });
  assert(!sent.workId, "Recording an unconfigured discussion unexpectedly scheduled execution.");
  const duplicate = await api(handle, messageRoute, { method: "POST", body: messageBody });
  assert.equal(duplicate.message.id, sent.message.id);
  const branch = await api(handle, prefix + "/conversations/" + chat.id + "/branch");
  const branchPrefix = prefix + "/branches/" + branch.id, insightRoute = "/product" + branchPrefix + "/insights";
  const idea = { key: "stable-paths", expectedRevision: 0, kind: "decision", status: "proposed", title: "稳定成果路径", content: messageBody.content, reason: "来自真实保存的讨论消息。", sourceMessageIds: [sent.message.id] };
  const first = await api(handle, insightRoute, { method: "POST", body: { clientRequestId: randomUUID(), insight: idea } });
  assert.equal(first.revision, 1);
  const second = await api(handle, insightRoute, { method: "POST", body: { clientRequestId: randomUUID(), insight: { ...idea, expectedRevision: 1, status: "adopted", reason: "验证采用状态、来源和修订可共同持久保存。" } } });
  assert.equal(second.revision, 2);
  await api(handle, insightRoute, { method: "POST", expected: 409, body: { clientRequestId: randomUUID(), insight: idea } });
  await api(handle, insightRoute, { method: "POST", expected: 400, body: { clientRequestId: randomUUID(), insight: { ...idea, key: "invalid-source", sourceMessageIds: [randomUUID()] } } });
  const harnesses = (await api(handle, "/harnesses")).harnesses.map((h) => h.id);
  for (const id of ["codex", "claude-code", "pi", "deepseek-harness", "opencode"]) assert(harnesses.includes(id), "Missing integrated adapter: " + id);
  for (const input of [
    { id: "verify-codex-a", harness: "codex", model: "package-verification-model-a" },
    { id: "verify-pi-a", harness: "pi", model: "package-verification-model-a" },
    { id: "verify-codex-b", harness: "codex", model: "package-verification-model-b" },
  ]) {
    const resource = { expectedVersion: 0, name: input.id, description: "Configuration-only package probe; this model is never invoked.", config: { harness: input.harness, model: input.model, provider: "package-verification", baseUrl: "https://models.invalid/v1", credentialEnv: "PACKAGE_VERIFICATION_KEY", protocol: input.harness === "codex" ? "responses" : "chat-completions", access: "read-only" } };
    const saved = await api(handle, prefix + "/resources/" + input.id, { method: "PUT", body: resource });
    assert.equal(saved.version, 1);
    await api(handle, prefix + "/resources/" + input.id, { method: "PUT", body: resource, expected: 409 });
  }
  const firstPage = await api(handle, branchPrefix + "/directory?kind=resources&limit=2");
  assert.equal(firstPage.total, 3); assert.equal(firstPage.items.length, 2); assert.equal(firstPage.nextOffset, 2);
  const lastPage = await api(handle, branchPrefix + "/directory?kind=resources&limit=2&offset=2");
  assert.equal(lastPage.items.length, 1); assert.equal(lastPage.nextOffset, null);
  const models = (await api(handle, branchPrefix + "/directory?kind=models")).items;
  assert.equal(models.length, 2);
  assert.deepEqual([...models.find((m) => m.model === "package-verification-model-a").harnesses].sort(), ["codex", "pi"]);
  const detail = await api(handle, branchPrefix + "/directory/detail?kind=resource&id=verify-codex-a");
  assert.equal(detail.resource.config.harness, "codex"); assert.equal(detail.observations.length, 0);
  const context = await api(handle, branchPrefix + "/host-context");
  assert.equal(context.version, 0); assert.deepEqual(context.notes, []);
  assert.equal((await api(handle, branchPrefix + "/host-context/reset", { method: "POST", body: { expectedVersion: 0 } })).version, 1);
  await api(handle, branchPrefix + "/host-context/reset", { method: "POST", body: { expectedVersion: 0 }, expected: 409 });
  const views = await api(handle, branchPrefix + "/views");
  assert.equal(views.branch.id, branch.id); assert.equal(views.project.branchId, branch.id);
  assert.deepEqual(views.collaboration.works, []); assert.deepEqual(views.collaboration.exchanges, []);
  return { teamId: team.id, conversationId: chat.id, branchId: branch.id, messageId: sent.message.id, messageContent: messageBody.content, insightId: second.id, resourceCount: 3, configuredHarnesses: harnesses };
}
async function verifyAllocationPackage(handle, ids) {
  const route = "/teams/" + ids.teamId + "/allocation-package";
  const pkg = await api(handle, route);
  assert.equal(pkg.format, "teamswarm-execution-resources");
  assert.equal(pkg.version, 1);
  assert.equal(pkg.resources.length, 3);
  const destination = await api(handle, "/teams", { method: "POST", body: { name: "Portable configuration destination", purpose: "Model-free import and restart verification." }, expected: 201 });
  const prefix = "/teams/" + destination.id;
  const preview = await api(handle, prefix + "/allocation-package/preview", { method: "POST", body: { package: pkg } });
  assert(preview.ok); assert.deepEqual(preview.conflicts, []);
  assert(preview.plan.every((entry) => entry.action === "create"));
  await api(handle, prefix + "/allocation-package/import", { method: "POST", body: { package: pkg } });
  const first = await api(handle, prefix + "/resources");
  assert.equal(first.resources.length, 3);
  await api(handle, prefix + "/allocation-package/import", { method: "POST", body: { package: pkg } });
  assert.deepEqual(await api(handle, prefix + "/resources"), first, "Repeated import changed persisted resources.");
  const invalid = structuredClone(pkg);
  invalid.resources[0].config.apiKey = "invalid-test-field";
  const badPreview = await api(handle, prefix + "/allocation-package/preview", { method: "POST", body: { package: invalid } });
  assert.equal(badPreview.ok, false);
  await api(handle, prefix + "/allocation-package/import", { method: "POST", body: { package: invalid }, expected: 400 });
  assert.deepEqual(await api(handle, prefix + "/resources"), first, "Rejected import changed persisted resources.");
  // Reuse is defined by resource identity, version and execution configuration.
  // Display-only differences keep the destination's metadata unchanged.
  const displayOnly = structuredClone(pkg);
  displayOnly.resources[0].name += " source display label";
  await api(handle, prefix + "/allocation-package/import", { method: "POST", body: { package: displayOnly } });
  assert.deepEqual(await api(handle, prefix + "/resources"), first, "Display-only reuse changed destination metadata.");
  const conflict = structuredClone(pkg);
  conflict.resources[0].config.model += "-conflicting-model";
  await api(handle, prefix + "/allocation-package/import", { method: "POST", body: { package: conflict }, expected: 409 });
  assert.deepEqual(await api(handle, prefix + "/resources"), first, "Conflicting import changed persisted resources.");
  const missingCredential = await api(handle, prefix + "/resources", { method: "POST", expected: 400, body: { name: "Unavailable custom connection", config: { ...pkg.resources[0].config, credentialEnv: "PACKAGE_VERIFICATION_MISSING_KEY" } } });
  assert.equal(missingCredential.error.code, "credential_unavailable");
  assert.deepEqual(await api(handle, prefix + "/resources"), first);
  const created = await api(handle, prefix + "/resources", { method: "POST", expected: 201, body: { name: "Disposable package verification resource", description: "Created by this verifier only; native configuration is not executed.", config: { harness: "codex", model: null, effort: null, access: "read-only" } } });
  assert.equal(created.version, 1);
  const updated = await api(handle, prefix + "/resources/" + created.id, { method: "PUT", body: { expectedVersion: 1, name: created.name, description: "Updated by this verifier only.", config: created.config } });
  assert.equal(updated.version, 2);
  await api(handle, prefix + "/resources/" + created.id, { method: "DELETE" });
  assert.deepEqual(await api(handle, prefix + "/resources"), first);
  return { teamId: destination.id, resources: first.resources, packageSha256: digest(JSON.stringify(pkg)), nativeModelsInvoked: 0, repeatedImportUnchanged: true, rejectedImportsUnchanged: true };
}
async function verifyRecords(handle, ids) {
  const prefix = "/teams/" + ids.teamId, branchPrefix = prefix + "/branches/" + ids.branchId;
  const detail = await api(handle, prefix + "/conversations/" + ids.conversationId);
  assert.equal(detail.messages.length, 1); assert.equal(detail.messages[0].id, ids.messageId); assert.equal(detail.messages[0].content, ids.messageContent);
  const sources = await api(handle, "/product" + prefix + "/insights/" + ids.insightId + "/sources");
  assert.equal(sources.revisions.length, 2); assert.equal(sources.sources.length, 1);
  assert.equal(sources.sources[0].id, ids.messageId); assert.equal(sources.sources[0].content, ids.messageContent);
  assert.equal(sources.revisions.at(-1).status, "adopted");
  const resources = await api(handle, branchPrefix + "/directory?kind=resources");
  assert.equal(resources.total, ids.resourceCount);
  if (ids.portable) {
    assert.deepEqual((await api(handle, "/teams/" + ids.portable.teamId + "/resources")).resources, ids.portable.resources);
    assert.equal(digest(JSON.stringify(await api(handle, prefix + "/allocation-package"))), ids.portable.packageSha256);
  }
  assert.equal((await api(handle, branchPrefix + "/host-context")).version, 1);
  const state = await api(handle, prefix + "/runtime");
  for (const name of ["works", "runs", "artifacts", "acceptances", "outputs", "exchanges", "deliveries"])
    assert.deepEqual(state[name], [], "Unexpected " + name + " in a no-execution probe.");
  assert(!state.settings); assert.equal(state.insights[0].id, ids.insightId);
  const product = await api(handle, "/product");
  assert(product.teams.some((team) => team.id === ids.teamId && team.configured === false));
  assert(product.chats.find((chat) => chat.id === ids.conversationId)?.messages.some((message) => message.recordId === ids.messageId));
  assert(product.insights.some((idea) => idea.id === ids.insightId && idea.revision === 2));
  assert.deepEqual(product.executions[ids.teamId].attempts, []);
  const events = (await api(handle, prefix + "/events")).events;
  for (const type of ["resource.updated", "host.context_reset", "insight.saved"]) assert(events.some((event) => event.type === type), "Missing durable event: " + type);
  return { messageCount: 1, insightRevisionCount: 2, resourceCount: resources.total, hostContextVersion: 1, nativeAttemptCount: 0, independentAcceptanceCount: 0, eventCount: events.length };
}

try {
  const args = options();
  evidenceFile = args["--evidence"] ?? path.join(checkout, ".local/package-verification", "package-evidence-" + runId + ".json");
  assert(!existsSync(evidenceFile), "Refusing to overwrite an existing evidence file.");
  const root = productRoot(args["--product"]);
  evidence.productRoot = root;
  evidence.versions = await check("expected-package-version", async () => {
    const actual = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
    const expected = args["--expected-version"] ?? JSON.parse(readFileSync(path.join(checkout, "package.json"), "utf8")).version;
    assert.equal(actual, expected, "Selected service package version does not match the requested/current checkout version.");
    return { expected, actual };
  });
  const dataDirectory = prepareDataDirectory(args["--data-dir"]);
  Object.assign(evidence, { productRoot: root, dataDirectory, isolatedFreshData: true, controlTokenExported: false });
  if (args["--installer"]) evidence.installer = { path: args["--installer"], ...await hashFile(args["--installer"]) };
  evidence.code = await check("packaged-code-identity", () => codeManifest(root));
  const first = await check("cold-start-through-packaged-node-and-ipc", async () => {
    const handle = await start(root, dataDirectory, "cold-start");
    return { pid: handle.child.pid, port: handle.record.port, readyThroughIPC: true };
  });
  let cookie;
  await check("health-authentication-and-packaged-web-assets", async () => {
    const result = await transportChecks(active, root); cookie = result.cookie;
    return { publicWebAssetCount: result.publicWebAssetCount, unauthorizedStatus: 401, foreignOriginStatus: 403, cookieAuthenticated: true };
  });
  evidence.records = await check("discussion-insights-directory-and-host-context-integration", () => createRecords(active));
  evidence.records.portable = await check("allocation-portability-and-zero-write-rejection", () => verifyAllocationPackage(active, evidence.records));
  await check("unified-product-view-before-restart", () => verifyRecords(active, evidence.records));
  await check("graceful-shutdown-and-port-closure", async () => { await stop(active); return { graceful: true, exitCode: 0, portClosed: true }; });
  await check("restart-through-same-packaged-node-and-ipc", async () => {
    const handle = await start(root, dataDirectory, "restart");
    assert.notEqual(handle.child.pid, first.pid);
    return { pid: handle.child.pid, port: handle.record.port, reusedSameDataDirectory: true };
  });
  await check("authentication-and-web-assets-after-restart", async () => {
    const result = await transportChecks(active, root, cookie);
    return { priorSessionStillAuthenticates: true, publicWebAssetCount: result.publicWebAssetCount };
  });
  await check("durable-unified-records-after-restart", () => verifyRecords(active, evidence.records));
  await check("second-graceful-shutdown", async () => { await stop(active); return { graceful: true, exitCode: 0, portClosed: true }; });
  await check("packaged-code-remains-unchanged", async () => {
    const after = await codeManifest(root);
    assert.equal(after.sha256, evidence.code.sha256);
    if (evidence.installer) assert.equal((await hashFile(evidence.installer.path)).sha256, evidence.installer.sha256);
    return { sha256: after.sha256, fileCount: after.files.length };
  });
  evidence.passed = true;
} catch (error) {
  evidence.error = sanitize(error.message); process.exitCode = 1;
} finally {
  if (active) {
    try { await stop(active); }
    catch (error) { evidence.cleanupError = sanitize(error.message); evidence.passed = false; process.exitCode = 1; }
  }
  evidence.finishedAt = new Date().toISOString();
  if (evidenceFile && !existsSync(evidenceFile)) {
    try {
      mkdirSync(path.dirname(evidenceFile), { recursive: true });
      writeFileSync(evidenceFile, sanitize(JSON.stringify(evidence, null, 2)) + "\n", { flag: "wx" });
    } catch (error) { evidence.passed = false; process.exitCode = 1; console.error("Evidence could not be saved: " + sanitize(error.message)); }
  }
  console.log(JSON.stringify({ passed: evidence.passed, evidenceFile: evidenceFile ?? null, checks: evidence.checks.length, error: evidence.error ?? evidence.cleanupError ?? null }));
}
