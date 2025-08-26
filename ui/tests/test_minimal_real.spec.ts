import { test, expect } from '@playwright/test';

test('test minimal real page', async ({ page }) => {
  await page.goto('http://localhost:8081/minimal-real-test.html');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);
  
  const title = await page.title();
  const buttons = await page.locator('button').count();
  
  console.log('Title:', title);
  console.log('Buttons found:', buttons);
  
  if (buttons > 0) {
    const newProjectButton = page.locator('button').filter({ hasText: /new project/i }).first();
    const buttonText = await newProjectButton.textContent();
    console.log('New Project button text:', buttonText);
    
    // Test clicking the button
    await newProjectButton.click();
    
    // Check for alert (in this minimal version it shows an alert)
    page.on('dialog', dialog => {
      console.log('Alert appeared:', dialog.message());
      dialog.accept();
    });
    
    console.log('✅ Successfully clicked New Project button');
  }
  
  // Check if projects loaded
  const projectCount = await page.locator('text=/Projects \\(/').textContent();
  console.log('Project count text:', projectCount);
  
  expect(buttons).toBeGreaterThan(0);
  expect(title).toContain('Minimal Real Test');
});
