/*
  server.js
  ----------------
  Node/Express + OSC + WebSocket backend for DubSwitch.

  Responsibilities
  - Serve the static UI (./public) and static resources.
  - Discover and maintain the X32 device IP via OSC /xinfo broadcasts.
  - Forward OSC replies to WebSocket-connected clients and accept
    control commands from clients (CLP writes, routing toggles, matrix ops).

  Key runtime data structures
  - routingBlocks: descriptor list for the 4 routing blocks and their
      corresponding CLP values (userin/localin) used to toggle device routing.
  - currentRoutingState: cached snapshot of the most recently observed
      routing values for the 4 blocks.

  Message flows
  - Clients connect via WebSocket. On connect the server triggers /xinfo
    (to warm discovery) and queries the X32 for channel names, routing and
    user patches. Replies are forwarded back to clients as 'clp' and 'routing'.
  - Clients can request get_matrix/set_matrix/preview_matrix/apply_matrix to
    manage the persisted toggle matrix. set_matrix writes matrix.json to disk.

  Security / safety notes
  - The server assumes a trusted local network and does not implement
    authentication. Be cautious if exposing this server beyond your LAN.
*/
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const osc = require('osc');

const app = express();
const fs = require('fs');
// server and wss are created by startServer so we can rebind at runtime
let server = null;
let wss = null;

// Serve static UI
app.use(express.static(path.join(__dirname, 'public')));
app.use('/resources', express.static(path.join(__dirname, 'resources')));

// Version endpoint
const pkg = require('./package.json');
app.get('/version', (req, res) => res.send(pkg.version));

// X32 discovery and OSC settings
let X32_IP = null;
const X32_OSC_PORT = 10023;
const LOCAL_OSC_PORT = 9001;

function getBroadcastAddress() {
  const ifaces = os.networkInterfaces();
  for (const name in ifaces) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const ipOctets = iface.address.split('.').map(n => parseInt(n, 10));
        const maskOctets = iface.netmask.split('.').map(n => parseInt(n, 10));
        const bcOctets = ipOctets.map((oct, i) => (oct & maskOctets[i]) | (~maskOctets[i] & 0xff));
        return bcOctets.join('.');
      }
    }
  }
  return '255.255.255.255';
}
const BROADCAST_ADDR = getBroadcastAddress();

// Routing block descriptors (OSC address + representative values)
const routingBlocks = [
  { label: '1-8', osc: '/config/routing/IN/1-8', userin: 20, localin: 0 },
  { label: '9-16', osc: '/config/routing/IN/9-16', userin: 21, localin: 1 },
  { label: '17-24', osc: '/config/routing/IN/17-24', userin: 22, localin: 2 },
  { label: '25-32', osc: '/config/routing/IN/25-32', userin: 23, localin: 3 }
];

let currentRoutingState = [null, null, null, null];
const routingRequests = {};
let routingRequestId = 1;

// OSC UDP port
const oscPort = new osc.UDPPort({ localAddress: '0.0.0.0', localPort: LOCAL_OSC_PORT, broadcast: true, metadata: true });
oscPort.setMaxListeners(0);

oscPort.on('ready', () => {
  console.log('OSC port ready — broadcasting /xinfo');
  try { sendOsc({ address: '/xinfo', args: [] }, BROADCAST_ADDR); } catch (e) { /* ignore */ }
});

// Diagnostics counters
let pingCount = 0;

// Channel name cache
const channelNames = {};
// Server-side cache of per-channel user patch values (updated when CLP replies arrive)
const userPatches = {};

// Persisted matrix mapping (per-channel A/B) stored on disk
const MATRIX_PATH = path.join(__dirname, 'matrix.json');
let persistedMatrix = {};
try {
  if (fs.existsSync(MATRIX_PATH)) {
    persistedMatrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8') || '{}') || {};
  }
} catch (e) { console.warn('Failed to read existing matrix.json:', e && e.message); persistedMatrix = {}; }

// Persisted HTTP port file (simple text file containing port number)
const PORT_PERSIST_PATH = path.join(__dirname, 'server.port');
let persistedPort = null;
try {
  if (fs.existsSync(PORT_PERSIST_PATH)) {
    const txt = fs.readFileSync(PORT_PERSIST_PATH, 'utf8').trim();
    const n = Number(txt || '');
    if (n && n > 0 && n <= 65535) persistedPort = n;
  }
} catch (e) { /* ignore */ }

