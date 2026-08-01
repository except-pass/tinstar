import { describe, expect, it } from 'vitest'
import { describeTtydFailure } from '../ttyd-diagnostics'
import {
  TtydStartCancellationReceiptError,
  TtydStartCancelledError,
  TtydStartSupersededError,
} from '../tmux'

describe('describeTtydFailure', () => {
  const cyclic = new Error('cycle')
  Object.defineProperty(cyclic, 'cause', { value: cyclic })
  const shared = new Error('shared')

  it.each([
    ['non-error', 'plain failure', 'plain failure'],
    [
      'cause chain',
      new Error('outer', { cause: new Error('inner', { cause: 'root' }) }),
      'outer; caused by: inner; caused by: root',
    ],
    [
      'aggregate',
      new AggregateError(
        [new Error('left'), new Error('right', { cause: 'detail' })],
        'combined',
      ),
      'combined; errors: [left | right; caused by: detail]',
    ],
    [
      'shared-node diamond',
      new AggregateError(
        [shared, new Error('branch', { cause: shared })],
        'diamond',
      ),
      'diamond; errors: [shared | branch; caused by: shared]',
    ],
    ['cause cycle', cyclic, 'cycle; caused by: [cycle: cycle]'],
  ])('renders a %s diagnostic', (_case, failure, expected) => {
    expect(describeTtydFailure(failure)).toBe(expected)
  })

  it('renders a cancellation reason and its non-causal interruption once', () => {
    const interrupted = new TtydStartSupersededError(
      'diagnostic-session',
      'post-spawn',
    )
    const cancellation = new TtydStartCancelledError(
      'diagnostic-session',
      'post-spawn',
      'session stop requested',
      interrupted,
    )
    const described = describeTtydFailure(cancellation)

    expect(cancellation.message).toContain(
      '; cancellation reason: session stop requested',
    )
    expect(cancellation.message).toContain(
      `; interrupted failure: ${interrupted.message}`,
    )
    expect(described).toContain(
      '; cancellation reason: session stop requested',
    )
    expect(described).toContain(
      `; interrupted failure: ${interrupted.message}`,
    )
    expect(described.split(interrupted.message)).toHaveLength(2)
  })

  it('does not repeat a cancellation interruption carried by cleanup', () => {
    const interrupted = new TtydStartSupersededError(
      'diagnostic-session',
      'post-spawn',
    )
    const cancellation = new TtydStartCancelledError(
      'diagnostic-session',
      'post-spawn',
      'session stop requested',
      interrupted,
      {
        cause: new AggregateError(
          [interrupted, new Error('cleanup failed')],
          'cleanup aggregate',
        ),
      },
    )
    const described = describeTtydFailure(cancellation)

    expect(described).toContain(
      'cleanup aggregate; errors: [ttyd start for diagnostic-session '
        + 'was superseded at post-spawn | cleanup failed]',
    )
    expect(described).not.toContain('interrupted failure:')
    expect(described.split(interrupted.message)).toHaveLength(2)
  })

  it('renders a missing receipt and its non-causal interruption once', () => {
    const interrupted = new TtydStartSupersededError(
      'diagnostic-session',
      'post-spawn',
    )
    const receipt = new TtydStartCancellationReceiptError(
      'diagnostic-session',
      interrupted,
    )
    const described = describeTtydFailure(receipt)

    expect(receipt.message).toContain(
      `; interrupted failure: ${interrupted.message}`,
    )
    expect(described).toContain(
      `; interrupted failure: ${interrupted.message}`,
    )
    expect(described.split(interrupted.message)).toHaveLength(2)
  })

  it('does not repeat a receipt interruption carried by cleanup', () => {
    const interrupted = new TtydStartSupersededError(
      'diagnostic-session',
      'post-spawn',
    )
    const receipt = new TtydStartCancellationReceiptError(
      'diagnostic-session',
      interrupted,
      {
        cause: new AggregateError(
          [interrupted, new Error('receipt cleanup failed')],
          'receipt cleanup aggregate',
        ),
      },
    )
    const described = describeTtydFailure(receipt)

    expect(described).toContain(
      'receipt cleanup aggregate; errors: [ttyd start for diagnostic-session '
        + 'was superseded at post-spawn | receipt cleanup failed]',
    )
    expect(described).not.toContain('interrupted failure:')
    expect(described.split(interrupted.message)).toHaveLength(2)
  })
})
