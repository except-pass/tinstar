# Details Pane API Specification

This document outlines the API endpoints that the Details Pane UI components will interact with.

## Session Management

### Get Session Details

Retrieves the full session object, including the initial prompt.

- **Endpoint:** `GET /api/sessions/{session_id}`
- **`session_id`** (string, required): The ID of the session.

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

### Terminate Session

Terminates a running session. This will kill the associated agent and cleanup any session-specific resources.

- **Endpoint:** `DELETE /api/sessions/{session_id}`
- **`session_id`** (string, required): The ID of the session to terminate.

## Terminal Output

### Peek at Terminal

Retrieves the most recent lines of output from the session's terminal.

- **Endpoint:** `GET /api/sessions/{session_id}/peek`
- **`session_id`** (string, required): The ID of the session.

**Query Parameters:**

- **`lines`** (integer, optional): The number of lines to retrieve. Defaults to 50.

## Worktree Management

### Delete Worktree

Deletes a worktree. This is typically done after the associated session has been terminated.

- **Endpoint:** `DELETE /api/worktrees/{worktree_name}`
- **`worktree_name`** (string, required): The name of the worktree to delete.

**Query Parameters:**

- **`project`** (string, required): The name of the project the worktree belongs to.
- **`force`** (boolean, optional): If `true`, the worktree will be deleted even if it has uncommitted changes. Defaults to `false`.

## Todos

### Get Todos

Retrieves a list of "todo" events for a session.

- **Endpoint:** `GET /api/events/todos`

**Query Parameters:**

- **`session_id`** (string, optional): Filter todos by a specific session.
- **`start_time`** (string, optional): ISO 8601 timestamp to filter events after this time.
- **`end_time`** (string, optional): ISO 8601 timestamp to filter events before this time.
- **`tinstar_term_name`** (string, optional): Filter by a specific terminal name.

## Event Stats

There is no dedicated endpoint for event statistics. The frontend should fetch the raw event data from the `GET /api/events` endpoint and compute the stats client-side.

Display the count and type of each event.