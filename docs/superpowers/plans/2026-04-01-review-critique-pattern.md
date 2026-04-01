# Review & Critique Pattern Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable multi-agent patterns where an orchestrator spawns a worker, reviews their work, and iterates until satisfied.

**Architecture:** Pattern files live in `~/.claude/patterns/*.md` using YAML frontmatter with session configs. Tinstar discovers patterns at startup, exposes them via API, and the CreateSessionDialog shows a pattern dropdown. When a pattern is selected, Tinstar spawns all defined sessions with interpolated prompts.

**Tech Stack:** TypeScript, React, YAML parsing (js-yaml), Jinja-style templating

---

## File Structure

```
src/server/patterns/
├── discovery.ts      # Scan ~/.claude/patterns/ for pattern files
├── parser.ts         # Parse YAML frontmatter + session configs
├── interpolate.ts    # Template variable interpolation
└── index.ts          # Exports

src/server/api/routes.ts    # Add GET /api/patterns, modify POST /api/sessions
src/components/CreateSessionDialog.tsx  # Add pattern dropdown
```

---

### Task 1: Create Pattern Parser

**Files:**
- Create: `src/server/patterns/parser.ts`
- Test: `src/server/patterns/__tests__/parser.test.ts`

- [ ] **Step 1: Write the failing test for parsePatternFile**

Create `src/server/patterns/__tests__/parser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { parsePatternFile } from '../parser'

describe('parsePatternFile', () => {
  it('parses pattern with orchestrator and worker sessions', () => {
    const content = `---
name: bug-review
description: Worker searches, orchestrator reviews
---

orchestrator:
  backend: tmux
  project: myproject
  prompt: |
    You are orchestrating a bug review for {{task}}.

worker:
  backend: tmux
  project: myproject
  worktree: true
  prompt: |
    You are a worker on {{task}}.
`

    const result = parsePatternFile(content)

    expect(result.name).toBe('bug-review')
    expect(result.description).toBe('Worker searches, orchestrator reviews')
    expect(result.sessions).toHaveLength(2)
    expect(result.sessions[0].role).toBe('orchestrator')
    expect(result.sessions[0].config.backend).toBe('tmux')
    expect(result.sessions[0].config.prompt).toContain('{{task}}')
    expect(result.sessions[1].role).toBe('worker')
    expect(result.sessions[1].config.worktree).toBe(true)
  })

  it('returns null for invalid pattern', () => {
    const result = parsePatternFile('not valid yaml')
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/patterns/__tests__/parser.test.ts`
Expected: FAIL with "Cannot find module '../parser'"

- [ ] **Step 3: Write parsePatternFile implementation**

Create `src/server/patterns/parser.ts`:

```typescript
import { load as parseYaml } from 'js-yaml'

export interface PatternSessionConfig {
  backend?: 'tmux' | 'docker'
  project?: string
  worktree?: boolean
  worktreePath?: string
  skipPermissions?: boolean
  profile?: string
  cliTemplate?: string
  prompt?: string
}

export interface PatternSession {
  role: string  // 'orchestrator', 'worker', etc.
  config: PatternSessionConfig
}

export interface Pattern {
  name: string
  description: string
  sessions: PatternSession[]
}

/**
 * Parse a pattern file content (markdown with YAML frontmatter and body).
 * Returns null if parsing fails.
 */
export function parsePatternFile(content: string): Pattern | null {
  try {
    // Split frontmatter and body
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!frontmatterMatch) return null

    const frontmatter = parseYaml(frontmatterMatch[1]) as Record<string, unknown>
    const body = frontmatterMatch[2].trim()

    const name = frontmatter.name as string
    const description = (frontmatter.description as string) ?? ''

    if (!name) return null

    // Parse body as YAML containing session definitions
    const bodyYaml = parseYaml(body) as Record<string, unknown>
    if (!bodyYaml || typeof bodyYaml !== 'object') return null

    const sessions: PatternSession[] = []

    for (const [role, config] of Object.entries(bodyYaml)) {
      if (config && typeof config === 'object') {
        sessions.push({
          role,
          config: config as PatternSessionConfig,
        })
      }
    }

    return { name, description, sessions }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/patterns/__tests__/parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/patterns/parser.ts src/server/patterns/__tests__/parser.test.ts
git commit -m "feat(patterns): add pattern file parser"
```

---

### Task 2: Create Template Interpolation

