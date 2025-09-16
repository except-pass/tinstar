# Claude Code Viewer

A full-featured web-based Claude Code client that provides complete interactive functionality for managing Claude Code projects. Start new conversations, resume existing sessions, monitor running tasks in real-time, and browse your conversation history - all through a modern web interface.

![demo](./docs/assets/claude-code-viewer-demo-min.gif)

## Overview

Claude Code Viewer has evolved from a simple conversation viewer into a comprehensive web-based Claude Code client. It provides all essential Claude Code functionality through an intuitive web interface, including creating new sessions, resuming conversations, real-time task management, and live synchronization with your local Claude Code projects.

The application leverages Server-Sent Events (SSE) for real-time bidirectional communication, automatically syncing with JSONL conversation files in `~/.claude/projects/` and providing instant updates as conversations progress.

## Features

### Interactive Claude Code Client

- **New Chat Creation** - Start new Claude sessions directly from the web interface
- **Session Resumption** - Continue paused Claude conversations with full context
- **Real-time Task Management** - Monitor, control, and abort running Claude tasks
- **Command Autocompletion** - Smart completion for both global and project-specific Claude commands
- **Live Status Indicators** - Visual feedback for running, paused, and completed tasks

### Real-time Synchronization

- **Server-Sent Events (SSE)** - Instant bidirectional communication and updates
- **File System Monitoring** - Automatic detection of conversation file changes
- **Live Task Updates** - Real-time progress tracking for active Claude sessions
- **Auto-refresh UI** - Instant updates when conversations are modified externally

### Advanced Conversation Management

- **Project Browser** - View all Claude Code projects with metadata and session counts
- **Smart Session Filtering** - Hide empty sessions, unify duplicates, filter by status
- **Multi-tab Interface** - Sessions, Tasks, and Settings in an organized sidebar
- **Conversation Display** - Human-readable format with syntax highlighting and tool usage
- **Command Detection** - Enhanced display of XML-like command structures
- **Task Controller** - Full lifecycle management of Claude processes

## Installation

Clone and run locally:

```bash
cd claude-code-viewer
pnpm i
pnpm build
pnpm start
```
or `pnpm dev`

## Data Source

The application reads Claude Code conversation files from:

- **Location**: `~/.claude/projects/<project>/<session-id>.jsonl`
- **Format**: JSONL files containing conversation entries
- **Auto-detection**: Automatically discovers new projects and sessions

## Usage Guide

### 1. Project List

- Browse all Claude Code projects
- View project metadata (name, path, session count, last modified)
- Click any project to view its sessions

### 2. Session Browser  

- View all conversation sessions within a project
- Filter to hide empty sessions
- Sessions show message counts and timestamps
- Click to view detailed conversation

### 3. Conversation Viewer

- Full conversation history with proper formatting
- Syntax highlighting for code blocks
- Tool usage and results clearly displayed
- Navigation sidebar for jumping between sessions
- Support for different message types (user, assistant, system, tools)

## Configuration

### Port Configuration

Set a custom port using the `PORT` environment variable:

```bash
PORT=8080 pnpm dev
```

### Data Directory

The application automatically detects the standard Claude Code directory at `~/.claude/projects/`. No additional configuration is required.


## Contributing

This is a fork of a cool project.  You should contribute to the original. https://github.com/d-kimuson/claude-code-viewer
