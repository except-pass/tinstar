import { test, expect } from '@playwright/test';

test('test real page after fix', async ({ page }) => {
  await page.goto('http://localhost:8081/real-test.html');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);
  
  const title = await page.title();
  const buttons = await page.locator('button').count();
  const projectMentions = await page.locator('text=/project/i').count();
  
  console.log('Title:', title);
  console.log('Buttons:', buttons);
  console.log('Project mentions:', projectMentions);
  
  // Take screenshot to see what we have
  await page.screenshot({ path: 'test-results/real-page-fixed.png' });
  
  if (buttons > 0) {
    const allButtons = await page.locator('button').all();
    for (let i = 0; i < Math.min(allButtons.length, 5); i++) {
      const buttonText = await allButtons[i].textContent();
      console.log(`Button ${i}: "${buttonText}"`);
    }
  }
  
  // Basic assertion - should have loaded content
  const bodyText = await page.locator('body').textContent();
  expect(bodyText?.length || 0).toBeGreaterThan(1000);
});
