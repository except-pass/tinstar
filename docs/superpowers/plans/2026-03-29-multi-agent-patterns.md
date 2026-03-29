# Multi-Agent Pattern Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to create multi-agent tasks by selecting a pattern (Sequential, Parallel, Coordinator, Review & Critique) that scaffolds multiple sessions with auto-wired NATS subscriptions and pattern-specific instructions.

**Architecture:** Pattern definitions are hardcoded in a shared module. When a task is created with a pattern, the backend spawns all sessions in a batch with computed NATS subjects. The frontend arranges spawned widgets in the pattern's canonical layout. The traffic widget is simplified to remove single-agent bias.

**Tech Stack:** React, TypeScript, existing session management APIs, NATS subscriptions

---

## File Structure

**New files:**
- `src/domain/patterns.ts` — Pattern definitions (sessions, layouts, instructions)
- `src/components/PatternPreview.tsx` — Inline preview component for task creation dialog

**Modified files:**
- `src/components/CreateEntityDialog.tsx` — Add pattern dropdown for task creation
- `src/server/api/routes.ts` — Handle pattern in POST /api/tasks, spawn sessions
- `src/widgets/natsTraffic/NatsTrafficWidget.tsx` — Remove direction bias, show sender→recipient
- `src/hooks/useWidgetLayouts.ts` — Add pattern-aware layout generation

---

### Task 1: Define Pattern Types and Data

**Files:**
- Create: `src/domain/patterns.ts`

- [ ] **Step 1: Create the patterns module with type definitions**

```typescript
// src/domain/patterns.ts

export type PatternType = 'single' | 'sequential' | 'parallel' | 'coordinator' | 'review-critique'

export interface PatternSession {
  nameSuffix: string  // e.g., "coordinator", "stage-1"
  role: string        // Human-readable role
  instructions: string
}

export interface PatternLayout {
  // Relative positions (0-1) within the pattern's bounding box
  positions: Array<{ nameSuffix: string; x: number; y: number }>
}

export interface PatternDefinition {
  type: PatternType
  label: string
  description: string
  sessions: PatternSession[]
  layout: PatternLayout
}

export const PATTERNS: Record<PatternType, PatternDefinition> = {
  single: {
    type: 'single',
    label: 'Single Agent',
    description: 'One agent handles the full task autonomously.',
    sessions: [],  // Empty means use default single-session behavior
    layout: { positions: [] },
  },

  sequential: {
    type: 'sequential',
    label: 'Sequential (Pipeline)',
    description: 'Agents run in order. Each output feeds the next.',
    sessions: [
      {
        nameSuffix: 'coordinator',
        role: 'Entry Point',
        instructions: `You are the entry point for this pipeline. When you receive a task:
1. Begin processing and prepare the initial data or analysis
2. Publish your output to the next stage using: nats_publish subject=tinstar.{task}.stage-1
3. Include all context the next stage needs to continue

You are the first link in a chain. Focus on preparing work for downstream agents.`,
      },
      {
        nameSuffix: 'stage-1',
        role: 'Stage 1',
        instructions: `You are Stage 1 in a sequential pipeline. When you receive input:
1. Process the input according to your specialty
2. Publish your output to Stage 2 using: nats_publish subject=tinstar.{task}.stage-2
3. Pass along all relevant context

Focus on your step of the pipeline. Trust that previous stages prepared the work correctly.`,
      },
      {
        nameSuffix: 'stage-2',
        role: 'Stage 2',
        instructions: `You are Stage 2 in a sequential pipeline. When you receive input:
1. Process the input according to your specialty
2. Publish your output to Stage 3 using: nats_publish subject=tinstar.{task}.stage-3
3. Pass along all relevant context

Focus on your step of the pipeline. Trust that previous stages prepared the work correctly.`,
      },
      {
        nameSuffix: 'stage-3',
        role: 'Final Stage',
        instructions: `You are the final stage in a sequential pipeline. When you receive input:
1. Complete the final processing step
2. Synthesize all work into a final deliverable
3. The pipeline is complete when you finish

