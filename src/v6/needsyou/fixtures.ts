/** Labeled fixture rows. A fixture is not integration proof. */

const AT = '2026-09-24T23:20:00.000Z'

function item(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    fixture: true,
    state: 'open',
    createdAt: AT,
    updatedAt: AT,
    response: null,
    provenance: {},
    ...fields,
  }
}

export function decisionFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return item({
    id: 'ny-decision',
    type: 'decision',
    headline: 'Keep attention in one queue?',
    revision: 'rev-decision',
    executionImpact: 'continues',
    provenance: { workerId: 'worker-alpha', taskId: 'ts-needsyou' },
    payload: {
      options: [
        {
          id: 'keep',
          label: 'Keep one queue',
          gain: 'One place to look',
          cost: 'The rail gets taller',
          wrongIf: 'Review volume drowns blockers',
        },
        {
          id: 'split',
          label: 'Split reviews out',
          gain: 'Quieter blockers',
          cost: 'A second queue hides review',
          wrongIf: 'People stop opening the second queue',
        },
        {
          id: 'defer',
          label: 'Defer the call',
          gain: 'Time to read the thread',
          cost: 'The worker waits on a silent card',
          wrongIf: 'The delay itself becomes the drift',
        },
      ],
      risks: [
        {
          label: 'Unknown word stays unknown',
          severity: 'catastrophic',
          likelihood: 'possible',
          discoverability: 'subtle',
          note: 'fixture risk',
        },
        {
          label: 'Known scales',
          severity: 'severe',
          likelihood: 'likely',
          discoverability: 'silent',
        },
      ],
      reversal: {
        action: 'cheap',
        damage: 'weeks+',
        note: 'The revert is cheap. The migration is not.',
      },
      horizon: {
        span: 'until-this-ships',
        until: 'the v6 account wire-up lands',
      },
      comment: 'fixture comment',
    },
    ...over,
  })
}

export function blockedFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return item({
    id: 'ny-blocked',
    type: 'blocked',
    headline: 'Reviewer is missing for the contract',
    revision: 'rev-blocked',
    executionImpact: 'blocked',
    provenance: { workerId: 'worker-alpha', taskId: 'ts-needsyou' },
    payload: {
      needed: 'A named reviewer for the schema',
      why: 'The rail cannot treat an unreviewed contract as settled',
      attempts: ['Pinged the shell task', 'Left the card open'],
      unblockCondition: 'A named reviewer approves the schema',
    },
    ...over,
  })
}

export function failureFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return item({
    id: 'ny-failure',
    type: 'failure',
    headline: 'Projection write failed',
    revision: 'rev-failure',
    executionImpact: 'unknown',
    provenance: { workerId: 'worker-beta' },
    payload: {
      operation: 'publish the needs-you projection',
      error: 'disk full',
      evidence: 'ENOSPC on the config volume',
      attempts: ['retried the write once'],
      proposedNextAction: 'retry the projection write',
    },
    ...over,
  })
}

export function driftFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return item({
    id: 'ny-drift',
    type: 'schedule-drift',
    headline: 'Needs You ran past its budget',
    revision: 'rev-drift',
    executionImpact: 'continues',
    provenance: { workerId: 'worker-alpha', taskId: 'ts-needsyou' },
    payload: {
      plannedMs: 7_200_000,
      elapsedMs: 11_000_000,
      activity: 'rendering the six cards',
      lastProgress: { unknown: true },
      evidence: 'no commit since the contract pin',
      explanation: 'the renderer is still being written',
      continues: true,
    },
    ...over,
  })
}

export function contradictionFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return item({
    id: 'ny-contradiction',
    type: 'contradiction',
    headline: 'The queue cannot be both empty and waiting',
    revision: 'rev-contradiction',
    executionImpact: 'continues',
    provenance: { epicId: 'epic-attention' },
    payload: {
      a: {
        claim: 'The queue is empty',
        evidence: 'rail length 0',
        source: 'fixture snapshot',
      },
      b: {
        claim: 'A decision is waiting',
        evidence: 'items.json has ny-decision',
        source: 'projection file',
      },
      impact: 'The captain may skip a real decision',
      blocking: false,
    },
    ...over,
  })
}

export function reviewFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return item({
    id: 'ny-review',
    type: 'review-ready',
    headline: 'Review the Needs You rail',
    revision: 'rev-review',
    executionImpact: 'continues',
    provenance: { taskId: 'ts-needsyou' },
    ci: 'unknown',
    payload: {
      kind: 'pr',
      summary: 'Six attention renderers on one rail',
      target: 'feat/v6-ts-needsyou',
      ci: 'unknown',
      pr: {
        repo: 'except-pass/tinstar',
        number: 1206,
        url: 'https://github.com/except-pass/tinstar/pull/1206',
      },
    },
    ...over,
  })
}

export function needsYouFixtures(): Record<string, unknown>[] {
  return [
    decisionFixture(),
    blockedFixture(),
    failureFixture(),
    driftFixture(),
    contradictionFixture(),
    reviewFixture(),
  ]
}
