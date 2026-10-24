import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, linkSync, symlinkSync, existsSync, statSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceAccess } from "../src/runtime/workspace-access.js";
import { preflight } from "../src/runtime/harness/preflight.js";
import { prepareExecutionEnvironment } from "../src/runtime/harness/execution-environment.js";
import { spawnSync } from "node:child_process";

test("prepared checks normalize temporary storage and preserve command failure without shell interpretation", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "teamswarm-prepared-"));
  const prepared = prepareExecutionEnvironment(scratch, {});
  const command = [...prepared.commandPrefix.slice(1), process.execPath, "-e",
    "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const root=os.tmpdir();const a=path.join(root,'atomic');fs.writeFileSync(a,process.argv[1]);fs.renameSync(a,a+'.done');console.log(JSON.stringify({root,text:fs.readFileSync(a+'.done','utf8'),temp:process.env.TEMP,tmp:process.env.TMP,telemetry:process.env.POWERSHELL_TELEMETRY_OPTOUT}));",
    "literal $(not-a-command) & text"];
  const result = spawnSync(prepared.commandPrefix[0], command, {
    env: { ...process.env, TEMP: path.join(scratch, "invalid"), TMP: "invalid", TMPDIR: "invalid" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.root, prepared.directory);
  assert.equal(output.temp, prepared.directory);
  assert.equal(output.tmp, prepared.directory);
  assert.equal(output.text, "literal $(not-a-command) & text");
  assert.equal(output.telemetry, "1");
  const failed = spawnSync(prepared.commandPrefix[0], [...prepared.commandPrefix.slice(1), process.execPath, "-e", "process.exit(7)"]);
  assert.equal(failed.status, 7);
  assert.equal(prepared.linkFixtures, undefined, "Ordinary commands do not prepare link fixtures.");
});


// A read-only Windows reviewer can use real links prepared in its writable
// scratch grant. It still verifies their filesystem identity and all write
// assertions; no link test is skipped or replaced with a filesystem mock.
const preparedLinks = process.env.TEAMSWARM_LINK_FIXTURES ?? process.env.TEAMSWARM_TEST_LINK_FIXTURES;
if (preparedLinks) assert.ok(path.isAbsolute(preparedLinks));

test("bounded writes preserve peers, reject stale edits and private paths, and replace hard links safely", () => {
  const root = preparedLinks ? path.join(preparedLinks, "hardlink") : mkdtempSync(path.join(tmpdir(), "teamswarm-scope-"));
  writeFileSync(path.join(root,"owned.md"), "before\n");
  writeFileSync(path.join(root,"peer.md"), "peer\n");
  const files = new WorkspaceAccess(root, ["owned.md", "docs/", "alias.md"]);
  const original = files.read("owned.md");
  files.edit("owned.md", "before", "after", original.sha256!);
  assert.equal(readFileSync(path.join(root,"owned.md"),"utf8"), "after\n");
  assert.throws(()=>files.write("owned.md","clobber",original.sha256!), { code: "file_changed" });
  assert.throws(()=>files.write("peer.md","clobber",files.read("peer.md").sha256!), /cannot write/);
  assert.equal(readFileSync(path.join(root,"peer.md"),"utf8"), "peer\n");
  for (const p of ["../outside.md",".local/cache.json",".git/config","node_modules/x","docs/../../peer.md","docs/x:stream","docs/NUL","docs/end."])
    assert.throws(()=>files.write(p,"bad",null));
  files.write("docs/new.md","new",null);
  assert.throws(()=>files.write("docs/new.md","replace",null), { code: "file_changed" });
  if (!preparedLinks) linkSync(path.join(root,"peer.md"),path.join(root,"alias.md"));
  const peer = statSync(path.join(root,"peer.md"), { bigint: true });
  const alias = statSync(path.join(root,"alias.md"), { bigint: true });
  assert.notEqual(peer.ino, 0n);
  assert.equal(alias.ino, peer.ino, "fixture must be a real hard link");
  assert.equal(alias.dev, peer.dev);
  files.write("alias.md","separate",files.read("alias.md").sha256!);
  assert.equal(readFileSync(path.join(root,"peer.md"),"utf8"),"peer\n");
  assert.equal(readFileSync(path.join(root,"alias.md"),"utf8"),"separate");
  assert.equal(WorkspaceAccess.overlaps("docs/", "docs/new.md"), true);
  assert.equal(WorkspaceAccess.overlaps("docs/", "docs-other/new.md"), false);
  if (process.platform === "win32") {
    assert.equal(WorkspaceAccess.overlaps("DOCS/", "docs/new.md"), true);
    files.write("OWNED.md", "case-aware", files.read("owned.md").sha256!);
  }
});