You produce the final output. Make it polished and complete.`,
      },
    ],
    layout: {
      positions: [
        { nameSuffix: 'coordinator', x: 0, y: 0.5 },
        { nameSuffix: 'stage-1', x: 0.25, y: 0.5 },
        { nameSuffix: 'stage-2', x: 0.5, y: 0.5 },
        { nameSuffix: 'stage-3', x: 0.75, y: 0.5 },
      ],
    },
  },

  parallel: {
    type: 'parallel',
    label: 'Parallel (Fan-out)',
    description: 'Coordinator fans out to specialists. Aggregator collects results.',
    sessions: [
      {
        nameSuffix: 'coordinator',
        role: 'Coordinator',
        instructions: `You are the coordinator for a parallel fan-out pattern. When you receive a task:
1. Break the task into independent subtasks suitable for parallel processing
2. Fan out to all specialists simultaneously:
   - nats_publish subject=tinstar.{task}.specialist-1 with their subtask
   - nats_publish subject=tinstar.{task}.specialist-2 with their subtask
   - nats_publish subject=tinstar.{task}.specialist-3 with their subtask
3. Tell each specialist to reply to: tinstar.{task}.aggregator

You orchestrate the work. Make sure each specialist has clear, independent instructions.`,
      },
      {
        nameSuffix: 'specialist-1',
        role: 'Specialist 1',
        instructions: `You are Specialist 1 in a parallel pattern. When you receive a subtask:
1. Process your assigned portion of the work
2. Publish your result to the aggregator using the replyTo subject provided
3. Include enough context for the aggregator to synthesize your contribution

Focus on your specialty. Work independently and report your findings.`,
      },
      {
        nameSuffix: 'specialist-2',
        role: 'Specialist 2',
        instructions: `You are Specialist 2 in a parallel pattern. When you receive a subtask:
1. Process your assigned portion of the work
2. Publish your result to the aggregator using the replyTo subject provided
3. Include enough context for the aggregator to synthesize your contribution

Focus on your specialty. Work independently and report your findings.`,
      },
      {
        nameSuffix: 'specialist-3',
        role: 'Specialist 3',
        instructions: `You are Specialist 3 in a parallel pattern. When you receive a subtask:
1. Process your assigned portion of the work
2. Publish your result to the aggregator using the replyTo subject provided
3. Include enough context for the aggregator to synthesize your contribution

Focus on your specialty. Work independently and report your findings.`,
      },
      {
        nameSuffix: 'aggregator',
        role: 'Aggregator',
        instructions: `You are the aggregator for a parallel pattern. Your job:
1. Collect results from all 3 specialists
2. Wait until you have heard from all of them before synthesizing
3. Combine their contributions into a unified final result

You synthesize parallel work into a coherent whole. Be patient and thorough.`,
      },
    ],
    layout: {
      positions: [
        { nameSuffix: 'coordinator', x: 0.5, y: 0 },
        { nameSuffix: 'specialist-1', x: 0.15, y: 0.5 },
        { nameSuffix: 'specialist-2', x: 0.5, y: 0.5 },
        { nameSuffix: 'specialist-3', x: 0.85, y: 0.5 },
        { nameSuffix: 'aggregator', x: 0.5, y: 1 },
      ],
    },
  },

  coordinator: {
    type: 'coordinator',
    label: 'Coordinator (Router)',
    description: 'Central coordinator routes requests to appropriate specialists.',
    sessions: [
      {
        nameSuffix: 'coordinator',
        role: 'Coordinator',
        instructions: `You are a routing coordinator. When you receive a request:
1. Analyze the request to determine which specialist should handle it
2. Route to the appropriate specialist:
   - tinstar.{task}.specialist-1 for [domain 1]
   - tinstar.{task}.specialist-2 for [domain 2]
   - tinstar.{task}.specialist-3 for [domain 3]
3. Include the original replyTo so specialists can respond directly

You are a smart router. Classify requests accurately and delegate appropriately.`,
      },
      {
        nameSuffix: 'specialist-1',
        role: 'Specialist 1',
        instructions: `You are Specialist 1, handling requests in your domain. When you receive work:
1. Handle the request according to your expertise
2. Reply to the replyTo subject provided with your response

Focus on your specialty. Handle requests in your domain thoroughly.`,
      },
      {
        nameSuffix: 'specialist-2',
        role: 'Specialist 2',
        instructions: `You are Specialist 2, handling requests in your domain. When you receive work:
1. Handle the request according to your expertise
2. Reply to the replyTo subject provided with your response

