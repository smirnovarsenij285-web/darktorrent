const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("darkTorrent", {

  start: () => invoke("aria:start"),
  status: () => invoke("aria:status"),

  addMagnet: magnet => invoke("aria:addMagnet", magnet),
  addTorrent: () => invoke("aria:addTorrent"),
  addTorrentData: base64 => invoke("aria:addTorrentData", base64),

  pause: gid => invoke("aria:pause", gid),
  resume: gid => invoke("aria:resume", gid),
  pauseAll: () => invoke("aria:pauseAll"),
  resumeAll: () => invoke("aria:resumeAll"),
  retry: gid => invoke("aria:retry", gid),
  remove: gid => invoke("aria:remove", gid),
  removeKeepFiles: gid => invoke("aria:removeKeepFiles", gid),
  openDownload: gid => invoke("aria:openDownload", gid),
  clearCompleted: () => invoke("aria:clearCompleted"),

  getSettings: () => invoke("settings:get"),
  saveSettings: settings => invoke("settings:save", settings),
  chooseDir: () => invoke("settings:chooseDir"),
  openDir: () => invoke("settings:openDir"),
  resetSettings: () => invoke("settings:reset"),
  exportSettings: () => invoke("settings:export"),
  importSettings: () => invoke("settings:import"),

  setTrayTooltip: text => invoke("app:setTrayTooltip", text),

  onAdded: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("app:added", handler);
    return () => ipcRenderer.removeListener("app:added", handler);
  }
});
