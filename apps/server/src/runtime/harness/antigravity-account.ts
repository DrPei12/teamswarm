import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { antigravityInspection } from "./antigravity.js";
import { nativeEntry, terminateNative } from "./native-support.js";
import { installerEnvironment } from "./device-tools.js";
import { spawnOwned, confirmOwnedExit } from "./owned-process.js";
import { conflict } from "../../errors.js";

type Login = {
  id: string;
  state: "waiting" | "complete" | "failed" | "cancelled";
  error?: string;
};
class AntigravityAccounts {
  private job?: {
    view: Login;
    child: ChildProcessWithoutNullStreams;
    timer: ReturnType<typeof setTimeout>;
  };
  private starting?: Promise<Login>;
  async status() {
    const observed = await antigravityInspection(true);
    return {
      installed: observed.installed,
      available: observed.available,
      version: observed.version,
      login: this.poll(),
      error: "error" in observed ? observed.error : undefined,
    };
  }
  poll() {
    return this.job ? { ...this.job.view } : null;
  }
  async start(): Promise<Login> {
    if (this.starting) return this.starting;
    if (this.job?.view.state === "waiting") return { ...this.job.view };
    this.starting = this.launch();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }
  private async launch(): Promise<Login> {
    const entry = nativeEntry("antigravity"),
      javascript = /\.[cm]?js$/i.test(entry);
    const child = await spawnOwned(
      javascript ? process.execPath : entry,
      [...(javascript ? [entry] : []), "acp", "--login", "--disable-telemetry"],
      {
        env: installerEnvironment(),
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    const view: Login = { id: randomUUID(), state: "waiting" };
    const timer = setTimeout(
      () =>
        void this.cancel(view.id).catch((error) => {
          view.error = (error as Error).message;
        }),
      10 * 60 * 1000,
    );
    timer.unref();
    this.job = { view, child, timer };
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      view.state = "failed";
      view.error =
        "Antigravity sign-in could not start. Check the CLI installation.";
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (view.state !== "waiting") return;
      view.state = code === 0 ? "complete" : "failed";
      if (code !== 0)
        view.error = "Antigravity sign-in ended before completion. Try again.";
    });
    return { ...view };
  }
  async cancel(id: string) {
    const job = this.job;
    if (!job || job.view.id !== id)
      throw conflict("login_changed", "The sign-in request changed.");
    if (job.view.state !== "waiting") return this.poll();
    clearTimeout(job.timer);
    if (
      !(await confirmOwnedExit(job.child)) &&
      !(await terminateNative(job.child))
    )
      throw conflict(
        "login_stopping",
        "Antigravity sign-in is still closing. Try again.",
      );
    job.view.state = "cancelled";
    return this.poll();
  }
  async close() {
    if (this.starting) await this.starting.catch(() => {});
    if (this.job?.view.state === "waiting") await this.cancel(this.job.view.id);
  }
}
export const antigravityAccounts = new AntigravityAccounts();
