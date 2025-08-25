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