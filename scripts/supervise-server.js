#!/usr/bin/env node
// Supervisor for server.js (dev): uses fs.watch for server.port changes and
// captures child stdout/stderr into server_child.log with simple rotation.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server.js');
const PORT_FILE = path.join(ROOT, 'server.port');
const LOG_FILE = path.join(ROOT, 'server_child.log');
const LOG_ROTATE_SIZE = 5 * 1024 * 1024; // 5MB

let child = null;
let attempts = 0;
let restarting = false;
let watchHandle = null;
let debounceTimer = null;

function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size >= LOG_ROTATE_SIZE) {
      const old = LOG_FILE + '.old';
      try { fs.unlinkSync(old); } catch (e) {}
      fs.renameSync(LOG_FILE, old);
      console.log('[supervisor] rotated log to', old);
    }
  } catch (e) {
    // file may not exist yet — that's fine
  }
}

function createLogStreams() {
  rotateLogIfNeeded();
  const w = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  return w;
}

function startChild() {
  attempts++;
  const backoff = Math.min(30, Math.pow(2, Math.min(6, attempts))); // seconds
  console.log(`[supervisor] starting server (attempt ${attempts})`);
  const out = createLogStreams();
  child = spawn(process.execPath, [SERVER_JS], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', (d) => { process.stdout.write(d); out.write(d); });
  child.stderr.on('data', (d) => { process.stderr.write(d); out.write(d); });

  child.on('exit', (code, signal) => {
    out.end();
    console.log(`[supervisor] server exited with code=${code} signal=${signal}`);
    child = null;
    // If we intentionally triggered a restart, start immediately
    if (restarting) {
      restarting = false;
      attempts = 0;
      console.log('[supervisor] restarting server immediately (triggered)');
      startChild();
      return;
    }
    // Otherwise apply backoff
    console.log(`[supervisor] will restart in ${backoff}s`);
    setTimeout(startChild, backoff * 1000);
  });
}

function stopChild() {
  if (!child) return;
  try {
    console.log('[supervisor] stopping child process');
    child.kill('SIGTERM');
  } catch (e) { console.error('[supervisor] error killing child', e); }
}

function triggerRestart(reason) {
  console.log('[supervisor] triggerRestart:', reason);
  restarting = true;
  stopChild();
}

// Watch the port file using fs.watch and debounce rapid events
function watchPortFile() {
  try {
    if (watchHandle) watchHandle.close();
    // Ensure file exists before watching
    try { fs.statSync(PORT_FILE); } catch (e) { fs.writeFileSync(PORT_FILE, ''); }
    watchHandle = fs.watch(PORT_FILE, (ev) => {
      // debounce: wait 200ms to coalesce rapid updates
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        triggerRestart('port-file-changed');
      }, 200);
    });
    console.log('[supervisor] watching', PORT_FILE);
  } catch (e) {
    console.warn('[supervisor] fs.watch failed; falling back to polling');
    // fallback: simple poll
    setInterval(() => {
      try {
        const st = fs.statSync(PORT_FILE);
        const m = String(st.mtimeMs);
        if (!watchPortFile._last || watchPortFile._last !== m) {
          watchPortFile._last = m;
          triggerRestart('port-file-poll');
        }
      } catch (e) {}
    }, 1000);
  }
}

// Start supervisor
watchPortFile();
startChild();

process.on('SIGINT', () => { console.log('[supervisor] SIGINT, shutting down'); stopChild(); process.exit(0); });
process.on('SIGTERM', () => { console.log('[supervisor] SIGTERM, shutting down'); stopChild(); process.exit(0); });

// Keep the supervisor alive
process.stdin.resume();
// Simple supervisor for server.js used during development.
