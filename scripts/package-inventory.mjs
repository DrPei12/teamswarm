import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, realpathSync, copyFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { digest, filesUnder } from "./release-identity.mjs";

export function copyPackageInput(source, destination, boundary = realpathSync(source)) {
  if ([".gitkeep", ".DS_Store"].includes(path.basename(source))) return;
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    const resolved = realpathSync(source);
    const relative = path.relative(boundary, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Build input link escapes its package.");
    return copyPackageInput(resolved, destination, boundary);
  }
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) copyPackageInput(path.join(source, entry), path.join(destination, entry), boundary);
  } else {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (process.platform !== "win32") chmodSync(destination, stat.mode & 0o777);
  }
}

export function packageInventory(product, frontendRoot) {
  const packages = [];
  const scan = (root, base, scope) => {
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      const file = path.join(root, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) scan(file, base, scope);
      else if (name === "package.json") {
        const item = JSON.parse(readFileSync(file, "utf8"));
        if (!item.name || !item.version) continue;
        const directory = path.dirname(file);
        const licenses = readdirSync(directory).filter((n) => /^(license|licence|copying|notice)(?:[.-]|$)/i.test(n) && lstatSync(path.join(directory, n)).isFile());
        const location = path.relative(base, directory).replaceAll("\\", "/");
        packages.push({ name: item.name, version: item.version, license: item.license ?? null, scope, location, licenses });
        if (scope === "frontend") {
          const target = path.join(product, "licenses", "frontend-dependencies", item.name.replaceAll("/", "__"));
          mkdirSync(target, { recursive: true });
          for (const license of licenses) writeFileSync(path.join(target, license), readFileSync(path.join(directory, license)));
        }
      }
    }
  };
  scan(path.join(product, "node_modules"), product, "service");
  scan(path.join(product, "runtime/node_modules"), product, "bundled-tools");
  // Follow the Vite bundle's actual dependency closure, including transitive React packages.
  const modules = JSON.parse(readFileSync(path.join(frontendRoot, ".codex-local/frontend-modules.json"), "utf8"));
  const seen = new Set();
  for (const filename of modules) {
    let directory = path.dirname(filename.split("?")[0]);
    while (directory !== path.dirname(directory)) {
      const manifest = path.join(directory, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name && pkg.version && !seen.has(directory)) {
          seen.add(directory);
          const licenses = readdirSync(directory).filter((n) => /^(license|licence|copying|notice)(?:[.-]|$)/i.test(n) && lstatSync(path.join(directory, n)).isFile());
          packages.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? null, scope: "frontend", location: path.relative(frontendRoot, directory).replaceAll("\\", "/"), licenses });
          const target = path.join(product, "licenses/frontend-dependencies", pkg.name.replaceAll("/", "__"));
          mkdirSync(target, { recursive: true });
          for (const license of licenses) writeFileSync(path.join(target, license), readFileSync(path.join(directory, license)));
        }
        if (pkg.name && pkg.version) break;
      }
      directory = path.dirname(directory);
    }
  }
  const supplemental = JSON.parse(readFileSync(path.join(product, "licenses/dependency-notices/manifest.json"), "utf8"));
  for (const pkg of packages) {
    const directory = pkg.scope === "frontend"
      ? `licenses/frontend-dependencies/${pkg.name.replaceAll("/", "__")}`
      : pkg.location;
    pkg.licenseFiles = pkg.licenses.map((name) => path.posix.join(directory, name));
    if (!pkg.licenseFiles.length) {
      const notice = supplemental[`${pkg.name}@${pkg.version}`];
      if (!notice || notice.license !== pkg.license)
        throw new Error(`Missing license evidence for ${pkg.name}@${pkg.version}`);
      if (digest(readFileSync(path.join(product, notice.file))) !== notice.sha256)
        throw new Error(`License notice changed: ${notice.file}`);
      pkg.licenseFiles = [notice.file];
      pkg.licenseEvidence = notice;
    }
    for (const file of pkg.licenseFiles)
      if (!existsSync(path.join(product, file))) throw new Error(`Missing license file: ${file}`);
  }
  const nativeTools = JSON.parse(readFileSync(path.join(product, "config/harnesses.json"), "utf8"));
  const files = filesUnder(product, ["apps", "teamswarm", "scripts", "config", "runtime", "node_modules", "licenses", "package.json", "package-lock.json", "runtime-manifest.json", "build-identity.json", "TeamSwarm-Tools.cmd", "Install-Harnesses.cmd", "docs", "LICENSE", "NOTICE", "TeamSwarm-Tools.sh", "Install-Harnesses.sh"]);
  return { schemaVersion: 1, packages: packages.sort((a, b) => (a.scope + a.name + a.location).localeCompare(b.scope + b.name + b.location)),
    nativeTools: Object.fromEntries(Object.entries(nativeTools).map(([name, spec]) => [name, { ...spec, distribution: name === "codex" ? "bundled" : "installed separately by user" }])),
    files, contentSha256: digest(JSON.stringify(files)) };
}
