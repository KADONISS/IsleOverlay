const { app, BrowserWindow, ipcMain, net, shell, screen, Tray, Menu, safeStorage, nativeImage } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");

app.setPath("userData", path.join(app.getPath("appData"), "isleoverlay"));
app.setAppUserModelId("eu.isleoverlay.desktop");

let uio = null;
try {
  uio = require("uiohook-napi");
} catch {
  uio = null;
}
let cursorOn = false;
let cursorKeyHeld = false;
let dashKeyHeld = false;
let dashOn = true;
let recordTarget = "cursorKey";
let uioStarted = false;
let recordResolve = null;

const SETTINGS_FILE = () =>
  path.join(app.getPath("userData"), "isleoverlay.settings.json");

const defaultTheme = {
  accent: "#7cf2a6",
  stat: { health: "#ff5a5a", stamina: "#ffcf4a", food: "#79f2a6", water: "#5ab6ff" },
};

const defaultSettings = {
  apiBaseUrl: "https://islepilot.eu",
  serverPageUrl: null,
  useServerPathAsApiPrefix: false,
  steamId: null,
  overlayToken: null,
  opacity: 1,
  layout: null,
  panels: null,
  theme: defaultTheme,
  radarBounds: null,
  radarSize: 320,
  radarRange: 1,
  radarLabels: false,
  radarOpen: false,
  cursorEnabled: false,
  cursorKey: "Insert",
  cursorMode: "toggle",
  dashKey: "F8",
  streamerMode: false,
  compatMode: false,
  autoUpdate: false,
};

const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const normalizeTheme = (t) => {
  const src = t && typeof t === "object" ? t : {};
  const st = src.stat && typeof src.stat === "object" ? src.stat : {};
  return {
    accent: isHex(src.accent) ? src.accent : defaultTheme.accent,
    stat: {
      health: isHex(st.health) ? st.health : defaultTheme.stat.health,
      stamina: isHex(st.stamina) ? st.stamina : defaultTheme.stat.stamina,
      food: isHex(st.food) ? st.food : defaultTheme.stat.food,
      water: isHex(st.water) ? st.water : defaultTheme.stat.water,
    },
  };
};

const asStringOrNull = (v) =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
const asString = (v, fallback) =>
  typeof v === "string" && v.trim() ? v.trim() : fallback;

const normalizeHttpUrl = (value, fallback = null) => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
      return fallback;
    }
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
};

const normalizeSettings = (raw) => {
  const s = raw && typeof raw === "object" ? raw : {};
  const steamIdRaw = typeof s.steamId === "string" ? s.steamId.trim() : "";
  return {
    apiBaseUrl: normalizeHttpUrl(s.apiBaseUrl, defaultSettings.apiBaseUrl),
    serverPageUrl: normalizeHttpUrl(s.serverPageUrl, null),
    useServerPathAsApiPrefix: Boolean(s.useServerPathAsApiPrefix),
    steamId: /^\d{17}$/.test(steamIdRaw) ? steamIdRaw : null,
    overlayToken: asStringOrNull(s.overlayToken),
    opacity:
      typeof s.opacity === "number" && Number.isFinite(s.opacity)
        ? Math.max(0.3, Math.min(1, s.opacity))
        : 1,
    layout: s.layout && typeof s.layout === "object" ? s.layout : null,
    panels: s.panels && typeof s.panels === "object" ? s.panels : null,
    theme: normalizeTheme(s.theme),
    radarBounds: s.radarBounds && typeof s.radarBounds === "object" ? s.radarBounds : null,
    radarSize:
      typeof s.radarSize === "number" && Number.isFinite(s.radarSize)
        ? Math.max(180, Math.min(560, Math.round(s.radarSize)))
        : 320,
    radarRange:
      typeof s.radarRange === "number" && s.radarRange >= 0 && s.radarRange <= 3
        ? Math.round(s.radarRange)
        : 1,
    radarLabels: Boolean(s.radarLabels),
    radarOpen: Boolean(s.radarOpen),
    cursorEnabled: Boolean(s.cursorEnabled),
    cursorKey: typeof s.cursorKey === "string" && s.cursorKey ? s.cursorKey : "Insert",
    cursorMode: s.cursorMode === "hold" ? "hold" : "toggle",
    dashKey: typeof s.dashKey === "string" ? s.dashKey : "F8",
    streamerMode: Boolean(s.streamerMode),
    compatMode: Boolean(s.compatMode),
    autoUpdate: Boolean(s.autoUpdate),
  };
};

