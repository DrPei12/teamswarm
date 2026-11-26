import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { HarnessRequest, HarnessResult, NativeCompactionCheckpoint } from "../types.js";
import { confirmOwnedExit } from "./owned-process.js";
import { terminateNative } from "./native-support.js";

export type PiTurnCheckpoint = NativeCompactionCheckpoint
  | { stage: "model"; nativeSessionId: string }
  | { stage: "probe_open"; nativeSessionId: string; probeId: string; paths: string[] }
  | { stage: "probe_close"; nativeSessionId: string; probeId: string; status: "completed" | "failed" | "interrupted" }
  | { stage: "subspace_open"; nativeSessionId: string; childId: string; paths: string[] }
  | { stage: "subspace_close"; nativeSessionId: string; childId: string; status: "completed" | "failed" | "interrupted" };

type Pending = {
  observe: (event: Record<string, any>) => void;
  checkpoint?: (boundary: PiTurnCheckpoint) => string | undefined;
  resolve: (result: HarnessResult) => void;
  observationFailed?: boolean;
};

export class PiDaemon {
  readonly id = randomUUID();
  readonly closed: Promise<boolean>;
  readonly active = new Map<string, Pending>();
  idleSince = Date.now();
  turnsStarted = 0;
  private accepting = true;
  private transportClosed = false;
  private released = false;
  get available() {
    return this.accepting && !this.child.killed && this.child.exitCode === null &&
      this.child.signalCode === null && this.child.stdin.writable;
  }
  private closing?: Promise<boolean>;
  private releaseReason?: string;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly binding: string,
    private observe: HarnessRequest["onEvent"],
    private confirmExit = confirmOwnedExit,
  ) {
    const lines = createInterface({ input: child.stdout });
    const fail = () => {
      this.accepting = false;
      for (const turn of this.active.values())
        turn.resolve({
          status: "unknown",
          text: "",
          error: "The Pi process disconnected during execution.",
        });
      this.active.clear();
    };
    child.stderr.resume();
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.once("exit", () => {
      this.accepting = false;
    });
    this.closed = new Promise((resolve) =>
      child.once("close", () => {
        lines.close();
        fail();
        this.transportClosed = true;
        void this.confirmExit(child).catch(() => false).then(confirmed => {
          this.reportExit(confirmed);
          return this.released;
        }).then(resolve, () => resolve(false));
      }),
    );
    lines.on("line", (line) => {
      try {
        const { turnId, event } = JSON.parse(line);
        const turn = this.active.get(turnId);
        if (!turn) return;
        if (event.type === "result") {
          this.active.delete(turnId);
          this.idleSince = Date.now();
          turn.resolve(
            turn.observationFailed
              ? {
                  status: "unknown",
                  text: "",
                  error: "Pi observations could not be saved.",
                }
              : { status: event.status, text: event.text, error: event.error },
          );
        } else if (event.type === "pi.turn.checkpoint") {
          if (typeof event.requestId !== "string") return;
          let checkpointId: string | undefined;
          try {
            if (!turn.observationFailed || event.boundary?.stage === "probe_close" || event.boundary?.stage === "subspace_close")
              checkpointId = turn.checkpoint?.(event.boundary);
          } catch {
            turn.observationFailed = true;
          }
          this.child.stdin.write(JSON.stringify({ type: "checkpoint.checked", turnId, requestId: event.requestId, checkpointId }) + "\n");
        } else if (!turn.observationFailed) {
          try {
            turn.observe(event);
          } catch {
            turn.observationFailed = true;
            this.abort(turnId);
          }
        }
      } catch {
        void this.close(true);
      }
    });
  }

  observeFromAttempt(observe: HarnessRequest["onEvent"]) {
    this.observe = observe;
  }

  private reportExit(confirmed: boolean) {
    if (this.released) return;
    this.observe({ type: confirmed ? "resource.released" : "resource.unconfirmed",
      data: { id: this.id, pid: this.child.pid, scope: "harness", reason: this.releaseReason ?? "process_exit" } });
    this.released = confirmed;
  }

  async reconcileExit() {
    if (!this.transportClosed) return false;
    await this.closed;
    if (!this.released && await this.confirmExit(this.child)) this.reportExit(true);
    return this.released;
  }

  run(
    turnId: string,
    spec: unknown,
    apiKey: string,
    observe: Pending["observe"],
    checkpoint?: Pending["checkpoint"],
  ) {
    if (!this.available || this.active.has(turnId))
      throw new Error("The Pi process is unavailable for this turn.");
    return new Promise<HarnessResult>((resolve, reject) => {
      this.active.set(turnId, { observe, resolve, checkpoint });
      this.turnsStarted++;
      try {
        this.child.stdin.write(
          JSON.stringify({ type: "run", turnId, spec, apiKey }) + "\n",
        );
      } catch (error) {
        this.active.delete(turnId);
        reject(error);
      }
    });
  }

  abort(turnId: string) {
    if (!this.active.has(turnId) || !this.available) return;
    this.child.stdin.write(JSON.stringify({ type: "abort", turnId }) + "\n");
  }

  close(force = false, reason = force ? "transport_failure" : "shutdown"): Promise<boolean> {
    this.accepting = false;
    if (this.transportClosed) return this.reconcileExit();
    this.releaseReason ??= reason;
    if (force) void terminateNative(this.child);
    return (this.closing ??= (async () => {
      this.child.stdin.end();
      const timer = setTimeout(() => {
        void terminateNative(this.child);
      }, 3000);
      try {
        return await this.closed;
      } finally {
        clearTimeout(timer);
      }
    })());
  }
}
