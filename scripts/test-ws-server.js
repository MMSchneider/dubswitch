#!/usr/bin/env node
// Simple WebSocket test server to validate client messages during headless tests
const WebSocket = require('ws');
const port = process.env.TEST_WS_PORT || 9009;
const wss = new WebSocket.Server({ port }, ()=>console.log('Test WS server listening on', port));
wss.on('connection', ws => {
  console.log('Test WS client connected');
});
let lastMsg = null;
// keep a small rolling history of recent messages for test inspection
let lastMessages = [];
  wss.on('connection', ws => {
    ws.on('message', m => {
      try { lastMsg = JSON.parse(m); } catch (e) { lastMsg = m; }
      try { lastMessages.push(lastMsg); if (lastMessages.length > 50) lastMessages.shift(); } catch (e) {}
      console.log('Test WS received:', JSON.stringify(lastMsg));
    // Echo simple routing reply when toggle_inputs arrives so client can re-enable UI
    try {
      if (lastMsg && (lastMsg.type === 'toggle_inputs' || lastMsg.type === 'toggle_inputs_block')) {
        // Build a conservative routing reply: if toggle_inputs provided targets array use it,
        // if toggle_inputs_block provided a single block/target, apply that to a baseline and echo.
        setTimeout(()=>{
          try {
            let values = [0,1,2,3];
            if (lastMsg.type === 'toggle_inputs' && Array.isArray(lastMsg.targets)) {
              values = lastMsg.targets.slice(0,4).map(v => Number(v));
            } else if (lastMsg.type === 'toggle_inputs_block' && typeof lastMsg.block !== 'undefined') {
              const b = Number(lastMsg.block);
              const t = Number(lastMsg.target);
              values = [0,1,2,3];
              if (!Number.isNaN(b) && b >= 0 && b < 4) values[b] = t;
            }
            wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'routing', values: values })); });
          } catch (e) { console.warn('reply failed', e); }
        }, 300);
      }
    } catch (e) {}
  });
});
// expose a simple HTTP status endpoint returning the recent message history
const http = require('http');
http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({ ok:true, last: lastMsg, lastMessages: lastMessages }));
}).listen(9010);
process.on('SIGINT', ()=>{ wss.close(()=>process.exit(0)); });
