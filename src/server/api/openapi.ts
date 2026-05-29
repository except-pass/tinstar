/** OpenAPI 3.0 specification for the Tinstar API */
export const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Tinstar API',
    version: '3.1.0',
    description: 'Session orchestration, taxonomy management, and observability for Claude Code agents.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'State', description: 'Full document-store snapshot and SSE stream' },
    { name: 'Spaces', description: 'Workspace isolation' },
    { name: 'Initiatives', description: 'Top-level taxonomy nodes' },
    { name: 'Epics', description: 'Mid-level taxonomy nodes' },
    { name: 'Tasks', description: 'Leaf-level taxonomy nodes' },
    { name: 'Worktrees', description: 'Git worktree tracking' },
    { name: 'Runs', description: 'Agent run instances' },
    { name: 'Sessions', description: 'Tmux session lifecycle' },
    { name: 'Hooks', description: 'Callbacks from Claude Code inside sessions' },
    { name: 'Projects', description: 'Registered project directories' },
    { name: 'Config', description: 'User configuration' },
    { name: 'Editor', description: 'Open files in external editor' },
    { name: 'Observability', description: 'OpenTelemetry spans and metrics' },
    { name: 'Widgets', description: 'Canvas widgets — browser, file editor, image' },
    { name: 'Simulator', description: 'Mock data generator (dev/test only)' },
  ],
  paths: {
    // ── State ────────────────────────────────────────────
    '/api/state': {
      get: {
        tags: ['State'],
        summary: 'Full document-store snapshot',
        responses: {
          200: { description: 'Current state', content: { 'application/json': { schema: { $ref: '#/components/schemas/State' } } } },
        },
      },
    },
    '/api/events': {
      get: {
        tags: ['State'],
        summary: 'Server-Sent Events stream',
        description: 'Real-time updates for all state changes. Sends an initial snapshot followed by delta events.',
        responses: {
          200: { description: 'SSE stream', content: { 'text/event-stream': {} } },
        },
      },
    },

    // ── Spaces ───────────────────────────────────────────
    '/api/spaces': {
      get: {
        tags: ['Spaces'],
        summary: 'List all spaces',
        responses: { 200: { description: 'Space list', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/Space' } } } } } } } },
      },
      post: {
        tags: ['Spaces'],
        summary: 'Create a space',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created' } },
      },
    },
    '/api/spaces/{id}': {
      patch: {
        tags: ['Spaces'],
        summary: 'Update a space',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Updated' } },
      },
      delete: {
        tags: ['Spaces'],
        summary: 'Delete a space',
        description: 'Cannot delete the last or currently active space.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' }, 400: { description: 'Cannot delete last/active space' } },
      },
    },
    '/api/spaces/{id}/activate': {
      post: {
        tags: ['Spaces'],
        summary: 'Set active space',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Activated' } },
      },
    },

    // ── Initiatives ──────────────────────────────────────
    '/api/initiatives': {
      post: {
        tags: ['Initiatives'],
        summary: 'Create an initiative',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' }, status: { type: 'string', enum: ['active', 'paused', 'archived'] }, summary: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Initiative' } } } } },
      },
    },
    '/api/initiatives/{id}': {
      patch: {
        tags: ['Initiatives'],
        summary: 'Update an initiative',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' }, settings: { $ref: '#/components/schemas/EntitySettings' } } } } } },
        responses: { 200: { description: 'Updated' } },
      },
      delete: {
        tags: ['Initiatives'],
        summary: 'Delete an initiative',
        description: 'Children are orphaned, not deleted.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' } },
      },
    },
    '/api/initiatives/{id}/settings': {
      get: {
        tags: ['Initiatives'],
        summary: 'Resolved settings (with inheritance)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Resolved settings showing inherited vs local values' } },
      },
    },

    // ── Epics ────────────────────────────────────────────
    '/api/epics': {
      post: {
        tags: ['Epics'],
        summary: 'Create an epic',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, initiativeId: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created' } },
      },
    },
    '/api/epics/{id}': {
      patch: {
        tags: ['Epics'],
        summary: 'Update an epic',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, initiativeId: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' }, settings: { $ref: '#/components/schemas/EntitySettings' } } } } } },
        responses: { 200: { description: 'Updated' } },
      },
      delete: {
        tags: ['Epics'],
        summary: 'Delete an epic',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' } },
      },
    },
    '/api/epics/{id}/settings': {
      get: {
        tags: ['Epics'],
        summary: 'Resolved settings (with inheritance)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Resolved settings' } },
      },
    },

    // ── Tasks ────────────────────────────────────────────
    '/api/tasks': {
      post: {
        tags: ['Tasks'],
        summary: 'Create a task',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, epicId: { type: 'string' }, initiativeId: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created' } },
      },
    },
    '/api/tasks/{id}': {
      patch: {
        tags: ['Tasks'],
        summary: 'Update a task',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, epicId: { type: 'string' }, initiativeId: { type: 'string' }, status: { type: 'string' }, summary: { type: 'string' }, settings: { $ref: '#/components/schemas/EntitySettings' } } } } } },
        responses: { 200: { description: 'Updated' } },
      },
      delete: {
        tags: ['Tasks'],
        summary: 'Delete a task',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' } },
      },
    },
    '/api/tasks/{id}/settings': {
      get: {
        tags: ['Tasks'],
        summary: 'Resolved settings (with inheritance)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Resolved settings' } },
      },
    },
    '/api/tasks/{taskId}/sessions': {
      post: {
        tags: ['Tasks', 'Sessions'],
        summary: 'Create a session in a task with auto-resolved settings',
        description: 'One-call session creation in task context. Auto-resolves project from the task hierarchy (Task → Epic → Initiative, closest wins) and fills in epicId/initiativeId from the task. Defaults: backend=tmux, nats enabled. Any field in the body overrides resolved/default values.',
        parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', description: 'Session name (unique identifier)' },
              cliTemplate: { type: 'string' },
              prompt: { type: 'string', description: 'Initial message to send to the agent' },
              project: { type: 'string', description: 'Override the resolved project' },
              color: { type: 'string' },
              nats: { type: 'object', properties: { enabled: { type: 'boolean' }, subscriptions: { type: 'array', items: { type: 'string' } } } },
            },
          } } },
        },
        responses: { 201: { description: 'Session created and started' }, 400: { description: 'Missing name' }, 404: { description: 'Task not found' }, 409: { description: 'Session name already exists' } },
      },
    },

    // ── Worktrees ────────────────────────────────────────
    '/api/worktrees': {
      post: {
        tags: ['Worktrees'],
        summary: 'Create a worktree record',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, branch: { type: 'string' }, repo: { type: 'string' }, worktreePath: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created' } },
      },
    },
    '/api/worktrees/{id}': {
      patch: {
        tags: ['Worktrees'],
        summary: 'Update a worktree',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Updated' } },
      },
      delete: {
        tags: ['Worktrees'],
        summary: 'Delete a worktree',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' } },
      },
    },

    // ── Runs ─────────────────────────────────────────────
    '/api/runs/{id}': {
      patch: {
        tags: ['Runs'],
        summary: 'Update a run',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'Updated' } },
      },
    },

    // ── Sessions ─────────────────────────────────────────
    '/api/sessions': {
      get: {
        tags: ['Sessions'],
        summary: 'List all sessions',
        description: 'Triggers backend reconciliation (checks tmux process state).',
        responses: { 200: { description: 'Session list', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/Session' } } } } } } } },
      },
      post: {
        tags: ['Sessions'],
        summary: 'Create a new session',
        description: 'Starts a tmux session with Claude Code.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', description: 'Session name (unique identifier)' },
              project: { type: 'string', description: 'Project name for workspace path' },
              worktree: { type: 'boolean', default: false },
              worktreePath: { type: 'string', description: 'Existing worktree path (if not creating new)' },
              prompt: { type: 'string', description: 'Initial message to send to Claude' },
              skipPermissions: { type: 'boolean', default: true },
              taskId: { type: 'string' },
              epicId: { type: 'string' },
              initiativeId: { type: 'string' },
              color: { type: 'string' },
            },
          } } },
        },
        responses: { 201: { description: 'Session created and started' }, 400: { description: 'Missing name or invalid config' }, 409: { description: 'Session name already exists' } },
      },
    },
    '/api/sessions/{name}': {
      get: {
        tags: ['Sessions'],
        summary: 'Get session by name',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Session details' }, 404: { description: 'Not found' } },
      },
      delete: {
        tags: ['Sessions'],
        summary: 'Delete a session',
        description: 'Responds immediately, then asynchronously stops the tmux session, removes worktree, and cleans up.',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' } },
      },
    },
    '/api/sessions/{name}/start': {
      post: {
        tags: ['Sessions'],
        summary: 'Start/resume a stopped session',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Started' } },
      },
    },
    '/api/sessions/{name}/stop': {
      post: {
        tags: ['Sessions'],
        summary: 'Stop a running session',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Stopped' } },
      },
    },
    '/api/sessions/{name}/files': {
      get: {
        tags: ['Sessions'],
        summary: 'List files in session workspace',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'path', in: 'query', schema: { type: 'string', default: '.' }, description: 'Relative directory path' },
        ],
        responses: { 200: { description: 'File listing', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/FileEntry' } } } } } } } },
      },
    },
    '/api/sessions/{name}/files/upload': {
      post: {
        tags: ['Sessions'],
        summary: 'Upload a file into the session workspace',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Workspace-relative target path' },
                  file: { type: 'string', format: 'binary' },
                },
                required: ['path', 'file'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Uploaded' },
          '400': { description: 'Invalid path or multipart' },
          '404': { description: 'Session not found' },
          '413': { description: 'File too large' },
        },
      },
    },
    '/api/sessions/{name}/send-keys': {
      post: {
        tags: ['Sessions'],
        summary: 'Send raw tmux keys to a session',
        description: 'Sends arbitrary key sequences to the session\'s tmux pane.',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['keys'],
            properties: {
              keys: { type: 'array', items: { type: 'string' }, description: 'Array of tmux key arguments (passed directly to tmux send-keys)', example: ['hello world', 'Enter'] },
            },
          } } },
        },
        responses: { 200: { description: 'Keys sent' }, 400: { description: 'Invalid keys' }, 404: { description: 'Session not found' } },
      },
    },
    '/api/sessions/{name}/enter-prompt': {
      post: {
        tags: ['Sessions'],
        summary: 'Type text then submit with Enter',
        description: 'Sends the prompt text to the session, waits 300ms for the terminal to process it, then sends Enter. This avoids the common pitfall where sending text+Enter in one shot causes a newline instead of submission in Claude Code.',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['prompt'],
            properties: {
              prompt: { type: 'string', description: 'Text to type into the session' },
            },
          } } },
        },
        responses: { 200: { description: 'Prompt submitted' }, 400: { description: 'Missing prompt' }, 404: { description: 'Session not found' } },
      },
    },
    // ── Projects ─────────────────────────────────────────
    '/api/projects': {
      get: {
        tags: ['Projects'],
        summary: 'List registered projects',
        responses: { 200: { description: 'Project map' } },
      },
      post: {
        tags: ['Projects'],
        summary: 'Register a project',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name', 'path'], properties: { name: { type: 'string' }, path: { type: 'string' } } } } } },
        responses: { 201: { description: 'Registered' }, 400: { description: 'Missing fields' } },
      },
    },
    '/api/projects/{name}': {
      delete: {
        tags: ['Projects'],
        summary: 'Unregister a project',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Unregistered' }, 404: { description: 'Not found' } },
      },
    },
    '/api/projects/{name}/worktrees': {
      get: {
        tags: ['Projects'],
        summary: 'List git worktrees for a project',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Worktree list' } },
      },
    },

    // ── Config ───────────────────────────────────────────
    '/api/config': {
      get: {
        tags: ['Config'],
        summary: 'Read user configuration',
        responses: { 200: { description: 'Config object' } },
      },
      patch: {
        tags: ['Config'],
        summary: 'Update user configuration',
        description: 'Deep-merges into ~/.config/tinstar/config.json.',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'Merged config' } },
      },
    },
    // ── Editor ───────────────────────────────────────────
    '/api/editor/open': {
      post: {
        tags: ['Editor'],
        summary: 'Open a file in the configured editor',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, sessionId: { type: 'string', description: 'Session name to resolve relative paths against' } } } } } },
        responses: { 200: { description: 'Editor launched' } },
      },
    },

    // ── Observability ────────────────────────────────────
    '/api/otel/spans': {
      get: {
        tags: ['Observability'],
        summary: 'Query OpenTelemetry spans',
        parameters: [{ name: 'traceId', in: 'query', schema: { type: 'string' }, description: 'Filter by trace ID' }],
        responses: { 200: { description: 'Span list' } },
      },
    },
    '/api/otel/metrics': {
      get: {
        tags: ['Observability'],
        summary: 'Query OpenTelemetry metrics',
        parameters: [{ name: 'name', in: 'query', schema: { type: 'string' }, description: 'Filter by metric name' }],
        responses: { 200: { description: 'Metric list' } },
      },
    },
    '/api/telemetry/turn-length': {
      get: {
        tags: ['Observability'],
        summary: 'Recent turn-length observations for heatmap rendering',
        parameters: [
          { name: 'windowSec', in: 'query', schema: { type: 'integer', minimum: 60, maximum: 3600 }, description: 'Time window in seconds (default 3600; clamped)' },
          { name: 'session', in: 'query', schema: { type: 'string' }, description: 'Tinstar session name (omit for fleet)' },
        ],
        responses: {
          200: {
            description: 'Turn-length observations',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    observations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          tsSec: { type: 'integer' },
                          sec: { type: 'number' },
                          session: { type: 'string' },
                          ccConvId: { type: 'string' },
                        },
                      },
                    },
                    lastUpdated: { type: 'integer' },
                  },
                },
              },
            },
          },
          400: { description: 'invalid windowSec' },
        },
      },
    },

    // ── Widgets ────────────────────────────────────────────
    '/api/browser-widgets': {
      post: {
        tags: ['Widgets'],
        summary: 'Create a browser widget on the canvas',
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: { type: 'string', description: 'Session name (must have a running run)' },
            url: { type: 'string', description: 'Initial URL to load' },
            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Custom HTTP headers injected via server-side proxy (like ModHeader)' },
          },
        } } } },
        responses: { 200: { description: 'Created widget', content: { 'application/json': { schema: { $ref: '#/components/schemas/BrowserWidget' } } } } },
      },
    },
    '/api/browser-widgets/{id}': {
      patch: {
        tags: ['Widgets'],
        summary: 'Update a browser widget',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Replace all custom headers (empty object clears them)' },
          },
        } } } },
        responses: { 200: { description: 'Updated widget' } },
      },
      delete: {
        tags: ['Widgets'],
        summary: 'Delete a browser widget',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' } },
      },
    },
    '/api/proxy/{widgetId}/{path}': {
      get: {
        tags: ['Widgets'],
        summary: 'Header-injection proxy for browser widgets',
        description: 'Reverse-proxies requests to the browser widget\'s target URL, injecting its configured custom headers on every request. Used automatically when a widget has headers set — the iframe src becomes /api/proxy/{widgetId}/path instead of the direct URL.',
        parameters: [
          { name: 'widgetId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'path', in: 'path', required: true, schema: { type: 'string' }, description: 'Path forwarded to the target origin' },
        ],
        responses: { 200: { description: 'Proxied response' }, 502: { description: 'Target unreachable' } },
      },
    },
    '/api/editor-widgets': {
      post: {
        tags: ['Widgets'],
        summary: 'Create a file editor widget on the canvas',
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          required: ['sessionId', 'filePath'],
          properties: {
            sessionId: { type: 'string' },
            filePath: { type: 'string', description: 'Absolute or workspace-relative file path' },
          },
        } } } },
        responses: { 200: { description: 'Created widget' } },
      },
    },
    '/api/editor-widgets/{id}': {
      delete: {
        tags: ['Widgets'],
        summary: 'Delete a file editor widget',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' } },
      },
    },
    '/api/image-widgets': {
      post: {
        tags: ['Widgets'],
        summary: 'Create an image widget on the canvas',
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          required: ['sessionId', 'filePath'],
          properties: {
            sessionId: { type: 'string' },
            filePath: { type: 'string', description: 'Absolute path to an image file' },
          },
        } } } },
        responses: { 200: { description: 'Created widget' } },
      },
    },
    '/api/image-widgets/{id}': {
      delete: {
        tags: ['Widgets'],
        summary: 'Delete an image widget',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' } },
      },
    },
    '/api/plugin-widgets': {
      post: {
        tags: ['Widgets'],
        summary: 'Create a plugin widget instance',
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          required: ['pluginId', 'widgetType', 'spaceId', 'position', 'size'],
          properties: {
            pluginId: { type: 'string', description: 'Plugin identifier' },
            widgetType: { type: 'string', description: 'Widget type within the plugin' },
            spaceId: { type: 'string', description: 'Space ID where the widget exists' },
            position: {
              type: 'object',
              required: ['x', 'y'],
              properties: { x: { type: 'number' }, y: { type: 'number' } },
            },
            size: {
              type: 'object',
              required: ['width', 'height'],
              properties: { width: { type: 'number' }, height: { type: 'number' } },
            },
            data: { type: 'object', description: 'Plugin-specific state (must be JSON-serializable, max 64KB)' },
          },
        } } } },
        responses: { 200: { description: 'Created instance', content: { 'application/json': { schema: { $ref: '#/components/schemas/PluginWidgetInstance' } } } } },
      },
      get: {
        tags: ['Widgets'],
        summary: 'List plugin widget instances',
        parameters: [{ name: 'spaceId', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by space (omit to list all)' }],
        responses: { 200: { description: 'Instance list', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/PluginWidgetInstance' } } } } } } } },
      },
    },
    '/api/plugin-widgets/{id}': {
      patch: {
        tags: ['Widgets'],
        summary: 'Update a plugin widget instance',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            position: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' } },
            },
            size: {
              type: 'object',
              properties: { width: { type: 'number' }, height: { type: 'number' } },
            },
            data: { type: 'object', description: 'Replace widget data entirely (no deep merge)' },
          },
        } } } },
        responses: { 200: { description: 'Updated instance', content: { 'application/json': { schema: { $ref: '#/components/schemas/PluginWidgetInstance' } } } } },
      },
      delete: {
        tags: ['Widgets'],
        summary: 'Delete a plugin widget instance',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' } },
      },
    },

    // ── Simulator ────────────────────────────────────────
    '/api/simulator/start': {
      post: {
        tags: ['Simulator'],
        summary: 'Start the mock data simulator',
        responses: { 200: { description: 'Started' } },
      },
    },
    '/api/simulator/reset': {
      post: {
        tags: ['Simulator'],
        summary: 'Reset and restart the simulator',
        description: 'Clears the document store and re-emits all mock events.',
        responses: { 200: { description: 'Reset complete' } },
      },
    },
  },

  components: {
    schemas: {
      State: {
        type: 'object',
        properties: {
          activeSpaceId: { type: 'string' },
          spaces: { type: 'array', items: { $ref: '#/components/schemas/Space' } },
          initiatives: { type: 'array' },
          epics: { type: 'array' },
          tasks: { type: 'array' },
          worktrees: { type: 'array' },
          runs: { type: 'array', items: { $ref: '#/components/schemas/Run' } },
        },
      },
      Space: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Initiative: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          color: { type: 'string' },
          status: { type: 'string', enum: ['active', 'paused', 'archived'] },
          summary: { type: 'string' },
          settings: { $ref: '#/components/schemas/EntitySettings' },
          spaceId: { type: 'string' },
        },
      },
      EntitySettings: {
        type: 'object',
        description: 'Nullable fields — null means "inherit from parent".',
        properties: {
          project: { type: 'string', nullable: true },
          backend: { type: 'string', enum: ['tmux'], nullable: true },
          worktreeMode: { type: 'string', enum: ['none', 'new', 'existing'], nullable: true },
          skipPermissions: { type: 'boolean', nullable: true },
          prompt: { type: 'string', nullable: true },
          defaultRunColor: { type: 'string', nullable: true },
        },
      },
      Session: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          backend: { type: 'string', enum: ['tmux'] },
          state: { type: 'string', enum: ['creating', 'running', 'idle', 'needs_attention', 'stopped'] },
          project: { type: 'string' },
          workspace: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              worktree: { type: 'boolean' },
              branch: { type: 'string', nullable: true },
            },
          },
          conversation: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
          profile: { type: 'string' },
          port: { type: 'integer', nullable: true },
          oneshot: { type: 'boolean' },
          skipPermissions: { type: 'boolean' },
          created: { type: 'string', format: 'date-time' },
          lastActive: { type: 'string', format: 'date-time' },
        },
      },
      Run: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          sessionId: { type: 'string' },
          color: { type: 'string' },
          initiative: { type: 'string' },
          epic: { type: 'string' },
          task: { type: 'string' },
          backend: { type: 'string' },
          port: { type: 'integer', nullable: true },
          touchedFiles: { type: 'array', items: { $ref: '#/components/schemas/TouchedFile' } },
          recapEntries: { type: 'array' },
          createdAt: { type: 'string', format: 'date-time' },
          spaceId: { type: 'string' },
        },
      },
      TouchedFile: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          path: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string', enum: ['code', 'config', 'test', 'script', 'doc'] },
          additions: { type: 'integer' },
          deletions: { type: 'integer' },
          readOnly: { type: 'boolean' },
          pending: { type: 'boolean' },
        },
      },
      FileEntry: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          isDir: { type: 'boolean' },
        },
      },
      BrowserWidget: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          sessionId: { type: 'string' },
          spaceId: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          color: { type: 'string' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Custom HTTP headers injected on proxied requests' },
        },
      },
      PluginWidgetInstance: {
        type: 'object',
        required: ['id', 'pluginId', 'widgetType', 'spaceId', 'position', 'size', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string', description: 'Instance ID (pw-{shortId})' },
          pluginId: { type: 'string', description: 'Plugin identifier' },
          widgetType: { type: 'string', description: 'Widget type within the plugin' },
          spaceId: { type: 'string', description: 'Space ID where the widget exists' },
          position: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
          },
          size: {
            type: 'object',
            properties: { width: { type: 'number' }, height: { type: 'number' } },
          },
          data: { type: ['object', 'null'], description: 'Plugin-specific state' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      // ── Response envelope (ADR 0001) ──────────────────
      //
      // Every application API endpoint returns one of two shapes. Wire-protocol
      // endpoints (this spec, OTLP/Prom exports, /api/state SSE snapshot,
      // cc-quota snapshot) are documented exceptions and return raw payloads.
      ErrorCode: {
        type: 'string',
        enum: [
          'BAD_REQUEST', 'INVALID_PARAMS', 'NOT_FOUND', 'SESSION_NOT_FOUND',
          'CONFLICT', 'PATH_OUTSIDE_WORKSPACE', 'FORBIDDEN',
          'INTERNAL', 'BACKEND_UNAVAILABLE', 'BRIDGE_UNAVAILABLE',
          'CONFIG_UNAVAILABLE', 'LIST_FAILED',
        ],
        description: 'Closed taxonomy of error categories. Adding a new code requires an ADR amendment.',
      },
      Ok: {
        type: 'object',
        required: ['ok', 'data'],
        properties: {
          ok: { const: true },
          data: { description: 'Success payload — type depends on the endpoint.' },
          warnings: {
            type: 'object',
            additionalProperties: { type: 'array', items: {} },
            description: 'Optional soft-failure carrier. Keys are warning categories (e.g. "nats"); values are arrays of category-specific entries.',
          },
        },
      },
      Error: {
        type: 'object',
        required: ['ok', 'error'],
        properties: {
          ok: { const: false },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { $ref: '#/components/schemas/ErrorCode' },
              message: { type: 'string' },
              details: { description: 'Structured context for specific handlers (e.g. field validation maps). Opaque to generic readers.' },
            },
          },
        },
      },
    },
  },
} as const
