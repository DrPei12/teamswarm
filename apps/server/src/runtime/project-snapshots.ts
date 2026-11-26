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
import { commitPreparedDirectory } from "./prepared-directory.js";
import { spawnSync } from "node:child_process";
import { conflict } from "../errors.js";
import type { ArtifactVersion, ProjectNode } from "./types.js";
import { sameWorkspace, WorkspaceAccess, workspaceIdentity } from "./workspace-access.js";

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
export type CapturedWorkspace = { id: string; source: NonNullable<ProjectNode["workspaceSnapshotSource"]> };

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
  /** Preserve just one edited file; no project inventory or extra working copy. */
  preserveFile(bytes: Buffer): string {
    const hash = digest(bytes);
    this.persist(this.objectPath(hash), bytes);
    return hash;
  }
  inspectWorkspace(workspace: string, preserveFiles = false) {
    const identity = workspaceIdentity(workspace);
    const root = identity.path;
    const collect = (preserve: boolean) => {
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
          if (preserve) this.persist(this.objectPath(hash), bytes);
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
      return { manifest, inventory: included ? "git" as const : "filesystem" as const };
    };
    const result = collect(preserveFiles);
    // Recheck inventory as well as bytes; callers hold off all managed writable attempts.
    if (JSON.stringify(collect(false)) !== JSON.stringify(result) || !sameWorkspace(identity, workspaceIdentity(workspace)))
      throw conflict(
        "workspace_changed",
        "Workspace changed while capturing its checkpoint.",
      );
    return { manifest: result.manifest, source: { identity, inventory: result.inventory } };
  }
  captureWithProvenance(workspace: string): CapturedWorkspace {
    const { manifest, source } = this.inspectWorkspace(workspace, true);
    const raw = JSON.stringify(manifest);
    const id = digest(raw);
    const target = path.join(this.root, "manifests", id + ".json");
    this.persist(target, raw);
    return { id, source };
  }
  capture(workspace: string): string {
    return this.captureWithProvenance(workspace).id;
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
  fileHash(snapshotId: string, relative: string): string | null {
    return this.manifest(snapshotId).files.find(file => WorkspaceAccess.overlaps(file.path, relative))?.hash ?? null;
  }
  readObject(hash: string): Buffer {
    const bytes = readFileSync(this.objectPath(hash));
    if (digest(bytes) !== hash)
      throw conflict("snapshot_corrupt", "Checkpoint content no longer matches its identity.");
    return bytes;
  }
  candidate(baseId: string, submitted: ArtifactVersion[], workspace: string): string {
    const base = this.manifest(baseId);
    const actual = this.manifest(this.capture(workspace));
    const identity = (relative: string) => process.platform === "win32" ? relative.toLowerCase() : relative;
    const expected = new Map(base.files.map(file => [identity(file.path), file]));
    for (const artifact of submitted) {
      if (artifact.path === "@result") continue;
      const relative = WorkspaceAccess.relative(artifact.path, false);
      const key = identity(relative);
      const bytes = Buffer.from(artifact.content, "utf8");
      if (digest(bytes) !== artifact.sha256 || bytes.length !== artifact.bytes)
        throw conflict("artifact_corrupt", `Artifact content failed verification: ${relative}`);
      const mode = expected.get(key)?.mode ?? (process.platform === "win32" ? 0o666 : 0o600);
      expected.set(key, { path: relative, hash: artifact.sha256, bytes: artifact.bytes, mode });
    }
    const seen = new Set<string>();
    const drift: string[] = [];
    for (const file of actual.files) {
      const key = identity(file.path);
      const selected = expected.get(key);
      if (seen.has(key) || selected?.hash !== file.hash || (selected.mode & 0o111) !== (file.mode & 0o111)) drift.push(file.path);
      seen.add(key);
    }
    for (const [key, file] of expected) if (!seen.has(key)) drift.push(file.path);
    if (drift.length) throw conflict("candidate_drift", `The working copy differs from the submitted files: ${drift.slice(0, 12).join(", ")}. Submit the changed files or remove unrelated changes before verification.`);
    const files = [...expected.values()].sort((a, b) => a.path.localeCompare(b.path));
    const raw = JSON.stringify({ files, excludedPaths: base.excludedPaths });
    const id = digest(raw);
    this.persist(path.join(this.root, "manifests", id + ".json"), raw);
    return id;
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
    const staging = path.join(parent, ".teamswarm-restore-" + randomUUID());
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
      const bytes = this.readObject(file.hash);
      if (bytes.length !== file.bytes)
        throw conflict(
          "snapshot_corrupt",
          "Checkpoint content no longer matches its identity.",
        );
      const target = path.join(staging, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: "wx", mode: file.mode });
      if (process.platform !== "win32") chmodSync(target, file.mode);
    }
    commitPreparedDirectory(staging, destination);
  }
}
