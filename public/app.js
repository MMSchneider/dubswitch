/*
  public/app.js
  ----------------
  Front-end application logic for the DubSwitch UI.

  Purpose
  - Manage WebSocket communication with the local server.
  - Present the channel grid (1..32) and allow toggling inputs.
  - Provide the Settings / Matrix UI used to configure per-block and
    per-channel A/B mappings (LocalIns, UserIns, DAW, AES50X, Custom).
  - Infer a sensible default matrix from the live device state when
    the server hasn't provided a persisted one.

  High-level concepts / data shapes
  - blocks: Array of 4 block descriptors (1-8, 9-16, 17-24, 25-32)
      { label, userin, localin }

  - routingState: [v0, v1, v2, v3] numeric values representing each
    block's current route as provided by the X32 device.

  - userPatches: map ch -> numeric value representing /config/userrout/in/NN

  - toggleMatrix: persisted mapping (from server or inferred) with shape:
      { blocks: [ { id, toggleAction, switchAllAction, param, overrides } ... ],
        channelMap: { '01': { aAction, bAction, param }, ... } }

  - channelMatrix: runtime per-channel mapping derived from toggleMatrix
      keys 1..32 -> { aAction, bAction, param }

  WebSocket message contract (subset used by this client)
  - From server: {type: 'ping'|'routing'|'clp'|'channel_names'|'matrix'|...}
  - To server:   {type: 'clp'|'load_routing'|'set_x32_ip'|'get_matrix'|'set_matrix'|...}

  Important functions (documented inline below)
  - safeSendWs(data) : send on ws only when open (with once-open fallback)
  - createWs(url)    : establish WS and wire handlers
  - handleWsMessage  : central handler for incoming WS messages
  - computeValueForAction(ch, action, param): compute numeric CLP value
  - buildMatrixFromCurrentState(): create a sensible toggleMatrix if missing
  - renderUserPatches()/renderRoutingTable()/renderMatrix()/renderPerChannelMatrix(): UI renderers

  Notes
  - This file contains UI logic and optimistic updates (client-side) — the server
    is authoritative for persisted matrix and device routing. The client will
    request the server matrix at startup (get_matrix) and will auto-save
    inferred matrices if the user opted into autosave.
*/

