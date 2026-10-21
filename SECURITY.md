# Security

## Report a vulnerability

Use this repository's **Security → Report a vulnerability** entry when it is available. Include the affected version, operating system, harness, reproduction steps and the impact you observed. If private reporting is unavailable, open an issue asking for a private contact channel without posting the vulnerability details.

Remove credentials, private source code, model transcripts and personal paths from attachments. A minimal test project and synthetic inputs are usually sufficient.

## Security model

TeamSwarm is a local, single-user application. Its API listens on loopback and requires the local control credential. The desktop renderer is sandboxed and accesses a narrowly scoped preload API. Native harnesses execute tools with the permissions configured for their work and with the privileges of the operating-system user running them.

Treat model-selected commands and project content according to the trust you place in the project. Read-only and workspace-write settings are harness capabilities; consult the harness documentation for its operating-system isolation guarantees.

Credentials saved by the Windows service use DPAPI. macOS and Linux desktop builds use Electron's system-backed credential encryption. Linux plaintext fallback storage is rejected. Environment references are available for the source web service. See [Data and privacy](docs/en/data-and-privacy.md).

## Updates

Security corrections are delivered in new releases. The currently maintained line is the latest stable release. Review its release notes and upgrade instructions before upgrading an existing workspace.