// Track the currently-bound HTTP port (updated when server listens)
let CURRENT_PORT = null;

oscPort.on('message', (msg, timeTag, info) => {
  try {
    // Debug: log routing-related incoming messages so we can inspect replies
    if (msg && msg.address && String(msg.address).includes('/config/routing/IN')) {
      try { console.log('[OSC IN] ->', info && info.address, msg.address, JSON.stringify(msg.args || [])); } catch (e) { console.log('[OSC IN] (err)'); }
    }
  } catch (e) {}
  // discovery replies
  if (msg.address === '/xinfo') {
    pingCount++;
    if (!X32_IP) updateX32Ip(info.address, 'initial-discovery');
    else if (X32_IP !== info.address) updateX32Ip(info.address, 'discovery-reply');
    else console.log('Ping OK from', info.address);
    // broadcast ping to connected clients
    wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', from: info.address })); });
  }

  // routing replies for pending requests
  for (const [reqId, req] of Object.entries(routingRequests)) {
    routingBlocks.forEach((block, i) => {
      if (!req.got[i] && msg.address === block.osc && Array.isArray(msg.args) && msg.args.length) {
        const raw = msg.args[0];
        const val = (raw && typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
        req.values[i] = Number(val); req.got[i] = true; req.replies++;
        if (req.replies === routingBlocks.length) {
          clearTimeout(req.timeout);
          currentRoutingState = req.values.slice();
          try { req.ws.send(JSON.stringify({ type: 'routing', values: req.values })); } catch (e) {}
          // Broadcast to all connected clients to ensure everyone observes the new state
          try { if (wss && wss.clients) wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'routing', values: req.values })); }); } catch (e) {}
          delete routingRequests[reqId];
        }
      }
    });
  }

  // Forward CLP and channel name/color replies
  if (msg.address.startsWith('/config/userrout/in/') || /^\/ch\/\d{2}\/config\/name$/.test(msg.address) || /^\/ch\/\d{2}\/config\/color$/.test(msg.address)) {
    const payload = { type: 'clp', address: msg.address, args: msg.args || [] };
    // Update userPatches cache when we receive /config/userrout/in/NN replies
    if (/^\/config\/userrout\/in\/(\d{2})$/.test(msg.address) && msg.args && msg.args.length) {
      const ch = Number(msg.address.match(/^\/config\/userrout\/in\/(\d{2})$/)[1]);
      const raw = msg.args[0];
      const val = (raw && typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
      userPatches[ch] = Number(val);
    }
    if (/^\/ch\/(\d{2})\/config\/name$/.test(msg.address) && msg.args && msg.args.length) {
      const chNum = msg.address.match(/^\/ch\/(\d{2})\/config\/name$/)[1];
      const name = (msg.args[0] && typeof msg.args[0] === 'object' && 'value' in msg.args[0]) ? msg.args[0].value : msg.args[0];
      channelNames[chNum] = name;
      wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'channel_names', names: channelNames })); });
    } else {
      wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); });
    }
  }
});

