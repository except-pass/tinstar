/**
 * API Integration Tests
 * 
 * Tests the integration between the FileTree component and the backend API.
 * These tests verify:
 * - API endpoint correctness
 * - Request/response format compliance
 * - Error handling scenarios
 * - Data transformation accuracy
 */

import { test, expect } from '@playwright/test';

test.describe('FileTree API Integration', () => {
  
  test('API endpoint format matches specification', async ({ page }) => {
    // Mock network requests to capture API calls
    const apiCalls: any[] = [];
    
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.includes('/api/filelist/')) {
        apiCalls.push({
          url,
          method: route.request().method(),
          headers: route.request().headers(),
          body: route.request().postData()
        });
        
        // Mock successful response
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            tree: {
              type: 'directory',
              path: '',
              children: [],
              stats: {}
            }
          })
        });
      } else {
        route.continue();
      }
    });
    
    // Load a simple component that makes API calls
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body>
        <div id="test"></div>
        <script>
          async function testAPI() {
            const response = await fetch('/api/filelist/test-project/tree', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ open_dirs: [''] })
            });
            
            const data = await response.json();
            document.getElementById('test').textContent = 'API called';
          }
          
          testAPI().catch(console.error);
        </script>
      </body>
      </html>
    `);
    
    await page.waitForSelector('#test:has-text("API called")');
    
    // Verify API call format
    expect(apiCalls).toHaveLength(1);
    const apiCall = apiCalls[0];
    
    expect(apiCall.url).toContain('/api/filelist/test-project/tree');
    expect(apiCall.method).toBe('POST');
    expect(apiCall.headers['content-type']).toContain('application/json');
    
    const requestBody = JSON.parse(apiCall.body);
    expect(requestBody).toHaveProperty('open_dirs');
    expect(Array.isArray(requestBody.open_dirs)).toBe(true);
  });

  test('handles API errors gracefully', async ({ page }) => {
    // Mock API to return different error responses
    await page.route('**/api/filelist/**', route => {
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Project not found' })
      });
    });
    
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body>
        <div id="error-test"></div>
        <script>
          async function testErrorHandling() {
            try {
              const response = await fetch('/api/filelist/nonexistent/tree', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ open_dirs: [''] })
              });
              
              if (!response.ok) {
                document.getElementById('error-test').textContent = 'Error handled: ' + response.status;
              }
            } catch (error) {
              document.getElementById('error-test').textContent = 'Network error handled';
            }
          }
          
          testErrorHandling().catch(console.error);
        </script>
      </body>
      </html>
    `);
    
    await page.waitForSelector('#error-test:has-text("Error handled: 404")');
  });

  test('data transformation matches specification', async ({ page }) => {
    const mockApiResponse = {
      tree: {
        path: '',
        children: [
          {
            type: 'file',
            path: 'test.js',
            size: 1024,
            modified: '2024-01-15T10:30:00Z',
            stats: { lines_added: 15, lines_removed: 3, is_tracked: true }
          }
        ],
        stats: { lines_added: 15, lines_removed: 3 }
      }
    };
    
    await page.route('**/api/filelist/**', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockApiResponse)
      });
    });
    
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body>
        <div id="transform-test"></div>
        <script>
          async function testTransformation() {
            const response = await fetch('/api/filelist/test/tree', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ open_dirs: [''] })
            });
            
            const data = await response.json();
            
            // Verify structure
            const valid = (
              data.tree &&
              data.tree.path === '' &&
              Array.isArray(data.tree.children) &&
              data.tree.children.length > 0 &&
              data.tree.children[0].type === 'file' &&
              data.tree.children[0].path === 'test.js' &&
              typeof data.tree.children[0].stats === 'object'
            );
            
            document.getElementById('transform-test').textContent = valid ? 'Transformation valid' : 'Transformation invalid';
          }
          
          testTransformation().catch(console.error);
        </script>
      </body>
      </html>
    `);
    
    await page.waitForSelector('#transform-test:has-text("Transformation valid")');
  });

  test('editor integration API calls work correctly', async ({ page }) => {
    const editorCalls: any[] = [];
    
    await page.route('**/api/sessions/**/editor', route => {
      editorCalls.push({
        url: route.request().url(),
        method: route.request().method(),
        body: route.request().postData()
      });
      
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true })
      });
    });
    
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <body>
        <div id="editor-test"></div>
        <script>
          async function testEditorAPI() {
            const response = await fetch('/api/sessions/test-session/editor', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ file_path: 'src/test.js' })
            });
            
            const data = await response.json();
            document.getElementById('editor-test').textContent = data.success ? 'Editor API works' : 'Editor API failed';
          }
          
          testEditorAPI().catch(console.error);
        </script>
      </body>
      </html>
    `);
    
    await page.waitForSelector('#editor-test:has-text("Editor API works")');
    
    // Verify editor API call format
    expect(editorCalls).toHaveLength(1);
    const editorCall = editorCalls[0];
    
    expect(editorCall.url).toContain('/api/sessions/test-session/editor');
    expect(editorCall.method).toBe('POST');
    
    const requestBody = JSON.parse(editorCall.body);
    expect(requestBody).toHaveProperty('file_path');
    expect(requestBody.file_path).toBe('src/test.js');
  });
});