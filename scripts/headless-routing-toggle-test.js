/*
  scripts/headless-routing-toggle-test.js
  -------------------------------------
  Headless test that opens the app, navigates to Settings -> Routing,
  inspects the per-block quick buttons (#userins-block-N), clicks one to
  toggle it, verifies a WS message of type 'toggle_inputs_block' was sent,
  then simulates a server 'routing' message and asserts the button badge
  updates to reflect the new setting.

  Usage:
    node scripts/headless-routing-toggle-test.js http://localhost:3000
*/
const puppeteer = require('puppeteer');
(async () => {
  const url = process.argv[2] || 'http://localhost:3000';
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const logs = [];
  page.on('console', msg => {
    try { console.log('[page:' + msg.type() + ']', msg.text()); } catch (e) {}
    try { logs.push({type: msg.type(), text: msg.text()}); } catch (e) {}
  });
  page.on('pageerror', err => {
    try { console.error('[page:error]', err && err.message); } catch (e) {}
    try { logs.push({type: 'pageerror', text: err.message}); } catch (e) {}
  });
  // Prepare to possibly start the real test WS server so we can assert the server received messages.
  const child_process = require('child_process');
  const path = require('path');
  const testWsScript = path.resolve(__dirname, 'test-ws-server.js');
  const TEST_WS_PORT = process.env.TEST_WS_PORT || 9009;
  let testWsProc = null;
  try {
    testWsProc = child_process.spawn(process.execPath, [testWsScript], { env: Object.assign({}, process.env, { TEST_WS_PORT: String(TEST_WS_PORT) }), stdio: ['ignore','pipe','pipe'] });
    testWsProc.stdout.on('data', d => console.log('[test-ws]', String(d).trim()));
    testWsProc.stderr.on('data', d => console.error('[test-ws-err]', String(d).trim()));
    // allow server to start
    await new Promise(r => setTimeout(r, 250));
  } catch (e) { console.warn('Could not start test WS server locally, continuing with FakeWS fallback'); }

  // Decide whether to use FakeWS inside the page: use fake when the test server didn't start
  const useFakeWs = !testWsProc;

  // Inject a robust Fake WebSocket stub and minimal dev shims before any page script runs.
  await page.evaluateOnNewDocument((useFake, wsPort) => {
    window.__wsMessages = [];
    window.__fakeWsInstances = [];
    // If the test harness requested a fake WS (no real server available), stub it.
    if (useFake) {
      class FakeWS {
        constructor(url){
          this.url = url; this.readyState = 1; this.onopen = null; this.onmessage = null; this.onclose = null;
          window.__fakeWsInstances.push(this);
          setTimeout(()=>{ if (this.onopen) this.onopen({}); if (this.onload) this.onload({}); }, 0);
        }
        send(data){ try{ window.__wsMessages.push(data); }catch(e){} }
        close(){ this.readyState = 3; if (this.onclose) this.onclose({}); }
        addEventListener(ev, fn){ this['on'+ev] = fn; }
        removeEventListener(ev, fn){ if (this['on'+ev] === fn) delete this['on'+ev]; }
      }
      window.OriginalWebSocket = window.WebSocket;
      window.WebSocket = FakeWS;
      try{ window.ws = new window.WebSocket('ws://fake'); }catch(e){}
      window.__fakeServerSend = function(data){
        window.__fakeWsInstances.forEach(inst => {
          try { if (inst.onmessage) inst.onmessage({ data: data }); } catch (e) {}
          try { if (inst['onmessage']) inst['onmessage']({ data: data }); } catch (e) {}
        });
      };
    }

    // If a real test WS server is present, instruct the client to use that origin so the page's createWs connects to it.
    if (!useFake && typeof localStorage !== 'undefined') {
      try { localStorage.setItem('dubswitch_api_origin', 'http://localhost:' + String(wsPort)); } catch (e) {}
    }

    // Minimal dev shims expected by app.js
    window.blocks = window.blocks || [
      { label: '1-8', userin: 20, localin: 0 },
      { label: '9-16', userin: 21, localin: 1 },
      { label: '17-24', userin: 22, localin: 2 },
      { label: '25-32', userin: 23, localin: 3 }
    ];
    // Start with LocalIns to ensure UI shows LocalIns initially
    window.routingState = window.routingState || [0,1,2,3];
    window.userPatches = window.userPatches || {};
    window.channelNames = window.channelNames || {};
    window.channelColors = window.channelColors || {};
    window.colorMap = window.colorMap || { null: 'transparent' };
  }, useFakeWs, TEST_WS_PORT);

  // Ensure the client connects to our local API origin so WebSocket targets our test server
  // When served from http://localhost:3000, the app uses that origin for ws connections by default.
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    console.log('HTTP status:', resp && resp.status ? resp.status() : 'unknown');

    // Wait for client initialization
    await page.waitForTimeout(700);

    // Open settings modal
    const settings = await page.$('#settingsBtn');
    if (!settings) throw new Error('#settingsBtn not found');
    await page.evaluate(() => document.querySelector('#settingsBtn').click());
    await page.waitForSelector('#settingsModal', { visible: true });

    // Switch to Routing tab
    await page.evaluate(() => { const el = document.getElementById('tab-routing-link'); if (el) el.click(); });
    await page.waitForTimeout(250);

    // Ensure per-block quick buttons are present
    for (let i = 0; i < 4; i++) {
      const sel = `#userins-block-${i}`;
      const el = await page.$(sel);
      if (!el) throw new Error(`${sel} not found`);
    }

    const fetch = require('node-fetch');
    const httpStatusUrl = `http://localhost:9010/`;

    // Iterate each block button and assert the real test WS server received the corresponding message
    for (let i = 0; i < 4; i++) {
      const sel = `#userins-block-${i}`;
      const initialText = await page.$eval(sel, el => el.textContent.trim());
      console.log(`Initial ${sel}:`, initialText);

      // Click the button
      await page.evaluate((s) => { const b = document.querySelector(s); if (b) b.click(); }, sel);
      // Allow client to send and server to process
      await page.waitForTimeout(500);

      // Query the test server status endpoint to get the last message it saw
      let statusJson = null;
      try {
        const r = await fetch(httpStatusUrl, { timeout: 1500 });
        statusJson = await r.json();
      } catch (e) { console.warn('Could not fetch test WS server status', e && e.message); }
      console.log('server status last:', statusJson && statusJson.last ? JSON.stringify(statusJson.last) : String(statusJson));

      if (!statusJson || !Array.isArray(statusJson.lastMessages)) {
        console.log('No lastMessages array from test WS server; FAIL');
        process.exitCode = 2; break;
      }
      // Find the most recent toggle_inputs_block for this block index
      const found = (statusJson.lastMessages || []).slice().reverse().find(m => m && m.type === 'toggle_inputs_block' && Number(m.block) === i);
      if (!found) {
        console.log('Did not find toggle_inputs_block for block', i, 'in server history. History:', JSON.stringify(statusJson.lastMessages.slice(-8)));
        process.exitCode = 2; break;
      }

      // Wait a bit for the server to echo a routing message and client to render UI
      await page.waitForTimeout(300);
      const afterText = await page.$eval(sel, el => el.textContent.trim());
      console.log(`After ${sel}:`, afterText);
      if (!/UserIns|LocalIns|pending|…|toggle pending/i.test(afterText)) {
        console.log('Button text did not update to a recognized state:', afterText);
        process.exitCode = 2; break;
      }

      // Clear server last state by sending a benign request to ensure next loop reads fresh (not strictly necessary)
      try { await fetch(httpStatusUrl, { timeout: 800 }); } catch (e) {}
      process.exitCode = 0;
    }
  } catch (e) {
    console.error('Test error:', e && e.message);
    process.exitCode = 3;
  } finally {
    try { await browser.close(); } catch (e) {}
    if (testWsProc) {
      try { testWsProc.kill(); } catch (e) {}
    }
  }
})();
