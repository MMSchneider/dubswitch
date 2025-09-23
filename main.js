/*
  main.js
  -------
  Electron launcher used when packaging the app as a desktop application.

  Responsibilities
  - Start the local Express server (server.js) unless it's already running.
  - Wait for the server's /version endpoint to be available before creating
    the Electron BrowserWindow (packaged app startup flow).
  - Create the application window and load either the local server URL
    (development mode) or the packaged index.html (production).

  The file intentionally keeps the Electron integration minimal — the
  server remains the central authority for device communication and
  persistence.
*/
// Resolve persisted port file path within Electron's userData so writes are allowed
let PERSIST_FILE = null;
try {
  // app.getPath('userData') is available after app module is loaded
  PERSIST_FILE = require('path').join(app.getPath('userData'), 'server.port');
} catch (e) { /* fallback below */ }

// Read persisted port from userData if present; otherwise fall back to env or default
function readPersistedPort(defaultPort) {
  try {
    const fs = require('fs'); const path = require('path');
    const dir = app.getPath('userData');
    const file = path.join(dir, 'server.port');
    if (fs.existsSync(file)) {
      const txt = fs.readFileSync(file, 'utf8').trim();
      const n = Number(txt || ''); if (n && n > 0 && n <= 65535) return n;
    }
  } catch (_) {}
  const nEnv = Number(process.env.PORT || '') || null; if (nEnv) return nEnv;
  return defaultPort;
}

let SERVER_PORT = readPersistedPort(3000);
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
// Read package.json version to show in window title
const pkg = require(path.join(__dirname, 'package.json'));

// Supervise the local Node server as a child process when running packaged.
// This ensures clean restarts when the server exits (for example after a port
// change) and keeps server stdout/stderr visible in main process logs.
const { spawn } = require('child_process');
let serverProc = null;
let serverRestartAttempts = 0;
let serverRestartTimer = null;
let lastServerExit = { code: null, signal: null, time: null };

function startServerProcess() {
  if (serverProc && !serverProc.killed) return;
  try {
    const node = process.execPath;
    const serverScript = path.join(__dirname, 'server.js');
    const args = [serverScript];
  // When running packaged under Electron, process.execPath points at the
  // electron binary. In that case we must instruct the electron binary to
  // run the child script in 'node' mode to avoid launching a second GUI
  // instance. Setting ELECTRON_RUN_AS_NODE=1 makes Electron behave like
  // a plain Node runtime for the spawned process.
  // Instruct the child server where to keep the persisted port file
  const env = Object.assign({}, process.env, {
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(SERVER_PORT),
    DUBSWITCH_PORT_FILE: PERSIST_FILE || path.join(app.getPath('userData'), 'server.port')
  });
    // Keep working dir stable
  // Use the Electron userData directory for working dir and logs so the
  // packaged app does not attempt to write into the bundle or a read-only
  // root filesystem. app.getPath('userData') is per-user and writable.
  const DATA_DIR = app.getPath && typeof app.getPath === 'function' ? app.getPath('userData') : process.cwd();
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* ignore */ }
  serverProc = spawn(node, args, { cwd: DATA_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Setup persistent log file for the child process with a minimal rotation
  try {
  const LOG_PATH = path.join(DATA_DIR, 'server_child.log');
      const MAX_BYTES = 5 * 1024 * 1024; // 5MB
      try {
        if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_BYTES) {
          const old = LOG_PATH + '.old';
          try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch (e) {}
          fs.renameSync(LOG_PATH, old);
        }
      } catch (e) {}
      const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
      serverProc.stdout.on('data', d => { process.stdout.write('[server] ' + d); try { logStream.write('[OUT] ' + d); } catch (e) {} });
      serverProc.stderr.on('data', d => { process.stderr.write('[server] ' + d); try { logStream.write('[ERR] ' + d); } catch (e) {} });
      serverProc.on('exit', () => { try { logStream.end(); } catch (e) {} });
    } catch (logErr) {
      serverProc.stdout.on('data', d => process.stdout.write('[server] ' + d));
      serverProc.stderr.on('data', d => process.stderr.write('[server] ' + d));
    }
    serverProc.on('exit', (code, signal) => {
      console.log(`Local server process exited (code=${code}, signal=${signal})`);
      serverProc = null;
      lastServerExit = { code: code, signal: signal, time: Date.now() };
      serverRestartAttempts++;
      // Exponential backoff with cap (ms)
      const backoff = Math.min(30000, 1000 * Math.pow(2, Math.min(serverRestartAttempts, 6)));
      console.log(`Restarting server in ${backoff}ms (attempt ${serverRestartAttempts})`);
      serverRestartTimer = setTimeout(() => { startServerProcess(); }, backoff);
    });
    console.log('Spawned local server process pid=' + serverProc.pid);
    // Reset attempts after a successful spawn
    serverRestartAttempts = 0;
  } catch (e) {
    console.error('Failed to spawn server process:', e && e.message);
  }
}