Focus on your specialty. Handle requests in your domain thoroughly.`,
      },
      {
        nameSuffix: 'specialist-3',
        role: 'Specialist 3',
        instructions: `You are Specialist 3, handling requests in your domain. When you receive work:
1. Handle the request according to your expertise
2. Reply to the replyTo subject provided with your response

Focus on your specialty. Handle requests in your domain thoroughly.`,
      },
    ],
    layout: {
      positions: [
        { nameSuffix: 'coordinator', x: 0.5, y: 0.5 },
        { nameSuffix: 'specialist-1', x: 0.15, y: 0.15 },
        { nameSuffix: 'specialist-2', x: 0.85, y: 0.15 },
        { nameSuffix: 'specialist-3', x: 0.5, y: 0.9 },
      ],
    },
  },

  'review-critique': {
    type: 'review-critique',
    label: 'Review & Critique',
    description: 'Generator creates work, critic reviews until approval.',
    sessions: [
      {
        nameSuffix: 'coordinator',
        role: 'Generator',
        instructions: `You are the generator in a review loop. Your workflow:
1. When you receive a task, produce your best work
2. Send your work to the critic: nats_publish subject=tinstar.{task}.critic
3. If the critic sends feedback, revise and resubmit
4. If the critic sends APPROVED, you're done

Iterate based on feedback. Improve with each revision.`,
      },
      {
        nameSuffix: 'critic',
        role: 'Critic',
        instructions: `You are the critic in a review loop. When you receive work:
1. Evaluate the work against quality criteria
2. If it meets standards: reply with "APPROVED" and a brief summary
3. If it needs improvement: reply with specific, actionable feedback

Be constructive but rigorous. Help the generator improve.`,
      },
    ],
    layout: {
      positions: [
        { nameSuffix: 'coordinator', x: 0.25, y: 0.5 },
        { nameSuffix: 'critic', x: 0.75, y: 0.5 },
      ],
    },
  },
}

export function getPattern(type: PatternType): PatternDefinition {
  return PATTERNS[type]
}

export function isMultiAgentPattern(type: PatternType): boolean {
  return type !== 'single' && PATTERNS[type].sessions.length > 0
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit src/domain/patterns.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/domain/patterns.ts
git commit -m "feat: add multi-agent pattern definitions"
```

---

### Task 2: Create Pattern Preview Component

**Files:**
- Create: `src/components/PatternPreview.tsx`

- [ ] **Step 1: Create the preview component**

```typescript
// src/components/PatternPreview.tsx

import { PATTERNS, type PatternType } from '../domain/patterns'

interface Props {
  pattern: PatternType
}

export function PatternPreview({ pattern }: Props) {
  const def = PATTERNS[pattern]

  if (pattern === 'single' || def.sessions.length === 0) {
    return (
      <div className="text-xs text-slate-500 italic">
        Standard single-agent session
      </div>
    )
  }

  return (
    <div className="bg-surface-base border border-white/10 rounded p-3 mt-2">
      {/* Mini diagram */}
      <div className="relative h-20 mb-3">
        {def.layout.positions.map((pos, i) => {
          const session = def.sessions.find(s => s.nameSuffix === pos.nameSuffix)
          if (!session) return null
          const isCoordinator = pos.nameSuffix === 'coordinator'
          return (
            <div
              key={pos.nameSuffix}
              className={`absolute px-2 py-1 text-2xs rounded border transform -translate-x-1/2 -translate-y-1/2 ${
                isCoordinator
                  ? 'bg-primary/20 border-primary/40 text-primary'
                  : 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
              }`}
              style={{
                left: `${pos.x * 100}%`,
                top: `${pos.y * 100}%`,
              }}
            >
              {pos.nameSuffix}
            </div>
          )
        })}
      </div>

      {/* Description */}
      <div className="text-xs text-slate-400 mb-2">{def.description}</div>

      {/* Sessions list */}
      <div className="text-2xs text-slate-500">
        <span className="text-slate-400">Creates:</span>{' '}
        {def.sessions.map(s => s.nameSuffix).join(', ')}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit src/components/PatternPreview.tsx`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/PatternPreview.tsx
