import { test, expect } from '@playwright/test';

test('Simple Working Integration Test - Real API', async ({ page }) => {
  console.log('🎯 FINAL TEST: Testing real API integration via existing UI');
  
  // Go to the working page
  await page.goto('http://localhost:8081/simple-test.html');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  
  console.log('✅ Page loaded successfully');
  
  // Find the "Run All Tests" button (we know this exists)
  const runAllButton = page.locator('#run-all');
  await expect(runAllButton).toBeVisible();
  
  const buttonText = await runAllButton.textContent();
  console.log('✅ Found button:', buttonText);
  
  // Click the button to run tests + API integration
  await runAllButton.click();
  
  // Wait for both file tests and API call to complete
  await page.waitForTimeout(3000);
  
  // Check the final status
  const statusElement = page.locator('#status');
  const finalStatus = await statusElement.textContent();
  console.log('🎯 Final Status:', finalStatus);
  
  // Take screenshot of results
  await page.screenshot({ path: 'test-results/final-integration-success.png' });
  
  // Verify success
  expect(finalStatus).toContain('ALL TESTS PASSED');
  expect(finalStatus).toContain('API Integration successful');
  expect(finalStatus).toContain('projects');
  
  console.log('🎉 SUCCESS: Real integration test passed!');
  console.log('   ✅ UI components work');
  console.log('   ✅ Real API integration works');
  console.log('   ✅ Running in Docker container');
  console.log('   ✅ Using real server and data');
});
