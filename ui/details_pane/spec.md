# Details Pane

The details pane is the main pane on the screen.  It shows details for the selected Agent in the Agents Pane.  

It has the following sections

## Info
Show the agent name, project, and session id.  
Show the agent status (active, idle, or needs attention)

## Controls

- Save.  Sends a request to the session to git commit all changes with  a helpful commit message.
- Pause.  Sends the escape key to the session to stop the agent.
- Attach.  Opens a ttymd session
- Quit.  Attempts to terminate the agent.

If the underlying API of the controls, display the appropriate error message to the user.

## Peek
Shows the last 50 lines of the session's output.

## Filelist
Show the filelist widget for the agent's worktree.


## Prompt
show the latest prompt of the agent.

## To do
Show the current todo list of the agent

## Event stats
Show the number and type of each event that has occured for this agent.


# Details Pane API Specification

This document outlines the API endpoints that the Details Pane UI components will interact with.

## Session Management

### Send Keys to Session

Sends a string of text to the session's interactive terminal. This is used for sending commands or other input to the running process.

- **Endpoint:** `POST /api/sessions/{session_id}/send`
- **`session_id`** (string, required): The ID of the session to send keys to.

**Request Body:**

```json
{
  "text": "The text to send to the terminal"
}
```

**Example:**

```http
POST /api/sessions/claude-20240726-120000/send
Content-Type: application/json

{
  "text": "npm install\n"
}
```

### Terminate Session

Terminates a running session. This will kill the associated agent and cleanup any session-specific resources.

- **Endpoint:** `DELETE /api/sessions/{session_id}`
- **`session_id`** (string, required): The ID of the session to terminate.

**Example:**

```http
DELETE /api/sessions/claude-20240726-120000
```

## Worktree Management

### Delete Worktree

Deletes a worktree. This is typically done after the associated session has been terminated.

- **Endpoint:** `DELETE /api/worktrees/{worktree_name}`
- **`worktree_name`** (string, required): The name of the worktree to delete.

**Query Parameters:**

- **`project`** (string, required): The name of the project the worktree belongs to.
- **`force`** (boolean, optional): If `true`, the worktree will be deleted even if it has uncommitted changes. Defaults to `false`.

**Example:**

```http
DELETE /api/worktrees/feature-branch-xyz?project=my-cool-app&force=true
```
