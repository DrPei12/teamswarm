import { applicationDataBase } from "../../../../../scripts/platform.cjs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { nativeEntry, terminateNative } from "./native-support.js";
import { installerEnvironment } from "./device-tools.js";
import { sessionStoreScope } from "./session-scope.js";
import { badRequest, conflict } from "../../errors.js";
import { isolateGrokEnvironment } from "./grok-config.js";

export type SubscriptionHarness = "claude-code" | "grok";
export const supportsSubscription = (id: string): id is SubscriptionHarness => id === "claude-code" || id === "grok";
export function accountHome(id: SubscriptionHarness) {
  const home = path.join(process.env.TEAM_ACCOUNT_HOME ?? path.join(applicationDataBase(), "TeamSwarm", "accounts"), id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}
// Only the official CLI handles login, storage and refresh. No tokens enter the
// browser, team configuration, activity log, or another provider's environment.
export function subscriptionEnvironment(id: SubscriptionHarness): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = installerEnvironment();
  if (id === "claude-code") {
    env.CLAUDE_CONFIG_DIR = accountHome(id);
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    // auth login still prints its fallback URL; the UI opens that official URL.
    env.BROWSER = "none";
  } else {
    env.GROK_HOME = accountHome(id);
    isolateGrokEnvironment(env);
  }
  return env;
}
export const claudeSubscriptionFlags = ["--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--disable-slash-commands"];
export function subscriptionScope(id: SubscriptionHarness) { return sessionStoreScope(accountHome(id)); }
export function startSubscriptionProcess(id: SubscriptionHarness, args: string[]) {
  const entry = nativeEntry(id);
  if (id === "grok" && path.basename(entry) === "grok-bootstrap.js") throw new Error("Finish the device installation check, then refresh the account status.");
  return spawn(/\.[cm]?js$/i.test(entry) ? process.execPath : entry, /\.[cm]?js$/i.test(entry) ? [entry, ...args] : args, {
    cwd: accountHome(id), env: subscriptionEnvironment(id), windowsHide: true,
    shell: false, stdio: "pipe", detached: process.platform !== "win32",
  });
}
export function cleanTerminal(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}
export function loginPrompt(id: SubscriptionHarness, input: string): { url: string; code?: string } | null {
  const text = cleanTerminal(input);
  for (const match of text.matchAll(/https:\/\/[^\s<>"\x1b]+/g)) {
    try {
      const url = new URL(match[0].replace(/[),.;]+$/, ""));
      if (url.username || url.password || url.hash || url.port) continue;
      if (id === "claude-code") {
        if (!((url.hostname === "claude.com" && url.pathname === "/cai/oauth/authorize") || (url.hostname === "claude.ai" && url.pathname === "/oauth/authorize"))) continue;
        if (!url.searchParams.get("state") || !url.searchParams.get("code_challenge") || url.searchParams.get("response_type") !== "code") continue;
        return { url: url.toString() };
      }
      if (url.hostname !== "accounts.x.ai" || url.pathname !== "/oauth2/device") continue;
      const code = url.searchParams.get("user_code");
      if ([...url.searchParams.keys()].join() !== "user_code" || !code || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(code)) continue;
      const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 400);
      // The URL and repeated code can arrive in different chunks. The verified
      // official URL already carries the code; reject a conflicting repetition.
      const confirmation = after.match(/Confirm this code in your browser:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1];
      if (confirmation && confirmation.toUpperCase() !== code.toUpperCase()) continue;
      return { url: url.toString(), code };
    } catch { /* Ignore unvalidated terminal links. */ }
  }
  return null;
}

