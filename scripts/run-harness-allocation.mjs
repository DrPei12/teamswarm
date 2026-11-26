// Operates the real TeamSwarm runtime in the current checkout. No mock agents,
// copied project, branch or worktree. Private driver state stays under .local.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { testGateway } from "./harness-test-gateway.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, ".local/harness-allocation");
mkdirSync(directory, { recursive: true });
const stateFile = path.join(directory, "driver.json");
const durableDirectory = path.join(
  process.env.LOCALAPPDATA,
  "TeamSwarm/validation/harness-allocation",
);
const durableState = path.join(durableDirectory, "driver.json");
const identityFile = existsSync(durableState) ? durableState : stateFile;
const saved = existsSync(identityFile)
  ? JSON.parse(readFileSync(identityFile, "utf8"))
  : {
      token: randomUUID(),
      port: 4333,
      gatewayPort: 4334,
      dataDir: path.join(
        process.env.LOCALAPPDATA,
        "TeamSwarm/validation/harness-allocation",
      ),
      workspace: root,
      phases: {},
      members: {},
      createdAt: new Date().toISOString(),
    };
const persist = () => {
  mkdirSync(durableDirectory, { recursive: true });
  for (const file of [durableState, stateFile])
    writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
};
persist();
const base = `http://127.0.0.1:${saved.port}`;
const digest = (v) => createHash("sha256").update(v).digest("hex");
const secretFile = process.env.TEAM_DEEPSEEK_CREDENTIAL_FILE;
const fallbackFile = process.env.TEAM_DEEPSEEK_FALLBACK_CREDENTIAL_FILE;
const secrets = [saved.token];
if (secretFile)
  secrets.push(
    readFileSync(secretFile, "utf8")
      .replace(/^\uFEFF/, "")
      .trim(),
  );
const primaryCredential = secrets.at(-1);
const fallbackCredential = fallbackFile
  ? readFileSync(fallbackFile, "utf8")
      .replace(/^\uFEFF/, "")
      .trim()
  : undefined;
