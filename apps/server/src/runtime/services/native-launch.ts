import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  DevelopmentPreview,
  ManagedService,
} from "@team/contracts/services";
import type { Work } from "../types.js";

type Grant = {
  file: string;
  expires: number;
  check: () => void;
  start: () => Promise<ManagedService>;
  result?: Promise<ManagedService>;
};

/** Scoped, revocable launch tickets. Native command approval sees the actual prepared launch. */
export class NativeServiceLaunch {
  private grants = new Map<string, Grant>();
  private server?: Server;
  private listening?: Promise<number>;
  private closing = false;

  private listen() {
    return (this.listening ??= new Promise<number>((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        const token = req.headers.authorization?.replace(/^Bearer /, "");
        const grant = token ? this.grants.get(token) : undefined;
        if (
          this.closing ||
          req.method !== "POST" ||
          req.url !== "/launch" ||
          req.headers.origin ||
          !grant ||
          grant.expires < Date.now()
        ) {
          res.writeHead(403);
          res.end("Launch authorization expired.");
          return;
        }
        try {
          grant.check();
          grant.result ??= grant.start();
          const service = await grant.result;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(service));
        } catch (error) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server!.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Could not prepare native service launch."));
      });
    }));
  }

  async prepare(
    work: Work,
    workspace: string,
    spec: DevelopmentPreview,
    check: () => void,
    start: () => Promise<ManagedService>,
  ) {
    if (this.closing) throw new Error("Project is closing.");
    for (const [token, grant] of this.grants) {
      try {
        if (grant.expires < Date.now()) throw new Error("Expired");
        grant.check();
      } catch {
        this.grants.delete(token);
        try {
          unlinkSync(grant.file);
        } catch {
          /* It may already have been consumed. */
        }
      }
    }
    const port = await this.listen(),
      token = randomBytes(32).toString("hex");
    const file = path.join(
      workspace,
      `.teamswarm-launch-${token.slice(0, 12)}.json`,
    );
    writeFileSync(
      file,
      JSON.stringify({ endpoint: `http://127.0.0.1:${port}/launch`, token }),
      { mode: 0o600, flag: "wx" },
    );
    this.grants.set(token, {
      file,
      expires: Date.now() + 600000,
      check,
      start,
    });
    const compiled = fileURLToPath(
      new URL("./native-launch-command.js", import.meta.url),
    );
    const prefix = existsSync(compiled)
      ? [process.execPath, compiled]
      : [
          process.execPath,
          fileURLToPath(import.meta.resolve("tsx/cli")),
          fileURLToPath(new URL("./native-launch-command.ts", import.meta.url)),
        ];
    return {
      commandPrefix: [...prefix, file],
      framework: spec.framework,
      script: spec.script,
      workId: work.id,
      executionScope: "project-service",
      instruction:
        "Run commandPrefix with your native command tool. This starts the selected development script in a project-owned working copy. The launch response identifies the real process and preview URL.",
    };
  }

  async close() {
    this.closing = true;
    for (const grant of this.grants.values())
      try {
        unlinkSync(grant.file);
      } catch {
        /* Only task-owned ticket files. */
      }
    this.grants.clear();
    this.server?.closeAllConnections();
    if (this.server?.listening)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
