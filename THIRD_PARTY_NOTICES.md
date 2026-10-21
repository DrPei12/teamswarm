# Third-party software and assets

TeamSwarm's own code is licensed under Apache-2.0. The following software and assets retain their original licenses.

| Component | Use | License and notice |
|---|---|---|
| [open-claude-ui](https://github.com/Caho1/open-claude-ui/tree/f4947c62a459f6413ed44b289a8d495962add1a2) | Adapted design tokens, layout and interaction patterns in `teamswarm/src/design-system/` | [MIT notice](teamswarm/licenses/open-claude-ui-MIT.txt) |
| Inter Variable | Application font | [SIL Open Font License 1.1](teamswarm/public/fonts/LICENSE.txt) |
| React, Radix UI, Lucide, React Flow, Motion and Markdown packages | Application interface | Their package license files are included in desktop package inventories |
| Node.js | Bundled service runtime | [Node.js notice](apps/desktop/licenses/node-LICENSE.txt) |
| Codex CLI | Bundled native harness | [Apache-2.0 notice](apps/desktop/licenses/codex-LICENSE.txt) |
| Electron | Desktop shell | Electron and Chromium licenses ship with the desktop runtime |
| npm and service dependencies | Native tool support and local API | License files ship with the installed packages |

Every desktop package includes `resources/product/package-inventory.json` (inside `Contents/Resources` on macOS), recording bundled dependency versions and their license files. Supplemental notices for packages that omit a license file are in [apps/desktop/licenses/dependency-notices](apps/desktop/licenses/dependency-notices).

Claude Code, Grok, Pi, DeepSeek Harness and OpenCode are separately installed tools. Their own licenses, service terms and authentication requirements apply. They are not bundled into TeamSwarm.

The TeamSwarm mark in `teamswarm/public/favicon.svg` is project artwork. Third-party product names identify compatible software and services.