// --- Debug logging helpers ---------------------------------------------------
// Enable verbose logging automatically for localhost and file://, or when
// window.__DUBSWITCH_DEBUG__ === true, or query param ?debug=1
const DEBUG_ON = (function(){
  try {
    if (typeof window !== 'undefined') {
      if (window.__DUBSWITCH_DEBUG__ === true) return true;
      if (/[?&]debug=1\b/.test((location && location.search) || '')) return true;
      if (location && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return true;
      if (location && location.protocol === 'file:') return true;
    }
  } catch (e) {}
  return false;
})();
function dbg(){ try { if (DEBUG_ON) { const a = Array.from(arguments); a.unshift('[DubSwitch]'); console.log.apply(console, a); } } catch (e) {} }
// Global error surface
try {
  window.addEventListener('error', function(ev){ try { dbg('window error:', ev && ev.message, ev && ev.filename, ev && ev.lineno + ':' + ev.colno); } catch (e) {} });
  window.addEventListener('unhandledrejection', function(ev){ try { dbg('unhandledrejection:', ev && (ev.reason && ev.reason.message ? ev.reason.message : ev.reason)); } catch (e) {} });
} catch (e) {}

// Helper to send via WebSocket only when open
// Send data over the global WebSocket if it's open. If the socket is not
// yet open, attach a one-time 'open' listener to send once the connection
// becomes ready. This prevents losing messages during startup when the
// connection may still be initializing.
function safeSendWs(data) {
  if (window.ws && window.ws.readyState === 1) {
    dbg('WS send (open):', (typeof data === 'string' ? data.slice(0, 160) : data));
    window.ws.send(data);
  } else {
    // Wait for connection, then send once
    if (window.ws) {
      const onceOpen = () => {
        if (window.ws && window.ws.readyState === 1) {
          dbg('WS send (deferred until open):', (typeof data === 'string' ? data.slice(0, 160) : data));
          window.ws.send(data);
        }
        window.ws.removeEventListener('open', onceOpen);
      };
      dbg('WS not open yet; deferring send until open. readyState=', window.ws && window.ws.readyState);
      window.ws.addEventListener('open', onceOpen);
    }
  }
}

// --- Safe defaults / shims for missing globals (prevent page errors) ---
// Gate the larger compatibility shims behind a dev-only flag so production
// builds are not polluted. The small, essential stubs used by inline HTML
// event handlers remain always-present to avoid ReferenceErrors.
const IS_DEV = (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || window.__DUBSWITCH_DEV_SHIMS__ === true);

// API origin helper: when running as a packaged app (file://) the renderer
// cannot use relative URLs like '/status'. Provide a getter that prefers:
// 1) window.__DUBSWITCH_API_ORIGIN__ (programmatic override)
// 2) localStorage 'dubswitch_api_origin' (persisted via Settings)
// 3) file:// fallback -> http://localhost:3000
// 4) empty string for normal web context (use relative URLs)
function getApiOrigin() {
  try {
    if (window.__DUBSWITCH_API_ORIGIN__) return String(window.__DUBSWITCH_API_ORIGIN__);
    const stored = (typeof localStorage !== 'undefined') ? localStorage.getItem('dubswitch_api_origin') : null;
    if (stored) { dbg('getApiOrigin: using stored origin', stored); return stored; }
    if (location && location.protocol === 'file:') { dbg('getApiOrigin: file:// fallback -> http://localhost:3000'); return 'http://localhost:3000'; }
    dbg('getApiOrigin: empty (use relative URLs)');
    return '';
  } catch (e) { return ''; }
}

function apiUrl(path) {
  if (!path) path = '/';
  const API_ORIGIN = getApiOrigin();
  if (API_ORIGIN) {
    // ensure there's a single slash between origin and path
    const u = API_ORIGIN.replace(/\/$/, '') + (path.startsWith('/') ? path : ('/' + path));
    dbg('apiUrl:', path, '=>', u);
    return u;
  }
  dbg('apiUrl (relative):', path);
  return path;
}

// NOTE: Origin probing and automatic fallback logic removed. The app will
// use the configured API origin (localStorage / runtime override) or the
// current location. When the user changes the port the server persists the
// choice and exits so the application can be restarted on the new port.

// Minimal DOM element fallbacks used by various functions below. If the
// real element exists, these will be replaced by actual nodes during
// normal runtime (DOMContentLoaded handlers). These placeholders prevent
// attempts to access properties of `null`.
const _noopEl = () => ({ disabled: false, style: {}, innerHTML: '', textContent: '', addEventListener() {}, removeEventListener() {} });
window.statusEl = document.getElementById('status') || _noopEl();
window.toggleInputsBtn = document.getElementById('toggle-inputs') || _noopEl();
// routingTable element removed from UI; keep a safe reference as a no-op
window.routingTable = _noopEl();
window.userpatchContainer = document.getElementById('userpatch-container') || _noopEl();

// Minimal connect dialog helpers (safe no-op implementations when original
// dialog code was removed). These are lightweight: they update the header
// status text and create a transient on-screen overlay when invoked.
window.connectDialogTimeout = window.connectDialogTimeout || null;
window.initialConnectShown = window.initialConnectShown || false;
function showConnectDialog(force) {
  try {
    dbg('showConnectDialog(force=', !!force, ')');
    initialConnectShown = true;
    if (window.statusEl && window.statusEl.textContent !== undefined) {
      window.statusEl.textContent = 'Local: Connecting…';
    }
    // create a small overlay if none exists (non-blocking)
    let el = document.getElementById('connect-overlay');
    if (!el && force) {
      el = document.createElement('div'); el.id = 'connect-overlay';
      el.style.position = 'fixed'; el.style.left = '50%'; el.style.top = '14%'; el.style.transform = 'translateX(-50%)';
      el.style.background = 'rgba(0,0,0,0.7)'; el.style.color = '#fff'; el.style.padding = '8px 12px';
      el.style.borderRadius = '8px'; el.style.zIndex = 20000; el.textContent = 'Connecting to local server…';
      document.body.appendChild(el);
    }
  } catch (e) { console.warn('showConnectDialog failed', e); }
}

function hideConnectDialog() {
  try {
    dbg('hideConnectDialog');
    initialConnectShown = false;
    if (window.statusEl && window.statusEl.textContent !== undefined) {
      // Reset to default; pollStatusForHeader will update shortly
      window.statusEl.textContent = 'Local: —';
    }
    const el = document.getElementById('connect-overlay'); if (el) el.remove();
    if (connectDialogTimeout) { try { clearTimeout(connectDialogTimeout); connectDialogTimeout = null; } catch(e){} }
  } catch (e) { console.warn('hideConnectDialog failed', e); }
}

// Friendly one-line status used in multiple places. Keeps header consistent
function setConnectedStatus(x32Ip) {
  try {
    const ip = x32Ip || window.lastX32Ip || '—';
    const el = document.getElementById('x32-ip-indicator') || window.x32IpIndicator || null;
    if (el) el.textContent = 'X32: ' + ip;
    const statusElLocal = document.getElementById('status') || window.statusEl || null;
    // Prefer the last detected non-loopback IP combined with the configured/known port
    let port = '3000';
    try {
      const cfgOrigin = getApiOrigin();
      if (cfgOrigin) { try { port = (new URL(cfgOrigin)).port || port; } catch (e) {} }
      else if (location && location.port) { port = location.port; }
    } catch (e) {}
    const ipHost = (window.lastLocalIp && typeof window.lastLocalIp === 'string') ? window.lastLocalIp : null;
    const localDisplay = ipHost ? (ipHost + (port ? (':' + port) : ''))
                                : ((location && location.host) || '—');
    if (statusElLocal) statusElLocal.textContent = 'Local: ' + localDisplay;
    dbg('setConnectedStatus -> X32:', ip, '| Local:', localDisplay);
  } catch (e) { console.warn('setConnectedStatus failed', e); }
}

// Keep legacy bare globals in sync with authoritative window.* values.
// Many existing functions reference the bare identifiers (routingState, blocks)
// while WebSocket handlers update window.routingState. Call syncGlobals()
// inside routing-aware renderers to ensure we always read the current data.
function syncGlobals() {
  try {
    // Prefer the window.* authoritative values
    if (Array.isArray(window.routingState)) routingState = window.routingState;
    if (Array.isArray(window.blocks)) blocks = window.blocks;
    if (window.userPatches) userPatches = window.userPatches;
    if (window.channelNames) channelNames = window.channelNames;
  } catch (e) { /* ignore sync errors */ }
}

// Defensive runtime defaults: when running as a packaged file:// app the
// server hasn't yet populated these globals and many UI renderers assume
// they exist. Initialize minimal safe defaults to avoid ReferenceErrors and
// let the WebSocket/server overwrite them when data arrives.
window.blocks = window.blocks || [];
window.routingState = window.routingState || [null, null, null, null];
window.userPatches = window.userPatches || {};
// Track pending block toggles so the UI can show an in-flight spinner/disabled state
window._blockTogglePending = window._blockTogglePending || [false,false,false,false];
window.channelNames = window.channelNames || {};
window.channelNamePending = window.channelNamePending || {};
window.channelColors = window.channelColors || {};
window.colorMap = window.colorMap || { null: 'transparent' };

// Create legacy bare identifiers many older functions expect (blocks, routingState, etc.)
// and keep them synced with the authoritative `window.*` objects. This avoids
// ReferenceErrors in packaged/file:// contexts where code was historically
// written to reference bare globals instead of `window.` properties.
var blocks = window.blocks || [];
var routingState = window.routingState || [null, null, null, null];
var userPatches = window.userPatches || {};
var channelNames = window.channelNames || {};
var channelNamePending = window.channelNamePending || {};
var channelColors = window.channelColors || {};
var colorMap = window.colorMap || { null: 'transparent' };

// Lightweight periodic sync to keep the legacy identifiers pointing at the
// latest values if the server updates `window.*` directly.
// (removed accidental duplicate savePortBtn.onclick assignment that caused a
// ReferenceError at top-level; the correct handler is wired later inside
// the DOMContentLoaded block around the Server tab UI.)
            try {
              const restartNowBtn = document.getElementById('restartNowBtn');
              if (restartNowBtn) {
                restartNowBtn.onclick = async () => {
                  try {
                    // Prefer restarting only the supervised server when available
                    if (window.electronAPI && typeof window.electronAPI.restartServer === 'function') {
                      const resp = await window.electronAPI.restartServer();
                      if (resp && resp.ok) showToast('Restarting local server…', 3000);
                      else showToast('Server restart failed: ' + (resp && resp.error ? resp.error : 'unknown'));
                      return;
                    }
                    // Fallback: relaunch the whole Electron app
                    if (window.electronAPI && typeof window.electronAPI.restartApp === 'function') {
                      const resp = await window.electronAPI.restartApp();
                      if (resp && resp.ok) showToast('Restarting application…', 3000);
                      else showToast('Restart request failed: ' + (resp && resp.error ? resp.error : 'unknown'));
                      return;
                    }
                    // If running in dev (localhost) try to hit the dev supervisor endpoint
                    if (IS_DEV) {
                      try {
                        const r = await fetch(apiUrl('/supervisor-restart'), { method: 'POST' });
                        if (r.ok) {
                          const j = await r.json().catch(()=>null);
                          if (j && j.ok) { showToast('Dev supervisor restart triggered.', 3000); return; }
                        }
                      } catch (e) { /* ignore and fallthrough to manual message */ }
                    }
                    // As a last resort, instruct the user to restart manually
                    showToast('Please restart the application manually to apply changes.');
                  } catch (e) { console.error('restart request failed', e); showToast('Restart failed'); }
                };
              }
            } catch (e) {}
            try {
              // Server status display + paged log viewer (uses electronAPI when available)
              const LOG_PAGE_BYTES = 64 * 1024; // 64KB
              let logTailOffset = null;

              async function fetchServerStatus() {
                let status = { running: null, lastExit: null };
                try {
                  if (window.electronAPI && window.electronAPI.getServerStatus) {
                    status = await window.electronAPI.getServerStatus();
                  } else {
                    const r = await fetch(apiUrl('/status'));
                    if (r.ok) {
                      const js = await r.json().catch(()=>null);
                      status.running = true;
                      status.lastExit = { code: null, signal: null, time: new Date().toISOString(), info: js };
                    } else {
                      status.running = false;
                    }
                  }
                } catch (err) {
                  status.running = false;
                  status.lastExit = status.lastExit || { code: null, signal: null, time: new Date().toISOString(), info: String(err) };
                }
                return status;
              }

              async function updateServerStatusUI() {
                const s = await fetchServerStatus();
                const runningLabel = s.running ? 'running' : 'stopped';
                const origin = (typeof localStorage !== 'undefined' && localStorage.getItem('dubswitch_api_origin')) ? localStorage.getItem('dubswitch_api_origin') : '—';
                const statusEl = document.getElementById('serverStatusPreview');
                if (statusEl) statusEl.textContent = `Origin: ${origin} | status: ${runningLabel}`;
                const lastEl = document.getElementById('serverLastStatus');
                // If running in dev mode, attempt to fetch richer supervisor status
                if (IS_DEV) {
                  try {
                    const r = await fetch(apiUrl('/supervisor-status'));
                    if (r.ok) {
                      const info = await r.json().catch(()=>null);
                      if (info && lastEl) {
                        const t = info.pidMtime ? new Date(info.pidMtime).toLocaleString() : '—';
                        lastEl.textContent = `Supervisor PID: ${info.pid || '—'} running=${info.pidRunning ? 'yes' : 'no'} (pid mtime: ${t})`;
                        return;
                      }
                    }
                  } catch (e) { /* ignore and fall back to generic display */ }
                }
                if (s.lastExit && lastEl) {
                  const t = s.lastExit.time ? new Date(s.lastExit.time).toLocaleString() : '—';
                  const code = s.lastExit.code != null ? s.lastExit.code : '—';
                  const signal = s.lastExit.signal || '—';
                  lastEl.textContent = `Last exit: code=${code} signal=${signal} at ${t}`;
                } else if (lastEl) {
                  lastEl.textContent = 'Last start: —';
                }
              }

              async function fetchServerLogPage(offset, length) {
                if (window.electronAPI && window.electronAPI.getServerLog) {
                  return await window.electronAPI.getServerLog({ offset, length });
                }
                // fallback: try to fetch a full log endpoint
                const r = await fetch(apiUrl('/server-child-log'));
                if (!r.ok) throw new Error('Unable to fetch server log');
                const txt = await r.text();
                // Return tail slice when negative offset requested
                if (offset < 0) {
                  const tail = txt.slice(Math.max(0, txt.length + offset));
                  return { size: txt.length, chunk: tail };
                }
                return { size: txt.length, chunk: txt.slice(offset, offset + length) };
              }

              async function refreshLogToEnd() {
                try {
                  const resp = await fetchServerLogPage(-LOG_PAGE_BYTES, LOG_PAGE_BYTES);
                  const el = document.getElementById('serverLogContent'); if (el) el.textContent = resp.chunk || '';
                  const sizeLabel = document.getElementById('logSizeLabel'); if (sizeLabel) sizeLabel.textContent = `Size: ${resp.size}`;
                  logTailOffset = resp.size - (resp.chunk ? resp.chunk.length : 0);
                  if (logTailOffset < 0) logTailOffset = 0;
                } catch (err) {
                  const el = document.getElementById('serverLogContent'); if (el) el.textContent = 'Error loading log: ' + String(err);
                  const sizeLabel = document.getElementById('logSizeLabel'); if (sizeLabel) sizeLabel.textContent = 'Size: —';
                }
              }

              async function loadOlder() {
                try {
                  if (logTailOffset == null) { await refreshLogToEnd(); return; }
                  const readLen = LOG_PAGE_BYTES;
                  const newOffset = Math.max(0, logTailOffset - readLen);
                  const resp = await fetchServerLogPage(newOffset, readLen);
                  const el = document.getElementById('serverLogContent');
                  const existing = el ? el.textContent || '' : '';
                  if (el) el.textContent = (resp.chunk || '') + existing;
                  logTailOffset = newOffset;
                  const sizeLabel = document.getElementById('logSizeLabel'); if (sizeLabel) sizeLabel.textContent = `Size: ${resp.size}`;
                } catch (err) {
                  const el = document.getElementById('serverLogContent'); if (el) el.textContent = 'Error loading older logs: ' + String(err);
                }
              }

              // Wire up modal buttons and the view log button
              const viewLogBtn = document.getElementById('viewServerLogBtn');
              if (viewLogBtn) {
                viewLogBtn.onclick = async () => {
                  try {
                    $('#serverLogModal').modal('show');
                    logTailOffset = null;
                    const el = document.getElementById('serverLogContent'); if (el) el.textContent = 'Loading…';
                    await refreshLogToEnd();
                  } catch (e) { console.error('show log modal failed', e); showToast('Failed to open server log'); }
                };
              }

              const logRefreshBtn = document.getElementById('logRefreshBtn'); if (logRefreshBtn) logRefreshBtn.onclick = refreshLogToEnd;
              const logLoadOlderBtn = document.getElementById('logLoadOlderBtn'); if (logLoadOlderBtn) logLoadOlderBtn.onclick = loadOlder;

              // Start status polling
              updateServerStatusUI();
              setInterval(updateServerStatusUI, 5000);
            } catch (e) {}
// Apply A mapping to all channels
function setAllUserPatchesLocal() {
  try {
    // Snapshot previous values for undo
    const snapshot = {};
    const updates = [];
    for (let ch = 1; ch <= 32; ch++) {
      const nn = String(ch).padStart(2, '0');
      const prev = window.userPatches && window.userPatches[ch];
      snapshot[nn] = (prev != null && Number.isFinite(Number(prev))) ? Number(prev) : null;
    }
    for (let ch = 1; ch <= 32; ch++) {
      const nn = String(ch).padStart(2, '0');
      let aVal = null;
      // Prefer server-persisted numeric A value
      const persisted = (window._persistedMatrix && window._persistedMatrix[nn]) ? window._persistedMatrix[nn] : null;
      if (persisted && persisted.a != null && !Number.isNaN(Number(persisted.a))) {
        aVal = Number(persisted.a);
      } else {
        // Fallback: compute from current channelMatrix mapping
        const mapping = channelMatrix[ch] || { aAction: 'LocalIns', param: null };
        aVal = computeValueForAction(ch, mapping.aAction, mapping.param);
      }
      if (Number.isFinite(aVal)) {
        window.userPatches[ch] = aVal;
        updates.push({ nn, val: aVal });
      }
    }
    // Push undo snapshot
    try { pushMatrixUndo(snapshot); } catch (e) {}
    // Send CLP updates
    for (const u of updates) {
      safeSendWs(JSON.stringify({ type: 'clp', address: `/config/userrout/in/${u.nn}`, args: [u.val] }));
    }
    if (typeof renderUserPatches === 'function') renderUserPatches();
    showToast('Applied A mapping to all channels', 5000, 'Undo', () => {
      try {
        const prev = popMatrixUndo();
        if (!prev) { showToast('Nothing to undo'); return; }
        const undos = [];
        for (let ch = 1; ch <= 32; ch++) {
          const nn = String(ch).padStart(2, '0');
          const v = prev[nn];
          if (v != null && Number.isFinite(Number(v))) {
            window.userPatches[ch] = Number(v);
            undos.push({ nn, val: Number(v) });
          }
        }
        for (const u of undos) {
          safeSendWs(JSON.stringify({ type: 'clp', address: `/config/userrout/in/${u.nn}`, args: [u.val] }));
        }
        if (typeof renderUserPatches === 'function') renderUserPatches();
        showToast('Undo applied');
      } catch (e) { console.error('Undo failed', e); showToast('Undo failed'); }
    });
  } catch (e) { console.error('setAllUserPatchesLocal failed', e); showToast('Failed to apply A to all'); }
}

// Apply B mapping to all channels
function setAllUserPatchesCard() {
  try {
    // Snapshot previous values for undo
    const snapshot = {};
    const updates = [];
    for (let ch = 1; ch <= 32; ch++) {
      const nn = String(ch).padStart(2, '0');
      const prev = window.userPatches && window.userPatches[ch];
      snapshot[nn] = (prev != null && Number.isFinite(Number(prev))) ? Number(prev) : null;
    }
    for (let ch = 1; ch <= 32; ch++) {
      const nn = String(ch).padStart(2, '0');
      let bVal = null;
      // Prefer server-persisted numeric B value
      const persisted = (window._persistedMatrix && window._persistedMatrix[nn]) ? window._persistedMatrix[nn] : null;
      if (persisted && persisted.b != null && !Number.isNaN(Number(persisted.b))) {
        bVal = Number(persisted.b);
      } else {
        // Fallback: compute from current channelMatrix mapping
        const mapping = channelMatrix[ch] || { bAction: 'DAW', param: null };
        bVal = computeValueForAction(ch, mapping.bAction, mapping.param);
      }
      if (Number.isFinite(bVal)) {
        window.userPatches[ch] = bVal;
        updates.push({ nn, val: bVal });
      }
    }
    // Push undo snapshot
    try { pushMatrixUndo(snapshot); } catch (e) {}
    // Send CLP updates
    for (const u of updates) {
      safeSendWs(JSON.stringify({ type: 'clp', address: `/config/userrout/in/${u.nn}`, args: [u.val] }));
    }
    if (typeof renderUserPatches === 'function') renderUserPatches();
    showToast('Applied B mapping to all channels', 5000, 'Undo', () => {
      try {
        const prev = popMatrixUndo();
        if (!prev) { showToast('Nothing to undo'); return; }
        const undos = [];
        for (let ch = 1; ch <= 32; ch++) {
          const nn = String(ch).padStart(2, '0');
          const v = prev[nn];
          if (v != null && Number.isFinite(Number(v))) {
            window.userPatches[ch] = Number(v);
            undos.push({ nn, val: Number(v) });
          }
        }
        for (const u of undos) {
          safeSendWs(JSON.stringify({ type: 'clp', address: `/config/userrout/in/${u.nn}`, args: [u.val] }));
        }
        if (typeof renderUserPatches === 'function') renderUserPatches();
        showToast('Undo applied');
      } catch (e) { console.error('Undo failed', e); showToast('Undo failed'); }
    });
  } catch (e) { console.error('setAllUserPatchesCard failed', e); showToast('Failed to apply B to all'); }
}

// Dev-only larger shims: populate sensible defaults for local dev/testing
if (IS_DEV) {
  window.blocks = window.blocks || [
    { label: '1-8', userin: 20, localin: 0 },
    { label: '9-16', userin: 21, localin: 1 },
    { label: '17-24', userin: 22, localin: 2 },
    { label: '25-32', userin: 23, localin: 3 }
  ];
  window.routingState = window.routingState || [null, null, null, null];
  window.userPatches = window.userPatches || {};
  window.channelNames = window.channelNames || {};
  window.channelNamePending = window.channelNamePending || {};
  window.channelColors = window.channelColors || {};
  window.colorMap = window.colorMap || { null: 'transparent' };
}
// --- end shims ---

// --- Additional safe stubs ---
// loadChannelNames: lightweight loader that fills sensible placeholders
// for channel names so the UI doesn't show 'undefined' while offline.
function loadChannelNames() {
  try {
    for (let ch = 1; ch <= 32; ch++) {
      const nn = String(ch).padStart(2, '0');
      if (!window.channelNames[nn]) window.channelNames[nn] = `Ch ${nn}`;
      window.channelNamePending[nn] = false;
    }
    // refresh UI (safe if renderUserPatches exists)
    if (typeof renderUserPatches === 'function') renderUserPatches();
  } catch (e) { console.error('loadChannelNames stub failed', e); }
}

// computeValueForAction: map logical actions to numeric CLP values used by
// the server/X32. These are safe approximations used for UI toggles.
function computeValueForAction(ch, action, param) {
  try {
    const n = Number(ch);
    if (!action) return null;
    const a = String(action).toLowerCase();
    if (a === 'localins' || a === 'local') return n; // direct channel
    if (a === 'daw' || a === 'card') return 128 + n; // DAW mapping (example)
    if (a === 'userins') {
      const blockIdx = Math.floor((n - 1) / 8);
      const blk = (window.blocks && window.blocks[blockIdx]) || null;
      return blk && blk.userin != null ? Number(blk.userin) : null;
    }
    // numeric param override
    if (param != null) {
      const p = Number(param);
      if (!Number.isNaN(p)) return p;
    }
    const parsed = parseInt(action, 10);
    return Number.isNaN(parsed) ? null : parsed;
  } catch (e) { return null; }
}
// --- end additional stubs ---

// Human-friendly source label for numeric values used across the UI
function prettySourceLabel(raw) {
  try {
    const n = Number(raw);
    if (!Number.isFinite(n)) return String(raw || 'Other');
    if (n >= 129 && n <= 160) return `DAW(${String(n - 128)})`;
    if (n >= 81 && n <= 128) return `AES50B(${String(n - 80)})`;
    if (n >= 33 && n <= 80) return `AES50A(${String(n - 32)})`;
    if (n >= 1 && n <= 32) return `Local(${String(n)})`;
    return String(n);
  } catch (e) { return String(raw); }
}

// Refresh user patches UI — small wrapper used by some code paths.
function refreshUserPatches() {
  try {
    if (typeof renderUserPatches === 'function') {
      renderUserPatches();
    } else {
      // fallback: ensure channel name placeholders exist
      loadChannelNames();
    }
  } catch (e) {
    console.error('refreshUserPatches stub failed', e);
  }
}

// Single WebSocket manager
window.ws = window.ws || null;
function createWs(url) {
  try {
    if (window.ws && window.ws.readyState <= 1) {
      dbg('Closing pre-existing WS before creating new one. prev readyState=', window.ws.readyState);
      window.ws.close();
    }
  } catch (e) { /* ignore */ }
  dbg('WS creating with URL:', url);
  window.ws = new WebSocket(url);
  window.ws.onopen = () => {
    dbg('WS open ->', url);
    // After opening the WS, request current routing and per-channel user routings
    // so the UI can initialize button states from the device.
    try {
      // Ask server to load routing (server will query the X32 and reply with 'routing')
      safeSendWs(JSON.stringify({ type: 'load_routing' }));
      
      // Ask server to explicitly send block descriptors (defensive: ensures
      // the client receives the blocks even if a timing race occurred during
      // the initial connection handshake).
      safeSendWs(JSON.stringify({ type: 'get_blocks' }));
      // Request per-channel user routing values (server will forward replies as 'clp')
      for (let ch = 1; ch <= 32; ch++) {
        const nn = String(ch).padStart(2, '0');
        // Send a CLP read for /config/userrout/in/NN (empty args == read)
        safeSendWs(JSON.stringify({ type: 'clp', address: `/config/userrout/in/${nn}`, args: [] }));
      }
      // Also request channel names
      for (let ch = 1; ch <= 32; ch++) {
        const nn = String(ch).padStart(2, '0');
        safeSendWs(JSON.stringify({ type: 'clp', address: `/ch/${nn}/config/name`, args: [] }));
      }
    } catch (e) { console.warn('initial WS queries failed', e); }
  };
  window.ws.onclose = () => {
    dbg('WS closed. readyState=', window.ws && window.ws.readyState);
    x32Connected = false;
    showConnectDialog();
    statusEl.textContent = 'Status: Disconnected';
  };
  window.ws.onerror = (e) => {
    dbg('WS error:', (e && e.message) || e);
    statusEl.textContent = 'Status: WebSocket error';
  };
  window.ws.onmessage = function(ev){
    try {
      const t = (ev && ev.data && typeof ev.data === 'string') ? (ev.data.startsWith('{') ? (JSON.parse(ev.data).type || 'json') : 'text') : (ev && ev.data && ev.data.type ? ev.data.type : typeof ev);
      dbg('WS message type:', t);
    } catch (e) {}
    handleWsMessage(ev);
  };
}

// Fallback boot: if this script was injected after DOMContentLoaded fired,
// our DOMContentLoaded handlers won't run. In that case, proactively compute
// the WS URL and start the connection now. Also do nothing if a WS is already open/connecting.
try {
  (function bootWsFallback(){
    try {
      const already = (window.ws && window.ws.readyState <= 1);
      if (already) { dbg('Boot fallback: WS already present, skipping. readyState=', window.ws.readyState); return; }
      let origin = getApiOrigin() || '';
      let wsUrl = '';
      if (origin) wsUrl = origin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '');
      else {
        const proto = (location && location.protocol === 'https:') ? 'wss:' : 'ws:';
        wsUrl = proto + '//' + (location && location.host ? location.host : 'localhost:3000');
      }
      dbg('Boot fallback -> starting WS with URL:', wsUrl);
      createWs(wsUrl);
    } catch (e) { dbg('Boot fallback failed:', e && e.message); }
  })();
} catch (e) {}

