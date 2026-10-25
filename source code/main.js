const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  Tray,
  nativeImage
} = require("electron");

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const crypto = require("crypto");
const { spawn } = require("child_process");

if (process.platform === "win32") {
  app.setAppUserModelId("DarkTorrent");
}

let mainWindow = null;
let tray = null;
let ariaProcess = null;
let rpcPort = 0;
let rpcSecret = "";
let ariaStartPromise = null;
let forceQuit = false;
let quitting = false;
let rpcCounter = 0;

const downloadCache = new Map();

const MAX_TORRENT_BASE64 = 14 * 1024 * 1024;

const downloadFields = [
  "gid",
  "status",
  "totalLength",
  "completedLength",
  "uploadLength",
  "downloadSpeed",
  "uploadSpeed",
  "connections",
  "numSeeders",
  "seeder",
  "filename",
  "infoHash",
  "files",
  "dir",
  "errorMessage",
  "followedBy",
  "belongsTo",
  "bittorrent"
];

function getAriaPath() {
  const relative =
    process.platform === "win32"
      ? path.join("bin", "win32", "aria2c.exe")
      : path.join("bin", process.platform, "aria2c");

  const candidates = [
    path.join(__dirname, relative)
  ];

  if (app.isPackaged) {
    candidates.unshift(
      path.join(process.resourcesPath, relative)
    );
  }

  return (
    candidates.find(item => fs.existsSync(item)) ||
    candidates[0]
  );
}

function getAppIconPath() {
  const candidates = [
    path.join(__dirname, "icon.ico"),
    path.join(app.getAppPath(), "icon.ico"),
    path.join(process.cwd(), "icon.ico")
  ];

  if (app.isPackaged) {
    candidates.unshift(
      path.join(process.resourcesPath, "icon.ico"),
      path.join(process.resourcesPath, "app.ico")
    );
  }

  return (
    candidates.find(filePath => fs.existsSync(filePath)) ||
    null
  );
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function getSessionPath() {
  return path.join(app.getPath("userData"), "aria2.session");
}

const SETTINGS_VERSION = 2;

const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,

  downloadDir: app.getPath("downloads"),

  proxy: {
    type: "",
    host: "",
    port: "",
    username: "",
    password: ""
  },

  downloads: {
    maxConcurrent: 3,
    maxConnections: 4,
    split: 4,
    minSplitSize: "1M",
    maxDownloadSpeed: "0",
    maxUploadSpeed: "0",
    fileAllocation: "falloc",
    continueDownloads: true,
    autoFileRenaming: true
  },

  bittorrent: {
    dht: true,
    peerExchange: true,
    lpd: true,
    seedTime: 0,
    seedRatio: 0,
    saveMetadata: true,
    listenPort: ""
  },

  general: {
    startWithWindows: true,
    startMinimized: false,
    closeToTray: false,
    confirmRemove: true,
    compactMode: false,
    notifyOnComplete: true,
    handleMagnet: false
  }
};

function deepMerge(target, source) {
  if (!source || typeof source !== "object") {
    return target;
  }

  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key])
    ) {
      if (!target[key] || typeof target[key] !== "object") {
        target[key] = {};
      }

      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }

  return target;
}

function defaultSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function sanitizeSettings(value) {
  if (!value || typeof value !== "object") {
    return defaultSettings();
  }

  delete value.vpn;
  delete value.encryption;

  return value;
}

function loadSettings() {
  try {
    const saved = JSON.parse(
      fs.readFileSync(getSettingsPath(), "utf8")
    );

    const merged = deepMerge(defaultSettings(), saved);

    if (!saved.settingsVersion || saved.settingsVersion < SETTINGS_VERSION) {
      const current = merged.downloads.fileAllocation;

      if (!current || current === "none") {
        merged.downloads.fileAllocation = "falloc";
      }

      merged.settingsVersion = SETTINGS_VERSION;

      try {
        fs.writeFileSync(
          getSettingsPath(),
          JSON.stringify(merged, null, 2),
          "utf8"
        );
      } catch {}
    }

    return sanitizeSettings(merged);
  } catch {
    return defaultSettings();
  }
}

