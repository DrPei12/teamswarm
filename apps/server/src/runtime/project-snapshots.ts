import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
  chmodSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { conflict } from "../errors.js";

const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const excluded = new Set([
  ".git",
  "node_modules",
  ".local",
  ".codex-local",
  ".local-workspaces",
  ".claude",
  ".codex",
  ".pi",
  ".opencode",
  ".dsh",
  "dist",
  "__pycache__",
]);
const secretFile = (name: string) =>
  (/^\.env(?:\.|$)/i.test(name) && name !== ".env.example") ||
  /^(auth|credentials|secrets)\.(json|ya?ml|toml)$/i.test(name) ||
  /\.(pem|key|p12|pfx)$/i.test(name);
type Manifest = {
  files: { path: string; hash: string; bytes: number; mode: number }[];
  excludedPaths: string[];
};

/** Content-addressed local checkpoints. Never reset or overwrite the source workspace. */
export class ProjectSnapshots {
  readonly root: string;
  constructor(dataDir: string) {
    this.root = path.join(dataDir, "project-history");
    mkdirSync(path.join(this.root, "objects"), { recursive: true });
    mkdirSync(path.join(this.root, "manifests"), { recursive: true });
  }
  private objectPath(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw conflict("invalid_snapshot", "Invalid checkpoint identity.");
    return path.join(this.root, "objects", hash);
  }
  private persist(target: string, bytes: Buffer | string) {
    if (existsSync(target)) {
      if (digest(readFileSync(target)) !== digest(bytes))
        throw conflict(
          "snapshot_corrupt",
          "Existing checkpoint storage failed verification; no new checkpoint was published.",
        );
      return;
    }
    const temporary = target + ".pending-" + randomUUID();
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
  }
  capture(workspace: string): string {
    const root = realpathSync(workspace);
    const collect = (): Manifest => {
      const manifest: Manifest = { files: [], excludedPaths: [] };
      // Git's own inventory preserves tracked files even when an ignore rule
      // matches them, and respects nested ignore rules for untracked build data.
      const git = existsSync(path.join(root, ".git"))
        ? spawnSync(
            "git",
            [
              "ls-files",
              "--cached",
              "--others",
              "--exclude-standard",
              "-z",
              "--",
              ".",
            ],
            {
              cwd: root,
              windowsHide: true,
              encoding: "utf8",
              maxBuffer: 16 * 1024 * 1024,
            },
          )
        : undefined;
      let included: Set<string> | undefined;
      let directories: Set<string> | undefined;
      if (git?.status === 0) {
        included = new Set(git.stdout.split("\0").filter(Boolean));
        directories = new Set<string>();
        for (const file of included) {
          const parts = file.split("/");
          for (let i = 1; i < parts.length; i++)
            directories.add(parts.slice(0, i).join("/"));
        }
      } else if (
        git?.error &&
        (git.error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw conflict(
          "checkpoint_inventory",
          "Git could not enumerate the project; no checkpoint was published.",
        );
      } else if (git && !git.error) {
        throw conflict(
          "checkpoint_inventory",
          "Git could not enumerate the project; no checkpoint was published.",
        );
      }
      let total = 0;
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
          (a, b) => a.name.localeCompare(b.name),
        )) {
          const absolute = path.join(dir, entry.name);
          const relative = path
            .relative(root, absolute)
            .split(path.sep)
            .join("/");
          if (
            excluded.has(entry.name.toLowerCase()) ||
            secretFile(entry.name) ||
            (included &&
              !(entry.isDirectory()
                ? directories!.has(relative)
                : included.has(relative)))
          ) {
            manifest.excludedPaths.push(relative);
            continue;
          }
          const stat = lstatSync(absolute);
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
            throw conflict(
              "unsupported_checkpoint_entry",
              `Checkpoint cannot safely capture ${relative}.`,
            );
          if (stat.isDirectory()) {
            walk(absolute);
            continue;
          }
          if (
            manifest.files.length >= 2000 ||
            stat.size > 8 * 1024 * 1024 ||
            total + stat.size > 64 * 1024 * 1024
          )
            throw conflict(
              "checkpoint_capacity",
              "Checkpoint exceeds 2,000 files, 8 MiB per file or 64 MiB total. No partial checkpoint is published.",
            );
          const bytes = readFileSync(absolute);
          const after = lstatSync(absolute);
          if (
            bytes.length !== stat.size ||
            !after.isFile() ||
            after.ino !== stat.ino ||
            after.mtimeMs !== stat.mtimeMs ||
            realpathSync(absolute) !== absolute
          )
            throw conflict(
              "workspace_changed",
              "Workspace changed while capturing its checkpoint.",
            );
          const hash = digest(bytes);
          const target = this.objectPath(hash);
          this.persist(target, bytes);
          manifest.files.push({
            path: relative,
            hash,
            bytes: bytes.length,
            mode: stat.mode & 0o777,
          });
          total += bytes.length;
        }
      };
      walk(root);
      return manifest;
    };
    const manifest = collect();
    const raw = JSON.stringify(manifest);
    // Recheck inventory as well as bytes; callers hold off all managed writable attempts.
    if (JSON.stringify(collect()) !== raw)
      throw conflict(
        "workspace_changed",
        "Workspace changed while capturing its checkpoint.",
      );
    const id = digest(raw);
    const target = path.join(this.root, "manifests", id + ".json");
    this.persist(target, raw);
    return id;
  }
  manifest(id: string): Manifest {
    this.objectPath(id);
    const raw = readFileSync(path.join(this.root, "manifests", id + ".json"));
    if (digest(raw) !== id)
      throw conflict(
        "snapshot_corrupt",
        "Checkpoint manifest no longer matches its identity.",
      );
    return JSON.parse(raw.toString());
  }
  restore(id: string, destination: string): void {
    const parent = path.dirname(path.resolve(destination));
    mkdirSync(parent, { recursive: true });
    if (realpathSync(parent) !== parent)
      throw conflict(
        "unsafe_workspace",
        "Managed branch storage cannot use symbolic links or junctions.",
      );
    if (existsSync(destination))
      throw conflict(
        "workspace_exists",
        "A branch requires a new workspace; existing files are never overwritten.",
      );
    const manifest = this.manifest(id);
    // Private staging is never executed. A failed restore can leave a staging directory for diagnosis.
    const staging = destination + ".pending-" + randomUUID();
    mkdirSync(staging, { recursive: true });
    for (const file of manifest.files) {
      if (
        path.isAbsolute(file.path) ||
        file.path.split(/[\\/]/).some((p) => p === ".." || p === ".") ||
        file.path.includes(":")
      )
        throw conflict(
          "snapshot_corrupt",
          "Checkpoint contains an invalid file path.",
        );
      const bytes = readFileSync(this.objectPath(file.hash));
      if (digest(bytes) !== file.hash || bytes.length !== file.bytes)
        throw conflict(
          "snapshot_corrupt",
          "Checkpoint content no longer matches its identity.",
        );
      const target = path.join(staging, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: "wx", mode: file.mode });
      if (process.platform !== "win32") chmodSync(target, file.mode);
    }
    renameSync(staging, destination);
  }
}