const encryptToken = (plain) => {
  if (!plain) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return "enc1:" + safeStorage.encryptString(plain).toString("base64");
    }
  } catch {}
  return plain;
};
const decryptToken = (stored) => {
  if (!stored) return null;
  if (typeof stored === "string" && stored.startsWith("enc1:")) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(5), "base64"));
    } catch {
      return null;
    }
  }
  return stored;
};

const readSettings = () => {
  try {
    const s = normalizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")));
    s.overlayToken = decryptToken(s.overlayToken);
    return s;
  } catch {
    return { ...defaultSettings };
  }
};

const writeSettings = (patch) => {
  const merged = normalizeSettings({
    ...readSettings(),
    ...(patch && typeof patch === "object" ? patch : {}),
  });
  const onDisk = { ...merged, overlayToken: encryptToken(merged.overlayToken) };
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(onDisk, null, 2), "utf8");
  return merged;
};

if (readSettings().compatMode) {
  app.commandLine.appendSwitch("disable-direct-composition");
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

function baseApi() {
  return readSettings().apiBaseUrl || defaultSettings.apiBaseUrl;
}

function apiUrl(pathname) {
  const suffix = String(pathname || "");
  if (!suffix) return baseApi();
  return `${baseApi()}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

function serviceOrigin() {
  try {
    const url = new URL(baseApi());
    return `${url.protocol}//${url.host}`;
  } catch {
    return defaultSettings.apiBaseUrl;
  }
}

let mainWindow = null;
let settingsWindow = null;
let gameBounds = null;
let overlayFocusActive = false;
let lastUpdaterState = { state: "idle" };
const bootGraceUntil = Date.now() + 4000;
let streamerModeActive = false;
let lastShowTs = 0;
let lastTopmostTs = 0;

