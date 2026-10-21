const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
  screen,
  session,
  safeStorage,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { installCredentialBridge } = require("./credential-bridge.cjs");
const platformHelpers = require(app.isPackaged
  ? path.join(process.resourcesPath, "product/scripts/platform.cjs")
  : path.resolve(__dirname, "../../scripts/platform.cjs"));
const label = (english, chinese) => app.getLocale().startsWith("zh") ? chinese : english;

app.setName("TeamSwarm");
app.setAppUserModelId("org.teamswarm.desktop");
const userDirectory =
  process.env.TEAMSWARM_USER_DATA ||
  path.join(app.getPath("appData"), "TeamSwarm");
app.setPath("userData", userDirectory);
const dataDirectory = platformHelpers.dataDirectory();
const productRoot = app.isPackaged
  ? path.join(process.resourcesPath, "product")
  : path.resolve(__dirname, "../..");
const stateFile = path.join(userDirectory, "window.json");
const readJSON = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
let windowState = readJSON(stateFile, {}),
  mainWindow,
  serviceChild,
  origin,
  connection,
  quitting = false,
  saving;
let restarting;
let healthTimer,
  healthBusy = false,
  healthFailures = 0;
const clientStateFile = path.join(userDirectory, "pending-input.json");
const clientState = readJSON(clientStateFile, {});
const storageKeys = new Set([
  "teamswarm.workspace",
  "teamswarm.preferences.pending",
  "teamswarm.messages.pending",
  "teamswarm.create-team.pending",
  "teamswarm.archive.browser-v1",
  "teamswarm.migration.id",
]);

function saveWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const currentURL = mainWindow.webContents.getURL();
  const hash = currentURL.startsWith(origin + "/")
    ? new URL(currentURL).hash
    : windowState.hash;
  windowState = {
    bounds: mainWindow.getNormalBounds(),
    maximized: mainWindow.isMaximized(),
    zoom: mainWindow.webContents.getZoomFactor(),
    hash: /^#\/team\//.test(hash || "") ? hash : "",
    dark: windowState.dark === true,
  };
  fs.mkdirSync(userDirectory, { recursive: true });
  const temporary = stateFile + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(windowState));
  fs.renameSync(temporary, stateFile);
}
function deferSave() {
  clearTimeout(saving);
  saving = setTimeout(saveWindow, 200);
}
function allowedExternal(url) {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
function localURL(url) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
async function choosePort() {
  const listener = net.createServer();
  const previous = readJSON(path.join(dataDirectory, "connection.json"), {});
  const preferred =
    Number.isInteger(previous.port) &&
    previous.port > 1024 &&
    previous.port < 65536
      ? previous.port
      : 0;
  listener.listen(preferred, "127.0.0.1");
  try {
    await once(listener, "listening");
  } catch (error) {
    if (error.code !== "EADDRINUSE" || !preferred) throw error;
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
  }
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
async function existingService() {
  const info = readJSON(path.join(dataDirectory, "connection.json"), null);
  const credential = readJSON(path.join(dataDirectory, "control.json"), null);
  if (
    !info ||
    !credential ||
    !Number.isInteger(info.port) ||
    !Number.isInteger(info.pid)
  )
    return null;
  try {
    process.kill(info.pid, 0);
    const response = await fetch(`http://127.0.0.1:${info.port}/api/teams`, {
      headers: { Authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok && Array.isArray((await response.json()).teams))
      return { port: info.port, token: credential.token, credentialStore: info.credentialStore };
  } catch {}
  return null;
}
async function stopService(child, grace = 15000) {
  if (!child) return;
  const exited = () => {
    if (child.exitCode !== null || !child.pid) return true;
    try {
      process.kill(child.pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  };
  if (exited()) {
    if (serviceChild === child) serviceChild = undefined;
    return;
  }
  await new Promise((resolve, reject) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      child.off("exit", done);
      resolve();
    };
    const verify = () => {
      if (exited()) return done();
      clearTimeout(timer);
      child.off("exit", done);
      reject(new Error("The local service is still stopping. Try again."));
    };
    child.once("exit", done);
    timer = setTimeout(() => {
      if (child.exitCode !== null) return done();
      if (process.platform !== "win32") {
        child.kill("SIGTERM");
        timer = setTimeout(verify, 3000);
        return;
      }
      const killer = spawn(
        path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32/taskkill.exe",
        ),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("close", verify);
      killer.once("error", verify);
    }, grace);
    if (child.connected) {
      try {
        child.send({ type: "shutdown" }, () => {});
      } catch {}
    }
  });
  if (serviceChild === child) serviceChild = undefined;
}
async function startService() {
  const existing = await existingService();
  if (existing) {
    if (process.platform !== "win32" && existing.credentialStore !== "desktop-keyring")
      throw new Error("A TeamSwarm browser service is already using this workspace. Stop that service, then reopen the desktop application to use the system keyring.");
    return existing;
  }
  await stopService(serviceChild, 3000);
  const port = await choosePort();
  const nativeDirectory = path.join(productRoot, "runtime");
  const suffix = process.platform === "win32" ? ".exe" : "";
  const node = app.isPackaged
    ? path.join(nativeDirectory, "node" + suffix)
    : process.env.TEAMSWARM_NODE_BIN || "node" + suffix;
  const codex = path.join(nativeDirectory, "codex", "bin", "codex" + suffix);
  const env = {
    ...process.env,
    TEAM_API_PORT: String(port),
    TEAM_DATA_DIR: dataDirectory,
    TEAMSWARM_DESKTOP_CREDENTIALS: "1",
    // Windows' restricted execution account cannot traverse LocalAppData. Keep
    // project files in the user's document directory; databases stay private.
    TEAM_PROJECTS_DIR:
      process.env.TEAM_PROJECTS_DIR ||
      path.join(app.getPath("documents"), "TeamSwarm"),
    TEAM_HARNESS_HOME: path.join(dataDirectory, "harnesses"),
    PATH: [
      nativeDirectory,
      path.join(nativeDirectory, "codex", "codex-path"),
      process.env.PATH || "",
    ].join(path.delimiter),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (fs.existsSync(codex)) env.TEAM_CODEX_FALLBACK_BIN = codex;
  const child = spawn(
    node,
    [path.join(productRoot, "scripts/start-product.mjs"), "--no-open"],
    {
      cwd: productRoot,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  serviceChild = child;
  installCredentialBridge(child, safeStorage);
  // Do not put model/provider errors or credentials in desktop diagnostics.
  child.stdout.resume();
  child.stderr.resume();
  let ready;
  try {
    ready = await new Promise((resolve, reject) => {
      const clean = () => {
        clearTimeout(timeout);
        child.off("error", fail);
        child.off("exit", fail);
        child.off("message", onMessage);
      };
      const timeout = setTimeout(() => {
        clean();
        reject(new Error("The local service did not start in time."));
      }, 20000);
      const fail = () => {
        clean();
        reject(new Error("The local service could not start."));
      };
      child.once("error", fail);
      child.once("exit", fail);
      const onMessage = (message) => {
        if (
          message?.type !== "ready" ||
          !Number.isInteger(message.port) ||
          typeof message.token !== "string"
        )
          return;
        clean();
        resolve(message);
      };
      child.on("message", onMessage);
    });
  } catch (error) {
    await stopService(child, 3000);
    throw error;
  }
  child.once("exit", () => {
    if (serviceChild === child) serviceChild = undefined;
    if (!quitting && mainWindow && !mainWindow.isDestroyed())
      void recoverService();
  });
  return ready;
}
async function authenticate() {
  origin = `http://127.0.0.1:${connection.port}`;
  await session.defaultSession.cookies.set({
    url: origin + "/api",
    name: "teamswarm_control",
    value: connection.token,
    path: "/api",
    httpOnly: true,
    sameSite: "strict",
  });
  healthFailures = 0;
}
function monitorService() {
  healthTimer = setInterval(async () => {
    if (quitting || restarting || healthBusy || !connection) return;
    healthBusy = true;
    try {
      const response = await fetch(origin + "/api/teams", {
        headers: { Authorization: `Bearer ${connection.token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error("Unavailable");
      healthFailures = 0;
    } catch {
      if (++healthFailures >= 2 && !serviceChild) void recoverService();
    } finally {
      healthBusy = false;
    }
  }, 3000);
}
async function recoverService() {
  if (restarting) return restarting;
  restarting = (async () => {
    saveWindow();
    try {
      connection = await startService();
      await authenticate();
      await mainWindow.loadURL(origin + "/" + (windowState.hash || ""));
    } catch {
      const result = await dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "TeamSwarm",
        message: label("Could not connect to your workspace", "无法连接工作空间"),
        detail: label("Retry to continue. Your saved conversations and files are preserved.", "请重试以继续。已保存的对话和文件会保留。"),
        buttons: [label("Retry", "重试"), label("Quit", "退出")],
        defaultId: 0,
        cancelId: 1,
      });
      if (result.response === 0) {
        restarting = undefined;
        return recoverService();
      }
      app.quit();
    }
  })().finally(() => {
    restarting = undefined;
  });
  return restarting;
}
function restoredBounds() {
  const bounds = windowState.bounds;
  if (
    bounds &&
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
  ) {
    const display = screen.getDisplayMatching(bounds).workArea;
    const width = Math.min(Math.max(bounds.width, 900), display.width),
      height = Math.min(Math.max(bounds.height, 650), display.height);
    return {
      width,
      height,
      x: Math.min(
        Math.max(bounds.x, display.x),
        display.x + display.width - width,
      ),
      y: Math.min(
        Math.max(bounds.y, display.y),
        display.y + display.height - height,
      ),
    };
  }
  const area = screen.getPrimaryDisplay().workArea;
  return {
    width: Math.min(1440, area.width),
    height: Math.min(960, area.height),
  };
}
async function createWindow() {
  Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate([
    { role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ]) : null);
  mainWindow = new BrowserWindow({
    ...restoredBounds(),
    minWidth: 900,
    minHeight: 650,
    show: false,
    title: "TeamSwarm",
    backgroundColor: windowState.dark ? "#151514" : "#f5f5f3",
    titleBarStyle: process.platform === "darwin" ? "default" : "hidden",
    titleBarOverlay: process.platform === "darwin" ? undefined : {
      color: windowState.dark ? "#1b1b19" : "#fcfcfb",
      symbolColor: windowState.dark ? "#e8ecf4" : "#616d80",
      height: 40,
    },
    icon: path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      devTools: !app.isPackaged,
    },
  });
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) =>
      callback(permission === "clipboard-sanitized-write"),
  );
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) =>
      localURL(requestingOrigin) && permission === "clipboard-sanitized-write",
  );
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    if (localURL(details.url))
      headers["Content-Security-Policy"] = [
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'",
      ];
    callback({ responseHeaders: headers });
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (localURL(url) && new URL(url).pathname.startsWith("/api/product/"))
      mainWindow.webContents.downloadURL(url);
    else if (allowedExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!localURL(url)) {
      event.preventDefault();
      if (allowedExternal(url)) void shell.openExternal(url);
    }
  });
  mainWindow.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  mainWindow.webContents.on("did-navigate-in-page", deferSave);
  mainWindow.webContents.on("render-process-gone", () => {
    if (!quitting) void recoverService();
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if ((input.control || input.meta) && ["+", "=", "-", "0"].includes(input.key)) {
      event.preventDefault();
      const current = mainWindow.webContents.getZoomFactor();
      mainWindow.webContents.setZoomFactor(
        input.key === "0"
          ? 1
          : Math.min(
              1.75,
              Math.max(
                0.75,
                Math.round((current + (input.key === "-" ? -0.1 : 0.1)) * 10) /
                  10,
              ),
            ),
      );
      deferSave();
    } else if ((input.control || input.meta) && input.key.toLowerCase() === "r") {
      event.preventDefault();
      mainWindow.webContents.reload();
    } else if ((input.control || input.meta) && input.key.toLowerCase() === "w") {
      event.preventDefault();
      mainWindow.close();
    } else if (input.key === "F11") {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });
  for (const event of ["resize", "move", "maximize", "unmaximize"])
    mainWindow.on(event, deferSave);
  mainWindow.on("close", (event) => {
    saveWindow();
    if (!quitting) {
      event.preventDefault();
      app.quit();
    }
  });
  mainWindow.once("ready-to-show", () => {
    if (windowState.maximized) mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.webContents.setZoomFactor(
    Math.min(1.75, Math.max(0.75, windowState.zoom || 1)),
  );
  await mainWindow.loadURL(origin + "/" + (windowState.hash || ""));
}
function trustedIPC(event) {
  return (
    mainWindow &&
    event.sender === mainWindow.webContents &&
    localURL(event.senderFrame?.url || "")
  );
}
ipcMain.on("pending-input", (event, action, key, value) => {
  const memberInputKey =
    typeof key === "string" &&
    /^teamswarm\.(?:member-input|work-input|delivery-view):[0-9a-f-]{36}:(?:host:)?[0-9a-f-]{36}$/.test(
      key,
    );
  const harnessPreferenceKey = typeof key === "string" && /^teamswarm:harness-updates:(codex|claude-code|grok|pi|opencode|deepseek-harness)$/.test(key);
  if (!trustedIPC(event) || (!storageKeys.has(key) && !memberInputKey && !harnessPreferenceKey)) {
    event.returnValue = { error: "Untrusted request." };
    return;
  }
  if (action === "get") {
    event.returnValue = { value: clientState[key] ?? null };
    return;
  }
  try {
    if (
      action !== "remove" &&
      (action !== "set" ||
        typeof value !== "string" ||
        value.length > 8 * 1024 * 1024)
    )
      throw new Error("Invalid saved input.");
    const next = { ...clientState };
    if (action === "remove") delete next[key];
    else next[key] = value;
    fs.mkdirSync(userDirectory, { recursive: true });
    fs.writeFileSync(clientStateFile + ".tmp", JSON.stringify(next));
    fs.renameSync(clientStateFile + ".tmp", clientStateFile);
    if (action === "remove") delete clientState[key];
    else clientState[key] = value;
    event.returnValue = { value: null };
  } catch {
    event.returnValue = { error: "Couldn’t save your input. Try again." };
  }
});
ipcMain.handle("choose-directory", async (event) => {
  if (!trustedIPC(event)) throw new Error("Untrusted request.");
  const selection = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  return selection.canceled ? null : selection.filePaths[0] || null;
});
ipcMain.on("theme", (event, dark) => {
  if (!trustedIPC(event) || typeof dark !== "boolean") return;
  windowState.dark = dark;
  if (process.platform !== "darwin") mainWindow.setTitleBarOverlay({
    color: dark ? "#1b1b19" : "#fcfcfb",
    symbolColor: dark ? "#e8ecf4" : "#616d80",
    height: 40,
  });
  deferSave();
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      connection = await startService();
      await authenticate();
      await createWindow();
      monitorService();
    } catch (error) {
      dialog.showErrorBox("TeamSwarm", label("Could not start your workspace.\n", "工作空间无法启动。\n") + error.message);
      app.quit();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    clearTimeout(saving);
    clearInterval(healthTimer);
    saveWindow();
    void stopService(serviceChild).then(
      () => app.quit(),
      () => {
        quitting = false;
        monitorService();
        dialog.showErrorBox("TeamSwarm", label("The background process is still stopping. Try closing again.", "后台进程尚未退出，请重试关闭。"));
      },
    );
  });
}