git commit -m "feat: add PatternPreview component for task creation"
```

---

### Task 3: Add Pattern Dropdown to CreateEntityDialog

**Files:**
- Modify: `src/components/CreateEntityDialog.tsx`

- [ ] **Step 1: Import pattern types and preview**

Add imports at top of file:

```typescript
import { PATTERNS, type PatternType } from '../domain/patterns'
import { PatternPreview } from './PatternPreview'
```

- [ ] **Step 2: Add pattern state (only for tasks)**

Inside `CreateEntityDialog` component, after existing state declarations, add:

```typescript
const [pattern, setPattern] = useState<PatternType>('single')
const [showPreview, setShowPreview] = useState(false)
const isTask = dialog.childType === 'task'
```

- [ ] **Step 3: Add pattern to request body**

In the `handleSubmit` function, modify the body construction to include pattern for tasks:

```typescript
const body: Record<string, string> = { name: trimmedName, id }

// Set parent foreign key
const fkField = parentKeyField(dialog.parentType)
if (fkField && dialog.parentId) {
  body[fkField] = dialog.parentId
}

// For initiatives, include color
if (dialog.childType === 'initiative') {
  body.color = color
}

// For tasks, include pattern if not single
if (dialog.childType === 'task' && pattern !== 'single') {
  body.pattern = pattern
}
```

- [ ] **Step 4: Add pattern dropdown UI (after name input, only for tasks)**

After the name input and before the initiative color picker, add:

```typescript
{isTask && (
  <div className="mt-3">
    <div className="flex items-center gap-2">
      <label className="text-xs text-slate-400">Pattern</label>
      <button
        type="button"
        onClick={() => setShowPreview(!showPreview)}
        className="text-2xs text-slate-500 hover:text-slate-300"
      >
        {showPreview ? 'hide' : '? preview'}
      </button>
    </div>
    <select
      value={pattern}
      onChange={e => setPattern(e.target.value as PatternType)}
      className="w-full mt-1 px-3 py-2 bg-surface-base border border-white/10 rounded text-sm text-slate-200 focus:border-primary/50 focus:outline-none"
    >
      {Object.values(PATTERNS).map(p => (
        <option key={p.type} value={p.type}>
          {p.label}
        </option>
      ))}
    </select>
    {showPreview && <PatternPreview pattern={pattern} />}
  </div>
)}
```

- [ ] **Step 5: Verify the file compiles**

Run: `npx tsc --noEmit src/components/CreateEntityDialog.tsx`
Expected: No errors

- [ ] **Step 6: Test manually**

1. Run `npm run dev`
2. Open http://infrapoc:5280
3. Create a new task under an epic
4. Verify pattern dropdown appears
5. Select "Parallel" and click "? preview"
6. Verify preview shows the pattern diagram and session list

- [ ] **Step 7: Commit**

```bash
git add src/components/CreateEntityDialog.tsx
git commit -m "feat: add pattern dropdown to task creation dialog"
```

---

### Task 4: Backend — Handle Pattern in Task Creation

**Files:**
- Modify: `src/server/api/routes.ts`

- [ ] **Step 1: Import pattern helpers**

Add import near top of file:

```typescript
import { getPattern, isMultiAgentPattern, type PatternType } from '../../domain/patterns'
```

- [ ] **Step 2: Find the POST /api/tasks handler**

Locate this block (around line 512-530):

```typescript
// POST /api/tasks
if (method === 'POST' && url === '/api/tasks') {
```

- [ ] **Step 3: Extract pattern from request body**

Modify the body parsing to include pattern:

```typescript
const { name, epicId, initiativeId, status, id: providedId, percentDone, externalUrl, pattern } = JSON.parse(body)
```

- [ ] **Step 4: Store pattern on task entity (optional metadata)**

After creating the entity object, before upserting:

```typescript
const entity = {
  id: providedId ?? shortId('task'),
  name: name ?? 'Untitled Task',
  epicId: epicId ?? '',
  initiativeId: initiativeId ?? '',
  status: status ?? 'active',
  spaceId: ctx.docStore.activeSpaceId,
  percentDone: percentDone ?? null,
  externalUrl: externalUrl ?? null,
}
ctx.docStore.upsertTask(entity.id, entity)
```

- [ ] **Step 5: Spawn pattern sessions after task creation**

After `ctx.docStore.upsertTask(entity.id, entity)`, add session spawning logic:

```typescript
// If pattern specified, spawn multi-agent sessions
const patternType = (pattern as PatternType) ?? 'single'
if (isMultiAgentPattern(patternType)) {
  const patternDef = getPattern(patternType)

  for (const sessionDef of patternDef.sessions) {
    const sessionName = `${entity.id}-${sessionDef.nameSuffix}`

    // Compute NATS subscriptions for this session
    const natsCtx = {
      sessionName,
      taskId: entity.id,
      epicId: entity.epicId || null,
      initiativeId: entity.initiativeId || null,
    }
    const subscriptions = computeNatsSubscriptions(natsCtx, ctx.docStore)

    // Create session with pattern instructions
    const session = createSession(ctx.sessionsDir, {
      name: sessionName,
      backend: 'tmux',
      nats: {
        enabled: true,
        subscriptions,
      },
    })

    // Store session instructions for later injection
    // (Instructions get injected when terminal starts via cliTemplate or direct injection)
    const instructionsPath = join(ctx.sessionsDir, sessionName, 'pattern-instructions.md')
    const resolvedInstructions = sessionDef.instructions
      .replace(/\{task\}/g, entity.id)
    writeFileSync(instructionsPath, resolvedInstructions)

    // Create run entry
    const runId = shortId('run')
    ctx.docStore.upsertRun(runId, {
      id: runId,
      name: sessionName,
      status: session.state,
      taskId: entity.id,
      worktreeId: '',
      createdAt: new Date().toISOString(),
      spaceId: ctx.docStore.activeSpaceId,
    })
  }
}

json(res, entity, 201)
```

- [ ] **Step 6: Add required imports at top of routes.ts**

```typescript
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeNatsSubscriptions } from '../sessions/nats-subscriptions'
import { createSession } from '../sessions/session'
```

- [ ] **Step 7: Verify the file compiles**

Run: `npx tsc --noEmit src/server/api/routes.ts`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/server/api/routes.ts
git commit -m "feat: spawn multi-agent sessions when task created with pattern"
```

