# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tinstar is a web-based viewer for Claude Code conversation history files. The application provides a UI to browse and view JSONL conversation files from Claude Code projects stored in `~/.claude/projects/`.

## Development Commands

**Start development server:**
```bash
pnpm dev
```
This runs Next.js on port 3400 with Turbopack for fast development.

**Build and type checking:**
```bash
pnpm build      # Next.js standalone build + asset copying
pnpm typecheck  # TypeScript compilation check
```

**Linting and formatting (Biome):**
```bash
pnpm lint       # Run format and lint checks in sequence (biome format + biome check)
pnpm fix        # Auto-fix format and lint issues with unsafe fixes
```

**Testing (Vitest):**
```bash
pnpm test       # Run all tests once
pnpm test:watch # Run tests in watch mode
```

## Architecture Overview

### Technology Stack
- **Frontend**: Next.js 15.5.2 with React 19.1.1, TypeScript (strict mode via @tsconfig/strictest)
- **Backend**: Hono.js 4.9.5 API routes (served via Next.js API routes with Zod validation)
- **Styling**: Tailwind CSS 4.1.12 with shadcn/ui components (Radix UI primitives)
- **Data fetching**: TanStack Query 5.85.5 with Suspense integration
- **State management**: Jotai 2.13.1 atoms for client-side filtering
- **Validation**: Zod 4.1.5 schemas with modular conversation parsing
- **Code formatting**: Biome 2.2.2 (replaces ESLint + Prettier completely)
- **Testing**: Vitest 3.2.4 with global test setup
- **Package manager**: pnpm 10.8.1

### Key Architecture Patterns

**Monorepo Structure**: Single Next.js app with integrated backend API

**API Layer**: Hono.js app mounted at `/api` with type-safe routes:
- `/api/projects` - List all Claude projects
- `/api/projects/:projectId` - Get project details and sessions
- `/api/projects/:projectId/sessions/:sessionId` - Get session conversations
- `/api/projects/:projectId/new-session` - Start new session with task
- `/api/projects/:projectId/sessions/:sessionId/resume` - Resume session with task
- `/api/tasks/alive` - Monitor live tasks
- `/api/events/state_changes` - Server-Sent Events for real-time file monitoring

**Data Flow**:
1. Backend reads JSONL files from `~/.claude/projects/`
2. Parses and validates conversation entries with Zod schemas
3. Frontend fetches via type-safe API client with TanStack Query
4. Real-time updates via Server-Sent Events for file system changes

**Type Safety**: 
- Zod schemas for conversation data validation (`src/lib/conversation-schema/`)
- Type-safe API client with Hono and Zod validation
- Strict TypeScript configuration extending `@tsconfig/strictest`

### Core Concepts: Projects, Sessions, and Tasks

**Projects** (`src/server/service/types.ts:4-15`):
- Represent Claude Code projects stored in `~/.claude/projects/`
- Each project has an ID (encoded path), name, and project path on disk
- Contains metadata like last modified date and session count

**Sessions** (`src/server/service/types.ts:17-29`):
- JSONL files within a project folder containing conversation history
- Each session represents a single conversation thread with Claude
- Has metadata including message count, first command, and last modified date
- Can be associated with git worktrees for isolated development branches

**Tasks** (`src/server/service/claude-code/`):
- Live interaction instances with Claude Code CLI via `@anthropic-ai/claude-code` package
- Managed by `ClaudeCodeTaskController` (`ClaudeCodeTaskController.ts`)
- States: `pending` → `running` ↔ `paused` → `completed/failed`
- Can start new sessions or resume existing ones
- Each task tracks its session ID, user message ID, and working directory

**Relationships**:
- **Project → Sessions**: A project contains multiple session files (1-to-many)
- **Session → Task**: Tasks execute Claude commands within a session context
- **Task → Session**: Tasks can create new sessions or continue existing ones

Tasks enable real-time interaction with Claude Code, while projects and sessions provide the persistent storage and organization of conversation history.

### Projects vs Repositories

**A Project is Claude Code's workspace for a git repository**:
- Each git repository worked on with Claude Code gets a corresponding project folder in `~/.claude/projects/`
- The project ID is an encoded version of the repository path (e.g., `/home/ubuntu/repo/tinstar` → `-home-ubuntu-repo-tinstar`)
- The `projectPath` property points to the actual git repository directory on disk
- One repository maps to one Claude project (1:1 relationship)

**Git Integration**:
- Projects extract repository paths from session JSONL files (stored as `cwd` in conversations)
- Git operations (branches, commits, diffs) are performed on the repository via `projectPath`
- Projects can spawn git worktrees for isolated development (`src/server/service/worktree/management.ts`)
- Sessions can be tied to specific worktrees, enabling parallel development on different branches
- Each conversation/session records its working directory, typically the repository root or a worktree path

### File Structure Patterns

**Conversation Schema** (`src/lib/conversation-schema/`):
- Modular Zod schemas for different conversation entry types
- Union types for flexible conversation parsing
- Separate schemas for content types, tools, and message formats

**Server Services** (`src/server/service/`):
- Project operations: `getProjects`, `getProject`, `getProjectMeta`
- Session operations: `getSessions`, `getSession`, `getSessionMeta` 
- Parsing utilities: `parseJsonl`, `parseCommandXml`
- File monitoring: `FileWatcherService` for real-time updates

**Frontend Structure**:
- Page components in app router structure
- Reusable UI components in `src/components/ui/`
- Custom hooks for data fetching (`useProject`, `useConversations`)
- Conversation display components in nested folders

### Data Sources

The application reads Claude Code history from:
- **Primary location**: `~/.claude/projects/` (defined in `src/server/service/paths.ts`)
- **File format**: JSONL files containing conversation entries
- **Structure**: Project folders containing session JSONL files
- **Real-time monitoring**: Watches for file changes and updates UI automatically

### Key Components

**Conversation Parsing**: 
- JSONL parser validates each line against conversation schema
- Handles different entry types: User, Assistant, Summary, System
- Supports various content types: Text, Tool Use, Tool Result, Thinking

**Command Detection**:
- Parses XML-like command structures in conversation content
- Extracts command names and arguments for better display
- Handles different command formats (slash commands, local commands)

### Key Features

**Real-time Updates**:
- FileWatcherService singleton monitors `~/.claude/projects/` using Node.js `fs.watch()`
- Server-Sent Events via Hono's `streamSSE()` for live UI updates  
- Event types: `connected`, `project_changed`, `session_changed`, `heartbeat`
- Automatic TanStack Query cache invalidation when conversation files are modified
- Heartbeat mechanism (30s intervals) for connection health monitoring
- Proper cleanup and abort handling on client disconnection

**CLI Installation**:
- Can be installed via `PORT=3400 npx tinstar@latest`
- Published as `tinstar` on npm
- Standalone Next.js build with embedded dependencies
- Binary entry point at `dist/index.js`

### Development Notes

- Biome handles both linting and formatting (no ESLint/Prettier)
- Vitest for testing with global test setup
- TanStack Query for server state management with error boundaries
- Jotai atoms for client-side state (filtering, UI state)
- React 19 with Suspense boundaries for progressive loading