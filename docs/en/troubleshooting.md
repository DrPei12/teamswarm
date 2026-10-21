# Troubleshooting

[Harnesses](harnesses.md) · [Data and recovery](data-and-privacy.md) · [中文](../zh-CN/troubleshooting.md)

| Symptom | What to check |
|---|---|
| Harness not installed | Install the selected tool from execution settings. For additional npm tools, confirm device Node/npm is available and its global prefix is outside the project. |
| Account or credential unavailable | Reconnect the selected harness account or configure the exact environment reference used by the resource. |
| Model or protocol incompatible | Select a model and API protocol supported by both the provider and the harness. Recheck the resource after changing it. |
| Provider reports insufficient balance or rate limit | Resolve the provider account limit, then resume or retry the affected work after its state is settled. |
| Workspace cannot start | Close duplicate instances, confirm port availability and inspect diagnostics. Preserve the data directory while investigating. |
| Windows desktop exits before showing a window | Install into the default application directory. For an unpacked build, try a shorter directory and include both paths in the bug report. |
| Task says recovery is required | Use recovery to reconcile the native attempt. Confirm that an earlier process has stopped before retrying conflicting work. |
| API key cannot be saved on Linux | Unlock GNOME Keyring/KWallet in a desktop session. The source service can use an environment reference instead. |
| Desktop says a browser service is using the workspace | Stop that browser/source service, then reopen the desktop app so saved keys can use the system keyring. |
| Saved key is unavailable after an account or device change | The app preserves the encrypted record and starts. Unlock the original keyring, configure an environment reference, or save the key again on this device. |
| AppImage cannot mount | Install the distribution's FUSE support or use the DEB package on a supported Debian/Ubuntu desktop. |
| Electron reports a sandbox error | Use the supported package and OS security configuration. Do not disable the sandbox for normal use; report the OS, package version and exact error. |
| Files missing after an upgrade | Confirm the same OS account, `TEAM_DATA_DIR` and project folder are in use. Restore a backup to a new directory if needed. |

For a bug report, provide the application version, operating system/architecture, harness/version, a small reproduction and the exact visible error. Export diagnostics with the commands in [Data and privacy](data-and-privacy.md), review the file and remove private information before attaching it.

For installation or runtime issues that only occur on one OS, include whether the application was opened from the desktop launcher or a terminal. Source users should include `node --version` and the command they ran.
