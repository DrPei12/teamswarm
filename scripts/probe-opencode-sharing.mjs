import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const implementation = path.resolve(
  process.argv[2] ?? ".local/teamswarm-context",
);
const moduleAt = (file) =>
  import(
    pathToFileURL(
      path.join(implementation, "apps/server/dist/runtime/harness", file),
    ).href
  );
const { nativeEntry, terminateNative } = await moduleAt("native-support.js");
const { spawnOwned, confirmOwnedExit, sampleWindowsProcesses } =
  await moduleAt("owned-process.js");
const root = mkdtempSync(path.join(implementation, ".local/opencode-share-"));
const dirs = Array.from("ABCDEFGH", (id) => path.join(root, id));
const markers = dirs.map(() => randomUUID());
for (const [i, dir] of dirs.entries()) {
  mkdirSync(dir);
  writeFileSync(path.join(dir, "marker.txt"), markers[i]);
  writeFileSync(
    path.join(dir, "proof.cjs"),
    `const fs = require("node:fs");
if (process.argv[2] === "hold") {
  fs.writeFileSync("started", "1");
  setTimeout(() => fs.writeFileSync("late", "1"), 6000);
} else if (process.argv[2] === "credential") {
  console.log(process.env.OPENCODE_SERVER_PASSWORD ? "CONTROL_ENV_PRESENT" : "CONTROL_ENV_ABSENT");
} else {
  console.log(fs.readFileSync("marker.txt", "utf8"));
}`,
  );
}
const home = path.join(root, "home");
mkdirSync(home);
const portProbe = createServer().listen(0, "127.0.0.1");
await once(portProbe, "listening");
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const origin = "http://127.0.0.1:" + port;
const password = randomBytes(32).toString("hex");
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|PROGRAMFILES|PROGRAMFILES\(X86\)|LANG|LC_ALL)$/i.test(
      key,
    ),
  ),
);
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  XDG_STATE_HOME: path.join(home, "state"),
  OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    autoupdate: false,
    share: "disabled",
    model: "local/fixture",
    enabled_providers: ["local"],
    provider: {
      local: {
        npm: "@ai-sdk/openai-compatible",
        name: "Loopback Only",
        options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "local-test" },
        models: { fixture: { name: "Fixture" } },
      },
    },
    permission: {
      "*": "deny",
      read: "allow",
      bash: "allow",
      external_directory: "deny",
    },
  }),
});
const child = await spawnOwned(
  nativeEntry("opencode"),
  ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: root,
    env,
    detached: process.platform !== "win32",
    windowsHide: true,
  },
);
let startup = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    startup = (startup + chunk).slice(-1800);
  });