const createWindow = () => {
  streamerModeActive = readSettings().streamerMode;
  const primary = screen.getPrimaryDisplay();
  mainWindow = new BrowserWindow({
    x: primary.bounds.x,
    y: primary.bounds.y,
    width: primary.bounds.width,
    height: primary.bounds.height,
    title: "IsleOverlay",
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: !readSettings().streamerMode,
    hasShadow: false,
    fullscreenable: false,
    focusable: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.setMenuBarVisibility(false);

  const distIndex = path.join(__dirname, "..", "dist", "index.html");
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (!app.isPackaged && devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(distIndex);

  mainWindow.once("ready-to-show", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.showInactive();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

function openServerSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.setAlwaysOnTop(true, "floating");
    settingsWindow.show();
    settingsWindow.focus();
    settingsWindow.moveTop();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 680,
    minHeight: 620,
    title: "IsleOverlay - Server settings",
    backgroundColor: "#07110e",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.setAlwaysOnTop(true, "floating");
  void settingsWindow.loadFile(path.join(__dirname, "server-settings.html"));
  settingsWindow.once("ready-to-show", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      settingsWindow.moveTop();
    }
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function closeServerSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
}

let radarWindow = null;

function openRadar() {
  if (radarWindow && !radarWindow.isDestroyed()) {
    radarWindow.show();
    radarWindow.focus();
    return;
  }
  const s = readSettings();
  const b = s.radarBounds || null;
  const sz = s.radarSize || 320;
  radarWindow = new BrowserWindow({
    width: b?.width ?? sz,
    height: b?.height ?? sz,
    x: b?.x,
    y: b?.y,
    minWidth: 160,
    minHeight: 160,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      devTools: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  radarWindow.setAlwaysOnTop(true, "screen-saver", 2);
  radarWindow.setMenuBarVisibility(false);

  const distIndex = path.join(__dirname, "..", "dist", "index.html");
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (!app.isPackaged && devUrl) void radarWindow.loadURL(`${devUrl}#radar`);
  else void radarWindow.loadFile(distIndex, { hash: "radar" });

  radarWindow.once("ready-to-show", () => {
    if (radarWindow && !radarWindow.isDestroyed()) radarWindow.show();
  });
  const saveBounds = () => {
    if (radarWindow && !radarWindow.isDestroyed()) writeSettings({ radarBounds: radarWindow.getBounds() });
  };
  radarWindow.on("resize", saveBounds);
  radarWindow.on("move", saveBounds);
  radarWindow.on("closed", () => {
    radarWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("radar:changed", { open: false });
  });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("radar:changed", { open: true });
}

function closeRadar() {
  if (radarWindow && !radarWindow.isDestroyed()) radarWindow.close();
}

function radarSend(channel, data) {
  if (radarWindow && !radarWindow.isDestroyed()) radarWindow.webContents.send(channel, data);
}

function setCursor(on) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  cursorOn = on;
  mainWindow.setIgnoreMouseEvents(on ? false : true, { forward: true });
  if (on) {
    if (!mainWindow.isVisible()) mainWindow.showInactive();
    mainWindow.setAlwaysOnTop(true, "screen-saver");
    mainWindow.focus();
    try { app.focus({ steal: true }); } catch {}
    if (radarWindow && !radarWindow.isDestroyed()) {
      radarWindow.setAlwaysOnTop(true, "screen-saver", 2);
      radarWindow.moveTop();
    }
  } else {
    try { mainWindow.blur(); } catch {}
  }
  mainWindow.webContents.send("overlay:cursor", on);
}

function toggleDash() {
  dashOn = !dashOn;
  setCursor(dashOn);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("overlay:dash", dashOn);
}

let tray = null;

function createTrayIcon() {
  const iconPath = path.join(__dirname, "tray.ico");
  if (fs.existsSync(iconPath)) {
    const fileIcon = nativeImage.createFromPath(iconPath);
    if (!fileIcon.isEmpty()) return fileIcon;
  }

  // Keep a visible fallback when a packaged build is missing tray.ico.
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      if (dx * dx + dy * dy > 48) continue;
      const offset = (y * size + x) * 4;
      bitmap[offset] = 166;
      bitmap[offset + 1] = 242;
      bitmap[offset + 2] = 124;
      bitmap[offset + 3] = 255;
    }
  }
  const fallback = nativeImage.createFromBitmap(bitmap, { width: size, height: size });
  if (fallback.isEmpty()) throw new Error("Could not create IsleOverlay tray icon");
  return fallback;
}

function createTray() {
  try {
    tray = new Tray(createTrayIcon());
    tray.setToolTip("IsleOverlay");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Configure", click: () => openServerSettings() },
        { type: "separator" },
        { label: "Show / hide dashboard", click: () => toggleDash() },
        { type: "separator" },
        { label: "Quit IsleOverlay", click: () => app.quit() },
      ]),
    );
    tray.on("double-click", () => toggleDash());
  } catch (error) {
    tray = null;
    console.error("IsleOverlay tray initialization failed:", error);
  }
}

function keyNameForCode(code) {
  if (!uio) return String(code);
  for (const name of Object.keys(uio.UiohookKey)) {
    if (uio.UiohookKey[name] === code) return name;
  }
  return String(code);
}

function cursorCodeFrom(cursorKey) {
  if (!uio || !cursorKey) return null;
  const named = uio.UiohookKey[cursorKey];
  if (typeof named === "number") return named;
  const n = Number(cursorKey);
  return Number.isFinite(n) ? n : null;
}

function currentCursorCode() {
  const s = readSettings();
  if (!s.cursorEnabled) return null;
  return cursorCodeFrom(s.cursorKey);
}

function startCursorHook() {
  if (!uio || uioStarted) return;
  uioStarted = true;
  uio.uIOhook.on("keydown", (e) => {
    if (recordResolve) {
      const name = keyNameForCode(e.keycode);
      writeSettings({ [recordTarget]: name });
      const r = recordResolve;
      recordResolve = null;
      r(name);
      return;
    }
    if (licenseBlocked) return;
    if (!overlayFocusActive) return;
    const dashCode = cursorCodeFrom(readSettings().dashKey);
    if (dashCode != null && e.keycode === dashCode) {
      if (!dashKeyHeld) {
        dashKeyHeld = true;
        toggleDash();
      }
      return;
    }
    const code = currentCursorCode();
    if (code == null || e.keycode !== code) return;
    if (cursorKeyHeld) return;
    cursorKeyHeld = true;
    if (readSettings().cursorMode === "hold") setCursor(true);
    else setCursor(!cursorOn);
  });
  uio.uIOhook.on("keyup", (e) => {
    const dashCode = cursorCodeFrom(readSettings().dashKey);
    if (dashCode != null && e.keycode === dashCode) dashKeyHeld = false;
    const code = currentCursorCode();
    if (code != null && e.keycode === code) {
      cursorKeyHeld = false;
      if (readSettings().cursorMode === "hold") setCursor(false);
    }
  });
  try {
    uio.uIOhook.start();
  } catch {}
}