test("editing preserves the exact previous bytes before writing, and unchanged edits do no extra work", () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-preserve-"));
  const file = path.join(root, "owned.md");
  const before = Buffer.from("Existing user content\r\nSpecific sentence\r\n");
  writeFileSync(file, before);
  const preserved: Buffer[] = [];
  const access = new WorkspaceAccess(root, ["owned.md"], [], bytes => {
    assert.deepEqual(readFileSync(file), before, "preimage must exist before replacement");
    preserved.push(Buffer.from(bytes));
  });
  const hash = access.read("owned.md").sha256!;
  assert.equal(access.write("owned.md", before.toString(), hash).unchanged, true);
  assert.equal(preserved.length, 0);
  access.edit("owned.md", "Specific sentence", "Updated sentence", hash);
  assert.deepEqual(preserved, [before]);
  assert.equal(readFileSync(file, "utf8"), "Existing user content\r\nUpdated sentence\r\n");
  const failing = new WorkspaceAccess(root, ["owned.md"], [], () => { throw new Error("storage unavailable"); });
  assert.throws(() => failing.edit("owned.md", "Updated", "Lost", failing.read("owned.md").sha256!), /storage unavailable/);
  assert.equal(readFileSync(file, "utf8"), "Existing user content\r\nUpdated sentence\r\n");
});

test("a linked directory and platform-owned data cannot acquire write authority", () => {
  const root = preparedLinks ? path.join(preparedLinks, "junction") : mkdtempSync(path.join(tmpdir(), "teamswarm-links-"));
  const outside = preparedLinks ? path.join(preparedLinks, "outside") : mkdtempSync(path.join(tmpdir(), "teamswarm-peer-"));
  if (!preparedLinks) symlinkSync(outside,path.join(root,"linked"),process.platform === "win32" ? "junction" : "dir");
  assert.equal(lstatSync(path.join(root,"linked")).isSymbolicLink(), true);
  // Windows package virtualization can expose two paths for the same directory.
  const linked = statSync(realpathSync(path.join(root,"linked")), { bigint: true });
  const target = statSync(realpathSync(outside), { bigint: true });
  assert.notEqual(target.ino, 0n);
  assert.equal(linked.ino, target.ino);
  assert.equal(linked.dev, target.dev);
  const files = new WorkspaceAccess(root,["linked/", "data/"] ,[path.join(root,"data")]);
  assert.throws(()=>files.write("linked/outside.txt","bad",null), /Linked paths/);
  assert.throws(()=>files.write("data/database.txt","bad",null), /Platform data/);
  assert.equal(existsSync(path.join(outside,"outside.txt")),false);
});

test("lightweight work avoids command probes; unsupported checks fail before execution; reusable probes are cached", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-preflight-test-"));
  const config = { harness:"fixture", model:null, provider:null, baseUrl:null, credentialEnv:null, effort:null, access:"workspace-write" as const };
  const input = { workspace:root, config, writePaths:["owned.md"], scratchDirectory:path.join(tmpdir(),"teamswarm-probes",path.basename(root)),requirements:{} };
  let probes=0;
  const probe=async()=>{probes++;return { childProcesses:true };};
  assert.equal((await preflight(input,process.execPath,false,probe)).passed,true);
  assert.equal(probes,0);
  assert.equal((await preflight({...input,writePaths:undefined},process.execPath,false,probe)).passed,false);
  const required={...input,requirements:{nativeCommands:true}};
  assert.equal((await preflight(required,process.execPath,false,probe)).passed,false);
  assert.equal(probes,0);
  assert.equal((await preflight(required,process.execPath,true,probe)).passed,true);
  assert.equal((await preflight({...required,scratchDirectory:required.scratchDirectory+"-next"},process.execPath,true,probe)).cached,true);
  assert.equal(probes,1);
});