let settings = loadSettings();

function saveSettings() {
  settings = sanitizeSettings(settings);

  fs.mkdirSync(app.getPath("userData"), { recursive: true });

  fs.writeFileSync(
    getSettingsPath(),
    JSON.stringify(settings, null, 2),
    "utf8"
  );
}

function updateLoginItem() {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.general.startWithWindows),
      openAsHidden: Boolean(settings.general.startMinimized),

      args: settings.general.startMinimized ? ["--hidden"] : []
    });
  } catch {}
}

function syncMagnetHandler() {
  try {
    const withArgs =
      process.defaultApp && process.argv.length >= 2;

    if (settings.general.handleMagnet) {
      if (withArgs) {
        app.setAsDefaultProtocolClient(
          "magnet",
          process.execPath,
          [path.resolve(process.argv[1])]
        );
      } else {
        app.setAsDefaultProtocolClient("magnet");
      }
    } else if (withArgs) {
      app.removeAsDefaultProtocolClient(
        "magnet",
        process.execPath,
        [path.resolve(process.argv[1])]
      );
    } else {
      app.removeAsDefaultProtocolClient("magnet");
    }
  } catch (error) {
    console.error("[DarkTorrent] magnet handler:", error);
  }
}

function afterSettingsChanged() {
  updateLoginItem();
  syncMagnetHandler();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      const port =
        address && typeof address === "object"
          ? address.port
          : 0;

      server.close(() => resolve(port));
    });
  });
}

function booleanString(value) {
  return value ? "true" : "false";
}

function isValidPortSpec(value) {
  return /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/.test(
    String(value || "").trim()
  );
}

function notifyRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

const UPDATE_CHECK_URL = "https://darktorrent.vercel.app/version.json";

let updateLink = "";

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, "").split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, "").split(/[.-]/).map(n => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);

    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }

  return 0;
}

