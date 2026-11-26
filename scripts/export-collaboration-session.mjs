// Export observable coordinator messages and tool records, not private reasoning
// or system/developer context. Native Team members have their own SQLite export.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const [rollout, threadId, since, output] = process.argv.slice(2);
if (
  !rollout ||
  !threadId ||
  !since ||
  !output ||
  !Number.isFinite(Date.parse(since))
)
  throw new Error(
    "Use <rollout.jsonl> <thread-id> <ISO-since> <output.jsonl>.",
  );
const bytes = readFileSync(rollout),
  lines = bytes.toString("utf8").split(/\r?\n/);
const records = [],
  secrets = [];
for (const name of ["BAILIAN_API_KEY", "DASHSCOPE_API_KEY"])
  if (process.env[name]) secrets.push(process.env[name]);
for (const key of [
  "TEAM_DEEPSEEK_CREDENTIAL_FILE",
  "TEAM_DEEPSEEK_FALLBACK_CREDENTIAL_FILE",
])
  if (process.env[key])
    secrets.push(
      readFileSync(process.env[key], "utf8")
        .replace(/^\uFEFF/, "")
        .trim(),
    );
const driver = path.join(
  process.cwd(),
  ".local/harness-allocation/driver.json",
);
secrets.push(JSON.parse(readFileSync(driver, "utf8")).token);
const clean = (s) => {
  for (const secret of secrets)
    if (secret) s = s.split(secret).join("[credential-redacted]");
  return s;
};
let identityVerified = false,
  partialFinalLine = false;
const allowed = new Set([
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "agent_message",
]);
for (const [index, line] of lines.entries()) {
  if (!line) continue;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    if (index === lines.length - 1) {
      partialFinalLine = true;
      continue;
    }
    throw new Error(`Invalid source record ${index + 1}.`);
  }
  const p = row.payload ?? {};
  if (row.type === "session_meta") {
    if (p.id !== threadId)
      throw new Error("The source is not the authorized coordinator thread.");
    identityVerified = true;
  }
  if (
    Date.parse(row.timestamp) < Date.parse(since) ||
    row.type !== "response_item"
  )
    continue;
  if (p.type === "message") {
    if (
      !["user", "assistant"].includes(p.role) ||
      ["analysis", "summary"].includes(p.channel)
    )
      continue;
    const text = (p.content ?? []).map((x) => x.text ?? "").join("\n");
    if (
      text.startsWith("# AGENTS.md instructions") ||
      text.includes("<environment_context>") ||
      text.startsWith("<external_codex_apps_open_page>")
    )
      continue;
  } else if (!allowed.has(p.type)) continue;
  records.push(
    clean(
      JSON.stringify({
        sourceLine: index + 1,
        timestamp: row.timestamp,
        payload: p,
      }),
    ),
  );
}
if (!identityVerified) throw new Error("Missing source thread identity.");
mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
const content = records.join("\n") + "\n";
writeFileSync(output, content);
const hash = (x) => createHash("sha256").update(x).digest("hex");
const manifest = {
  threadId,
  since,
  exportedAt: new Date().toISOString(),
  records: records.length,
  bytes: Buffer.byteLength(content),
  sha256: hash(content),
  sourcePrefixBytes: bytes.length,
  sourcePrefixSha256: hash(bytes),
  partialFinalLine,
  scope:
    "Original observable messages and tool records. Credentials redacted. System/developer context and private reasoning excluded. Platform-encrypted fields are preserved encrypted, not reconstructed.",
};
writeFileSync(output + ".manifest.json", JSON.stringify(manifest, null, 2));
console.log(
  JSON.stringify({
    output,
    records: manifest.records,
    bytes: manifest.bytes,
    sha256: manifest.sha256,
  }),
);