// Enumerate possible source codes by probing a conservative set of likely values
// This endpoint will query the X32 for a set of addresses/values and return what it sees.
app.get('/enumerate-sources', async (req, res) => {
  if (!X32_IP) return res.status(400).json({ error: 'X32 not set' });
  // Candidate numeric values to probe (conservative expanded set)
  const probes = [];
  // Local inputs
  for (let i = 1; i <= 32; i++) probes.push(i);
  // DAW/Card range commonly 129..160
  for (let i = 129; i <= 160; i++) probes.push(i);
  // block userin codes
  [20,21,22,23].forEach(v => probes.push(v));
  // AES50 ranges: include reasonable windows for AES50 A and B
  for (let i = 33; i <= 96; i++) probes.push(i);
  for (let i = 97; i <= 128; i++) probes.push(i);
  // Ultranet / other external ranges sometimes use higher numbers — include a short sample
  for (let i = 200; i <= 220; i++) probes.push(i);
  // MADI / exotic ranges near 240..260 — small sample
  for (let i = 240; i <= 250; i++) probes.push(i);

  // For each channel, try setting a read for its user rout and collect replies
  const results = {};
  const timeout = Date.now() + 3000;
  try {
    // Request current per-channel values (server will populate userPatches)
    for (let ch = 1; ch <= 32; ch++) {
      const nn = String(ch).padStart(2, '0');
      sendOsc({ address: `/config/userrout/in/${nn}`, args: [] }, X32_IP);
    }
    // Wait briefly for replies (shorter wait if possible)
    await new Promise(resolve => setTimeout(resolve, 1200));
    // Build results from cached userPatches and classify values into ranges
    const unique = {};
    for (let ch = 1; ch <= 32; ch++) {
      const key = String(ch).padStart(2,'0');
      const val = (userPatches[ch] != null) ? Number(userPatches[ch]) : null;
      let label = 'Unknown';
      if (val == null) label = 'Unknown';
      else if (val >= 1 && val <= 32) label = 'Local';
      else if (val >= 33 && val <= 80) label = 'AES50A';
      else if (val >= 81 && val <= 128) label = 'AES50B';
      else if (val >= 129 && val <= 160) label = 'DAW';
      else if ([20,21,22,23].includes(val)) label = 'UserInsBlock';
      else label = 'Other';
      results[key] = { value: val, label };
      if (val != null) unique[val] = (unique[val] || 0) + 1;
    }
    // Also produce a small summary of unique values seen
    const uniques = Object.keys(unique).sort((a,b)=>Number(a)-Number(b)).map(k=>({ value: Number(k), count: unique[k] }));
    return res.json({ ip: X32_IP, userPatches: results, uniques });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message) });
  }
});

// Accept POST body payloads (JSON) for setting per-channel matrix entries.
app.use(express.json({ limit: '100kb' }));

// Save per-channel mapping: { channel: { aAction: 'LocalIns'|'DAW'|..., aValue: 12 }, ... }
app.post('/set-channel-matrix', (req, res) => {
  try {
    const body = req.body || {};
    // Validate input is an object keyed by channel (01..32)
    const entries = Object.keys(body).filter(k => /^\d{2}$/.test(k));
    if (entries.length === 0) return res.status(400).json({ error: 'no channel entries' });
    for (const ch of entries) {
      persistedMatrix[ch] = body[ch];
    }
    // Persist to disk atomically (write to temp then rename) and reload
    try {
        const tmp = MATRIX_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(persistedMatrix, null, 2), 'utf8');
        fs.renameSync(tmp, MATRIX_PATH);
        try {
          // Reload canonical matrix from disk to ensure we return what was actually written
          const raw = fs.readFileSync(MATRIX_PATH, 'utf8') || '{}';
          persistedMatrix = JSON.parse(raw) || persistedMatrix;
        } catch (e) {
          console.warn('Failed to reload matrix.json after write:', e && e.message);
        }
      } catch (e) {
        // Enhanced error logging to aid debugging when clients report save failures
        try {
          const errDetails = { message: (e && e.message) || String(e), stack: (e && e.stack) || null };
          console.error('Failed to write matrix.json atomically:', errDetails);
          // Log the incoming payload for diagnosis
          try { console.error('Incoming payload that failed to persist:', JSON.stringify(body)); } catch (ee) { console.error('Failed to stringify incoming payload'); }
          // Attempt a fallback write directly (non-atomic) and log outcome
          try {
            fs.writeFileSync(MATRIX_PATH, JSON.stringify(persistedMatrix, null, 2), 'utf8');
            console.warn('Fallback: wrote matrix.json directly (non-atomic) after atomic write failed');
            // Return success but include a warning so clients can surface a non-critical message
            return res.json({ ok: true, matrix: persistedMatrix, warning: 'atomic write failed, fallback write used. Check server logs for details.' });
          } catch (e2) {
            console.error('Fallback write also failed:', e2 && e2.message);
            // Return 500 to the client with a helpful message
            return res.status(500).json({ ok: false, error: 'atomic write failed and fallback write also failed: ' + (e2 && e2.message) });
          }
        } catch (inner) { console.error('Error while logging matrix.json write failure', inner && inner.message); }
    }
    // Broadcast to connected WebSocket clients to refresh their UIs
    wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'matrix_update', matrix: persistedMatrix })); });
    // Always return the canonical persisted matrix so clients re-render server truth
    return res.json({ ok: true, matrix: persistedMatrix });
  } catch (e) { return res.status(500).json({ error: String(e && e.message) }); }
});