function fetchJson(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { "User-Agent": "DarkTorrent", Accept: "application/json" } },
      response => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location &&
          redirects > 0
        ) {
          response.resume();
          resolve(fetchJson(new URL(response.headers.location, url).toString(), redirects - 1));
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", chunk => {
          body += chunk;
          if (body.length > 1024 * 1024) request.destroy();
        });
        response.on("end", () => {
          try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        });
      }
    );

    request.setTimeout(8000, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

async function checkForUpdate() {
  if (!/^https:\/\//i.test(UPDATE_CHECK_URL) || /OWNER\/REPO/.test(UPDATE_CHECK_URL)) {
    return { available: false };
  }

  try {
    const data = await fetchJson(UPDATE_CHECK_URL);

    const version = String(data.version || data.tag_name || "").trim();
    const url = String(data.url || data.html_url || "").trim();

    if (!version || !/^https:\/\//i.test(url)) {
      return { available: false };
    }

    if (compareVersions(version, app.getVersion()) > 0) {
      updateLink = url;

      return {
        available: true,
        version: version.replace(/^v/i, ""),
        current: app.getVersion()
      };
    }
  } catch (error) {
    console.error("[update] check failed:", error.message);
  }

  return { available: false };
}

ipcMain.handle("app:checkUpdate", () => checkForUpdate());

ipcMain.handle("app:openUpdate", async () => {
  if (/^https:\/\//i.test(updateLink)) {
    await shell.openExternal(updateLink);
    return true;
  }

  return false;
});

function getAriaArguments() {
  const args = [
    "--enable-rpc=true",
    "--rpc-listen-all=false",
    `--rpc-listen-port=${rpcPort}`,
    `--rpc-secret=${rpcSecret}`,
    `--dir=${settings.downloadDir}`,
    "--console-log-level=warn",
    "--disk-cache=64M",
    "--check-integrity=false",
    "--bt-hash-check-seed=false",
    "--bt-seed-unverified=true",
    `--stop-with-process=${process.pid}`,
    "--max-tries=5",
    "--retry-wait=3",
    "--max-file-not-found=2",
    `--save-session=${getSessionPath()}`,
    "--save-session-interval=15",
    `--input-file=${getSessionPath()}`,
    `--max-concurrent-downloads=${Math.max(1, Number(settings.downloads.maxConcurrent) || 3)}`,
    `--max-connection-per-server=${Math.max(1, Number(settings.downloads.maxConnections) || 4)}`,
    `--split=${Math.max(1, Number(settings.downloads.split) || 4)}`,
    `--min-split-size=${settings.downloads.minSplitSize || "1M"}`,
    `--max-overall-download-limit=${settings.downloads.maxDownloadSpeed || "0"}`,
    `--max-overall-upload-limit=${settings.downloads.maxUploadSpeed || "0"}`,
    `--file-allocation=${settings.downloads.fileAllocation || "none"}`,
    `--continue=${booleanString(settings.downloads.continueDownloads)}`,
    `--auto-file-renaming=${booleanString(settings.downloads.autoFileRenaming)}`,
    `--enable-dht=${booleanString(settings.bittorrent.dht)}`,
    `--enable-peer-exchange=${booleanString(settings.bittorrent.peerExchange)}`,
    `--bt-enable-lpd=${booleanString(settings.bittorrent.lpd)}`,
    `--seed-time=${Number(settings.bittorrent.seedTime) || 0}`,
    `--seed-ratio=${Number(settings.bittorrent.seedRatio) || 0}`,
    `--bt-save-metadata=${booleanString(settings.bittorrent.saveMetadata)}`
  ];

  const listenPort = String(settings.bittorrent.listenPort || "").trim();

  if (listenPort && isValidPortSpec(listenPort)) {
    args.push(
      `--listen-port=${listenPort}`,
      `--dht-listen-port=${listenPort}`
    );
  }

  if (
    settings.proxy.type &&
    settings.proxy.host &&
    settings.proxy.port
  ) {
    args.push(
      `--all-proxy=${settings.proxy.type}://${settings.proxy.host}:${settings.proxy.port}`
    );

    if (settings.proxy.username) {
      args.push(`--all-proxy-user=${settings.proxy.username}`);
    }

    if (settings.proxy.password) {
      args.push(`--all-proxy-passwd=${settings.proxy.password}`);
    }
  }

  return args;
}

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    if (!rpcPort || !rpcSecret) {
      reject(new Error("Сервис загрузок не запущен."));
      return;
    }

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: `${Date.now()}-${++rpcCounter}`,
      method,
      params: [`token:${rpcSecret}`, ...params]
    });

    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: rpcPort,
        path: "/jsonrpc",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      response => {
        let data = "";

        response.setEncoding("utf8");

        response.on("data", chunk => {
          data += chunk;
        });

        response.on("end", () => {
          try {
            const parsed = JSON.parse(data);

            if (parsed.error) {
              reject(new Error(parsed.error.message));
              return;
            }

            resolve(parsed.result);
          } catch {
            reject(new Error("Некорректный RPC-ответ."));
          }
        });
      }
    );

    request.setTimeout(5000, () => {
      request.destroy(new Error("RPC timeout."));
    });

    request.on("error", reject);

    request.write(body);
    request.end();
  });
}

async function applyAriaSettings() {
  if (!ariaProcess || ariaProcess.killed) {
    return;
  }

  const options = {
    dir: settings.downloadDir,
    "max-concurrent-downloads": String(Math.max(1, Number(settings.downloads.maxConcurrent) || 3)),
    "max-connection-per-server": String(Math.max(1, Number(settings.downloads.maxConnections) || 4)),
    split: String(Math.max(1, Number(settings.downloads.split) || 4)),
    "min-split-size": settings.downloads.minSplitSize || "1M",
    "max-overall-download-limit": settings.downloads.maxDownloadSpeed || "0",
    "max-overall-upload-limit": settings.downloads.maxUploadSpeed || "0",
    continue: booleanString(settings.downloads.continueDownloads),
    "auto-file-renaming": booleanString(settings.downloads.autoFileRenaming),
    "enable-dht": booleanString(settings.bittorrent.dht),
    "enable-peer-exchange": booleanString(settings.bittorrent.peerExchange),
    "bt-enable-lpd": booleanString(settings.bittorrent.lpd),
    "seed-time": String(Number(settings.bittorrent.seedTime) || 0),
    "seed-ratio": String(Number(settings.bittorrent.seedRatio) || 0),
    "bt-save-metadata": booleanString(settings.bittorrent.saveMetadata),
    "all-proxy": "",
    "all-proxy-user": "",
    "all-proxy-passwd": ""
  };

  if (
    settings.proxy.type &&
    settings.proxy.host &&
    settings.proxy.port
  ) {
    options["all-proxy"] =
      `${settings.proxy.type}://${settings.proxy.host}:${settings.proxy.port}`;

    options["all-proxy-user"] = settings.proxy.username || "";
    options["all-proxy-passwd"] = settings.proxy.password || "";
  }

  await rpc("aria2.changeGlobalOption", [options]);
}

