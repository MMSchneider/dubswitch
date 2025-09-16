// server.js
const os = require("os");
const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const osc = require("osc");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let X32_IP = null;
const X32_OSC_PORT   = 10023;
const LOCAL_OSC_PORT = 9001;

// Serve your UI from ./public
app.use(express.static(path.join(__dirname, "public")));

// Serve version from package.json
// Autodiscover X32 IP endpoint
app.get('/autodiscover-x32', (req, res) => {
  // Always attempt a fresh discovery so we don't return a stale cached IP.
  const priorIp = X32_IP;
  console.log('⟳ /autodiscover-x32 requested (prior X32_IP =', priorIp, ')');
  // Broadcast /xinfo to the network
  try {
    oscPort.send({ address: "/xinfo", args: [] }, BROADCAST_ADDR, X32_OSC_PORT);
  } catch (err) {
    console.error('Error sending /xinfo broadcast:', err && err.message);
  }

  let responded = false;
  const deadline = Date.now() + 2000;
  const interval = setInterval(() => {
    // If a new IP was discovered (different from prior), prefer that immediately
    if (!responded && X32_IP && X32_IP !== priorIp) {
      responded = true;
      clearInterval(interval);
      console.log('Autodiscover: new X32 IP discovered ->', X32_IP);
      return res.json({ ip: X32_IP });
    }
    // timed out: return the most recent IP we have (could be priorIp or null)
    if (Date.now() > deadline) {
      clearInterval(interval);
      const replyIp = X32_IP || null;
      console.log('Autodiscover: timeout, returning', replyIp);
      return res.json({ ip: replyIp });
    }
  }, 200);
});
const pkg = require('./package.json');
app.get('/version', (req, res) => {
  res.send(pkg.version);
});

// Listen immediately on port 8080
server.listen(3000, "0.0.0.0", () => {
  console.log("✅ Web UI listening on http://localhost:3000");
});

// Compute broadcast address from your NICs
function getBroadcastAddress() {
  const ifaces = os.networkInterfaces();
  for (const name in ifaces) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        const ipOctets   = iface.address.split('.').map(n=>parseInt(n,10));
        const maskOctets = iface.netmask.split('.').map(n=>parseInt(n,10));
        const bcOctets = ipOctets.map((oct,i) =>
          (oct & maskOctets[i]) | (~maskOctets[i] & 0xFF)
        );
        return bcOctets.join('.');
      }
    }
  }
  return "255.255.255.255";
}
const BROADCAST_ADDR = getBroadcastAddress();
console.log("▶️  Using broadcast address:", BROADCAST_ADDR);

// Ping keep-alive interval handle so we can reset it when IP changes
let pingInterval = null;

// Centralized X32 IP setter that performs initial queries and resets keep-alive
function updateX32Ip(newIp, reason = 'discovery') {
  if (!newIp) return;
  if (X32_IP === newIp) {
    console.log(`updateX32Ip: IP unchanged (${newIp})`);
    return;
  }
  const prior = X32_IP;
  X32_IP = newIp;
  console.log(`🔧 X32 IP updated from ${prior} -> ${X32_IP} (reason: ${reason})`);
  // Query channel names after discovery/change
  for (let ch = 1; ch <= 32; ch++) {
    const nn = String(ch).padStart(2, "0");
    oscPort.send({ address: `/ch/${nn}/config/name`, args: [] }, X32_IP, X32_OSC_PORT);
  }
  // Query routing blocks after a short delay
  setTimeout(() => {
    wss.clients.forEach(ws => readAllRouting(ws));
  }, 300);
  // Reset keep-alive ping interval
  try { if (pingInterval) clearInterval(pingInterval); } catch(e) {}
  pingInterval = setInterval(() => {
    try {
      oscPort.send({ address: "/xinfo", args: [] }, X32_IP, X32_OSC_PORT);
    } catch (e) { console.error('Ping send error', e && e.message); }
  }, 5000);
}