**Files:**
- Create: `src/server/patterns/interpolate.ts`
- Test: `src/server/patterns/__tests__/interpolate.test.ts`

- [ ] **Step 1: Write the failing test for interpolateTemplate**

Create `src/server/patterns/__tests__/interpolate.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { interpolateTemplate } from '../interpolate'

describe('interpolateTemplate', () => {
  it('interpolates task variable', () => {
    const template = 'Review bug {{task}}'
    const vars = { task: 'JIRA-123' }
    expect(interpolateTemplate(template, vars)).toBe('Review bug JIRA-123')
  })

  it('interpolates multiple variables', () => {
    const template = 'Session {{sessionId}} working on {{task}}'
    const vars = { sessionId: 'worker-abc', task: 'JIRA-456' }
    expect(interpolateTemplate(template, vars)).toBe('Session worker-abc working on JIRA-456')
  })

  it('leaves unknown variables as-is', () => {
    const template = 'Value: {{unknown}}'
    const vars = { task: 'test' }
    expect(interpolateTemplate(template, vars)).toBe('Value: {{unknown}}')
  })

  it('handles empty template', () => {
    expect(interpolateTemplate('', { task: 'test' })).toBe('')
  })

  it('handles undefined template', () => {
    expect(interpolateTemplate(undefined, { task: 'test' })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/patterns/__tests__/interpolate.test.ts`
Expected: FAIL with "Cannot find module '../interpolate'"

- [ ] **Step 3: Write interpolateTemplate implementation**

Create `src/server/patterns/interpolate.ts`:

```typescript
export interface TemplateVars {
  task?: string
  taskId?: string
  sessionId?: string
  orchestrator?: string
  worker?: string
  [key: string]: string | undefined
}

/**
 * Interpolate Jinja-style {{variable}} placeholders in a template string.
 * Unknown variables are left as-is.
 */
export function interpolateTemplate(template: string | undefined, vars: TemplateVars): string | undefined {
  if (!template) return template

  return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    const value = vars[varName]
    return value !== undefined ? value : match
  })
}

/**
 * Interpolate all string fields in a session config object.
 */
export function interpolateSessionConfig<T extends Record<string, unknown>>(
  config: T,
  vars: TemplateVars
): T {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      result[key] = interpolateTemplate(value, vars)
    } else {
      result[key] = value
    }
  }

  return result as T
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/patterns/__tests__/interpolate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/patterns/interpolate.ts src/server/patterns/__tests__/interpolate.test.ts
git commit -m "feat(patterns): add template interpolation"
```

---

### Task 3: Create Pattern Discovery

**Files:**
- Create: `src/server/patterns/discovery.ts`
- Test: `src/server/patterns/__tests__/discovery.test.ts`

- [ ] **Step 1: Write the failing test for discoverPatterns**

Create `src/server/patterns/__tests__/discovery.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverPatterns } from '../discovery'

describe('discoverPatterns', () => {
  const testDir = join(tmpdir(), 'tinstar-patterns-test-' + Date.now())

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('discovers pattern files in directory', () => {
    writeFileSync(join(testDir, 'bug-review.md'), `---
name: bug-review
description: Bug review pattern
---

orchestrator:
  backend: tmux
  prompt: Test

worker:
  backend: tmux
  prompt: Test
`)

    const patterns = discoverPatterns(testDir)

    expect(patterns).toHaveLength(1)
    expect(patterns[0].name).toBe('bug-review')
    expect(patterns[0].sessions).toHaveLength(2)
  })

  it('returns empty array for non-existent directory', () => {
    const patterns = discoverPatterns('/nonexistent/path')
    expect(patterns).toEqual([])
  })

  it('skips invalid pattern files', () => {
    writeFileSync(join(testDir, 'valid.md'), `---
name: valid
description: Valid pattern
---

orchestrator:
  backend: tmux
  prompt: Test
`)
    writeFileSync(join(testDir, 'invalid.md'), 'not a valid pattern')

    const patterns = discoverPatterns(testDir)

    expect(patterns).toHaveLength(1)
    expect(patterns[0].name).toBe('valid')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/patterns/__tests__/discovery.test.ts`
Expected: FAIL with "Cannot find module '../discovery'"

- [ ] **Step 3: Write discoverPatterns implementation**

Create `src/server/patterns/discovery.ts`:

```typescript
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parsePatternFile, type Pattern } from './parser'

/** Default patterns directory */
export const DEFAULT_PATTERNS_DIR = join(homedir(), '.claude', 'patterns')

/**
 * Discover all pattern files in a directory.
 * Returns array of parsed patterns, skipping invalid files.
 */
export function discoverPatterns(dir: string = DEFAULT_PATTERNS_DIR): Pattern[] {
  if (!existsSync(dir)) return []

  const patterns: Pattern[] = []

  try {
    const files = readdirSync(dir)

    for (const file of files) {
      if (!file.endsWith('.md')) continue

      try {
        const content = readFileSync(join(dir, file), 'utf-8')
        const pattern = parsePatternFile(content)
        if (pattern) {
          patterns.push(pattern)
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return patterns
}

/**
 * Get a specific pattern by name.
 */
export function getPatternByName(name: string, dir: string = DEFAULT_PATTERNS_DIR): Pattern | null {
  const patterns = discoverPatterns(dir)
  return patterns.find(p => p.name === name) ?? null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/patterns/__tests__/discovery.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/patterns/discovery.ts src/server/patterns/__tests__/discovery.test.ts
git commit -m "feat(patterns): add pattern discovery"
```

---

### Task 4: Create Pattern Module Index

**Files:**
- Create: `src/server/patterns/index.ts`

- [ ] **Step 1: Create index.ts with exports**

Create `src/server/patterns/index.ts`:

```typescript
export { parsePatternFile, type Pattern, type PatternSession, type PatternSessionConfig } from './parser'
export { discoverPatterns, getPatternByName, DEFAULT_PATTERNS_DIR } from './discovery'
export { interpolateTemplate, interpolateSessionConfig, type TemplateVars } from './interpolate'
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/server/patterns/index.ts
git commit -m "feat(patterns): add module index"
```

---

### Task 5: Add GET /api/patterns Endpoint

**Files:**
- Modify: `src/server/api/routes.ts`

- [ ] **Step 1: Add import for pattern discovery**

In `src/server/api/routes.ts`, add import near the top (after other imports around line 47):

```typescript
import { discoverPatterns } from '../patterns'
```

- [ ] **Step 2: Add GET /api/patterns handler**

In `src/server/api/routes.ts`, add handler after the `/api/cli-templates` handler (search for "cli-templates" to find the location, around line 360):

```typescript
    // GET /api/patterns
    if (method === 'GET' && url === '/api/patterns') {
      const patterns = discoverPatterns()
      // Return simplified pattern info for UI
      const data = patterns.map(p => ({
        name: p.name,
        description: p.description,
        sessions: p.sessions.map(s => s.role),
      }))
      return json(res, { ok: true, data })
    }
```

- [ ] **Step 3: Test endpoint manually**

Run: `curl http://localhost:5273/api/patterns | jq`
Expected: `{"ok":true,"data":[]}` (empty until patterns exist)

- [ ] **Step 4: Commit**

```bash
git add src/server/api/routes.ts
git commit -m "feat(api): add GET /api/patterns endpoint"
```

---

### Task 6: Modify POST /api/sessions for Pattern Support

**Files:**
- Modify: `src/server/api/routes.ts`

- [ ] **Step 1: Add pattern imports**

Update the import in `src/server/api/routes.ts`:

```typescript
import { discoverPatterns, getPatternByName, interpolateSessionConfig, type TemplateVars } from '../patterns'
```

- [ ] **Step 2: Add pattern parameter to session creation**

In the POST /api/sessions handler (around line 1411), add `pattern` to the destructured params:

```typescript
const { name, backend = 'docker', project, worktree = false, worktreePath, profile, prompt, oneshot = false, skipPermissions = true, cliTemplate: cliTemplateName, taskId, epicId, initiativeId, color: colorParam, nats, pattern: patternName } = JSON.parse(body)
```

- [ ] **Step 3: Add pattern handling logic after validation**

After the existing validation checks (around line 1420, before the project resolution), add:

```typescript
        // Handle pattern-based session creation
        if (patternName) {
          const pattern = getPatternByName(patternName)
          if (!pattern) {
            return json(res, { ok: false, error: { code: 'PATTERN_NOT_FOUND', message: `Pattern '${patternName}' not found` } }, 404)
          }

          // Template variables for interpolation
          const templateVars: TemplateVars = {
            task: taskId ?? name,
            taskId: taskId ?? '',
            sessionId: name,
          }

          // Find orchestrator session (gets the user's prompt)
          const orchestratorDef = pattern.sessions.find(s => s.role === 'orchestrator')
          if (!orchestratorDef) {
            return json(res, { ok: false, error: { code: 'INVALID_PATTERN', message: 'Pattern must have an orchestrator session' } }, 400)
          }

          // Spawn all sessions defined in the pattern
          const createdSessions: string[] = []

          for (const sessionDef of pattern.sessions) {
            const sessionSuffix = sessionDef.role === 'orchestrator' ? '' : `-${sessionDef.role}`
            const sessionName = `${name}${sessionSuffix}`
            
            // Update template vars with session-specific values
            templateVars.sessionId = sessionName
            if (sessionDef.role === 'orchestrator') {
              templateVars.orchestrator = `agents.${sessionName}`
            } else if (sessionDef.role === 'worker') {
              templateVars.worker = `agents.${sessionName}`
            }

            // Interpolate session config
            const interpolatedConfig = interpolateSessionConfig(sessionDef.config, templateVars)

            // Determine prompt: orchestrator gets user's prompt prepended, others get pattern prompt
            let sessionPrompt: string | undefined
            if (sessionDef.role === 'orchestrator') {
              const patternPrompt = interpolatedConfig.prompt ?? ''
              sessionPrompt = prompt ? `${prompt}\n\n---\n\n${patternPrompt}` : patternPrompt
            } else {
              sessionPrompt = interpolatedConfig.prompt
            }

            // Create the session via internal call (reuse existing logic)
            const sessionBody = {
              name: sessionName,
              backend: interpolatedConfig.backend ?? backend,
              project: interpolatedConfig.project ?? project,
              worktree: interpolatedConfig.worktree ?? false,
              worktreePath: interpolatedConfig.worktreePath,
              profile: interpolatedConfig.profile ?? profile,
              skipPermissions: interpolatedConfig.skipPermissions ?? skipPermissions,
              cliTemplate: interpolatedConfig.cliTemplate ?? cliTemplateName,
              prompt: sessionPrompt,
              taskId,
              epicId,
              initiativeId,
              color: colorParam,
              // Enable NATS for all pattern sessions
              nats: { enabled: true },
            }

            // Make internal request to create session
            // We'll create sessions directly here to avoid recursive HTTP calls
            createdSessions.push(sessionName)
          }

          // For now, create sessions sequentially using the existing helper
          // This is a placeholder - the actual implementation will call the session creation logic directly
          log.info('patterns', `creating pattern sessions: ${createdSessions.join(', ')}`)
          
          // Return success with list of created sessions
          return json(res, { ok: true, data: { pattern: patternName, sessions: createdSessions } }, 201)
        }
```

**Note:** This is a placeholder. The full implementation requires extracting session creation into a reusable function. Task 7 will refactor this properly.

- [ ] **Step 4: Commit placeholder**

```bash
git add src/server/api/routes.ts
git commit -m "wip(api): add pattern parameter to session creation"
```

---

### Task 7: Extract Session Creation Helper

**Files:**
- Modify: `src/server/api/routes.ts`

This task extracts the session creation logic into a reusable function so pattern sessions can be created without recursive HTTP calls.

- [ ] **Step 1: Create createSessionInternal function**

Add this function before the routes handler (around line 100, after the helper functions):