function normalizeDownload(item) {
  const torrentName = item.bittorrent?.info?.name;

  const filename = item.filename
    ? path.basename(item.filename)
    : Array.isArray(item.files) &&
      item.files.length &&
      item.files[0].path
      ? path.basename(String(item.files[0].path).replace(/\\/g, "/"))
      : "";

  return {
    ...item,
    displayName: torrentName || filename || "Загрузка",

    isMetadata:
      Array.isArray(item.followedBy) &&
      item.followedBy.length > 0
  };
}

async function cacheStatus(gid) {
  try {
    const item = await rpc("aria2.tellStatus", [gid, downloadFields]);
    const normalized = normalizeDownload(item);
    downloadCache.set(normalized.gid, normalized);
  } catch {}
}

async function getDownloadsFromAria() {
  const active = await rpc("aria2.tellActive", [downloadFields]);
  const waiting = await rpc("aria2.tellWaiting", [0, 1000, downloadFields]);
  const stopped = await rpc("aria2.tellStopped", [0, 1000, downloadFields]);

  return [...active, ...waiting, ...stopped].map(normalizeDownload);
}

async function startAria2() {
  if (ariaProcess && !ariaProcess.killed) {
    return true;
  }

  if (ariaStartPromise) {
    return ariaStartPromise;
  }

  ariaStartPromise = (async () => {
    try {
      const ariaPath = getAriaPath();

      if (!fs.existsSync(ariaPath)) {
        throw new Error(`Не найден aria2c:\n\n${ariaPath}`);
      }

      fs.mkdirSync(settings.downloadDir, { recursive: true });

      const sessionPath = getSessionPath();

      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });

      if (!fs.existsSync(sessionPath)) {
        fs.writeFileSync(sessionPath, "", "utf8");
      }

      rpcPort = await getFreePort();
      rpcSecret = crypto.randomBytes(24).toString("hex");

      ariaProcess = spawn(ariaPath, getAriaArguments(), {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });

      ariaProcess.stdout.on("data", data => {
        console.log("[aria2]", data.toString());
      });

      ariaProcess.stderr.on("data", data => {
        console.error("[aria2]", data.toString());
      });

      ariaProcess.on("error", error => {
        console.error("[aria2] error:", error);
      });

      ariaProcess.on("exit", (code, signal) => {
        console.log("[aria2] exited:", code, signal);

        ariaProcess = null;
        rpcPort = 0;
        rpcSecret = "";
      });

      const started = Date.now();

      while (Date.now() - started < 10000) {
        try {
          await rpc("aria2.getVersion");

          try {
            const initial = await getDownloadsFromAria();

            for (const item of initial) {
              downloadCache.set(item.gid, item);
            }
          } catch {}

          return true;
        } catch {
          await sleep(150);
        }
      }

      throw new Error("aria2c запустился, но RPC не отвечает.");
    } finally {
      ariaStartPromise = null;
    }
  })();

  return ariaStartPromise;
}

function stopAria2Gracefully(timeoutMs = 30000) {
  const proc = ariaProcess;

  if (!proc || proc.killed || proc.exitCode !== null) {
    stopAria2();
    return Promise.resolve();
  }

  return new Promise(resolve => {
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stopAria2();
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);

    proc.once("exit", finish);

    rpc("aria2.shutdown").catch(finish);
  });
}

