# Data, credentials and recovery

[Troubleshooting](troubleshooting.md) · [中文](../zh-CN/data-and-privacy.md)

## Storage

TeamSwarm stores team records, messages, work, artifact versions and project history in its local service directory. Project work files live in the project directories you select.

| Platform | Default service data |
|---|---|
| Windows | `%LOCALAPPDATA%\TeamSwarm\data` |
| macOS | `~/Library/Application Support/TeamSwarm/data` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/TeamSwarm/data` |

`TEAM_DATA_DIR` overrides the service directory. Desktop window state and pending inputs use Electron's `TeamSwarm` user-data directory; on Windows this is `%APPDATA%\TeamSwarm`. Back up those files separately if you need pending, unsubmitted input.

## Model requests

The selected harness sends prompts and relevant project content to its configured provider. Native harnesses also maintain their own session records and account state. Review the provider and harness settings for their retention and data-use policies. TeamSwarm does not operate a model gateway.

The local API listens on `127.0.0.1` and uses a local control credential. Keep its `control.json`, databases and native session records private. Diagnostic export omits conversation bodies and credential values.

## Credentials

Windows credentials saved through the application use DPAPI for the current OS account. macOS desktop builds use Keychain-backed encryption; Linux desktop builds use the available supported system keyring. A Linux plaintext backend is rejected. Unlock the keyring to save or read a key.

For the source web service on macOS/Linux, use environment-variable credentials or startup secret-file references. Config exports carry references rather than secret values. When moving to a different OS account or device, reconnect accounts and enter the required keys there.

## Backup and restore

Close TeamSwarm before backing up or restoring service data. From a source checkout, use:

```sh
node scripts/data-tools.mjs diagnostics --data-dir /absolute/data-directory --output /absolute/diagnostics.json
node scripts/data-tools.mjs backup --data-dir /absolute/data-directory --output /absolute/new-backup-directory
node scripts/data-tools.mjs restore --backup /absolute/backup-directory --data-dir /absolute/new-data-directory
```

Replace the example paths with your paths; quote paths containing spaces. Backups include the service database, attachments and service-owned configuration/session files. Back up project directories and desktop pending input separately. Restore into a new directory, then set `TEAM_DATA_DIR` to it before opening the application.

Installed packages contain `TeamSwarm-Tools.cmd` on Windows and `TeamSwarm-Tools.sh` on macOS/Linux under `resources/product` (under `Contents/Resources/product` inside the Mac app). They accept the same arguments after the command name.

Store backups in a private location. They contain your project records and may include native account/session material. Uninstalling the app preserves user data; remove it deliberately only when you no longer need it.
