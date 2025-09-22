/*
  scripts/port-switch-test.js
  ---------------------------
  Headless test: start server.js as a child process on an initial port,
  request a runtime port switch via POST /set-port, then confirm the
  server answers on the new port.

  Usage:
    node scripts/port-switch-test.js <initialPort> <targetPort>

  Example:
    node scripts/port-switch-test.js 4000 3000
*/
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

function waitForStatus(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/status', method: 'GET', timeout: 1000 }, res => {
        let buff = '';
        res.on('data', c => buff += c.toString());
        res.on('end', () => resolve({ ok: true, body: buff }));
      });
      req.on('error', () => {
        if (Date.now() > deadline) return resolve({ ok: false, err: 'timeout' });
        setTimeout(tryOnce, 200);
      });
      req.on('timeout', () => { req.destroy(); if (Date.now() > deadline) return resolve({ ok: false, err: 'timeout' }); setTimeout(tryOnce, 200); });
      req.end();
    };
    tryOnce();
  });
}

async function run(initialPort, targetPort) {
  console.log('Starting headless port-switch test', initialPort, '->', targetPort);
  const env = Object.assign({}, process.env, { PORT: String(initialPort) });
  const node = process.execPath;
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(node, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout.on('data', d => process.stdout.write('[server stdout] ' + d.toString()));
  child.stderr.on('data', d => process.stderr.write('[server stderr] ' + d.toString()));

  // wait for initial port status
  const ok1 = await waitForStatus(initialPort, 10000);
  if (!ok1.ok) {
    console.error('Server did not start on initial port', initialPort, ok1.err || ok1);
    child.kill();
    process.exit(2);
  }
  console.log('Server responding on', initialPort);

  // ask server to rebind
  const postBody = JSON.stringify({ port: Number(targetPort) });
  const opts = { hostname: '127.0.0.1', port: initialPort, path: '/set-port', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) } };
  await new Promise((resolve) => {
    const req = http.request(opts, res => {
      let buff = '';
      res.on('data', c=>buff+=c.toString());
      res.on('end', ()=>{
        try { const j = JSON.parse(buff); if (j && j.ok) console.log('Server accepted rebind to', j.port); else console.error('Server returned error', buff); } catch (e) { console.error('Bad JSON from /set-port', buff); }
        resolve();
      });
    });
    req.on('error', e => { console.error('POST /set-port failed', e && e.message); resolve(); });
    req.write(postBody); req.end();
  });

  // wait for server to respond on target port
  const ok2 = await waitForStatus(targetPort, 10000);
  if (!ok2.ok) {
    console.error('Server did not respond on target port', targetPort, ok2.err || ok2);
    child.kill();
    process.exit(3);
  }
  console.log('Server responding on', targetPort);

  // cleanup
  child.kill();
  console.log('Test passed');
  process.exit(0);
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length < 2) {
    console.error('Usage: node scripts/port-switch-test.js <initialPort> <targetPort>');
    process.exit(1);
  }
  run(Number(a[0]), Number(a[1]));
}