export type ModelOption = { model: string; name: string; provider: string; isDefault?: boolean; reasoningEfforts?: { reasoningEffort: string }[] };
type CommandResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
const pendingCommands = new Map<ChildProcessWithoutNullStreams, SubscriptionHarness>();
const unconfirmedCommands = new Set<SubscriptionHarness>();
function assertStopped(id: SubscriptionHarness) {
  if (unconfirmedCommands.has(id)) throw conflict("harness_stopping", "A previous harness check could not be stopped. Close the harness processes before restarting TeamSwarm.");
}
async function command(id: SubscriptionHarness, args: string[], input?: string, timeout = 20000, control = false): Promise<CommandResult> {
  assertStopped(id);
  const child = startSubscriptionProcess(id, args);
  pendingCommands.set(child, id);
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; void terminateNative(child).then(confirmed => { if (!confirmed) unconfirmedCommands.add(id); finish(null); }); }, timeout);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-256000);
      if (control && stdout.split("\n").some(line => { try { return JSON.parse(line).type === "control_response"; } catch { return false; } })) {
        // EOF lets Claude finish the control-only session without a model turn.
        child.stdin.end();
      }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.once("error", () => { pendingCommands.delete(child); clearTimeout(timer); reject(new Error("Unable to start the installed harness.")); });
    child.once("close", code => { pendingCommands.delete(child); finish(code); });
    child.stdin.on("error", () => {});
    if (control) child.stdin.write(input ?? ""); else child.stdin.end(input ?? "");
  });
}
function credentialStamp(id: SubscriptionHarness) {
  try { return createHash("sha256").update(readFileSync(path.join(accountHome(id), id === "grok" ? "auth.json" : ".credentials.json"))).digest("hex"); }
  catch { return "none"; }
}
function grokCredentialPresent() {
  try {
    const data = JSON.parse(readFileSync(path.join(accountHome("grok"), "auth.json"), "utf8"));
    return Object.values(data).some((v: any) => typeof v?.key === "string" && !!v.key && typeof v.refresh_token === "string" && !!v.refresh_token);
  } catch { return false; }
}
export function grokModels(output: string): ModelOption[] {
  const clean = cleanTerminal(output);
  return clean.split("\n").flatMap(line => {
    const match = line.match(/^\s*([*-])\s+(grok-[a-zA-Z0-9._:-]+)(?:\s+\(default\))?\s*$/);
    return match ? [{ model: match[2], name: match[2], provider: "xAI", isDefault: match[1] === "*" }] : [];
  });
}
export async function subscriptionInspection(id: SubscriptionHarness) {
  let entry: string;
  try { entry = nativeEntry(id); } catch { return { id, installed: false, available: false, authenticated: false, models: [] as ModelOption[], loginState: "not_installed", modelState: "not_checked" }; }
  let authenticated: boolean | null = null, models: ModelOption[] = [], account: string | undefined;
  try {
    if (id === "claude-code") {
      const auth = await command(id, ["auth", "status", "--json"]);
      const data = JSON.parse(auth.stdout);
      authenticated = data.loggedIn === true && ["claude.ai", "oauth_token"].includes(data.authMethod);
      account = authenticated && typeof data.email === "string" ? data.email : undefined;
      const catalog = await command(id, ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--permission-mode", "dontAsk", "--tools", "", ...claudeSubscriptionFlags], JSON.stringify({ type: "control_request", request_id: "catalog", request: { subtype: "initialize" } }) + "\n", 15000, true);
      for (const line of catalog.stdout.split("\n")) {
        try {
          const response = JSON.parse(line);
          if (response.type !== "control_response" || response.response?.request_id !== "catalog") continue;
          models = (response.response?.response?.models ?? []).filter((m: any) => typeof m.value === "string" && typeof m.displayName === "string").map((m: any) => ({ model: m.value, name: m.displayName, provider: "Anthropic", isDefault: m.value === "default", reasoningEfforts: (m.supportedEffortLevels ?? []).filter((e: unknown) => typeof e === "string").map((e: string) => ({ reasoningEffort: e })) }));
        } catch { /* Ignore non-protocol text. */ }
      }
    } else {
      const result = await command(id, ["models"]);
      models = grokModels(result.stdout);
      authenticated = grokCredentialPresent();
      if (/not authenticated|No auth credentials|unauthorized|invalid.*token|expired.*token/i.test(result.stdout + result.stderr)) authenticated = false;
      else if (result.timedOut || result.code !== 0) authenticated = null;
    }
  } catch { /* Unknown is distinct from signed out and software missing. */ }
  return { id, installed: true, available: true, entry, authenticated, account, models, loginState: authenticated === true ? "signed_in" : authenticated === false ? "signed_out" : "unknown", modelState: "not_checked", capabilities: { reasoningEffort: models.some(m => m.reasoningEfforts?.length) } };
}

type Login = { id: string; harness: SubscriptionHarness; state: "starting" | "waiting" | "verifying" | "complete" | "failed" | "cancelled"; url?: string; code?: string; error?: string; expiresAt: number };
type ActiveLogin = { view: Login; child: ChildProcessWithoutNullStreams; timer: ReturnType<typeof setTimeout>; stopping: boolean; buffer: string; lock: string };
type ModelCheck = { model: string | null; state: "available" | "unavailable"; checkedAt: number; error?: string };
export class SubscriptionAccounts {
  private logins = new Map<SubscriptionHarness, ActiveLogin>();
  private checks = new Map<string, { stamp: string; value: ModelCheck }>();
  private probes = new Set<SubscriptionHarness>();
  private publicLogin(job?: ActiveLogin) { return job ? { ...job.view } : null; }
  private release(job: ActiveLogin) {
    clearTimeout(job.timer); job.buffer = ""; delete job.view.url; delete job.view.code;
    try { const lock = JSON.parse(readFileSync(job.lock, "utf8")); if (lock.id === job.view.id) unlinkSync(job.lock); } catch { /* Already released. */ }
  }
  async status(id: SubscriptionHarness, model: string | null) {
    const inspection = await subscriptionInspection(id);
    const cached = this.checks.get(`${id}:${model ?? ""}`);
    return { ...inspection, login: this.publicLogin(this.logins.get(id)), modelCheck: cached && cached.stamp === credentialStamp(id) && Date.now() - cached.value.checkedAt < 300000 && inspection.authenticated ? cached.value : { model, state: "not_checked" } };
  }
  async start(id: SubscriptionHarness) {
    assertStopped(id);
    nativeEntry(id);
    if (this.probes.has(id)) throw conflict("model_check_busy", "A model check is already running.");
    const old = this.logins.get(id);
    if (old && ["starting", "waiting", "verifying"].includes(old.view.state)) return this.publicLogin(old);
    const lock = path.join(accountHome(id), ".teamswarm-login.lock");
    const loginId = randomUUID();
    try {
      if (existsSync(lock)) {
        const owner = JSON.parse(readFileSync(lock, "utf8"));
        let alive = true;
        try { process.kill(owner.childPid ?? owner.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive) throw conflict("login_busy", "Another sign-in is already running for this harness.");
        unlinkSync(lock);
      }
      writeFileSync(lock, JSON.stringify({ id: loginId, pid: process.pid }), { flag: "wx", mode: 0o600 });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict("login_busy", "Another sign-in is already running for this harness."); throw error; }
    let child: ChildProcessWithoutNullStreams;
    try { child = startSubscriptionProcess(id, id === "claude-code" ? ["auth", "login", "--claudeai"] : ["login", "--device-auth"]); }
    catch { unlinkSync(lock); throw new Error("Unable to start the installed harness."); }
    writeFileSync(lock, JSON.stringify({ id: loginId, pid: process.pid, childPid: child.pid }), { mode: 0o600 });
    const job: ActiveLogin = { view: { id: loginId, harness: id, state: "starting", expiresAt: Date.now() + 600000 }, child, timer: setTimeout(() => void this.cancel(id, loginId, true), 600000), stopping: false, buffer: "", lock };
    this.logins.set(id, job); this.checks.clear();
    // Account changes must not resume another account's native conversation.
    writeFileSync(path.join(accountHome(id), ".teamswarm-session-store"), randomUUID(), { mode: 0o600 });
    const output = (chunk: Buffer) => {
      if (job.stopping || !["starting", "waiting"].includes(job.view.state)) return;
      job.buffer = (job.buffer + chunk).slice(-64000);
      const prompt = loginPrompt(id, job.buffer);
      if (prompt) { job.view = { ...job.view, ...prompt, state: "waiting" }; job.buffer = ""; }
    };
    child.stdout.on("data", output); child.stderr.on("data", output); child.stdin.on("error", () => {});
    child.once("error", () => { job.view.state = "failed"; job.view.error = "Unable to start the installed harness."; this.release(job); });
    child.once("close", async code => {
      if (job.stopping || job.view.state === "failed") return;
      job.view.state = "verifying"; delete job.view.url; delete job.view.code; job.buffer = "";
      const inspection = code === 0 ? await subscriptionInspection(id) : null;
      if (job.stopping || this.logins.get(id) !== job || job.view.state !== "verifying") return;
      job.view.state = inspection?.authenticated === true ? "complete" : "failed";
      if (job.view.state === "failed") job.view.error = "Sign-in was not completed. Check your subscription and network, then try again.";
      this.release(job);
    });
    return this.publicLogin(job);
  }
  login(id: SubscriptionHarness) { return this.publicLogin(this.logins.get(id)); }
  submitCode(id: SubscriptionHarness, loginId: string, code: string) {
    const job = this.logins.get(id);
    if (id !== "claude-code" || !job || job.view.id !== loginId || job.view.state !== "waiting" || !job.view.url) throw badRequest("invalid_login", "This sign-in is no longer waiting for a code.");
    if (!/^[a-zA-Z0-9._~+\/#=:-]{1,4096}$/.test(code)) throw badRequest("invalid_code", "Paste the code from the official sign-in page.");
    job.child.stdin.write(code + "\n");
    job.view.state = "verifying"; delete job.view.url; job.buffer = "";
    return this.publicLogin(job);
  }
  async cancel(id: SubscriptionHarness, loginId: string, expired = false) {
    const job = this.logins.get(id);
    if (!job || job.view.id !== loginId) throw badRequest("invalid_login", "This sign-in is no longer active.");
    if (!["starting", "waiting", "verifying"].includes(job.view.state)) return this.publicLogin(job);
    job.stopping = true;
    const stopped = job.child.exitCode !== null || await terminateNative(job.child);
    job.view.state = stopped && !expired ? "cancelled" : "failed";
    job.view.error = stopped ? expired ? "Sign-in expired. Start again to receive a new code." : undefined : "Sign-in could not be stopped. Close the harness login process before trying again.";
    if (stopped) this.release(job); else { clearTimeout(job.timer); delete job.view.url; delete job.view.code; job.buffer = ""; }
    return this.publicLogin(job);
  }
  async checkModel(id: SubscriptionHarness, model: string | null) {
    if (this.probes.has(id)) throw conflict("model_check_busy", "A model check is already running.");
    if (["starting", "waiting", "verifying"].includes(this.logins.get(id)?.view.state ?? "")) throw conflict("login_busy", "Another sign-in is already running for this harness.");
    this.probes.add(id);
    try {
      const inspection = await subscriptionInspection(id);
      if (!inspection.authenticated) throw badRequest("sign_in_required", "Sign in to your subscription before checking a model.");
      const scope = subscriptionScope(id);
      const args = id === "claude-code"
        ? ["--print", "Reply exactly OK.", "--output-format", "json", "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "dontAsk", "--no-session-persistence", ...claudeSubscriptionFlags]
        : ["--single", "Reply exactly OK.", "--output-format", "streaming-json", "--max-turns", "1", "--tools", "mcp__*", "--disallowed-tools", "search_tool,use_tool", "--deny", "*", "--permission-mode", "dontAsk", "--no-plan", "--no-subagents", "--disable-web-search"];
      if (model) args.push("--model", model);
      const result = await command(id, args, undefined, 60000);
      if (scope !== subscriptionScope(id)) throw conflict("account_changed", "The account changed during this check. Check the model again.");
      let available = false, responseText = "";
      for (const line of result.stdout.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (id === "grok" && event.type === "text" && typeof event.data === "string") responseText += event.data;
          if (id === "claude-code" && event.type === "result" && event.is_error === false && typeof event.result === "string" && event.result.trim()) available = true;
          if (id === "grok" && event.type === "end" && event.stopReason === "end_turn" && !event.error && !event.errorKind) available = true;
          if (event.type === "error") available = false;
        } catch { /* Never treat text or an exit code as a completed response. */ }
      }
      available &&= result.code === 0 && !result.timedOut && (id !== "grok" || !!responseText.trim());
      const value: ModelCheck = { model, state: available ? "available" : "unavailable", checkedAt: Date.now() };
      if (!available) value.error = result.timedOut ? "The model check timed out. Check your network and try again." : /quota|rate.limit|usage.limit|capacity|429/i.test(result.stdout + result.stderr) ? "The account is signed in, but its current quota or rate limit prevents this request." : "The selected model did not complete a response. Check model access, subscription and network.";
      this.checks.set(`${id}:${model ?? ""}`, { stamp: credentialStamp(id), value });
      return value;
    } finally { this.probes.delete(id); }
  }
  async close(id?: SubscriptionHarness) {
    await Promise.allSettled([...this.logins.values()].filter(job => !id || job.view.harness === id).map(job => this.cancel(job.view.harness, job.view.id)));
    await Promise.allSettled([...pendingCommands].filter(([, owner]) => !id || owner === id).map(([child]) => terminateNative(child)));
  }
}
export const subscriptionAccounts = new SubscriptionAccounts();
