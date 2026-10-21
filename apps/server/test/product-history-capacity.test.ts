import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { ProductStore } from "../src/product.js";

test("5000-message history stays bounded, pages ties without gaps and revalidates unchanged snapshots", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-history-capacity-"));
  const service = createApp({ dataDir: path.join(root, "data"), harnesses: [] });
  const team = service.store.createTeam("History", "");
  const product = new ProductStore(service.runtime);
  product.configureDefault(team.id);
  const chat = service.store.createConversation(team.id, "Long conversation", null)!;
  const insert = service.store.database.prepare("INSERT INTO messages(id,conversation_id,role,content,created_at,delivery) VALUES(?,?,'user',?,?,'recorded')");
  const ids: string[] = [];
  service.runtime.store.transaction(() => {
    for (let i = 0; i < 5000; i++) {
      const id = randomUUID(); ids.push(id);
      insert.run(id, chat.id, "Synthetic history. ".repeat(110), "2026-01-01T00:00:00Z");
    }
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const headers = { authorization: `Bearer ${service.controlToken}` };
  try {
    const response = await fetch(base + "/product", { headers });
    const raw = await response.text(), snapshot = JSON.parse(raw);
    assert.ok(Buffer.byteLength(raw) < 160_000, `Snapshot bytes: ${Buffer.byteLength(raw)}`);
    assert.equal(snapshot.chats[0].messages.length, 50);
    assert.deepEqual(snapshot.chats[0].messages.map((m: any) => m.id), ids.slice(-50));
    const tag = response.headers.get("etag")!;
    assert.equal((await fetch(base + "/product", { headers: { ...headers, "if-none-match": tag } })).status, 304);
    const older = await fetch(base + `/product/conversations/${chat.id}/messages?before=${snapshot.chats[0].historyBefore}`, { headers });
    const page: any = await older.json();
    assert.equal(older.status, 200);
    assert.deepEqual(page.messages.map((m: any) => m.id), ids.slice(-100, -50));
    let cursor = page.historyBefore, collected = [...page.messages, ...snapshot.chats[0].messages].map((m: any) => m.id);
    while (cursor) {
      const response = await fetch(base + `/product/conversations/${chat.id}/messages?before=${cursor}`, { headers });
      assert.equal(response.status, 200);
      const next: any = await response.json();
      collected.unshift(...next.messages.map((m: any) => m.id));
      cursor = next.historyBefore;
    }
    assert.deepEqual(collected, ids);
    insert.run(randomUUID(), chat.id, "A new message", "2026-01-02T00:00:00Z");
    assert.equal((await fetch(base + "/product", { headers: { ...headers, "if-none-match": tag } })).status, 200);
    assert.equal((await fetch(base + `/product/conversations/${chat.id}/messages?before=missing`, { headers })).status, 404);
    console.log(JSON.stringify({ messages: 5000, snapshotBytes: Buffer.byteLength(raw), returned: 50, pagesVerified: 100 }));
  } finally {
    await service.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot validators identify content across service instances with identical write counts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-history-validator-"));
  const services = [createApp({ dataDir: path.join(root, "first"), harnesses: [] }), createApp({ dataDir: path.join(root, "second"), harnesses: [] })];
  try {
    const tags = services.map((service, index) => {
      service.store.createTeam("Workspace " + index, "");
      const product = new ProductStore(service.runtime);
      product.snapshot();
      return product.snapshotTag();
    });
    assert.notEqual(tags[0], tags[1]);
  } finally { for (const service of services) await service.close(); rmSync(root, { recursive: true, force: true }); }
});