// MATRIX (static placeholder)
// The active matrix functionality has been removed per user request. Below
// is a purely visual renderer that places a disabled/inert table into the
// Settings modal. No runtime state or server messages are produced by this
// UI.
function renderStaticMatrixTable() {
  const container = document.getElementById('matrix-table-container');
  if (!container) return;
  // If the app has enumerate results, offer them as options in the selects
  const enumMap = (window.enumerateResults && window.enumerateResults.userPatches) ? window.enumerateResults.userPatches : null;
  function makeOptions(baseOptions, selectedVal) {
    // Helper to render numeric values as friendly labels
    function prettyValLabel(raw) {
      const n = Number(raw);
      if (!Number.isFinite(n)) return String(raw);
      if (n >= 129 && n <= 160) return `DAW(${String(n - 128)})`;
      if (n >= 81 && n <= 128) return `AES50B(${String(n - 80)})`;
      if (n >= 33 && n <= 80) return `AES50A(${String(n - 32)})`;
      if (n >= 1 && n <= 32) return `Local(${String(n)})`;
      return String(n);
    }
    // Build ordered map of value -> display label to avoid duplicate entries
    const entries = [];
    const seen = new Set();
    function pushEntry(value, label) {
      const v = String(value);
      if (seen.has(v)) return;
      seen.add(v);
      entries.push({ v, label });
    }
    // base options (skip plain DAW/LocalIns/UserIns) -- we don't want a
    // literal 'UserIns' entry in the dropdowns, prefer numeric or
    // enumerated entries instead.
    for (const o of baseOptions) {
      const lc = String(o).toLowerCase();
      if (lc === 'daw' || lc === 'localins' || lc === 'local' || lc === 'userins') continue;
      pushEntry(o, String(o));
    }
  // numeric LocalIns, AES50A, AES50B, then DAW
  for (let ch = 1; ch <= 32; ch++) pushEntry(String(ch), `Local(${String(ch)})`);
  // AES50A: 33..80 -> AES50A(1..48)
  for (let ch = 1; ch <= 48; ch++) pushEntry(String(32 + ch), `AES50A(${String(ch)})`);
  // AES50B: 81..128 -> AES50B(1..48)
  for (let ch = 1; ch <= 48; ch++) pushEntry(String(80 + ch), `AES50B(${String(ch)})`);
  for (let ch = 1; ch <= 32; ch++) pushEntry(String(128 + ch), `DAW(${String(ch)})`);
    // enumerated entries: prefer their label, but show pretty mapping too
    if (enumMap) {
      const keys = Object.keys(enumMap).sort((a,b)=>Number(a)-Number(b));
      for (const ch of keys) {
        const entry = enumMap[ch] || {};
        const val = (entry.value != null) ? String(entry.value) : '';
        const lbl = entry.label ? String(entry.label) : `Ch ${ch}`;
        const pretty = (val && !isNaN(Number(val))) ? prettyValLabel(val) : `${lbl} (${val})`;
        let displayLabel = `${lbl} — ${pretty}`;
        try {
          const l = (lbl || '').toString().trim().toLowerCase();
          const p = (pretty || '').toString().trim().toLowerCase();
          if (l && p && (p.includes(l) || l.includes(p) || l === p)) displayLabel = pretty;
        } catch (e) {}
        // If value already exists, replace its label with the more descriptive enumerated label
        if (seen.has(String(val))) {
          // find and update
          for (const it of entries) {
            if (it.v === String(val)) { it.label = displayLabel; break; }
          }
        } else {
          pushEntry(val, displayLabel);
        }
      }
    }

    // Build option HTML, marking selectedVal if present
    let opts = '';
    for (const e of entries) {
      const sel = (selectedVal != null && String(selectedVal) === e.v) ? ' selected' : '';
      opts += `<option value="${e.v}"${sel}>${e.label}</option>`;
    }
    // If selectedVal wasn't found in entries, prepend a fallback option
    try {
      if (selectedVal != null && !seen.has(String(selectedVal))) {
        const pretty = (!isNaN(Number(selectedVal))) ? prettyValLabel(selectedVal) : String(selectedVal);
        opts = `<option value="${String(selectedVal)}" selected>${pretty}</option>` + opts;
      }
    } catch (e) {}
    return opts;
  }

  // Block-level configuration has been removed; the per-channel table is shown below.
  // (User requested the longer explanatory paragraph be removed.)
  let html = '';
  // Add a compact bulk-set dropdown after the B header for quick operations
  html += `<div style="display:flex;align-items:center;gap:12px;margin-top:8px;margin-bottom:6px">
    <div class="small-muted">Quick set for column B:</div>
    <select id="matrix-b-bulk-select" class="form-control form-control-sm" style="width:160px">
      <option value="">-- Select --</option>
      <option value="local">Local</option>
      <option value="daw">DAW</option>
      <option value="aes50a">AES50A</option>
      <option value="aes50b">AES50B</option>
    </select>
    <button id="matrix-b-bulk-apply" class="btn btn-sm btn-primary">Apply to all B</button>
  </div>`;
  // Per-channel A/B view (visual only)
  html += `<div class="table-responsive matrix-table-wrap" style="margin-top:6px"><table class="table table-sm"><thead><tr><th>Ch</th><th>A</th><th>B</th></tr></thead><tbody>`;
  for (let ch = 1; ch <= 32; ch++) {
    const nn = String(ch).padStart(2,'0');
  html += `<tr><td class="matrix-ch-number">${nn}</td>`;
    // For per-channel selects, include a few common defaults plus enumerated inputs.
    // If we have an enumerated value for this channel, pre-select it in column A.
  // Determine preselected values: prefer persisted server matrix then enumerate map
  const persisted = (window._persistedMatrix && window._persistedMatrix[nn]) ? window._persistedMatrix[nn] : null;
  const aPersist = persisted && persisted.a != null ? String(persisted.a) : null;
  const bPersist = persisted && persisted.b != null ? String(persisted.b) : null;
  const enumVal = (aPersist != null)
    ? aPersist
    : (enumMap && enumMap[nn] && enumMap[nn].value != null ? String(enumMap[nn].value) : null);
  // Determine B value: prefer persisted B, otherwise default to the opposite
  // of A (DAW <-> LocalIns mapping). If A is non-numeric or unknown, leave B empty.
  let enumValB = null;
  if (bPersist != null) {
    enumValB = bPersist;
  } else if (enumVal != null && !isNaN(Number(enumVal))) {
    const aval = Number(enumVal);
    if (aval >= 129 && aval <= 160) {
      // A is DAW -> B should be LocalIns (1..32)
      enumValB = String(aval - 128);
    } else if (aval >= 1 && aval <= 32) {
      // A is LocalIns -> B should be DAW (129..160)
      enumValB = String(128 + aval);
    }
  }
  html += `<td><select class="form-control form-control-sm matrix-select-a" data-ch="${nn}">` + makeOptions(['LocalIns','DAW','UserIns'], enumVal) + `</select></td>`;
  html += `<td><select class="form-control form-control-sm matrix-select-b" data-ch="${nn}">` + makeOptions(['DAW','LocalIns','UserIns'], enumValB) + `</select></td>`;
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  container.innerHTML = html;

  // Legend removed per user request.

  // Wire change handlers: when any select changes, send the full matrix
  // state to the server (debounced) so the server persists the full mapping.
  let changeDebounce = null;
  // flag used to indicate we are awaiting the server's broadcast confirming persistence
  let awaitingMatrixBroadcast = false;

  function sendFullMatrixState() {
    try {
      const body = {};
      // Build a mapping for channels '01'..'32'
      for (let ch = 1; ch <= 32; ch++) {
        const nn = String(ch).padStart(2, '0');
        const aEl = document.querySelector(`.matrix-select-a[data-ch="${nn}"]`);
        const bEl = document.querySelector(`.matrix-select-b[data-ch="${nn}"]`);
        const aVal = aEl ? aEl.value : null; const bVal = bEl ? bEl.value : null;
        body[nn] = { a: aVal, b: bVal };
      }
      // POST the full matrix and mark that we're awaiting the server's
      // authoritative broadcast. Do not show a toast here — wait for WS.
      try {
        awaitingMatrixBroadcast = true;
        const payload = JSON.stringify(body);
        console.debug('[UI] Sending matrix payload', body);
  fetch(apiUrl('/set-channel-matrix'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
          .then(async (r) => {
            if (!r.ok) {
              // try to read response body for a helpful message
              let text = '';
              try { text = await r.text(); } catch (e) { text = '' + e; }
              throw new Error(`HTTP ${r.status} ${r.statusText} ${text ? '- ' + text : ''}`);
            }
            return r.json();
          })
          .then(j => {
            if (j && j.matrix) window._persistedMatrix = j.matrix;
            // keep awaitingMatrixBroadcast true until server sends WS 'matrix_update'
          })
          .catch((err)=>{
            console.error('persist matrix failed', err);
            awaitingMatrixBroadcast = false;
            try { showToast('Failed to save matrix: ' + (err && err.message ? err.message : 'network error')); } catch(e){}
          });
      } catch (e) {
        console.error('persist matrix unexpected error', e);
        awaitingMatrixBroadcast = false;
        try { showToast('Failed to save matrix: ' + (e && e.message ? e.message : 'unknown error')); } catch(e){}
      }
    } catch (e) {}
  }
  // expose for other UI actions to trigger (buttons etc.)
  window.persistCurrentMatrix = function(){ if (changeDebounce) clearTimeout(changeDebounce); sendFullMatrixState(); };
  document.querySelectorAll('.matrix-select-a, .matrix-select-b').forEach(sel => {
    sel.addEventListener('change', (ev)=>{
      try {
        const target = ev.currentTarget || ev.target;
        const ch = target.getAttribute('data-ch');
        const isA = target.classList.contains('matrix-select-a');
        // If A changed and there's no persisted B, auto-fill B to the opposite
        if (isA) {
          try {
            const aVal = target.value;
            const persistedRow = (window._persistedMatrix && window._persistedMatrix[ch]) ? window._persistedMatrix[ch] : null;
            const bEl = document.querySelector(`.matrix-select-b[data-ch="${ch}"]`);
            // Only auto-set B when server doesn't already have a stored value for B
            if (bEl && (!persistedRow || persistedRow.b == null)) {
              if (!isNaN(Number(aVal))) {
                const n = Number(aVal);
                let newB = null;
                if (n >= 129 && n <= 160) newB = String(n - 128);
                else if (n >= 1 && n <= 32) newB = String(128 + n);
                if (newB != null) {
                  // set value if different
                  if (bEl.value !== String(newB)) bEl.value = String(newB);
                }
              }
            }
          } catch (e) { /* ignore fill errors */ }
        }
      } catch (e) {}
      if (changeDebounce) clearTimeout(changeDebounce);
      changeDebounce = setTimeout(()=>{ sendFullMatrixState(); changeDebounce = null; }, 350);
    }, { passive: true });
  });

  // Wire bulk-set "Apply to all B" behaviour
  try {
    const bulkSelect = document.getElementById('matrix-b-bulk-select');
    const bulkBtn = document.getElementById('matrix-b-bulk-apply');
    if (bulkBtn && bulkSelect) {
      bulkBtn.addEventListener('click', (ev) => {
        try {
          const val = bulkSelect.value;
          if (!val) { showToast('Select a source to apply'); return; }
          // Confirm with the user
          const human = (val === 'local') ? 'Local' : (val === 'daw' ? 'DAW' : (val === 'aes50a' ? 'AES50A' : 'AES50B'));
          // Use Bootstrap modal for confirmation
          try {
            const modalText = document.getElementById('bulkApplyConfirmText');
            const okBtn = document.getElementById('bulkApplyConfirmOk');
            const $modal = window.jQuery ? window.jQuery('#bulkApplyConfirmModal') : null;
            if (modalText) modalText.textContent = `Are you sure you want to set all B inputs to ${human}? This will overwrite current B values.`;
            // show modal
            if ($modal && $modal.modal) {
              // Ensure previous handlers are removed to avoid duplicate application
              okBtn && okBtn.replaceWith(okBtn.cloneNode(true));
              const freshOk = document.getElementById('bulkApplyConfirmOk');
              $modal.modal('show');
              // Attach one-time click handler
              freshOk.addEventListener('click', () => {
                try {
                  $modal.modal('hide');
                } catch (e) {}
                  // Snapshot current B values for undo
                  const snapshot = {};
                  for (let ch = 1; ch <= 32; ch++) {
                    const nn = String(ch).padStart(2, '0');
                    const bEl = document.querySelector(`.matrix-select-b[data-ch="${nn}"]`);
                    snapshot[nn] = bEl ? bEl.value : null;
                  }
                  pushMatrixUndo(snapshot);
                  // Apply mapping now
                  for (let ch = 1; ch <= 32; ch++) {
                    const nn = String(ch).padStart(2, '0');
                    const bEl = document.querySelector(`.matrix-select-b[data-ch="${nn}"]`);
                    if (!bEl) continue;
                    let setVal = '';
                    if (val === 'local') setVal = String(ch);
                    else if (val === 'daw') setVal = String(128 + ch);
                    else if (val === 'aes50a') setVal = String(32 + ch);
                    else if (val === 'aes50b') setVal = String(80 + ch);
                    if (bEl.value !== setVal) {
                      bEl.value = setVal;
                      bEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  }
                  if (changeDebounce) clearTimeout(changeDebounce);
                  changeDebounce = setTimeout(()=>{ sendFullMatrixState(); changeDebounce = null; }, 200);
                  // Show toast with Undo
                  showToast(`Applied ${human} to all B inputs`, 5000, 'Undo', ()=>{
                    try {
                      const prev = popMatrixUndo();
                      if (!prev) { showToast('Nothing to undo'); return; }
                      // restore
                      for (let ch = 1; ch <= 32; ch++) {
                        const nn = String(ch).padStart(2, '0');
                        const bEl = document.querySelector(`.matrix-select-b[data-ch="${nn}"]`);
                        if (!bEl) continue;
                        const v = prev[nn] != null ? String(prev[nn]) : '';
                        if (bEl.value !== v) {
                          bEl.value = v;
                          bEl.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                      }
                      if (changeDebounce) clearTimeout(changeDebounce);
                      changeDebounce = setTimeout(()=>{ sendFullMatrixState(); changeDebounce = null; }, 200);
                      showToast('Undo applied');
                    } catch (e) { console.error('undo failed', e); showToast('Undo failed'); }
                  });
              }, { passive: true });
            } else {
              // Modal unavailable: abort and inform user. We intentionally do not
              // fall back to native confirm() to avoid inconsistent UX in packaged apps.
              showToast('Confirmation dialog unavailable — please use the Settings UI inside the packaged app.', 5000);
            }
          } catch (e) { console.error('modal bulk apply failed', e); showToast('Bulk apply failed'); }
        } catch (e) { console.error('bulk apply failed', e); showToast('Bulk apply failed'); }
      }, { passive: true });
    }
  } catch (e) {}
}

// Ensure Matrix table renders even if this script loads after DOMContentLoaded
(function ensureMatrixRenderedEarly(){
  async function bootMatrixOnce(){
    try {
      // Load persisted matrix once so B defaults are restored
      try {
        const resp = await fetch(apiUrl('/get-matrix'));
        if (resp && resp.ok) { const j = await resp.json().catch(()=>null); if (j && j.matrix) window._persistedMatrix = j.matrix; }
      } catch (e) {}
      // Preload enumerate results so A column can preselect known sources
      try {
        if (!window.enumerateResults) {
          const r = await fetch(apiUrl('/enumerate-sources'));
          if (r && r.ok) { const j = await r.json().catch(()=>null); if (j) window.enumerateResults = j; }
        }
      } catch (e) {}
      try { renderStaticMatrixTable(); } catch (e) {}
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', bootMatrixOnce, { once: true });
  } else {
    // DOM already parsed; render immediately
    bootMatrixOnce();
  }
})();

// Render static table once DOM ready
window.addEventListener('DOMContentLoaded', async ()=>{
  try {
    // Try to load server-persisted matrix so column B values are restored after restart
    try {
      const resp = await fetch(apiUrl('/get-matrix'));
      if (resp && resp.ok) {
        const j = await resp.json();
        if (j && j.matrix) window._persistedMatrix = j.matrix;
      }
    } catch (e) { /* ignore network errors; render fallback */ }
    try { renderStaticMatrixTable(); } catch (e) {}
  } catch (e) {}
});
// Attempt to fetch enumerate results at startup so the Matrix A column
// pre-selects known enumerated sources when available.
window.addEventListener('DOMContentLoaded', async ()=>{
  try {
    if (!window.enumerateResults) {
  const resp = await fetch(apiUrl('/enumerate-sources'));
      if (resp && resp.ok) {
        const json = await resp.json();
        if (json) {
          window.enumerateResults = json;
          try { renderStaticMatrixTable(); } catch (e) {}
        }
      }
    }
  } catch (e) { /* ignore failures silently */ }
});

// Diagnostics: fetch /status and /troubleshoot/matrix-file and display
async function fetchDiagnostics() {
  try {
    const outStatus = document.getElementById('diagnostics-status');
    const outMatrix = document.getElementById('diagnostics-matrix-file');
    const spinner = document.getElementById('diagnostics-spinner');
    if (spinner) spinner.style.display = '';
    if (outStatus) outStatus.textContent = 'Loading...';
    if (outMatrix) outMatrix.textContent = 'Loading...';
    // Fetch both in parallel
    const [sRes, mRes] = await Promise.allSettled([
      fetch(apiUrl('/status')),
      fetch(apiUrl('/troubleshoot/matrix-file'))
    ]);
    if (sRes.status === 'fulfilled') {
      try {
        const j = await sRes.value.json();
        if (outStatus) outStatus.textContent = JSON.stringify(j, null, 2);
      } catch (e) { if (outStatus) outStatus.textContent = 'Failed to parse /status JSON: ' + e; }
    } else { if (outStatus) outStatus.textContent = '/status fetch failed: ' + sRes.reason; }

    if (mRes.status === 'fulfilled') {
      try {
        const j = await mRes.value.json();
        if (outMatrix) outMatrix.textContent = JSON.stringify(j, null, 2);
      } catch (e) { if (outMatrix) outMatrix.textContent = 'Failed to parse /troubleshoot/matrix-file JSON: ' + e; }
    } else { if (outMatrix) outMatrix.textContent = '/troubleshoot/matrix-file fetch failed: ' + mRes.reason; }
    if (spinner) spinner.style.display = 'none';
  } catch (e) {
    console.error('fetchDiagnostics failed', e);
    const spinner = document.getElementById('diagnostics-spinner'); if (spinner) spinner.style.display = 'none';
  }
}

// Wire diagnostics UI actions when DOM ready
window.addEventListener('DOMContentLoaded', async ()=>{
  try {
    const diagBtn = document.getElementById('diagnosticsBtn');
    const diagRefresh = document.getElementById('diagnostics-refresh');
    const diagCopyStatus = document.getElementById('diagnostics-copy-status');
    const diagCopyMatrix = document.getElementById('diagnostics-copy-matrix');

    if (diagBtn) {
      diagBtn.addEventListener('click', ()=>{
        try {
          if (window.jQuery) window.jQuery('#diagnosticsModal').modal('show');
          fetchDiagnostics();
          // Start auto-refresh while modal is open
          try {
            if (window.__diagnosticsAutoInterval) clearInterval(window.__diagnosticsAutoInterval);
            window.__diagnosticsAutoInterval = setInterval(()=>{
              const mod = document.getElementById('diagnosticsModal');
              if (!mod) return; // safety
              // only refresh when modal is visible
              const isOpen = window.jQuery ? window.jQuery(mod).hasClass('show') : (mod.style.display !== 'none');
              if (isOpen) fetchDiagnostics();
              else {
                try { clearInterval(window.__diagnosticsAutoInterval); window.__diagnosticsAutoInterval = null; }
                catch (e) {}
              }
            }, 4000);
          } catch (e) {}
        } catch (e) { console.error(e); }
      }, { passive: true });
    }
    if (diagRefresh) diagRefresh.addEventListener('click', fetchDiagnostics, { passive: true });
    if (diagCopyStatus) diagCopyStatus.addEventListener('click', ()=>{
      const out = document.getElementById('diagnostics-status'); if (!out) return; navigator.clipboard.writeText(out.textContent||'').then(()=> showToast('Status copied to clipboard')).catch(()=> showToast('Copy failed'));
    }, { passive: true });
    if (diagCopyMatrix) diagCopyMatrix.addEventListener('click', ()=>{
      const out = document.getElementById('diagnostics-matrix-file'); if (!out) return; navigator.clipboard.writeText(out.textContent||'').then(()=> showToast('Matrix info copied')).catch(()=> showToast('Copy failed'));
    }, { passive: true });
  } catch (e) { console.error('diagnostics wiring failed', e); }
});

// Update header X32 IP indicator from /status periodically
async function pollStatusForHeader() {
  try {
    // Try current configured origin first
    let resp;
    let j = null;
    try {
      resp = await fetch(apiUrl('/status'));
      if (resp && resp.ok) j = await resp.json().catch(()=>null);
      dbg('/status primary origin OK:', !!(resp && resp.ok));
    } catch (e) {
      // network error contacting configured origin — we'll try fallbacks below
      resp = null; j = null;
      dbg('/status primary origin failed:', e && e.message);
    }
    // If the configured origin is unreachable, try a small set of sensible fallbacks
    if (!resp || !resp.ok) {
      // Avoid infinite probing when user intentionally configured a custom origin.
      const tried = new Set();
      const candidates = [];
      try {
        const cfg = getApiOrigin(); if (cfg) candidates.push(cfg);
      } catch (e) {}
      // Common local ports to try
      candidates.push('http://localhost:3000');
      candidates.push('http://localhost:4000');
      candidates.push('http://127.0.0.1:3000');
      candidates.push('http://127.0.0.1:4000');

      let found = null;
      for (const c of candidates) {
        if (!c || tried.has(c)) continue;
        tried.add(c);
        try {
          const u = c.replace(/\/$/, '') + '/status';
          dbg('Probing fallback origin:', u);
          const r = await fetch(u, { cache: 'no-store' });
          if (r && r.ok) {
            const parsed = await r.json().catch(()=>null);
            if (parsed) { found = { origin: c.replace(/\/$/, ''), json: parsed }; break; }
          }
        } catch (e) { /* ignore and try next */ }
      }
      if (found) {
        const origin = found.origin;
        try { localStorage.setItem('dubswitch_api_origin', origin); } catch (e) {}
        window.__DUBSWITCH_API_ORIGIN__ = origin;
        j = found.json;
        dbg('Switched API origin to fallback:', origin);
  // Inform the user that origin was switched; user may need to reload
  try { showToast('Switched API origin to ' + origin + '. Reload the app to apply.', 4000); } catch (e) {}
      } else {
        dbg('All fallback origins failed.');
        // No candidate worked — surface a clear preview and stop here
        try {
          const preview = document.getElementById('serverStatusPreview');
          if (preview) preview.textContent = 'Origin: ' + (getApiOrigin() || 'http://localhost:3000') + ' | status: unreachable';
        } catch (e) {}
        try { showToast('Local server unreachable at configured origin', 3000); } catch (e) {}
        return;
      }
    }
    // Update X32 indicator
    const ipEl = document.getElementById('x32-ip-indicator');
    if (ipEl) ipEl.textContent = 'X32: ' + (j && j.x32Ip ? j.x32Ip : '—');
    // Update local server address shown in header (Local: ip:port)
    const statusEl = document.getElementById('status');
    try {
      // Prefer server-provided network interfaces (ifaces) to find a non-loopback address
      let localAddr = '';
      if (j && j.ifaces) {
        // ifaces is an object mapping iface name -> array of addresses
        for (const k of Object.keys(j.ifaces)) {
          const arr = j.ifaces[k] || [];
          for (const it of arr) {
            if (!it || !it.address) continue;
            if (it.internal) continue; // skip loopback
            // prefer IPv4
            if (it.family === 'IPv4' || it.family === 4) { localAddr = it.address; break; }
            if (!localAddr) localAddr = it.address;
          }
          if (localAddr) break;
        }
      }
      // Determine port we should show
      let portToShow = '3000';
      try {
        const cfgOrigin = getApiOrigin();
        if (cfgOrigin) { try { portToShow = (new URL(cfgOrigin)).port || portToShow; } catch (e) {} }
        else if (location && location.port) { portToShow = location.port; }
      } catch (e) {}
      // Prefer the real IP when available; otherwise fall back to host
      let displayLocal = '—';
      if (localAddr) displayLocal = localAddr + (portToShow ? (':' + portToShow) : '');
      else if (location && location.host) displayLocal = location.host;
      // Persist last known values for other updaters (e.g., setConnectedStatus)
      try { window.lastLocalIp = localAddr || window.lastLocalIp || null; window.lastLocalPort = portToShow; } catch (e) {}
      if (statusEl) statusEl.textContent = 'Local: ' + displayLocal;
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Local: —';
    }
  // Also prepopulate the Local Port input so the Save Port field shows the
    // currently-targeted port. Preference order:
    // 1) configured API origin (localStorage / runtime override)
    // 2) current location.port (when served over http(s))
    // 3) default 3000
    try {
      const localPortInput = document.getElementById('localPortInput');
      if (localPortInput) {
        let portToShow = '';
        const cfgOrigin = getApiOrigin();
        if (cfgOrigin) {
          try { portToShow = (new URL(cfgOrigin)).port || ''; } catch (e) { portToShow = ''; }
        }
        if (!portToShow) {
          if (location && location.port) portToShow = location.port;
          else portToShow = '3000';
        }
        localPortInput.value = portToShow;
      }
    } catch (e) {}
    // Update one-line Server status preview (if present)
    try {
      try {
        const preview = document.getElementById('serverStatusPreview');
        if (preview) {
          const origin = getApiOrigin() || 'http://localhost:3000';
          const pieces = ['Origin: ' + origin.replace(/^https?:\/\//, '').replace(/\/$/, '')];
          if (j) {
            const extras = [];
            if (typeof j.wsClients !== 'undefined') extras.push('ws=' + j.wsClients);
            if (typeof j.pingCount !== 'undefined') extras.push('pings=' + j.pingCount);
            if (j.x32Ip) extras.push('x32=' + j.x32Ip);
            if (extras.length) pieces.push('status: ' + extras.join(', '));
          }
          preview.textContent = pieces.join(' | ');
        }
      } catch (e) {}
    } catch (e) {}
  } catch (e) {}
}
// Start polling header status every 5s
try { pollStatusForHeader(); setInterval(pollStatusForHeader, 5000); } catch (e) {}

// Populate version labels (header and footer) from /version
(function setupVersionLabels(){
  async function updateVersionOnce() {
    try {
      const r = await fetch(apiUrl('/version'), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ver = (await r.text()).trim();
      if (ver) {
        const hdr = document.getElementById('header-version');
        if (hdr && !/v\d/.test(hdr.textContent || '')) hdr.textContent = 'v' + ver;
        const ftr = document.getElementById('app-version');
        if (ftr && !/v\d/.test(ftr.textContent || '')) ftr.textContent = 'v' + ver + ' — ';
      }
    } catch (e) {
      // keep quiet; maybe server not up yet — retry shortly
      try { dbg('updateVersionOnce failed:', e && e.message); } catch(_){}
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateVersionOnce, { once: true });
  } else {
    updateVersionOnce();
  }
  // Also attempt one delayed retry after 2s in case server started later
  setTimeout(updateVersionOnce, 2000);
})();

// Rebind important DOM elements once the DOM is ready and render routing
// table so it appears in the correct tab. Previously these globals were
// initialized before DOMContentLoaded which could leave them as noop
// placeholders and prevent the routing table from being rendered into the
// Settings -> Routing tab.
window.addEventListener('DOMContentLoaded', ()=>{
  try {
    window.statusEl = document.getElementById('status') || window.statusEl || _noopEl();
    window.toggleInputsBtn = document.getElementById('toggle-inputs') || window.toggleInputsBtn || _noopEl();
  // routing table element removed; initialize hint element if present
  window.routingTable = window.routingTable || _noopEl();
  const routingHintEl = document.getElementById('routing-hint');
  if (routingHintEl) routingHintEl.textContent = 'Per-block controls are available in the header above; use those buttons to toggle blocks.';
    window.userpatchContainer = document.getElementById('userpatch-container') || window.userpatchContainer || _noopEl();
    // Ensure channel names are present for UI rendering
    try { loadChannelNames(); } catch (e) {}
  // Render routing UI (updates header buttons and badges)
  try { renderRoutingTable(); } catch (e) { console.warn('renderRoutingTable on DOMContentLoaded failed', e); }

    // Wire the routing tab to re-render when the tab becomes active. This
    // ensures the table is fresh and visible when users open Settings -> Routing.
    const routingTab = document.getElementById('tab-routing-link');
    if (routingTab) {
      // If Bootstrap jQuery is available, listen to shown.bs.tab for more
      // reliable timing; otherwise use click as a fallback.
      try {
        if (window.jQuery && window.jQuery(routingTab).on) {
          window.jQuery(routingTab).on('shown.bs.tab', function(){ try { renderRoutingTable(); } catch (e) {} });
        } else {
          routingTab.addEventListener('click', ()=>{ try { renderRoutingTable(); } catch (e) {} });
        }
      } catch (e) {}
    }
    // Create WebSocket connection to the configured API origin (or current host)
    try {
      let origin = getApiOrigin() || '';
      let wsUrl = '';
      if (origin) wsUrl = origin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '');
      else {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = proto + '//' + location.host;
      }
      dbg('Computed origin:', origin || '(relative)');
      dbg('Computed WS URL:', wsUrl);
      createWs(wsUrl);
    } catch (e) { console.warn('createWs failed', e); }

    // UI flag: while we are awaiting per-channel CLP replies from the server
    // we will show a lightweight spinner/placeholder instead of full channel tiles.
    window.userPatchesPending = true;

    // Wire autodiscover and save IP buttons in Settings
    try {
      const autodBtn = document.getElementById('autodiscoverBtn');
      if (autodBtn) {
        autodBtn.onclick = async () => {
          try {
            autodBtn.disabled = true;
            const res = await fetch(apiUrl('/autodiscover-x32'));
            const json = await res.json();
            if (json && json.ip) {
              const ipEl = document.getElementById('x32IpInput'); if (ipEl) ipEl.value = json.ip;
              // Notify server of chosen IP
              safeSendWs(JSON.stringify({ type: 'set_x32_ip', ip: json.ip }));
              showToast('X32 discovered: ' + json.ip);
            } else {
              showToast('No X32 discovered');
            }
          } catch (e) { console.error('autodiscover failed', e); showToast('Autodiscover failed'); }
          finally { try { autodBtn.disabled = false; } catch (e){} }
        };
      }
      const saveBtn = document.getElementById('saveIpBtn');
      if (saveBtn) {
        saveBtn.onclick = () => {
          try {
            const ip = (document.getElementById('x32IpInput') || { value: '' }).value.trim();
            if (!ip) { showToast('Enter an IP first'); return; }
            safeSendWs(JSON.stringify({ type: 'set_x32_ip', ip }));
            showToast('X32 IP saved');
            // Also allow storing a preferred local server port so the client can
            // target a different port when the default 3000 is occupied.
            try {
              const portEl = document.getElementById('localPortInput');
              if (portEl && portEl.value) {
                const portVal = String(portEl.value).trim();
                if (/^\d{2,5}$/.test(portVal)) {
                  const origin = 'http://localhost:' + portVal;
                  try { localStorage.setItem('dubswitch_api_origin', origin); } catch (e) {}
                  window.__DUBSWITCH_API_ORIGIN__ = origin;
                  showToast('Local API origin set to ' + origin);
                  try { pollStatusForHeader(); } catch (e) {}
                } else {
                  showToast('Invalid port — not saved');
                }
              }
            } catch (e) {}
            // Separate Save Port button (placed in its own Server tab)
            try {
              const savePortBtn = document.getElementById('savePortBtn');
              if (savePortBtn) {
                savePortBtn.onclick = async () => {
                  try {
                    const portEl = document.getElementById('localPortInput');
                    if (!portEl || !portEl.value) { showToast('Enter a port first'); return; }
                    const portVal = String(portEl.value).trim();
                    if (!/^\d{2,5}$/.test(portVal)) { showToast('Invalid port'); return; }
                    savePortBtn.disabled = true;
                    savePortBtn.textContent = 'Saving…';
                    // Ask currently-running server to rebind
                    try {
                      const resp = await fetch(apiUrl('/set-port'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: Number(portVal) }) });
                      const json = await resp.json().catch(()=>null);
                      if (resp.ok && json && json.ok) {
                        const origin = 'http://localhost:' + portVal;
                        try { localStorage.setItem('dubswitch_api_origin', origin); } catch (e) {}
                        window.__DUBSWITCH_API_ORIGIN__ = origin;
                              // Longer success toast with an action to reconnect WS immediately
                              // The action will reconnect the WebSocket and, if the page
                              // was originally served from a different host:port, will
                              // navigate the browser to the new origin so the UI is
                              // loaded from the newly-bound server.
                              showToast('Port saved. Please restart the application to apply the new port.', 8000);
                        try { pollStatusForHeader(); } catch (e) {}
                        // Also auto-reconnect shortly after successful rebind so user sees the change
                        // No automatic reconnect
                        // If this page was loaded over http(s) and the host:port differs
                        // from the newly-bound server, automatically navigate there so
                        // the UI (assets and location-based logic) are served from
                        // the new origin. Delay slightly to give the server time to bind.
                        try {
                          const currentHost = (location && location.host) ? location.host : '';
                          const newHost = origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
                          if (location && location.protocol && location.protocol.indexOf('http') === 0 && currentHost && currentHost !== newHost) {
                            setTimeout(()=>{
                              try { window.location.replace(origin + (location.pathname || '/')); } catch(e){}
                            }, 900);
                          }
                        } catch (e) {}
                      } else {
                        const msg = (json && json.error) ? json.error : ('HTTP ' + resp.status);
                        showToast('Failed to change port: ' + msg);
                      }
                    } catch (e) { console.error('set-port request failed', e); showToast('Failed to contact server'); }
                  } finally { try { savePortBtn.disabled = false; savePortBtn.textContent = 'Save Port'; } catch (e){} }
                };
              }
            } catch (e) {}
          } catch (e) { console.error('saveIp failed', e); }
        };
      }
      // Prefill local port input if stored
      try {
        const storedOrigin = (typeof localStorage !== 'undefined') ? localStorage.getItem('dubswitch_api_origin') : null;
        const localPortInput = document.getElementById('localPortInput');
        if (localPortInput && storedOrigin) {
          try {
            const u = new URL(storedOrigin);
            localPortInput.value = u.port || '';
            localPortInput.dataset.orig = storedOrigin;
          } catch (e) { /* ignore */ }
        }
      } catch (e) {}
      // Enumerate button: call server endpoint and show JSON + CSV download
      const enumBtn = document.getElementById('enumerateBtn');
      const enumContainer = document.getElementById('enumerate-results-container');
      const enumPre = document.getElementById('enumerate-results');
      const enumDownload = document.getElementById('enumerate-download-csv');
      const enumClear = document.getElementById('enumerate-clear');
      if (enumBtn) {
        enumBtn.onclick = async () => {
          try {
            enumBtn.disabled = true; enumBtn.textContent = 'Enumerating…';
            const resp = await fetch(apiUrl('/enumerate-sources'));
            const json = await resp.json();
            // Keep a global copy so other UI pieces (matrix) can reuse results
            window.enumerateResults = json || {};
            enumContainer.style.display = 'block';
            enumPre.textContent = JSON.stringify(window.enumerateResults, null, 2);
            // Re-render matrix picks to reflect newly enumerated user inputs
            try { renderStaticMatrixTable(); } catch (e) { console.warn('re-render matrix after enumerate failed', e); }
            // create CSV for download
            if (enumDownload) {
              enumDownload.onclick = () => {
                const rows = ['ch,value,label'];
                if (json && json.userPatches) {
                  for (const ch of Object.keys(json.userPatches)) {
                    const v = json.userPatches[ch] && json.userPatches[ch].value != null ? json.userPatches[ch].value : '';
                    const lbl = json.userPatches[ch] && json.userPatches[ch].label ? json.userPatches[ch].label : '';
                    rows.push(`${ch},${v},${lbl}`);
                  }
                }
                const csv = rows.join('\n');
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = 'enumerate-sources.csv'; document.body.appendChild(a); a.click(); a.remove();
                URL.revokeObjectURL(url);
              };
            }
            enumClear.onclick = () => { enumContainer.style.display = 'none'; enumPre.textContent = ''; };
            // Also clear global cache and re-render matrix when using clear
            const _origClear = enumClear.onclick;
            enumClear.onclick = () => { window.enumerateResults = null; try { renderStaticMatrixTable(); } catch (e) {} ; if (_origClear) _origClear(); };
          } catch (e) { console.error('enumerate failed', e); showToast('Enumerate failed'); }
          finally { enumBtn.disabled = false; enumBtn.textContent = 'Enumerate Sources'; }
        };
      }
      const manualBtn = document.getElementById('manualIpBtn');
      if (manualBtn) {
        manualBtn.onclick = () => {
          try {
            // Open settings modal and focus IP input
            if (window.jQuery) window.jQuery('#settingsModal').modal('show');
            const ipEl = document.getElementById('x32IpInput'); if (ipEl) { ipEl.focus(); ipEl.select(); }
          } catch (e) {}
        };
      }
    } catch (e) {}
  } catch (e) {}
});

// Central WS message handler used by createWs
function handleWsMessage(ev) {
  try {
    const raw = ev && ev.data ? ev.data : ev;
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    try { dbg('WS <=', data && data.type ? data.type : typeof data); } catch (e) {}

    // Handle server broadcast for persisted matrix updates first
    if (data && data.type === 'matrix_update') {
        if (data.matrix) window._persistedMatrix = data.matrix;
        try { renderStaticMatrixTable(); } catch (e) {}
        try {
          const savedEl = document.getElementById('matrix-saved-indicator');
          if (awaitingMatrixBroadcast && savedEl) {
            // show inline Saved indicator briefly
            savedEl.style.display = '';
            setTimeout(()=>{ try { savedEl.style.display = 'none'; } catch(e){} }, 1400);
            awaitingMatrixBroadcast = false;
          } else {
            // If we weren't the originator, show a brief toast to inform users
            try { showToast('Matrix updated'); } catch (e) {}
          }
        } catch (e) {}
        return;
    }

    switch (data.type) {
      case 'ping':
        window.lastX32Ip = data.from || window.lastX32Ip || null;
        x32Connected = true;
        hideConnectDialog();
        setConnectedStatus(window.lastX32Ip);
        break;
      case 'routing':
        if (Array.isArray(data.values)) {
          dbg('[WS] routing values:', data.values);
          window.routingState = data.values.slice();
          // Clear any _blockTogglePending flags for blocks whose routing now matches
          try {
            window._blockTogglePending = window._blockTogglePending || [false,false,false,false];
            for (let i = 0; i < 4; i++) {
              try {
                if (window._blockTogglePending[i]) {
                  // If the new routing equals either localin or userin for that block we can clear pending
                  const b = (window.blocks && window.blocks[i]) || null;
                  if (!b) { window._blockTogglePending[i] = false; continue; }
                  const newVal = Number(window.routingState[i]);
                  if (newVal === Number(b.localin) || newVal === Number(b.userin)) {
                    window._blockTogglePending[i] = false;
                  }
                }
              } catch (e) { window._blockTogglePending[i] = false; }
            }
          } catch (e) {}
          try { renderRoutingTable(); } catch (e) {}
          try { checkUserIns(); } catch (e) {}
          x32Connected = true;
          hideConnectDialog();
        }
        break;
      case 'blocks':
        if (Array.isArray(data.blocks)) {
          // Normalize to expected shape
          window.blocks = data.blocks.map(b => ({ label: b.label || '', userin: Number(b.userin), localin: Number(b.localin) }));
          try { renderRoutingTable(); } catch (e) {}
        }
        break;
      case 'channel_names':
        if (data.names) {
          window.channelNames = Object.assign({}, window.channelNames || {}, data.names);
          try { renderUserPatches(); } catch (e) {}
        }
        break;
      case 'clp':
        // Example CLP forwarding: update userPatches or channelNames when replies arrive
        if (data.address && typeof data.address === 'string') {
          if (/^\/config\/userrout\/in\//.test(data.address)) {
            const m = data.address.match(/in\/(\d{2})$/);
            if (m && data.args && data.args.length) {
              const ch = Number(m[1]);
              const rawArg = data.args[0];
              const val = (rawArg && typeof rawArg === 'object' && 'value' in rawArg) ? rawArg.value : rawArg;
              window.userPatches = window.userPatches || {}; window.userPatches[ch] = Number(val);
              dbg('[UI] userpatch ch', ch, '=>', window.userPatches[ch]);
              try { window.userPatchesPending = false; renderUserPatches(); checkUserIns(); } catch (e) {}
            }
          } else if (/^\/ch\/(\d{2})\/config\/name$/.test(data.address)) {
            const mm = data.address.match(/^\/ch\/(\d{2})\/config\/name$/);
            if (mm && data.args && data.args.length) {
              const chnum = mm[1]; const name = (data.args[0] && data.args[0].value) ? data.args[0].value : data.args[0];
              window.channelNames = window.channelNames || {}; window.channelNames[chnum] = name;
              try { renderUserPatches(); } catch (e) {}
            }
          }
        }
        break;
      default:
        // ignore other message types
        break;
    }
  } catch (e) { console.error('handleWsMessage failed', e); }
}

function checkUserIns() {
  syncGlobals();
  // If we don't have an explicit connection but we already received
  // per-channel userPatches (e.g. after a page reload the server-side
  // cache may still be present), treat that as 'connected enough' so
  // the UI isn't needlessly greyed out. This improves the refresh UX
  // where buttons appear disabled after reload but work after a manual
  // refresh.
  if (!x32Connected) {
    if (window.userPatches && Object.keys(window.userPatches).length > 0) {
      x32Connected = true; hideConnectDialog();
    } else {
      showConnectDialog();
      document.querySelectorAll('.channel-btn').forEach(btn=>{
        btn.disabled = true;
        btn.style.opacity = 0.5;
        btn.style.pointerEvents = 'none';
      });
      toggleInputsBtn.disabled = false;
      toggleInputsBtn.style.opacity = 1;
      toggleInputsBtn.style.pointerEvents = '';
      return;
    }
  }
  hideConnectDialog();
  if (!Array.isArray(routingState) || routingState.length !== blocks.length) return;
  const allLocal = routingState.every((v,i)=>Number(v)===blocks[i].localin);
  const warning = document.getElementById('userin-warning');
  // If all blocks are LocalIns, show the full error and disable everything
  if (allLocal) {
    if (warning) warning.style.display = '';
    document.querySelectorAll('.channel-btn').forEach(btn=>{
      // skip modal internals
      if (btn.closest && btn.closest('.modal')) return;
      btn.disabled = true;
      btn.style.opacity = 0.5;
      btn.style.pointerEvents = 'none';
    });
    toggleInputsBtn.disabled = false;
    toggleInputsBtn.style.opacity = 1;
    toggleInputsBtn.style.pointerEvents = '';
    statusEl.innerHTML = '<span style="color:#ff5c5c;font-weight:bold;">All inputs are LocalIns — switch at least one block to UserIns to use the app.</span>';
    const swBtn = document.getElementById('switch-to-userins');
    if (swBtn) { swBtn.disabled = false; swBtn.style.opacity = 1; swBtn.style.pointerEvents = ''; }
    return;
  }

  // Mixed state: only grey out channels that belong to blocks currently set to LocalIns
  if (warning) warning.style.display = 'none';
  // compute blocked blocks indexes
  const blocked = [];
  blocks.forEach((b,i)=>{
    if (Number(routingState[i]) === b.localin) blocked.push(i);
  });
  // If user opted to allow toggles even while block is LocalIns, treat blocked as empty
  // (matrix-allow-local-toggle removed: default to be conservative)
  // Build a friendly status message if any blocks are blocked (but not all)
  if (blocked.length > 0) {
    const labels = blocked.map(i=>blocks[i].label).join(', ');
    statusEl.innerHTML = `<span style="color:#ffae42;font-weight:600;">Warning:</span> Channels in block(s) ${labels} cannot be switched while their inputs are LocalIns.`;
  } else {
    setConnectedStatus(window.lastX32Ip);
  }

  // Enable/disable channel buttons per-block
  for (let ch=1; ch<=32; ch++){
    const btn = document.getElementById(`btn-${String(ch).padStart(2,'0')}`);
    if (!btn) continue;
    const blockIdx = Math.floor((ch-1)/8);
    if (blocked.includes(blockIdx)){
      btn.disabled = true;
      btn.style.opacity = 0.5;
      btn.style.pointerEvents = 'none';
    } else {
      btn.disabled = false;
      btn.style.opacity = 1;
      btn.style.pointerEvents = '';
    }
  }
  // Toggle button remains enabled
  toggleInputsBtn.disabled = false;
  toggleInputsBtn.style.opacity = 1;
  toggleInputsBtn.style.pointerEvents = '';
}

// Attach dialog button handlers
window.addEventListener('DOMContentLoaded',()=>{
  const sw = document.getElementById('switch-to-userins');
  if (sw) sw.onclick = ()=>{ safeSendWs(JSON.stringify({type:'toggle_inputs',targets:blocks.map(b=>b.userin)})); setTimeout(()=>safeSendWs(JSON.stringify({type:'load_routing'})),500); };
  // 'matrix-allow-local-toggle' checkbox removed from UI; no initialization required
});

// Set a single block's inputs to UserIns (block index 0..3)
function setBlockToUserIns(blockIdx) {
  syncGlobals();
  try {
    if (!Array.isArray(window.blocks) || !window.blocks[blockIdx]) return;
    const blk = window.blocks[blockIdx];
    // Determine current state and toggle
    const nowLocal = Array.isArray(window.routingState) && Number(window.routingState[blockIdx]) === blk.localin;
    const target = nowLocal ? blk.userin : blk.localin;
    // Mark this block as pending (in-flight) so UI shows spinner and disables the button
    try { window._blockTogglePending = window._blockTogglePending || [false,false,false,false]; window._blockTogglePending[blockIdx] = true; } catch (e) {}
    try { renderRoutingTable(); } catch (e) {}
    // Send a block-specific toggle action to the server/X32
  // Debug log: show exact payload we send
  try { console.log('[DEBUG] -> WS send toggle_inputs_block', JSON.stringify({ type: 'toggle_inputs_block', block: Number(blockIdx), target: Number(target) })); } catch (e) {}
  safeSendWs(JSON.stringify({ type: 'toggle_inputs_block', block: Number(blockIdx), target: Number(target) }));
    // Ask server to refresh routing after a short delay so UI updates
    setTimeout(()=>safeSendWs(JSON.stringify({ type: 'load_routing' })), 500);
    // optimistically update local routingState so UI reflects change immediately
    if (Array.isArray(window.routingState) && window.routingState.length > blockIdx) {
      window.routingState[blockIdx] = Number(target);
      try { renderRoutingTable(); } catch (e) {}
    }
  } catch (e) { console.error('setBlockToUserIns failed', e); }
}

function renderRoutingTable(){
  syncGlobals();
  // The explicit table was removed — update top quick buttons, global toggle
  // and badges instead so the UI is not duplicated. If blocks/routingState
  // are not yet available we skip visual updates.
  if (!Array.isArray(window.blocks) || window.blocks.length === 0) return;
  if (!Array.isArray(window.routingState)) return;
  // Update per-block header buttons (if present)
  try {
    for (let i = 0; i < 4; i++) {
      const btn = document.getElementById('userins-block-' + i);
      if (!btn) continue;
      const b = window.blocks[i];
      // If routingState isn't ready, show pending state
      const hasRouting = Array.isArray(window.routingState) && window.routingState.length > i && window.routingState[i] != null;
      btn.disabled = !hasRouting;
      btn.style.opacity = hasRouting ? 1 : 0.6;
      btn.style.pointerEvents = hasRouting ? '' : 'none';
      try { btn.classList.remove('btn-success','btn-warning','btn-outline-light'); } catch (e) {}
      if (!hasRouting) {
        // show neutral pending label in the badge span
        try { btn.classList.remove('btn-success','btn-warning'); } catch (e) {}
        btn.classList.add('btn-outline-light');
        const badge = btn.querySelector('.btn-badge');
        if (badge) { badge.innerHTML = `<span class="badge" style="background:#6b7280;color:#fff;margin-left:6px">…</span>`; }
        btn.title = `Block ${b.label} status pending — waiting for device`;
      } else {
        const isLocal = Number(window.routingState[i]) === b.localin;
        const pending = (window._blockTogglePending && window._blockTogglePending[i]);
        try { btn.classList.remove('btn-success','btn-warning','btn-outline-light'); } catch (e) {}
        if (pending) {
          // show spinner and disabled look
          btn.disabled = true;
          btn.style.pointerEvents = 'none';
          btn.classList.add('btn-outline-light');
          const badge = btn.querySelector('.btn-badge');
          if (badge) { badge.innerHTML = `<span class="btn-spinner" aria-hidden="true" style="margin-left:8px"></span>`; }
          btn.title = `Block ${b.label} toggle pending…`;
        } else if (isLocal) {
          btn.classList.add('btn-warning');
          const badge = btn.querySelector('.btn-badge');
          if (badge) { badge.innerHTML = `<span class="badge" style="background:#ffae42;color:#111;margin-left:6px">LocalIns</span>`; }
          btn.title = `Block ${b.label} is LocalIns — click to set UserIns`;
        } else {
          btn.classList.add('btn-success');
          const badge = btn.querySelector('.btn-badge');
          if (badge) { badge.innerHTML = `<span class="badge" style="background:#2f855a;color:#fff;margin-left:6px">UserIns</span>`; }
          btn.title = `Block ${b.label} is UserIns — click to set LocalIns`;
        }
      }
    }
  } catch (e) {}
  // Update toggle button appearance and enable it
  const allLocal = routingState.every((v,i)=>Number(v)===blocks[i].localin);
  toggleInputsBtn.classList.toggle('local', allLocal);
  toggleInputsBtn.classList.toggle('user', !allLocal);
  toggleInputsBtn.disabled = false;
  toggleInputsBtn.style.opacity = 1;
  toggleInputsBtn.style.pointerEvents = '';
  renderUserPatches();
  checkUserIns();
}

// Toggle all inputs between LocalIns and UserIns (bound to #toggle-inputs)
function toggleAllInputs() {
  try {
    if (!Array.isArray(blocks) || !Array.isArray(routingState)) return;
    const allLocal = routingState.every((v,i)=>Number(v)===blocks[i].localin);
    const targets = blocks.map(b => allLocal ? b.userin : b.localin);
    safeSendWs(JSON.stringify({ type: 'toggle_inputs', targets }));
    // Ask server to refresh routing after a short delay
    setTimeout(()=>safeSendWs(JSON.stringify({ type: 'load_routing' })), 500);
  } catch (e) {
    console.error('toggleAllInputs failed', e);
  }
}

// Lightweight toast helper to show temporary confirmations
// Toast helper with optional action button: showToast(message, timeoutMs, actionLabel, actionCallback)
function showToast(msg, timeoutMs = 1800, actionLabel = null, actionCallback = null) {
  try {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const t = document.createElement('div');
    t.className = 'dubswitch-toast';
    const text = document.createElement('span'); text.textContent = msg;
    t.appendChild(text);
    if (actionLabel && typeof actionCallback === 'function') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-outline-light';
      btn.style.marginLeft = '10px';
      btn.textContent = actionLabel;
      btn.onclick = function(e){ try { actionCallback(e); } catch (ex) { console.error('toast action failed', ex); } };
      t.appendChild(btn);
    }
    container.appendChild(t);
    // animate in via class
    requestAnimationFrame(()=> t.classList.add('show'));
    setTimeout(()=>{
      t.classList.remove('show');
      setTimeout(()=>{ try{ container.removeChild(t); }catch(e){} }, 240);
    }, timeoutMs);
  } catch (e) { console.error('showToast failed', e); }
}

// Attempt to gracefully reconnect the WebSocket using current API origin
// reconnectWs removed — the app uses the configured origin and expects a restart when port changes

// Simple undo stack for UI-only bulk operations (keeps last snapshot only)
window.__matrixUndoStack = window.__matrixUndoStack || [];

function pushMatrixUndo(snapshot) {
  try {
    // Keep only one-level undo for simplicity
    window.__matrixUndoStack = [snapshot];
  } catch (e) {}
}

function popMatrixUndo() {
  try {
    const s = (window.__matrixUndoStack && window.__matrixUndoStack.length) ? window.__matrixUndoStack.pop() : null;
    return s;
  } catch (e) { return null; }
}

// Enhance toggleAllInputs to show a confirmation and disable the button while
// the change is in-flight. Re-enable on routing reply or after a timeout.
function _enableToggleInputsBtn() {
  try { const btn = document.getElementById('toggle-inputs'); if (btn) { btn.disabled = false; btn.style.opacity = 1; btn.style.pointerEvents = ''; } } catch (e) {}
}

// UX-friendly version of toggleAllInputs: disable button, show toast,
// send WS message, re-enable on routing reply or after a timeout.
function toggleAllInputs() {
  try {
    const btn = document.getElementById('toggle-inputs');
    if (btn) { btn.disabled = true; btn.style.opacity = 0.6; btn.style.pointerEvents = 'none'; }
    showToast('Switching all inputs…');

    // Build and send targets
    try {
      if (!Array.isArray(blocks) || !Array.isArray(routingState)) {
        // nothing to do
        _enableToggleInputsBtn();
        return;
      }
      const allLocal = routingState.every((v,i)=>Number(v)===blocks[i].localin);
      const targets = blocks.map(b => allLocal ? b.userin : b.localin);
      safeSendWs(JSON.stringify({ type: 'toggle_inputs', targets }));
      setTimeout(()=>safeSendWs(JSON.stringify({ type: 'load_routing' })), 500);
      // Re-render and persist matrix shortly after toggling so UI reflects new state
      setTimeout(()=>{ try { renderStaticMatrixTable(); if (window.persistCurrentMatrix) window.persistCurrentMatrix(); } catch (e){} }, 700);
    } catch (e) {
      console.error('toggleAllInputs send failed', e);
      _enableToggleInputsBtn();
      return;
    }

    // Re-enable when a 'routing' message arrives on the websocket
    let reenabled = false;
    function onRoutingMsg(ev) {
      try {
        const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
        if (data && data.type === 'routing') {
          reenabled = true; _enableToggleInputsBtn();
          try { if (window.ws && window.ws.removeEventListener) window.ws.removeEventListener('message', onRoutingMsg); } catch (e) {}
        }
      } catch (e) {}
    }
    try { if (window.ws && window.ws.addEventListener) window.ws.addEventListener('message', onRoutingMsg); } catch (e) {}

    // Safety timeout
    setTimeout(()=>{ if (!reenabled) _enableToggleInputsBtn(); }, 2200);
  } catch (e) { console.error('toggleAllInputs failed', e); _enableToggleInputsBtn(); }
}

// (closeAllPanels removed — modal has its own tabs now)

function renderUserPatches(){
  syncGlobals();
  // Ensure channelMatrix initialized from current toggleMatrix so runtime buttons follow settings
  initChannelMatrixFromBlocks();
  let html="";
  // If we're still waiting for per-channel reads to arrive, render placeholders
  const pending = !!window.userPatchesPending;
  if (pending) {
    html += `<div style="display:flex;align-items:center;justify-content:center;padding:12px;grid-column:1/-1">`;
    html += `<div style="display:flex;align-items:center;gap:12px"><div class="btn-spinner"></div><div class="small-muted">Loading channel routing…</div></div></div>`;
  }
  for(let ch=1;ch<=32;ch++){
    const nn=String(ch).padStart(2,"0");
    let name = `Ch ${nn}`;
    const chKey = nn;
    if((window.channelNamePending||{})[chKey]){
      name = "Updating…";
    } else if((window.channelNames||{})[chKey]!==undefined && (window.channelNames||{})[chKey]!==null && (window.channelNames||{})[chKey]!=""){
      const chVal = (window.channelNames||{})[chKey];
      if(typeof chVal==="object" && "value" in chVal){
        name = String(chVal.value).trim();
      } else if(typeof chVal==="string"){
        name = chVal.trim();
      } else {
        name = String(chVal).trim();
      }
    }
  const uVal=(window.userPatches && window.userPatches[ch])||ch;
    // Always show a friendly, pretty label for the current source value
    let patchTypeText = 'Unknown';
    try {
      patchTypeText = prettySourceLabel(uVal != null ? uVal : '');
    } catch (e) { patchTypeText = (uVal != null) ? String(uVal) : 'Unknown'; }
    html+=`
      <div id="card-${nn}" class="channel-card card">
        <div id="led-${nn}" class="led-top"></div>
        <div class="channel-top">
          <div class="up-num">${nn}</div>
          <button id="rename-icon-${nn}" class="btn-icon-only" aria-label="Rename channel ${nn}" title="Rename ${nn}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 113 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>
          </button>
        </div>
        <div id="btn-${nn}" class="channel-btn card-body">
          <div class="channel-title" id="chname-${nn}">${name}</div>
          <div class="up-type" style="font-size:0.8em;color:#adff2f;margin-top:6px">${patchTypeText}</div>
          <span class="led" id="inner-led-${nn}"></span>
        </div>
      </div>`;
  }
  userpatchContainer.innerHTML=html;

  for(let ch=1;ch<=32;ch++){
    const nn=String(ch).padStart(2,"0");
    const btn = document.getElementById(`btn-${nn}`);
    const card= document.getElementById(`card-${nn}`);
  const cVal=(window.channelColors&&window.channelColors[ch]);
    const uVal=userPatches[ch]||ch;
    if(uVal>=1&&uVal<=32){
      btn.style.backgroundColor = "#222"; // dark grey for Local
    } else if(uVal>=129&&uVal<=160){
      btn.style.backgroundColor = "#0074D9"; // blue for Card
    } else {
      btn.style.backgroundColor = cVal!=null? colorMap[cVal] : "transparent";
    }
    const topLed = document.getElementById(`led-${nn}`);
    const innerLed = document.getElementById(`inner-led-${nn}`);
    if(uVal>=1&&uVal<=32){
      topLed.style.background="#222"; // dark grey for Local
      innerLed.style.background="red";
    } else if(uVal>=129&&uVal<=160){
      topLed.style.background="#39e639"; // green for Card
      innerLed.style.background="green";
    } else {
      topLed.style.background="#333"; innerLed.style.background="#333";
    }
    const nameEl = document.getElementById(`chname-${nn}`);
    const iconEl = document.getElementById(`rename-icon-${nn}`);
    iconEl.onclick = (e) => {
      e.stopPropagation(); // Prevent patch toggle when renaming
      const chKey = nn;
      const currentName = channelNames[chKey] || "";
      const newName = prompt(`Rename channel ${nn}:`, currentName);
      if(newName && newName.trim() && newName !== currentName){
        channelNamePending[chKey] = true;
        renderUserPatches();
        safeSendWs(JSON.stringify({
          type: "clp",
          address: `/ch/${nn}/config/name`,
          args: [newName.trim()]
        }));
        setTimeout(() => {
          safeSendWs(JSON.stringify({
            type: "clp",
            address: `/ch/${nn}/config/name`,
            args: []
          }));
        }, 500);
      }
    };
    btn.onclick = (e) => {
      if (pending) return; // disable interaction while reads are pending
      // Prefer server-persisted per-channel numeric mappings (window._persistedMatrix)
      // If not present or non-numeric, fall back to the in-memory channelMatrix
      let aVal = null, bVal = null;
      // Ensure mapping is available in this scope so diagnostics can reference it safely
      let mapping = channelMatrix[ch] || { aAction: 'LocalIns', bAction: 'DAW', param: null };
      try {
        const nnKey = String(ch).padStart(2,'0');
        const persistedRow = (window._persistedMatrix && window._persistedMatrix[nnKey]) ? window._persistedMatrix[nnKey] : null;
        if (persistedRow) {
          const pa = persistedRow.a != null ? Number(persistedRow.a) : NaN;
          const pb = persistedRow.b != null ? Number(persistedRow.b) : NaN;
          if (Number.isFinite(pa)) aVal = pa;
          if (Number.isFinite(pb)) bVal = pb;
        }
      } catch (e) {}
      // Fallback to computed actions if persisted numeric values are not available
      if (!Number.isFinite(aVal) || !Number.isFinite(bVal)) {
        if (!Number.isFinite(aVal)) aVal = computeValueForAction(ch, mapping.aAction, mapping.param);
        if (!Number.isFinite(bVal)) bVal = computeValueForAction(ch, mapping.bAction, mapping.param);
      }
      // Default currentVal to A if we don't have an explicit userPatch
      const currentVal = (userPatches[ch] != null) ? Number(userPatches[ch]) : aVal;
      let targetVal = null;
      if (aVal != null && bVal != null) {
        targetVal = (currentVal === aVal) ? bVal : aVal;
      } else {
        // fallback to old behavior using routingState to guess Local vs Card
        const rsVal = (routingState[Math.floor((ch-1)/8)] != null) ? Number(routingState[Math.floor((ch-1)/8)]) : null;
        const isLocal = (rsVal >= 1 && rsVal <= 32) || false;
        targetVal = isLocal ? 128 + ch : ch;
      }
      if (targetVal == null) return;
  console.debug(`Channel ${ch} click -> A=${mapping.aAction}(${aVal}), B=${mapping.bAction}(${bVal}), current=${currentVal}, sending=${targetVal}`);
      userPatches[ch]=targetVal;
      safeSendWs(JSON.stringify({
        type:"clp",
        address:`/config/userrout/in/${nn}`,
        args:[targetVal]
      }));
      renderUserPatches();
    };
  }
}

function togglePanel(panel) {
  // Tabs control visibility now; togglePanel is intentionally a no-op.
}

// Send custom OSC (CLP) from the settings form. Parses a simple
// comma-separated args string and forwards a JSON 'clp' message to the server.
function sendCustomOSC() {
  try {
    const addrEl = document.getElementById('clp-address');
    const argsEl = document.getElementById('clp-args');
    if (!addrEl) return;
  const address = (addrEl.value || '').trim();
    const argsRaw = (argsEl && argsEl.value) ? argsEl.value.trim() : '';
    const args = [];
    if (argsRaw.length) {
      // Split on commas but allow quoted strings
      const parts = argsRaw.split(',').map(s=>s.trim()).filter(s=>s.length);
      for (const p of parts) {
        if (/^-?\d+$/.test(p)) args.push(Number(p));
        else if (/^-?\d+\.\d+$/.test(p)) args.push(Number(p));
        else {
          // strip surrounding quotes if present
          const m = p.match(/^"(.*)"$/);
          args.push(m ? m[1] : p);
        }
      }
    }
  if (!address || address[0] !== '/') { showToast('Invalid OSC address (must start with /)'); return; }
  console.log('CLP sending from UI:', address, args);
  safeSendWs(JSON.stringify({ type: 'clp', address, args }));
    // small UX feedback
    showToast('OSC sent');
  } catch (e) { console.error('sendCustomOSC failed', e); }
}

// Focus trap for settings modal
(function setupModalFocusTrap(){
  const modal = document.getElementById('settingsModal');
  if(!modal) return;
  modal.addEventListener('shown.bs.modal', ()=>{
    const focusable = modal.querySelectorAll('a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])');
    if(focusable.length) focusable[0].focus();
    const first = focusable[0];
    const last = focusable[focusable.length-1];
    function trap(e){
      if(e.key === 'Tab'){
        if(e.shiftKey){ // shift+tab
          if(document.activeElement === first){
            e.preventDefault(); last.focus();
          }
        } else {
          if(document.activeElement === last){
            e.preventDefault(); first.focus();
          }
        }
      } else if(e.key === 'Escape'){
        try{ $('#settingsModal').modal('hide'); } catch(e){}
      }
    }
    modal.addEventListener('keydown', trap);
    modal.addEventListener('hidden.bs.modal', ()=>{
      modal.removeEventListener('keydown', trap);
    }, { once: true });
  });
})();

// Wire the Settings button to open the Settings modal (explicit handler)
window.addEventListener('DOMContentLoaded', ()=>{
  try {
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', (e) => {
        try {
          // Use Bootstrap's modal if available
          if (window.jQuery && typeof window.jQuery === 'function') {
            window.jQuery('#settingsModal').modal('show');
            return;
          }
          // Fallback: manually make the modal visible and add a backdrop
          const modal = document.getElementById('settingsModal');
          if (!modal) return;
          modal.classList.add('show');
          modal.style.display = 'block';
          modal.setAttribute('aria-modal', 'true');
          // add a backdrop so visual checks succeed
          let backdrop = document.querySelector('.modal-backdrop');
          if (!backdrop) {
            backdrop = document.createElement('div');
            backdrop.className = 'modal-backdrop fade show';
            document.body.appendChild(backdrop);
          } else {
            backdrop.classList.add('show');
          }
          document.body.classList.add('modal-open');
        } catch (err) {
          try {
            const modal = document.getElementById('settingsModal'); if (modal) { modal.style.display = 'block'; modal.classList.add('show'); }
          } catch(e){}
        }
      });
    }
  } catch (e) {}
});

// --- UI wiring fallback: ensure buttons work even if DOMContentLoaded already fired ---
(function ensureCoreButtonsWired(){
  function wireOnce(id, handler){
    try {
      const el = document.getElementById(id);
      if (el && !el.dataset.wired) { el.addEventListener('click', handler); el.dataset.wired = '1'; }
    } catch (e) {}
  }
  function wireDiagnosticsGroup(){
    try {
      const diagBtn = document.getElementById('diagnosticsBtn');
      if (diagBtn && !diagBtn.dataset.wired) {
        diagBtn.dataset.wired = '1';
        diagBtn.addEventListener('click', ()=>{
          try {
            try { dbg('diagnosticsBtn click (fallback)'); } catch(_){}
            if (window.jQuery) window.jQuery('#diagnosticsModal').modal('show');
            else {
              const m = document.getElementById('diagnosticsModal');
              if (m) {
                m.classList.add('show'); m.style.display='block';
                // simple backdrop if bootstrap JS not active
                let backdrop = document.querySelector('.modal-backdrop');
                if (!backdrop) { backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop fade show'; document.body.appendChild(backdrop); }
                document.body.classList.add('modal-open');
              }
            }
            if (typeof fetchDiagnostics === 'function') fetchDiagnostics();
            // Start auto-refresh every 4s while modal is open
            try {
              if (window.__diagnosticsAutoInterval) clearInterval(window.__diagnosticsAutoInterval);
              window.__diagnosticsAutoInterval = setInterval(()=>{
                const mod = document.getElementById('diagnosticsModal');
                if (!mod) return;
                const isOpen = window.jQuery ? window.jQuery(mod).hasClass('show') : (mod.style.display !== 'none' && mod.classList.contains('show'));
                if (isOpen) { if (typeof fetchDiagnostics === 'function') fetchDiagnostics(); }
                else { try { clearInterval(window.__diagnosticsAutoInterval); window.__diagnosticsAutoInterval = null; } catch(_){} }
              }, 4000);
            } catch(_){}
          } catch (e) { try { showToast('Failed to open diagnostics'); } catch(_){} }
        }, { passive: true });
      }
      const diagRefresh = document.getElementById('diagnostics-refresh');
      if (diagRefresh && !diagRefresh.dataset.wired) { diagRefresh.dataset.wired = '1'; diagRefresh.addEventListener('click', fetchDiagnostics, { passive: true }); }
      const diagCopyStatus = document.getElementById('diagnostics-copy-status');
      if (diagCopyStatus && !diagCopyStatus.dataset.wired) {
        diagCopyStatus.dataset.wired = '1';
        diagCopyStatus.addEventListener('click', ()=>{ const out = document.getElementById('diagnostics-status'); if (!out) return; navigator.clipboard.writeText(out.textContent||'').then(()=> showToast('Status copied to clipboard')).catch(()=> showToast('Copy failed')); }, { passive: true });
      }
      const diagCopyMatrix = document.getElementById('diagnostics-copy-matrix');
      if (diagCopyMatrix && !diagCopyMatrix.dataset.wired) {
        diagCopyMatrix.dataset.wired = '1';
        diagCopyMatrix.addEventListener('click', ()=>{ const out = document.getElementById('diagnostics-matrix-file'); if (!out) return; navigator.clipboard.writeText(out.textContent||'').then(()=> showToast('Matrix info copied')).catch(()=> showToast('Copy failed')); }, { passive: true });
      }
    } catch (e) {}
  }
  function wireSettingsBtn(){
    try {
      const settingsBtn = document.getElementById('settingsBtn');
      if (settingsBtn && !settingsBtn.dataset.wired) {
        settingsBtn.dataset.wired = '1';
        settingsBtn.addEventListener('click', (e) => {
          try {
            try { dbg('settingsBtn click (fallback)'); } catch(_){}
            if (window.jQuery && typeof window.jQuery === 'function') {
              window.jQuery('#settingsModal').modal('show');
              return;
            }
            const modal = document.getElementById('settingsModal');
            if (!modal) return;
            modal.classList.add('show');
            modal.style.display = 'block';
            modal.setAttribute('aria-modal', 'true');
            let backdrop = document.querySelector('.modal-backdrop');
            if (!backdrop) { backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop fade show'; document.body.appendChild(backdrop); }
            else { backdrop.classList.add('show'); }
            document.body.classList.add('modal-open');
          } catch (err) {
            try { const modal = document.getElementById('settingsModal'); if (modal) { modal.style.display = 'block'; modal.classList.add('show'); } } catch(e){}
          }
        });
      }
    } catch (e) {}
  }
  function wireAll(){ wireSettingsBtn(); wireDiagnosticsGroup(); }
  // Also wire Matrix tab activation to re-render its content
  try {
    const tabLink = document.getElementById('tab-matrix-link');
    if (tabLink && !tabLink.dataset.wired) {
      tabLink.dataset.wired = '1';
      const activate = async () => {
        try {
          dbg && dbg('Matrix tab activated: ensuring table render');
          // Try to refresh persisted data once when the tab is opened
          try {
            const resp = await fetch(apiUrl('/get-matrix'));
            if (resp && resp.ok) { const j = await resp.json().catch(()=>null); if (j && j.matrix) window._persistedMatrix = j.matrix; }
          } catch (e) {}
          try { renderStaticMatrixTable(); } catch (e) {}
        } catch (e) {}
      };
      tabLink.addEventListener('click', activate, { passive: true });
      // If Bootstrap tabs are present, also react to the "shown" event
      try { if (window.jQuery) window.jQuery(tabLink).on('shown.bs.tab', activate); } catch (_) {}
    }
  } catch (e) {}
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireAll, { once: true });
  } else {
    // DOM already parsed, wire now
    wireAll();
  }
})();

// Fallback: support [data-dismiss="modal"] close buttons without Bootstrap JS
(function addModalDismissFallback(){
  try {
    document.addEventListener('click', function(ev){
      let t = ev.target;
      while (t && t !== document) {
        if (t.matches && t.matches('[data-dismiss="modal"]')) {
          const modal = t.closest('.modal');
          if (!modal) return;
          if (window.jQuery && typeof window.jQuery === 'function') {
            try { window.jQuery(modal).modal('hide'); } catch(_){}
          } else {
            modal.classList.remove('show');
            modal.style.display = 'none';
            const backdrop = document.querySelector('.modal-backdrop'); if (backdrop) backdrop.remove();
            document.body.classList.remove('modal-open');
          }
          return;
        }
        t = t.parentNode;
      }
    }, true);
  } catch (_) {}
})();

// Message handling is centralized in handleWsMessage which is assigned
// to window.ws.onmessage inside createWs(). No duplicate handlers here.

window.onload=()=>{
  dbg('window.onload fired');
  showConnectDialog(true);
  initialConnectShown = false;
  x32Connected = false;
  if (connectDialogTimeout) clearTimeout(connectDialogTimeout);
  connectDialogTimeout = setTimeout(()=>{
    if (x32Connected) {
      hideConnectDialog();
      setConnectedStatus(window.lastX32Ip);
    } else {
      dbg('Still not connected after initial delay; starting interval watcher.');
      connectDialogTimeout = setInterval(()=>{
        if (x32Connected) {
          hideConnectDialog();
          setConnectedStatus(window.lastX32Ip);
          clearInterval(connectDialogTimeout);
          connectDialogTimeout = null;
        }
      }, 500);
    }
  }, 3000);
  renderUserPatches();
  loadChannelNames(); // Explicitly load channel names from X32 on start
  refreshUserPatches();
  safeSendWs(JSON.stringify({type:"load_routing"}));
};

// Matrix functionality has been intentionally removed server-side and client-side.
// Provide safe defaults and no-op stubs so existing UI logic and event handlers
// that reference matrix functions don't throw errors.

// Ensure toggleMatrix exists but is not used to control device state.
let toggleMatrix = null;

// Per-channel A/B mapping derived from blocks (safe defaults)
const channelMatrix = window.channelMatrix || {};
function initChannelMatrixDefaults() {
  for (let ch = 1; ch <= 32; ch++) channelMatrix[ch] = { aAction: 'LocalIns', bAction: 'DAW', param: null };
}
// initialize defaults immediately
try { initChannelMatrixDefaults(); } catch (e) { console.error('initChannelMatrixDefaults failed', e); }

// replace formerly active inference/persistence routines with safe no-ops
function inferActionFromValue() { return 'LocalIns'; }
function buildMatrixFromCurrentState() { initChannelMatrixDefaults(); renderStaticMatrixTable(); }
function scheduleInferMatrix() { /* no-op (matrix inference removed) */ }
function requestMatrix() { /* no-op (server matrix removed) */ }

// Render helpers fall back to the static visual renderer
function renderMatrix() { renderStaticMatrixTable(); }
function renderPerChannelMatrix() { renderStaticMatrixTable(); }

// Safe initializer used by other parts of the app
function initChannelMatrixFromBlocks() { try { initChannelMatrixDefaults(); } catch (e) {} }

// Disable overrides modal (matrix overrides removed)
function openOverridesModal(blockIdx) {
  // Informative UX fallback
  alert('Per-channel overrides have been disabled in this build. The Matrix in Settings is visual-only.');
}

// Neutralize any previously-installed WS matrix bridge
try { window.handleMatrixWs = function(){ /* matrix messages ignored */ }; } catch (e) {}

// Autosave / allow-local toggles removed from UI; no-op guards removed

// Ensure the static matrix is rendered on load (idempotent)
window.addEventListener('DOMContentLoaded', () => { try { renderStaticMatrixTable(); } catch (e) {} });