// Troubleshooting helper: report matrix.json file status, ownership and a small sample
app.get('/troubleshoot/matrix-file', (req, res) => {
  try {
    const info = { path: MATRIX_PATH, exists: false };
    try {
      const stat = fs.statSync(MATRIX_PATH);
      info.exists = true;
      info.size = stat.size;
      info.mtime = stat.mtime;
      info.uid = stat.uid;
      info.gid = stat.gid;
      info.mode = (stat.mode & 0o777).toString(8);
    } catch (e) {
      // file missing or inaccessible
      info.exists = false;
      info.error = (e && e.message) || String(e);
    }
    // Try a small read if possible
    if (info.exists) {
      try {
        const raw = fs.readFileSync(MATRIX_PATH, 'utf8');
        info.sample = raw.length > 2000 ? raw.slice(0, 2000) + '\n...[truncated]' : raw;
      } catch (e) {
        info.readError = (e && e.message) || String(e);
      }
    }
    return res.json({ ok: true, info });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
});

oscPort.on('error', err => console.error('UDP OSC Error:', err && err.message));
oscPort.open();

// Wrapper for oscPort.send that logs outgoing packets for debugging
function sendOsc(msg, host) {
  try {
    const dest = host || X32_IP || BROADCAST_ADDR;
    const port = X32_OSC_PORT;
    const argRepr = (msg.args || []).map(a => {
      if (a == null) return null;
      if (typeof a === 'object' && 'type' in a && 'value' in a) return { type: a.type, value: a.value };
      if (typeof a === 'object') return a;
      return { type: typeof a, value: a };
    });
    console.log('[OSC SEND] ->', dest + ':' + port, msg.address, argRepr);
    oscPort.send(msg, dest, port);
  } catch (e) {
    console.error('sendOsc failed', e && e.message);
  }
}

function readAllRouting(ws) {
  const reqId = routingRequestId++;
  console.log('[ROUTING] start req', reqId);
  routingRequests[reqId] = { ws, values: Array(routingBlocks.length).fill(null), got: Array(routingBlocks.length).fill(false), replies: 0, timeout: setTimeout(() => {
    const req = routingRequests[reqId];
      if (req) {
      currentRoutingState = req.values.slice();
      try { req.ws.send(JSON.stringify({ type: 'routing', values: req.values })); console.log('[ROUTING] timeout send req', reqId, 'values', req.values); } catch (e) { console.error('[ROUTING] timeout send failed', e && e.message); }
      try { if (wss && wss.clients) wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'routing', values: req.values })); }); } catch (e) {}
      delete routingRequests[reqId];
    }
  }, 2000) };
  routingBlocks.forEach(block => { try { sendOsc({ address: block.osc, args: [] }, X32_IP); } catch (e) {} });
}