---

### Task 5: Pattern-Aware Canvas Layout

**Files:**
- Modify: `src/hooks/useWidgetLayouts.ts`

- [ ] **Step 1: Import pattern helpers**

Add import:

```typescript
import { PATTERNS, type PatternType } from '../domain/patterns'
```

- [ ] **Step 2: Add pattern layout helper function**

Add this function before `generateDefaultLayouts`:

```typescript
/**
 * Compute layout offsets for multi-agent pattern sessions.
 * Returns a map of session name suffix to {dx, dy} offsets relative to task container.
 */
function getPatternOffsets(pattern: PatternType): Map<string, { dx: number; dy: number }> {
  const offsets = new Map<string, { dx: number; dy: number }>()
  const def = PATTERNS[pattern]
  if (!def || def.sessions.length === 0) return offsets

  // Pattern layout is in 0-1 relative coords. Convert to pixel offsets.
  // Assume a bounding box of 1800x1200 for the pattern layout.
  const PATTERN_WIDTH = 1800
  const PATTERN_HEIGHT = 1200

  for (const pos of def.layout.positions) {
    offsets.set(pos.nameSuffix, {
      dx: pos.x * PATTERN_WIDTH,
      dy: pos.y * PATTERN_HEIGHT,
    })
  }

  return offsets
}
```

- [ ] **Step 3: Modify run layout generation to use pattern offsets**

In the `generateDefaultLayouts` function, inside the `computeSize` function where non-container nodes are handled, we need to check if the node is part of a pattern and position accordingly.

This is complex because the pattern info isn't on the TreeNode. For now, we'll handle this in a simpler way: runs within the same task will be laid out in a grid, and the initial positions will be set when the runs are created.

Actually, a cleaner approach: when spawning pattern sessions, compute their initial positions and store them on the Run entity. Then the layout system reads those positions.

- [ ] **Step 4: Add position fields to Run entity (simpler approach)**

For now, skip this task's complex layout logic. The sessions will spawn and use default grid layout. We can enhance layout later.

- [ ] **Step 5: Commit placeholder**

```bash
git commit --allow-empty -m "chore: placeholder for pattern-aware layout (deferred)"
```

---

### Task 6: Simplify NatsTrafficWidget

**Files:**
- Modify: `src/widgets/natsTraffic/NatsTrafficWidget.tsx`

- [ ] **Step 1: Remove direction column from table header**

Find the thead section and change:

