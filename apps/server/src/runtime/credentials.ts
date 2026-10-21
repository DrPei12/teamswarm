import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Startup-only secret references. HTTP imports cannot read arbitrary server files. */
export function loadCredentialFiles(
  raw = process.env.TEAM_CREDENTIAL_FILES,
): void {
  if (!raw) return;
  const mappings = JSON.parse(raw);
  if (
    !mappings ||
    Array.isArray(mappings) ||
    typeof mappings !== "object" ||
    Object.keys(mappings).length > 32
  )
    throw new Error(
      "TEAM_CREDENTIAL_FILES must map environment names to absolute secret-file paths.",
    );
  const pending: Record<string, string> = {};
  for (const [name, file] of Object.entries(mappings)) {
    if (
      !/^[A-Z][A-Z0-9_]{1,127}$/.test(name) ||
      typeof file !== "string" ||
      !path.isAbsolute(file)
    )
      throw new Error("Invalid credential file reference.");
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 65536)
      throw new Error(`Credential file for ${name} is invalid.`);
    const value = readFileSync(file, "utf8").trim();
    if (!value || /[\r\n\0]/.test(value))
      throw new Error(
        `Credential file for ${name} must contain one non-empty token.`,
      );
    if (process.env[name] && process.env[name] !== value)
      throw new Error(`Credential reference conflicts with existing ${name}.`);
    pending[name] = value;
  }
  Object.assign(process.env, pending);
}
