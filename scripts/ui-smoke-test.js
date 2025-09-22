const puppeteer = require('puppeteer');
const assert = require('assert');

async function run(){
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  try {
    await page.goto('http://localhost:3000/', { waitUntil: 'networkidle2' });
    // open settings (use DOM click to avoid overlay/clickability issues)
    await page.waitForSelector('#settingsBtn', { visible: true });
    await page.evaluate(() => document.querySelector('#settingsBtn').click());
    await page.waitForSelector('#settingsModal', { visible: true });
    // switch to Matrix tab
    await page.click('#tab-matrix-link');
    await page.waitForSelector('#matrix-table-container');
    // choose bulk select value and click apply
  await page.waitForSelector('#matrix-b-bulk-select');
  await page.select('#matrix-b-bulk-select', 'daw');
  // click apply via DOM to avoid Puppeteer click interception
  await page.evaluate(() => document.querySelector('#matrix-b-bulk-apply').click());
    // modal should show
    await page.waitForSelector('#bulkApplyConfirmModal.show', { visible: true });
    // click confirm
    await page.click('#bulkApplyConfirmOk');
    // toast with Undo should appear; wait and click Undo button inside the toast
  await page.waitForSelector('#toast-container .dubswitch-toast', { visible: true });
    // find undo button and click it
    const undoBtn = await page.$x("//div[@id='toast-container']//button[contains(., 'Undo')]");
    if (undoBtn && undoBtn.length) {
      await undoBtn[0].click();
    } else {
      throw new Error('Undo button not found in toast');
    }
    console.log('UI smoke test passed');
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('UI smoke test failed:', err);
    await browser.close();
    process.exit(2);
  }
}

run();
