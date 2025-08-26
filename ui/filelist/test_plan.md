# FileTree Test Plan

## Setup
1. Start the docker integration test container
2. Run the docker test setup

## Test Scenarios

### Project Pane Visibility
- Project pane should be visible on the left
- Agent pane should be visible

### Project Management
- Add a new project

### FileTree Functionality
Evaluate the Project Pane:

- Expanding a directory should show the files in the directory properly indented
- Files should have a file icon and edit icon
- Expanding a directory should show the subdirs properly indented
- After expanding a directory, the directory should still be visible but with expander

### File Editing
- Add and remove lines from a file
- The edited file should be properly tracked


### Resizing
The Project pane shoudl be resizable horizontally by click dragging the right edge of the project pane.  When you resize the project pane, the scroll bar should always be visible.
The Project pane should be resizable vertically by click dragging the bottom edge of the project pane.  When you resize the project pane to make it vertically taller, more files should be visible.


### Agent Pane
The agent pane should be resizable horizontally.  When you resize the agent panel, the scroll bar should always be visible.