const call = async (route, directory, body) => {
  const url = new URL(route, origin);
  if (directory) url.searchParams.set("directory", directory);
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization:
        "Basic " + Buffer.from("opencode:" + password).toString("base64"),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(route === "/global/health" ? 2500 : 30000),
  });
  const value = await response.text();
  if (!response.ok)
    throw new Error(route + " " + response.status + " " + value.slice(0, 420));
  return JSON.parse(value);
};
const until = async (check, timeout) => {
  const end = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(100);
  } while (Date.now() < end);
  throw new Error("Timed out waiting for native server or command. " + startup);
};
const proof = {
  nativeHarness: "opencode",
  transport: "serve",
  modelRequests: 0,
  samples: [],
};
const sample = async (count) => {
  if (process.platform !== "win32") return;
  const { processes } = await sampleWindowsProcesses(child.pid);
  proof.samples.push({
    sessions: count,
    processes: processes.length,
    privateMiB: Math.round(
      processes.reduce((n, p) => n + p.privateBytes, 0) / 1048576,
    ),
    workingSetMiB: Math.round(
      processes.reduce((n, p) => n + p.workingSet, 0) / 1048576,
    ),
  });
};
try {
  let lastHealthError;
  const health = await until(async () => {
    if (child.exitCode !== null) throw new Error(startup);
    try {
      return await call("/global/health");
    } catch (error) {
      lastHealthError = String(error.cause ?? error);
      return false;
    }
  }, 45000).catch((error) => {
    throw new Error(
      error.message + " Last health response: " + lastHealthError,
    );
  });
  proof.version = health.version;
  const sessions = [];
  const shell = (i, command) =>
    call("/session/" + sessions[i].id + "/shell", dirs[i], {
      agent: "build",
      model: { providerID: "local", modelID: "fixture" },
      command,
    });
  const verify = async (i) => {
    const result = await shell(i, "node proof.cjs");
    const output = JSON.stringify(result.parts);
    assert(
      output.includes(markers[i]),
      "Missing native marker for member " + i + " " + output.slice(0, 950),
    );
    assert(markers.every((v, j) => j === i || !output.includes(v)));
  };
  for (const count of [1, 4, 8]) {
    const start = sessions.length;
    sessions.push(
      ...(await Promise.all(
        dirs
          .slice(start, count)
          .map((dir, j) =>
            call("/session", dir, { title: "Member " + (start + j) }),
          ),
      )),
    );
    assert.equal(new Set(sessions.map((s) => s.id)).size, count);
    for (const [i, s] of sessions.entries())
      assert.equal(
        path.resolve(s.directory).toLowerCase(),
        dirs[i].toLowerCase(),
      );
    await Promise.all(sessions.map((_, i) => verify(i)));
    await sample(count);
  }
  proof.sameFilenameReadFromOwnDirectory = true;
  const inspected = await shell(1, "node proof.cjs credential");
  const shellOutput = JSON.stringify(inspected.parts);
  assert(/CONTROL_ENV_(PRESENT|ABSENT)/.test(shellOutput));
  proof.nativeShellInheritedControlCredential = shellOutput.includes(
    "CONTROL_ENV_PRESENT",
  );
  const held = shell(0, "node proof.cjs hold").then(
    (value) => ({ value }),
    (error) => ({ error: String(error) }),
  );
  await until(() => existsSync(path.join(dirs[0], "started")), 5000);
  await verify(1);
  const cancel = await call(
    "/session/" + sessions[0].id + "/abort",
    dirs[0],
    {},
  );
  assert.equal(cancel, true);
  const terminal = await held;
  proof.cancelRequestAcknowledged = true;
  proof.nativeShellInterrupted =
    !terminal.error &&
    JSON.stringify(terminal.value).toLowerCase().includes("abort");
  await verify(1);
  await delay(6300);
  proof.cancelledChildStayedStopped = !existsSync(path.join(dirs[0], "late"));
  const histories = await Promise.all(
    sessions.map((s, i) => call("/session/" + s.id + "/message", dirs[i])),
  );
  for (const [i, h] of histories.entries()) {
    const body = JSON.stringify(h);
    assert(body.includes(markers[i]));
    assert(markers.every((v, j) => j === i || !body.includes(v)));
  }
  // Test whether selecting B's directory restricts a holder of the service credential to B's history.
  const foreignURL = new URL("/session/" + sessions[0].id + "/message", origin);
  foreignURL.searchParams.set("directory", dirs[1]);
  const foreign = await fetch(foreignURL, {
    headers: {
      authorization:
        "Basic " + Buffer.from("opencode:" + password).toString("base64"),
    },
    signal: AbortSignal.timeout(5000),
  });
  proof.crossDirectoryReadStatus = foreign.status;
  proof.crossDirectoryReadSawOtherMarker = (await foreign.text()).includes(
    markers[0],
  );
  proof.historiesSeparate = true;
  proof.otherSessionSurvived = true;
  proof.sessions = sessions.map((s) => s.id);
} catch (error) {
  proof.error = String(error);
  throw error;
} finally {
  if (child.exitCode === null && child.signalCode === null)
    await terminateNative(child);
  for (let i = 0; i < 60 && !(await confirmOwnedExit(child)); i++)
    await delay(100);
  proof.ownedProcessExited = await confirmOwnedExit(child);
  proof.portClosed = await fetch(origin + "/global/health", {
    signal: AbortSignal.timeout(1500),
  }).then(
    () => false,
    () => true,
  );
  writeFileSync(path.join(root, "proof.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
  console.log("Evidence", path.join(root, "proof.json"));
}
assert(
  proof.ownedProcessExited && proof.portClosed,
  "OpenCode process and port did not close",
);
assert(
  proof.cancelledChildStayedStopped,
  "Native abort allowed a command child to survive",
);
