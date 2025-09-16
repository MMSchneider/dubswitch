const puppeteer = require('puppeteer');

(async () => {
  const url = 'http://localhost:3000';
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
    // grab console / errors
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
