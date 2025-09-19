/*
  scripts/headless-settings-test.js
  -------------------------------
  Opens the UI, clicks the Settings button, waits for the modal to appear
  and asserts several elements inside the Settings modal are visible.

  Usage:
    node scripts/headless-settings-test.js http://localhost:3000
*/

const puppeteer = require('puppeteer');
(async () => {
  const url = process.argv[2] || 'http://localhost:3000';
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  // Inject a WebSocket stub before any page scripts run so we can capture
  // messages sent by the client. Collected messages are available at
  // window.__wsMessages for inspection.
  await page.evaluateOnNewDocument(() => {
    window.__wsMessages = [];
    class FakeWS {
      constructor(url) {
        this.url = url;
        this.readyState = 1; // OPEN
        this.listeners = {};
        setTimeout(()=>{ if (this.onopen) this.onopen(); }, 0);
      }
      send(data) {
        try { window.__wsMessages.push(data); } catch (e) {}
      }
      addEventListener(ev, fn){ this.listeners[ev] = fn; }
      removeEventListener(ev, fn){ if(this.listeners[ev]===fn) delete this.listeners[ev]; }
      close(){ this.readyState = 3; }
    }
  window.OriginalWebSocket = window.WebSocket;
  window.WebSocket = FakeWS;
  // Create a fake open websocket instance so client code that expects
  // window.ws to exist will send messages into our stub.
  try { window.ws = new window.WebSocket('ws://fake'); } catch (e) {}
    // Provide minimal dev shims so client logic that depends on these
    // structures will operate during headless tests.
    window.blocks = window.blocks || [
      { label: '1-8', userin: 20, localin: 0 },
      { label: '9-16', userin: 21, localin: 1 },
      { label: '17-24', userin: 22, localin: 2 },
      { label: '25-32', userin: 23, localin: 3 }
    ];
    window.routingState = window.routingState || [20,21,22,23];
    window.userPatches = window.userPatches || {};
    window.channelNames = window.channelNames || {};
    window.channelColors = window.channelColors || {};
    window.colorMap = window.colorMap || { null: 'transparent' };
  });
  const logs = [];
  page.on('console', msg => logs.push({type: msg.type(), text: msg.text()}));
  page.on('pageerror', err => logs.push({type: 'pageerror', text: err.message}));

  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
    console.log('HTTP status:', resp.status());

    // Wait a short while for client initialization
    await page.waitForTimeout(800);

    // Click settings button
    const settings = await page.$('#settingsBtn');
    if (!settings) { throw new Error('#settingsBtn not found'); }
    await settings.click();

    // Wait for modal to open
    await page.waitForSelector('#settingsModal.show, #settingsModal', { timeout: 3000 });
    // The modal uses Bootstrap; ensure the matrix container is present
    const matrix = await page.$('#matrix-table-container');
    const clpAddr = await page.$('#clp-address');
    console.log('matrix present:', !!matrix);
    console.log('clp-address present:', !!clpAddr);

    // Switch to Routing tab and click 'Switch all Inputs' to trigger WS message
    const routingTab = await page.$('#tab-routing-link');
    if (routingTab) await page.evaluate(() => { const el = document.getElementById('tab-routing-link'); if (el) el.click(); });
    // Wait for tab to be active
    await page.waitForTimeout(200);
    const hasToggle = await page.$('#toggle-inputs') !== null;
    if (hasToggle) {
      // Use DOM click dispatch to avoid Puppeteer 'not clickable' errors
      await page.evaluate(() => { const el = document.getElementById('toggle-inputs'); if (el) el.click(); });
      // allow any in-page WS send to execute
      await page.waitForTimeout(200);
    }

    // Retrieve captured WS messages
    const wsMsgs = await page.evaluate(() => (window.__wsMessages || []).slice());
    const parsed = wsMsgs.map(s => { try { return JSON.parse(s); } catch (e) { return s; } });
    const sentToggle = parsed.find(p => p && p.type === 'toggle_inputs');
    console.log('captured ws messages:', JSON.stringify(parsed));
    console.log('captured toggle_inputs:', !!sentToggle);

    // Quick visibility checks. In headless mode the modal may not have
    // measurable layout; prefer checking that the modal has class 'show'
    // and that the important elements exist in the DOM.
    const modalHasShow = await page.evaluate(() => {
      const m = document.getElementById('settingsModal');
      return !!(m && m.classList && m.classList.contains('show'));
    });
    const matrixVisible = !!matrix;
    const clpVisible = !!clpAddr;
    console.log('modal.show:', modalHasShow);
    console.log('matrix present:', matrixVisible);
    console.log('clp present:', clpVisible);

    // Dump console logs
    console.log('--- Console dump ---');
    logs.forEach(l => console.log(`${l.type}: ${l.text}`));

    // Determine pass/fail (fail if any pageerror present or critical elements not visible)
    const errors = logs.filter(l => l.type === 'error' || l.type === 'pageerror');
    if (errors.length === 0 && matrixVisible && clpVisible && sentToggle) {
      console.log('HEADLESS SETTINGS TEST: PASS');
      process.exitCode = 0;
    } else {
      console.log('HEADLESS SETTINGS TEST: FAIL');
      if (errors.length) console.log('Errors:', JSON.stringify(errors, null, 2));
      if (!sentToggle) console.log('Reason: toggle_inputs message not captured');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('Test error:', e && e.message);
    process.exitCode = 3;
  } finally {
    await browser.close();
  }
})();
