// Windows native acceptance: node --import tsx test/native/codex-process-reclamation.mjs [rounds]
// With pinned Node: same command + --observe MINUTES LABEL (45–90), or --observe-smoke LABEL.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodexHarness } from "../../apps/server/src/runtime/harness/codex.ts";
import { sampleWindowsProcesses } from "../../apps/server/src/runtime/harness/owned-process.ts";
import { deviceSampler } from "../../apps/server/src/runtime/device-sample.ts";
import { RuntimeResources } from "../../apps/server/src/runtime/resources.ts";
import { RuntimeStore } from "../../apps/server/src/runtime/store.ts";
import { TeamStore } from "../../apps/server/src/store.ts";

if (process.platform !== "win32") {
  console.log("SKIP: Codex Windows Job acceptance requires Windows.");
  process.exit(0);
}
const [, , mode, duration, label] = process.argv;
const observe = mode === "--observe" || mode === "--observe-smoke";
const smoke = mode === "--observe-smoke";
const minutes = observe && !smoke ? Number(duration) : undefined;
const runLabel = smoke ? duration : label;
const rounds = observe ? 0 : Number(mode ?? 1);
if (observe) {
  assert.ok(/^[a-z0-9][a-z0-9-]{0,35}$/.test(runLabel ?? "") && (smoke ? process.argv.length === 4 :
    process.argv.length === 5 && Number.isInteger(minutes) && minutes >= 45 && minutes <= 90),
  "Use --observe MINUTES LABEL (45–90) or --observe-smoke LABEL with a unique lowercase label.");
} else {
  assert.ok(process.argv.length <= 3 && Number.isInteger(rounds) && rounds >= 1 && rounds <= 10,
    "Specify 1–10 rounds (default 1).");
}
const repository = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const arch = process.arch;
assert.ok(["x64", "arm64"].includes(arch), `Unsupported Windows architecture: ${arch}`);
const codex = await realpath(path.join(repository, "node_modules", "@openai", `codex-win32-${arch}`, "vendor",
  `${arch === "x64" ? "x86_64" : "aarch64"}-pc-windows-msvc`, "bin", "codex.exe"));
const relativeCodex = path.relative(repository, codex);
assert.ok(!path.isAbsolute(relativeCodex) && !relativeCodex.startsWith(`..${path.sep}`), "Use the repo-local Codex executable.");
const version = "0.169.0"; // Pin the acceptance protocol and shell contract.
const model = "teamswarm-reclamation-fixture";
const token = "synthetic-loopback-codex-acceptance";
const credentialEnv = "TEAMSWARM_RECLAMATION_TEST_KEY";
const pidLifetimeMs = 120_000;
const waitMs = 55_000;
const prefix = `reclamation-${randomUUID()}`;
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const evidence = observe ? path.join(repository, ".local", "verification", `codex-observation-${runLabel}`) : undefined;
const stopPath = evidence && path.join(evidence, "STOP");
const logPath = evidence && path.join(evidence, "events.jsonl");
const statusPath = evidence && path.join(evidence, "result.json");
const metadataPath = evidence && path.join(evidence, "run.json");
const MiB = 1024 ** 2;
const limits = { activePrivateBytes: 1536 * MiB, fixtureNodeRssBytes: 512 * MiB, minSystemAvailable: 0.12,
  maxWorkers: 2, maxSampleAgeMs: 10_000, maxCpuBusyPercent: 95 };
const lifecycle = new AbortController();
const openedAt = performance.now();
const observation = { phase: "starting", burst: 0, samples: 0, scopedCpuSamples: 0, denied: 0, skipped: 0, workers: 0,
  completedBursts: 0, parallelHeldBursts: 0, peakWorkers: 0, interrupted: 0, resumed: 0, cleanupReceipts: 0, releaseIdle: false,
  residentSamples: 0, idleResidentSamples: 0, residentSpanMs: 0, maxResidentGapMs: 0 };
let deadlineTimer, stopPoll, teamsStore, runtimeStore, res, lastSample, currentHost, expectedShared, sampleFailure, scheduledPhaseEnd;
let firstResidentSample, lastResidentSample, residentIdentity;
let finalStatus = { result: "FAILED" };
const log = (kind, fields = {}) => {
  if (logPath) appendFileSync(logPath, JSON.stringify({ kind, at: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - openedAt), phase: observation.phase, burst: observation.burst, ...fields }) + "\n");
};
const regularPause = ms => sleep(ms, undefined, { signal: lifecycle.signal });
const abort = (message, code) => { if (!lifecycle.signal.aborted) lifecycle.abort(Object.assign(new Error(message), { code })); };
if (evidence) {
  await mkdir(path.dirname(evidence), { recursive: true });
  await mkdir(evidence); // Do not reuse a log directory or a previous run's stop marker.
}
const root = await mkdtemp(evidence ? path.join(evidence, "disposable-profile-") : path.join(repository, ".test-codex-reclamation-"));
let harness = new CodexHarness();
const savedEnv = { ...process.env };
const workspace = path.join(root, "workspace");
const childFile = path.join(workspace, "grandchild.mjs");
const launcher = path.join(workspace, "launcher.mjs");
const scenarios = new Map();
const modelErrors = [];
const measurements = [];
let sequence = 0;

function assertLive(pid) {
  assert.ok(Number.isInteger(pid) && pid > 1, "Expected a Windows PID");
  assert.doesNotThrow(() => process.kill(pid, 0), `Expected live process ${pid}`);
}
function assertGone(pid) {
  assert.ok(Number.isInteger(pid) && pid > 1, "Expected a Windows PID");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `PID ${pid} must have exited`);
}
function deadline(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), waitMs);
  })]).finally(() => clearTimeout(timer));
}