function stopServerProcess() {
  if (serverRestartTimer) { clearTimeout(serverRestartTimer); serverRestartTimer = null; }
  if (serverProc) {
    try { serverProc.kill('SIGTERM'); } catch (e) { /* ignore */ }
    serverProc = null;
  }
}

function createWindow() {
  // Try to surface a window icon when available (helps on Windows/Linux and
  // packaged macOS builds where an .icns is provided inside Resources)
  const possibleIcon = path.join(__dirname, 'resources', 'dubswitch.icns');
  const winOpts = {
    width: 1100,
    height: 800,
    webPreferences: { nodeIntegration: false },
    autoHideMenuBar: true,
    // Set a meaningful title including the app version
  title: `dubswitch v${pkg.version}`
  };
  if (fs.existsSync(possibleIcon)) winOpts.icon = possibleIcon;
  // Add a preload script so the renderer can request main-process actions
  // (exposed safely via contextBridge). Keep contextIsolation enabled.
  winOpts.webPreferences = Object.assign(winOpts.webPreferences || {}, {
    contextIsolation: true,
    preload: path.join(__dirname, 'preload.js')
  });
  const win = new BrowserWindow(winOpts);
  // If running in dev mode, use local server; otherwise, load the packaged index.html
  const isDev = process.env.NODE_ENV === 'development' || process.env.ELECTRON_DEV === 'true';
  if (isDev) {
    // Re-read persisted port in case it was changed before window creation
    SERVER_PORT = readPersistedPort(SERVER_PORT || 3000);
    win.loadURL(`http://localhost:${SERVER_PORT}`);
  } else {
    win.loadFile(path.join(__dirname, 'public', 'index.html'));
  // DevTools are not opened in packaged app
  }
  // Optionally open DevTools: allow forcing via ELECTRON_OPEN_DEVTOOLS=1 or ELECTRON_DEVTOOLS=true
  try {
    // Only auto-open DevTools when explicitly requested via env var. The
    // application menu provides a runtime toggle instead of always opening in dev.
    const openDev = Boolean(process.env.ELECTRON_OPEN_DEVTOOLS === '1' || process.env.ELECTRON_DEVTOOLS === 'true');
    if (openDev && win && win.webContents) {
      // Use detached mode so the inspector is separate from the app window
      win.webContents.openDevTools({ mode: 'detach' });
    }
  } catch (e) { /* ignore */ }
  return win;
}

// Setup the application menu including a Toggle DevTools item so users can
// open/close DevTools at runtime. The click handler toggles the focused
// BrowserWindow's webContents.
function setupMenu() {
  try {
    const template = [];
    // macOS: provide a proper app menu so the app name and icon appear in the
    // global menu bar. This also makes the UI feel native.
    if (process.platform === 'darwin') {
      template.push({
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services', submenu: [] },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideothers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      });
    } else {
      // Non-mac platforms: add a File menu with common actions
      template.push({ role: 'fileMenu' });
    }

    // View menu (common) — includes the Toggle DevTools action
    template.push({
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forcereload' },
        { type: 'separator' },
        {
          label: 'Toggle DevTools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: (menuItem, browserWindow) => {
            const win = browserWindow || BrowserWindow.getFocusedWindow();
            if (win && win.webContents) win.webContents.toggleDevTools();
          }
        }
      ]
    });
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  } catch (e) { console.warn('Failed to setup application menu', e && e.message); }
}

// Wait for the local HTTP server to respond before creating the renderer window.
function waitForServer(port, opts = {}) {
  const http = require('http');
  const attempts = opts.attempts || 20;
  const delay = opts.delay || 200; // ms
  let tries = 0;
  return new Promise(resolve => {
    const tryOnce = () => {
      const req = http.request({ method: 'GET', host: '127.0.0.1', port, path: '/version', timeout: 1000 }, res => {
        // any successful response means the server is up
        resolve(true);
      });
      req.on('error', () => {
        tries++;
        if (tries >= attempts) return resolve(false);
        setTimeout(tryOnce, delay);
      });
      req.on('timeout', () => {
        req.destroy();
        tries++;
        if (tries >= attempts) return resolve(false);
        setTimeout(tryOnce, delay);
      });
      req.end();
    };
    tryOnce();
  });
}

