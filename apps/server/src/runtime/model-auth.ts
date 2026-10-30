import { createServer, type Server } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { protect } from "../product-credentials.js";
import { signInPresentation, signInResultPage, type SignInPresentation } from "./model-auth-page.js";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const permission = "chatgpt.tokens.use.direct";
const jwks = createRemoteJWKSet(new URL(issuer + "/.well-known/jwks.json"));
type Account = {
  id: string;
  clientId: string;
  subject: string;
  email: string;
  tokens: string;
  generation?: number;
};
type Tokens = {
  access: string;
  refresh: string;
  identity: string;
  scopes: string[];
  expires: number;
};
type Data = { hostId: string; accounts: Account[] };
type Login = {
  server: Server;
  timer: NodeJS.Timeout;
  state: "pending" | "complete" | "failed";
  accountId?: string;
  error?: string;
  returned?: boolean;
  listeners: Set<(event: "state" | "return" | "close") => void>;
};
type AuthServices = {
  fetch: typeof fetch;
  protect: typeof protect;
  verify: (token: string, client: string) => Promise<Record<string, any>>;
};

/** Owns ChatGPT model authorization, independently of every native Harness account. */
export class ChatGPTAccounts {
  private logins = new Map<string, Login>();
  private refreshing = new Map<string, Promise<string>>();
  private disconnecting = new Set<string>();
  private opened = new Map<string, { encrypted: string; tokens: Tokens }>();
  private closed = false;
  private shutdown = new AbortController();
  private readonly file: string;
  watch(id: string, listener: (event: "state" | "return" | "close") => void) {
    const login = this.logins.get(id);
    if (!login) { listener("close"); return () => {}; }
    login.listeners.add(listener);
    listener(login.returned ? "return" : "state");
    return () => { login.listeners.delete(listener); };
  }
  private expire(id: string) {
    const login = this.logins.get(id);
    if (!login) return;
    clearTimeout(login.timer);
    login.server.close();
    this.logins.delete(id);
    for (const listener of login.listeners) listener("close");
    login.listeners.clear();
  }
  constructor(
    directory: string,
    private readonly services: AuthServices = {
      fetch: globalThis.fetch,
      protect,
      verify: async (token, client) =>
        (
          await jwtVerify(token, jwks, {
            issuer,
            audience: client,
            requiredClaims: ["sub", "exp", "iat"],
            clockTolerance: 5,
          })
        ).payload,
    },
  ) {
    this.file = path.join(directory, "chatgpt-accounts.json");
  }
  private read(): Data {
    if (existsSync(this.file))
      return JSON.parse(readFileSync(this.file, "utf8"));
    const value = { hostId: "urn:uuid:" + randomUUID(), accounts: [] };
    mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      writeFileSync(this.file, JSON.stringify(value), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return JSON.parse(readFileSync(this.file, "utf8"));
      throw error;
    }
    return value;
  }
  private write(value: Data) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, this.file);
  }
  list() {
    return this.read().accounts.map(({ tokens, ...account }) => ({
      ...account,
      connected: !!tokens,
    }));
  }
  private account(id: string) {
    const account = this.read().accounts.find((a) => a.id === id);
    if (!account)
      throw new Error(
        "ChatGPT account not found. Continue with ChatGPT in model connections.",
      );
    return account;
  }
  private async exchange(body: Record<string, string>) {
    const response = await this.services.fetch(
      issuer + "/api/accounts/oauth/token",
      {
        method: "POST",
        body: new URLSearchParams({ ...body, resource }),
        redirect: "error",
        signal: AbortSignal.any([
          this.shutdown.signal,
          AbortSignal.timeout(30000),
        ]),
      },
    );
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { error?: string | { code?: string } } | null;
      const code = typeof error?.error === "string" ? error.error : error?.error?.code;
      const expired = response.status === 401 || code === "invalid_grant";
      throw new Error(expired
        ? "ChatGPT authorization expired. Reconnect this account."
        : `ChatGPT authorization is temporarily unavailable (${response.status}). Try again shortly.`);
    }
    const value = (await response.json()) as Record<string, any>;
    if (
      typeof value.access_token !== "string" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0 ||
      (value.token_type ?? "Bearer").toLowerCase() !== "bearer"
    )
      throw new Error("ChatGPT returned an invalid token response.");
    return value;
  }
  private tokens(value: Record<string, any>, previous?: Tokens): Tokens {
    const scopes =
      typeof value.scope === "string"
        ? value.scope.split(/\s+/)
        : (previous?.scopes ?? []);
    if (!scopes.includes(permission))
      throw new Error("Enable ChatGPT plan usage when signing in.");
    const refresh = value.refresh_token ?? previous?.refresh;
    if (typeof refresh !== "string" || !refresh)
      throw new Error("ChatGPT did not grant renewable access. Sign in again.");
    return {
      access: value.access_token,
      refresh,
      identity: value.id_token ?? previous?.identity ?? "",
      scopes,
      expires: Date.now() + value.expires_in * 1000,
    };
  }
  private async save(
    account: Omit<Account, "tokens">,
    tokens: Tokens,
    current: () => boolean = () => true,
  ) {
    const encrypted = await this.services.protect(JSON.stringify(tokens));
    const release = await this.lock(this.file + ".store.lock");
    try {
      if (!current())
        throw new Error("Sign-in was cancelled. Start sign-in again.");
      const data = this.read();
      data.accounts = [
        ...data.accounts.filter((a) => a.id !== account.id),
        { ...account, tokens: encrypted },
      ];
      this.write(data);
      this.opened.set(account.id, { encrypted, tokens });
    } finally {
      release();
    }
  }
  private async lock(file: string) {
    const deadline = Date.now() + 35000;
    for (;;) {
      try {
        const handle = openSync(file, "wx", 0o600);
        return () => {
          closeSync(handle);
          unlinkSync(file);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(file).mtimeMs > 120000) {
            unlinkSync(file);
            continue;
          }
        } catch {}
        if (Date.now() > deadline)
          throw new Error(
            "ChatGPT credentials are being saved. Try again shortly.",
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  async start(accountId?: string, returnTo?: SignInPresentation) {
    if (this.closed) throw new Error("Service is closing.");
    const presentation = signInPresentation(returnTo);
    if (accountId && this.disconnecting.has(accountId))
      throw new Error("ChatGPT is signing out. Try again shortly.");
    if (
      [...this.logins.values()].filter((l) => l.state === "pending").length >= 4
    )
      throw new Error("Finish the current sign-in first.");
    const account = accountId ? this.account(accountId) : undefined;
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url"),
      id = randomUUID();
    const receipt = randomBytes(32).toString("base64url");
    let email: string | undefined;
    let redirect = "",
      consumed = false;
    const server = createServer(async (req, res) => {
      let callback: URL;
      try {
        callback = new URL(req.url ?? "/", redirect);
      } catch {
        res.writeHead(400).end("Invalid sign-in request.");
        return;
      }
      const login = this.logins.get(id);
      if (["/auth/result", "/auth/return"].includes(callback.pathname)) {
        if (!login || login.state === "pending" || callback.searchParams.get("receipt") !== receipt) {
          res.writeHead(404).end(); return;
        }
        if (callback.pathname === "/auth/return") {
          if (req.method !== "POST" || req.headers.origin !== new URL(redirect).origin || !presentation?.desktop) {
            res.writeHead(403).end(); return;
          }
          login.returned = true;
          for (const listener of login.listeners) listener("return");
          res.writeHead(204, { "cache-control": "no-store" }).end();
          return;
        }
        if (req.method !== "GET") { res.writeHead(405).end(); return; }
        const page = signInResultPage({ id, receipt, complete: login.state === "complete", email, presentation });
        res.writeHead(login.state === "complete" ? 200 : 400, page.headers).end(page.html); return;
      }
      if (req.method !== "GET" || callback.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      if (callback.searchParams.get("state") !== state || consumed) {
        res.writeHead(400).end("Invalid sign-in request.");
        return;
      }
      if (!login) {
        res.writeHead(400).end("Sign-in expired.");
        return;
      }
      consumed = true;
      try {
        if (callback.searchParams.has("error"))
          throw new Error("ChatGPT sign-in was not approved.");
        const code = callback.searchParams.get("code");
        const clientId =
          callback.searchParams.get("client_id") ?? account?.clientId;
        if (
          !code ||
          !clientId ||
          clientId === "dynamic_agent_client" ||
          (account && clientId !== account.clientId)
        )
          throw new Error("ChatGPT returned an invalid registration.");
        const value = await this.exchange({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
        });
        const payload = await this.services.verify(value.id_token, clientId);
        if (
          payload.nonce !== nonce ||
          !payload.sub ||
          (account && account.subject !== payload.sub)
        )
          throw new Error(
            "The signed-in ChatGPT account differs from the selected account.",
          );
        const existing = account ?? this.read().accounts.find(a => a.subject === payload.sub);
        const saved = {
          id: existing?.id ?? randomUUID(),
          clientId,
          subject: payload.sub,
          generation: existing?.generation ?? 0,
          email: typeof payload.email === "string" ? payload.email : "ChatGPT",
        };
        if (this.closed) throw new Error("Service is closing.");
        const releaseAccount = await this.lock(
          this.file + "." + saved.id + ".lock",
        );
        try {
          if (
            account &&
            (this.account(account.id).generation ?? 0) !== saved.generation
          )
            throw new Error(
              "This sign-in was cancelled by sign-out. Start sign-in again.",
            );
          await this.save(
            saved,
            this.tokens(value),
            () => !this.closed && login.state === "pending",
          );
        } finally {
          releaseAccount();
        }
        login.state = "complete";
        login.accountId = saved.id;
        email = saved.email;
        const page = signInResultPage({ id, receipt, complete: true, email, presentation });
        res.writeHead(200, page.headers).end(page.html);
      } catch (error) {
        login.state = "failed";
        login.error =
          error instanceof Error ? error.message : "ChatGPT sign-in failed.";
        const page = signInResultPage({ id, receipt, complete: false, presentation });
        res.writeHead(400, page.headers).end(page.html);
      } finally {
        clearTimeout(login.timer);
        login.timer = setTimeout(() => this.expire(id), 120000).unref();
        for (const listener of login.listeners) listener("state");
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    if (this.closed) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("Service is closing.");
    }
    redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}/auth/callback`;
    const timer = setTimeout(() => this.expire(id), 10 * 60_000).unref();
    this.logins.set(id, { server, timer, state: "pending", listeners: new Set() });
    const url = new URL(issuer + "/api/accounts/authorize");
    const values = {
      client_id: account?.clientId ?? "dynamic_agent_client",
      ext_agent_host_id: this.read().hostId,
      response_type: "code",
      redirect_uri: redirect,
      resource,
      scope:
        "openid profile email offline_access resource.invoke " + permission,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      ...(account
        ? { login_hint: account.email }
        : { agent_name_hint: "TeamSwarm" }),
    };
    for (const [key, value] of Object.entries(values))
      url.searchParams.set(key, value);
    return { id, url: url.href, callbackOrigin: new URL(redirect).origin };
  }
  status(id: string) {
    const login = this.logins.get(id);
    if (!login)
      return { state: "failed", error: "Sign-in expired. Try again." };
    return {
      state: login.state,
      accountId: login.accountId,
      error: login.error,
    };
  }
  cancel(id: string) {
    const login = this.logins.get(id);
    if (login?.state === "pending") {
      login.state = "failed";
      login.error = "Sign-in cancelled.";
      login.server.close();
      for (const listener of login.listeners) listener("state");
    }
    return this.status(id);
  }
  async accessToken(id: string): Promise<string> {
    if (this.closed) throw new Error("Service is closing.");
    if (this.disconnecting.has(id)) throw new Error("ChatGPT is signing out.");
    if (this.refreshing.has(id)) return this.refreshing.get(id)!;
    const operation = (async () => {
      const open = async (account: Account) => {
        if (!account.tokens)
          throw new Error("Continue with ChatGPT in model connections.");
        const cached = this.opened.get(id);
        if (cached?.encrypted === account.tokens) return cached.tokens;
        const tokens: Tokens = JSON.parse(
          await this.services.protect(account.tokens, true),
        );
        this.opened.set(id, { encrypted: account.tokens, tokens });
        return tokens;
      };
      const cached = await open(this.account(id));
      if (cached.expires > Date.now() + 60000) return cached.access;
      // Refresh tokens rotate. A file lock also serializes another local service instance.
      const lock = this.file + "." + id + ".lock";
      let handle: number | undefined;
      const deadline = Date.now() + 35000;
      while (handle === undefined) {
        if (this.closed) throw new Error("Service is closing.");
        try {
          handle = openSync(lock, "wx", 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try {
            if (Date.now() - statSync(lock).mtimeMs > 120000) {
              unlinkSync(lock);
              continue;
            }
          } catch {}
          if (Date.now() > deadline)
            throw new Error(
              "ChatGPT credentials are being refreshed. Try again shortly.",
            );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      try {
        const account = this.account(id),
          old = await open(account);
        if (old.expires > Date.now() + 60000) return old.access;
        const value = await this.exchange({
          grant_type: "refresh_token",
          client_id: account.clientId,
          refresh_token: old.refresh,
        });
        if (value.id_token) {
          const payload = await this.services.verify(
            value.id_token,
            account.clientId,
          );
          if (payload.sub !== account.subject)
            throw new Error("ChatGPT account identity changed. Sign in again.");
        }
        const next = this.tokens(value, old);
        await this.save(account, next);
        return next.access;
      } finally {
        closeSync(handle);
        unlinkSync(lock);
      }
    })();
    this.refreshing.set(id, operation);
    try {
      return await operation;
    } finally {
      this.refreshing.delete(id);
    }
  }
  async models(id: string) {
    const response = await this.services.fetch(resource + "/models", {
      headers: { authorization: "Bearer " + (await this.accessToken(id)) },
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`ChatGPT model list unavailable (${response.status}).`);
    const data = (await response.json()) as {
      models?: { slug: string; display_name?: string; visibility?: string }[];
    };
    if (!Array.isArray(data.models))
      throw new Error(
        "ChatGPT returned an invalid model catalog. Try loading it again.",
      );
    const seen = new Set<string>();
    return data.models
      .filter(
        (m) =>
          m.visibility === "list" &&
          typeof m.slug === "string" &&
          m.slug.length <= 200 &&
          !seen.has(m.slug) &&
          !!seen.add(m.slug),
      )
      .slice(0, 1000)
      .map((m) => ({
        model: m.slug,
        name: typeof m.display_name === "string" ? m.display_name : m.slug,
      }));
  }
  async signOut(id: string) {
    if (this.disconnecting.has(id)) throw new Error("ChatGPT is signing out.");
    this.disconnecting.add(id);
    let releaseAccount: (() => void) | undefined;
    try {
      await this.refreshing.get(id)?.catch(() => {});
      releaseAccount = await this.lock(this.file + "." + id + ".lock");
      const account = this.account(id);
      let revoked = !account.tokens;
      // Stop new use durably before the remote revocation request. The account
      // lock prevents another service's rotating refresh from restoring tokens.
      const releaseStore = await this.lock(this.file + ".store.lock");
      try {
        const data = this.read();
        const saved = data.accounts.find((a) => a.id === id);
        if (saved) {
          saved.tokens = "";
          saved.generation = (saved.generation ?? 0) + 1;
        }
        this.write(data);
        this.opened.delete(id);
      } finally {
        releaseStore();
      }
      if (account.tokens)
        try {
          const tokens: Tokens = JSON.parse(
            await this.services.protect(account.tokens, true),
          );
          const discovery = await this.services.fetch(
            issuer + "/.well-known/openid-configuration",
            { signal: AbortSignal.timeout(15000), redirect: "error" },
          );
          const metadata = (await discovery.json()) as {
            revocation_endpoint?: string;
          };
          const url = new URL(metadata.revocation_endpoint!);
          if (url.origin !== issuer)
            throw new Error("Invalid revocation endpoint.");
          const response = await this.services.fetch(url, {
            method: "POST",
            body: new URLSearchParams({
              token: tokens.refresh,
              token_type_hint: "refresh_token",
              client_id: account.clientId,
            }),
            signal: AbortSignal.timeout(15000),
            redirect: "error",
          });
          revoked = response.status === 200;
        } catch {}
      return { revoked };
    } finally {
      releaseAccount?.();
      this.disconnecting.delete(id);
    }
  }
  async close() {
    this.closed = true;
    this.shutdown.abort();
    for (const id of this.logins.keys()) this.expire(id);
    await Promise.allSettled(this.refreshing.values());
    this.opened.clear();
  }
}
