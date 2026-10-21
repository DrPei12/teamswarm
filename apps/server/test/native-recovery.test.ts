import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeHarness } from "../src/runtime/harness/native.js";
import {
  rebootConfirmsTermination,
  systemBootTime,
} from "../src/runtime/harness/native-recovery.js";

test("reboot recovery fails closed for same boot, unavailable evidence and ambiguous timestamps", () => {
  const boot = "2026-10-17T03:00:00Z",
    now = "2026-10-17T04:00:00Z";
  assert.equal(
    rebootConfirmsTermination("2026-10-16T11:00:00Z", boot, now),
    true,
  );
  for (const [receipt, started] of [
    ["2026-10-17T03:30:00Z", boot],
    ["2026-10-17T02:59:30Z", boot],
    ["2026-10-16T11:00:00Z", null],
    ["invalid", boot],
    [null, boot],
    ["2026-10-16T11:00:00Z", "2026-10-18T00:00:00Z"],
  ])
    assert.equal(rebootConfirmsTermination(receipt, started, now), false);
});

test(
  "a pre-boot unknown receipt reconciles as interrupted without changing its bytes",
  { skip: process.platform !== "win32" },
  async () => {
    const boot = await systemBootTime();
    assert.ok(
      boot,
      "Windows must supply boot evidence for this recovery check",
    );
    const root = mkdtempSync(path.join(tmpdir(), "teamswarm-reboot-"));
    const savedHome = process.env.TEAM_HARNESS_HOME;
    process.env.TEAM_HARNESS_HOME = root;
    const directory = path.join(root, "opencode", "fixture-session");
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "fixture-turn.json");
    const receipt = JSON.stringify({
      sessionId: "fixture-session",
      turnId: "fixture-turn",
      pid: 123,
      updatedAt: new Date(Date.parse(boot) - 120_000).toISOString(),
      result: {
        status: "unknown",
        text: "Partial output, not a completed artifact",
        error: "Lost observation",
      },
    });
    writeFileSync(file, receipt);
    try {
      const harness = new NativeHarness("opencode");
      assert.equal(
        (await harness.reconcile("fixture-session", "fixture-turn")).status,
        "interrupted",
      );
      assert.equal(readFileSync(file, "utf8"), receipt);
      writeFileSync(
        file,
        JSON.stringify({
          ...JSON.parse(receipt),
          updatedAt: new Date().toISOString(),
        }),
      );
      assert.equal(
        (await harness.reconcile("fixture-session", "fixture-turn")).status,
        "unknown",
      );
      writeFileSync(
        file,
        JSON.stringify({ ...JSON.parse(receipt), turnId: "another-turn" }),
      );
      await assert.rejects(
        harness.reconcile("fixture-session", "fixture-turn"),
        /identity/,
      );
    } finally {
      if (savedHome === undefined) delete process.env.TEAM_HARNESS_HOME;
      else process.env.TEAM_HARNESS_HOME = savedHome;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
