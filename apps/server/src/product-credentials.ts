import { spawn } from "node:child_process";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function desktopProtect(value: string, decrypt: boolean): Promise<string> {
  if (!process.send || !process.connected || process.env.TEAMSWARM_DESKTOP_CREDENTIALS !== "1") {
    throw new Error("Open the desktop application to save keys in your system keyring, or configure an environment credential in advanced settings.");
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const finish = (error?: Error, result?: string) => {
      clearTimeout(timer);
      process.off("message", listener);
      process.off("disconnect", disconnected);
      error ? reject(error) : resolve(result!);
    };
    const listener = (message: unknown) => {
      const reply = message as { type?: string; id?: string; value?: string; error?: string };
      if (reply?.type !== "credential-protect-result" || reply.id !== id) return;
      if (typeof reply.error === "string") finish(new Error(reply.error));
      else if (typeof reply.value === "string") finish(undefined, reply.value);
      else finish(new Error("Invalid credential-store response."));
    };
    const disconnected = () => finish(new Error("The desktop credential store disconnected."));
    const timer = setTimeout(() => finish(new Error("Unlock your system keyring and try again.")), 30000);
    process.on("message", listener);
    process.once("disconnect", disconnected);
    process.send!({ type: "credential-protect", id, operation: decrypt ? "decrypt" : "encrypt", value }, (error) => {
      if (error) finish(new Error("The desktop credential store is unavailable."));
    });
  });
}

async function protect(value: string, decrypt = false): Promise<string> {
  if (decrypt && value.startsWith("electron-v1:")) return desktopProtect(value.slice(12), true);
  if (process.platform !== "win32") {
    if (decrypt) throw new Error("This credential belongs to another operating-system account. Configure the key again on this device.");
    return "electron-v1:" + await desktopProtect(value, false);
  }
  const setup =
    "[void][Reflection.Assembly]::LoadWithPartialName('System.Security'); $v=[Console]::In.ReadToEnd(); ";
  const script =
    setup +
    (decrypt
      ? "[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"
      : "[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; " + script,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Credential storage timed out."));
    }, 10000);
    child.stdout.on("data", (data) => chunks.push(data));
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Credential storage is unavailable."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(Buffer.concat(chunks).toString("utf8"))
        : reject(
            new Error(
              "The credential could not be opened by this Windows account.",
            ),
          );
    });
    child.stdin.end(value, "utf8");
  });
}
function readCredentialStore(target: string): Record<string, string> {
  if (!existsSync(target)) return {};
  const credentials: unknown = JSON.parse(readFileSync(target, "utf8"));
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    throw new Error("Credential store is invalid.");
  }
  for (const [reference, value] of Object.entries(credentials)) {
    if (!/^TEAMSWARM_KEY_[A-Z0-9_]{1,100}$/.test(reference) || typeof value !== "string") {
      throw new Error("Credential store is invalid.");
    }
  }
  return credentials as Record<string, string>;
}

export async function saveProductCredential(
  dataDir: string,
  reference: string,
  secret: string,
) {
  if (!/^TEAMSWARM_KEY_[A-Z0-9_]{1,100}$/.test(reference) || !secret || secret.length > 65536 || /[\r\n\0]/.test(secret)) {
    throw new Error("Invalid credential reference or value.");
  }
  const target = path.join(dataDir, "credentials.json");
  readCredentialStore(target);
  const encrypted = await protect(secret);
  // Read again after encryption so concurrent saves preserve completed writes.
  const current = readCredentialStore(target);
  mkdirSync(dataDir, { recursive: true });
  current[reference] = encrypted;
  const temporary = target + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(current), {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, target);
  process.env[reference] = secret;
}
export async function loadProductCredentials(dataDir: string) {
  const target = path.join(dataDir, "credentials.json");
  if (!existsSync(target)) return { loaded: [] as string[], unavailable: [] as string[] };
  const credentials = readCredentialStore(target);
  const opened: Record<string, string> = {};
  const unavailable: string[] = [];
  // Validate the whole store before changing the process environment. Preserve
  // encrypted records when their OS account/keyring cannot currently open them.
  for (const [reference, value] of Object.entries(credentials)) {
    if (process.env[reference]) continue;
    try { opened[reference] = await protect(value, true); }
    catch { unavailable.push(reference); }
  }
  Object.assign(process.env, opened);
  return { loaded: Object.keys(opened), unavailable };
}
