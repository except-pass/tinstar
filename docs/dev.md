# Developer Documentation

This document provides technical details for developers contributing to Claude Code Viewer.

## Architecture Overview

### Tech Stack

- **Frontend**: Next.js 15.5.2 with React 19.1.1, TypeScript with @tsconfig/strictest
- **Backend**: Hono.js 4.9.5 API routes mounted via Next.js API routes with Zod validation
- **Styling**: Tailwind CSS 4.1.12 with Radix UI components (shadcn/ui pattern), Geist fonts
- **State Management**: TanStack Query 5.85.5 + Jotai 2.13.1 atoms with localStorage persistence
- **Code Quality**: Biome 2.2.2 (replaces ESLint + Prettier completely) with double quotes, 2-space indentation
- **Testing**: Vitest 3.2.4 with global test setup and watch mode
- **Validation**: Zod 4.1.5 schemas throughout the stack with modular conversation parsing
- **Real-time**: Server-Sent Events with FileWatcherService singleton and heartbeat mechanism
- **Package Manager**: pnpm 10.8.1 with npm-run-all2 for parallel script execution

### Project Structure

```text
src/
├── app/                           # Next.js 15 app router
│   ├── api/[[...route]]/         # Hono API mounted via Next.js
│   ├── components/               # App-level components
│   │   ├── ServerEventsProvider.tsx  # SSE connection management
│   │   └── RootErrorBoundary.tsx     # Global error handling
│   ├── projects/                 # Project routes
│   │   ├── [projectId]/         # Dynamic project routes
│   │   │   ├── components/      # Project-specific components
│   │   │   ├── hooks/           # Project data fetching hooks
│   │   │   ├── services/        # Client-side business logic
│   │   │   ├── sessions/        # Session management
│   │   │   │   └── [sessionId]/ # Individual session pages
│   │   │   │       ├── components/ # Session UI components
│   │   │   │       └── hooks/   # Session-specific hooks
│   │   │   └── store/           # Jotai atoms for filtering
│   │   └── components/          # Project list components
│   └── layout.tsx               # Root layout with providers
├── server/                      # Backend implementation
│   ├── hono/                    # Hono.js configuration
│   │   ├── app.ts              # Hono app setup
│   │   └── route.ts            # Route definitions
│   └── service/                 # Core business logic
│       ├── events/              # Real-time event system
│       │   ├── fileWatcher.ts  # File system monitoring
│       │   ├── sseEvent.ts     # SSE event formatting
│       │   └── types.ts        # Event type definitions
│       ├── project/            # Project operations
│       ├── session/            # Session operations
│       ├── parseJsonl.ts       # JSONL parsing logic
│       ├── parseCommandXml.ts  # Command detection
│       └── paths.ts            # File system paths
├── lib/
│   ├── conversation-schema/     # Modular Zod schemas
│   │   ├── content/            # Content type schemas
│   │   ├── entry/              # Entry type schemas
│   │   ├── message/            # Message schemas
│   │   └── tool/               # Tool-specific schemas
│   ├── api/                    # Type-safe API client
│   │   ├── client.ts           # Hono client setup
│   │   └── queryClient.ts      # TanStack Query config
│   ├── sse/                    # SSE client utilities
│   └── utils.ts                # Shared utilities
└── components/
    └── ui/                     # Reusable shadcn/ui components
```

## Development Setup

### Prerequisites

- Node.js 18 or later
- pnpm (recommended package manager)
- Claude Code with sample conversation data in `~/.claude/projects/`

### Installation

```bash
git clone https://github.com/d-kimuson/claude-code-viewer.git
cd claude-code-viewer
pnpm install
```

### Development Commands

```bash
# Start development server (port 3400 with Turbopack)
pnpm dev        # Runs multiple dev processes in parallel

# Type checking
pnpm typecheck  # TypeScript compilation check

# Code Quality (Biome)
pnpm lint       # Run format and lint checks in sequence
pnpm fix        # Auto-fix format and lint issues (includes unsafe fixes)

# Testing (Vitest)
pnpm test       # Run all tests once
pnpm test:watch # Run tests in watch mode
```

### Build Process

```bash
pnpm build      # Next.js standalone build + asset copying
```

The build process:
1. Creates standalone Next.js build in `.next/standalone/`
2. Copies `public/` assets to standalone directory
3. Copies static assets (`.next/static`) to standalone directory
4. Results in a fully self-contained application

## API Architecture

### Hono.js Integration

The backend uses Hono.js mounted via Next.js API routes with a catch-all route at `/api/[[...route]]/route.ts`. This provides:

- **Type-safe API**: Full TypeScript inference from server to client
- **Zod validation**: Request/response validation throughout the stack
- **Performance**: Lightweight runtime with minimal overhead
- **Streaming**: Native SSE support for real-time features

### API Endpoints

