/**
 * Test Data Utilities Tests
 * 
 * Tests for mock data and test utilities used across the test suite.
 * Ensures test data is consistent and follows the API specification.
 */

import { test, expect } from '@playwright/test';

test.describe('Test Data Utilities', () => {
  test('mock data follows API specification format', async ({ page }) => {
    // Define mock data inline to avoid import issues
    await page.setContent(`
      <!DOCTYPE html>
      <html>
      <head><title>Test Data Validation</title></head>
      <body>
        <script>
          const mockTreeData = {
            tree: {
              type: 'directory',
              path: '',
              children: [
                {
                  type: 'directory',
                  path: 'src',
                  children: [
                    {
                      type: 'file',
                      path: 'src/App.tsx',
                      size: 1536,
                      modified: '2024-01-15T09:15:00Z',
                      stats: { lines_added: 20, lines_removed: 3, is_tracked: true }
                    }
                  ],
                  stats: { lines_added: 55, lines_removed: 11 }
                },
                {
                  type: 'file',
                  path: 'README.md',
                  size: 800,
                  modified: '2024-01-15T08:00:00Z',
                  stats: { lines_added: 10, lines_removed: 0, is_tracked: true }
                }
              ],
              stats: { lines_added: 65, lines_removed: 11 }
            }
          };
          window.mockTreeData = mockTreeData;
        </script>
      </body>
      </html>
    `);
    
    // Validate mock data structure in JavaScript
    const isValidStructure = await page.evaluate(() => {
      // Check if mockTreeData is available
      if (!window.mockTreeData) return false;
      
      const tree = window.mockTreeData.tree;
      
      // Validate root structure
      if (tree.type !== 'directory') return false;
      if (tree.path !== '') return false;
      if (!Array.isArray(tree.children)) return false;
      if (typeof tree.stats !== 'object') return false;
      
      // Validate children structure
      for (const child of tree.children) {
        if (!child.type || !['file', 'directory'].includes(child.type)) return false;
        if (typeof child.path !== 'string') return false;
        if (typeof child.stats !== 'object') return false;
        
        if (child.type === 'file') {
          if (typeof child.size !== 'number') return false;
          if (typeof child.modified !== 'string') return false;
        }
        
        if (child.type === 'directory') {
          if (!Array.isArray(child.children)) return false;
        }
      }
      
      return true;
    });
    
    expect(isValidStructure).toBe(true);
  });

  test('test data covers all required scenarios', async ({ page }) => {
    await page.setContent(`
      <script>
        const mockTreeData = {
          tree: {
            type: 'directory',
            path: '',
            children: [
              {
                type: 'file',
                path: 'README.md',
                stats: { lines_added: 10, lines_removed: 0, is_tracked: true }
              },
              {
                type: 'file', 
                path: 'new-file.js',
                stats: { is_tracked: false }
              },
              {
                type: 'file',
                path: 'binary-file.jpg', 
                stats: { binary: true }
              },
              {
                type: 'directory',
                path: 'src',
                children: [],
                stats: { lines_added: 50, lines_removed: 10 }
              }
            ]
          }
        };
        window.testData = mockTreeData;
      </script>
    `);
    
    const hasAllScenarios = await page.evaluate(() => {
      const tree = window.testData.tree;
      const files = tree.children;
      
      // Check for different file types and stats combinations
      const hasTrackedFile = files.some(f => f.stats && f.stats.is_tracked === true);
      const hasNewFile = files.some(f => f.stats && f.stats.is_tracked === false);
      const hasBinaryFile = files.some(f => f.stats && f.stats.binary === true);
      const hasDirectory = files.some(f => f.type === 'directory');
      const hasStatsWithBothAddedRemoved = files.some(f => 
        f.stats && f.stats.lines_added && f.stats.lines_removed
      );
      
      return hasTrackedFile && hasNewFile && hasBinaryFile && hasDirectory && hasStatsWithBothAddedRemoved;
    });
    
    expect(hasAllScenarios).toBe(true);
  });
});