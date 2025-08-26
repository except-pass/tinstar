import { test, expect } from '@playwright/test';

test('find what URLs actually work', async ({ page }) => {
  const urlsToTry = [
    'http://localhost:8081/',
    'http://localhost:8081/index.html',
    'http://localhost:8081/master.html',
    'http://localhost:8081/demo-page.html',
    'http://localhost:8081/real-test.html',
    'http://localhost:8081/simple-test.html'
  ];
  
  for (const url of urlsToTry) {
    try {
      console.log(`\n=== Trying ${url} ===`);
      await page.goto(url, { timeout: 5000 });
      await page.waitForTimeout(2000);
      
      const title = await page.title();
      const bodyText = await page.locator('body').textContent();
      const bodyLength = bodyText?.length || 0;
      const hasButtons = await page.locator('button').count();
      const hasProjectText = await page.locator('text=/project/i').count();
      
      console.log(`✅ ${url} - SUCCESS`);
      console.log(`   Title: "${title}"`);
      console.log(`   Body length: ${bodyLength} chars`);
      console.log(`   Buttons: ${hasButtons}`);
      console.log(`   Project mentions: ${hasProjectText}`);
      
      if (hasButtons > 0) {
        const buttons = await page.locator('button').all();
        for (let i = 0; i < Math.min(buttons.length, 3); i++) {
          const buttonText = await buttons[i].textContent();
          console.log(`   Button ${i}: "${buttonText}"`);
        }
      }
      
      // Take a screenshot of working pages
      if (bodyLength > 1000 || hasButtons > 0) {
        await page.screenshot({ 
          path: `test-results/working-page-${url.replace(/[^a-zA-Z0-9]/g, '_')}.png` 
        });
      }
      
    } catch (error) {
      console.log(`❌ ${url} - FAILED: ${error.message}`);
    }
  }
});
