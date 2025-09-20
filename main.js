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
const SERVER_PORT = process.env.PORT || 3000;
const { app, BrowserWindow, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
// Read package.json version to show in window title
const pkg = require(path.join(__dirname, 'package.json'));

// Only start the server if not already started
let serverStarted = false;
try {
  require.resolve('./server.js');
  if (!serverStarted) {
    require('./server.js');
    serverStarted = true;
  }
} catch (e) {
  console.error('Could not start server.js:', e);
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
    title: `x32-router v${pkg.version}`
  };
  if (fs.existsSync(possibleIcon)) winOpts.icon = possibleIcon;
  const win = new BrowserWindow(winOpts);
  // If running in dev mode, use local server; otherwise, load the packaged index.html
  const isDev = process.env.NODE_ENV === 'development' || process.env.ELECTRON_DEV === 'true';
  if (isDev) {
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
    createWindow();
  } else {
    // Wait for server to be ready (packaged app's main process starts server.js)
    const ok = await waitForServer(SERVER_PORT, { attempts: 40, delay: 200 });
    if (!ok) console.warn('Timed out waiting for local server to start; creating window anyway.');
    const win = createWindow();
    // Ensure title is preserved after renderer loads
    try { win.setTitle(`x32-router v${pkg.version}`); } catch (e) {}
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
