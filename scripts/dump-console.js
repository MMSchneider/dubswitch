const puppeteer = require('puppeteer');
(async () => {
  const url = process.argv[2] || 'http://localhost:3000/index2.html';
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.on('console', msg => console.log('CONSOLE', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('PAGEERROR', err.message));
  page.on('requestfailed', req => console.log('REQFAILED', req.url(), req.failure() && req.failure().errorText));
  page.on('response', resp => {
    if (resp.status() >= 400) console.log('BADRESP', resp.status(), resp.url());
  });
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
    console.log('HTTP status:', resp.status());
    await page.waitForTimeout(800);
  } catch (e) {
    console.error('Error:', e && e.message);
  } finally {
    await browser.close();
  }
})();
