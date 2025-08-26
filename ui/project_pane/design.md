# Project Pane Design Document

## Overview

The Project Pane is a vertical UI component that manages multiple open projects in Tinstar. It displays a list of Project Widgets, each representing an active project with its file tree and controls.

## API Dependencies

### Projects API
- **GET /api/projects** - List all open projects
- **POST /api/projects** - Create new project from directory path
- **PUT /api/projects/{name}** - Update project settings (unignore_paths)
- **DELETE /api/projects/{name}** - Close/remove project
- **GET /api/projects/{name}** - Get specific project details

### Filelist API (via Project Widget)
- **GET /filelist/{project}/tree** - Get file tree for project

### Editor API (via FileTree component)
- **POST /api/editor/open** - Open file in configured editor

## Data Contracts

### Project Model
```typescript
interface Project {
  name: string;              // Unique project name (slug-safe)
  path: string;              // Absolute path to project directory
  created_at: string;        // ISO 8601 timestamp
  default_branch?: string;   // Default git branch
  unignore_paths: string[];  // Relative paths to copy to worktrees
}
```

### API Response Format
```typescript
interface ProjectResponse {
  success: boolean;
  message?: string;
  project?: Project;
  projects?: Project[];
}
```

## Visual Design

```
┌─ Project Pane ──────────────┐
│                             │
│ ┌─ Project Widget 1 ──────┐ │
│ │ [my-app] [↻] [⚙] [✕]   │ │  ← Desert Sand (#C6A77B)
│ │ ┌─ FileTree ───────────┐ │ │
│ │ │ 📁 src/             │ │ │
│ │ │ ├─ 📄 App.tsx    ✏️ │ │ │
│ │ │ └─ 📄 index.ts   ✏️ │ │ │
│ │ └─────────────────────┘ │ │
│ └─────────────────────────┘ │
│                             │
│ ┌─ Project Widget 2 ──────┐ │
│ │ [api-server] [↻] [⚙] [✕]│ │  ← Saddle Brown (#8B5A2B)
│ │ ┌─ FileTree ───────────┐ │ │
│ │ │ 📁 routes/          │ │ │
│ │ │ └─ 📄 main.py    ✏️ │ │ │
│ │ └─────────────────────┘ │ │
│ └─────────────────────────┘ │
│                             │
│ [ + New Project ]           │
│                             │
└─────────────────────────────┘
```

## Component Architecture

### ProjectPane (Root Component)
- Fetches and manages list of open projects
- Handles project lifecycle (create, close)
- Assigns colors to projects from palette
- Renders ProjectWidget for each project

### ProjectWidget (Per-Project Component)
- Displays project header with name and controls (refresh, settings, close)
- Embeds FileTree component for file navigation
- Handles refresh, settings dialog, and close actions
- Applies project-specific color theme

### FileTree (Reusable Component)
- Displays hierarchical file structure
- Integrates with filelist API
- Provides file editing controls
- **Note**: No git stats in Project Pane context (different from standalone FileTree)

## Color Palette Integration

Projects are assigned colors cyclically from the Western theme palette:

