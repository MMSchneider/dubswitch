/*
  scripts/headless-colors-picker-test.js
  -------------------------------------
  Opens the UI, sets channel 1 to Local, changes the Local color via the
  color input in Settings → Colors, and verifies the button background
  updates without a full re-render.

  Usage:
    node scripts/headless-colors-picker-test.js http://localhost:3000
*/
const puppeteer = require('puppeteer');

(async () => {
  const url = process.argv[2] || 'http://localhost:3000';
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', msg => logs.push({type: msg.type(), text: msg.text()}));
  page.on('pageerror', err => logs.push({type: 'pageerror', text: err.message}));

  try {
    // Inject fake WS and minimal shims
    await page.evaluateOnNewDocument(() => {
      window.__wsMessages = [];
      class FakeWS { constructor(url){ this.url=url; this.readyState=1; setTimeout(()=>{ if(this.onopen) this.onopen(); },0);} send(d){ try{ window.__wsMessages.push(d); }catch(e){} } addEventListener(ev,fn){ this[ev]=fn } removeEventListener(ev,fn){ if(this[ev]===fn) delete this[ev]; } close(){ this.readyState=3; } }
      window.OriginalWebSocket = window.WebSocket; window.WebSocket = FakeWS; try{ window.ws = new window.WebSocket('ws://fake'); }catch(e){}
      window.blocks = window.blocks || [ { label:'1-8', userin:20, localin:0 }, { label:'9-16', userin:21, localin:1 }, { label:'17-24', userin:22, localin:2 }, { label:'25-32', userin:23, localin:3 } ];
      window.routingState = window.routingState || [20,21,22,23];
      window.userPatches = window.userPatches || {};
      window.channelNames = window.channelNames || {};
      window.channelColors = window.channelColors || {};
      window.colorMap = window.colorMap || { null: 'transparent' };
    });

    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
    console.log('HTTP status:', resp.status());

    // Ensure the grid is there and set ch1 to Local
    await page.waitForSelector('#btn-01', { timeout: 5000 });
    await page.evaluate(() => { window.userPatches[1] = 1; if (typeof renderUserPatches === 'function') renderUserPatches(); });
    const before = await page.$eval('#btn-01', el => getComputedStyle(el).backgroundColor);

    // Open Settings and go to Colors tab
    await page.evaluate(() => { const s = document.getElementById('settingsBtn'); if (s) s.click(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { const tab = document.getElementById('tab-colors-link'); if (tab) tab.click(); });
    await page.waitForSelector('#color-local', { timeout: 2000 });

    // Change Local color to magenta and trigger input/change
    await page.evaluate(() => { const el = document.getElementById('color-local'); if (el){ el.value = '#ff00ff'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } });

    // Wait a moment for in-place recolor helper
    await page.waitForTimeout(120);
    const after = await page.$eval('#btn-01', el => getComputedStyle(el).backgroundColor);

    console.log('before:', before, 'after:', after);
    logs.forEach(l => console.log(`${l.type}: ${l.text}`));

    if (/rgb\(255,\s*0,\s*255\)/.test(after)) {
      console.log('HEADLESS COLORS PICKER TEST: PASS');
      process.exitCode = 0;
    } else {
      console.log('HEADLESS COLORS PICKER TEST: FAIL');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('Test error:', e && e.message);
    process.exitCode = 3;
  } finally {
    await browser.close();
  }
})();
