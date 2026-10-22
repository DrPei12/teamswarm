# Development and packaging

[Architecture](architecture.md) · [Release process](releasing.md) · [中文](../zh-CN/development.md)

Use Node.js 24 and the committed npm lockfile. Windows installer verification also requires Python 3. Linux packaging requires the Electron desktop libraries, `tar` and standard build tools. Build macOS arm64 packages on an Apple Silicon Mac.

On Windows, use a short checkout path such as `C:\src\teamswarm` for native desktop builds. The pinned electron-builder version uses `scripts/run-electron-builder.cjs` to preserve Windows system paths when generating its NSIS uninstaller; review that adapter when upgrading the build dependency.

The build proxy uses `roarr 3.0.0` with string-only formatting for fixed messages and structured context. The scoped npm override keeps `sprintf-js` out of the build dependency tree.

```sh
npm ci
npm run check
npm run build
npm run test:smoke
npm start
```

`npm run check` runs documentation validation, type checking, server tests, offline audit tests, platform/credential tests, frontend formatting and frontend compilation. These tests use deterministic local fixtures and do not call a paid model provider.

After building, run `node test/browser/offline-drafts.mjs` to check that separate browser tabs retain unsent drafts through a disconnect, reopen, and delayed server responses. This uses an isolated local database and no models. Install Playwright Chromium first, or set `PLAYWRIGHT_EXECUTABLE_PATH` to a system browser.

For development, run `npm run dev`. It starts the API on port 4318 and Vite on 4317. Use a dedicated `TEAM_DATA_DIR` for experiments so that you keep your normal workspace separate.

## Desktop packages

On the target operating system and architecture:

```sh
npm run desktop:build
```

Use `npm run desktop:unpacked` to produce an unpacked desktop build. Packaging stages a pinned Node runtime, Codex, service dependencies and licenses, verifies their file inventory, then generates the platform package. Outputs use a fixed platform directory: `release/win32-x64`, `release/linux-x64` or `release/darwin-arm64`. Both desktop commands replace that platform directory on the next build. The manifest records the version, source commit and content hash.

`config/desktop-runtime.json` pins official Node archives and SHA-256 values. `config/harnesses.json` pins tested integration versions. Update the matching license notices when changing bundled software.

The source and compiled-output manifests detect changes during a build. Rebuild after editing a source, configuration or documentation file. A source archive without Git metadata is identified as `source-archive`; its content hash still binds the build.

## Test a package

Inspect `release-manifest.json`, `SHA256SUMS.txt` and the package verification result. Start the packaged application on a clean workspace, create a team, configure a supported harness, complete the getting-started task, continue it, close and reopen, and download both artifact versions.

Test installation, upgrade with preserved data, normal exit and recovery separately. Use [Data and privacy](data-and-privacy.md) for backup commands. Use a clean Windows environment for installer tests.

## Add or change a harness

Start with the interfaces in `apps/server/src/runtime/types.ts` and the adapters under `runtime/harness/`. Preserve session identity, native observations, permission boundaries and uncertain-stop behavior. Add protocol fixtures and real-process tests for the changed contract. Record live provider validation separately with the exact harness/model/version combination.
