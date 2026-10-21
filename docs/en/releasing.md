# Preparing a release

1. Choose the version and synchronize all workspace manifests, the service lockfile and the current user documentation.
2. Run `npm ci`, `npm run check`, `npm run release:check`, `npm run build` and `npm run test:smoke` from a fresh checkout.
3. Build on each operating system included in the release using `npm run desktop:build`. Keep the generated source identity, package inventories, installer verification, manifest and checksums.
4. Complete first-use, real-task, continuation, exit/restart and data-preserving upgrade checks on the target operating system. Record the actual environment and model/harness combination.
5. Review the source tree, all Git refs being published, screenshots, examples and release assets for credentials, private data and third-party license requirements.
6. Review the dependency and runtime security advisories at the release freeze. Rebuild after any dependency update.
7. Review the exact source commit and binaries before uploading. Publish binaries as release assets with `SHA256SUMS.txt`; keep source commits free of generated packages.

## CI

`ci.yml` checks pushes and pull requests on Windows. `desktop.yml` builds packages on a selected native runner. `windows-installer.yml` tests clean installation, application startup, upgrade with preserved data, and uninstallation. Set `previous_tag` to the installed version to upgrade from. Leave `candidate_tag` empty to build the current checkout and produce the verified `windows-installer-package` artifact, or set it to an existing release tag to test that installer. Workflows use read-only repository permissions.

## macOS signing

macOS source builds produce unsigned DMG and ZIP packages. Before general distribution, configure a Developer ID identity, enable the hardened runtime, sign every bundled executable with appropriate entitlements, notarize the final app/disk image and staple its ticket. Verify the signed payload, installation and Keychain behavior on another Mac. Keep signing credentials in the CI secret store and repeat artifact checks after signing.

Official references: [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), [Apple Developer ID](https://developer.apple.com/developer-id/), [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

## Release notes

State the user-visible changes, available platform/architecture packages, signing status, tested environments, known issues, upgrade/data instructions and fixed source version. Include a direct link to the first-project tutorial.
