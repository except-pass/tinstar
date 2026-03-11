import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  console.log('Navigating to http://localhost:5174 ...');
  await page.goto('http://localhost:5174', { waitUntil: 'networkidle' });

  console.log('Waiting for [data-testid="infinite-canvas"] ...');
  await page.waitForSelector('[data-testid="infinite-canvas"]', { timeout: 10000 });

  // Small extra wait to let any animations settle
  await page.waitForTimeout(500);

  console.log('Taking screenshot-before.png ...');
  await page.screenshot({ path: 'screenshot-before.png', fullPage: true });

  console.log('Clicking Arrange button ...');
  const arrangeBtn = await page.waitForSelector('[data-testid="arrange-button"]', { timeout: 5000 });
  await arrangeBtn.click();

  console.log('Waiting 500ms for arrange animation ...');
  await page.waitForTimeout(500);

  console.log('Taking screenshot-after.png ...');
  await page.screenshot({ path: 'screenshot-after.png', fullPage: true });

  await browser.close();
  console.log('Done!');
})();
