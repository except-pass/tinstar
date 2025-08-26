import { test, expect } from '@playwright/test';

test.describe('AgentPane Component', () => {
  test.beforeEach(async ({ page }) => {
    // Mock API responses with our test data
    await page.route('/api/projects', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          projects: [
            {
              name: 'tinstar',
              path: '/home/ubuntu/repo/tinstar',
              created_at: '2025-01-01T10:00:00Z',
              unignore_paths: ['.env']
            },
            {
              name: 'claude-code',
              path: '/home/ubuntu/repo/claude-code',
              created_at: '2025-01-02T11:00:00Z',
              unignore_paths: []
            },
            {
              name: 'webapp',
              path: '/home/ubuntu/projects/webapp',
              created_at: '2025-01-03T12:00:00Z',
              unignore_paths: []
            }
          ]
        })
      });
    });

    await page.route('/api/sessions', async route => {
      if (route.request().method() === 'POST') {
        // Handle session creation
        const body = await route.request().postDataJSON();
        const newSession = {
          id: `session-${Date.now()}`,
          name: `new-agent-${Math.random().toString(36).substr(2, 8)}`,
          project: body.project,
          status: 'active',
          created_at: new Date().toISOString(),
          last_activity: new Date().toISOString(),
          agent_type: body.agent_type || 'claude',
          initial_prompt: body.initial_prompt
        };
        
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            session: newSession,
            message: `Session '${newSession.name}' created successfully`
          })
        });
      } else {
        // Handle session list
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            sessions: [
              {
                id: 'session-active-1',
                name: 'deadwood-saloon',
                project: 'tinstar',
                status: 'active',
                created_at: '2025-01-15T09:00:00Z',
                last_activity: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
                agent_type: 'claude'
              },
              {
                id: 'session-attention-1',
                name: 'tombstone-ranch',
                project: 'tinstar',
                status: 'active',
                created_at: '2025-01-15T10:00:00Z',
                last_activity: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
                agent_type: 'claude'
              },
              {
                id: 'session-idle-1',
                name: 'silver-city',
                project: 'claude-code',
                status: 'active',
                created_at: '2025-01-15T11:00:00Z',
                last_activity: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                agent_type: 'claude'
              },
              {
                id: 'session-active-2',
                name: 'dodge-city',
                project: 'webapp',
                status: 'active',
                created_at: '2025-01-15T12:00:00Z',
                last_activity: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
                agent_type: 'claude'
              }
            ]
          })
        });
      }
    });

    // Mock events API with different event types for different sessions
    await page.route('/api/events**', async route => {
      const url = new URL(route.request().url());
      const sessionId = url.searchParams.get('session_id');
      
      const mockEvents = {
        'session-active-1': [
          {
            session_id: 'session-active-1',
            timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            hook_event_name: 'PreToolUse',
            tool_name: 'TodoWrite'
          }
        ],
        'session-attention-1': [
          {
            session_id: 'session-attention-1',
            timestamp: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
            hook_event_name: 'notification',
            tool_name: 'Bash'
          }
        ],
        'session-idle-1': [
          {
            session_id: 'session-idle-1',
            timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
            hook_event_name: 'Stop'
          }
        ],
        'session-active-2': [
          {
            session_id: 'session-active-2',
            timestamp: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
            hook_event_name: 'PostToolUse',
            tool_name: 'Edit'
          }
        ]
      };

      const events = sessionId ? (mockEvents[sessionId] || []) : [];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(events)
      });
    });

    await page.goto('/test-agent-pane');
  });

  test('displays project groups with correct background colors', async ({ page }) => {
    // Wait for component to load
    await expect(page.locator('.agent-pane')).toBeVisible();
    
    // Check that project groups are displayed
    await expect(page.locator('.project-group')).toHaveCount(3);
    
    // Verify project names are displayed
    await expect(page.locator('text=tinstar')).toBeVisible();
    await expect(page.locator('text=claude-code')).toBeVisible();
    await expect(page.locator('text=webapp')).toBeVisible();
    
    // Check project group background colors (Desert Sand, Saddle Brown, Rust Red)
    const tinstarGroup = page.locator('.project-group').first();
    await expect(tinstarGroup).toHaveCSS('background-color', 'rgb(198, 167, 123)'); // #C6A77B
  });

  test('displays agents with correct status indicators', async ({ page }) => {
    await expect(page.locator('.agent-pane')).toBeVisible();
    
    // Wait for status updates to complete
    await page.waitForTimeout(2000);
    
    // Check that all agents are displayed
    await expect(page.locator('.small-agent-widget')).toHaveCount(4);
    
    // Verify agent names are displayed
    await expect(page.locator('text=deadwood-saloon')).toBeVisible();
    await expect(page.locator('text=tombstone-ranch')).toBeVisible();
    await expect(page.locator('text=silver-city')).toBeVisible();
    await expect(page.locator('text=dodge-city')).toBeVisible();
    
    // Check status indicators - look for the status text
    await expect(page.locator('text=Active')).toHaveCount(2); // deadwood-saloon and dodge-city
    await expect(page.locator('text=Needs attention')).toHaveCount(1); // tombstone-ranch
    await expect(page.locator('text=Idle')).toHaveCount(1); // silver-city
  });

  test('agent selection works correctly', async ({ page }) => {
    await expect(page.locator('.agent-pane')).toBeVisible();
    
    // Click on first agent
    await page.locator('text=deadwood-saloon').click();
    
    // Check that the agent is selected (should have 'selected' class)
    const selectedAgent = page.locator('.small-agent-widget').first();
    await expect(selectedAgent).toHaveClass(/selected/);
    
    // Click on another agent
    await page.locator('text=silver-city').click();
    
    // Check that selection moved
    const newSelectedAgent = page.locator('.small-agent-widget').nth(2);
    await expect(newSelectedAgent).toHaveClass(/selected/);
    
    // First agent should no longer be selected
    await expect(selectedAgent).not.toHaveClass(/selected/);
  });

  test('new agent dialog works correctly', async ({ page }) => {
    await expect(page.locator('.agent-pane')).toBeVisible();
    
    // Click new agent button
    await page.locator('text=+ New Agent').click();
    
    // Dialog should appear
    await expect(page.locator('.new-agent-dialog')).toBeVisible();
    await expect(page.locator('text=Create New Agent')).toBeVisible();
    
    // Select a project
    await page.selectOption('#project-select', 'tinstar');
    
    // Add initial prompt
    await page.fill('#initial-prompt', 'Test agent creation');
    
    // Create agent button should be enabled
    const createButton = page.locator('button:text("Create Agent")');
    await expect(createButton).toBeEnabled();
    
    // Click create (this will trigger the mocked API)
    await createButton.click();
    
    // Dialog should close
    await expect(page.locator('.new-agent-dialog')).not.toBeVisible();
  });

  test('displays WebSocket connection indicator', async ({ page }) => {
    await expect(page.locator('.agent-pane')).toBeVisible();
    
    // Check for WebSocket indicator (green dot)
    await expect(page.locator('.websocket-indicator')).toBeVisible();
    await expect(page.locator('.websocket-indicator')).toContainText('🟢');
  });

  test('shows empty state when no agents exist', async ({ page }) => {
    // Override sessions API to return empty list
    await page.route('/api/sessions', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          sessions: []
        })
      });
    });
    
    await page.goto('/test-agent-pane');
    await expect(page.locator('.agent-pane')).toBeVisible();
    
    // Should show empty state
    await expect(page.locator('.empty-state')).toBeVisible();
    await expect(page.locator('text=No active agents')).toBeVisible();
  });

  test('handles API errors gracefully', async ({ page }) => {
    // Override sessions API to return error
    await page.route('/api/sessions', async route => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Internal server error'
        })
      });
    });
    
    await page.goto('/test-agent-pane');
    await expect(page.locator('.agent-pane')).toBeVisible();
    
    // Should show error banner
    await expect(page.locator('.error-banner')).toBeVisible();
    
    // Retry button should be present
    await expect(page.locator('.error-banner button:text("Retry")')).toBeVisible();
  });

  test('project grouping maintains correct order', async ({ page }) => {
    await expect(page.locator('.agent-pane')).toBeVisible();
    
    // Check that projects are grouped correctly with agents
    const projectGroups = page.locator('.project-group');
    
    // tinstar project should have 2 agents (deadwood-saloon, tombstone-ranch)
    const tinstarGroup = projectGroups.first();
    await expect(tinstarGroup.locator('.small-agent-widget')).toHaveCount(2);
    
    // claude-code project should have 1 agent (silver-city)  
    const claudeCodeGroup = projectGroups.nth(1);
    await expect(claudeCodeGroup.locator('.small-agent-widget')).toHaveCount(1);
    
    // webapp project should have 1 agent (dodge-city)
    const webappGroup = projectGroups.nth(2);
    await expect(webappGroup.locator('.small-agent-widget')).toHaveCount(1);
  });
});