import React, { useState } from 'react';
import { AgentPane } from './AgentPane';

// Mock data for demo
const mockProjects = [
  {
    name: 'tinstar',
    path: '/home/ubuntu/repo/tinstar',
    created_at: '2025-01-01T10:00:00Z',
    unignore_paths: ['.env', 'config/secrets.json']
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
    unignore_paths: ['.env.local']
  }
];

const mockSessions = [
  {
    id: 'session-1',
    name: 'deadwood-saloon',
    project: 'tinstar',
    status: 'active' as const,
    created_at: '2025-01-15T09:00:00Z',
    last_activity: '2025-01-15T09:45:00Z',
    agent_type: 'claude',
    initial_prompt: 'Help me implement the agent pane'
  },
  {
    id: 'session-2', 
    name: 'tombstone-ranch',
    project: 'tinstar',
    status: 'active' as const,
    created_at: '2025-01-15T10:00:00Z',
    last_activity: '2025-01-15T10:30:00Z',
    agent_type: 'claude'
  },
  {
    id: 'session-3',
    name: 'silver-city',
    project: 'claude-code',
    status: 'active' as const,
    created_at: '2025-01-15T11:00:00Z',
    last_activity: '2025-01-15T08:00:00Z', // Old activity (idle)
    agent_type: 'claude',
    initial_prompt: 'Debug the authentication flow'
  },
  {
    id: 'session-4',
    name: 'dodge-city',
    project: 'webapp',
    status: 'active' as const,
    created_at: '2025-01-15T12:00:00Z',
    last_activity: '2025-01-15T12:15:00Z',
    agent_type: 'claude'
  }
];

const mockEvents = {
  'session-1': [
    {
      session_id: 'session-1',
      timestamp: '2025-01-15T09:45:00Z',
      hook_event_name: 'PreToolUse',
      tool_name: 'TodoWrite'
    }
  ],
  'session-2': [
    {
      session_id: 'session-2', 
      timestamp: '2025-01-15T10:30:00Z',
      hook_event_name: 'notification',
      tool_name: 'Bash'
    }
  ],
  'session-3': [
    {
      session_id: 'session-3',
      timestamp: '2025-01-15T08:00:00Z',
      hook_event_name: 'Stop'
    }
  ],
  'session-4': [
    {
      session_id: 'session-4',
      timestamp: '2025-01-15T12:15:00Z',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit'
    }
  ]
};

// Mock API responses
const setupMockAPIs = () => {
  // Mock fetch to return our test data
  const originalFetch = window.fetch;
  
  window.fetch = async (url: string | Request, init?: RequestInit): Promise<Response> => {
    const urlString = typeof url === 'string' ? url : url.url;
    
    if (urlString.includes('/api/sessions')) {
      if (init?.method === 'POST') {
        // Create session
        const body = JSON.parse(init.body as string);
        const newSession = {
          id: `session-${Date.now()}`,
          name: `new-session-${Math.random().toString(36).substr(2, 8)}`,
          project: body.project,
          status: 'active' as const,
          created_at: new Date().toISOString(),
          last_activity: new Date().toISOString(),
          agent_type: body.agent_type || 'claude',
          initial_prompt: body.initial_prompt
        };
        
        return new Response(JSON.stringify({
          success: true,
          session: newSession,
          message: `Session '${newSession.name}' created successfully`
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        // Get sessions
        return new Response(JSON.stringify({
          success: true,
          sessions: mockSessions
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    if (urlString.includes('/api/projects')) {
      return new Response(JSON.stringify({
        success: true,
        projects: mockProjects
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (urlString.includes('/api/events')) {
      const url = new URL(urlString, window.location.origin);
      const sessionId = url.searchParams.get('session_id');
      const events = sessionId ? (mockEvents[sessionId] || []) : [];
      
      return new Response(JSON.stringify(events), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Fallback to original fetch for other requests
    return originalFetch(url, init);
  };
};

export const AgentPaneDemo: React.FC = () => {
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [mounted, setMounted] = useState(false);

  React.useEffect(() => {
    setupMockAPIs();
    setMounted(true);
  }, []);

  const handleAgentClick = (sessionId: string) => {
    setSelectedAgentId(sessionId);
    console.log('Selected agent:', sessionId);
  };

  if (!mounted) {
    return <div>Loading demo...</div>;
  }

  return (
    <div style={{ display: 'flex', height: '100vh', backgroundColor: '#f5f5f5' }}>
      <AgentPane
        onAgentClick={handleAgentClick}
        selectedAgentId={selectedAgentId}
      />
      
      <div style={{ 
        flex: 1, 
        padding: '20px',
        backgroundColor: '#fff',
        margin: '20px',
        borderRadius: '8px',
        boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
      }}>
        <h2>Agent Details</h2>
        {selectedAgentId ? (
          <div>
            <h3>Selected Agent: {selectedAgentId}</h3>
            <p>This would be the details pane showing information about the selected agent.</p>
            <div style={{ 
              padding: '16px', 
              backgroundColor: '#f8f9fa', 
              borderRadius: '4px',
              marginTop: '16px'
            }}>
              <strong>Mock Session Details:</strong>
              <pre style={{ fontSize: '12px', margin: '8px 0' }}>
                {JSON.stringify(
                  mockSessions.find(s => s.id === selectedAgentId), 
                  null, 
                  2
                )}
              </pre>
            </div>
          </div>
        ) : (
          <p>Click on an agent in the left pane to see its details here.</p>
        )}
        
        <div style={{ marginTop: '20px' }}>
          <h4>Demo Features:</h4>
          <ul style={{ fontSize: '14px', lineHeight: '1.6' }}>
            <li>✅ Project grouping with color-coded backgrounds</li>
            <li>✅ Agent status indicators (Active/Needs attention/Idle)</li>
            <li>✅ Real-time status based on mock events</li>
            <li>✅ Agent selection with visual feedback</li>
            <li>✅ New agent creation dialog</li>
            <li>✅ WebSocket connection indicator</li>
            <li>✅ Auto-refresh every 10 seconds</li>
          </ul>
          
          <h4 style={{ marginTop: '20px' }}>Test Cases:</h4>
          <ul style={{ fontSize: '14px', lineHeight: '1.6' }}>
            <li><strong>deadwood-saloon</strong>: Active (recent activity)</li>
            <li><strong>tombstone-ranch</strong>: Needs attention (notification event)</li>
            <li><strong>silver-city</strong>: Idle (Stop event + old activity)</li>
            <li><strong>dodge-city</strong>: Active (recent activity)</li>
          </ul>
        </div>
      </div>
    </div>
  );
};