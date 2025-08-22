# Tinstar Design Document

## Development Cycle

We will follow a strict development cycle:
1. **Design Document**: Design the API first, then design everything against that API
2. **Data Contracts**: Document the data contracts that the API expects
3. **Tests**: Write tests that honor the data models
4. **Implementation**: Develop code to the design document, ensuring it passes tests

## Tests

- Use pytest
- Make the test as true to life as possible.  If the test requires making files or folders, then createa a tmp dir to do so.  
- Make sure the tests start and end cleanly.  No left over cruff.  
- When needed or possible, use the real api in your testing.

## Architecture Layers

The system follows these layers of abstraction:
- **UI** → **Widget** → **Data Model** → **API** → **Backend Loading and Processing** → **Database**

For editor integration, we use a generic editor interface with specific implementations:
- Example: `editor.open_file()` where `editor=Cursor()` makes the command Cursor-specific

## Key Components and Terms

- **workdir**: Same as CTRLTower - the base directory for all Tinstar operations
- **projectdir**: Same as CTRLTower - individual project directories within workdir
- **Configuration**: Maintain config file (Pydantic Settings) and SQLite database files in the workdir
- **Agents**: Operate in worktrees, just like CTRLTower
  - New agents open up new worktrees named after them
  - Name sessions using old west theme instead of aviation theme
  - Track session name, ID, and workdir

## Core Features

### Improved Hooks
- Capture all hooks from Claude Code
- Treat all file changes as first-class citizens (create, edit, multiedit)
- Maintain comprehensive statistics on file operations

### Multi-Project Support
- Support for managing multiple projects simultaneously
- Each project gets its own worktree and session tracking


## Quick Draw: UI Hotkey System

Every command is available by a combination of keys. The keys map directly onto API organization:
- `a` for agent operations
- `p` for project operations
- Any action available via button must also have a hotkey