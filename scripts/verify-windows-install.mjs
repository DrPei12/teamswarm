import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { sourceIdentity } from "./release-identity.mjs";

const { values } = parseArgs({ options: Object.fromEntries(
  ["installer", "previous-installer", "manifest", "root"].map(name => [name, { type: "string" }])
)});
for (const name of ["installer", "previous-installer", "manifest", "root"]) assert(values[name], `Missing --${name}`);
assert.equal(process.platform, "win32");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Run installer tests on a clean GitHub Windows runner.");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
const repository = path.resolve(import.meta.dirname, "..");
const root = path.resolve(values.root);
const runnerTemp = fs.realpathSync(process.env.RUNNER_TEMP);
assert(root.startsWith(runnerTemp + path.sep));
assert(!fs.existsSync(root), "Installer test directory already exists.");
const installer = path.resolve(values.installer);
const previousInstaller = path.resolve(values["previous-installer"]);
const manifest = JSON.parse(fs.readFileSync(values.manifest, "utf8"));
const identity = sourceIdentity(repository);
assert.equal(identity.commit, manifest.commit);
assert.equal(identity.sourceSha256, manifest.sourceSha256);
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const asset = manifest.assets.find(item => item.name === path.basename(installer));
assert(asset);
assert.equal(hash(installer), asset.sha256);
const installDir = path.join(root, "TeamSwarm 安装");
const executable = path.join(installDir, "TeamSwarm.exe");
const dataHome = path.join(process.env.LOCALAPPDATA, "TeamSwarm");
const dataDir = path.join(dataHome, "data");
const userData = path.join(process.env.APPDATA, "TeamSwarm");
const { _electron: electron } = createRequire(path.join(repository, "teamswarm/package.json"))("playwright");
const env = { ...process.env, TEAM_PROJECTS_DIR: path.join(root, "projects") };
for (const name of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "TEAM_DATA_DIR", "TEAMSWARM_USER_DATA", "TEAM_HARNESS_MODULES", "TEAM_CREDENTIAL_FILES"]) delete env[name];
function ps(command, extra = {}) {
  const encoded = Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; " + command, "utf16le").toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    encoding: "utf8", windowsHide: true, env: { ...env, ...extra }, timeout: 240000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function registrations() {
  return JSON.parse(ps(`$roots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); $items=@(foreach($r in $roots){Get-ChildItem -LiteralPath $r -ErrorAction SilentlyContinue | ForEach-Object {Get-ItemProperty -LiteralPath $_.PSPath} | Where-Object {$_.DisplayName -eq 'TeamSwarm' -or $_.DisplayName -eq ('TeamSwarm '+$_.DisplayVersion)} | Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString}); ConvertTo-Json -InputObject $items -Compress`));
}
const shortcuts = JSON.parse(ps(`$paths=@((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'TeamSwarm.lnk'),(Join-Path ([Environment]::GetFolderPath('Programs')) 'TeamSwarm.lnk')); ConvertTo-Json -InputObject $paths -Compress`));
assert.deepEqual(registrations(), [], "TeamSwarm is already installed.");
for (const location of [dataHome, userData, ...shortcuts]) assert(!fs.existsSync(location), `Existing application data: ${location}`);
fs.mkdirSync(root, { recursive: true });
const report = { version: manifest.version, commit: manifest.commit, installerSha256: asset.sha256, passed: false, checks: {} };
let app, page;
const secret = "installer-credential-fixture";
const provider = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${secret}` || request.url !== "/models") return response.writeHead(401).end();
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "installer-fixture-model" }] }));
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
const waitFor = async predicate => {
  const end = Date.now() + 60000;
  while (!predicate()) {
    assert(Date.now() < end, "Installer state did not settle.");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
};
function install(file) {
  ps(`$p=Start-Process -FilePath $env:TEST_INSTALLER -ArgumentList @('/S','/currentuser',('/D='+$env:TEST_INSTALL_DIR)) -WindowStyle Hidden -PassThru; if(-not $p.WaitForExit(180000)){throw 'Installer timeout'}; if($p.ExitCode -ne 0){throw ('Installer exit '+$p.ExitCode)}`, { TEST_INSTALLER: file, TEST_INSTALL_DIR: installDir });
  assert(fs.existsSync(executable));
  const records = registrations();
  assert.equal(records.length, 1, "Expected one TeamSwarm uninstall registration.");
  assert.equal(records[0].DisplayName, `TeamSwarm ${records[0].DisplayVersion}`);
  const uninstallPath = /^"([^"]+)"/.exec(records[0].UninstallString)?.[1];
  assert(uninstallPath);
  assert.equal(path.dirname(uninstallPath), installDir);
  for (const shortcut of shortcuts) {
    assert(fs.existsSync(shortcut));
    const target = ps(`$s=New-Object -ComObject WScript.Shell; $s.CreateShortcut($env:TEST_SHORTCUT).TargetPath`, { TEST_SHORTCUT: shortcut });
    assert.equal(path.resolve(target), executable);
  }
}
async function uninstall() {
  const file = path.join(installDir, "Uninstall TeamSwarm.exe");
  assert(fs.existsSync(file));
  ps(`$p=Start-Process -FilePath $env:TEST_UNINSTALLER -ArgumentList @('/S','/currentuser') -WindowStyle Hidden -PassThru; if(-not $p.WaitForExit(180000)){throw 'Uninstaller timeout'}; if($p.ExitCode -ne 0){throw ('Uninstaller exit '+$p.ExitCode)}`, { TEST_UNINSTALLER: file });
  await waitFor(() => !fs.existsSync(executable) && !fs.existsSync(file) && registrations().length === 0);
  for (const shortcut of shortcuts) assert(!fs.existsSync(shortcut));
}
async function launch(expected) {
  app = await electron.launch({ executablePath: executable, cwd: installDir, env, chromiumSandbox: true, timeout: 60000 });
  page = await app.firstWindow({ timeout: 60000 });
  page.setDefaultTimeout(30000);
  await page.waitForLoadState("domcontentloaded");
  const actual = await app.evaluate(({ app, BrowserWindow }) => ({
    version: app.getVersion(), userData: app.getPath("userData"), sandbox: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox,
  }));
  if (expected) assert.equal(actual.version, expected);
  assert.equal(actual.userData, userData);
  assert.equal(actual.sandbox, true);
  return actual.version;
}
async function api(route, method = "GET", body) {
  return page.evaluate(async ({ route, method, body }) => {
    const response = await fetch("/api" + route, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error(`${route}: ${response.status}`);
    return response.json();
  }, { route, method, body });
}
async function close() {
  const connection = JSON.parse(fs.readFileSync(path.join(dataDir, "connection.json"), "utf8"));
  await app.close(); app = undefined;
  await waitFor(() => !fs.existsSync(path.join(dataDir, "runtime.lock")));
  await assert.rejects(fetch(`http://127.0.0.1:${connection.port}/api/teams`, { signal: AbortSignal.timeout(2000) }));
}
function verifyPayload() {
  const product = path.join(installDir, "resources/product");
  const built = JSON.parse(fs.readFileSync(path.join(product, "build-identity.json"), "utf8"));
  assert.equal(built.commit, manifest.commit);
  assert.equal(built.sourceSha256, manifest.sourceSha256);
  const inventory = JSON.parse(fs.readFileSync(path.join(product, "package-inventory.json"), "utf8"));
  for (const [relative, expected] of Object.entries(inventory.files)) {
    const file = path.resolve(product, relative);
    assert(file.startsWith(product + path.sep));
    assert.equal(hash(file), expected, relative);
  }
  report.productFiles = Object.keys(inventory.files).length;
}
async function seed() {
  await page.getByRole("textbox", { name: "Team name", exact: true }).fill("Installer project");
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await page.getByRole("button", { name: "New chat", exact: true }).waitFor();
  const team = (await api("/teams")).teams.find(item => item.name === "Installer project");
  assert(team);
  const conversation = await api(`/teams/${team.id}/conversations`, "POST", { title: "Installer conversation" });
  const { reference } = await api(`/product/teams/${team.id}/credential`, "PUT", { secret });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.1));
  return { team, conversation, reference };
}
async function verifySeed(saved) {
  await page.getByRole("button", { name: "New chat", exact: true }).waitFor();
  assert.equal((await api("/teams")).teams.find(item => item.id === saved.team.id)?.name, saved.team.name);
  const item = await api(`/teams/${saved.team.id}/conversations/${saved.conversation.id}`);
  assert.equal(item.conversation.title, saved.conversation.title);
  const models = await api(`/teams/${saved.team.id}/model-catalog`, "POST", { endpoints: { responses: providerOrigin }, credentialEnv: saved.reference });
  assert.deepEqual(models.models, ["installer-fixture-model"]);
  assert(!fs.readFileSync(path.join(dataDir, "credentials.json"), "utf8").includes(secret));
  const zoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
  assert(Math.abs(zoom - 1.1) < 0.01);
}
try {
  install(installer);
  assert.equal(registrations()[0].DisplayVersion, manifest.version);
  verifyPayload();
  await launch(manifest.version);
  const clean = await seed();
  await close();
  await launch(manifest.version);
  await verifySeed(clean);
  await close();
  report.checks.cleanInstall = true;
  report.checks.shortcutsAndRegistration = true;
  report.checks.coldRestart = true;
  await uninstall();
  assert(fs.existsSync(path.join(dataDir, "credentials.json")));
  assert(fs.existsSync(path.join(userData, "window.json")));
  report.checks.uninstallPreservesData = true;
  for (const location of [dataHome, userData]) fs.rmSync(location, { recursive: true });
  install(previousInstaller);
  report.previousVersion = await launch();
  assert.notEqual(report.previousVersion, manifest.version);
  const saved = await seed();
  await close();
  const projectFile = path.join(root, "projects", saved.team.id, "kept.txt");
  assert(fs.statSync(path.dirname(projectFile)).isDirectory());
  fs.writeFileSync(projectFile, "installer-project-fixture\n");
  const projectHash = hash(projectFile);
  install(installer);
  assert.equal(registrations()[0].DisplayVersion, manifest.version);
  verifyPayload();
  await launch(manifest.version);
  await verifySeed(saved);
  await close();
  assert.equal(hash(projectFile), projectHash);
  report.checks.previousVersionUpgrade = true;
  report.checks.teamAndConversation = true;
  report.checks.credentialRecovery = true;
  report.checks.windowPreference = true;
  report.checks.projectFiles = true;
  await uninstall();
  assert.equal(hash(projectFile), projectHash);
  install(installer);
  assert.equal(hash(projectFile), projectHash);
  await launch(manifest.version);
  await verifySeed(saved);
  await close();
  report.checks.reinstallPreservesData = true;
  await uninstall();
  assert.equal(hash(projectFile), projectHash);
  report.checks.finalUninstall = true;
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  await new Promise(resolve => provider.close(resolve));
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
