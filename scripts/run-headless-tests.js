#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

function spawnNode(script, args=[]) {
  const p = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
  return p;
}

console.log('Starting test WS server...');
const server = spawnNode(path.join(__dirname,'test-ws-server.js'));

server.on('spawn', async ()=>{
  console.log('Test WS server started. Running headless tests...');
  // Run the headless tests in sequence
  const tests = [
    'headless-channel-toggle-test.js',
    'headless-rename-test.js',
    'headless-clp-send-test.js',
    'headless-settings-test.js'
  ];
  (async function runAll(){
    for (const t of tests) {
      console.log('Running', t);
      const p = spawnNode(path.join(__dirname, t), ['http://localhost:3000']);
      const code = await new Promise(res => p.on('exit', res));
      console.log(`${t} exit ${code}`);
      if (code !== 0) {
        console.log('Test failed, aborting test run.');
        try { process.kill(server.pid); } catch (e) {}
        process.exit(code || 1);
      }
    }
    console.log('All tests passed.');
    try { process.kill(server.pid); } catch (e) {}
    process.exit(0);
  })();
});

server.on('exit', (code)=>{ console.log('WS server exited', code); });
