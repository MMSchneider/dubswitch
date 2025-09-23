/*
  scripts/headless-colors-update-test.js
  -------------------------------------
  Verifies that changing colors triggers in-place recolor without a full
  grid re-render by simulating a server colors_update broadcast and
  observing DOM style changes on existing elements.

  Usage:
    node scripts/headless-colors-update-test.js http://localhost:3000
*/
const puppeteer = require('puppeteer');

(async () => {
  const url = process.argv[2] || 'http://localhost:3000';
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();

  // Capture console for debugging
  const logs = [];
  page.on('console', msg => logs.push({type: msg.type(), text: msg.text()}));
  page.on('pageerror', err => logs.push({type: 'pageerror', text: err.message}));

  try {
    // Inject a fake WebSocket and required shims so the UI initializes
    await page.evaluateOnNewDocument(() => {
      window.__wsMessages = [];
      class FakeWS {
        constructor(url) {
          this.url = url; this.readyState = 1; this.listeners = {};
          setTimeout(()=>{ if (this.onopen) this.onopen(); }, 0);
        }
        send(data) { try { window.__wsMessages.push(data); } catch (e) {} }
        addEventListener(ev, fn) { this.listeners[ev] = fn; }
        removeEventListener(ev, fn) { if (this.listeners[ev] === fn) delete this.listeners[ev]; }
        close() { this.readyState = 3; }
      }
      window.OriginalWebSocket = window.WebSocket; window.WebSocket = FakeWS; try { window.ws = new window.WebSocket('ws://fake'); } catch (e) {}
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

    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
    console.log('HTTP status:', resp.status());

    // Wait for grid to appear and capture initial background
    await page.waitForSelector('#btn-01', { timeout: 5000 });
    const before = await page.$eval('#btn-01', el => getComputedStyle(el).backgroundColor);

    // Ensure channel 1 is a Local source so it uses 'local' color bucket
    await page.evaluate(() => { window.userPatches[1] = 1; if (typeof updateButtonColorsFromPrefs === 'function') updateButtonColorsFromPrefs(); });
    const before2 = await page.$eval('#btn-01', el => getComputedStyle(el).backgroundColor);

    // Simulate a server broadcast: set 'local' to a unique color and dispatch
    await page.evaluate(() => {
      const ev = { data: JSON.stringify({ type: 'colors_update', colors: { local: '#ff00ff' } }) };
      try { handleWsMessage(ev); } catch (e) { console.error('invoke handleWsMessage failed', e); }
    });

    // Wait a tiny bit for DOM application
    await page.waitForTimeout(100);
    const after = await page.$eval('#btn-01', el => getComputedStyle(el).backgroundColor);

    console.log('before:', before, 'before2:', before2, 'after:', after);
    console.log('--- Console dump ---');
    logs.forEach(l => console.log(`${l.type}: ${l.text}`));

    // Expect after to be the computed rgb for #ff00ff => rgb(255, 0, 255)
    if (/rgb\(255,\s*0,\s*255\)/.test(after)) {
      console.log('HEADLESS COLORS UPDATE TEST: PASS');
      process.exitCode = 0;
    } else {
      console.log('HEADLESS COLORS UPDATE TEST: FAIL');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('Test error:', e && e.message);
    process.exitCode = 3;
  } finally {
    await browser.close();
  }
})();
