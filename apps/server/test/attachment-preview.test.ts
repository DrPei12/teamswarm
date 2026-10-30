import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";

test("attachment preview bytes remain readable when the data root has a hidden parent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-preview-"));
  const app = createApp({
    dataDir: path.join(root, ".local", "data"),
    harnesses: [],
  });
  const server = app.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/product/files/`;
  const id = randomUUID(),
    bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const headers = { authorization: `Bearer ${app.controlToken}` };
  try {
    const upload = await fetch(base + id, {
      method: "PUT",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-file-name": "preview.png",
        "x-file-type": "image/png",
        "x-file-size": String(bytes.length),
      },
      body: bytes,
    });
    assert.equal(upload.status, 200);
    const response = await fetch(base + id, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.match(response.headers.get("content-disposition")!, /attachment/);
    assert.equal((await fetch(base + randomUUID(), { headers })).status, 404);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