function setupWebsocketHandlers(currentWss) {
  currentWss.on('connection', ws => {
    console.log('WebSocket client connected');
    try { sendOsc({ address: '/xinfo', args: [] }, X32_IP); } catch (e) {}
  // Send routing block descriptors to client so UI knows userin/localin codes
  try { ws.send(JSON.stringify({ type: 'blocks', blocks: routingBlocks })); } catch (e) {}
  readAllRouting(ws);
    for (let ch = 1; ch <= 32; ch++) {
      const nn = String(ch).padStart(2, '0');
      try { sendOsc({ address: `/config/userrout/in/${nn}`, args: [] }, X32_IP); } catch (e) {}
      try { sendOsc({ address: `/ch/${nn}/config/name`, args: [] }, X32_IP); } catch (e) {}
      try { sendOsc({ address: `/ch/${nn}/config/color`, args: [] }, X32_IP); } catch (e) {}
    }
    ws.send(JSON.stringify({ type: 'channel_names', names: channelNames }));
    if (currentRoutingState && currentRoutingState.some(v => v !== null)) ws.send(JSON.stringify({ type: 'routing', values: currentRoutingState }));

    ws.on('message', raw => {
      let data;
      try { data = JSON.parse(raw); } catch (e) { return; }

      if (data && data.type === 'set_x32_ip') {
        X32_IP = data.ip; console.log('Manual X32 IP set to', X32_IP);
        try { sendOsc({ address: '/xinfo', args: [] }, X32_IP); } catch (e) {}
        for (let ch = 1; ch <= 32; ch++) { const nn = String(ch).padStart(2, '0'); try { sendOsc({ address: `/ch/${nn}/config/name`, args: [] }, X32_IP); } catch (e) {} }
        setTimeout(() => readAllRouting(ws), 300);
        return;
      }
      if (!X32_IP) return console.warn('X32 not connected yet.');

      switch (data.type) {
        case 'load_routing':
          readAllRouting(ws);
          break;

        case 'get_blocks':
          // Client explicitly requested block descriptors and current routing
          try { ws.send(JSON.stringify({ type: 'blocks', blocks: routingBlocks })); } catch (e) {}
          try { if (currentRoutingState && currentRoutingState.some(v => v !== null)) ws.send(JSON.stringify({ type: 'routing', values: currentRoutingState })); } catch (e) {}
          break;

        case 'toggle_inputs_block':
          if (typeof data.block === 'number' && data.block >= 0 && data.block < routingBlocks.length) {
            const idx = data.block; const val = Number(data.target);
            console.log('[X32 ROUTE] Sending OSC for block', idx, val);
            try { sendOsc({ address: routingBlocks[idx].osc, args: [{ type: 'i', value: val }] }, X32_IP); } catch (e) { console.error('Error sending block toggle OSC', e && e.message); }
            setTimeout(() => { if (wss && wss.clients) wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) readAllRouting(c); }); }, 500);
          } else console.warn('toggle_inputs_block: invalid block index', data.block);
          break;

        case 'toggle_inputs':
          if (Array.isArray(data.targets) && data.targets.length === routingBlocks.length) {
            data.targets.forEach((val, i) => { try { sendOsc({ address: routingBlocks[i].osc, args: [{ type: 'i', value: val }] }, X32_IP); } catch (e) { console.error('Error sending toggle', e && e.message); } });
            setTimeout(() => { readAllRouting(ws); }, 500);
          }
          break;

        case 'ping':
          try { oscPort.send({ address: '/xinfo', args: [] }, X32_IP, X32_OSC_PORT); } catch (e) {}
          break;

        case 'clp':
          try {
            const rawAddr = (data.address || '').toString();
            const addr = rawAddr.trim();
            if (!addr || addr[0] !== '/') { console.warn('Received invalid CLP address from client:', JSON.stringify(rawAddr)); break; }
            const oscArgs = (data.args || []).map(v => Number.isInteger(v) ? { type: 'i', value: v } : (typeof v === 'number' ? { type: 'f', value: v } : { type: 's', value: String(v) }));
            // Only pad a trailing numeric segment when it's directly after a slash
            // so we don't accidentally change addresses like '/config/routing/IN/1-8'
            // (which would otherwise become '/config/routing/IN/1-08').
            const padAddr = addr.replace(/\/(\d+)$/, (m, p1) => '/' + p1.padStart(2, '0'));
            console.log('CLP sending:', padAddr, oscArgs);
            try { sendOsc({ address: padAddr, args: oscArgs }, X32_IP); } catch (e) { console.error('Error sending CLP', e && e.message, 'payload:', JSON.stringify({ address: padAddr, args: oscArgs })); }
          } catch (e) { console.error('CLP handler failed', e && e.message); }
          break;

        default:
          console.log('Unhandled WS message type:', data.type);
      }
    });
  });
}

// Helper to (re)start the HTTP + WebSocket server on a given port
function startServer(port) {
  return new Promise((resolve, reject) => {
    try {
      if (server) {
        try { server.close(); } catch (e) {}
        server = null; wss = null;
      }
      server = http.createServer(app);
      wss = new WebSocket.Server({ server });
      setupWebsocketHandlers(wss);
      server.listen(port, '0.0.0.0', () => {
        CURRENT_PORT = port;
        console.log(`Web UI listening on http://localhost:${port}`);
        resolve(server);
      });
      server.on('error', err => { reject(err); });
    } catch (e) { reject(e); }
  });
}

function updateX32Ip(newIp, reason = 'discovery') {
  if (!newIp) return;
  if (X32_IP === newIp) return console.log('updateX32Ip: IP unchanged', newIp);
  const prior = X32_IP; X32_IP = newIp; console.log('X32 IP updated', prior, '->', X32_IP, '(', reason, ')');
  for (let ch = 1; ch <= 32; ch++) { const nn = String(ch).padStart(2, '0'); try { oscPort.send({ address: `/ch/${nn}/config/name`, args: [] }, X32_IP, X32_OSC_PORT); } catch (e) {} }
  setTimeout(() => { wss.clients.forEach(ws => readAllRouting(ws)); }, 300);
  try { if (global.pingInterval) clearInterval(global.pingInterval); } catch (e) {}
  global.pingInterval = setInterval(() => { try { oscPort.send({ address: '/xinfo', args: [] }, X32_IP, X32_OSC_PORT); } catch (e) {} }, 5000);
}

