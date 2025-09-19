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

// Helper to send via WebSocket only when open
// Send data over the global WebSocket if it's open. If the socket is not
// yet open, attach a one-time 'open' listener to send once the connection
// becomes ready. This prevents losing messages during startup when the
// connection may still be initializing.
function safeSendWs(data) {
  if (window.ws && window.ws.readyState === 1) {
    window.ws.send(data);
  } else {
    // Wait for connection, then send once
    if (window.ws) {
      const onceOpen = () => {
        if (window.ws && window.ws.readyState === 1) window.ws.send(data);
        window.ws.removeEventListener('open', onceOpen);
      };
      window.ws.addEventListener('open', onceOpen);
    }
  }
}

// --- Safe defaults / shims for missing globals (prevent page errors) ---
// Gate the larger compatibility shims behind a dev-only flag so production
// builds are not polluted. The small, essential stubs used by inline HTML
// event handlers remain always-present to avoid ReferenceErrors.
const IS_DEV = (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || window.__DUBSWITCH_DEV_SHIMS__ === true);

// Minimal DOM element fallbacks used by various functions below. If the
// real element exists, these will be replaced by actual nodes during
// normal runtime (DOMContentLoaded handlers). These placeholders prevent
// attempts to access properties of `null`.
const _noopEl = () => ({ disabled: false, style: {}, innerHTML: '', textContent: '', addEventListener() {}, removeEventListener() {} });
window.statusEl = document.getElementById('status') || _noopEl();
window.toggleInputsBtn = document.getElementById('toggle-inputs') || _noopEl();
window.routingTable = document.getElementById('routing-table') || _noopEl();
window.userpatchContainer = document.getElementById('userpatch-container') || _noopEl();

// Simple connect-dialog helpers used throughout the app. They try to
// manipulate the DOM when the elements exist; otherwise they are safe no-ops.
function showConnectDialog(force) {
  const el = document.getElementById('connect-warning');
  if (el) el.style.display = '';
  window.initialConnectShown = window.initialConnectShown || !!force;
}
function hideConnectDialog() {
  const el = document.getElementById('connect-warning');
  if (el) el.style.display = 'none';
}
function setConnectedStatus(ip) {
  try {
    const s = document.getElementById('status');
    if (s) s.textContent = ip ? `Status: Connected (${ip})` : 'Status: Connected';
  } catch (e) {}
}

// Lightweight flag used by UI logic
window.x32Connected = window.x32Connected || false;
window.connectDialogTimeout = window.connectDialogTimeout || null;
window.initialConnectShown = window.initialConnectShown || false;

// Essential stubs that are referenced directly by HTML onload/onclick.
// These remain available in all environments to avoid race conditions.
// Improved refresh: re-request per-channel CLP reads when called while WS is open.
function refreshUserPatches() {
  try {
    // If WS is open, request fresh CLP reads for user routs and channel names
    if (window.ws && window.ws.readyState === 1) {
      for (let ch = 1; ch <= 32; ch++) {
        const nn = String(ch).padStart(2, '0');
        safeSendWs(JSON.stringify({ type: 'clp', address: `/config/userrout/in/${nn}`, args: [] }));
        safeSendWs(JSON.stringify({ type: 'clp', address: `/ch/${nn}/config/name`, args: [] }));
      }
      // mark as pending so UI shows spinner until at least one reply
      window.userPatchesPending = true;
      renderUserPatches();
      try { renderStaticMatrixTable(); } catch (e) {}
      return;
    }
    if (typeof renderUserPatches === 'function') renderUserPatches();
    else loadChannelNames();
  } catch (e) { console.error('refreshUserPatches failed', e); }
}

function setAllUserPatchesLocal() {
  // Set all channels to Local (numeric 1..32) in-memory and notify server
  try {
    for (let ch = 1; ch <= 32; ch++) { window.userPatches[ch] = ch; }
    safeSendWs(JSON.stringify({ type: 'toggle_inputs', targets: (window.blocks||[]).map(b => b.localin || 0) }));
    if (typeof renderUserPatches === 'function') renderUserPatches();
    try { renderStaticMatrixTable(); if (window.persistCurrentMatrix) window.persistCurrentMatrix(); } catch (e) {}
  } catch (e) { console.error('setAllUserPatchesLocal failed', e); }
}

