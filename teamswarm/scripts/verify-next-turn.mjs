import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { openNextTurnFixture } from "../../test/fixtures/next-turn.mjs";

const fixture = await openNextTurnFixture();
let browser;
const errors = [],
  checks = [];
const until = async (check) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > 12000) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};
try {
  browser = await chromium.launch({
    channel: process.env.TEAMSWARM_BROWSER_CHANNEL || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1044, height: 679 },
    deviceScaleFactor: 1.5,
    reducedMotion: "reduce",
  });
  await context.request.post(fixture.base + "/api/control/session", {
    headers: { authorization: `Bearer ${fixture.service.controlToken}` },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(fixture.base + `/#/team/${fixture.team.id}/agent`);
  const effort = () =>
    page.getByRole("button", { name: "Choose effort", exact: true });
  const send = async (text) => {
    await page.locator(".composer textarea").fill(text);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
  };
  await effort().waitFor();
  await send("Hold the first local fixture turn.");
  await until(() => fixture.requests.length === 1);
  assert.equal(fixture.requests[0].config.effort, "low");
  const attempt = fixture.service.runtime.store
    .list("attempts", fixture.team.id)
    .at(-1);
  const endpoint = `**/product/teams/${fixture.team.id}/branches/*/host/runtime`;
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "fixture_save_failure",
          message: "Local save failure. Retry.",
        },
      }),
    }),
  );
  await effort().click();
  await page.getByRole("button", { name: "High", exact: true }).click();
  await page
    .getByRole("alert")
    .getByText("Local save failure. Retry.")
    .waitFor();
  assert.equal((await effort().innerText()).trim(), "Low");
  assert.equal(await page.locator(".runtime-pending").count(), 0);
  await page.unroute(endpoint);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/host/runtime") &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "High", exact: true }).click();
  assert.equal((await saved).status(), 200);
  await page
    .getByRole("status")
    .getByText("Applies next turn", { exact: true })
    .waitFor();
  assert.deepEqual(
    fixture.service.runtime.store.get("attempts", fixture.team.id, attempt.id),
    attempt,
  );
  checks.push(
    "running Host save and failed-save retry; active Attempt unchanged",
  );
  await page.reload();
  await page.getByText("Applies next turn", { exact: true }).waitFor();
  assert.equal((await effort().innerText()).trim(), "High");
  checks.push("saved value and next-turn hint survive reload");
  for (const width of [1044, 760, 390]) {
    await page.setViewportSize({ width, height: 679 });
    await page.screenshot({
      path: path.join(fixture.root, `pending-${width}.png`),
    });
    assert(await page.locator(".runtime-pending").isVisible());
    assert(await effort().isEnabled());
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  checks.push("pending state at 1044, 760 and 390 CSS px, DPR 1.5");
  fixture.release();
  await until(
    () =>
      !fixture.service.runtime.store
        .list("attempts", fixture.team.id)
        .some((a) => a.status === "running"),
  );
  await page.locator(".runtime-pending").waitFor({ state: "detached" });
  await send("Start the next fixture turn.");
  await until(() => fixture.requests.length === 2);
  assert.equal(fixture.requests[1].config.effort, "high");
  assert.equal(await page.locator(".runtime-pending").count(), 0);
  assert.equal(
    fixture.service.runtime.store.get("attempts", fixture.team.id, attempt.id)
      .config.effort,
    "low",
  );
  checks.push(
    "next real scheduler dispatch uses High; old Attempt stays Low; hint clears",
  );
  await effort().click();
  await page.getByRole("button", { name: "Low", exact: true }).click();
  await page.getByText("Applies next turn", { exact: true }).waitFor();
  await effort().click();
  await page.getByRole("button", { name: "High", exact: true }).click();
  await page.locator(".runtime-pending").waitFor({ state: "detached" });
  checks.push("restoring active configuration clears pending hint");
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(fixture.root, "result.json"),
    JSON.stringify({ passed: true, fixture: true, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, root: fixture.root, checks }));
} finally {
  fixture.release();
  await browser?.close();
  await fixture.close();
}