- `GET /api/projects` - List all projects with metadata
- `GET /api/projects/:projectId` - Get project details and sessions
- `GET /api/projects/:projectId/sessions/:sessionId` - Get conversation data
- `GET /api/events/state_changes` - Server-Sent Events for real-time updates

### Data Flow Architecture

```text
File System → Services → Hono Routes → Next.js API → TanStack Query → React Components
     ↓              ↓           ↓             ↓              ↓              ↓
~/.claude/     parseJsonl  route.ts    [[...route]]   useProject    ProjectList
projects/      +schemas    +streaming   /route.ts      +hooks        +components
```

1. **File System Reading**: Services read JSONL files from `~/.claude/projects/`
2. **Schema Validation**: Each line validated against modular Zod conversation schemas
3. **API Layer**: Hono.js routes provide type-safe endpoints with streaming support
4. **Client Integration**: TanStack Query manages server state with error boundaries
5. **Real-time Updates**: File watcher emits SSE events, automatically updating UI

### Backend Services

#### Project Services (`src/server/service/project/`)

- **`getProjects()`** - Scans project directories, returns sorted metadata
- **`getProject(projectId)`** - Fetches project details and session list
- **`getProjectMeta(projectId)`** - Fast metadata extraction

#### Session Services (`src/server/service/session/`)

- **`getSessions(projectId)`** - List sessions for a project
- **`getSession(projectId, sessionId)`** - Parse JSONL conversation files
- **`getSessionMeta(projectId, sessionId)`** - Extract session metadata

#### Event System (`src/server/service/events/`)

- **`fileWatcher.ts`** - FileWatcherService singleton class using Node.js `fs.watch()`
- **`sseEvent.ts`** - Event formatting utilities for SSE
- **`types.ts`** - Event type definitions

**File Watching Features:**
- Monitors `~/.claude/projects/` recursively with singleton pattern
- Event types: `connected`, `project_changed`, `session_changed`, `heartbeat`
- Heartbeat mechanism (30s intervals) for connection health monitoring
- Automatic cleanup on client disconnection with proper abort handling
- Uses Hono's `streamSSE()` for efficient server-sent event streaming

## Data Validation

### Conversation Schema (`src/lib/conversation-schema/`)

The schema system uses a modular Zod architecture for type-safe conversation parsing:

#### Schema Organization

```text
conversation-schema/
├── index.ts              # Main union schema
├── content/              # Content type schemas
│   ├── TextContentSchema.ts
│   ├── ToolUseContentSchema.ts
│   ├── ToolResultContentSchema.ts
│   ├── ThinkingContentSchema.ts
│   └── ImageContentSchema.ts
├── entry/                # Entry type schemas
│   ├── BaseEntrySchema.ts
│   ├── UserEntrySchema.ts
│   ├── AssistantEntrySchema.ts
│   ├── SystemEntrySchema.ts
│   └── SummaryEntrySchema.ts
├── message/              # Message schemas
│   ├── UserMessageSchema.ts
│   └── AssistantMessageSchema.ts
└── tool/                 # Tool-specific schemas
    ├── CommonToolSchema.ts
    ├── StructuredPatchSchema.ts
    └── TodoSchema.ts
```

#### Key Features

- **Union Types**: `ConversationSchema` combines all entry types
- **Incremental Parsing**: Graceful handling of malformed JSONL lines
- **Content Validation**: Strict typing for different content formats
- **Tool Support**: Dedicated schemas for Claude Code tools
- **Type Safety**: Full TypeScript inference throughout the stack

### Command Detection

Advanced XML-like command parsing for enhanced conversation display:

```typescript
// src/server/service/parseCommandXml.ts
parseCommandXml(content: string) // Extracts command names and arguments
```

Supports various command formats:
- Slash commands (`/save`, `/edit`)
- Local commands with arguments
- Structured command detection for better UX

## Frontend Architecture

### Component Hierarchy

```text
RootLayout (providers, error boundaries, SSE)
├── ServerEventsProvider (SSE connection management)
├── QueryClientProviderWrapper (TanStack Query setup)
├── RootErrorBoundary (global error handling)
└── Pages
    ├── ProjectList (grid of project cards)
    └── ProjectDetail ([projectId])
        ├── ProjectPage (project overview)
        ├── SessionList (filterable session grid)
        └── SessionDetail ([sessionId])
            ├── SessionPageContent (main layout)
            ├── SessionSidebar (conversation navigation)
            ├── ConversationList (message display)
            ├── ConversationItem (individual messages)
            └── SidechainConversationModal (popup details)
```

### State Management Architecture

#### Server State (TanStack Query)
- **`useProjects`** - Project listing with caching
- **`useProject`** - Individual project details and sessions
- **`useSession`** - Conversation data fetching
- **Suspense Integration**: Progressive loading with error boundaries
- **Cache Management**: Automatic invalidation on SSE events

