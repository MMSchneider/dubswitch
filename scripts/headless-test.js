/*
  scripts/headless-test.js
  -------------------------
  Automated smoke-test for the UI using Puppeteer. This script:
  - Loads the UI at the provided URL (default: http://localhost:3000)
  - Waits for the channel grid to render
  - Clicks a couple of sample channel buttons (#btn-01 and #btn-09)
  - Dumps console logs and page errors to help diagnose runtime issues

  Usage:
    node scripts/headless-test.js http://localhost:3000

  The script is intentionally lightweight and intended as a quick
  regression check when making UI changes during development.
*/
const puppeteer = require('puppeteer');

(async () => {
  const url = process.argv[2] || 'http://localhost:3000';
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', msg => logs.push({type: msg.type(), text: msg.text()}));
  page.on('pageerror', err => logs.push({type: 'pageerror', text: err.message}));
  page.on('requestfailed', req => logs.push({type: 'requestfailed', url: req.url(), err: req.failure() && req.failure().errorText}));

  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
    console.log('HTTP status:', resp.status());
    // wait for some UI hooks to initialize
    await page.waitForTimeout(1200);
    // Wait for channel button #btn-01 to appear (renderUserPatches)
    try {
      await page.waitForSelector('#btn-01', { timeout: 5000 });
      console.log('Found #btn-01 on page');
    } catch (err) {
      console.log('Warning: #btn-01 not found within timeout');
    }
    // Try clicking channel 01 and channel 09 to observe behavior
    const clicks = ['#btn-01', '#btn-09'];
    for (const sel of clicks) {
      try {
        const exists = await page.$(sel);
        if (!exists) { console.log(`Selector ${sel} not present, skipping click`); continue; }
        console.log(`Clicking ${sel}`);
        await page.click(sel);
        // wait a little for UI to update / WS messages to be processed
        await page.waitForTimeout(500);
        // read back computed style and userPatches
        const bg = await page.$eval(sel, el => getComputedStyle(el).backgroundColor);
  const up = await page.evaluate(() => (typeof userPatches !== 'undefined' ? JSON.stringify(userPatches) : null));
        console.log(`${sel} background: ${bg}`);
        console.log(`window.userPatches: ${up}`);
      } catch (e) {
        console.log(`Error clicking ${sel}:`, e && e.message);
      }
    }
    // dump all console logs for inspection
    console.log('--- Console log dump ---');
    logs.forEach(l => console.log(`${l.type}: ${l.text}`));
    // grab errors specifically for exit status
    const errors = logs.filter(l => l.type === 'error' || l.type === 'pageerror' || l.type === 'requestfailed');
    if (errors.length === 0) {
      console.log('HEADLESS TEST: PASS — no errors captured');
    } else {
      console.log('HEADLESS TEST: FAIL — errors captured:');
      console.log(JSON.stringify(errors, null, 2));
    }
  } catch (e) {
    console.error('Headless run failed:', e && e.message);
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
