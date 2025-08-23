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

- **Unit tests**: Stats formatting, tree traversal
- **Integration tests**: API calls, editor integration
- **Visual tests**: Icon rendering, layout consistency