const targets = {
  "win32-x64": { platform: "win32", arch: "x64", builder: "win", label: "Windows", node: "node.exe", codex: "codex.exe", codexPackage: "codex-win32-x64", triple: "x86_64-pc-windows-msvc" },
  "darwin-arm64": { platform: "darwin", arch: "arm64", builder: "mac", label: "macOS", node: "node", codex: "codex", codexPackage: "codex-darwin-arm64", triple: "aarch64-apple-darwin" },
  "linux-x64": { platform: "linux", arch: "x64", builder: "linux", label: "Linux", node: "node", codex: "codex", codexPackage: "codex-linux-x64", triple: "x86_64-unknown-linux-musl" },
};
export function desktopTarget(platform = process.env.TEAMSWARM_TARGET_PLATFORM || process.platform, arch = process.env.TEAMSWARM_TARGET_ARCH || process.arch) {
  const key = `${platform}-${arch}`;
  if (!targets[key]) throw new Error(`Unsupported desktop target: ${key}. Supported: ${Object.keys(targets).join(", ")}`);
  return { key, ...targets[key] };
}
