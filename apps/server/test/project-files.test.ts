import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { WorkspaceAccess } from "../src/runtime/workspace-access.js";

test("project file API preserves concurrent changes, enforces control and branch boundaries, and retains original bytes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-project-files-test-"));
  const workspace = path.join(root, "project");
  mkdirSync(path.join(workspace, "docs"), { recursive: true });
  writeFileSync(path.join(workspace, "docs", "guide.md"), "# Original\n");
  writeFileSync(path.join(workspace, ".env"), "PRIVATE");
  const service = createApp({
    dataDir: path.join(root, "data"),
    harnesses: [
      {
        id: "file-fixture",
        capabilities: {},
        async inspect() {
          return {};
        },
        async execute() {
          throw new Error("No model execution in this test");
        },
        async interrupt() {},
        async close() {},
      },
    ],
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const request = async (
    url: string,
    body?: unknown,
    method = body ? "POST" : "GET",
    authorized = true,
  ) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        "content-type": "application/json",
        ...(authorized
          ? { authorization: `Bearer ${service.controlToken}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const team = (await request("/teams", { name: "Files" })).data;
    const config = {
      harness: "file-fixture",
      model: null,
      provider: null,
      baseUrl: null,
      credentialEnv: null,
      effort: null,
      access: "workspace-write",
    };
    assert.equal(
      (
        await request(
          `/teams/${team.id}/runtime`,
          { workspace, config, expectedVersion: 0 },
          "PUT",
        )
      ).status,
      200,
    );
    const branch = (await request(`/teams/${team.id}/branches`)).data
      .branches[0];
    const prefix = `/teams/${team.id}/branches/${branch.id}/files`;
    assert.equal((await request(prefix, undefined, "GET", false)).status, 401);
    const listed = (await request(prefix)).data;
    assert.deepEqual(
      listed.entries.map((e: { name: string }) => e.name),
      ["docs"],
    );
    assert.equal(
      (await request(prefix + "?q=guide")).data.entries[0].path,
      "docs/guide.md",
    );
    const file = (await request(prefix + "/content?path=docs%2Fguide.md")).data;
    assert.equal(file.content, "# Original\n");
    const saved = await request(
      prefix + "/content",
      {
        path: file.path,
        content: "# Edited\n",
        expectedSha256: file.sha256,
        encoding: "utf8",
      },
      "PUT",
    );
    assert.equal(saved.status, 200);
    assert.equal(
      readFileSync(path.join(workspace, file.path), "utf8"),
      "# Edited\n",
    );
    assert.equal(
      (
        await request(
          prefix + "/content",
          {
            path: file.path,
            content: "STALE",
            expectedSha256: file.sha256,
            encoding: "utf8",
          },
          "PUT",
        )
      ).status,
      409,
    );
    writeFileSync(path.join(workspace, file.path), "external change");
    assert.equal(
      (
        await request(
          prefix + "/content",
          {
            path: file.path,
            content: "OVERWRITE",
            expectedSha256: saved.data.sha256,
            encoding: "utf8",
          },
          "PUT",
        )
      ).status,
      409,
    );
    assert.equal(
      readFileSync(path.join(workspace, file.path), "utf8"),
      "external change",
    );
    for (const target of [
      "../data",
      ".env",
      "C:/Windows/win.ini",
      "docs/../../outside.txt",
    ])
      assert.equal(
        (await request(prefix + "/content?path=" + encodeURIComponent(target)))
          .status,
        400,
      );
    assert.equal(
      (await request(prefix.replace(branch.id, "another-branch"))).status,
      404,
    );
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "private.txt"), "PRIVATE");
    symlinkSync(outside, path.join(workspace, "linked"), "junction");
    assert.equal(
      (await request(prefix + "/content?path=linked/private.txt")).status,
      409,
    );
    assert(
      !((await request(prefix)).data.entries as { name: string }[]).some(
        (e) => e.name === "linked",
      ),
    );
    const raw = await fetch(base + prefix + "/raw?path=docs%2Fguide.md", {
      headers: { authorization: `Bearer ${service.controlToken}` },
    });
    assert.equal(await raw.text(), "external change");
    assert.match(raw.headers.get("content-disposition")!, /attachment/);
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("binary write uses hashes and preserves original bytes without altering hard-link peers", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "teamswarm-file-bytes-test-"));
  try {
    writeFileSync(path.join(root, "book.xlsx"), Buffer.from([80, 75, 0, 1, 2]));
    linkSync(path.join(root, "book.xlsx"), path.join(root, "peer.xlsx"));
    const preserved: Buffer[] = [];
    const access = new WorkspaceAccess(root, ["book.xlsx"], [], (bytes) =>
      preserved.push(bytes),
    );
    const before = access.readBytes("book.xlsx");
    const result = access.writeBytes(
      "book.xlsx",
      Buffer.from([80, 75, 0, 9]),
      before.sha256,
    );
    assert.deepEqual(preserved, [before.bytes]);
    assert.deepEqual(readFileSync(path.join(root, "peer.xlsx")), before.bytes);
    assert.equal(access.readBytes("book.xlsx").sha256, result.sha256);
    assert.throws(
      () => access.writeBytes("book.xlsx", Buffer.from([0]), before.sha256),
      /another change/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
