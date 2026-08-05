import { HOST_RECIPE_KINDS } from '../../domain/types'

/** The typed refresh recipe, as an author may write it (R1/R6/R7, KTD1). Shared by
 *  the create/update bodies and the Surface schema so the two cannot drift. */
const RECIPE_SCHEMA = {
  oneOf: [
    { type: 'string', description: 'Prose. Read as an AGENT recipe: only a human\'s deliberate navigation or interaction runs it.' },
    {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['agent', 'host'] },
        prompt: { type: 'string', description: 'agent only: the instruction delivered to the foreground agent.' },
        handler: {
          type: 'string', enum: [...HOST_RECIPE_KINDS],
          description: 'host only: a registered machine check. The ONLY proactive-eligible form.',
        },
        params: {
          type: 'object', additionalProperties: { type: 'string' },
          description: 'host only: flat string parameters.',
        },
      },
    },
  ],
  description:
    'The ONE recipe that rebuilds this whole Surface. The kind decides who may run it: a host '
    + 'handler from the closed list may run proactively; anything else, including all prose, runs '
    + 'only on a discrete human action. An unrecognised handler is refused, never guessed at.',
}

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
    { name: 'CLI Templates', description: 'Stable launch-template identities and renameable display metadata' },
    { name: 'Hooks', description: 'Callbacks from Claude Code inside sessions' },
    { name: 'Projects', description: 'Registered project directories' },
    { name: 'Config', description: 'User configuration' },
    { name: 'Editor', description: 'Open files in external editor' },
    { name: 'Observability', description: 'OpenTelemetry spans and metrics' },
    { name: 'Widgets', description: 'Canvas widgets — browser, file editor, image' },
    { name: 'Surfaces', description: 'Canonical recursive Surfaces — the agent/UI parity primitives' },
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
              cliTemplate: { type: 'string', description: 'Stable CLI template ID (not its renameable display name)' },
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
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            name: { type: 'string', nullable: true, description: 'Friendly display name, shown wherever the UI would otherwise show the run id. Free text (spaces, punctuation, emoji), capped at 200 chars, NOT id-sanitized. Empty or null clears it and the UI falls back to the id. Display-only: the run id remains the sole identity (tmux session, worktree, branch, NATS subject), so names need not be unique and nothing resolves one back to a run.' },
            taskId: { type: 'string', description: 'Reparent the run to another task (updates NATS subscriptions when enabled).' },
            attention: { type: 'object', nullable: true, description: 'Explicit attention: { level: urgent|attention|info, reason: string }, or null to clear.' },
            background: { type: 'boolean', description: 'Promote (false) or demote (true) the session to/from background. Persisted to the session record and mirrored onto the run; attention re-derives from (status, blocked, background) in the same mutation, so demoting an idle run clears its "Ready for input" row and promoting restores it.' },
          },
        } } } },
        responses: { 200: { description: 'Updated' }, 400: { description: 'Invalid name/attention shape or non-boolean background' }, 404: { description: 'Run not found' } },
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
        description: 'Starts a provider-backed CLI agent in a tmux session.',
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
              prompt: { type: 'string', description: 'Initial message to send to the agent' },
              skipPermissions: { type: 'boolean', default: true },
              cliTemplate: { type: 'string', description: 'Stable CLI template ID (not its renameable display name)' },
              taskId: { type: 'string' },
              epicId: { type: 'string' },
              initiativeId: { type: 'string' },
              color: { type: 'string' },
              focus: { type: 'boolean', default: true, description: 'Passive spawn: when false, the session is created but the canvas does NOT pan/zoom to it (the viewport stays put). Omitted/true auto-focuses the new run.' },
              background: { type: 'boolean', default: false, description: 'Create as a background session: hidden from the canvas, hierarchy sidebar, and passive inbox rows by default, while staying fully alive and commandable (NATS + prompt endpoint). Forces focus:false — a background session never steals camera focus. Needs-attention states (permission-blocked, dead harness) still break through to the inbox. Background agents that want zero inbox residue should DELETE their own session when done; a bare exit leaves a "Run stopped" info row.' },
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
    '/api/cli-templates': {
      get: {
        tags: ['CLI Templates'],
        summary: 'List configured CLI templates',
        description: 'Returns stable template IDs together with renameable display names and provider adapter IDs.',
        responses: {
          200: {
            description: 'Template list',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    data: { type: 'array', items: { $ref: '#/components/schemas/CliTemplate' } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['CLI Templates'],
        summary: 'Create a CLI template',
        description: 'Creates a template with a server-generated stable ID.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CliTemplateInput' },
            },
          },
        },
        responses: {
          200: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/CliTemplateResponse' } } } },
          400: { description: 'Invalid template or unsupported provider capability' },
        },
      },
    },
    '/api/cli-templates/{id}': {
      put: {
        tags: ['CLI Templates'],
        summary: 'Update a CLI template without changing its stable ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CliTemplateInput' },
            },
          },
        },
        responses: {
          200: { description: 'Updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/CliTemplateResponse' } } } },
          400: { description: 'Invalid template or unsupported provider capability' },
          404: { description: 'Template not found' },
        },
      },
      delete: {
        tags: ['CLI Templates'],
        summary: 'Delete a user-defined CLI template',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/NullResponse' } } } },
          404: { description: 'Template not found or built-in template has no user override' },
        },
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
    '/api/sessions/{name}/timeline': {
      get: {
        tags: ['Observability'],
        summary: "Where a session's wall-clock time went",
        description:
          'Reconstructs a session\'s time usage from its own transcript (Claude Code or Codex). ' +
          'Bands never overlap and always sum to the span, so they can be totalled directly. ' +
          'Retroactive: works on sessions that started long before this endpoint existed.\n\n' +
          'The band kinds that matter for orchestration are `approval` (the agent is parked on a ' +
          'permission prompt nobody has answered) and `question` (it asked something and is waiting ' +
          'for a reply). To check whether a session is stuck on you right now, read the last band: ' +
          'if its kind is `approval` or `question` and its `end` is close to now, nobody has answered it.\n\n' +
          '`think` is a residual — in-turn time with no tool outstanding — so treat it as an upper ' +
          'bound rather than a measurement. `data` is null when the session has no resolvable ' +
          'transcript; that is a legitimate answer, not an error.',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' }, description: 'Tinstar session name' },
          { name: 'windowSec', in: 'query', schema: { type: 'integer', minimum: 1 }, description: 'Trailing window in seconds (default 3600). Echoed back; the response always carries the full span.' },
        ],
        responses: {
          200: {
            description: 'Reconstructed timeline, or null when no transcript resolves',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    data: {
                      type: 'object',
                      nullable: true,
                      properties: {
                        t0: { type: 'number', description: 'Epoch seconds of the first transcript entry' },
                        t1: { type: 'number', description: 'Epoch seconds of the right edge — extends to now while a call is in flight' },
                        windowSec: { type: 'integer' },
                        partial: { type: 'boolean', description: 'True when a cold parse yielded early and more remains' },
                        bands: {
                          type: 'array',
                          description: 'Non-overlapping, ordered, tiling [t0, t1]',
                          items: {
                            type: 'object',
                            properties: {
                              start: { type: 'number' },
                              end: { type: 'number' },
                              kind: { type: 'string', enum: ['approval', 'question', 'subagent', 'compact', 'tool', 'idle', 'think'] },
                              name: { type: 'string', description: 'Tool name, or a label such as "waiting on you"' },
                              detail: { type: 'string', description: 'Command or argument snippet' },
                            },
                          },
                        },
                        marks: {
                          type: 'array',
                          description: 'Point failures. Only a non-zero exit code counts.',
                          items: {
                            type: 'object',
                            properties: {
                              at: { type: 'number' },
                              kind: { type: 'string', enum: ['tool-failed', 'subagent-interrupted'] },
                              name: { type: 'string' },
                              detail: { type: 'string' },
                            },
                          },
                        },
                        turns: {
                          type: 'array',
                          description: '[start, end, isOpen] per turn, epoch seconds',
                          items: { type: 'array', items: { type: 'number' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          404: { description: 'session not found' },
          500: { description: 'reconstruction failed' },
        },
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
                          toolUses: { type: 'integer' },
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

    // ── Surfaces ─────────────────────────────────────────
    //
    // The Agent-Native Action Parity contract: every action a human can take on
    // a Surface has an endpoint here, so an agent is never second-class.
    //
    // Two things about this resource are easy to get wrong from the spec alone
    // and are therefore spelled out in the descriptions below: DELETE is a MOVE
    // into the recovery store and is undone by `restore`, while `purge` is the
    // only irreversible operation; and there is NO approval or proposal step,
    // because agents act directly and safety comes from recoverability.
    '/api/surfaces': {
      get: {
        tags: ['Surfaces'],
        summary: 'List a space\'s canonical Surfaces',
        description: 'Deleted Surfaces are excluded unless `includeDeleted=true`; `recoveryIds` always reports that they exist.',
        parameters: [
          { name: 'spaceId', in: 'query', schema: { type: 'string' }, description: 'Defaults to the active space' },
          { name: 'includeDeleted', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { 200: { description: 'Listing with capabilities, root ids, and recovery ids' } },
      },
      post: {
        tags: ['Surfaces'],
        summary: 'Create a Surface',
        description:
          'Identity, revisions, timestamps, freshness, aliases, and sibling order are HOST-owned and are rejected if supplied. '
          + 'A compatibility alias is assigned automatically (the declared run, else the workspace-recovery bucket).',
        requestBody: {
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['spaceId', 'home', 'content'],
            properties: {
              spaceId: { type: 'string' },
              home: { $ref: '#/components/schemas/SurfaceHome' },
              content: { $ref: '#/components/schemas/SurfaceContent' },
              contentAuthority: { type: 'string', enum: ['source-binding', 'canonical-direct'] },
              author: { type: 'string', enum: ['user', 'agent', 'process'] },
              provenance: { type: 'object' },
              owner: { type: 'object' },
              source: { type: 'object' },
              compatibilityOnly: { type: 'boolean' },
            },
          } } },
        },
        responses: { 201: { description: 'Created' }, 400: { description: 'Validation refused' } },
      },
    },
    '/api/surfaces/group': {
      post: {
        tags: ['Surfaces'],
        summary: 'Group siblings under one new parent',
        description: 'Atomic. Every child must currently share one home. Direct — no approval step.',
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          required: ['childIds', 'content'],
          properties: {
            childIds: { type: 'array', items: { type: 'string' } },
            content: { $ref: '#/components/schemas/SurfaceContent' },
            expectedTopologyRev: { type: 'integer' },
            expectedRevs: { type: 'object', additionalProperties: { type: 'integer' } },
          },
        } } } },
        responses: { 200: { description: 'One atomic batch applied' }, 409: { description: 'Conflict; nothing moved' } },
      },
    },
    '/api/surfaces/reparent': {
      post: {
        tags: ['Surfaces'],
        summary: 'Move Surfaces to one home',
        description: 'Atomic and cycle-checked. Also the "promote to Canvas" operation. Direct — no approval step.',
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          required: ['ids', 'home'],
          properties: {
            ids: { type: 'array', items: { type: 'string' } },
            home: { $ref: '#/components/schemas/SurfaceHome' },
            expectedTopologyRev: { type: 'integer' },
            expectedRevs: { type: 'object', additionalProperties: { type: 'integer' } },
          },
        } } } },
        responses: { 200: { description: 'One atomic batch applied' }, 409: { description: 'Conflict; nothing moved' } },
      },
    },
    '/api/surfaces/{id}': {
      get: {
        tags: ['Surfaces'],
        summary: 'One Surface and its effective capabilities',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Record and capabilities' }, 404: { description: 'Not found' } },
      },
      delete: {
        tags: ['Surfaces'],
        summary: 'Move a Surface into the recovery store',
        description:
          'NOT an erase. The subtree is moved into the per-space recovery store inside the same atomic transaction '
          + 'and is restorable until purged. A Surface with descendants requires the EXACT descendant set the caller '
          + 'displayed plus a disposition, so a stale confirmation cannot remove more than the human agreed to.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            descendants: { type: 'array', items: { type: 'string' } },
            disposition: { type: 'string', enum: ['reparent-children', 'delete-subtree'] },
          },
        } } } },
        responses: { 200: { description: 'Moved to the recovery store' }, 409: { description: 'Descendant set or revision mismatch' } },
      },
    },
    '/api/surfaces/{id}/context': {
      get: {
        tags: ['Surfaces'],
        summary: 'Ancestors, immediate children, contributors, freshness, and capabilities',
        description: 'Children are the immediate scope only; `descendantCount` carries the total. Child content outside the caller\'s worktree scope is withheld rather than hidden.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Context' }, 404: { description: 'Not found' } },
      },
    },
    '/api/surfaces/{id}/contributors': {
      get: {
        tags: ['Surfaces'],
        summary: 'Resolve contributors to ttyd, Graveyard, process evidence, or unavailable',
        description: 'Only a live managed session sets `terminal: true`; a process or file source never offers a dead terminal.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Contributors' }, 404: { description: 'Not found' } },
      },
    },
    '/api/surfaces/{id}/content': {
      patch: {
        tags: ['Surfaces'],
        summary: 'Update authored content behind a revision gate',
        description:
          'Whitelisted to headline, body (validated A2UI), and recipe; `null` clears body or recipe. '
          + 'When content authority is the source binding, the edit routes through that source\'s adapter with an '
          + 'expected watermark, or is refused with instructions to transfer authority first.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          required: ['expectedRev'],
          properties: {
            expectedRev: { type: 'integer' },
            headline: { type: 'string' },
            body: { type: 'object', nullable: true },
            recipe: { ...RECIPE_SCHEMA, nullable: true },
            expectedWatermark: { type: 'string' },
          },
        } } } },
        responses: { 200: { description: 'Updated' }, 409: { description: 'Stale revision or source authority' } },
      },
    },
    '/api/surfaces/{id}/authority': {
      post: {
        tags: ['Surfaces'],
        summary: 'Transfer content authority between the source binding and the record',
        description: 'Explicit, revision-checked, and restart-stable. The source binding survives the transfer so divergence can still be reported.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          required: ['to', 'expectedRev'],
          properties: {
            to: { type: 'string', enum: ['source-binding', 'canonical-direct'] },
            expectedRev: { type: 'integer' },
          },
        } } } },
        responses: { 200: { description: 'Transferred' }, 409: { description: 'Stale revision or already there' } },
      },
    },
    '/api/surfaces/{id}/thread': {
      post: {
        tags: ['Surfaces'],
        summary: 'Append one message to a Surface thread',
        description: 'Persist-first. The author defaults from the calling principal: a browser posts as `user`, a managed session as `agent`.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string' },
            author: { type: 'string', enum: ['user', 'agent', 'process'] },
            expectedRev: { type: 'integer' },
          },
        } } } },
        responses: { 200: { description: 'Appended' } },
      },
    },
    '/api/surfaces/{id}/refresh': {
      post: {
        tags: ['Surfaces'],
        summary: 'Request a refresh',
        description: 'Moves freshness to `queued`. An `overdue` flag is carried through, never cleared — only a successful verification clears it. Refused while a refresh is already queued or running.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Queued' }, 409: { description: 'Already queued or refreshing' } },
      },
    },
    '/api/surfaces/{id}/ungroup': {
      post: {
        tags: ['Surfaces'],
        summary: 'Dissolve a parent; its children move up to its home',
        description: 'The exact inverse of group, in one transaction. The emptied parent goes to the recovery store, so an ungroup is undoable too. To move children out but KEEP the parent, use reparent.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Dissolved' }, 409: { description: 'Conflict; nothing moved' } },
      },
    },
    '/api/surfaces/{id}/restore': {
      post: {
        tags: ['Surfaces'],
        summary: 'Restore a deleted subtree',
        description: 'Returns it to its former home. A former home that no longer exists does NOT fail the restore — the Surface lands on the Canvas with the workspace-recovery alias rather than becoming unreachable.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Restored' }, 409: { description: 'Not a deleted subtree root' } },
      },
    },
    '/api/surfaces/{id}/purge': {
      delete: {
        tags: ['Surfaces'],
        summary: 'ERASE a deleted subtree. Irreversible.',
        description: 'The only irreversible operation on a Surface. Refused for anything not already in the recovery store, so a purge is always the second step of a decision. '
          + 'A subtree with descendants requires the EXACT descendant set the caller was shown, exactly as delete does — a purge computes its doomed set from the tree as it is NOW, '
          + 'so without that check it would erase records that arrived after the human read the recovery list, and there is no undo.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            descendants: {
              type: 'array', items: { type: 'string' },
              description: 'The exact transitive descendant set, at every depth. Required when the subtree has any.',
            },
            expectedTopologyRev: { type: 'integer', description: 'The space topology revision the caller believes it read.' },
          },
        } } } },
        responses: {
          200: { description: 'Erased' },
          409: { description: 'Not a deleted subtree root, or the named descendant set does not match' },
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
          properties: {
            sessionId: { type: 'string', description: 'Optional session name (must have a running run when given). Omit to create a standalone browser widget.' },
            url: { type: 'string', description: 'Initial URL to load' },
            color: { type: 'string', description: 'Accent color override (hex). Defaults to the bound run color, or a neutral standalone color.' },
            headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Custom HTTP headers injected via server-side proxy (like ModHeader)' },
            spaceId: { type: 'string', description: 'Target space (defaults to the active space). Scopes both placement and slot.' },
            position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, description: 'Initial canvas position seed. Wins over nearNodeId.' },
            size: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, description: 'Initial size paired with position/nearNodeId. Defaults to 800×600.' },
            nearNodeId: { type: 'string', description: 'Place just to the right of this node id, resolved from the persisted layout. Ignored if position is given or the node has no saved layout.' },
            slot: { type: 'integer', minimum: 1, maximum: 9, description: 'Constellation slot (1–9) to join. An out-of-range value is not assigned to a slot, but any explicit slot input still opts out of session auto-snap.' },
            snapToSession: { type: 'boolean', default: true, description: 'When a sessionId is given (and no explicit slot/position), the widget auto-snaps into the session\'s constellation and tiles to its right. Set false to spawn free-floating.' },
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
            position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, description: 'New placement seed (persisted; live re-positioning of an already-placed widget needs a reload).' },
            size: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } },
            nearNodeId: { type: 'string', description: 'Resolve position to the right of this node id (alternative to position).' },
            slot: { type: 'integer', minimum: 1, maximum: 9, description: 'Constellation slot (1–9) to join.' },
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
            snapToSession: { type: 'boolean', default: true, description: "When a sessionId is given, the editor auto-snaps into the session's constellation and tiles to its right. Set false to spawn free-floating (interactive drops do this and snap client-side from the drop point)." },
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

    // ── Artifacts ─────────────────────────────────────────
    '/api/artifacts': {
      post: {
        tags: ['Widgets'],
        summary: 'Store an HTML file as an ephemeral artifact and open a browser widget',
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'Absolute path to an HTML file to read and store' },
            name: { type: 'string', description: 'Display name for the artifact widget' },
            sessionId: { type: 'string', description: 'Session to associate with the browser widget' },
            color: { type: 'string', description: 'Widget accent color' },
            spaceId: { type: 'string', description: 'Target space (defaults to active space)' },
            position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, description: 'Initial canvas position seed. Wins over nearNodeId.' },
            size: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, description: 'Initial size. Defaults to 800×600.' },
            nearNodeId: { type: 'string', description: 'Place just to the right of this node id. Ignored if position is given.' },
            slot: { description: 'Constellation slot (1–9) to join. An out-of-range value is not assigned to a slot, but any explicit slot input still opts out of session auto-snap.', oneOf: [{ type: 'integer', minimum: 1, maximum: 9 }, { type: 'string' }] },
            snapToSession: { type: 'boolean', default: true, description: 'When a sessionId is given (and no explicit slot/position), the artifact widget auto-snaps into the session\'s constellation and tiles to its right. Set false to spawn free-floating.' },
          },
        } } } },
        responses: { 200: { description: 'Artifact created', content: { 'application/json': { schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, data: { type: 'object', properties: {
            artifactId: { type: 'string' },
            url: { type: 'string' },
            widgetId: { type: 'string' },
          } } },
        } } } } },
      },
      delete: {
        tags: ['Widgets'],
        summary: 'Clear all artifacts and close their owning browser widgets',
        responses: { 200: { description: 'All artifacts deleted and their owning browser widgets removed', content: { 'application/json': { schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, data: { type: 'object', properties: { deleted: { type: 'integer' } } } },
        } } } } },
      },
    },
    '/api/artifacts/{id}': {
      get: {
        tags: ['Widgets'],
        summary: 'Serve the raw HTML for a stored artifact',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'HTML content', content: { 'text/html': { schema: { type: 'string' } } } },
          404: { description: 'Unknown artifact' },
        },
      },
      put: {
        tags: ['Widgets'],
        summary: 'Re-read the file and update the artifact in place (reloads the open widget)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'Absolute path to the updated HTML file' },
          },
        } } } },
        responses: {
          200: { description: 'Artifact updated', content: { 'application/json': { schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, data: { type: 'object', properties: {
              artifactId: { type: 'string' },
              url: { type: 'string' },
              rev: { type: 'integer' },
            } } },
          } } } },
          404: { description: 'Unknown artifact' },
        },
      },
      delete: {
        tags: ['Widgets'],
        summary: 'Delete a single artifact and close its owning browser widget',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Artifact deleted and its owning browser widget removed', content: { 'application/json': { schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, data: { type: 'object', properties: { deleted: { type: 'boolean' } } } },
          } } } },
          404: { description: 'Unknown artifact' },
        },
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
      /** Exactly one home, always — recursion is a tree, not a graph. `recovery`
       *  is READ-ONLY over the wire: a Surface gets there through DELETE and
       *  leaves through restore, never by a caller naming it. */
      SurfaceHome: {
        oneOf: [
          { type: 'object', required: ['kind', 'spaceId'], properties: { kind: { type: 'string', enum: ['canvas'] }, spaceId: { type: 'string' } } },
          { type: 'object', required: ['kind', 'surfaceId'], properties: { kind: { type: 'string', enum: ['surface'] }, surfaceId: { type: 'string' } } },
          { type: 'object', required: ['kind', 'spaceId'], properties: { kind: { type: 'string', enum: ['recovery'] }, spaceId: { type: 'string' } }, readOnly: true },
        ],
      },
      SurfaceContent: {
        type: 'object',
        required: ['headline'],
        properties: {
          headline: { type: 'string' },
          body: { type: 'object', description: 'A2UI content from the bounded component catalog; validated at the boundary' },
          recipe: RECIPE_SCHEMA,
        },
      },
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
          sessions: { type: 'array', items: { $ref: '#/components/schemas/Session' } },
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
          cliTemplate: { type: 'string', nullable: true, description: 'Stable CLI template ID; null means inherit from parent.' },
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
          cliTemplate: { type: 'string', nullable: true, description: 'Stable CLI template ID used to launch and resume this session.' },
          adapter: { type: 'string', nullable: true, description: 'Open provider adapter ID persisted with the session.' },
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
      CliTemplateInput: {
        type: 'object',
        required: ['name', 'startCmd', 'resumeCmd'],
        properties: {
          name: { type: 'string', description: 'Renameable display label; not an identity.' },
          icon: { type: 'string' },
          adapter: { type: 'string', description: 'Open provider adapter ID, such as claude, codex, generic, or a registered third-party provider.' },
          telemetry: { type: 'boolean', description: 'Optional override. Omit to inherit the provider default.' },
          startCmd: { type: 'string' },
          resumeCmd: { type: 'string' },
        },
      },
      CliTemplate: {
        allOf: [
          { $ref: '#/components/schemas/CliTemplateInput' },
          {
            type: 'object',
            required: ['id', 'telemetryState'],
            properties: {
              id: { type: 'string', description: 'Stable reference used by sessions, entity settings, and hand definitions.' },
              telemetryState: {
                type: 'string',
                enum: ['enabled', 'disabled', 'unsupported', 'unavailable'],
                description: 'Resolved provider telemetry state returned by template discovery.',
              },
            },
          },
        ],
      },
      CliTemplateResponse: {
        type: 'object',
        required: ['ok', 'data'],
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: { $ref: '#/components/schemas/CliTemplate' },
        },
      },
      NullResponse: {
        type: 'object',
        required: ['ok', 'data'],
        properties: {
          ok: { type: 'boolean', enum: [true] },
          data: { nullable: true },
        },
      },
      Run: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string', nullable: true, description: 'Friendly display name, shown in the UI wherever the run id would otherwise appear. Absent when unset (falls back to id). Set/cleared via PATCH /api/runs/{id}.' },
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
          position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, description: 'Initial canvas placement seed (set by the placement API)' },
          size: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, description: 'Initial size paired with position' },
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
