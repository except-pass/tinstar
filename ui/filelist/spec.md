# Filelist UI Component Specification

## Overview

A simple file tree display component using `react-arborist` that shows project files and allows opening them in an editor.

## Data Source

Consumes data from `/filelist/{project}/tree` API:

```typescript
interface FileTreeResponse {
  tree: DirectoryNode
}

interface DirectoryNode {
  type: 'directory'
  path: string
  children: (FileNode | DirectoryNode)[]
  stats: Record<string, number>
}

interface FileNode {
  type: 'file'
  path: string
  size: number
  modified: string
  stats: {
    lines_added?: number
    lines_removed?: number
    is_tracked?: boolean
    binary?: boolean
  }
}
```

## Visual Design

```
📁 src/                          [+125/-23]
├─ 📁 components/                [+45/-12] 
│  ├─ 📄 Button.tsx              [+15/-3]  ✏️
│  └─ 📄 Input.tsx               [+20/-5]  ✏️
├─ 📄 App.tsx                    [+20/-3]  ✏️
└─ 📄 index.ts                   [New]     ✏️
```

## Entry Components

Each entry shows: `[Expander] [Icon] [Name] [Stats] [OpenEditor]`

- **Directories**: Folder icon, expandable, aggregated stats from children
- **Files**: File type icon, individual file stats, clickable to open in editor

## Implementation

### Using react-arborist

```bash
npm install react-arborist
```

```tsx
import { Tree } from 'react-arborist'

const FileTree = ({ projectName }) => {
  const [openDirs, setOpenDirs] = useState([''])
  
  const handleToggle = (node) => {
    // Update openDirs and refetch tree data
  }
  
  const handleOpenFile = (filePath) => {
    // Call editor API to open file
  }
  
  return (
    <Tree
      data={treeData}
      onToggle={handleToggle}
      height={400}
      indent={20}
    >
      {FileTreeNode}
    </Tree>
  )
}

const FileTreeNode = ({ node }) => (
  <div className="file-entry">
    {/* react-arborist handles icons automatically */}
    <span className="filename">{node.data.name}</span>
    <span className="stats">{formatStats(node.data.stats)}</span>
    {node.data.type === 'file' && (
      <button onClick={() => handleOpenFile(node.data.path)}>
        ✏️
      </button>
    )}
  </div>
)

const formatStats = (stats) => {
  const parts = []
  if (stats.lines_added) parts.push(`+${stats.lines_added}`)
  if (stats.lines_removed) parts.push(`-${stats.lines_removed}`)
  if (stats.binary) parts.push('Binary')
  if (!stats.is_tracked) parts.push('New')
  return parts.length > 0 ? `[${parts.join('/')}]` : ''
}
```

### File Icons

Uses `react-arborist`'s built-in file type icons (automatic based on file extensions).

### Open Editor

Click ✏️ button → calls configured editor to open file.

## API Integration

### Data Fetching
```typescript
// Fetch tree data when component mounts or openDirs changes
const fetchTreeData = async (projectName: string, openDirs: string[]) => {
  const response = await fetch(`/filelist/${projectName}/tree?open_dirs=${openDirs.join(',')}`)
  return response.json()
}
```

### Editor Integration
```typescript
// Open file in configured editor
const openInEditor = async (filePath: string) => {
  await fetch('/api/editor/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_path: filePath })
  })
}
```

## State Management

```typescript
interface FileTreeState {
  openDirs: string[]           // Currently expanded directories
  selectedPath: string | null  // Currently selected file
  loading: boolean             // Loading state for API calls
  error: string | null         // Error message if API fails
}
```

## Error Handling

- **API failures**: Show error message with retry button
- **Missing files**: Handle gracefully if files disappear
- **Network issues**: Retry logic with exponential backoff

## Accessibility

- **Keyboard navigation**: Arrow keys, Enter, Space
- **Screen readers**: Proper ARIA labels for tree structure
- **Focus management**: Clear focus indicators

## Performance Considerations

- **Debounced API calls**: Don't refetch on every expand/collapse
- **Memoization**: Cache tree data to avoid unnecessary re-renders
- **Virtual scrolling**: For large file trees (react-arborist handles this)

## Testing Strategy

### Playwright E2E Tests

Create a test UI that renders ONLY the FileTree component with controlled test data:

```typescript
// test-data.ts
export const mockTreeData = {
  tree: {
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
  }
}
```

### High-Value Test Scenarios

```typescript
// filetree.spec.ts
import { test, expect } from '@playwright/test'

test.describe('FileTree Component', () => {
  test.beforeEach(async ({ page }) => {
    // Mock API responses
    await page.route('/filelist/test-project/tree**', async route => {
      await route.fulfill({ 
        status: 200, 
        contentType: 'application/json',
        body: JSON.stringify(mockTreeData)
      })
    })
    
    await page.goto('/test-filetree')
  })

  test('displays root directory with aggregated stats', async ({ page }) => {
    await expect(page.locator('text=src')).toBeVisible()
    await expect(page.locator('text=[+55/-11]')).toBeVisible()
  })

  test('expands directory and shows children with individual stats', async ({ page }) => {
    // Click expander for components directory
    await page.locator('[data-testid="expand-components"]').click()
    
    // Verify children are visible
    await expect(page.locator('text=Button.tsx')).toBeVisible()
    await expect(page.locator('text=Input.tsx')).toBeVisible()
    
    // Verify individual file stats
    await expect(page.locator('text=[+15/-3]')).toBeVisible() // Button.tsx
    await expect(page.locator('text=[+20/-5]')).toBeVisible() // Input.tsx
    
    // Verify directory shows aggregated stats
    await expect(page.locator('text=[+35/-8]')).toBeVisible() // components dir
  })

  test('shows correct icons for different file types', async ({ page }) => {
    await page.locator('[data-testid="expand-components"]').click()
    
    // Check for folder icon on directory
    await expect(page.locator('[data-testid="folder-icon"]')).toBeVisible()
    
    // Check for file icons
    await expect(page.locator('[data-testid="tsx-file-icon"]')).toBeVisible()
  })

  test('opens file in editor when edit button clicked', async ({ page }) => {
    await page.locator('[data-testid="expand-components"]').click()
    
    // Mock editor API call
    let editorCallCount = 0
    await page.route('/api/editor/open', async route => {
      editorCallCount++
      await route.fulfill({ status: 200 })
    })
    
    // Click edit button on Button.tsx
    await page.locator('[data-testid="edit-Button.tsx"]').click()
    
    expect(editorCallCount).toBe(1)
  })

  test('handles new/untracked files correctly', async ({ page }) => {
    await expect(page.locator('text=index.ts')).toBeVisible()
    await expect(page.locator('text=[New]')).toBeVisible()
  })

  test('collapses directory and hides children', async ({ page }) => {
    // Expand then collapse
    await page.locator('[data-testid="expand-components"]').click()
    await expect(page.locator('text=Button.tsx')).toBeVisible()
    
    await page.locator('[data-testid="expand-components"]').click()
    await expect(page.locator('text=Button.tsx')).not.toBeVisible()
  })
})
```

### Test Data Requirements

- **Mixed file types**: .tsx, .ts, .js, .css, .md
- **Various stats combinations**: Added/removed lines, new files, binary files
- **Nested directory structure**: At least 3 levels deep
- **Edge cases**: Empty directories, very long filenames, special characters