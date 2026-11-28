import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [directory, driverFile] = process.argv.slice(2);
if (!directory || !driverFile)
  throw new Error("Use <export-directory> <private-driver-file>.");
const secrets = [JSON.parse(readFileSync(driverFile, "utf8")).token];
for (const name of ["BAILIAN_API_KEY", "DASHSCOPE_API_KEY"])
  if (process.env[name]) secrets.push(process.env[name]);
for (const name of ["TEAM_DEEPSEEK_CREDENTIAL_FILE", "TEAM_DEEPSEEK_FALLBACK_CREDENTIAL_FILE"])
  if (process.env[name]) secrets.push(readFileSync(process.env[name], "utf8").replace(/^\uFEFF/, "").trim());
assert.ok(secrets.every((s) => typeof s === "string" && s.length >= 16), "Expected real secret references for export verification");
const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
const privateKinds = new Set(["reasoning", "thinking", "thinking_delta", "reasoning_text", "reasoning_text_delta", "agent_thought_chunk"]);
let records = 0, omittedBlocks = 0, files = 0;
function checkRecord(value) {
  if (Array.isArray(value)) return value.forEach(checkRecord);
  if (!value || typeof value !== "object") return;
  if (privateKinds.has(value.type) || privateKinds.has(value.kind) || privateKinds.has(value.sessionUpdate)) {
    assert.ok(value.contentOmitted, "Private reasoning block retained a body");
    assert.ok(!["text", "delta", "content", "summary", "data"].some((key) => key in value), "Private reasoning payload must be omitted");
    omittedBlocks++;
  }
  for (const [key, item] of Object.entries(value)) {
    if (["reasoning_content", "thinking_content"].includes(key))
      assert.equal(item, "[private reasoning omitted]");
    if (key === "data" && typeof item === "string" && /^[\[{]/.test(item)) {
      let decoded;
      try { decoded = JSON.parse(item); } catch { continue; }
      checkRecord(decoded);
    } else checkRecord(item);
  }
}
for (const entry of manifest.manifest) {
  const bytes = readFileSync(path.join(directory, `${entry.table}.jsonl`));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `${entry.table} identity`);
  assert.equal(bytes.length, entry.bytes, `${entry.table} size`);
  const lines = bytes.toString("utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, entry.rows, `${entry.table} record count`);
  lines.forEach((line) => checkRecord(JSON.parse(line)));
  records += lines.length;
}
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { scan(file); continue; }
    assert.ok(entry.isFile(), "Evidence must not follow symbolic links");
    assert.ok(!/^(driver\.json|auth\.json|team\.sqlite(?:-.*)?|.*\.key)$/i.test(entry.name), "Private runtime file included in export");
    const bytes = readFileSync(file);
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, `Credential appeared in ${path.relative(directory, file)}`);
    files++;
  }
}
scan(directory);
const coordinator = path.join(directory, "coordinator.jsonl");
let coordinatorRecords = 0;
for (const line of readFileSync(coordinator, "utf8").split("\n").filter(Boolean)) {
  const row = JSON.parse(line);
  if (row.payload?.type === "message") {
    assert.ok(["user", "assistant"].includes(row.payload.role));
    assert.ok(!["analysis", "summary"].includes(row.payload.channel));
  }
  coordinatorRecords++;
}
const result = { passed: true, tables: manifest.manifest.length, records, omittedBlocks, coordinatorRecords, filesScanned: files, knownCredentialsAbsent: true, privateRuntimeFilesAbsent: true };
writeFileSync(path.join(directory, "export-verification.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