function displayForBounds(b) {
  if (!b) return screen.getPrimaryDisplay();
  return screen.getDisplayNearestPoint({
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + b.height / 2),
  });
}

function positionOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wa = displayForBounds(gameBounds).bounds;
  const cur = mainWindow.getBounds();
  if (cur.x !== wa.x || cur.y !== wa.y || cur.width !== wa.width || cur.height !== wa.height) {
    mainWindow.setBounds(wa);
  }
}

let nw = null;
function loadNw() {
  if (nw === null) {
    try {
      nw = require("./native-windows.cjs");
    } catch {
      nw = false;
    }
  }
  return nw || null;
}

const GAME_WINDOW_RE = /theisleclient-win64|theisle-win64|isle-win64/;
let gameHwnd = null;
let lastGameScanTs = 0;

function trackGame() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const n = loadNw();
  if (!n) return;

  let activeIsGame = false;
  let activeIsOverlay = false;
  try {
    if (gameHwnd && !n.IsWindow(gameHwnd)) gameHwnd = null;
    if (!gameHwnd && Date.now() - lastGameScanTs > 3000) {
      lastGameScanTs = Date.now();
      gameHwnd = n.findWindow((_title, imagePath, pid) => {
        if (pid === process.pid) return false;
        return GAME_WINDOW_RE.test(imagePath);
      });
    }
    if (gameHwnd) {
      const b = n.windowBounds(gameHwnd);
      if (b && b.width > 0 && b.height > 0) gameBounds = b;
    }

    const fg = n.GetForegroundWindow();
    activeIsGame = Boolean(gameHwnd && fg && n.isSameWindow(fg, gameHwnd));
    activeIsOverlay = Boolean(fg && !activeIsGame && n.windowPid(fg) === process.pid);
  } catch {
  }
  const shouldShow =
    activeIsGame || activeIsOverlay || streamerModeActive || Date.now() < bootGraceUntil;
  overlayFocusActive = shouldShow;

  if (shouldShow) {
    lastShowTs = Date.now();
    positionOverlay();
    const justShown = !mainWindow.isVisible();
    if (justShown) mainWindow.showInactive();
    if (justShown || Date.now() - lastTopmostTs > 2000) {
      mainWindow.setAlwaysOnTop(true, "screen-saver");
      lastTopmostTs = Date.now();
    }
  } else if (Date.now() - lastShowTs > 1500) {
    if (mainWindow.isVisible()) mainWindow.hide();
  }
  mainWindow.webContents.send("overlay:state", {
    gameDetected: gameBounds != null,
    active: shouldShow,
    focused: activeIsGame || activeIsOverlay,
  });
}

