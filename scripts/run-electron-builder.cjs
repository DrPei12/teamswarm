// electron-builder 26.15.3 replaces the Windows environment when NSIS creates
// its uninstaller. Preserve system paths while keeping credentials out of that
// helper process. This adapter is scoped to the pinned build dependency.
if (process.platform === "win32") {
  const { version } = require("app-builder-lib/package.json");
  if (version !== "26.15.3") {
    throw new Error("Review the Windows NSIS environment adapter before updating electron-builder.");
  }
  const { stripSensitiveEnvVars } = require("builder-util");
  const { WineVmManager } = require("app-builder-lib/out/vm/WineVm");
  const execWine = WineVmManager.prototype.execWine;
  WineVmManager.prototype.execWine = function (request) {
    const options = request.options || {};
    return execWine.call(this, {
      ...request,
      options: {
        ...options,
        env: { ...stripSensitiveEnvVars(process.env), ...options.env },
      },
    });
  };
}

require("electron-builder/cli.js");