#### Client State (Jotai Atoms)
```text
src/app/projects/[projectId]/store/filterAtoms.ts
├── sessionFilterAtom     # Session filtering state
├── searchTermAtom        # Search input state
└── sortOrderAtom         # Session sorting preference
```

#### Real-time State (Server-Sent Events)
- **`useServerEvents`** - SSE connection hook
- **Auto-reconnection**: Handles connection drops gracefully
- **Event Processing**: `project_changed`, `session_changed`, heartbeat
- **Query Invalidation**: Automatic cache refresh on file changes

### Type Safety System

- **API Types**: Full inference from Hono route definitions to React components
- **Schema Validation**: Runtime and compile-time type checking with Zod
- **Build Configuration**: `@tsconfig/strictest` for maximum type safety
- **Error Boundaries**: Typed error handling throughout the component tree

### Hook Patterns

#### Data Fetching Hooks
```typescript
// Custom hooks following consistent patterns
useProjects()           // → { data, isLoading, error }
useProject(projectId)   // → { project, sessions, isLoading }
useSession(projectId, sessionId) // → { session, conversations, isLoading }
```

#### Real-time Hooks
```typescript
useServerEvents()       // → SSE connection management
useSidechain()         // → Modal state management
```

## Code Conventions

### File Organization Patterns

- **Services**: Business logic organized by domain (`project/`, `session/`, `events/`)
- **Components**: Co-located with hooks, stores, and services in feature directories
- **Schemas**: Modular Zod schemas with clear separation of concerns
- **Hooks**: Custom hooks grouped by functionality and data dependency
- **Types**: TypeScript types inferred from Zod schemas where possible

### Naming Conventions

- **Files**: `camelCase.ts` for most files, `PascalCase.tsx` for React components
- **Components**: `PascalCase` (e.g., `SessionPageContent.tsx`)
- **Functions**: `camelCase` (e.g., `getProject`, `parseJsonl`)
- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `PROJECTS_BASE_PATH`)
- **Hooks**: `use` prefix (e.g., `useProject`, `useServerEvents`)
- **Atoms**: Suffix with `Atom` (e.g., `sessionFilterAtom`)

### Code Style (Biome Configuration)

**Biome replaces both ESLint and Prettier** with a single, fast tool:

```json
{
  "formatter": {
    "enabled": true,
    "indentStyle": "space"    // 2-space indentation
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double"  // Double quotes for strings
    }
  },
  "assist": {
    "actions": {
      "source": {
        "organizeImports": "on" // Auto-organize imports
      }
    }
  }
}
```

**Key Style Rules:**
- Double quotes for strings
- 2-space indentation
- Automatic import organization
- Biome recommended linting rules
- TypeScript strict mode via `@tsconfig/strictest`

### Development Workflow Integration

```bash
# Format and lint check
pnpm lint

# Auto-fix all issues (including unsafe fixes)
pnpm fix

# Type checking
pnpm typecheck
```

## Testing Strategy

### Test Structure

- **Unit Tests**: Individual functions and components
- **Integration Tests**: API routes and data flow
- **Setup**: Vitest with global test configuration

### Test Commands

```bash
pnpm test       # Run all tests once
pnpm test:watch # Watch mode for development
```

## Performance Considerations

### Optimization Strategies

- **Static Generation**: Pre-built project metadata
- **Suspense Boundaries**: Progressive loading of conversation data  
- **File Watching**: Efficient recursive directory monitoring
- **Memory Management**: Streaming JSONL parsing for large files

### Bundle Analysis

The app uses Next.js with Turbopack for fast development builds and optimized production bundles.

## Contributing Guidelines

### Pull Request Process

1. **Fork** the repository and create a feature branch
2. **Implement** changes following existing code conventions
3. **Test** your changes with `pnpm test`
4. **Lint** code with `pnpm fix`
5. **Type check** with `pnpm typecheck`
6. **Submit** PR with clear description and test coverage

### Code Review Criteria

- Type safety and error handling
- Performance impact on large conversation files
- UI/UX consistency with existing design
- Test coverage for new functionality
- Documentation updates for API changes

### Development Tips

- **Hot Reload**: Use `pnpm dev` for fast development iteration
- **Debug Mode**: Enable verbose logging in file watcher service
- **Mock Data**: Create sample JSONL files for testing edge cases
- **Browser DevTools**: React Query DevTools available in development

## Deployment

### Build Artifacts

- **Standalone**: Self-contained application in `.next/standalone/`
- **Static Assets**: Copied to standalone directory during build
- **Entry Point**: `dist/index.js` for CLI usage

### Environment Variables

- **PORT**: Server port (default: 3400)
- **NODE_ENV**: Environment mode (development/production)

The application is designed to be deployed as a standalone executable that can be installed via npm/npx.