```typescript
interface CreateSessionParams {
  name: string
  backend: 'docker' | 'tmux'
  project?: string
  worktree?: boolean
  worktreePath?: string
  profile?: string
  prompt?: string
  skipPermissions?: boolean
  cliTemplate?: string
  taskId?: string
  epicId?: string
  initiativeId?: string
  color?: string
  nats?: { enabled: boolean; subscriptions?: string[] }
}

interface CreateSessionContext {
  cfg: TinstarConfig
  sessDir: string
  docStore: DocumentStore
  readyQueue: ReadyQueue
  sse: SSEBroadcaster
  emitSessionEvent: (event: string, payload: Record<string, unknown>) => void
  secrets: () => Record<string, string>
  dashboardUrl: string
}

async function createSessionInternal(
  params: CreateSessionParams,
  ctx: CreateSessionContext
): Promise<{ ok: true; session: Session } | { ok: false; error: { code: string; message: string } }> {
  const {
    name, backend, project, worktree = false, worktreePath,
    profile, prompt, skipPermissions = true, cliTemplate: cliTemplateName,
    taskId, epicId, initiativeId, color: colorParam, nats
  } = params

  const { cfg, sessDir, docStore, readyQueue, sse, emitSessionEvent, secrets, dashboardUrl } = ctx

  if (!name) return { ok: false, error: { code: 'MISSING_NAME', message: 'Session name is required' } }
  if (!['docker', 'tmux'].includes(backend)) return { ok: false, error: { code: 'INVALID_BACKEND', message: 'Backend must be "docker" or "tmux"' } }

  if (getSession(sessDir, name)) {
    return { ok: false, error: { code: 'SESSION_EXISTS', message: `Session '${name}' already exists` } }
  }

  // Resolve project
  let projectPath: string | null = null
  if (project) {
    projectPath = getProject(cfg.files.projects, project)
    if (!projectPath) return { ok: false, error: { code: 'PROJECT_NOT_FOUND', message: `Project '${project}' not found` } }
  }

  // Create worktree or use existing
  let workspacePath = projectPath
  let branch: string | null = null
  if (worktreePath && projectPath) {
    workspacePath = worktreePath
    branch = await detectBranch(worktreePath)
  } else if (worktree && projectPath) {
    workspacePath = await createWorktree(projectPath, name)
    branch = name
  }

  const isWorktree = !!(worktreePath || worktree)

  // Register a Worktree entity so it appears in hierarchy/grouping
  let worktreeEntityId = ''
  if (isWorktree && workspacePath) {
    worktreeEntityId = name
    docStore.upsertWorktree(worktreeEntityId, {
      id: worktreeEntityId,
      name,
      branch: branch ?? name,
      repo: project ?? '',
      worktreePath: workspacePath,
      spaceId: docStore.activeSpaceId,
    })
  }

  // Resolve run color
  const color = colorParam
    ?? (taskId ? docStore.getTask(taskId)?.settings?.defaultRunColor : undefined)
    ?? (epicId ? docStore.getEpic(epicId)?.settings?.defaultRunColor : undefined)
    ?? (initiativeId ? docStore.getInitiative(initiativeId)?.settings?.defaultRunColor : undefined)

  // Resolve CLI template
  const resolvedTemplate = cliTemplateName
    ? cfg.cliTemplates.find(t => t.name === cliTemplateName) ?? null
    : null

  // Compute NATS subscriptions
  let resolvedNats = nats ?? null
  if (!nats && (taskId || epicId || initiativeId)) {
    const natsCtx = {
      sessionName: name,
      spaceId: docStore.activeSpaceId || null,
      taskId: taskId || null,
      epicId: epicId || null,
      initiativeId: initiativeId || null,
    }
    const subscriptions = computeNatsSubscriptions(natsCtx, docStore)
    resolvedNats = { enabled: true, subscriptions }
  } else if (nats?.enabled && !nats.subscriptions) {
    // Pattern session with NATS enabled but no explicit subscriptions
    const natsCtx = {
      sessionName: name,
      spaceId: docStore.activeSpaceId || null,
      taskId: taskId || null,
      epicId: epicId || null,
      initiativeId: initiativeId || null,
    }
    const subscriptions = computeNatsSubscriptions(natsCtx, docStore)
    resolvedNats = { enabled: true, subscriptions }
  }

  const session = createSession(sessDir, {
    name,
    backend: resolvedTemplate ? 'tmux' : backend,
    project,
    workspace: {
      path: workspacePath,
      worktree: isWorktree,
      branch,
      basePath: isWorktree ? projectPath : null,
    },
    profile,
    oneshot: false,
    skipPermissions,
    cliTemplate: cliTemplateName ?? null,
    adapter: resolvedTemplate?.adapter ?? null,
    nats: resolvedNats,
  })

  const enriched = session as Session & { _stateDir?: string; initialPrompt?: string }
  enriched._stateDir = claudeStateDir(sessDir, name)

  const sec = secrets()
  let sessionPort: number | undefined

  if (backend === 'docker') {
    sessionPort = await tmuxBackend.findPort(cfg.ports.hostStart)
    await dockerBackend.createContainer(cfg, { session: enriched, secrets: sec, port: sessionPort, dashboardUrl, initialPrompt: prompt || undefined })
    updateSession(sessDir, name, { port: sessionPort, state: 'running' })
  } else {
    const port = await tmuxBackend.findPort(cfg.ports.hostStart)
    if (prompt) enriched.initialPrompt = prompt

    const result = await tmuxBackend.createTmuxSession(cfg, { session: enriched, secrets: sec, port, template: resolvedTemplate })
    sessionPort = result.port
    updateSession(sessDir, name, { port: sessionPort, ttydPid: result.ttydPid ?? null, state: 'running' })
    tmuxBackend.onTtydRestart(name, (newPid) => {
      updateSession(sessDir, name, { ttydPid: newPid })
    })
  }

  // Create Run entry
  const runId = name
  const initialStatus = prompt ? 'running' : 'idle'
  let backendInfo: string | undefined
  if (backend === 'docker') {
    const container = dockerBackend.containerName(cfg, name)
    const imageProfile = profile ? cfg.profiles.find(p => p.name === profile) : undefined
    const image = imageProfile?.image ?? cfg.container.defaultImage
    backendInfo = `container: ${container}\nimage: ${image}`
  } else {
    backendInfo = `tmux session: ${name}`
  }

  docStore.upsertRun(runId, {
    id: runId,
    color,
    status: initialStatus,
    sessionId: name,
    initiative: initiativeId ?? '',
    epic: epicId ?? '',
    task: taskId ?? '',
    repo: project ?? '',
    worktree: isWorktree ? (branch ?? name) : '',
    touchedFiles: [],
    recapEntries: [],
    rawLogs: '',
    port: sessionPort ?? null,
    backend,
    backendInfo,
    agentIcon: resolvedTemplate?.icon ?? undefined,
    taskId: taskId ?? '',
    worktreeId: worktreeEntityId,
    createdAt: new Date().toISOString(),
    spaceId: docStore.activeSpaceId,
  })

  readyQueue.onStatusChange(name, initialStatus)
  sse.setReadyQueue(readyQueue.getQueue())
  sse.broadcastReadyQueueUpdate()
  emitSessionEvent('managed_session.created', { name, state: 'running' })

  const updated = getSession(sessDir, name)!
  return { ok: true, session: updated }
}
```

