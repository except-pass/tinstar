import { test, expect } from '@playwright/test';

test('debug page elements', async ({ page }) => {
  // Go to the page
  await page.goto('http://localhost:8081/real-test.html');
  
  // Wait for page to load
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000); // Give extra time for React to render
  
  // Take a screenshot
  await page.screenshot({ path: 'debug-page.png', fullPage: true });
  
  // Log all elements with their classes
  const allElements = await page.locator('*').all();
  console.log('Total elements found:', allElements.length);
  
  // Check if root element exists
  const root = page.locator('#root');
  console.log('Root element exists:', await root.count() > 0);
  
  // Check for any divs with classes
  const divsWithClasses = await page.locator('div[class]').all();
  console.log('Divs with classes found:', divsWithClasses.length);
  
  for (let i = 0; i < Math.min(divsWithClasses.length, 10); i++) {
    const className = await divsWithClasses[i].getAttribute('class');
    console.log(`Div ${i}: class="${className}"`);
  }
  
  // Check for specific classes we're looking for
  const projectPane = page.locator('.project-pane');
  console.log('Project pane elements:', await projectPane.count());
  
  const appContainer = page.locator('.app-container');
  console.log('App container elements:', await appContainer.count());
  
  const fileTreeContainer = page.locator('.file-tree-container');
  console.log('File tree container elements:', await fileTreeContainer.count());
  
  // Check console logs for errors
  page.on('console', msg => {
    console.log('Browser console:', msg.type(), msg.text());
  });
  
  // Check network responses
  page.on('response', response => {
    console.log('Network response:', response.status(), response.url());
  });
  
  // Wait a bit more to catch any async loading
  await page.waitForTimeout(5000);
  
  // Check if anything loaded
  const bodyText = await page.locator('body').textContent();
  console.log('Body contains text:', bodyText?.includes('Tinstar') || false);
  console.log('Body text length:', bodyText?.length || 0);
});
