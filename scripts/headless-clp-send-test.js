/*
  scripts/headless-clp-send-test.js
  ---------------------------------
  Headless test that fills the CLP form and submits it, asserting a CLP
  WebSocket message was emitted.
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
    await page.evaluateOnNewDocument(() => {
      window.__wsMessages = [];
      class FakeWS { constructor(url){ this.readyState = 1; setTimeout(()=>{ if(this.onopen) this.onopen(); },0);} send(data){ try{ window.__wsMessages.push(data); }catch(e){} } addEventListener(ev,fn){ this[ev]=fn } removeEventListener(ev,fn){ if(this[ev]===fn) delete this[ev]; } }
      window.OriginalWebSocket = window.WebSocket; window.WebSocket = FakeWS; try{ window.ws = new window.WebSocket('ws://fake'); }catch(e){}
    });

    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
    console.log('HTTP status:', resp.status());
    await page.waitForTimeout(600);

    // Open settings and CLP tab
    const settings = await page.$('#settingsBtn'); if (!settings) throw new Error('#settingsBtn not found');
    await page.evaluate(()=>document.getElementById('settingsBtn').click());
    await page.waitForTimeout(300);
    await page.evaluate(()=>{ const tab = document.getElementById('tab-clp-link'); if(tab) tab.click(); });
    await page.waitForTimeout(200);

    // Fill CLP form fields and submit
    await page.evaluate(()=>{ document.getElementById('clp-address').value = '/xinfo'; document.getElementById('clp-args').value = ''; document.querySelector('#clp form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await page.waitForTimeout(300);

    const wsMsgs = await page.evaluate(()=> (window.__wsMessages||[]).slice());
    const parsed = wsMsgs.map(s=>{ try{return JSON.parse(s);}catch(e){return s;} });
    console.log('captured ws messages:', JSON.stringify(parsed));
    const clpMsg = parsed.find(p=>p && p.type==='clp' && p.address === '/xinfo');

    logs.forEach(l=>console.log(`${l.type}: ${l.text}`));
    if (!clpMsg) { console.log('HEADLESS CLP SEND TEST: FAIL'); process.exitCode = 2; }
    else { console.log('HEADLESS CLP SEND TEST: PASS'); process.exitCode = 0; }
  } catch (e) {
    console.error('Test error:', e && e.message);
    process.exitCode = 3;
  } finally { await browser.close(); }
})();