async function apiFetch(method, pathname, body) {
  const s = readSettings();
  const headers = { Accept: "application/json", "X-Overlay-Version": "2" };
  if (s.overlayToken) headers.Authorization = `Bearer ${s.overlayToken}`;
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  try {
    const res = await net.fetch(apiUrl(pathname), init);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status, ...json };
    return json;
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

async function apiGetFile(pathname) {
  const s = readSettings();
  const headers = {};
  if (s.overlayToken) headers.Authorization = `Bearer ${s.overlayToken}`;
  try {
    const res = await net.fetch(apiUrl(pathname), { method: "GET", headers });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    const mime = res.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await res.arrayBuffer());
    return { dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

async function probeServer(rawUrl) {
  const candidate = normalizeHttpUrl(rawUrl, null);
  if (!candidate) {
    return { ok: false, error: "URL phải bắt đầu bằng http:// hoặc https://." };
  }
  try {
    const s = readSettings();
    const headers = { Accept: "application/json", "X-Overlay-Version": "2" };
    if (s.overlayToken) headers.Authorization = `Bearer ${s.overlayToken}`;
    const res = await net.fetch(`${candidate}/api/overlay/me`, { method: "GET", headers });
    const reachable = res.status === 401 || res.status === 403 || res.ok;
    return {
      ok: reachable,
      reachable,
      authenticated: res.ok,
      status: res.status,
      url: candidate,
      message: reachable
        ? res.ok
          ? "API phản hồi thành công."
          : "Server đã phản hồi; cần đăng nhập Steam hoặc token hợp lệ."
        : "Server phản hồi nhưng không tìm thấy endpoint overlay ở URL này.",
    };
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      url: candidate,
      error: String(err && err.message ? err.message : err),
    };
  }
}

const WebSocket = require("ws");
let liveWs = null;
let liveBackoff = 1000;
let liveTimer = null;
let liveStopped = false;

function baseWs() {
  return baseApi().replace(/^http/i, "ws");
}

function scheduleLiveReconnect() {
  if (liveStopped || liveTimer) return;
  if (!readSettings().overlayToken) return;
  liveTimer = setTimeout(() => {
    liveTimer = null;
    connectLive();
  }, liveBackoff);
  liveBackoff = Math.min(liveBackoff * 2, 15000);
}

async function sendOverlayHello(ws, token) {
  let name = "";
  try {
    const res = await fetch(apiUrl("/api/overlay/me"), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const me = await res.json();
      name = typeof me?.personaName === "string" ? me.personaName : typeof me?.name === "string" ? me.name : "";
    }
  } catch {}
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "hello", name }));
  } catch {}
}

// IslePilot deployments may wrap live messages with different field names.
function extractLivePayload(frame) {
  if (!frame || ![frame.t, frame.type, frame.event].includes("live")) return null;
  const payload = frame.d ?? frame.data ?? frame.payload ?? frame;
  return payload && typeof payload === "object" ? payload : null;
}

function connectLive() {
  liveStopped = false;
  const token = readSettings().overlayToken;
  if (!token) return;
  if (liveWs) {
    try {
      liveWs.removeAllListeners();
      liveWs.terminate();
    } catch {}
    liveWs = null;
  }
  let ws;
  try {
    ws = new WebSocket(`${baseWs()}/ows`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    scheduleLiveReconnect();
    return;
  }
  liveWs = ws;
  ws.on("open", () => {
    liveBackoff = 1000;
    sendOverlayHello(ws, token);
  });
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        mainWindow.webContents.send("overlay:troll-audio", buf);
      }
      return;
    }
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const livePayload = extractLivePayload(frame);
    if (livePayload) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("overlay:live", livePayload);
      radarSend("overlay:live", livePayload);
    } else if (frame && frame.t === "troll") {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("overlay:troll", frame);
    } else if (frame && frame.type === "ticket") {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("overlay:ticket", frame);
    }
  });
  ws.on("close", () => {
    if (liveWs === ws) liveWs = null;
    scheduleLiveReconnect();
  });
  ws.on("error", () => {
    try {
      ws.terminate();
    } catch {}
  });
}

function stopLive() {
  liveStopped = true;
  if (liveTimer) {
    clearTimeout(liveTimer);
    liveTimer = null;
  }
  if (liveWs) {
    try {
      liveWs.removeAllListeners();
      liveWs.terminate();
    } catch {}
    liveWs = null;
  }
}

ipcMain.handle("overlay:getSettings", () => {
  const s = readSettings();
  return { ...s, apiBaseUrl: baseApi() };
});
ipcMain.handle("overlay:setSettings", (_e, next) => {
  const prev = readSettings();
  const merged = writeSettings(next);
  const endpointChanged =
    merged.apiBaseUrl !== prev.apiBaseUrl ||
    merged.useServerPathAsApiPrefix !== prev.useServerPathAsApiPrefix;
  if (endpointChanged) {
    stopLive();
    if (merged.overlayToken) connectLive();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setOpacity(merged.opacity);
    if (typeof next?.streamerMode === "boolean" && merged.streamerMode !== prev.streamerMode) {
      streamerModeActive = merged.streamerMode;
      mainWindow.setSkipTaskbar(!merged.streamerMode);
      if (merged.streamerMode && !mainWindow.isVisible()) mainWindow.showInactive();
    }
    mainWindow.webContents.send("settings:changed", merged);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("settings:changed", merged);
  }
  return merged;
});
ipcMain.handle("overlay:getState", () => ({ gameDetected: gameBounds != null }));
ipcMain.handle("overlay:mouseIgnore", (_e, ignore) => {
  if (cursorOn) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  }
});
ipcMain.handle("overlay:quit", () => app.quit());
ipcMain.handle("server:closeSettings", () => closeServerSettings());

