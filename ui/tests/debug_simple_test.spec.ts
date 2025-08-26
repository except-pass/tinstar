import { test, expect } from '@playwright/test';

test('debug simple test page', async ({ page }) => {
  await page.goto('http://localhost:8081/simple-test.html');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);
  
  // Check all buttons
  const allButtons = await page.locator('button').all();
  console.log('All buttons found:', allButtons.length);
  
  for (let i = 0; i < allButtons.length; i++) {
    const button = allButtons[i];
    const id = await button.getAttribute('id') || 'no-id';
    const text = await button.textContent();
    console.log(`Button ${i}: id="${id}", text="${text}"`);
  }
  
  // Check if our function executed
  const containerExists = await page.locator('.test-container').count();
  console.log('Test container exists:', containerExists > 0);
  
  // Check console messages
  const messages: string[] = [];
  page.on('console', msg => messages.push(msg.text()));
  
  // Wait a bit more and check console
  await page.waitForTimeout(2000);
  console.log('Console messages:', messages);
  
  // Check if we can find our button by other means
  const greenButtons = await page.locator('button[style*="28a745"]').count();
  console.log('Green buttons found:', greenButtons);
});
