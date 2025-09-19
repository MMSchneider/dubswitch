/*
  scripts/push-matrix.js
  -----------------------
  Small helper used during development to push the on-disk `matrix.json`
  to a running server instance without restarting the server. This
  connects to the WebSocket server and sends a `set_matrix` message.

  Usage:
    node scripts/push-matrix.js ws://localhost:3000
  If no argument is provided, the default is ws://localhost:3000

  Note: This script expects `matrix.json` to be located at the project
  root (one level up from the scripts directory).
*/
const fs = require('fs');
const WebSocket = require('ws');
const path = require('path');
const MATRIX_FILE = path.join(__dirname, '..', 'matrix.json');
const SERVER = process.argv[2] || 'ws://localhost:3000';

if (!fs.existsSync(MATRIX_FILE)) { console.error('matrix.json not found'); process.exit(1); }
const matrix = JSON.parse(fs.readFileSync(MATRIX_FILE, 'utf8'));
const ws = new WebSocket(SERVER);
ws.on('open', () => {
  console.log('ws open to', SERVER);
  ws.send(JSON.stringify({ type: 'set_matrix', matrix }));
  console.log('set_matrix sent');
  setTimeout(()=>ws.close(), 300);
});
ws.on('error', (e)=>{ console.error('ws error', e); process.exit(1); });