function stopAria2() {
  try {
    if (ariaProcess && !ariaProcess.killed) {
      ariaProcess.kill();
    }
  } catch {}

  ariaProcess = null;
  rpcPort = 0;
  rpcSecret = "";
  ariaStartPromise = null;
}

async function addMagnetUri(magnet) {
  await startAria2();

  if (
    typeof magnet !== "string" ||
    !magnet.trim().toLowerCase().startsWith("magnet:")
  ) {
    throw new Error("Это не корректная magnet-ссылка.");
  }

  const gid = await rpc("aria2.addUri", [[magnet.trim()]]);

  await cacheStatus(gid);

  return gid;
}

async function addTorrentBase64(base64) {
  if (
    typeof base64 !== "string" ||
    !base64 ||
    base64.length > MAX_TORRENT_BASE64
  ) {
    throw new Error("Некорректный или слишком большой .torrent файл.");
  }

  if (Buffer.from(base64.slice(0, 8), "base64")[0] !== 0x64) {
    throw new Error("Файл не похож на .torrent.");
  }

  await startAria2();

  const gid = await rpc("aria2.addTorrent", [base64]);

  await cacheStatus(gid);

  return gid;
}

function extractLaunchItems(argv) {
  const items = [];

  for (const arg of argv) {
    if (typeof arg !== "string") {
      continue;
    }

    if (/^magnet:/i.test(arg)) {
      items.push({ type: "magnet", value: arg });
    } else if (/\.torrent$/i.test(arg) && fs.existsSync(arg)) {
      items.push({ type: "torrent", value: arg });
    }
  }

  return items;
}

async function processLaunchItems(items) {
  for (const item of items) {
    try {
      if (item.type === "magnet") {
        await addMagnetUri(item.value);
      } else {
        await addTorrentBase64(
          fs.readFileSync(item.value).toString("base64")
        );
      }

      notifyRenderer("app:added", { ok: true, kind: item.type });
    } catch (error) {
      notifyRenderer("app:added", {
        ok: false,
        kind: item.type,
        error: error.message
      });
    }
  }
}

function isInsideDirectory(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(base, target);

  return (
    relative === "" ||
    (
      !relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    )
  );
}

function resolveAriaFilePath(download, filePath) {
  if (!filePath) {
    return null;
  }

  const dir = download.dir || settings.downloadDir;
  const value = String(filePath);

  const absolute = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(dir, value);

  if (!isInsideDirectory(settings.downloadDir, absolute)) {
    return null;
  }

  return absolute;
}

function getSafeDownloadTargets(download) {
  const result = [];

  if (!download || !Array.isArray(download.files)) {
    return result;
  }

  const files = download.files
    .map(file => resolveAriaFilePath(download, file?.path))
    .filter(Boolean);

  if (!files.length) {
    return result;
  }

  const uniqueFiles = Array.from(new Set(files));

  const relativeFiles = uniqueFiles.map(file =>
    path.relative(path.resolve(settings.downloadDir), file)
  );

  const topLevels = relativeFiles
    .map(relative => relative.split(path.sep)[0] || "")
    .filter(Boolean);

  const uniqueTopLevels = Array.from(new Set(topLevels));

  if (
    uniqueTopLevels.length === 1 &&
    relativeFiles.every(
      relative => relative.split(path.sep).length >= 2
    )
  ) {
    const root = path.resolve(
      settings.downloadDir,
      uniqueTopLevels[0]
    );

    if (
      root !== path.resolve(settings.downloadDir) &&
      isInsideDirectory(settings.downloadDir, root)
    ) {
      result.push(root);
      return result;
    }
  }

  return uniqueFiles.filter(
    file => file !== path.resolve(settings.downloadDir)
  );
}

async function deletePathWithRetry(target) {
  if (!target) {
    return false;
  }

  const base = path.resolve(settings.downloadDir);
  const resolved = path.resolve(target);

  if (resolved === base || !isInsideDirectory(base, resolved)) {
    return false;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (fs.existsSync(resolved)) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }

      return true;
    } catch (error) {
      if (attempt === 4) {
        console.error("[DarkTorrent] Could not delete:", resolved, error);
        return false;
      }

      await sleep(300);
    }
  }

  return false;
}