// Routing blocks definition
const routingBlocks = [
  { osc: "/config/routing/IN/1-8",   userin: 20, localin: 0 },
  { osc: "/config/routing/IN/9-16",  userin: 21, localin: 1 },
  { osc: "/config/routing/IN/17-24", userin: 22, localin: 2 },
  { osc: "/config/routing/IN/25-32", userin: 23, localin: 3 }
];

// Track in-flight routing requests
const routingRequests = {};
let routingRequestId = 1;

// Open OSC port with metadata enabled
const oscPort = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort:    LOCAL_OSC_PORT,
  broadcast:    true,
  metadata:     true
});
// Prevent EventEmitter listener warnings
oscPort.setMaxListeners(0);

oscPort.on("ready", () => {
  console.log("🔍 Sending /xinfo broadcast to find X32…");
  oscPort.send({ address: "/xinfo", args: [] }, BROADCAST_ADDR, X32_OSC_PORT);
});

oscPort.on("message", (msg, timeTag, info) => {
  // — Discovery & ping replies —
  if (msg.address === "/xinfo") {
    // Prefer the latest responder — update X32_IP if it's newly discovered or changed
    if (!X32_IP) {
      updateX32Ip(info.address, 'initial-discovery');
    } else if (X32_IP !== info.address) {
      // A different device responded; prefer the latest responder
      console.log(`Notice: /xinfo reply from different IP ${info.address} (current ${X32_IP}), switching.`);
      updateX32Ip(info.address, 'discovery-reply');
    } else {
      console.log(`✅ Ping OK from ${info.address}`);
    }
    // Broadcast ping status to all clients
    wss.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping", from: info.address }));
      }
    });
  }

  // — Routing replies for pending requests —
  for (const [reqId, req] of Object.entries(routingRequests)) {
    routingBlocks.forEach((block, i) => {
      if (
        !req.got[i] &&
        msg.address === block.osc &&
        Array.isArray(msg.args) &&
        msg.args.length
      ) {
        const raw = msg.args[0];
        const val = (raw && typeof raw === "object" && "value" in raw)
          ? raw.value
          : raw;
        req.values[i] = Number(val);
        req.got[i]   = true;
        req.replies++;
        if (req.replies === routingBlocks.length) {
          clearTimeout(req.timeout);
          console.log(">>> Sending routing to browser:", req.values);
          req.ws.send(JSON.stringify({ type: "routing", values: req.values }));
          delete routingRequests[reqId];
        }
      }
    });
  }

  // — Forward User-Patch, Channel-Name, and Channel-Color replies —
    if (
      msg.address.startsWith("/config/userrout/in/") ||
      /^\/ch\/\d{2}\/config\/name$/.test(msg.address) ||
      /^\/ch\/\d{2}\/config\/color$/.test(msg.address)
    ) {
      const payload = {
        type:    "clp",
        address: msg.address,
        args:    msg.args || []
      };
      // Store channel names for mapping
      if (/^\/ch\/(\d{2})\/config\/name$/.test(msg.address) && msg.args && msg.args.length) {
        const chNum = msg.address.match(/^\/ch\/(\d{2})\/config\/name$/)[1];
        const name = (msg.args[0] && typeof msg.args[0] === "object" && "value" in msg.args[0]) ? msg.args[0].value : msg.args[0];
        channelNames[chNum] = name;
        // Broadcast all channel names to clients
        wss.clients.forEach(ws => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "channel_names", names: channelNames }));
          }
        });
      } else {
        wss.clients.forEach(ws => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
          }
        });
      }
    }

  // — Debug log all incoming OSC args —
  if (msg.args && msg.args.length) {
    msg.args.forEach((arg, i) => console.log(`   arg[${i}]:`, arg));
  } else {
    console.log("   (no args)");
  }
});

oscPort.on("error", err => {
  console.error("UDP OSC Error:", err.message);
});

oscPort.open();