1. **Desert Sand** (#C6A77B)
2. **Saddle Brown** (#8B5A2B) 
3. **Rust Red** (#A04020)
4. **Gunmetal Gray** (#4B4B4B)
5. **Prairie Gold** (#D4AF37)
6. **Cactus Green** (#556B2F)
7. **Dusty Sky** (#9AB6C3)
8. **Charred Wood** (#2E1B0F)

## State Management

### ProjectPane State
```typescript
interface ProjectPaneState {
  projects: Project[];         // List of open projects
  loading: boolean;            // API loading state
  error: string | null;        // Error message display
}
```

### ProjectWidget State
```typescript
interface ProjectWidgetState {
  refreshing: boolean;         // FileTree refresh state
  closing: boolean;            // Project close state
  showingSettings: boolean;    // Settings dialog visibility
  updatingSettings: boolean;   // Settings save state
}
```

### ProjectSettingsDialog State
```typescript
interface ProjectSettingsState {
  unignorePaths: string;       // Multiline text content (joined from project.unignore_paths array)
  originalPaths: string[];     // Original unignore_paths for cancel/reset
  saving: boolean;             // Save operation state
  error: string | null;        // Validation or save errors
}

// Helper functions for path handling
const pathsToText = (paths: string[]): string => paths.join('\n');
const textToPaths = (text: string): string[] => 
  text.split('\n').map(path => path.trim()).filter(path => path.length > 0);
```

## User Interactions

### New Project Flow
1. Click "New Project" button
2. Browser directory picker opens
3. User selects directory
4. POST to /api/projects with selected path
5. Handle API response:
   - Success: Refresh project list
   - Error: Display validation message from API

### Close Project Flow
1. Click "✕" button on project widget
2. DELETE /api/projects/{name}
3. Remove from local state
4. Handle errors gracefully

### Refresh Project Flow
1. Click "↻" button on project widget
2. FileTree component refetches its data
3. Visual loading indicator during refresh

### Project Settings Flow
1. Click "⚙" gear button on project widget
2. Open modal dialog with current project settings
3. Prepopulate textarea with current unignore_paths (one per line from project.unignore_paths array)
4. User edits paths in multiline text area (all paths relative to project root)
5. Click Save: 
   - Split textarea content by newlines
   - Trim whitespace from each path
   - PUT /api/projects/{name} with updated unignore_paths array
6. Handle API response:
   - Success: Close dialog, optionally refresh FileTree
   - Error: Display validation errors inline
7. Click Cancel: Close dialog without saving, discard changes

## Error Handling

### API Error Display
- Non-intrusive error banner at top of pane
- Dismissible with "✕" button
- Auto-dismiss after successful operation

### Directory Selection Errors
- Invalid directory: Show API validation message
- Non-git repository: Show helpful guidance
- Permission issues: Clear error description

### Settings Validation Errors
- Invalid path formats: Display field-level validation
- Path traversal attempts: Show security error message
- Network/save errors: Retry option with error details

### Network Errors
- Connection timeout: Retry suggestion
- Server errors: Contact administrator message

## File Structure

```
ui/project_pane/
├── design.md                 # This document
├── spec.md                   # Original requirements
├── ProjectPane.tsx           # Root component
├── ProjectWidget.tsx         # Individual project widget
├── ProjectSettingsDialog.tsx # Settings modal component
├── ProjectPane.css           # Styling with color themes
├── types.ts                  # TypeScript interfaces
├── hooks/
│   ├── useProjects.ts        # Projects API integration
│   └── useProjectColors.ts   # Color palette management
└── __tests__/
    ├── ProjectPane.spec.ts   # Component tests
    ├── ProjectSettings.spec.ts # Settings dialog tests
    └── integration.spec.ts   # E2E workflow tests
```

## Testing Strategy

### Unit Tests (Jest/React Testing Library)
- ProjectPane component rendering
- Project creation/deletion logic
- Settings dialog open/close logic
- Error state handling
- Color assignment logic
- Unignore paths validation and formatting

### E2E Tests (Playwright)
- Full project management workflow
- Directory picker integration
- Project settings dialog interactions
- Unignore paths editing and validation
- FileTree interaction within project context
- Error message display and dismissal

### Test Data Requirements
- Mock project list with various states
- Directory selection simulation
- API response mocking (success/error cases)
- Color palette validation

## Performance Considerations

- **Debounced API calls**: Prevent rapid refresh requests
- **Optimistic updates**: Update UI before API confirmation
- **Memoized components**: Avoid unnecessary re-renders
- **Virtual scrolling**: For large project lists (future consideration)

## Accessibility

- **Keyboard navigation**: Tab through projects and controls
- **Screen reader support**: ARIA labels for all interactive elements
- **Focus management**: Clear visual focus indicators
- **Color accessibility**: Sufficient contrast ratios for all palette colors

## Integration Points

### With FileTree Component
- **Props**: `projectName`, `showStats: false`, `onFileOpen`
- **API**: FileTree handles its own data fetching
- **Styling**: Inherits project color theme

### With Projects API
- **Authentication**: Uses existing session/auth
- **Error formats**: Consistent with API error structure
- **Validation**: Leverages server-side path validation

### With Editor Integration
- **File opening**: Delegates to FileTree component
- **Editor selection**: Uses system default editor configuration