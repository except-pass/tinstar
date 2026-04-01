// src/domain/patterns.ts

/**
 * @deprecated Use ~/.config/tinstar/patterns/ files instead.
 * This file is kept for reference during migration.
 * Remove after migration is complete.
 */

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
