import { test, expect } from '@playwright/test';

test.describe('Final Working Integration Test', () => {
  test('should successfully click New Project button with real API', async ({ page }) => {
    console.log('🎯 Testing against simple-test.html with real API integration');
    
    // Navigate to the working page
    await page.goto('http://localhost:8081/simple-test.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    
    // Verify page loaded
    const title = await page.title();
    console.log('✅ Page loaded:', title);
    
    // Find the New Project button
    const newProjectButton = page.locator('#new-project-btn');
    await expect(newProjectButton).toBeVisible();
    
    const buttonText = await newProjectButton.textContent();
    console.log('✅ New Project button found:', buttonText);
    
    // Click the button
    await newProjectButton.click();
    
    // Wait for the API call to complete
    await page.waitForTimeout(2000);
    
    // Check the status message to see if API call worked
    const statusElement = page.locator('#status');
    const statusText = await statusElement.textContent();
    console.log('✅ Status after click:', statusText);
    
    // Verify the API integration worked
    expect(statusText).toContain('API Working');
    expect(statusText).toContain('projects');
    
    console.log('🎉 SUCCESS: New Project button works with real API!');
    
    // Take a screenshot of success
    await page.screenshot({ path: 'test-results/final-success.png' });
  });
});