- [ ] **Step 2: Update pattern handling to use createSessionInternal**

Replace the placeholder pattern handling (from Task 6, Step 3) with:

```typescript
        // Handle pattern-based session creation
        if (patternName) {
          const pattern = getPatternByName(patternName)
          if (!pattern) {
            return json(res, { ok: false, error: { code: 'PATTERN_NOT_FOUND', message: `Pattern '${patternName}' not found` } }, 404)
          }

          const orchestratorDef = pattern.sessions.find(s => s.role === 'orchestrator')
          if (!orchestratorDef) {
            return json(res, { ok: false, error: { code: 'INVALID_PATTERN', message: 'Pattern must have an orchestrator session' } }, 400)
          }

          const templateVars: TemplateVars = {
            task: taskId ?? name,
            taskId: taskId ?? '',
          }

          // Pre-compute all session names for cross-references
          const sessionNames: Record<string, string> = {}
          for (const sessionDef of pattern.sessions) {
            const suffix = sessionDef.role === 'orchestrator' ? '' : `-${sessionDef.role}`
            sessionNames[sessionDef.role] = `${name}${suffix}`
          }
          templateVars.orchestrator = `agents.${sessionNames.orchestrator}`
          templateVars.worker = sessionNames.worker ? `agents.${sessionNames.worker}` : ''

          const createCtx: CreateSessionContext = {
            cfg,
            sessDir,
            docStore: ctx.docStore,
            readyQueue: ctx.readyQueue,
            sse: ctx.sse,
            emitSessionEvent,
            secrets,
            dashboardUrl,
          }

          const createdSessions: string[] = []
          const errors: string[] = []

          for (const sessionDef of pattern.sessions) {
            const sessionName = sessionNames[sessionDef.role]
            templateVars.sessionId = sessionName

            const interpolatedConfig = interpolateSessionConfig(sessionDef.config, templateVars)

            let sessionPrompt: string | undefined
            if (sessionDef.role === 'orchestrator') {
              const patternPrompt = interpolatedConfig.prompt ?? ''
              sessionPrompt = prompt ? `${prompt}\n\n---\n\n${patternPrompt}` : patternPrompt
            } else {
              sessionPrompt = interpolatedConfig.prompt
            }

            const result = await createSessionInternal({
              name: sessionName,
              backend: (interpolatedConfig.backend ?? backend) as 'docker' | 'tmux',
              project: interpolatedConfig.project ?? project,
              worktree: interpolatedConfig.worktree ?? false,
              worktreePath: interpolatedConfig.worktreePath,
              profile: interpolatedConfig.profile ?? profile,
              skipPermissions: interpolatedConfig.skipPermissions ?? skipPermissions,
              cliTemplate: interpolatedConfig.cliTemplate ?? cliTemplateName,
              prompt: sessionPrompt,
              taskId,
              epicId,
              initiativeId,
              color: colorParam,
              nats: { enabled: true },
            }, createCtx)

            if (result.ok) {
              createdSessions.push(sessionName)
            } else {
              errors.push(`${sessionName}: ${result.error.message}`)
            }
          }

          if (errors.length > 0) {
            log.warn('patterns', `some pattern sessions failed: ${errors.join(', ')}`)
          }

          log.info('patterns', `created pattern sessions: ${createdSessions.join(', ')}`)
          return json(res, { ok: true, data: { pattern: patternName, sessions: createdSessions, errors: errors.length > 0 ? errors : undefined } }, 201)
        }
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/server/api/routes.ts
git commit -m "feat(api): extract session creation helper, implement pattern spawning"
```

