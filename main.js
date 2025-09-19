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
const { app, BrowserWindow } = require('electron');
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
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    webPreferences: { nodeIntegration: false },
    autoHideMenuBar: true,
    // Set a meaningful title including the app version
    title: `x32-router v${pkg.version}`
  });
  // If running in dev mode, use local server; otherwise, load the packaged index.html
  const isDev = process.env.NODE_ENV === 'development' || process.env.ELECTRON_DEV === 'true';
  if (isDev) {
    win.loadURL(`http://localhost:${SERVER_PORT}`);
  } else {
    win.loadFile(path.join(__dirname, 'public', 'index.html'));
  // DevTools are not opened in packaged app
  }
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
