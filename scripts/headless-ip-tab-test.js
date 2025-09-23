/*
  scripts/headless-ip-tab-test.js
  --------------------------------
  Verifies Settings → IP tab buttons are wired:
  - Open Settings, click Autodetect → expect a fetch to /autodiscover-x32 and a ws send set_x32_ip when JSON has ip
  - Enter IP and click Save → expect ws send set_x32_ip
  - Enumerate Sources → expect fetch to /enumerate-sources and results rendered

  Usage:
    node scripts/headless-ip-tab-test.js http://localhost:3000
*/
const puppeteer = require('puppeteer');

(async () => {
  const url = process.argv[2] || 'http://localhost:3000';
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', msg => logs.push({type: msg.type(), text: msg.text()}));
  page.on('pageerror', err => logs.push({type: 'pageerror', text: err.message}));

  // Intercept network to stub autodiscover and enumerate endpoints
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (/\/autodiscover-x32$/.test(u)) {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ip: '192.168.1.99' }) });
    }
    if (/\/enumerate-sources$/.test(u)) {
      const sample = { userPatches: { '1': { value: 1, label: 'Local 1' } } };
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(sample) });
    }
    // let others pass
    return req.continue();
  });

  try {
    // Inject stub WS and minimal globals
    await page.evaluateOnNewDocument(() => {
      window.__wsMessages = [];
      class FakeWS { constructor(url){ this.url=url; this.readyState=1; setTimeout(()=>{ if(this.onopen) this.onopen(); },0);} send(d){ try{ window.__wsMessages.push(d); }catch(e){} } addEventListener(ev,fn){ this[ev]=fn } removeEventListener(ev,fn){ if(this[ev]===fn) delete this[ev]; } close(){ this.readyState=3; } }
      window.OriginalWebSocket = window.WebSocket; window.WebSocket = FakeWS; try{ window.ws = new window.WebSocket('ws://fake'); }catch(e){}
      window.blocks = window.blocks || [ { label:'1-8', userin:20, localin:0 }, { label:'9-16', userin:21, localin:1 }, { label:'17-24', userin:22, localin:2 }, { label:'25-32', userin:23, localin:3 } ];
      window.routingState = window.routingState || [20,21,22,23];
      window.userPatches = window.userPatches || {};
    });

    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
    console.log('HTTP status:', resp.status());

    // Open Settings (IP tab is default active)
    await page.evaluate(() => { const s = document.getElementById('settingsBtn'); if (s) s.click(); });
    await page.waitForTimeout(200);

    // Click Autodetect
    const auto = await page.$('#autodiscoverBtn');
    if (!auto) throw new Error('#autodiscoverBtn not found');
    await page.evaluate(()=>document.getElementById('autodiscoverBtn').click());
    await page.waitForTimeout(150);

    // Save IP
    await page.evaluate(()=>{ const el = document.getElementById('x32IpInput'); if (el) el.value = '192.168.1.77'; });
    const save = await page.$('#saveIpBtn');
    if (!save) throw new Error('#saveIpBtn not found');
    await page.evaluate(()=>document.getElementById('saveIpBtn').click());
    await page.waitForTimeout(120);

    // Enumerate Sources
    const enumBtn = await page.$('#enumerateBtn');
    if (!enumBtn) throw new Error('#enumerateBtn not found');
    await page.evaluate(()=>document.getElementById('enumerateBtn').click());
    await page.waitForSelector('#enumerate-results-container', { timeout: 2000 });

    // Inspect WS messages
    const wsMsgs = await page.evaluate(()=> (window.__wsMessages||[]).map(s=>{ try{return JSON.parse(s);}catch(e){return s;} }));
    const autoMsg = wsMsgs.find(m => m && m.type === 'set_x32_ip' && m.ip === '192.168.1.99');
    const saveMsg = wsMsgs.find(m => m && m.type === 'set_x32_ip' && m.ip === '192.168.1.77');

    // Logs
    logs.forEach(l => console.log(`${l.type}: ${l.text}`));

    if (autoMsg && saveMsg) {
      console.log('HEADLESS IP TAB TEST: PASS');
      process.exitCode = 0;
    } else {
      console.log('HEADLESS IP TAB TEST: FAIL');
      if (!autoMsg) console.log('Missing autodiscover set_x32_ip');
      if (!saveMsg) console.log('Missing save set_x32_ip');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('Test error:', e && e.message);
    process.exitCode = 3;
  } finally {
    await browser.close();
  }
})();