// Helper to query all routing blocks
function readAllRouting(ws) {
  const reqId = routingRequestId++;
  routingRequests[reqId] = {
    ws,
    values:  Array(routingBlocks.length).fill(null),
    got:     Array(routingBlocks.length).fill(false),
    replies: 0,
    timeout: setTimeout(() => {
      const req = routingRequests[reqId];
      if (req) {
        console.log(">>> Routing (timeout):", req.values);
        req.ws.send(JSON.stringify({ type: "routing", values: req.values }));
        delete routingRequests[reqId];
      }
    }, 2000)
  };
  routingBlocks.forEach(block => {
    oscPort.send({ address: block.osc, args: [] }, X32_IP, X32_OSC_PORT);
  });
}

// Store channel names for mapping
const channelNames = {};

// WebSocket: handle client commands
wss.on("connection", ws => {
  console.log("✅ WebSocket client connected");
  // send ping + routing on connect
  oscPort.send({ address: "/xinfo", args: [] }, X32_IP, X32_OSC_PORT);
  readAllRouting(ws); // <-- this triggers routing replies
  // On new connection, preload user patch, names, and colors
  for (let ch = 1; ch <= 32; ch++) {
    const nn = String(ch).padStart(2, "0");
    oscPort.send({ address: `/config/userrout/in/${nn}`, args: [] }, X32_IP, X32_OSC_PORT);
    oscPort.send({ address: `/ch/${nn}/config/name`, args: [] }, X32_IP, X32_OSC_PORT);
    oscPort.send({ address: `/ch/${nn}/config/color`, args: [] }, X32_IP, X32_OSC_PORT);
  }
  // Send current channel names to new client
  ws.send(JSON.stringify({ type: "channel_names", names: channelNames }));
  ws.on("message", raw => {
    const data = JSON.parse(raw);
    // Allow client to set manual X32 IP before discovery
    if (data && data.type === 'set_x32_ip') {
      X32_IP = data.ip;
      console.log(`🔧 Manual X32 IP set to ${X32_IP} by client`);
      // Trigger initial queries
      oscPort.send({ address: "/xinfo", args: [] }, X32_IP, X32_OSC_PORT);
      for (let ch = 1; ch <= 32; ch++) {
        const nn = String(ch).padStart(2, "0");
        oscPort.send({ address: `/ch/${nn}/config/name`, args: [] }, X32_IP, X32_OSC_PORT);
      }
      setTimeout(() => readAllRouting(ws), 300);
      return;
    }
    if (!X32_IP) return console.warn("X32 not connected yet.");

    switch (data.type) {
      case "load_routing":
        readAllRouting(ws);
        break;

      case "toggle_inputs":
        if (Array.isArray(data.targets) && data.targets.length === routingBlocks.length) {
          data.targets.forEach((val, i) => {
            console.log(`[X32 ROUTE] Sending OSC:`, {
              address: routingBlocks[i].osc,
              value: val,
              ip: X32_IP,
              port: X32_OSC_PORT
            });
            oscPort.send(
              { address: routingBlocks[i].osc, args: [{ type: "i", value: val }] },
              X32_IP,
              X32_OSC_PORT
            );
          });
          console.log('[X32 ROUTE] Refreshing routing state after toggle...');
          setTimeout(() => {
            readAllRouting(ws);
          }, 500);
        }
        break;

      case "ping":
        oscPort.send({ address: "/xinfo", args: [] }, X32_IP, X32_OSC_PORT);
        break;

      case "clp":
        // Build OSC args from JS values
        const oscArgs = (data.args || []).map(v =>
          Number.isInteger(v) ? { type: "i", value: v }
            : typeof v === "number"   ? { type: "f", value: v }
            :                           { type: "s", value: String(v) }
        );

        // Zero-pad trailing channel numbers for /ch/XX/... addresses
        const padAddr = data.address.replace(/(\d+)$/, m => m.padStart(2, "0"));
        console.log(`📤 CLP sending: ${padAddr}`, oscArgs);
        oscPort.send({ address: padAddr, args: oscArgs }, X32_IP, X32_OSC_PORT);
        break;
    }
  });
});
