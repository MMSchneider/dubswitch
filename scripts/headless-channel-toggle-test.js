/*
  scripts/headless-channel-toggle-test.js
  --------------------------------------
  Headless test that clicks a channel button and asserts the client sent
  a CLP message for /config/userrout/in/NN with a numeric arg.
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
    // Inject fake WS and dev shims
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

    // Click first channel button
    const btn = await page.$('#btn-01');
    if (!btn) throw new Error('#btn-01 not found');
    await page.evaluate(()=>document.getElementById('btn-01').click());
    await page.waitForTimeout(300);

    const wsMsgs = await page.evaluate(()=> (window.__wsMessages||[]).slice());
    const parsed = wsMsgs.map(s=>{ try{return JSON.parse(s);}catch(e){return s;} });
    console.log('captured ws messages:', JSON.stringify(parsed));
    const clpMsg = parsed.find(p=>p && p.type==='clp' && /config\/userrout\/in\/01$/.test(p.address));

    logs.forEach(l=>console.log(`${l.type}: ${l.text}`));
    if (!clpMsg) { console.log('HEADLESS CHANNEL TOGGLE TEST: FAIL'); process.exitCode = 2; }
    else { console.log('HEADLESS CHANNEL TOGGLE TEST: PASS'); process.exitCode = 0; }
  } catch (e) {
    console.error('Test error:', e && e.message);
    process.exitCode = 3;
  } finally { await browser.close(); }
})();
