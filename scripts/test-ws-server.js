#!/usr/bin/env node
// Simple WebSocket test server to validate client messages during headless tests
const WebSocket = require('ws');
const port = process.env.TEST_WS_PORT || 9009;
const wss = new WebSocket.Server({ port }, ()=>console.log('Test WS server listening on', port));
let lastMsg = null;
wss.on('connection', ws => {
  console.log('Test WS client connected');
  ws.on('message', m => {
    try { lastMsg = JSON.parse(m); } catch (e) { lastMsg = m; }
    console.log('Test WS received:', JSON.stringify(lastMsg));
    // Echo simple routing reply when toggle_inputs arrives so client can re-enable UI
    try {
      if (lastMsg && lastMsg.type === 'toggle_inputs') {
        setTimeout(()=>{
          wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'routing', values: [0,1,2,3] })); });
        }, 300);
      }
    } catch (e) {}
  });
});
// expose a simple HTTP status endpoint if needed
const http = require('http');
http.createServer((req,res)=>{ res.end(JSON.stringify({ ok:true, last:lastMsg })); }).listen(9010);
process.on('SIGINT', ()=>{ wss.close(()=>process.exit(0)); });