async function deleteDownloadData(download) {
  const targets = getSafeDownloadTargets(download);
  let deleted = 0;

  for (const target of targets) {
    if (await deletePathWithRetry(target)) {
      deleted++;
    }
  }

  return { deleted, total: targets.length };
}

ipcMain.handle("aria:start", async () => startAria2());

ipcMain.handle("aria:status", async () => {
  if (!ariaProcess || ariaProcess.killed) {
    return Array.from(downloadCache.values());
  }

  const results = await Promise.allSettled([
    rpc("aria2.tellActive", [downloadFields]),
    rpc("aria2.tellWaiting", [0, 1000, downloadFields]),
    rpc("aria2.tellStopped", [0, 1000, downloadFields])
  ]);

  const successfulLists = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      successfulLists.push(result.value);
    }
  }

  for (const list of successfulLists) {
    for (const item of list) {
      const normalized = normalizeDownload(item);
      downloadCache.set(normalized.gid, normalized);
    }
  }

  const allSuccessful = results.every(
    result => result.status === "fulfilled"
  );

  if (allSuccessful) {
    const currentGids = new Set(
      successfulLists.flat().map(item => item.gid)
    );

    for (const gid of downloadCache.keys()) {
      if (!currentGids.has(gid)) {
        downloadCache.delete(gid);
      }
    }
  }

  return Array.from(downloadCache.values());
});

ipcMain.handle("aria:addMagnet", async (_event, magnet) =>
  addMagnetUri(magnet)
);

ipcMain.handle("aria:addTorrent", async () => {
  await startAria2();

  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Выберите .torrent",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Torrent", extensions: ["torrent"] }]
  });

  if (result.canceled || !result.filePaths.length) {
    return 0;
  }

  let added = 0;

  for (const filePath of result.filePaths) {
    await addTorrentBase64(
      fs.readFileSync(filePath).toString("base64")
    );

    added++;
  }

  return added;
});

ipcMain.handle("aria:addTorrentData", async (_event, base64) =>
  addTorrentBase64(base64)
);

ipcMain.handle("aria:pause", async (_event, gid) => {
  if (!ariaProcess) {
    return null;
  }

  return rpc("aria2.pause", [gid]);
});

ipcMain.handle("aria:resume", async (_event, gid) => {
  if (!ariaProcess) {
    return null;
  }

  return rpc("aria2.unpause", [gid]);
});

ipcMain.handle("aria:pauseAll", async () => {
  if (!ariaProcess) {
    return null;
  }

  return rpc("aria2.pauseAll");
});

ipcMain.handle("aria:resumeAll", async () => {
  if (!ariaProcess) {
    return null;
  }

  return rpc("aria2.unpauseAll");
});

ipcMain.handle("aria:retry", async (_event, gid) => {
  await startAria2();

  try {
    return await rpc("aria2.forceRestart", [gid]);
  } catch (error) {
    try {
      return await rpc("aria2.unpause", [gid]);
    } catch {
      throw error;
    }
  }
});

ipcMain.handle("aria:remove", async (_event, gid) => {
  if (!ariaProcess) {
    return { removed: false, dataDeleted: 0, dataTotal: 0 };
  }

  let download = null;

  try {
    download = await rpc("aria2.tellStatus", [gid, downloadFields]);
  } catch {}

  try {
    await rpc("aria2.forceRemove", [gid]);
  } catch {
    try {
      await rpc("aria2.removeDownloadResult", [gid]);
    } catch {}
  }

  downloadCache.delete(gid);

  await sleep(250);

  const deletion = await deleteDownloadData(download);

  return {
    removed: true,
    dataDeleted: deletion.deleted,
    dataTotal: deletion.total
  };
});

ipcMain.handle("aria:removeKeepFiles", async (_event, gid) => {
  if (!ariaProcess) {
    return false;
  }

  try {
    await rpc("aria2.forceRemove", [gid]);
  } catch {
    try {
      await rpc("aria2.removeDownloadResult", [gid]);
    } catch {}
  }

  downloadCache.delete(gid);

  return true;
});