ipcMain.handle("radar:toggle", () => {
  if (radarWindow && !radarWindow.isDestroyed()) {
    closeRadar();
    writeSettings({ radarOpen: false });
    return false;
  }
  openRadar();
  writeSettings({ radarOpen: true });
  return true;
});
ipcMain.handle("radar:close", () => {
  closeRadar();
  writeSettings({ radarOpen: false });
});
ipcMain.handle("radar:isOpen", () => radarWindow != null && !radarWindow.isDestroyed());
ipcMain.handle("radar:getBounds", () =>
  radarWindow && !radarWindow.isDestroyed() ? radarWindow.getBounds() : null,
);
ipcMain.handle("radar:setBounds", (_e, b) => {
  if (radarWindow && !radarWindow.isDestroyed() && b) {
    radarWindow.setBounds({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.max(160, Math.round(b.width)),
      height: Math.max(160, Math.round(b.height)),
    });
    writeSettings({ radarBounds: radarWindow.getBounds() });
  }
});

ipcMain.handle("skin:send", (_e, state) => {
  if (liveWs && liveWs.readyState === WebSocket.OPEN && state && typeof state === "object") {
    try {
      liveWs.send(JSON.stringify({ t: "liveskin", d: state }));
    } catch {}
  }
});

function recordKey(target) {
  if (!uio) return Promise.resolve(null);
  startCursorHook();
  recordTarget = target;
  return new Promise((resolve) => {
    if (recordResolve) recordResolve(null);
    recordResolve = resolve;
    setTimeout(() => {
      if (recordResolve === resolve) {
        recordResolve = null;
        resolve(null);
      }
    }, 10000);
  });
}

ipcMain.handle("cursor:recordKey", () => recordKey("cursorKey"));
ipcMain.handle("dash:recordKey", () => recordKey("dashKey"));

ipcMain.handle("overlay:dashOpen", (_e, open) => {
  dashOn = !!open;
  setCursor(!!open);
});

ipcMain.handle("auth:steamLogin", () => {
  void shell.openExternal(apiUrl("/api/overlay/auth/steam"));
  return { pending: true };
});
ipcMain.handle("auth:getAuth", () => {
  const s = readSettings();
  return { steamId: s.steamId, authed: Boolean(s.overlayToken) };
});
ipcMain.handle("auth:logout", () => {
  writeSettings({ steamId: null, overlayToken: null });
  stopLive();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("auth:changed", { steamId: null });
});

ipcMain.handle("api:get", (_e, pathname) => apiFetch("GET", String(pathname)));
ipcMain.handle("api:post", (_e, pathname, body) => apiFetch("POST", String(pathname), body ?? {}));
ipcMain.handle("api:getfile", (_e, pathname) => apiGetFile(String(pathname)));
ipcMain.handle("server:probe", (_e, rawUrl) => probeServer(String(rawUrl || "")));
ipcMain.handle("server:openSettings", () => {
  openServerSettings();
  return true;
});

let mapCatalogCache = null;

function readJsonArray(fileName) {
  const dirs = [
    process.resourcesPath ? path.join(process.resourcesPath, "resources") : null,
    path.join(app.getAppPath(), "resources"),
    path.join(process.cwd(), "resources"),
    path.join(__dirname, "..", "resources"),
  ].filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, fileName);
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
    }
  }
  return [];
}

ipcMain.handle("mapedit:getCatalog", () => {
  if (mapCatalogCache) return mapCatalogCache;
  const meshes = readJsonArray("sm_files.json")
    .map((x) => ({
      path: typeof x?.path === "string" ? x.path : "",
      name: typeof x?.name === "string" ? x.name : "",
    }))
    .filter((x) => x.path && x.name);
  const blueprints = readJsonArray("bp_files.json")
    .map((x) => ({
      path: typeof x?.path === "string" ? x.path : "",
      name: typeof x?.name === "string" ? x.name : "",
      category: typeof x?.category === "string" && x.category ? x.category : "Uncategorized",
    }))
    .filter((x) => x.path && x.name);
  mapCatalogCache = { meshes, blueprints };
  return mapCatalogCache;
});