// Autodiscover endpoint: broadcast /xinfo and wait briefly for responses
app.get('/autodiscover-x32', (req, res) => {
  const priorIp = X32_IP;
  console.log('Autodiscover requested (prior X32_IP =', priorIp, ')');
  try { oscPort.send({ address: '/xinfo', args: [] }, BROADCAST_ADDR, X32_OSC_PORT); } catch (e) { console.error('Broadcast /xinfo failed', e && e.message); }
  let responded = false;
  const deadline = Date.now() + 2000;
  const interval = setInterval(() => {
    if (!responded && X32_IP && X32_IP !== priorIp) {
      responded = true; clearInterval(interval); return res.json({ ip: X32_IP });
    }
    if (Date.now() > deadline) { clearInterval(interval); return res.json({ ip: X32_IP || null }); }
  }, 200);
});

// Quick status endpoint for diagnostics (X32 IP, WS clients, ping counters)
app.get('/status', (req, res) => {
  try {
    const clients = Array.from(wss.clients || []).filter(c => c && c.readyState === WebSocket.OPEN).length;
    const ifaces = os.networkInterfaces();
    return res.json({ ok: true, x32Ip: X32_IP || null, wsClients: clients, pingCount, ifaces, port: CURRENT_PORT || Number(process.env.PORT) || 3000 });
  } catch (e) { return res.status(500).json({ ok: false, error: e && e.message }); }
});

// Allow changing the HTTP server port at runtime. This will attempt to
// rebind the server to the requested port and return success or failure.
app.post('/set-port', express.json(), (req, res) => {
  try {
    const body = req.body || {};
    const port = Number(body.port || 0);
    if (!port || port < 1 || port > 65535) return res.status(400).json({ ok: false, reason: 'invalid port' });
    // Persist the chosen port to disk and exit so the app can be restarted
    try {
      // Atomic write: write to a temp file then rename into place
      const tmp = PORT_PERSIST_PATH + '.tmp';
      try {
        fs.writeFileSync(tmp, String(port), 'utf8');
        fs.renameSync(tmp, PORT_PERSIST_PATH);
      } catch (fsErr) {
        // Cleanup tmp on failure if present
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (u) {}
        throw fsErr;
      }
      res.json({ ok: true, port, message: 'port_saved_restart_required' });
      console.log('Persisted new port', port, 'to', PORT_PERSIST_PATH, '- exiting to allow restart.');
      // No detached spawn here — the host (Electron main or external supervisor)
      // is responsible for restarting the server after we exit. Give the
      // response a moment to complete before exiting.
      console.log('Persisted port and exiting; supervisor should restart server.');
      setTimeout(() => process.exit(0), 200);
    } catch (e) {
      console.error('Failed to write port file', e && e.message);
      return res.status(500).json({ ok: false, reason: 'write_failed', error: e && e.message });
    }
  } catch (e) { return res.status(500).json({ ok: false, error: e && e.message }); }
});

