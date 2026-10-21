import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, linkSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { stageAttachment, attachmentFilename } from "../src/attachments.js";
import { createApp } from "../src/app.js";

test("an interrupted attachment write can retry after storage is available", () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-attachment-short-write-"));
  const id = randomUUID(), bytes = Buffer.from("retry the complete uploaded attachment");
  const original = fs.writeFileSync;
  try {
    fs.writeFileSync = ((target: any, data: any, ...options: any[]) => {
      if (typeof target === "number" && Buffer.isBuffer(data) && data.equals(bytes)) {
        original(target, data.subarray(0, 3));
        throw Object.assign(new Error("Fixture disk full"), { code: "ENOSPC" });
      }
      return (original as any)(target, data, ...options);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    assert.throws(() => stageAttachment(root, id, "notes.txt", bytes), /disk full/);
    fs.writeFileSync = original;
    syncBuiltinESMExports();
    assert.deepEqual(readFileSync(stageAttachment(root, id, "notes.txt", bytes)), bytes);
  } finally {
    fs.writeFileSync = original;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("attachment staging rejects every directory junction and rolls back the HTTP message", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-attachment-boundary-"));
  const service = createApp({ dataDir: path.join(root, "data"), harnesses: [] });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const headers = { authorization: `Bearer ${service.controlToken}`, "content-type": "application/json" };
  const post = async (route: string, body: unknown) => fetch(base + route, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    const team: any = await (await post("/product/teams", { name: "Boundary", clientRequestId: randomUUID() })).json();
    const chat: any = await (await post("/product/conversations", { teamId: team.id, title: "Host", clientRequestId: randomUUID() })).json();
    const workspace = service.runtime.store.settings(team.id)!.workspace;
    const id = randomUUID(), bytes = Buffer.from([0, 255, 31, 128]);
    const file = { id, name: "sentinel.bin", size: bytes.length, type: "application/octet-stream" };
    assert.equal((await fetch(base + `/product/files/${id}`, { method: "PUT", headers: { ...headers, "content-type": file.type, "x-file-name": file.name, "x-file-type": file.type, "x-file-size": String(file.size) }, body: bytes })).status, 200);
    for (let level = 0; level < 3; level++) {
      const parts = [".teamswarm", "attachments", id];
      const outside = path.join(root, "outside-" + level);
      const outsideDestination = path.join(outside, ...parts.slice(level + 1));
      mkdirSync(outsideDestination, { recursive: true });
      const sentinel = path.join(outsideDestination, file.name);
      writeFileSync(sentinel, "unchanged");
      mkdirSync(path.join(workspace, ...parts.slice(0, level)), { recursive: true });
      const alias = path.join(workspace, ...parts.slice(0, level + 1));
      symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
      try {
        const response = await post("/product/messages", { teamId: team.id, conversationId: chat.id, clientRequestId: randomUUID(), content: "Read file", files: [file], references: [] });
        assert.equal(response.status, 409);
        assert.equal((await response.json() as any).error.code, "attachment_path_conflict");
        assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
        assert.equal(service.store.getConversationDetail(team.id, chat.id)!.messages.length, 0);
        assert.equal(service.runtime.store.list("works", team.id).length, 0);
      } finally { unlinkSync(alias); }
    }
    const first = stageAttachment(workspace, id, file.name, bytes);
    assert.deepEqual(readFileSync(first), bytes);
    assert.equal(stageAttachment(workspace, id, file.name, bytes), first);
    assert.throws(() => stageAttachment(workspace, id, file.name, Buffer.from("changed")), /attachment location/);
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    // Default projects are separate from private service data.
    rmSync(path.join(root, "data-projects"), { recursive: true, force: true });
  }
});

test("attachment reuse never writes through hardlinks or file symlinks; binary, empty and normalized names work", () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-attachment-files-"));
  try {
    const id = randomUUID(), workspace = path.join(root, "project");
    const dir = path.join(workspace, ".teamswarm", "attachments", id);
    mkdirSync(dir, { recursive: true });
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "sentinel");
    const target = path.join(dir, "file.txt");
    linkSync(outside, target);
    assert.throws(() => stageAttachment(workspace, id, "file.txt", Buffer.from("sentinel")), /attachment location/);
    assert.equal(readFileSync(outside, "utf8"), "sentinel");
    unlinkSync(target);
    // Windows junction coverage above works without symlink privileges.
    if (process.platform !== "win32") {
      for (const source of [outside, path.join(root, "missing.txt")]) {
        symlinkSync(source, target);
        assert.throws(() => stageAttachment(workspace, id, "file.txt", Buffer.from("replacement")), /attachment location/);
        unlinkSync(target);
      }
    }
    assert.equal(readFileSync(stageAttachment(workspace, id, "empty.bin", Buffer.alloc(0))).length, 0);
    assert.equal(attachmentFilename(".."), "attachment");
    assert.equal(attachmentFilename("C:\\private\\CON.txt. "), "_CON.txt");
    assert.equal(attachmentFilename("目录/报告.txt"), "报告.txt");
    assert.equal(stageAttachment(workspace, id, "empty.bin", Buffer.alloc(0)), path.join(dir, "empty.bin"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
