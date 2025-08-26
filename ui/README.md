# Tinstar UI

A comprehensive UI for managing Claude Code agents and development projects.

## Quick Start

### Launch Master UI
```bash
cd ui
npm run master
```
This opens the full Tinstar interface with both agent pane and project pane.

### Other Launch Options
```bash
# Launch component demos
npm run demo          # Original demo page
npm run agent-pane     # Agent pane standalone test

# Development server
npm run dev            # Start development server

# Testing
npm run test           # Run Playwright tests
npm run test:ui        # Run tests with UI
```

## Master UI Features

The master UI combines all Tinstar components into a unified interface:

- **Agent Pane** (left): View and select active Claude Code agents
  - Grouped by project with color coding
  - Real-time status indicators (Active/Needs attention/Idle)
  - Agent selection for detailed interactions
  
- **Project Pane** (left-center): Manage development projects
  - Project list with file browsing
  - Color-coded project organization
  - Project settings and configuration

- **Main Content Area** (right): Context-sensitive content
  - Agent details when agent selected
  - Project details when project selected  
  - Welcome screen with quick actions

## Components

### Agent Pane (`/agent_pane/`)
- `AgentPane.tsx` - Main component
- `SmallAgentWidget.tsx` - Individual agent display
- `hooks/` - API integration hooks
- `test-page.html` - Standalone testing

### Project Pane (`/project_pane/`)  
- `ProjectPane.tsx` - Project management interface
- Color-coded project organization
- File browsing and settings

### FileTree (`/filelist/`)
- `FileTree.tsx` - Git-aware file tree
- Statistics display and file operations

## API Integration

The UI connects to Tinstar backend APIs:
- `/api/sessions` - Agent/session management
- `/api/projects` - Project management  
- `/api/events` - Real-time event streaming

Mock APIs are included for development and testing.

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Type checking  
npm run typecheck

# Linting
npm run lint

# Run tests
npm run test
```

## File Structure

```
ui/
├── master.html          # Master UI entry point
├── master.tsx           # Master UI React app
├── MasterUI.tsx         # Master UI component
├── MasterUI.css         # Master UI styles
├── agent_pane/          # Agent pane components
├── project_pane/        # Project pane components  
├── filelist/           # FileTree components
├── tests/              # Playwright tests
└── package.json        # Dependencies and scripts
```

## Testing

Comprehensive Playwright tests cover:
- Agent pane functionality and status detection
- Project grouping and color coding
- Real-time updates and WebSocket integration
- Error handling and edge cases

Run tests with:
```bash
npm run test           # Headless
npm run test:ui        # With Playwright UI
npm run test:debug     # Debug mode
```