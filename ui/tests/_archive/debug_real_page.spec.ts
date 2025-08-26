import { test, expect } from '@playwright/test';

test('debug real page rendering', async ({ page }) => {
  const consoleMessages: string[] = [];
  
  page.on('console', msg => {
    consoleMessages.push(`${msg.type()}: ${msg.text()}`);
  });
  
  page.on('pageerror', error => {
    consoleMessages.push(`PAGE ERROR: ${error.message}`);
  });
  
  await page.goto('http://localhost:8081/real-test.html');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(5000);
  
  // Check if React loaded
  const reactLoaded = await page.evaluate(() => typeof window.React !== 'undefined');
  const reactDOMLoaded = await page.evaluate(() => typeof window.ReactDOM !== 'undefined');
  
  // Check root element
  const rootContent = await page.locator('#root').innerHTML();
  
  console.log('React loaded:', reactLoaded);
  console.log('ReactDOM loaded:', reactDOMLoaded);
  console.log('Root content length:', rootContent.length);
  console.log('Root content preview:', rootContent.substring(0, 200));
  
  console.log('\n=== Console Messages ===');
  consoleMessages.forEach(msg => console.log(msg));
  
  // Check if API calls are being made
  const networkCalls: string[] = [];
  page.on('request', req => {
    if (req.url().includes('3002')) {
      networkCalls.push(req.url());
    }
  });
  
  await page.waitForTimeout(2000);
  console.log('\n=== API Calls to :3002 ===');
  networkCalls.forEach(call => console.log(call));
});
