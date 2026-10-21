# Platform support

TeamSwarm 0.4.0 provides a Windows x64 desktop installer.

| Operating system and architecture | Desktop format | Availability |
|---|---|---|
| Windows x64 | NSIS `.exe` | GitHub Release |
| Linux x64 | AppImage, DEB | Source build |
| macOS Apple Silicon | DMG, ZIP | Source build |

The Windows installer uses per-user installation and preserves workspace data during upgrades and uninstallation. It is unsigned; Windows identifies the publisher as unknown. Compare its SHA-256 with the release checksum file before installation.

The application includes Electron, Node.js and Codex. Additional native adapters include Claude Code, Grok, Pi, DeepSeek Harness and OpenCode. Account and model configuration is described in [Harnesses](harnesses.md).

Source builds use Node.js 24 on the target operating system and architecture. Linux desktop credentials use a system keyring; macOS uses Keychain. See [Development](development.md) for packaging dependencies and commands.

Available desktop architectures are Windows x64, Linux x64 and macOS arm64. Source checks run on Windows in `ci.yml`; `desktop.yml` accepts a native build runner; `windows-installer.yml` tests installation and upgrade on Windows.
