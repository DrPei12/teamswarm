# Third-party software and assets

TeamSwarm's own code is licensed under Apache-2.0. The following software and assets retain their original licenses.

| Component | Use | License and notice |
|---|---|---|
| [open-claude-ui](https://github.com/Caho1/open-claude-ui/tree/c1f923ae0051a871941b98a0e2e3183a545e6a85) | Adapted design tokens, layout and interaction patterns in `teamswarm/src/design-system/` | [MIT notice](https://github.com/DrPei12/teamswarm/blob/main/teamswarm/licenses/open-claude-ui-MIT.txt) |
| Inter Variable | Bundled application font | [SIL Open Font License 1.1](https://github.com/DrPei12/teamswarm/blob/main/teamswarm/public/fonts/LICENSE.txt) |
| Noto Sans SC and Source Serif 4 (Fontsource variable packages) | Bundled Chinese interface and reply fonts, and Latin reply font | SIL Open Font License 1.1; license files included in the desktop frontend dependency inventory |
| React, Radix UI, Lucide, React Flow, Motion and Markdown packages | Application interface | Their package license files are included in desktop package inventories |
| CodeMirror 6 | Code and text editing | MIT; included in desktop dependency inventory |
| office-kit DOCX, XLSX, PPTX and PPTX preview | Office parsing, editing and slide rendering | MIT; included in desktop dependency inventory |
| docx-preview and PDF.js | Word and PDF page rendering | Apache-2.0; included in desktop dependency inventory |
| DOMPurify, fflate and idb-keyval | Document sanitization, ZIP limits and drafts | Apache-2.0 or MPL-2.0, MIT, and Apache-2.0 respectively; included in desktop dependency inventory |
| Node.js | Bundled service runtime | [Node.js notice](https://github.com/DrPei12/teamswarm/blob/main/apps/desktop/licenses/node-LICENSE.txt) |
| Codex CLI | Bundled native harness | [Apache-2.0 notice](https://github.com/DrPei12/teamswarm/blob/main/apps/desktop/licenses/codex-LICENSE.txt) |
| Electron | Desktop shell | Electron and Chromium licenses ship with the desktop runtime |
| npm and service dependencies | Native tool support and local API | License files ship with the installed packages |
| [Pi AI](https://github.com/earendil-works/pi) (`@earendil-works/pi-ai` 1.3.0) | Model protocol clients and stream parsing; the selected Harness owns execution | MIT; license included with the installed package |
| [jose](https://github.com/panva/jose) 6.1.3 | ChatGPT identity-token signature and claim verification | MIT; license included with the installed package |

Every desktop package includes `resources/product/package-inventory.json` (inside `Contents/Resources` on macOS), recording bundled dependency versions and their license files. Supplemental notices for packages that omit a license file are in [apps/desktop/licenses/dependency-notices](https://github.com/DrPei12/teamswarm/tree/main/apps/desktop/licenses/dependency-notices).

Claude Code, Grok, Pi, DeepSeek Harness and OpenCode are separately installed tools. Their own licenses, service terms and authentication requirements apply. They are not bundled into TeamSwarm.

The approved TeamSwarm marks in `teamswarm/branding/` are project artwork. Builds bundle Inter, Noto Sans SC and Source Serif 4 under the SIL Open Font License. Fonts load from local application assets; no external font service or separately installed font is required. Third-party product names identify compatible software and services.

## Modified npm runtime

The bundled `npm-11.21.1-teamswarm.3.tgz` is based on npm 11.21.1.
It includes unmodified upstream releases of ip-address 10.7.4, undici 6.29.1,
glob 14.0.2, minimatch 11.0.1, path-scurry 3.0.0 and
`@isaacs/nonrecursive-glob-match` 1.0.1. Bundled package manifests reference
the updated glob and minimatch versions. The npm version in `package.json`
and `TEAMSWARM-NOTICE.md` identify this modified distribution; other
upstream file bytes and modes are retained.

The Apache-2.0 adapters in `vendor/glob-compat` and `vendor/minimatch-compat`
provide the callback and callable exports used by older build dependencies.
They delegate matching and filesystem traversal to the unmodified upstream
glob and minimatch releases listed above, whose ISC licenses remain with
their installed packages.

The npm source and these modifications are distributed under Artistic-2.0.
Dependencies retain their own licenses, included in the archive and desktop
package inventory. Official source URLs and SHA-512 integrity values are in
[vendor/npm-runtime.json](https://github.com/DrPei12/teamswarm/blob/main/vendor/npm-runtime.json).
The archive can be reproduced with `python -B scripts/rebuild-npm-runtime.py`
or verified without replacement using the same command with `--check`.
