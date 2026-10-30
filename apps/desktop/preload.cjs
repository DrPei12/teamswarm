const { contextBridge, ipcRenderer } = require("electron");
function pending(action, key, value) {
  const result = ipcRenderer.sendSync("pending-input", action, key, value);
  if (result?.error) throw new Error(result.error);
  return result?.value ?? null;
}
contextBridge.exposeInMainWorld(
  "teamswarmDesktop",
  Object.freeze({
    platform: "windows",
    chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
    setTheme: (dark) => ipcRenderer.send("theme", dark === true),
    returnFromChatGPT: () => ipcRenderer.send("chatgpt-sign-in-return"),
    storage: Object.freeze({
      getItem: (key) => pending("get", key),
      setItem: (key, value) => pending("set", key, value),
      removeItem: (key) => pending("remove", key),
    }),
  }),
);
