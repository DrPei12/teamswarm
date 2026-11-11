import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "../../teamswarm/node_modules/playwright/index.mjs";
import { createApp } from "../../apps/server/dist/app.js";
import { codexPermissionOptions } from "../../apps/server/dist/runtime/permission-options.js";

const root = mkdtempSync(path.resolve(".local/paused-settings-ui-"));
const project = path.join(root, "project");
mkdirSync(project);
const server = createServer().listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const port = server.address().port;
const origin = "http://127.0.0.1:" + port;
const service = createApp({
  dataDir: path.join(root, "data"), webDistDir: path.resolve("teamswarm/dist"), apiPort: port,
  harnesses: [{ id: "codex", capabilities: { fixture: true }, permissionOptions: () => codexPermissionOptions,
    inspect: async () => ({ available: true, installed: true, authenticated: true, models: [{ model: "fixture" }] }),
    validateConfig() {}, async execute() { throw new Error("This test must not start a model"); }, async interrupt() {}, async close() {} }],
});
server.on("request", service.app);
let browser;
try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.TEAMSWARM_BROWSER_CHANNEL ? {channel: process.env.TEAMSWARM_BROWSER_CHANNEL} : {}),
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {}) });
  const context = await browser.newContext();
  const session = await context.request.post(origin + "/api/control/session", {headers:{Authorization:"Bearer "+service.controlToken}});
  assert(session.ok());
  const create = await context.request.post(origin + "/api/product/teams", {data:{name:"Standard client",clientRequestId:randomUUID()}});
  assert(create.ok());
  const {id} = await create.json();
  const current = service.runtime.store.settings(id);
  const save = await context.request.put(origin+"/api/product/teams/"+id+"/runtime", {data:{
    expectedVersion:current.version, workspace:project, config:{harness:"codex",model:"fixture",access:"read-only"}
  }});
  assert(save.ok(),await save.text());
  const page = await context.newPage();
  const panelRequests = [], errors = [];
  page.on("pageerror", error=>errors.push(error.message));
  page.on("request", request=>{
    const pathname = new URL(request.url()).pathname;
    if (/\/assets\/AllocationSettings-|\/api\/teams\/[^/]+\/(?:resources(?:\/|$)|allocation-package)|\/(?:host-allocation|allocation-list|allocation)$/.test(pathname)) panelRequests.push(pathname);
  });
  await page.goto(origin + "/#/team/"+id+"/agent");
  await page.getByRole("button",{name:"Execution permissions",exact:true}).click();
  await page.getByRole("menuitem",{name:"Advanced settings →",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"Advanced settings",exact:true});
  await dialog.getByRole("combobox",{name:"Harness",exact:true}).waitFor();
  await dialog.getByRole("button",{name:"Choose model",exact:true}).waitFor();
  assert.equal(await dialog.getByRole("tab",{name:"Resources and allocation"}).count(),0);
  assert.equal(await dialog.locator(".allocation-settings").count(),0);
  await dialog.getByRole("button",{name:"Cancel",exact:true}).click();
  await page.reload();
  await page.getByRole("button",{name:"Choose effort",exact:true}).waitFor();
  assert.deepEqual(panelRequests,[]);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,manualPanelRequests:panelRequests.length,normalRuntimeAvailable:true}));
} finally {
  await browser?.close(); await service.close(); server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