ipcMain.handle("updater:restart", () => {
  if (!app.isPackaged || !readSettings().autoUpdate) return false;
  try {
    autoUpdater.quitAndInstall(false, true);
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle("updater:check", () => {
  if (!app.isPackaged || !readSettings().autoUpdate) return false;
  autoUpdater.checkForUpdates().catch(() => {});
  return true;
});
ipcMain.handle("updater:getState", () => lastUpdaterState);

const AUTH_PROTOCOLS = ["isleoverlay", "isle-overlay"];
for (const protocol of AUTH_PROTOCOLS) {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(protocol, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(protocol);
  }
}

function isAuthDeepLink(rawUrl) {
  return (
    typeof rawUrl === "string" &&
    AUTH_PROTOCOLS.some((protocol) => rawUrl.indexOf(`${protocol}://`) === 0)
  );
}

function handleDeepLink(rawUrl) {
  if (!isAuthDeepLink(rawUrl)) return;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  const sid = parsed.searchParams.get("sid");
  const token = parsed.searchParams.get("token");
  if (!sid || !/^\d{17}$/.test(sid)) return;
  const saved = writeSettings({ steamId: sid, overlayToken: token || null });
  connectLive();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("auth:changed", { steamId: saved.steamId });
    if (!mainWindow.isVisible()) mainWindow.showInactive();
  }
}

let licenseBlocked = false;

function applyLicense() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("overlay:blocked", licenseBlocked);
    if (licenseBlocked && !mainWindow.isVisible()) mainWindow.showInactive();
  }
  if (licenseBlocked) {
    try { closeRadar(); } catch {}
    try { setCursor(false); } catch {}
  }
}

async function checkLicense() {
  try {
    const res = await fetch(`${serviceOrigin()}/cdn/launcher/status.yml`, { cache: "no-store" });
    if (!res.ok) return;
    const text = await res.text();
    licenseBlocked = /wrightynice\s*[:=]\s*false/i.test(text);
    applyLicense();
  } catch {
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (argv.includes("--configure") || argv.includes("--settings")) {
      openServerSettings();
    }
    const url = argv.find((a) => isAuthDeepLink(a));
    if (url) handleDeepLink(url);
  });
  app.on("open-url", (_e, url) => handleDeepLink(url));

  app.whenReady().then(() => {
    const firstRun = !fs.existsSync(SETTINGS_FILE());
    const configureRequested = process.argv.includes("--configure") || process.argv.includes("--settings");
    createWindow();
    createTray();
    const boot = readSettings();
    mainWindow.setOpacity(boot.opacity);
    connectLive();
    startCursorHook();
    initAutoUpdate();
    void trackGame();
    setInterval(() => {
      void trackGame();
    }, 700);
    void checkLicense();
    setInterval(() => {
      void checkLicense();
    }, 5 * 60 * 1000);
    const startUrl = process.argv.find((a) => isAuthDeepLink(a));
    if (startUrl) handleDeepLink(startUrl);
    if (firstRun || configureRequested) setTimeout(() => openServerSettings(), 500);
  });
}

app.on("before-quit", () => {
  try {
    if (uio && uioStarted) uio.uIOhook.stop();
  } catch {}
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function initAutoUpdate() {
  if (!app.isPackaged || !readSettings().autoUpdate) return;
  try {
    autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const emit = (payload) => {
      lastUpdaterState = payload;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("updater:event", payload);
    };
    autoUpdater.on("update-available", (i) => emit({ state: "available", version: i && i.version }));
    autoUpdater.on("update-not-available", () => emit({ state: "none" }));
    autoUpdater.on("download-progress", (p) => emit({ state: "downloading", percent: p ? Math.round(p.percent) : 0 }));
    autoUpdater.on("update-downloaded", (i) => {
      emit({ state: "downloaded", version: i && i.version });
      setTimeout(() => {
        try { autoUpdater.quitAndInstall(true, true); } catch {}
      }, 1500);
    });
    autoUpdater.on("error", (e) => emit({ state: "error", message: e && (e.message || String(e)) }));
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 10 * 60 * 1000);
  } catch {
  }
}