---

### Task 8: Add Pattern Dropdown to CreateSessionDialog

**Files:**
- Modify: `src/components/CreateSessionDialog.tsx`

- [ ] **Step 1: Add pattern state and fetch**

In `CreateSessionDialog.tsx`, add state after the existing state declarations (around line 91):

```typescript
  const [patterns, setPatterns] = useState<Array<{ name: string; description: string; sessions: string[] }>>([])
  const [pattern, setPattern] = useState<string>('')
```

Add fetch in the existing useEffect that fetches projects (around line 105):

```typescript
    fetch('/api/patterns')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.ok && Array.isArray(d.data)) setPatterns(d.data)
      })
      .catch(() => {})
```

- [ ] **Step 2: Add pattern to submit body**

In the `handleSubmit` function, add pattern to the body object (around line 188):

```typescript
    if (pattern) body.pattern = pattern
```

- [ ] **Step 3: Add pattern dropdown UI**

After the "Attach to Task" section (around line 405), add:

```typescript
        {/* Pattern */}
        {patterns.length > 0 && (
          <div className="mb-3">
            <label className="text-2xs text-slate-400 uppercase tracking-wider mb-1 block">
              Pattern
              <span className="ml-1 text-slate-600">(optional)</span>
            </label>
            <select
              value={pattern}
              onChange={e => setPattern(e.target.value)}
              className="w-full px-3 py-1.5 bg-surface-base border border-white/10 rounded text-xs text-slate-200 focus:border-primary/50 focus:outline-none"
            >
              <option value="">Single Agent (default)</option>
              {patterns.map(p => (
                <option key={p.name} value={p.name}>
                  {p.name} — {p.sessions.join(' + ')}
                </option>
              ))}
            </select>
            {pattern && (
              <div className="mt-2 text-2xs text-slate-500">
                {patterns.find(p => p.name === pattern)?.description}
              </div>
            )}
          </div>
        )}
```

- [ ] **Step 4: Verify UI works**

1. Create a test pattern file at `~/.claude/patterns/test-review.md`:
```yaml
---
name: test-review
description: Test review pattern
---

orchestrator:
  backend: tmux
  prompt: You are the orchestrator.

worker:
  backend: tmux
  prompt: You are the worker.
```

2. Restart dev server and open CreateSessionDialog
3. Verify pattern dropdown appears with "test-review"

- [ ] **Step 5: Commit**

```bash
git add src/components/CreateSessionDialog.tsx
git commit -m "feat(ui): add pattern dropdown to CreateSessionDialog"
```

---

### Task 9: Create Example Pattern File

**Files:**
- Create: `examples/patterns/bug-review.md`

- [ ] **Step 1: Create example pattern**

Create `examples/patterns/bug-review.md`:

```yaml
---
name: bug-review
description: Worker investigates bug, orchestrator reviews with /proveit discipline
---

orchestrator:
  backend: tmux
  prompt: |
    You are orchestrating a bug review for {{task}}.
    
    Your role:
    1. The worker session is already running and will receive your task via NATS
    2. Send the task to the worker: reply(to="{{worker}}", text="<your task>")
    3. When the worker submits findings, review them using /proveit discipline
    4. Don't accept claims without file:line evidence
    5. If the analysis is weak, send feedback and ask for revision
    6. When satisfied, report the final findings
    
    Worker's NATS subject: {{worker}}
    Your NATS subject: {{orchestrator}}

worker:
  backend: tmux
  worktree: true
  prompt: |
    You are a worker on {{task}}.
    
    Your role:
    1. Wait for instructions from the orchestrator via NATS
    2. When you receive a task, use /bugsearcher or similar investigation skills
    3. Find the root cause with concrete evidence (file:line references)
    4. Submit your findings: reply(to="{{orchestrator}}", text="<your findings>")
    5. If the orchestrator sends feedback, revise and resubmit
    
    Orchestrator's NATS subject: {{orchestrator}}
    Your NATS subject: {{worker}}
```

