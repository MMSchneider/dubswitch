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
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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
  { osc: '/config/routing/IN/1-8', userin: 20, localin: 0 },
  { osc: '/config/routing/IN/9-16', userin: 21, localin: 1 },
  { osc: '/config/routing/IN/17-24', userin: 22, localin: 2 },
  { osc: '/config/routing/IN/25-32', userin: 23, localin: 3 }
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

// Channel name cache
const channelNames = {};
// Server-side cache of per-channel user patch values (updated when CLP replies arrive)
const userPatches = {};

oscPort.on('message', (msg, timeTag, info) => {
  // discovery replies
  if (msg.address === '/xinfo') {
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
          req.ws.send(JSON.stringify({ type: 'routing', values: req.values }));
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
  routingRequests[reqId] = { ws, values: Array(routingBlocks.length).fill(null), got: Array(routingBlocks.length).fill(false), replies: 0, timeout: setTimeout(() => {
    const req = routingRequests[reqId]; if (req) { currentRoutingState = req.values.slice(); req.ws.send(JSON.stringify({ type: 'routing', values: req.values })); delete routingRequests[reqId]; }
  }, 2000) };
  routingBlocks.forEach(block => { try { sendOsc({ address: block.osc, args: [] }, X32_IP); } catch (e) {} });
}

wss.on('connection', ws => {
  console.log('WebSocket client connected');
  try { sendOsc({ address: '/xinfo', args: [] }, X32_IP); } catch (e) {}
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

      case 'toggle_inputs_block':
        if (typeof data.block === 'number' && data.block >= 0 && data.block < routingBlocks.length) {
          const idx = data.block; const val = Number(data.target);
          console.log('[X32 ROUTE] Sending OSC for block', idx, val);
          try { sendOsc({ address: routingBlocks[idx].osc, args: [{ type: 'i', value: val }] }, X32_IP); } catch (e) { console.error('Error sending block toggle OSC', e && e.message); }
          setTimeout(() => { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) readAllRouting(c); }); }, 500);
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
        const oscArgs = (data.args || []).map(v => Number.isInteger(v) ? { type: 'i', value: v } : (typeof v === 'number' ? { type: 'f', value: v } : { type: 's', value: String(v) }));
        const padAddr = data.address.replace(/(\d+)$/, m => m.padStart(2, '0'));
        console.log('CLP sending:', padAddr, oscArgs);
  try { sendOsc({ address: padAddr, args: oscArgs }, X32_IP); } catch (e) { console.error('Error sending CLP', e && e.message); }
        break;

      default:
        console.log('Unhandled WS message type:', data.type);
    }
  });
});

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

// Start HTTP server
server.listen(3000, '0.0.0.0', () => console.log('Web UI listening on http://localhost:3000'));

module.exports = { app, server };