ipcMain.handle("aria:openDownload", async (_event, gid) => {
  await startAria2();

  let download;

  try {
    download = await rpc("aria2.tellStatus", [gid, downloadFields]);
  } catch {
    download = downloadCache.get(gid);
  }

  if (!download) {
    throw new Error("Не удалось получить информацию о загрузке.");
  }

  for (const file of Array.isArray(download.files) ? download.files : []) {
    const resolved = resolveAriaFilePath(download, file?.path);

    if (resolved && fs.existsSync(resolved)) {
      shell.showItemInFolder(resolved);
      return true;
    }
  }

  const dir = path.resolve(download.dir || settings.downloadDir);

  if (isInsideDirectory(settings.downloadDir, dir)) {
    await shell.openPath(dir);
    return true;
  }

  throw new Error("Путь загрузки недоступен.");
});

ipcMain.handle("aria:clearCompleted", async () => {
  if (!ariaProcess) {
    return 0;
  }

  const stopped = await rpc("aria2.tellStopped", [
    0,
    1000,
    ["gid", "status", "followedBy"]
  ]);

  const completed = stopped.filter(
    item => item.status === "complete"
  );

  let visible = 0;

  for (const item of completed) {
    const isMetadata =
      Array.isArray(item.followedBy) && item.followedBy.length > 0;

    try {
      await rpc("aria2.removeDownloadResult", [item.gid]);
    } catch {}

    downloadCache.delete(item.gid);

    if (!isMetadata) {
      visible++;
    }
  }

  return visible;
});

ipcMain.handle("settings:get", async () => settings);

ipcMain.handle("settings:save", async (_event, incoming) => {
  if (!incoming || typeof incoming !== "object") {
    throw new Error("Некорректные настройки.");
  }

  const port = String(incoming.bittorrent?.listenPort || "").trim();

  if (port && !isValidPortSpec(port)) {
    throw new Error(
      "Порт входящих соединений: укажите число, диапазон (6881-6999) или оставьте поле пустым."
    );
  }

  settings = sanitizeSettings(
    deepMerge(defaultSettings(), incoming)
  );

  settings.bittorrent.listenPort = port;

  fs.mkdirSync(settings.downloadDir, { recursive: true });

  saveSettings();
  afterSettingsChanged();

  if (ariaProcess && !ariaProcess.killed) {
    try {
      await applyAriaSettings();
    } catch {}
  }

  return settings;
});

ipcMain.handle("settings:chooseDir", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Выберите папку загрузок",
    properties: ["openDirectory"]
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  settings.downloadDir = result.filePaths[0];

  fs.mkdirSync(settings.downloadDir, { recursive: true });

  saveSettings();

  if (ariaProcess && !ariaProcess.killed) {
    try {
      await rpc("aria2.changeGlobalOption", [
        { dir: settings.downloadDir }
      ]);
    } catch {}
  }

  return settings.downloadDir;
});

ipcMain.handle("settings:openDir", async () => {
  await shell.openPath(settings.downloadDir);
  return true;
});

ipcMain.handle("settings:reset", async () => {
  settings = defaultSettings();

  saveSettings();
  afterSettingsChanged();

  if (ariaProcess && !ariaProcess.killed) {
    try {
      await applyAriaSettings();
    } catch {}
  }

  return settings;
});

ipcMain.handle("settings:export", async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Экспорт настроек",
    defaultPath: "DarkTorrent-settings.json",
    filters: [{ name: "JSON", extensions: ["json"] }]
  });

  if (result.canceled || !result.filePath) {
    return false;
  }

  fs.writeFileSync(
    result.filePath,
    JSON.stringify(sanitizeSettings(settings), null, 2),
    "utf8"
  );

  return true;
});

ipcMain.handle("settings:import", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Импорт настроек",
    properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }]
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }

  const imported = JSON.parse(
    fs.readFileSync(result.filePaths[0], "utf8")
  );

  settings = sanitizeSettings(
    deepMerge(defaultSettings(), imported)
  );

  saveSettings();
  afterSettingsChanged();

  fs.mkdirSync(settings.downloadDir, { recursive: true });

  if (ariaProcess && !ariaProcess.killed) {
    try {
      await applyAriaSettings();
    } catch {}
  }

  return settings;
});

