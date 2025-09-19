/*
  scripts/headless-rename-test.js
  -------------------------------
  Headless test that simulates renaming a channel; asserts a CLP message
  for channel name set is emitted.
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
      window.blocks = window.blocks || [ { label:'1-8', userin:20, localin:0 },{ label:'9-16', userin:21, localin:1 },{ label:'17-24', userin:22, localin:2 },{ label:'25-32', userin:23, localin:3 } ];
      window.routingState = window.routingState || [20,21,22,23]; window.userPatches = window.userPatches || {}; window.channelNames = window.channelNames || {}; window.channelColors = window.channelColors || {}; window.colorMap = window.colorMap || { null: 'transparent' };
    });

    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
    console.log('HTTP status:', resp.status());
    await page.waitForTimeout(600);

    // Click rename icon and simulate prompt response by overriding window.prompt
    await page.evaluate(()=>{
      window._promptBackup = window.prompt;
      window.prompt = (msg, def) => 'New Name';
      const icon = document.getElementById('rename-icon-01'); if(icon) icon.click();
    });
    await page.waitForTimeout(600);

    const wsMsgs = await page.evaluate(()=> (window.__wsMessages||[]).slice());
    const parsed = wsMsgs.map(s=>{ try{return JSON.parse(s);}catch(e){return s;} });
    console.log('captured ws messages:', JSON.stringify(parsed));
    const clpMsg = parsed.find(p=>p && p.type==='clp' && /config\/name$/.test(p.address));

    logs.forEach(l=>console.log(`${l.type}: ${l.text}`));
    if (!clpMsg) { console.log('HEADLESS RENAME TEST: FAIL'); process.exitCode = 2; }
    else { console.log('HEADLESS RENAME TEST: PASS'); process.exitCode = 0; }
  } catch (e) {
    console.error('Test error:', e && e.message);
    process.exitCode = 3;
  } finally { await browser.close(); }
})();
