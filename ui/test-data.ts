// Mock tree data for testing
export const mockTreeData = {
  tree: {
    type: 'directory',
    path: '',
    children: [
      {
        type: 'directory',
        path: 'src',
        children: [
          {
            type: 'directory',
            path: 'src/components',
            children: [
              {
                type: 'file',
                path: 'src/components/Button.tsx',
                size: 1024,
                modified: '2024-01-15T10:30:00Z',
                stats: { lines_added: 15, lines_removed: 3, is_tracked: true }
              },
              {
                type: 'file', 
                path: 'src/components/Input.tsx',
                size: 2048,
                modified: '2024-01-15T11:00:00Z',
                stats: { lines_added: 20, lines_removed: 5, is_tracked: true }
              }
            ],
            stats: { lines_added: 35, lines_removed: 8 }
          },
          {
            type: 'file',
            path: 'src/App.tsx',
            size: 1536,
            modified: '2024-01-15T09:15:00Z',
            stats: { lines_added: 20, lines_removed: 3, is_tracked: true }
          },
          {
            type: 'file',
            path: 'src/index.ts',
            size: 512,
            modified: '2024-01-15T12:00:00Z',
            stats: { is_tracked: false } // New file
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
      },
      {
        type: 'file',
        path: 'package.json',
        size: 600,
        modified: '2024-01-15T07:30:00Z',
        stats: { lines_added: 0, lines_removed: 0, is_tracked: true }
      }
    ],
    stats: { lines_added: 65, lines_removed: 11 }
  }
};

export const collapsedTreeData = {
  tree: {
    type: 'directory',
    path: '',
    children: [
      {
        type: 'directory',
        path: 'src',
        children: [], // Collapsed
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

// Test data for agent pane components

export const mockAgentPaneData = {
  projects: [
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
  ],

  sessions: [
    {
      id: 'session-active-1',
      name: 'deadwood-saloon',
      project: 'tinstar',
      status: 'active' as const,
      created_at: '2025-01-15T09:00:00Z',
      last_activity: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 minutes ago
      agent_type: 'claude',
      initial_prompt: 'Help me implement the agent pane'
    },
    {
      id: 'session-attention-1', 
      name: 'tombstone-ranch',
      project: 'tinstar',
      status: 'active' as const,
      created_at: '2025-01-15T10:00:00Z',
      last_activity: new Date(Date.now() - 3 * 60 * 1000).toISOString(), // 3 minutes ago
      agent_type: 'claude'
    },
    {
      id: 'session-idle-1',
      name: 'silver-city',
      project: 'claude-code',
      status: 'active' as const,
      created_at: '2025-01-15T11:00:00Z',
      last_activity: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago (idle)
      agent_type: 'claude',
      initial_prompt: 'Debug the authentication flow'
    },
    {
      id: 'session-active-2',
      name: 'dodge-city',
      project: 'webapp',
      status: 'active' as const,
      created_at: '2025-01-15T12:00:00Z',
      last_activity: new Date(Date.now() - 1 * 60 * 1000).toISOString(), // 1 minute ago
      agent_type: 'claude'
    },
    {
      id: 'session-active-3',
      name: 'abilene-town',
      project: 'webapp',
      status: 'active' as const,
      created_at: '2025-01-15T13:00:00Z',
      last_activity: new Date(Date.now() - 4 * 60 * 1000).toISOString(), // 4 minutes ago
      agent_type: 'claude'
    }
  ],

  events: {
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
    ],
    'session-active-3': [
      {
        session_id: 'session-active-3',
        timestamp: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
        hook_event_name: 'PreToolUse',
        tool_name: 'Read'
      }
    ]
  }
};

export const expectedProjectColors = [
  '#C6A77B', // Desert Sand - tinstar (created first)
  '#8B5A2B', // Saddle Brown - claude-code (created second)
  '#A04020', // Rust Red - webapp (created third)
];

export const expectedStatuses = {
  'session-active-1': {
    statusText: 'Active',
    statusColor: 'green',
    needsAttention: false
  },
  'session-attention-1': {
    statusText: 'Needs attention',
    statusColor: 'yellow', 
    needsAttention: true
  },
  'session-idle-1': {
    statusText: 'Idle',
    statusColor: 'gray',
    needsAttention: false
  },
  'session-active-2': {
    statusText: 'Active',
    statusColor: 'green',
    needsAttention: false
  },
  'session-active-3': {
    statusText: 'Active',
    statusColor: 'green',
    needsAttention: false
  }
};