```typescript
<thead className="sticky top-0 bg-surface-panel text-slate-400">
  <tr>
    <th className="px-2 py-1 text-left w-16">Time</th>
    <th className="px-2 py-1 text-left w-12">Dir</th>
    <th className="px-2 py-1 text-left w-24">ReplyTo</th>
```

Change to:

```typescript
<thead className="sticky top-0 bg-surface-panel text-slate-400">
  <tr>
    <th className="px-2 py-1 text-left w-16">Time</th>
    <th className="px-2 py-1 text-left w-32">Flow</th>
    <th className="px-2 py-1 text-left w-24">ReplyTo</th>
```

- [ ] **Step 2: Add helper to parse sender from subject**

Add this helper function before the component:

```typescript
function parseSenderRecipient(event: TrafficEvent): { sender: string; recipient: string } {
  // Subject format: tinstar.<init>.<epic>.<task>.<session-name>
  // or: agents.<session-name>
  const parts = event.subject.split('.')
  const recipient = parts[parts.length - 1] || event.subject

  // 'from' field contains the sender name
  const sender = event.from || 'unknown'

  return { sender, recipient }
}
```

- [ ] **Step 3: Replace direction cell with flow cell in table body**

Find the direction cell:

```typescript
<td className="px-2 py-1 whitespace-nowrap">
  {e.direction === 'inbound' ? '<-' : '->'}
</td>
```

Replace with:

```typescript
<td className="px-2 py-1 whitespace-nowrap text-slate-300">
  {(() => {
    const { sender, recipient } = parseSenderRecipient(e)
    return (
      <span>
        <span className="text-cyan-400">{sender}</span>
        <span className="text-slate-500"> → </span>
        <span className="text-amber-400">{recipient}</span>
      </span>
    )
  })()}
</td>
```

- [ ] **Step 4: Remove direction-based row coloring**

Find the row className that uses direction:

```typescript
className={`border-b border-white/5 cursor-pointer ${isExpanded ? 'bg-white/5' : 'hover:bg-white/5'} ${e.direction === 'inbound' ? 'text-cyan-400/80' : 'text-amber-400/80'}`}
```

Change to:

```typescript
className={`border-b border-white/5 cursor-pointer ${isExpanded ? 'bg-white/5' : 'hover:bg-white/5'}`}
```

- [ ] **Step 5: Verify the file compiles**

Run: `npx tsc --noEmit src/widgets/natsTraffic/NatsTrafficWidget.tsx`
Expected: No errors

- [ ] **Step 6: Test manually**

1. Run `npm run dev`
2. Create a NATS traffic widget
3. Send some test NATS messages
4. Verify the widget shows "sender → recipient" format instead of "inbound/outbound"

- [ ] **Step 7: Commit**

```bash
git add src/widgets/natsTraffic/NatsTrafficWidget.tsx
git commit -m "feat: simplify traffic widget - show sender→recipient instead of direction"
```

---

### Task 7: Integration Test

**Files:**
- No new files — manual testing

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Create a multi-agent task**

1. Navigate to an epic in the sidebar
2. Right-click → Add Child (to create a task)
3. Name the task "Test Parallel"
4. Select "Parallel (Fan-out)" pattern
5. Click Create

- [ ] **Step 3: Verify sessions spawned**

1. Check that 5 session widgets appear on the canvas
2. Verify their names: test-parallel-coordinator, test-parallel-specialist-1, etc.
3. Check that they're arranged in a reasonable layout

- [ ] **Step 4: Verify NATS subscriptions**

1. Open one of the session widgets
2. Check that NATS is enabled (should show in session info)
3. Open a NATS traffic widget
4. From coordinator, send a message to one of the specialists
5. Verify the traffic widget shows the message with sender→recipient format

- [ ] **Step 5: Document any issues**

If issues found, create follow-up tasks.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: multi-agent pattern scaffolding complete"
```

---

## Summary

This plan implements:
1. Pattern definitions with hardcoded configurations (4 multi-agent patterns)
2. Pattern dropdown in task creation dialog with inline preview
3. Backend logic to spawn multiple sessions when pattern selected
4. NATS subscription auto-wiring based on task hierarchy
5. Simplified traffic widget showing sender→recipient flow

The canvas layout enhancement (arranging sessions in pattern topology) is deferred to a follow-up task for simplicity.