ipcMain.handle("app:setTrayTooltip", async (_event, text) => {
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(String(text || "DarkTorrent").slice(0, 120));
  }

  return true;
});

function loadAppIcon() {
  const iconPath = getAppIconPath();

  if (!iconPath) {
    console.error("[DarkTorrent] icon.ico не найден.");
    return null;
  }

  try {
    const icon = nativeImage.createFromPath(iconPath);

    if (icon.isEmpty()) {
      console.error(
        "[DarkTorrent] Electron не смог загрузить icon.ico:",
        iconPath
      );

      return null;
    }

    return icon;
  } catch (error) {
    console.error("[DarkTorrent] Ошибка загрузки иконки:", error);
    return null;
  }
}

function createTray() {
  const icon = loadAppIcon();

  if (!icon) {
    console.error("[DarkTorrent] Tray не создан: нет рабочей иконки.");
    return false;
  }

  try {
    tray = new Tray(icon);

    tray.setToolTip("DarkTorrent");

    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "Открыть DarkTorrent",
          click: showMainWindow
        },
        { type: "separator" },
        {
          label: "Приостановить все",
          click: () => {
            if (ariaProcess) {
              rpc("aria2.pauseAll").catch(() => {});
            }
          }
        },
        {
          label: "Продолжить все",
          click: () => {
            if (ariaProcess) {
              rpc("aria2.unpauseAll").catch(() => {});
            }
          }
        },
        { type: "separator" },
        {
          label: "Выход",
          click: () => {
            forceQuit = true;
            app.quit();
          }
        }
      ])
    );

    tray.on("double-click", showMainWindow);

    return true;
  } catch (error) {
    console.error("[DarkTorrent] Tray error:", error);
    return false;
  }
}

function createWindow({ hidden = false } = {}) {
  const icon = loadAppIcon();

  const options = {
    width: 1350,
    height: 850,
    minWidth: 1000,
    minHeight: 650,
    title: "DarkTorrent",
    backgroundColor: "#070708",
    autoHideMenuBar: true,
    show: !hidden,

    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };

  if (process.platform === "darwin") {
    options.titleBarStyle = "hiddenInset";
  } else {
    options.titleBarStyle = "hidden";

    options.titleBarOverlay = {
      color: "#070708",
      symbolColor: "#c9c9d1",
      height: 36
    };
  }

  if (icon) {
    options.icon = icon;
  }

  mainWindow = new BrowserWindow(options);

  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }

    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", event => {
    event.preventDefault();
  });

  mainWindow.on("close", event => {
    if (settings.general.closeToTray && !forceQuit) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  const launchItems = extractLaunchItems(process.argv.slice(1));

  if (launchItems.length) {
    mainWindow.webContents.once("did-finish-load", () => {
      processLaunchItems(launchItems);
    });
  }
}

if (!app.requestSingleInstanceLock()) {

  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    showMainWindow();

    const items = extractLaunchItems(argv.slice(1));

    if (items.length) {
      processLaunchItems(items);
    }
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();

    if (/^magnet:/i.test(url)) {
      processLaunchItems([{ type: "magnet", value: url }]);
    }
  });

  app.on("open-file", (event, filePath) => {
    event.preventDefault();

    if (/\.torrent$/i.test(filePath)) {
      processLaunchItems([{ type: "torrent", value: filePath }]);
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    afterSettingsChanged();

    const startHidden =
      process.argv.includes("--hidden") &&
      Boolean(settings.general.startMinimized);

    createWindow({ hidden: startHidden });

    const trayCreated = createTray();

    if (startHidden && !trayCreated) {
      showMainWindow();
    }
  });

  app.on("before-quit", event => {
    if (quitting) {
      return;
    }

    quitting = true;
    event.preventDefault();

    (async () => {
      try {
        if (ariaProcess && !ariaProcess.killed) {
          try {
            await rpc("aria2.saveSession");
          } catch {}
        }
      } catch {}

      await stopAria2Gracefully();

      app.quit();
    })();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