app.whenReady().then(async () => {
  // Install the application menu so users can toggle DevTools at runtime
  setupMenu();
  const isDev = process.env.NODE_ENV === 'development' || process.env.ELECTRON_DEV === 'true';
  if (isDev) {
    // Ensure we wait on correct port (from persisted file or env)
    SERVER_PORT = readPersistedPort(SERVER_PORT || 3000);
    createWindow();
  } else {
    // Start and supervise the server as a child process when no external
    // server is already running. If an external process (developer or user)
    // is already listening on the configured port we avoid spawning a
    // supervised child to prevent EADDRINUSE errors and UDP port conflicts.
  SERVER_PORT = readPersistedPort(SERVER_PORT || 3000);
  const alreadyRunning = await waitForServer(SERVER_PORT, { attempts: 3, delay: 200 });
    if (alreadyRunning) {
      console.log(`Detected existing server on port ${SERVER_PORT}; skipping supervised spawn.`);
    } else {
      startServerProcess();
    }
    // Wait for server to be ready before creating the window (but don't block forever)
  const ok = await waitForServer(SERVER_PORT, { attempts: 40, delay: 200 });
    if (!ok) console.warn('Timed out waiting for local server to start; creating window anyway.');
    const win = createWindow();
    // Ensure title is preserved after renderer loads
  try { win.setTitle(`dubswitch v${pkg.version}`); } catch (e) {}
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

  // IPC handler: open a new origin in the existing BrowserWindow. This lets the
  // packaged renderer ask the main process to load http://localhost:PORT so the
  // UI is no longer file:// and assets/paths behave as if served from the
  // local HTTP server.
  // No 'open-origin' IPC handler — origin switching is handled by persisting
  // the chosen port and restarting the app so the server starts on the new port.

// IPC: support renderer-requested restart when running under Electron.
try {
  ipcMain.handle('restart-app', async () => {
    try {
      app.relaunch();
      setTimeout(() => { try { app.exit(0); } catch (e) { process.exit(0); } }, 120);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
} catch (e) { /* ignore when not running under Electron */ }

// IPC: quit application without relaunch (used after port change per UX)
try {
  ipcMain.handle('quit-app', async () => {
    try {
      setTimeout(() => { try { app.exit(0); } catch (e) { process.exit(0); } }, 50);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
} catch (e) { /* ignore */ }

// IPC to restart only the supervised server process (used by the renderer Save Port flow)
try {
  ipcMain.handle('restart-server', async () => {
    try {
      stopServerProcess();
      // Small delay to let process exit cleanly before restarting
      await new Promise(r => setTimeout(r, 220));
      startServerProcess();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
} catch (e) { /* ignore when not running under Electron */ }

// IPC to retrieve the supervised server log for diagnostics in the renderer
try {
  ipcMain.handle('get-server-log', async () => {
    // Backward-compatible handler: when no args are provided, return full log.
    try {
      const LOG_PATH = path.join(process.cwd(), 'server_child.log');
      if (!fs.existsSync(LOG_PATH)) return { ok: false, error: 'log_missing' };
      const args = arguments[0] || {};
      const offset = Number(args.offset) || 0;
      const length = args.length ? Number(args.length) : null;
      const stat = fs.statSync(LOG_PATH);
      const size = stat.size;
      // If offset is negative, treat as tail from end
      let readStart = offset;
      if (offset < 0) readStart = Math.max(0, size + offset);
      if (readStart > size) readStart = size;
      if (!length) {
        // Read to end
        const data = fs.readFileSync(LOG_PATH, 'utf8').slice(readStart);
        return { ok: true, log: data, size };
      }
      // Read slice
      const fd = fs.openSync(LOG_PATH, 'r');
      const buf = Buffer.alloc(Math.min(length, Math.max(0, size - readStart)));
      fs.readSync(fd, buf, 0, buf.length, readStart);
      fs.closeSync(fd);
      return { ok: true, log: buf.toString('utf8'), size };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
} catch (e) { /* ignore when not running under Electron */ }

// Expose server status (last exit, running state)
try {
  ipcMain.handle('get-server-status', async () => {
    try {
      return { ok: true, running: !!serverProc, lastExit: lastServerExit };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  });
} catch (e) { /* ignore */ }

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