if (fallbackCredential) secrets.push(fallbackCredential);
const clean = (value) => {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets)
    if (secret) text = text.split(secret).join("[credential-redacted]");
  return text;
};
function journal(kind, data) {
  appendFileSync(
    path.join(durableDirectory, "driver-events.jsonl"),
    clean({ at: new Date().toISOString(), kind, data }) + "\n",
  );
}
async function api(route, body, method = body === undefined ? "GET" : "POST") {
  const id = randomUUID();
  if (method !== "GET") journal("http.request", { id, method, route, body });
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: {
      authorization: `Bearer ${saved.token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (method !== "GET" || !response.ok)
    journal("http.response", { id, status: response.status, body: value });
  if (!response.ok)
    throw new Error(clean({ route, status: response.status, body: value }));
  return value;
}
const deepseek = (harness, access = "workspace-write") => {
  const anthropic = ["claude-code", "deepseek-harness"].includes(harness);
  return {
    harness,
    model: "deepseek-flash",
    provider: "deepseek",
    baseUrl: `http://127.0.0.1:${saved.gatewayPort}${anthropic ? "/anthropic" : ""}`,
    credentialEnv: "TEAM_DEEPSEEK_KEY",
    protocol:
      harness === "codex"
        ? "responses"
        : anthropic
          ? "anthropic-messages"
          : "chat-completions",
    effort: harness === "codex" ? "low" : null,
    access,
  };
};
const memberHarnesses = {
  research: "pi",
  architecture: "claude-code",
  backend: "codex",
  frontend: "claude-code",
  portability: "deepseek-harness",
  integration: "opencode",
  review: "codex",
};
async function migrateDeepseek() {
  const state = await api(`/teams/${saved.teamId}/runtime`);
  if (
    state.works.some((w) =>
      [
        "queued",
        "waiting",
        "running",
        "stopping",
        "recovery_required",
      ].includes(w.status),
    )
  )
    throw new Error(
      "Stop and reconcile pending work before changing model/Harness bindings.",
    );
  const { teamId, version, policyVersion, ...settings } = state.settings;
  await api(
    `/teams/${saved.teamId}/runtime`,
    { ...settings, config: deepseek("codex"), expectedVersion: version },
    "PUT",
  );
  for (const [role, id] of Object.entries(saved.members)) {
    const member = state.members.find((m) => m.id === id);
    await api(
      `/teams/${saved.teamId}/members/${id}`,
      {
        name: member.name,
        responsibility: member.responsibility.replaceAll(
          "Qwen",
          "DeepSeek V4.1 Flash",
        ),
        config: deepseek(
          memberHarnesses[role],
          role === "review" ? "read-only" : "workspace-write",
        ),
      },
      "PATCH",
    );
  }
  const resources = (
    await api(
      `/teams/${saved.teamId}/branches/${saved.branchId}/directory?kind=resources&limit=30`,
    )
  ).items;
  for (const harness of new Set(Object.values(memberHarnesses))) {
    const id = `${harness}-deepseek-flash`,
      old = resources.find((r) => r.id === id);
    await api(
      `/teams/${saved.teamId}/resources/${id}`,
      {
        expectedVersion: old?.version ?? 0,
        name: `${harness} · DeepSeek V4.1 Flash`,
        description:
          "Official DeepSeek endpoint through a transparent local recorder. Native session/tool connectivity verified separately; development evidence is recorded in this Team.",
        config: deepseek(harness),
      },
      "PUT",
    );
  }
  saved.productionModel = "deepseek-flash";
  saved.productionProvider = "deepseek";
  persist();
  console.log(
    JSON.stringify({
      configured: true,
      model: "deepseek-flash",
      members: memberHarnesses,
    }),
  );
}
async function setup() {
  if (!saved.teamId) {
    const team = await api("/teams", { name: "TeamSwarm 模型与 Harness 分配" });
    saved.teamId = team.id;
    persist();
  }
  if (!saved.chatId) {
    const chat = await api(`/teams/${saved.teamId}/conversations`, {
      title: "REA 逆向与便携切换系统开发",
    });
    saved.chatId = chat.id;
    persist();
  }
  const runtime = await api(`/teams/${saved.teamId}/runtime`);
  if (!runtime.settings) {
    await api(
      `/teams/${saved.teamId}/runtime`,
      {
        expectedVersion: runtime.settings?.version ?? 0,
        workspace: root,
        config: deepseek("codex"),
        maxConcurrent: 3,
        maxWorksPerRun: 65,
        maxTurnsPerWork: 75,
        timeoutSeconds: 1800,
        hostContextMaxBytes: 150000,
        hostSessionMaxTurns: 5,
        allowIsolatedWorkspaces: false,
      },
      "PUT",
    );
  }
  saved.branchId = (
    await api(`/teams/${saved.teamId}/conversations/${saved.chatId}/branch`)
  ).id;
  const roster = [
    [
      "research",
      "REA 机制研究",
      "Use the installed REA tool on the pinned cc-switch executable and source, preserve reproducible evidence, and derive concrete mechanisms for TeamSwarm. Own research/synthesis/harness-switching.md and ignored raw REA evidence only.",
      deepseek("pi"),
    ],
    [
      "architecture",
      "配置契约与迁移",
      "Own the portable model/Harness allocation contract and compatibility semantics, working with backend and UI through real Team exchanges. Implement small standalone shared contract/schema pieces only, coordinate exact file ownership before editing.",
      deepseek("claude-code"),
    ],
    [
      "backend",
      "分配与切换后端",
      "Own real server allocation APIs, persistence, effective per-member/task configuration, atomic safe switching, and API tests. Reuse existing resources/connections/runtime. Preserve current changes.",
      deepseek("codex"),
    ],
    [
      "frontend",
      "切换分配界面",
      "Own integrated TeamSwarm UI for model/Harness resource selection, assignment, portable import/export and truthful availability/errors. Coordinate exact API with backend and use existing UI design.",
      deepseek("claude-code"),
    ],
    [
      "portability",
      "便携配置工程",
      "Own portable profile import/export and credential-reference compatibility tests, using existing normalized connections. Implement actual reusable code; agree file ownership with backend first. No plaintext credentials or hard-coded private endpoint in public fixtures.",
      deepseek("deepseek-harness"),
    ],
    [
      "integration",
      "多 Harness 联调",
      "Own integration tests and meaningful real compatibility validation for the new allocation flows. Use the native OpenCode Harness and DeepSeek V4.1 Flash model, coordinate findings with implementers. Do not claim native execution from mock tests.",
      deepseek("opencode"),
    ],
    [
      "review",
      "独立验收",
      "Independently inspect immutable submitted artifacts and original criteria, run fresh appropriate native checks through Team tools, reject concrete defects and accept only with recorded evidence. Read-only, no source edits, different identity from every producer.",
      deepseek("codex", "read-only"),
    ],
  ];
  for (const [key, name, responsibility, config] of roster)
    if (!saved.members[key]) {
      const member = await api(`/teams/${saved.teamId}/members`, {
        clientRequestId: randomUUID(),
        name,
        responsibility,
        config,
      });
      saved.members[key] = member.id;
      persist();
    }
  const resources = [...new Set(Object.values(memberHarnesses))].map((h) => [
    `${h}-deepseek-flash`,
    deepseek(h),
  ]);
  if (!saved.resourcesReady) {
    for (const [id, config] of resources)
      await api(
        `/teams/${saved.teamId}/resources/${id}`,
        {
          expectedVersion: 0,
          name: id,
          description:
            "Real development resource; availability must be observed from an actual run.",
          config,
        },
        "PUT",
      );
    saved.resourcesReady = true;
    persist();
  }
  await api("/product/preferences", { language: "zh-CN" }, "PATCH");
  console.log(
    JSON.stringify({
      teamId: saved.teamId,
      branchId: saved.branchId,
      members: saved.members,
      url: base,
      workspace: root,
    }),
  );
}
async function serve() {
  if (!secretFile)
    throw new Error(
      "Set TEAM_DEEPSEEK_CREDENTIAL_FILE to the existing authorized credential file.",
    );
  process.env.TEAM_DEEPSEEK_KEY = primaryCredential;
  process.env.TEAM_HARNESS_HOME = path.join(durableDirectory, "native");
  process.env.TEAM_CODEX_HOME ??= path.join(directory, "native", "codex");
  process.env.TEAM_DSH_DISABLE_SHELL = "1";
  if (process.platform === "win32") {
    mkdirSync(process.env.TEAM_CODEX_HOME, { recursive: true });
    const configuration = path.join(process.env.TEAM_CODEX_HOME, "config.toml");
    // This task cache has no elevated-sandbox account setup. Keep the native
    // restricted-token sandbox, while each member still selects its access mode.
    if (!existsSync(configuration))
      writeFileSync(configuration, '[windows]\nsandbox = "unelevated"\n', {
        flag: "wx",
      });
  }
  // Resolve the device installation, as the desktop runtime does. Executables
  // in a checkout can inherit a Low integrity label and cannot provision MXC.
  // An explicit TEAM_CODEX_BIN remains available for a deliberate override.
  const { createApp } = await import("../apps/server/dist/app.js");
  const { loadHarnesses } =
    await import("../apps/server/dist/runtime/harness/registry.js");
  const meterFile = path.join(durableDirectory, "deepseek-requests.json");
  if (
    !existsSync(meterFile) &&
    existsSync(path.join(directory, "deepseek-requests.json"))
  )
    writeFileSync(
      meterFile,
      readFileSync(path.join(directory, "deepseek-requests.json")),
    );
  const maxRequests = Number(process.env.TEAM_VALIDATION_MAX_REQUESTS ?? 2400);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1)
    throw new Error("TEAM_VALIDATION_MAX_REQUESTS must be a positive safe integer");
  const maxReserved = Number(process.env.TEAM_VALIDATION_MAX_RESERVED ?? 800000000);
  if (!Number.isSafeInteger(maxReserved) || maxReserved < 1)
    throw new Error("TEAM_VALIDATION_MAX_RESERVED must be a positive safe integer");
  const gateway = await testGateway(
    "https://api.deepseek.com",
    "deepseek-flash",
    process.env.TEAM_DEEPSEEK_KEY,
    (data) => writeFileSync(meterFile, JSON.stringify(data, null, 2)),
    {
      port: saved.gatewayPort,
      maxRequests,
      maxInputBytes: 1300000,
      maxOutputTokens: 16384,
      maxReserved,
      fallbackCredentials: fallbackCredential ? [fallbackCredential] : [],
      ...(existsSync(meterFile)
        ? { previous: JSON.parse(readFileSync(meterFile, "utf8")) }
        : {}),
    },
  );
  const service = createApp({
    dataDir: saved.dataDir,
    controlToken: saved.token,
    apiPort: saved.port,
    webDistDir: path.join(root, "teamswarm/dist"),
    harnesses: await loadHarnesses(),
  });
  const server = service.app.listen(saved.port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  saved.pid = process.pid;
  persist();
  const controlFile = path.join(saved.dataDir, "control.json");
  if (
    existsSync(controlFile) &&
    JSON.parse(readFileSync(controlFile, "utf8")).token !== saved.token
  )
    throw new Error(
      "The runtime data directory belongs to a different control identity.",
    );
  writeFileSync(controlFile, JSON.stringify({ token: saved.token }), {
    mode: 0o600,
  });
  writeFileSync(
    path.join(saved.dataDir, "connection.json"),
    JSON.stringify({
      port: saved.port,
      webPort: saved.port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }),
  );
  journal("service.started", {
    pid: process.pid,
    workspace: root,
    port: saved.port,
  });
  console.log(
    JSON.stringify({
      ready: true,
      port: saved.port,
      dataDir: saved.dataDir,
      pid: process.pid,
    }),
  );
  let closing = false;
  async function close(reason) {
    if (closing) return;
    closing = true;
    journal("service.stopping", { reason });
    await service.close();
    await gateway.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    journal("service.stopped", { reason });
    process.exit(0);
  }
  const stopFile = path.join(directory, "stop-request.json");
  const started = Date.now();
  setInterval(() => {
    if (
      existsSync(stopFile) &&
      JSON.parse(readFileSync(stopFile, "utf8")).at > started
    )
      void close("driver-request");
  }, 1000);
  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));
}
async function send(file, key = randomUUID()) {
  if (!file)
    throw new Error(
      "send requires a UTF-8 task file and optional stable phase key",
    );
  const phase = (saved.phases[key] ??= { clientRequestId: randomUUID() });
  persist();
  const receipt = await api("/product/messages", {
    teamId: saved.teamId,
    conversationId: saved.chatId,
    clientRequestId: phase.clientRequestId,
    content: readFileSync(path.resolve(file), "utf8"),
    files: [],
    references: [],
  });
  Object.assign(phase, receipt);
  persist();
  console.log(JSON.stringify(receipt));
}
async function status() {
  const state = await api(`/teams/${saved.teamId}/runtime`);
  console.log(
    JSON.stringify(
      {
        runs: state.runs.map(({ id, state, continuedWorkIds }) => ({
          id,
          state,
          continuedWorkIds,
        })),
        members: state.members.map(({ id, name, config }) => ({
          id,
          name,
          harness: config.harness,
          model: config.model,
        })),
        works: state.works.map(
          ({
            id,
            memberId,
            title,
            status,
            error,
            reviewOf,
            continuationOf,
            result,
            artifactIds,
          }) => ({
            id,
            memberId,
            title,
            status,
            error,
            reviewOf,
            continuationOf,
            result: result?.slice(0, 1200),
            artifactIds,
          }),
        ),
        acceptances: state.acceptances.length,
      },
      null,
      2,
    ),
  );
}
function exportEvidence() {
  const output = path.join(durableDirectory, "evidence");
  mkdirSync(output, { recursive: true });
  const db = new DatabaseSync(path.join(saved.dataDir, "team.sqlite"), {
    readOnly: true,
  });
  // All exported tables must describe the same SQLite snapshot, even if an
  // already-running member finishes while the evidence is being copied.
  db.exec("BEGIN");
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((x) => x.name);
  const manifest = [];
  let omittedReasoningBlocks = 0;
  const observable = (value) => {
    if (Array.isArray(value)) return value.map(observable);
    if (!value || typeof value !== "object") return value;
    const privateKinds = [
      "reasoning",
      "thinking",
      "thinking_delta",
      "reasoning_text",
      "reasoning_text_delta",
    ];
    if (
      privateKinds.includes(value.kind) ||
      privateKinds.includes(value.type)
    ) {
      omittedReasoningBlocks++;
      return {
        ...Object.fromEntries(
          ["id", "turnId", "type", "kind", "status"]
            .filter((key) => key in value)
            .map((key) => [key, value[key]]),
        ),
        contentOmitted:
          "Private reasoning; observable messages and tools are exported separately.",
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (["reasoning_content", "thinking_content"].includes(key)) {
          omittedReasoningBlocks++;
          return [key, "[private reasoning omitted]"];
        }
        return [key, observable(item)];
      }),
    );
  };
  for (const table of names) {
    if (!/^[a-z_]+$/.test(table)) continue;
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    const content =
      rows
        .map((row) => {
          if (typeof row.data === "string") {
            try {
              row.data = JSON.stringify(observable(JSON.parse(row.data)));
            } catch {
              /* Non-JSON columns retain their original text. */
            }
          }
          return clean(observable(row));
        })
        .join("\n") + (rows.length ? "\n" : "");
    writeFileSync(path.join(output, `${table}.jsonl`), content);
    manifest.push({
      table,
      rows: rows.length,
      sha256: digest(content),
      bytes: Buffer.byteLength(content),
    });
  }
  db.exec("COMMIT");
  db.close();
  const summary = {
    exportedAt: new Date().toISOString(),
    teamId: saved.teamId,
    workspace: root,
    source:
      "Real TeamSwarm SQLite event and record tables; no synthesized agent communication.",
    sanitization: {
      credentialsRedacted: true,
      omittedReasoningBlocks,
      originalDatabaseModified: false,
    },
    manifest,
  };
  writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    JSON.stringify({
      output,
      tables: manifest.length,
      rows: manifest.reduce((n, x) => n + x.rows, 0),
    }),
  );
}
const [command, ...args] = process.argv.slice(2);
try {
  if (command === "serve") await serve();
  else if (command === "setup") await setup();
  else if (command === "migrate-deepseek") await migrateDeepseek();
  else if (command === "send") await send(...args);
  else if (command === "status") await status();
  else if (command === "export") exportEvidence();
  else if (command === "stop") {
    writeFileSync(
      path.join(directory, "stop-request.json"),
      JSON.stringify({ at: Date.now() }),
    );
    console.log("Graceful stop requested.");
  } else
    throw new Error(
      "Use serve | setup | send <task-file> [phase-key] | status | export | stop",
    );
} catch (error) {
  journal("driver.error", { command, error: error.message });
  console.error(clean(error.message));
  process.exitCode = 1;
}
