const puppeteer = require('puppeteer');
(async () => {
  const url = process.argv[2] || 'http://localhost:3000/index2.html';
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
    console.log('HTTP status:', resp.status());
    const ids = [
      'manualIpBtn','connect-warning','x32IpInput','autodiscoverBtn','saveIpBtn','settingsBtn','status','userpatch-container','routing-table','toggle-inputs','clp-log','switch-to-userins','routing-chevron','clp-chevron','app-version','header-version'
    ];
    const res = await page.evaluate((ids)=>{
      const out = {};
      ids.forEach(id=>{ out[id] = !!document.getElementById(id); });
      return out;
    }, ids);
    console.log('Element presence:');
    console.table(res);
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await browser.close();
  }
})();