function setAllUserPatchesCard() {
  // Set all channels to DAW (example offset 128+ch)
  try {
    for (let ch = 1; ch <= 32; ch++) { window.userPatches[ch] = 128 + ch; }
    safeSendWs(JSON.stringify({ type: 'toggle_inputs', targets: (window.blocks||[]).map(b => b.userin || 0) }));
    if (typeof renderUserPatches === 'function') renderUserPatches();
    try { renderStaticMatrixTable(); if (window.persistCurrentMatrix) window.persistCurrentMatrix(); } catch (e) {}
  } catch (e) { console.error('setAllUserPatchesCard failed', e); }
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
      window.ws.close();
    }
  } catch (e) { /* ignore */ }
  window.ws = new WebSocket(url);
  window.ws.onopen = () => {
    console.log('WebSocket open ->', url);
    // After opening the WS, request current routing and per-channel user routings
    // so the UI can initialize button states from the device.
    try {
      // Ask server to load routing (server will query the X32 and reply with 'routing')
      safeSendWs(JSON.stringify({ type: 'load_routing' }));
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
    console.log('WebSocket closed');
    x32Connected = false;
    showConnectDialog();
    statusEl.textContent = 'Status: Disconnected';
  };
  window.ws.onerror = (e) => {
    console.log('WebSocket error', e);
    statusEl.textContent = 'Status: WebSocket error';
  };
  window.ws.onmessage = handleWsMessage;
}

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

  // Block-level configuration has been removed; keep a short explanatory note
  let html = `<div class="small-muted" style="margin-bottom:8px">Block-level toggle configuration has been removed. Use the per-channel A/B table below to inspect or reference enumerated inputs.</div>`;
  // Legend removed — only show explanatory note and the per-channel table
  // Per-channel A/B view (visual only)
  html += `<div class="table-responsive" style="margin-top:12px"><table class="table table-sm"><thead><tr><th>Ch</th><th>A</th><th>B</th></tr></thead><tbody>`;
  for (let ch = 1; ch <= 32; ch++) {
    const nn = String(ch).padStart(2,'0');
    html += `<tr><td>${nn}</td>`;
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
        fetch('/set-channel-matrix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
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
}

// Render static table once DOM ready
window.addEventListener('DOMContentLoaded', ()=>{ renderStaticMatrixTable(); });
// Attempt to fetch enumerate results at startup so the Matrix A column
// pre-selects known enumerated sources when available.
window.addEventListener('DOMContentLoaded', async ()=>{
  try {
    if (!window.enumerateResults) {
      const resp = await fetch('/enumerate-sources');
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

// Rebind important DOM elements once the DOM is ready and render routing
// table so it appears in the correct tab. Previously these globals were
// initialized before DOMContentLoaded which could leave them as noop
// placeholders and prevent the routing table from being rendered into the
// Settings -> Routing tab.
window.addEventListener('DOMContentLoaded', ()=>{
  try {
    window.statusEl = document.getElementById('status') || window.statusEl || _noopEl();
    window.toggleInputsBtn = document.getElementById('toggle-inputs') || window.toggleInputsBtn || _noopEl();
    window.routingTable = document.getElementById('routing-table') || window.routingTable || _noopEl();
    window.userpatchContainer = document.getElementById('userpatch-container') || window.userpatchContainer || _noopEl();
    // Ensure channel names are present for UI rendering
    try { loadChannelNames(); } catch (e) {}
    // Render routing table now that the DOM element exists
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
    // Create WebSocket connection to the same origin so the client can
    // receive routing, channel_names and clp messages from the server.
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = proto + '//' + location.host;
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
            const res = await fetch('/autodiscover-x32');
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
          } catch (e) { console.error('saveIp failed', e); }
        };
      }
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
            const resp = await fetch('/enumerate-sources');
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
          window.routingState = data.values.slice();
          try { renderRoutingTable(); } catch (e) {}
          try { checkUserIns(); } catch (e) {}
          x32Connected = true;
          hideConnectDialog();
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
              console.debug('[UI] Received userpatch for ch', ch, '=>', window.userPatches[ch]);
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
    warning.style.display = '';
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
    document.getElementById('switch-to-userins').disabled = false;
    document.getElementById('switch-to-userins').style.opacity = 1;
    document.getElementById('switch-to-userins').style.pointerEvents = '';
    return;
  }

  // Mixed state: only grey out channels that belong to blocks currently set to LocalIns
  warning.style.display = 'none';
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
  document.getElementById('switch-to-userins').onclick = ()=>{
    safeSendWs(JSON.stringify({type:'toggle_inputs',targets:blocks.map(b=>b.userin)}));
    setTimeout(()=>safeSendWs(JSON.stringify({type:'load_routing'})),500);
  };
  // 'matrix-allow-local-toggle' checkbox removed from UI; no initialization required
});

function renderRoutingTable(){
  // Build a cleaner table with badges and clear status
  let html = `
    <thead><tr><th>Block</th><th>Current</th></tr></thead>
    <tbody>
  `;
  blocks.forEach((b,i)=>{
    const v = Number(routingState[i]);
    let txt = '';
    let badgeClass = 'badge-secondary';
    if (v === b.userin) {
      txt = `UserIns ${b.label}`;
      badgeClass = 'badge-success';
    } else if (v === b.localin) {
      txt = `LocalIns ${b.label}`;
      badgeClass = 'badge-warning';
    } else if (v === 0 && b.localin !== 0) {
      txt = `LocalIns ${b.label}`;
      badgeClass = 'badge-warning';
    } else if (v >= 1 && v <= 32 && channelNames[v]) {
      txt = `Other (${v}) — ${channelNames[v]}`;
      badgeClass = 'badge-info';
    } else {
      txt = `Other (${v})`;
      badgeClass = 'badge-secondary';
    }
    // Add inline toggle control to flip this block between Local and User
    const toggleId = `blk-toggle-${i}`;
    const toggleBtn = `<button id="${toggleId}" class="btn btn-sm btn-outline-light" data-block="${i}">Toggle</button>`;
    html += `<tr><td>${b.label}</td><td><span class="badge ${badgeClass}">${txt}</span></td><td style="width:110px">${toggleBtn}</td></tr>`;
  });
  html += `</tbody>`;
  routingTable.innerHTML = html;
  // Wire inline block toggles — always enabled so user can flip a block back and forth
  blocks.forEach((b,i)=>{
    const id = `blk-toggle-${i}`;
    const el = document.getElementById(id);
    if(el){
      const isLocal = Number(routingState[i]) === b.localin;
      // Label shows the action that will be taken when clicked
      el.disabled = false;
      el.style.opacity = 1;
      el.style.pointerEvents = '';
      el.textContent = isLocal ? 'Set UserIns' : 'Set LocalIns';
      el.onclick = () => {
        // flip this block's state
        const nowLocal = Number(routingState[i]) === b.localin;
        routingState[i] = nowLocal ? b.userin : b.localin;
        // notify server about the toggle for that block
        safeSendWs(JSON.stringify({type:'toggle_inputs_block',block:i,target:routingState[i]}));
        // reload UI
        renderRoutingTable();
      };
    }
  });
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
function showToast(msg, timeoutMs = 1800) {
  try {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    const t = document.createElement('div');
    t.className = 'dubswitch-toast';
    t.textContent = msg;
    container.appendChild(t);
    // animate in via class
    requestAnimationFrame(()=> t.classList.add('show'));
    setTimeout(()=>{
      t.classList.remove('show');
      setTimeout(()=>{ try{ container.removeChild(t); }catch(e){} }, 240);
    }, timeoutMs);
  } catch (e) { console.error('showToast failed', e); }
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
    if(channelNamePending[chKey]){
      name = "Updating…";
    } else if(channelNames[chKey]!==undefined && channelNames[chKey]!==null && channelNames[chKey]!=""){
      if(typeof channelNames[chKey]==="object" && "value" in channelNames[chKey]){
        name = String(channelNames[chKey].value).trim();
      } else if(typeof channelNames[chKey]==="string"){
        name = channelNames[chKey].trim();
      } else {
        name = String(channelNames[chKey]).trim();
      }
    }
    const uVal=userPatches[ch]||ch;
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
    const cVal=channelColors[ch];
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
    const address = addrEl.value || '';
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

// Message handling is centralized in handleWsMessage which is assigned
// to window.ws.onmessage inside createWs(). No duplicate handlers here.

window.onload=()=>{
  showConnectDialog(true);
  initialConnectShown = false;
  x32Connected = false;
  if (connectDialogTimeout) clearTimeout(connectDialogTimeout);
  connectDialogTimeout = setTimeout(()=>{
    if (x32Connected) {
      hideConnectDialog();
      setConnectedStatus(window.lastX32Ip);
    } else {
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
