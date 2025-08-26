import { test, expect } from '@playwright/test';

test('detailed debug of page loading', async ({ page }) => {
  // Listen for console messages and errors
  const consoleMessages: string[] = [];
  page.on('console', msg => {
    consoleMessages.push(`${msg.type()}: ${msg.text()}`);
  });
  
  const networkResponses: string[] = [];
  page.on('response', response => {
    networkResponses.push(`${response.status()}: ${response.url()}`);
  });
  
  // Go to the page
  await page.goto('http://localhost:8081/real-test.html');
  
  // Wait for page to load
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(5000); // Give extra time
  
  // Check if React and other libraries loaded
  const reactLoaded = await page.evaluate(() => typeof window.React !== 'undefined');
  const reactDOMLoaded = await page.evaluate(() => typeof window.ReactDOM !== 'undefined');
  const reactArboristLoaded = await page.evaluate(() => typeof window.ReactArborist !== 'undefined');
  
  console.log('React loaded:', reactLoaded);
  console.log('ReactDOM loaded:', reactDOMLoaded);
  console.log('ReactArborist loaded:', reactArboristLoaded);
  
  // Check if our components are defined
  const testAppLoaded = await page.evaluate(() => typeof window.TestApp !== 'undefined');
  console.log('TestApp loaded:', testAppLoaded);
  
  // Check root element content
  const rootContent = await page.locator('#root').innerHTML();
  console.log('Root innerHTML length:', rootContent.length);
  console.log('Root innerHTML preview:', rootContent.substring(0, 500));
  
  // Log console messages
  console.log('\n=== Console Messages ===');
  consoleMessages.forEach(msg => console.log(msg));
  
  // Log network responses  
  console.log('\n=== Network Responses ===');
  networkResponses.forEach(resp => console.log(resp));
  
  // Check for specific error patterns
  const hasJSError = consoleMessages.some(msg => msg.includes('error') || msg.includes('Error'));
  const hasBundleError = consoleMessages.some(msg => msg.includes('babel') || msg.includes('transform'));
  
  console.log('Has JS errors:', hasJSError);
  console.log('Has bundle/transform errors:', hasBundleError);
  
  // Check if API is reachable from the browser
  const apiReachable = await page.evaluate(async () => {
    try {
      const response = await fetch('http://localhost:3002/api/projects');
      return { ok: response.ok, status: response.status };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  
  console.log('API reachable from browser:', apiReachable);
});