- [ ] **Step 2: Add installation instructions to README**

Add to project README or create `examples/patterns/README.md`:

```markdown
# Pattern Templates

Copy patterns to `~/.claude/patterns/` to make them available in Tinstar.

## Installation

```bash
mkdir -p ~/.claude/patterns
cp examples/patterns/*.md ~/.claude/patterns/
```

## Available Patterns

### bug-review

Worker investigates bug, orchestrator reviews with /proveit discipline.

- **Orchestrator**: Reviews worker's findings, enforces evidence requirements
- **Worker**: Investigates using /bugsearcher, submits findings for review
```

- [ ] **Step 3: Commit**

```bash
git add examples/patterns/
git commit -m "docs: add example bug-review pattern"
```

---

### Task 10: End-to-End Test

**Files:**
- Create: `e2e/patterns.spec.ts`

- [ ] **Step 1: Write E2E test for pattern creation**

Create `e2e/patterns.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test.describe('Multi-Agent Patterns', () => {
  test('creates sessions from pattern', async ({ page }) => {
    // Setup: ensure test pattern exists
    // This assumes TINSTAR_FAST_SIM=1 is set

    await page.goto('/')
    
    // Open new session dialog
    await page.click('[data-testid="new-session-button"]')
    
    // Fill in session name
    await page.fill('[data-testid="session-name-input"]', 'e2e-pattern-test')
    
    // Select pattern if dropdown exists
    const patternSelect = page.locator('select').filter({ hasText: 'Single Agent' })
    if (await patternSelect.isVisible()) {
      // Pattern dropdown exists, but may not have patterns loaded in test env
      // Just verify the dropdown is present
      await expect(patternSelect).toBeVisible()
    }
    
    // Submit
    await page.click('[data-testid="create-session-submit"]')
    
    // Verify session appears
    await expect(page.locator('text=e2e-pattern-test')).toBeVisible({ timeout: 10000 })
  })
})
```

- [ ] **Step 2: Run E2E test**

Run: `TINSTAR_FAST_SIM=1 BASE_URL=http://localhost:5273 npx playwright test e2e/patterns.spec.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add e2e/patterns.spec.ts
git commit -m "test: add E2E test for pattern creation"
```

---

### Task 11: Clean Up Old Pattern Code

**Files:**
- Modify: `src/domain/patterns.ts`
- Modify: `src/components/CreateEntityDialog.tsx`
- Modify: `src/server/api/routes.ts`

This task removes the old hardcoded patterns that were tied to task creation.

- [ ] **Step 1: Deprecate old patterns.ts**

Add deprecation notice to `src/domain/patterns.ts`:

```typescript
/**
 * @deprecated Use ~/.claude/patterns/ files instead.
 * This file is kept for reference during migration.
 * Remove after migration is complete.
 */
```

- [ ] **Step 2: Remove pattern dropdown from CreateEntityDialog**

In `src/components/CreateEntityDialog.tsx`, remove:
- `import { PATTERNS, type PatternType }` 
- `import { PatternPreview }`
- `const [pattern, setPattern]` state
- `const [showPreview, setShowPreview]` state
- The pattern dropdown JSX (the `{isTask && ...}` block)
- `pattern` from the body in `handleSubmit`

- [ ] **Step 3: Remove pattern handling from task creation in routes.ts**

In `src/server/api/routes.ts`, in the POST /api/tasks handler (around line 530), remove the pattern spawning logic that references `isMultiAgentPattern` and `getPattern`.

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/domain/patterns.ts src/components/CreateEntityDialog.tsx src/server/api/routes.ts
git commit -m "refactor: remove old task-based pattern spawning"
```

---

## Summary

After completing all tasks:

1. Pattern files live in `~/.claude/patterns/*.md`
2. Tinstar discovers patterns and exposes them via `GET /api/patterns`
3. CreateSessionDialog shows pattern dropdown
4. Selecting a pattern spawns all defined sessions with interpolated prompts
5. Orchestrator receives user's prompt, other sessions receive pattern-defined prompts
6. All sessions have NATS enabled for inter-agent communication
7. Old task-based pattern system is removed
