# Install TeamSwarm

[First project](getting-started.md) · [Platform support](platforms.md) · [中文](../zh-CN/installation.md)

Get packages and `SHA256SUMS.txt` from the same [GitHub release](https://github.com/DrPei12/teamswarm/releases). The package name contains the version, operating system and architecture. The application bundles Node.js and Codex; a separate Node installation is needed for source development and for installing additional npm-based harnesses on your device.

## Windows x64

Download `TeamSwarm-0.5.0-Windows-x64.exe`. Run the installer, choose an installation directory if needed, then open **TeamSwarm** from the Start menu. The default installation is per user.

The Windows installer is unsigned. Windows displays the publisher as unknown. Check the download source and checksum before choosing to run the file.

Verify the file in PowerShell:

```powershell
Get-FileHash .\TeamSwarm-0.5.0-Windows-x64.exe -Algorithm SHA256
```

Compare the result with the matching line in `SHA256SUMS.txt`.

## Other platforms

The Linux x64 and macOS Apple Silicon desktop targets can be built from source. See [Development](development.md) for dependencies and build commands. This release provides a Windows x64 installer.

## Upgrade and uninstall

Close TeamSwarm and back up its data before upgrading. Run the newer Windows installer and use the existing installation directory. Keep the same user account and data location to reopen existing teams.

Uninstalling the application leaves workspace data in its user data directory. Project files remain in the project folders you selected. Data locations and backup commands are in [Data and privacy](data-and-privacy.md).

## Run the web application from source

Install Node.js 24. From the repository root, run:

```sh
npm ci
npm run build
npm start
```

The launcher opens the browser with a local connection credential. The default port is 4317. Avoid running two services against the same data directory. Set `TEAM_DATA_DIR` to choose a separate workspace and `TEAM_API_PORT` to choose another port.
