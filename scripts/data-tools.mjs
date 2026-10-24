import { backup, DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { digest, filesUnder } from "./release-identity.mjs";
import { dataDirectory } from "./platform.cjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--data-dir", "--output", "--backup"].includes(args[i]) || !args[i + 1]) throw new Error("Use diagnostics --output FILE | backup --output NEW_FOLDER | restore --backup FOLDER --data-dir NEW_FOLDER.");
  options[args[i].slice(2)] = path.resolve(args[i + 1]);
}
const directory = options["data-dir"] ?? dataDirectory();
const within = (a, b) => { const relative = path.relative(a.toLowerCase(), b.toLowerCase()); return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); };
const transient = new Set(["runtime.lock", "connection.json", "control.json", "team.sqlite", "team.sqlite-wal", "team.sqlite-shm"]);
function copyTree(source, destination) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error("Data contains a filesystem link. Inspect it before creating a portable backup.");
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const child of readdirSync(source)) copyTree(path.join(source, child), path.join(destination, child));
  } else if (stat.isFile()) copyFileSync(source, destination, 1);
  else throw new Error("Data contains an unsupported filesystem entry.");
}
function createDestination(destination) {
  if (!destination) throw new Error("Choose a new output path.");
  mkdirSync(destination);
}
function version() { return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version; }
try {
  if (command === "diagnostics") {
    if (!options.output) throw new Error("Specify --output FILE.");
    const result = { schemaVersion: 1, version: version(), node: process.version, platform: process.platform, architecture: process.arch,
      databasePresent: existsSync(path.join(directory, "team.sqlite")), runtimeLockPresent: existsSync(path.join(directory, "runtime.lock")), counts: {}, workStates: [] };
    if (result.databasePresent) {
      const db = new DatabaseSync(path.join(directory, "team.sqlite"), { readOnly: true });
      try {
        for (const table of ["teams", "conversations", "messages", "runtime_works", "runtime_attempts", "runtime_events"])
          if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) result.counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
        if (result.counts.runtime_works !== undefined) result.workStates = db.prepare("SELECT json_extract(data,'$.status') AS status, COUNT(*) AS count FROM runtime_works GROUP BY status").all();
        result.integrity = db.prepare("PRAGMA quick_check").get().quick_check === "ok" ? "ok" : "needs_attention";
      } finally { db.close(); }
    }
    const build = path.join(root, "build-identity.json");
    if (existsSync(build)) { const identity = JSON.parse(readFileSync(build, "utf8")); result.build = { commit: identity.commit, sourceSha256: identity.sourceSha256 }; }
    writeFileSync(options.output, JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
    console.log("Diagnostic summary saved. It contains version, counts and states; no messages, paths, tokens or credentials.");
  } else if (command === "backup") {
    const source = realpathSync(directory), destination = options.output;
    if (!destination || within(source, destination) || within(destination, source)) throw new Error("Choose a new backup folder outside the data directory.");
    const lock = path.join(source, "runtime.lock"), id = randomUUID();
    let fd;
    try { fd = openSync(lock, "wx", 0o600); }
    catch { throw new Error("Close TeamSwarm and its service before backup. If a previous service stopped unexpectedly, reopen and close it normally first."); }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, id })); closeSync(fd); fd = undefined;
      createDestination(destination);
      const target = path.join(destination, "data"); mkdirSync(target);
      for (const item of readdirSync(source)) if (!transient.has(item) && !item.startsWith("runtime.lock.stale-")) copyTree(path.join(source, item), path.join(target, item));
      const db = new DatabaseSync(path.join(source, "team.sqlite"), { readOnly: true });
      try { await backup(db, path.join(target, "team.sqlite")); } finally { db.close(); }
      const files = filesUnder(destination, ["data"]);
      writeFileSync(path.join(destination, "backup.json"), JSON.stringify({ schemaVersion: 1, version: version(), createdAt: new Date().toISOString(), files, sha256: digest(JSON.stringify(files)), scope: "Local service data and attachments. External project folders and desktop pending-input state are separate. Encrypted credentials remain bound to their original OS account." }, null, 2), { flag: "wx" });
      console.log(`Backup verified: ${Object.keys(files).length} files.`);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (JSON.parse(readFileSync(lock, "utf8")).id === id) unlinkSync(lock);
    }
  } else if (command === "restore") {
    if (!options.backup || !options["data-dir"]) throw new Error("Specify --backup FOLDER and --data-dir NEW_FOLDER.");
    const source = realpathSync(options.backup);
    if (within(source, directory) || within(directory, source)) throw new Error("Restore into a new folder outside the backup.");
    const manifest = JSON.parse(readFileSync(path.join(source, "backup.json"), "utf8"));
    const observed = filesUnder(source, ["data"]);
    if (manifest.schemaVersion !== 1 || JSON.stringify(observed) !== JSON.stringify(manifest.files) || digest(JSON.stringify(observed)) !== manifest.sha256) throw new Error("Backup contents do not match the saved manifest.");
    createDestination(directory);
    for (const item of readdirSync(path.join(source, "data"))) copyTree(path.join(source, "data", item), path.join(directory, item));
    console.log("Restored into a new data folder. Set TEAM_DATA_DIR to this folder before opening TeamSwarm. Project paths retain their original locations.");
  } else throw new Error("Use diagnostics, backup or restore. See README.md#data-and-recovery for exact commands and data scope.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