// Dev-only helper: trigger the external supervisor to restart the server
// This endpoint is intentionally restricted to local requests (127.0.0.1 / ::1 / localhost)
// or when the environment variable DUBSWITCH_DEV_ALLOW_SUPERVISOR=1 is set. It works by
// touching/writing the `server.port` file so the dev supervisor (scripts/supervise-server.js)
// notices the change and restarts the child process. This keeps production builds safe.
app.post('/supervisor-restart', (req, res) => {
  try {
    const allowByEnv = process.env.DUBSWITCH_DEV_ALLOW_SUPERVISOR === '1';
    // Express sets req.ip; strip IPv4-mapped IPv6 prefix if present
    const remote = (req.ip || '').replace(/^::ffff:/, '');
    const hostHeader = (req.hostname || '').toLowerCase();
    if (!allowByEnv) {
      // Accept only local loopback addresses or explicit localhost hostnames
      const isLocal = remote === '127.0.0.1' || remote === '::1' || hostHeader === 'localhost';
      if (!isLocal) return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    try {
      const data = String(CURRENT_PORT || Number(process.env.PORT) || 3000);
      // Prefer an atomic write to update mtime/content and avoid partial-writes
      const tmp = PORT_PERSIST_PATH + '.tmp';
      try {
        fs.writeFileSync(tmp, data, 'utf8');
        fs.renameSync(tmp, PORT_PERSIST_PATH);
      } catch (e) {
        // Fallback: if file exists, just update its mtime; otherwise write file
        try {
          if (fs.existsSync(PORT_PERSIST_PATH)) fs.utimesSync(PORT_PERSIST_PATH, new Date(), new Date());
          else fs.writeFileSync(PORT_PERSIST_PATH, data, 'utf8');
        } catch (e2) {
          // Last-resort: ignore failure but log it
          console.warn('supervisor-restart: failed to touch port file', e2 && e2.message);
        }
      }
    } catch (e) { /* ignore minor touch errors */ }

    console.log('Dev supervisor-restart triggered by', req.ip || req.hostname);
    return res.json({ ok: true, triggered: true });
  } catch (e) { return res.status(500).json({ ok: false, error: e && e.message }); }
});

// Dev-only supervisor status endpoint: reports PID, whether the PID is running,
// and a small tail of the supervised child's log files for debugging in the UI.
app.get('/supervisor-status', (req, res) => {
  try {
    const allowByEnv = process.env.DUBSWITCH_DEV_ALLOW_SUPERVISOR === '1';
    const remote = (req.ip || '').replace(/^::ffff:/, '');
    const hostHeader = (req.hostname || '').toLowerCase();
    if (!allowByEnv) {
      const isLocal = remote === '127.0.0.1' || remote === '::1' || hostHeader === 'localhost';
      if (!isLocal) return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const PID_FILE = path.join(__dirname, 'scripts', 'supervisor.pid');
    const SUP_OUT = path.join(__dirname, 'scripts', 'supervisor.out.log');
    const CHILD_LOG = path.join(__dirname, 'server_child.log');

    const info = { ok: true, pidFileExists: false, pid: null, pidRunning: false, pidMtime: null, supervisorOut: null, childLog: null };
    try {
      if (fs.existsSync(PID_FILE)) {
        info.pidFileExists = true;
        try { const pidTxt = fs.readFileSync(PID_FILE, 'utf8').trim(); info.pid = Number(pidTxt) || null; } catch (e) {}
        try { const st = fs.statSync(PID_FILE); info.pidMtime = st.mtime; } catch (e) {}
      }
    } catch (e) {}

    if (info.pid) {
      try {
        // Check if process exists (kill 0 will throw if not present on some platforms)
        process.kill(info.pid, 0);
        info.pidRunning = true;
      } catch (e) { info.pidRunning = false; }
    }

    // Supervisor stdout/log (small metadata)
    try {
      if (fs.existsSync(SUP_OUT)) {
        const st = fs.statSync(SUP_OUT);
        info.supervisorOut = { path: SUP_OUT, size: st.size, mtime: st.mtime };
      }
    } catch (e) {}

    // Tail of child log (last ~4KB) to avoid heavy reads
    try {
      if (fs.existsSync(CHILD_LOG)) {
        const st = fs.statSync(CHILD_LOG);
        const size = st.size;
        const tailBytes = 4096;
        const start = Math.max(0, size - tailBytes);
        const fd = fs.openSync(CHILD_LOG, 'r');
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        info.childLog = { path: CHILD_LOG, size, mtime: st.mtime, tail: buf.toString('utf8') };
      }
    } catch (e) { /* swallow */ }

    return res.json(info);
  } catch (e) { return res.status(500).json({ ok: false, error: e && e.message }); }
});

// Return persisted matrix if any
app.get('/get-matrix', (req, res) => {
  return res.json({ matrix: persistedMatrix || {} });
});

// Start HTTP server on the configured port (persistedPort overrides env)
const PORT = persistedPort || Number(process.env.PORT) || 3000;

(async () => {
  try {
    await startServer(PORT);
    module.exports = { app, server };
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`EADDRINUSE: port ${PORT} is unavailable. Please choose a different port or free the port.`);
      console.error(`Tip: run \`lsof -nP -iTCP:${PORT} -sTCP:LISTEN\` to find the process, or start with a different port: \`PORT=4000 node server.js\`.`);
      process.exit(1);
    }
    console.error('Failed to start server:', err && err.message);
    process.exit(1);
  }
})();
