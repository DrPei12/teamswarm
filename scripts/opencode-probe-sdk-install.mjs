import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertOpenCodeProbeHost, openCodeProbeSdkDirectory, openCodeProbeSdkFiles,
  openCodeProbeSdkModules, verifyOpenCodeProbeSdk,
} from "../apps/server/dist/runtime/harness/opencode-probe-sdk.js";

const product = fileURLToPath(new URL("../", import.meta.url));

function copyLockedTarball(cacheSource, cacheTarget, { resolved, integrity }) {
  const url = new URL(resolved);
  if (url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.search || url.hash ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity))
    throw new Error("The OpenCode SDK lock contains an unexpected registry artifact.");
  const key = `make-fetch-happen:request-cache:${resolved}`;
  const index = createHash("sha256").update(key).digest("hex");
  const content = Buffer.from(integrity.slice(7), "base64").toString("hex");
  const parts = digest => [digest.slice(0, 2), digest.slice(2, 4), digest.slice(4)];
  const indexPath = path.join("index-v5", ...parts(index));
  const contentPath = path.join("content-v2", "sha512", ...parts(content));
  const sourceIndex = path.join(cacheSource, "_cacache", indexPath);
  const sourceContent = path.join(cacheSource, "_cacache", contentPath);
  if (!existsSync(sourceIndex) || !existsSync(sourceContent))
    throw new Error(`The local npm cache lacks the locked OpenCode SDK artifact · ${url.pathname}`);
  const record = readFileSync(sourceIndex, "utf8").split(/\r?\n/).findLast((line) => {
    const separator = line.indexOf("\t");
    if (separator < 0) return false;
    let entry;
    try { entry = JSON.parse(line.slice(separator + 1)); }
    catch { return false; }
    if (entry?.key !== key || entry.integrity !== integrity) return false;
    const headerNames = ["reqHeaders", "resHeaders"].flatMap(name => Object.keys(entry.metadata?.[name] ?? {}));
    return !headerNames.some(name => /authorization|cookie|credential|api-key|access-token/i.test(name));
  });
  if (!record) throw new Error(`The locked OpenCode SDK artifact has no verified public cache entry · ${url.pathname}`);
  const bytes = readFileSync(sourceContent);
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity)
    throw new Error(`The cached OpenCode SDK artifact changed · ${url.pathname}`);
  const destinationIndex = path.join(cacheTarget, "_cacache", indexPath);
  const destinationContent = path.join(cacheTarget, "_cacache", contentPath);
  mkdirSync(path.dirname(destinationIndex), { recursive: true });
  mkdirSync(path.dirname(destinationContent), { recursive: true });
  writeFileSync(destinationIndex, `\n${record}\n`);
  writeFileSync(destinationContent, bytes);
}

export function installOpenCodeProbeSdk(offlineCache) {
  assertOpenCodeProbeHost();
  if (offlineCache !== undefined && !path.isAbsolute(offlineCache))
    throw new Error("Use an absolute path to the npm cache for offline OpenCode SDK setup.");
  const final = openCodeProbeSdkDirectory();
  if (existsSync(final)) return verifyOpenCodeProbeSdk(final);

  const bundledNpm = path.join(product, "runtime/node_modules/npm/bin/npm-cli.js");
  const npm = existsSync(bundledNpm) ? bundledNpm : path.join(product, "node_modules/npm/bin/npm-cli.js");
  if (!existsSync(npm)) throw new Error("The pinned TeamSwarm npm runtime is unavailable.");
  const source = path.join(product, "config/opencode-probe-sdk");
  const modules = openCodeProbeSdkModules(source);
  const vault = path.dirname(final);
  mkdirSync(vault, { recursive: true });
  const realVault = realpathSync(vault);
  if (realVault.toLowerCase() !== path.resolve(vault).toLowerCase())
    throw new Error("The TeamSwarm SDK directory changed location.");
  const stage = mkdtempSync(path.join(realVault, ".prepare-"));
  const sdk = path.join(stage, "sdk"), cache = path.join(stage, "npm-cache"), home = path.join(stage, "home");
  const userConfig = path.join(stage, "npmrc"), globalConfig = path.join(stage, "npmrc-global");
  try {
    for (const dir of [sdk, cache, home]) mkdirSync(dir);
    for (const name of Object.keys(openCodeProbeSdkFiles)) copyFileSync(path.join(source, name), path.join(sdk, name));
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    if (offlineCache) for (const module of modules) copyLockedTarball(offlineCache, cache, module);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\)|LANG|LC_ALL)$/i.test(key)));
    Object.assign(env, {
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home, TMPDIR: home,
      NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_UPDATE_NOTIFIER: "false",
      ...(offlineCache ? { NPM_CONFIG_OFFLINE: "true" } : {}),
    });
    const command = spawnSync(process.execPath, [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-bin-links",
      "--no-audit", "--no-fund", "--no-update-notifier", "--registry=https://registry.npmjs.org/", ...(offlineCache ? ["--offline"] : [])],
    { cwd: sdk, env, timeout: 180000, windowsHide: true, stdio: "inherit" });
    if (command.error || command.status !== 0) throw new Error("The locked OpenCode probe SDK installation failed.");
    verifyOpenCodeProbeSdk(sdk);
    try { if (!existsSync(final)) renameSync(sdk, final); }
    catch (error) { if (!existsSync(final)) throw error; }
    return verifyOpenCodeProbeSdk(final);
  } finally {
    const info = lstatSync(stage);
    const resolved = realpathSync(stage);
    if (!info.isDirectory() || info.isSymbolicLink() || path.dirname(resolved).toLowerCase() !== realVault.toLowerCase() ||
        !path.basename(resolved).startsWith(".prepare-"))
      throw new Error("The generated SDK staging directory changed location.");
    rmSync(resolved, { recursive: true, force: true });
  }
}