function respond(response, value) {
  const counter = ++sequence;
  const id = `resp_${counter}`;
  const text = typeof value === "string";
  const itemId = `${text ? "msg" : "fc"}_${counter}`;
  const item = text
    ? { id: itemId, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: value, annotations: [] }] }
    : { id: itemId, type: "function_call", status: "completed",
        name: value.name, call_id: value.callId, arguments: JSON.stringify(value.args) };
  let seq = 0;
  const send = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...fields })}\n\n`);
  const shell = { id, object: "response", model, created_at: Math.floor(Date.now() / 1000), error: null, incomplete_details: null };
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  send("response.created", { response: { ...shell, status: "in_progress", output: [] } });
  send("response.output_item.added", { output_index: 0, item: text
    ? { ...item, status: "in_progress", content: [] }
    : { ...item, status: "in_progress", arguments: "" } });
  if (text) {
    send("response.content_part.added", { output_index: 0, content_index: 0,
      item_id: itemId, part: { type: "output_text", text: "", annotations: [] } });
    send("response.output_text.delta", { output_index: 0, content_index: 0, item_id: itemId, delta: value });
    send("response.output_text.done", { output_index: 0, content_index: 0, item_id: itemId, text: value });
    send("response.content_part.done", { output_index: 0, content_index: 0, item_id: itemId, part: item.content[0] });
  } else {
    send("response.function_call_arguments.delta", { output_index: 0, item_id: itemId, delta: item.arguments });
    send("response.function_call_arguments.done", { output_index: 0, item_id: itemId, arguments: item.arguments });
  }
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", { response: { ...shell, status: "completed", output: [item],
    usage: { input_tokens: 300, output_tokens: 40, total_tokens: 340,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  response.end();
}

const shellNames = new Set(["exec_command", "write_stdin", "shell", "shell_command", "local_shell", "terminal.exec", "terminal.write_stdin"]);
const toolNames = tools => tools.flatMap(tool => tool.type === "namespace"
  ? [tool.name, ...tool.tools.flatMap(item => [item.name, `${tool.name}.${item.name}`])]
  : [tool.name ?? tool.type]);
const itemText = item => item?.content?.map(part => part.text ?? "").join("") ?? "";
const modelServer = createServer(async (request, response) => {
  try {
    assert.equal(request.socket.localAddress, "127.0.0.1");
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let length = 0;
    const chunks = [];
    for await (const chunk of request) {
      length += chunk.length;
      assert.ok(length <= 2 * 1024 * 1024, "Fixture request body exceeds its bound");
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(payload.model, model);
    assert.equal(payload.stream, true);
    const latest = payload.input.findLast(item => item.role === "user");
    const scenario = scenarios.get(itemText(latest));
    assert.ok(scenario, "Model received a user message not created by this fixture");
    const names = toolNames(payload.tools);
    scenario.requests++;
    scenario.maxRequestBytes = Math.max(scenario.maxRequestBytes ?? 0, length);
    assert.ok(scenario.requests <= (scenario.callId ? 2 : 1), "Unexpected extra model request");
    if (scenario.host) {
      assert.ok(!names.some(name => shellNames.has(name) || /^(?:terminal|shell)(?:[_.]|$)/.test(name)),
        `Shared Host advertised a native shell: ${names.join(", ")}`);
      assert.ok(payload.tools.some(tool => tool.type === "function" && tool.name === "request_user_input" &&
        tool.parameters?.type === "object"), "Shared Host did not advertise its native question schema");
      scenario.catalog = names;
    } else {
      assert.ok(payload.tools.some(tool => tool.type === "function" && tool.name === "exec_command" &&
        tool.parameters?.properties?.cmd?.type === "string" && tool.parameters.required?.includes("cmd")),
        `Worker did not advertise the native exec_command schema: ${names.join(", ")}`);
    }
    if (scenario.previous) {
      assert.ok(payload.input.some(item => item.role === "assistant" && itemText(item).includes(scenario.previous.answer)),
        "Previous terminal answer is missing from the cold-resumed model request");
      assert.ok(payload.input.some(item => item.type === "function_call_output" && item.call_id === scenario.previous.callId &&
        JSON.stringify(item.output).includes(scenario.previous.probe.marker)),
        "Previous native shell output is missing from the cold-resumed model request");
      respond(response, `resumed ${scenario.previous.probe.marker}`);
    } else if (scenario.previousHost) {
      assert.ok(payload.input.some(item => item.role === "assistant" && itemText(item).includes(scenario.previousHost.answer)),
        "The resumed Host request did not contain the latest saved terminal answer");
      respond(response, scenario.answer);
    } else if (!scenario.callId) {
      if (scenario.hold) {
        scenario.ready.resolve();
        await scenario.gate.promise;
      }
      if (!response.destroyed) respond(response, scenario.answer);
    } else if (scenario.requests === 1) {
      respond(response, { name: "exec_command", callId: scenario.callId, args: {
        cmd: `& ${quote(process.execPath)} ${quote(launcher)} ${quote(childFile)} ${quote(scenario.markerFile)}` +
          (scenario.workload ? ` ${scenario.workload}` : ""),
        workdir: workspace, login: false, yield_time_ms: 10_000,
      } });
    } else {
      const output = payload.input.find(item => item.type === "function_call_output" && item.call_id === scenario.callId);
      assert.ok(output, "Missing native shell output in second model request");
      const probe = await readFile(scenario.markerFile, "utf8").then(JSON.parse, error => {
        throw new Error(`Grandchild did not create its marker (${error.code}); Codex shell output: ${JSON.stringify(output.output).slice(0, 1500)}`);
      });
      assert.match(probe.marker, /^TEAMSWARM_WINDOWS_JOB_[\da-f-]+$/i);
      assert.ok(JSON.stringify(output.output).includes(probe.marker), "Native shell did not return the grandchild marker");
      assertLive(probe.pid);
      assertLive(scenario.session.actual.pid);
      scenario.probe = probe;
      scenario.answer = `normal ${probe.marker}`;
      if (scenario.stop) {
        // Keep a real native turn pending after its command has spawned the descendant.
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": stop fixture waiting for interruption\n\n");
        scenario.ready.resolve();
      } else {
        if (scenario.hold) {
          scenario.ready.resolve();
          await scenario.gate.promise;
        }
        if (!response.destroyed) respond(response, scenario.answer);
      }
    }
  } catch (error) {
    modelErrors.push(error);
    if (!response.headersSent) response.writeHead(500);
    response.end("Synthetic model fixture rejected the request.");
  }
});

function begin(label, options = {}) {
  const input = `${prefix} ${label}${options.inputText ? `\n${options.inputText}` : ""}`;
  const scenario = { label, events: [], requests: 0, ready: Promise.withResolvers(), gate: Promise.withResolvers(), ...options };
  scenarios.set(input, scenario);
  const started = Date.now();
  const runtimeResources = res;
  const attempt = runtimeResources && { id: randomUUID(), config: { harness: "codex" } };
  const work = runtimeResources && { id: randomUUID(), teamId: options.teamId, memberId: options.host ? "host" : label };
  scenario.attemptId = attempt?.id;
  if (runtimeResources) runtimeResources.reserve(work.id, "codex", !!options.host, options.admission.cost, attempt.id);
  scenario.done = deadline(harness.execute({
    workspace,
    config: {
      harness: "codex", model, protocol: "responses", provider: "Synthetic loopback fixture",
      baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, credentialEnv, effort: "none",
      access: options.host ? "read-only" : "workspace-write",
      permissions: { harness: "codex", approvalPolicy: "never", sandbox: options.host ? "read-only" : "workspace-write" },
    },
    ...(options.host ? { hostMode: "dialogue" } : {}),
    sessionId: options.sessionId,
    contextIsolation: "branch",
    instructions: "Run only the deterministic local acceptance fixture.", input, tools: [],
    onTool: async () => { throw new Error("Unexpected Team tool call"); },
    onPermission: async () => "deny",
    onSession: (id, actual) => { scenario.session = { id, actual }; },
    onTurn: id => { scenario.turnId = id; },
    onDispatch: ({ priorTurnIds }) => { scenario.priorTurnIds = priorTurnIds; },
    onEvent: event => {
      if (!runtimeResources || /^(?:resource\.|execution\.root_)/.test(event.type)) scenario.events.push(event);
      if (runtimeResources && event.type.startsWith("resource.")) runtimeResources.observe(work, attempt, event);
    },
  }), label).then(result => {
    if (modelErrors.length) throw modelErrors[0];
    scenario.elapsedMs = Date.now() - started;
    return result;
  }).finally(() => {
    if (runtimeResources) {
      runtimeResources.finish(work.id);
      scenarios.delete(input);
    }
  });
  // A held request can fail before its model-ready rendezvous is reached.
  void scenario.done.catch(() => {});
  return scenario;
}

async function ready(scenario) {
  await deadline(Promise.race([scenario.ready.promise, scenario.done.then(result => {
    throw new Error(`${scenario.label} ended before the fixture rendezvous: ${JSON.stringify(result)}`);
  })]), `${scenario.label} model rendezvous`);
}
function resource(scenario, type) {
  const events = scenario.events.filter(event => event.type === type);
  assert.equal(events.length, 1, `${scenario.label}: expected exactly one ${type}`);
  return events[0].data;
}
function unloaded(scenario, expectedStatus = "completed") {
  assert.deepEqual(resource(scenario, "execution.root_ended"), {
    threadId: scenario.session.id, turnId: scenario.turnId, status: expectedStatus,
  });
  const data = resource(scenario, "execution.root_unloaded");
  assert.equal(data.threadId, scenario.session.id);
  assert.equal(data.turnId, scenario.turnId);
  assert.ok(["thread/closed", "notLoaded"].includes(data.evidence));
  const eventIndex = type => scenario.events.findIndex(event => event.type === type);
  assert.ok(eventIndex("execution.root_ended") < eventIndex("execution.root_unloaded"));
  if (!scenario.host) assert.ok(eventIndex("execution.root_unloaded") < eventIndex("resource.released"));
  return data.evidence;
}
function released(scenario) {
  const acquired = resource(scenario, "resource.acquired");
  assert.equal(acquired.pid, scenario.session.actual.pid);
  assert.equal(acquired.scope, "attempt");
  assert.equal(acquired.ownership, "windows-attempt-job");
  assert.equal(scenario.session.actual.nativeShell, true);
  assert.equal(scenario.session.actual.processScope, "attempt");
  assert.deepEqual(resource(scenario, "resource.released"), { ...acquired, exitEvidence: "windows-job-empty" });
  assert.ok(!scenario.events.some(event => event.type === "resource.unconfirmed"));
  assertGone(acquired.pid);
  assert.ok(!harness.resources().some(group => group.id === acquired.id));
  if (scenario.probe) {
    assert.ok(Date.now() < scenario.probe.expiresAt, "Grandchild's natural expiry would invalidate the cleanup check");
    assertGone(scenario.probe.pid);
  }
  return acquired;
}
function hostStillHere(host, acquired, active) {
  assert.equal(host.session.actual.nativeShell, false);
  assert.equal(host.session.actual.processScope, "shared");
  assert.ok(harness.resources().some(group => group.id === acquired.id && group.pid === acquired.pid &&
    (active ? group.sessions === 1 : group.sessions === 0)), "Shared Host lost its original process or live turn");
  assertLive(acquired.pid);
  assert.ok(!host.events.some(event => event.type === "resource.released" || event.type === "resource.unconfirmed"));
}
function didComplete(result, scenario, text) {
  assert.equal(result.status, "completed", `${scenario.label}: ${JSON.stringify(result)}`);
  assert.equal(result.text.trim(), text);
  assert.ok(scenario.turnId, "Missing native turn ID");
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function sampleGroup(group, processes, previous, elapsedMs) {
  const pids = new Set([group.pid]);
  let size;
  do {
    size = pids.size;
    for (const p of processes) if (pids.has(p.parentPid)) pids.add(p.pid);
  } while (pids.size !== size);
  const members = processes.filter(p => pids.has(p.pid));
  const root = members.find(p => p.pid === group.pid);
  // CPU is the interval sum for stable identities only. A changed membership is
  // explicitly partial; startup/exit between polls can miss CPU and memory peaks.
  const deltas = members.flatMap(p => {
    const prior = previous?.get(`${p.pid}:${p.identity}`);
    return prior === undefined || !Number.isFinite(p.cpuMilliseconds) || p.cpuMilliseconds < prior
      ? [] : [p.cpuMilliseconds - prior];
  });
  return { ...group, identity: root?.identity ?? null,
    processCount: members.length, memberPids: members.map(p => p.pid),
    privateBytes: root ? members.reduce((n, p) => n + p.privateBytes, 0) : null,
    workingSetBytes: root ? members.reduce((n, p) => n + p.workingSet, 0) : null,
    cpuInterval: elapsedMs > 0 && deltas.length ? { ms: elapsedMs, matched: deltas.length,
      cpuMs: deltas.reduce((n, ms) => n + ms, 0) } : null };
}

function openObservationStore(data, teamId) {
  teamsStore = new TeamStore({ dataDir: data });
  const team = teamId ? teamsStore.getTeam(teamId) : teamsStore.createTeam("Codex observation", "Disposable runtime sampling");
  assert.ok(team, "Runtime observation team did not survive store reopen");
  runtimeStore = new RuntimeStore(teamsStore);
  const sampleDevice = deviceSampler();
  let sampleAt, loggedAt, previous, errors = 0;
  res = new RuntimeResources(runtimeStore, new Map([["codex", harness]]), () => {
    try {
      const summary = res.summary();
      if (summary.error || !lastSample || summary.stale) {
        if (!summary.error) return;
        log("sampler.error", { error: summary.error });
        if (++errors >= 3) abort("Three successive Windows sampler or maintenance errors", "SAFETY");
        return;
      }
      errors = 0;
      const { raw, at } = lastSample;
      if (loggedAt === at) return;
      const groups = harness.resources();
      const knownShared = expectedShared ?? currentHost?.events.find(event => event.type === "resource.acquired")?.data;
      const groupSamples = groups.map(group => ({ ...sampleGroup(group, raw.processes, previous, at - sampleAt),
        lane: knownShared?.id === group.id ? "host" : "worker" }));
      const host = groupSamples.find(group => group.lane === "host" && group.identity);
      if (host && observation.phase === "resident-policy-off") {
        assert.ok(!residentIdentity || host.identity === residentIdentity, "Resident Host process identity changed");
        residentIdentity = host.identity;
        firstResidentSample ??= at;
        if (lastResidentSample !== undefined) observation.maxResidentGapMs = Math.max(observation.maxResidentGapMs, Math.round(at - lastResidentSample));
        lastResidentSample = at;
        observation.residentSpanMs = Math.round(at - firstResidentSample);
        observation.residentSamples++;
        if (!currentHost) observation.idleResidentSamples++;
      }
      const node = raw.processes.find(p => p.pid === process.pid);
      const fixtureNodeRssBytes = process.memoryUsage().rss;
      const workerCount = groupSamples.filter(p => p.lane === "worker").length;
      log("sample", { activity: currentHost ? "host-window" : "idle", releaseIdle: observation.releaseIdle,
        system: summary.system, activeReservations: summary.teamswarm.activeReservations,
        harnessTreePrivateBytes: summary.teamswarm.privateBytes, pendingCpuCores: summary.pendingCpu,
        fixtureNode: { pid: process.pid, rssBytes: fixtureNodeRssBytes, privateBytes: node?.privateBytes ?? null },
        groups: groupSamples });
      observation.samples++;
      observation.scopedCpuSamples += groupSamples.filter(group => group.cpuInterval).length;
      observation.peakWorkers = Math.max(observation.peakWorkers, workerCount);
      loggedAt = at;
      sampleAt = at;
      previous = new Map(raw.processes.map(p => [`${p.pid}:${p.identity}`, p.cpuMilliseconds]));
      if (fixtureNodeRssBytes > limits.fixtureNodeRssBytes || summary.teamswarm.privateBytes > limits.activePrivateBytes ||
          availableFraction(raw) < limits.minSystemAvailable || workerCount > limits.maxWorkers) {
        abort("Available resource headroom or fixture limits exceeded", "SAFETY");
      }
    } catch (error) {
      sampleFailure ??= error;
      abort("Unable to record the Windows observation sample", "SAFETY");
    }
  }, async () => {
    const raw = await sampleDevice();
    lastSample = { raw, at: performance.now() };
    return raw;
  }, undefined, Date.now, () => observation.releaseIdle);
  return team.id;
}

function availableFraction(sample) {
  return Math.min(sample.availablePhysical / sample.totalPhysical,
    sample.totalCommit ? sample.availableCommit / sample.totalCommit : 1);
}

async function closeObservationStore() {
  await res?.close();
  runtimeStore?.close();
  teamsStore?.close();
  res = runtimeStore = teamsStore = lastSample = undefined;
}

async function observedStart(teamId, label, options) {
  lifecycle.signal.throwIfAborted();
  // Let the real product sampler/reconciler update before evaluating this dispatch.
  if (!lastSample || performance.now() - lastSample.at > 2500) await res.refresh();
  lifecycle.signal.throwIfAborted();
  const decision = res.admission("codex", !!options.host);
  const system = res.summary().system;
  const fresh = lastSample && performance.now() - lastSample.at <= limits.maxSampleAgeMs && system.cpuBusyPercent !== null;
  const allow = fresh && system.cpuBusyPercent < limits.maxCpuBusyPercent && decision.allowed &&
    availableFraction(lastSample.raw) >= limits.minSystemAvailable;
  log("admission", { label, lane: options.host ? "host" : "worker", systemCpuBusyPercent: system.cpuBusyPercent,
    cpuTargetPercent: res.policy().cpuTargetPercent, decision, started: !!allow, fresh: !!fresh });
  if (!decision.allowed) observation.denied++;
  if (!allow) { observation.skipped++; return undefined; }
  return begin(label, { ...options, admission: decision, teamId });
}

function recordTurn(scenario, acquired, unload) {
  const receipt = runtimeStore.db.prepare("SELECT data FROM runtime_events WHERE attempt_id=? AND type='resource.turn_measured'").get(scenario.attemptId);
  assert.ok(receipt, `${scenario.label}: runtime measurement receipt is missing`);
  log("turn", { label: scenario.label, group: acquired, nativeSessionId: scenario.session.id,
    nativeTurnId: scenario.turnId, largestRequestBytes: scenario.maxRequestBytes, requests: scenario.requests,
    durationMs: scenario.elapsedMs, unload, measurement: JSON.parse(String(receipt.data)) });
}

function verifyObservedHostRelease(host) {
  const acquired = resource(host, "resource.acquired");
  const ended = resource(host, "resource.released");
  assert.deepEqual(ended, { ...acquired, exitEvidence: "windows-job-empty" });
  assertGone(ended.pid);
  assert.deepEqual(harness.resources(), []);
  assert.equal(runtimeStore.db.prepare("SELECT state FROM runtime_process_groups WHERE id=?").get(ended.id)?.state, "released");
  observation.cleanupReceipts++;
  return ended;
}

async function observedBurst(teamId, latest) {
  const burst = observation.burst;
  const continuation = !!latest && burst % 4 === 0;
  const label = `host-${burst}`;
  const host = await observedStart(teamId, label, { host: true, hold: true,
    sessionId: continuation ? latest.session.id : undefined,
    inputText: `Context fixture ${burst}\n` + `Review channel ${burst}: preserve local decisions.\n`.repeat([8, 64, 192, 24][burst % 4]),
    answer: `host terminal ${prefix} ${burst}` });
  if (!host) return latest;
  currentHost = host;
  const active = [];
  try {
    await ready(host);
    const shared = resource(host, "resource.acquired");
    if (expectedShared) assert.deepEqual(shared, expectedShared, "Shared Host recycled during the resident measurement phase");
    else expectedShared = shared;
    if (continuation) assert.equal(host.session.id, latest.session.id);
    hostStillHere(host, shared, true);
    const workerCount = burst % 3 === 1 ? 2 : 1;
    for (let i = 0; i < workerCount; ++i) {
      const name = `worker-${burst}-${i}`;
      const worker = await observedStart(teamId, name, { callId: `call_${burst}_${i}`, stop: i === 0 && burst % 5 === 1,
        hold: true, markerFile: path.join(workspace, `${name}.json`), workload: (burst + i) % 4 + 1 });
      if (worker) active.push(worker);
    }
    await Promise.all(active.map(ready));
    if (active.length) {
      // The spawned payload must still be live when each independent Job is closed.
      // Sampling those known probe PIDs separately surfaces descendants lost from
      // the Windows parent snapshot when an intermediate shell already exited.
      await res.refresh();
      const probeSamples = await Promise.all(active.map(async worker => {
        const { pid } = worker.probe;
        const sample = await sampleWindowsProcesses(pid);
        const probe = sample.processes.find(p => p.pid === pid);
        assert.ok(probe, `${worker.label}: live detached probe missing from direct sample`);
        return { worker: worker.label, workload: worker.workload, ...probe, inFixtureAncestry: !!lastSample.raw.processes.find(p => p.pid === pid) };
      }));
      log("live-job-probes", { probes: probeSamples });
      if (active.length > 1) observation.parallelHeldBursts++;
      await regularPause([2600, 4100, 3200][burst % 3]);
    }
    for (const worker of active) {
      if (worker.stop) {
        await deadline(harness.interrupt(worker.session.id, worker.turnId), "native interrupt");
        assert.equal((await worker.done).status, "interrupted");
        observation.interrupted++;
      } else {
        worker.gate.resolve();
        didComplete(await worker.done, worker, worker.answer);
      }
      const group = released(worker);
      const unload = unloaded(worker, worker.stop ? "interrupted" : "completed");
      recordTurn(worker, group, unload);
      log("job-empty", { label: worker.label, pid: group.pid, probePid: worker.probe.pid, groupId: group.id,
        exitEvidence: "windows-job-empty", probeLifetimeRemainingMs: worker.probe.expiresAt - Date.now() });
      observation.cleanupReceipts++;
      observation.workers++;
      hostStillHere(host, shared, true);
      for (const sibling of active.slice(active.indexOf(worker) + 1)) {
        assertLive(sibling.session.actual.pid);
        assertLive(sibling.probe.pid);
        log("sibling-survived", { released: group.id, livePid: sibling.session.actual.pid, liveProbePid: sibling.probe.pid });
      }
    }
    const previous = active.find(worker => !worker.stop);
    if (previous && burst % 3 === 1 && !lifecycle.signal.aborted) {
      const resume = await observedStart(teamId, `resume-${burst}`, { sessionId: previous.session.id, previous });
      if (resume) {
        didComplete(await resume.done, resume, `resumed ${previous.probe.marker}`);
        assert.equal(resume.session.id, previous.session.id);
        assert.ok(resume.priorTurnIds.includes(previous.turnId));
        assert.notEqual(resume.turnId, previous.turnId);
        const group = released(resume);
        assert.notEqual(group.id, resource(previous, "resource.acquired").id);
        recordTurn(resume, group, unloaded(resume));
        observation.cleanupReceipts++;
        observation.resumed++;
      }
    }
    host.gate.resolve();
    didComplete(await host.done, host, host.answer);
    recordTurn(host, shared, unloaded(host));
    hostStillHere(host, shared, false);
    observation.completedBursts++;
    return host;
  } finally {
    currentHost = undefined;
    for (const worker of active) worker.gate.resolve();
    host.gate.resolve();
  }
}

async function runObservation() {
  const probeSample = await sampleWindowsProcesses(process.pid);
  const { availablePhysical, totalPhysical, availableCommit, totalCommit } = probeSample;
  log("preflight", { availablePhysical, totalPhysical, availableCommit, totalCommit, minAvailableFraction: limits.minSystemAvailable });
  const supervisorDirectory = path.join(root, "supervisor");
  const [supervisorBuild] = await readdir(supervisorDirectory);
  const supervisorBinary = path.join(supervisorDirectory, supervisorBuild, "owned-process.exe");
  log("windows-supervisor", { path: supervisorBinary, sha256: await sha256(supervisorBinary) });
  if (availableFraction(probeSample) < limits.minSystemAvailable) {
    throw Object.assign(new Error("Insufficient system physical or commit headroom to start a run"), { code: "HEADROOM" });
  }
  let latest;
  let teamId = openObservationStore(path.join(root, "data"));
  // Use the actual idle-retention setting boundary, not a patched clock or a
  // synthetic TTL. Keeping one group resident is the measurement intervention.
  observation.phase = "resident-policy-off";
  log("phase", { releaseIdle: false, systemCpuTargetPercent: res.policy().cpuTargetPercent });
  await res.refresh();
  await regularPause(850);
  await res.refresh();
  const phaseStart = performance.now();
  scheduledPhaseEnd = phaseStart + (smoke ? 50_000 : minutes * 60_000);
  while (performance.now() < scheduledPhaseEnd) {
    const burstStart = performance.now();
    observation.burst++;
    latest = (await observedBurst(teamId, latest)) ?? latest;
    if (smoke && observation.completedBursts >= 2) {
      await regularPause(2400);
      await res.refresh();
      break;
    }
    const delay = Math.min(scheduledPhaseEnd - performance.now(), Math.max(2400, burstStart + (smoke ? 16_000 : 24_000) - performance.now()));
    await regularPause(Math.max(0, delay));
  }
  lifecycle.signal.throwIfAborted();
  assert.ok(latest, "No shared Host survived the resident phase");
  assert.ok(observation.completedBursts >= (smoke ? 2 : minutes), "Too few representative Host bursts completed");
  assert.ok(observation.workers >= (smoke ? 2 : minutes) && observation.interrupted > 0 && observation.resumed > 0 &&
    observation.parallelHeldBursts > 0 && observation.scopedCpuSamples > 0, "The workload did not cover the required native lanes");
  assert.ok(observation.residentSpanMs >= (smoke ? 15_000 : (minutes - 0.5) * 60_000) && observation.idleResidentSamples > 0 &&
    observation.maxResidentGapMs <= 30_000, "Same-generation resident samples did not cover a sustained active/idle window");
  log("resident-window-ended", { durationMs: Math.round(performance.now() - phaseStart), group: expectedShared, ...observation });
  observation.phase = "idle-policy-on";
  observation.releaseIdle = true;
  log("phase", { releaseIdle: true });
  const idleDeadline = performance.now() + 75_000;
  while (harness.resources().length && performance.now() < idleDeadline) {
    await regularPause(2000);
    await res.refresh();
  }
  const oldShared = verifyObservedHostRelease(latest);
  log("idle-job-empty", { group: oldShared });
  await harness.close();
  await closeObservationStore();
  harness = new CodexHarness();
  expectedShared = undefined;
  observation.phase = "restart-native-and-reopen-store";
  teamId = openObservationStore(path.join(root, "data"), teamId);
  assert.equal(runtimeStore.db.prepare("SELECT state FROM runtime_process_groups WHERE id=?").get(oldShared.id)?.state, "released");
  assert.equal(runtimeStore.db.prepare("SELECT count(*) AS n FROM runtime_process_groups WHERE state != 'released'").get().n, 0);
  log("phase", { priorGroup: oldShared, oldSession: latest.session.id });
  await res.refresh();
  const retryUntil = performance.now() + (smoke ? 11_000 : 60_000);
  let reopened;
  while (!reopened && performance.now() < retryUntil) {
    await regularPause(1000);
    await res.refresh();
    reopened = await observedStart(teamId, "restart", { host: true, sessionId: latest.session.id,
      previousHost: latest, answer: `resumed saved Host ${prefix}` });
  }
  assert.ok(reopened, "Live CPU admission did not allow a Host restart");
  currentHost = reopened;
  try { didComplete(await reopened.done, reopened, reopened.answer); }
  finally { currentHost = undefined; }
  const shared = resource(reopened, "resource.acquired");
  assert.equal(reopened.session.id, latest.session.id);
  assert.notEqual(reopened.turnId, latest.turnId);
  assert.ok(reopened.priorTurnIds.includes(latest.turnId));
  assert.notEqual(shared.id, oldShared.id);
  expectedShared = shared;
  recordTurn(reopened, shared, unloaded(reopened));
  await res.refresh();
  await deadline(harness.close(), "close reopened job");
  log("restart-job-empty", { group: verifyObservedHostRelease(reopened), resumedSession: reopened.session.id });
  assert.deepEqual(modelErrors, []);
  lifecycle.signal.throwIfAborted();
}

try {
  if (observe) {
    assert.equal(process.version, "v24.22.0", "Observation requires the product's pinned Node runtime");
    const pinnedNode = await realpath(path.join(repository, ".codex-local", "runtime-cache", "v24.22.0", `win32-${arch}`, "node.exe"));
    assert.equal((await realpath(process.execPath)).toLowerCase(), pinnedNode.toLowerCase());
    const git = promisify(execFile);
    const [head, gitStatus, ...digests] = await Promise.all([
      git("git", ["-C", repository, "rev-parse", "HEAD"], { timeout: 8000 }),
      git("git", ["-C", repository, "status", "--porcelain"], { timeout: 8000 }),
      ...[codex, pinnedNode, fileURLToPath(import.meta.url), ...["harness/codex.ts", "harness/owned-process.ts", "device-sample.ts", "resources.ts"]
        .map(file => path.join(repository, "apps", "server", "src", "runtime", file))].map(async file => [file, await sha256(file)]),
    ]);
    const maxRunMs = (smoke ? 3 : minutes + 5) * 60_000;
    await writeFile(metadataPath, JSON.stringify({ mode, pid: process.pid, startedAt: new Date().toISOString(),
      plannedResidentMinutes: minutes ?? null, hardWorkDeadlineAt: new Date(Date.now() + maxRunMs).toISOString(),
      command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)], baseCommit: head.stdout.trim(),
      gitStatusAtStart: gitStatus.stdout.trim(), hashes: Object.fromEntries(digests), profileDirectory: root,
      evidence: logPath, terminalResult: statusPath, nodeVersion: process.version, codexVersion: version, limits,
      sampling: "RuntimeResources using deviceSampler and Windows native process ancestry; known detached probes sampled separately",
      phases: ["same resident Host, idle release disabled", "true idle with normal product release enabled", "new native process and reopened SQLite store"],
      stop: { method: "Create the STOP file, then await result.json; never kill by image name", path: stopPath },
    }, null, 2) + "\n", { flag: "wx" });
    deadlineTimer = setTimeout(() => abort("Bounded observation ran out of time", "WORK_DEADLINE"), maxRunMs);
    stopPoll = setInterval(() => { if (existsSync(stopPath)) abort("Stop marker received", "STOP_REQUESTED"); }, 750);
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort(`Received ${signal}`, "STOP_REQUESTED"));
    log("started", { profileDirectory: root });
  }
  const systemRoot = savedEnv.SystemRoot ?? "C:\\Windows";
  const system = path.join(systemRoot, "System32");
  const profile = path.join(root, "profile");
  const codexHome = path.join(profile, ".codex");
  const temp = path.join(root, "tmp");
  const appData = path.join(profile, "AppData", "Roaming");
  const localAppData = path.join(profile, "AppData", "Local");
  const programData = path.join(root, "program-data");
  for (const dir of [workspace, codexHome, temp, appData, localAppData, programData]) await mkdir(dir, { recursive: true });
  // Drop the caller environment entirely. Do not import a real home, account,
  // ambient proxy, Git config, credential, or tooling into the Codex subprocess.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    SYSTEMROOT: systemRoot, WINDIR: systemRoot, SYSTEMDRIVE: path.parse(systemRoot).root.slice(0, 2),
    COMSPEC: path.join(system, "cmd.exe"), PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PATH: [system, path.join(system, "WindowsPowerShell", "v1.0"), systemRoot].join(path.delimiter),
    HOME: profile, USERPROFILE: profile, APPDATA: appData, LOCALAPPDATA: localAppData, PROGRAMDATA: programData,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(profile, "empty.gitconfig"),
    TEMP: temp, TMP: temp, TMPDIR: temp, TEAMSWARM_SUPERVISOR_DIR: path.join(root, "supervisor"),
    TEAM_CODEX_BIN: codex, TEAM_CODEX_HOME: codexHome, TEAM_HARNESS_HOME: path.join(root, "harness"),
    TEAM_HARNESS_TEST_MODE: "1", [credentialEnv]: token,
  });
  const { stdout } = await promisify(execFile)(codex, ["--version"], { cwd: workspace, timeout: 15_000, windowsHide: true });
  assert.equal(stdout.trim(), `codex-cli ${version}`);
  modelServer.listen(0, "127.0.0.1");
  await once(modelServer, "listening");
  // Any non-loopback HTTP client is routed here and rejected; even built-in
  // OpenAI URL fallbacks point to the local fixture, not to an external API.
  const localUrl = `http://127.0.0.1:${modelServer.address().port}`;
  Object.assign(process.env, {
    HTTP_PROXY: localUrl, HTTPS_PROXY: localUrl, ALL_PROXY: localUrl, NO_PROXY: "localhost,127.0.0.1,::1",
  });
  modelServer.on("connect", (_request, socket) => {
    modelErrors.push(new Error("Unexpected attempt to open an outbound proxy tunnel"));
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await writeFile(path.join(codexHome, "config.toml"), `model = ${JSON.stringify(model)}
model_provider = "teamswarm"
openai_base_url = ${JSON.stringify(localUrl + "/v1")}
chatgpt_base_url = ${JSON.stringify(localUrl)}
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
web_search = "disabled"
[analytics]
enabled = false
[feedback]
enabled = false
[sandbox_workspace_write]
network_access = false
[windows]
sandbox = "unelevated"
[model_providers.teamswarm]
name = "Synthetic loopback fixture"
base_url = ${JSON.stringify(localUrl + "/v1")}
wire_api = "responses"
env_key = ${JSON.stringify(credentialEnv)}
requires_openai_auth = false
`);
  await writeFile(childFile, `import { writeFileSync, renameSync } from "node:fs";
import { pbkdf2Sync, randomUUID } from "node:crypto";
const marker = process.argv[2], lifetime = ${pidLifetimeMs};
const workload = Number(process.argv[3] || 0);
if (!Number.isInteger(workload) || workload < 0 || workload > 4) throw new Error("Unexpected fixture load");
setTimeout(() => {}, lifetime);
const retained = Buffer.alloc(workload * 1024 * 1024, 37);
let pulses = 0;
if (workload) {
  const tick = setInterval(() => {
    pbkdf2Sync(retained.subarray(0, 32), "local-fixture", workload * 8000, 32, "sha256");
    if (++pulses === 12) clearInterval(tick);
  }, 400);
}
writeFileSync(marker + ".tmp", JSON.stringify({ pid: process.pid, marker: "TEAMSWARM_WINDOWS_JOB_" + randomUUID(), expiresAt: Date.now() + lifetime }));
renameSync(marker + ".tmp", marker);
`);
  await writeFile(launcher, `import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
const [, , childFile, markerFile, workload] = process.argv;
const child = spawn(process.execPath, [childFile, markerFile, ...(workload ? [workload] : [])], { detached: true, windowsHide: true, stdio: "ignore" });
let startError;
child.on("error", error => { startError = error; });
child.unref();
async function awaitMarker() {
  for (let attempt = 0; attempt < 80; ++attempt) {
    if (startError) throw startError;
    const marker = await readFile(markerFile, "utf8").then(JSON.parse, error => { if (error.code !== "ENOENT") throw error; });
    if (marker) return marker;
    await sleep(50);
  }
  throw new Error("Grandchild did not write a marker");
}
const marker = await awaitMarker();
if (marker.pid !== child.pid) throw new Error("Unexpected grandchild PID");
console.log(marker.marker);
`);

  if (observe) {
    await runObservation();
    finalStatus = { result: smoke ? "PASS_SMOKE" : "PASS", measured: "Codex native runtime and SQLite resource accounting with loopback model", ...observation };
  }
  let hostSession, lastHost;
  for (let round = 1; round <= rounds; round++) {
    const host = begin(`host ${round}`, { host: true, hold: true, answer: `host ready ${round}`, sessionId: hostSession });
    await ready(host);
    const shared = resource(host, "resource.acquired");
    if (lastHost) assert.deepEqual(shared, resource(lastHost, "resource.acquired"));
    hostStillHere(host, shared, true);

    const normal = begin(`normal ${round}`, { callId: `call_normal_${round}`, markerFile: path.join(workspace, `normal-${round}.json`) });
    didComplete(await normal.done, normal, normal.answer);
    assert.equal(normal.requests, 2);
    const normalGroup = released(normal);
    const normalUnload = unloaded(normal);
    hostStillHere(host, shared, true);

    const resume = begin(`resume ${round}`, { sessionId: normal.session.id, previous: normal });
    didComplete(await resume.done, resume, `resumed ${normal.probe.marker}`);
    assert.equal(resume.session.id, normal.session.id);
    assert.ok(resume.priorTurnIds.includes(normal.turnId), "Cold dispatch did not see the saved native turn");
    assert.notEqual(resume.turnId, normal.turnId);
    const resumeGroup = released(resume);
    assert.notEqual(resumeGroup.id, normalGroup.id, "Cold resume did not receive a new owned group");
    const resumeUnload = unloaded(resume);
    hostStillHere(host, shared, true);

    let stopMeasurement;
    if (round === 1) {
      const stop = begin("stop", { stop: true, callId: "call_stop", markerFile: path.join(workspace, "stop.json") });
      await ready(stop);
      assert.ok(stop.turnId, "Missing native turn ID for stop");
      await deadline(harness.interrupt(stop.session.id, stop.turnId), "native interrupt");
      const result = await stop.done;
      assert.equal(result.status, "interrupted", `stop: ${JSON.stringify(result)}`);
      const stopGroup = released(stop);
      stopMeasurement = { pid: stopGroup.pid, grandchildPid: stop.probe.pid, group: stopGroup.id, unload: unloaded(stop, "interrupted"), ms: stop.elapsedMs };
      hostStillHere(host, shared, true);
    }

    host.gate.resolve();
    didComplete(await host.done, host, host.answer);
    const hostUnload = unloaded(host);
    hostStillHere(host, shared, false);
    hostSession = host.session.id;
    const warm = begin(`host warm ${round}`, { host: true, sessionId: hostSession, answer: `host retained ${round}` });
    didComplete(await warm.done, warm, warm.answer);
    assert.equal(warm.session.id, hostSession);
    assert.deepEqual(resource(warm, "resource.acquired"), shared);
    unloaded(warm);
    hostStillHere(warm, shared, false);
    lastHost = warm;
    const groups = harness.resources();
    assert.deepEqual(groups.map(group => group.id), [shared.id]);
    const sample = await sampleWindowsProcesses(shared.pid);
    assert(sample.processes.some(process => process.pid === shared.pid));
    const memory = { processCount: sample.processes.length,
      sharedWorkingSetBytes: sample.processes.reduce((sum, process) => sum + process.workingSet, 0),
      sharedPrivateBytes: sample.processes.reduce((sum, process) => sum + process.privateBytes, 0),
      fixtureNodeRssBytes: process.memoryUsage().rss };
    measurements.push({ round, nativeSession: normal.session.id, memory, normal: { pid: normalGroup.pid,
      grandchildPid: normal.probe.pid, group: normalGroup.id, unload: normalUnload, ms: normal.elapsedMs },
      resume: { pid: resumeGroup.pid, group: resumeGroup.id, unload: resumeUnload, ms: resume.elapsedMs },
      host: { pid: shared.pid, group: shared.id, unload: hostUnload, tools: host.catalog }, ...(stopMeasurement ? { stop: stopMeasurement } : {}) });
  }
  if (!observe) {
    assert.deepEqual(modelErrors, []);
    await harness.close();
    const release = resource(lastHost, "resource.released");
    assert.deepEqual(release, { ...resource(lastHost, "resource.acquired"), exitEvidence: "windows-job-empty" });
    assertGone(release.pid);
    assert.deepEqual(harness.resources(), []);
    console.log(JSON.stringify({ result: "PASS", codexVersion: version, rounds, fixture: "local Responses SSE", measurements }));
  }
} catch (error) {
  if (!observe) throw error;
  const reason = lifecycle.signal.reason ?? error;
  finalStatus = { result: reason.code === "STOP_REQUESTED" ? "STOPPED" : reason.code === "HEADROOM" ? "BLOCKED_HEADROOM" : "FAILED",
    error: String(sampleFailure ?? reason), ...observation };
  if (finalStatus.result === "FAILED") console.error(error);
} finally {
  clearTimeout(deadlineTimer);
  clearInterval(stopPoll);
  for (const scenario of scenarios.values()) scenario.gate.resolve();
  modelServer.closeAllConnections();
  let profileRemoved = false;
  try {
    await deadline(harness.close(), "close remaining owned processes");
    await Promise.allSettled([...scenarios.values()].map(scenario => scenario.done));
    if (observe && runtimeStore) {
      assert.deepEqual(harness.resources(), [], "Harness retains a native process group after close");
      const unconfirmed = runtimeStore.db.prepare("SELECT id,pid,state FROM runtime_process_groups WHERE state != 'released'").all();
      assert.deepEqual(unconfirmed, [], "At least one acquired group has no release receipt");
    }
  } catch (error) {
    if (!observe) throw error;
    finalStatus = { ...finalStatus, result: "FAILED", cleanupError: String(error) };
  } finally {
    try { await closeObservationStore(); }
    catch (error) {
      if (!observe) throw error;
      finalStatus = { ...finalStatus, result: "FAILED", cleanupError: String(error) };
    }
    if (modelServer.listening) await new Promise(resolve => modelServer.close(resolve));
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    if (!finalStatus.cleanupError) {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        profileRemoved = true;
      } catch (error) {
        if (!observe) throw error;
        finalStatus = { ...finalStatus, result: "FAILED", cleanupError: String(error) };
      }
    }
    if (observe) {
      Object.assign(finalStatus, { elapsedMs: Math.round(performance.now() - openedAt), profileRemoved, profileDirectory: root, evidence: logPath });
      log("terminal", finalStatus);
      await writeFile(`${statusPath}.partial`, JSON.stringify(finalStatus, null, 2) + "\n", { flag: "wx" });
      await rename(`${statusPath}.partial`, statusPath);
      console.log(JSON.stringify(finalStatus));
      if (finalStatus.result === "FAILED") process.exitCode = 1;
      if (finalStatus.result === "BLOCKED_HEADROOM") process.exitCode = 2;
      if (finalStatus.result === "STOPPED") process.exitCode = 130;
    }
  }
}
