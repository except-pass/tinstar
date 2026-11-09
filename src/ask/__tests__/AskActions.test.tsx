import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AskActions, type AskActionsProps, type AskActionDelivery } from '../AskActions'
import type { AskAction } from '../../shared/ask-actions'

afterEach(cleanup)
const close: AskAction = { id: 'close-done', label: 'Close as Done', instruction: 'Post the #3194 Feed verdict and set the linked Notion card Done' }
const keep: AskAction = { id: 'keep-open', label: 'Keep open', instruction: 'Retain card until a real DEV stall exhibits Feed recovery.' }
const answerId = '12d6fbba-a3ec-4aab-a020-7c543b56d34e'
const closeName = `${close.label}: ${close.instruction}`
function props(overrides: Partial<AskActionsProps> = {}): AskActionsProps {
  return { answerId, suggestions: [close, keep], superseded: false, onSelect: vi.fn(async () => ({ status: 'sent' as const })), ...overrides }
}
function deferred() {
  let resolve!: (value: AskActionDelivery) => void
  let reject!: (error: Error) => void
  const promise = new Promise<AskActionDelivery>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('Ask recommendation buttons', () => {
  it('presents compact contextual choices with accessible consequences beside the answer', () => {
    render(<><h3>Why is this overdue?</h3><p>The Feed verdict still needs confirmation.</p><a href="https://example.test">Evidence</a>
      <AskActions {...props()} /><textarea aria-label="Follow-up question" /></>)
    const button = screen.getByRole('button', { name: closeName })
    expect(button).toHaveTextContent('Close as Done')
    expect(button).toHaveAttribute('type', 'button')
    button.focus()
    expect(button).toHaveFocus()
    expect(screen.getByRole('button', { name: `${keep.label}: ${keep.instruction}` })).toBeEnabled()
    expect(screen.getByText('The Feed verdict still needs confirmation.')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Evidence' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Follow-up question' })).toBeVisible()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps only three choices prominent and exposes overflow with native disclosure', () => {
    const actions = Array.from({ length: 5 }, (_, i) => ({ ...close, id: `action-${i}`, label: `Choice ${i}` }))
    const { container } = render(<AskActions {...props({ suggestions: actions })} />)
    const overflow = container.querySelector('details')!
    expect(container.querySelector('.ask-action-choices')!.children).toHaveLength(3)
    expect(overflow.open).toBe(false)
    expect(overflow.querySelector('summary')).toHaveTextContent('More choices (2)')
    expect(within(overflow).getAllByRole('button', { hidden: true })).toHaveLength(2)
    fireEvent.click(overflow.querySelector('summary')!)
    expect(overflow.open).toBe(true)
  })

  it('renders legacy content as inert escaped text, without manufacturing action IDs', () => {
    const { container } = render(<AskActions {...props({ suggestions: ['<script>alert(1)</script>', 'Open https://example.test'] })} />)
    expect(screen.getByText('<script>alert(1)</script>')).toBeVisible()
    expect(screen.getByText('Open https://example.test')).toBeVisible()
    expect(container.querySelector('script,a')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('sends only retained identifiers on one click and suppresses same-event duplicates', async () => {
    const pending = deferred(), onSelect = vi.fn(() => pending.promise)
    render(<AskActions {...props({ onSelect })} />)
    const button = screen.getByRole('button', { name: closeName })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0]).toEqual([{ answer_id: answerId, action_id: close.id, client_key: expect.stringMatching(/^[a-f0-9-]{36}$/) }])
    expect(screen.getByRole('status')).toHaveTextContent('Sending selection')
    expect(screen.getByText(`Selected: ${close.instruction}`)).toBeVisible()
    expect(screen.getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true)
    pending.resolve({ status: 'sent' })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Requested'))
    expect(screen.queryByRole('button', { name: /Send/ })).toBeNull()
  })

  it('retains the same selection/key after an unknown acknowledgement and prevents competing clicks', async () => {
    const onSelect = vi.fn<AskActionsProps['onSelect']>().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ status: 'delivered' })
    render(<AskActions {...props({ onSelect })} />)
    fireEvent.click(screen.getByRole('button', { name: closeName }))
    const retry = await screen.findByRole('button', { name: 'Retry same selection' })
    expect(screen.getByRole('status')).toHaveTextContent('Delivery unconfirmed')
    fireEvent.click(screen.getByRole('button', { name: `${keep.label}: ${keep.instruction}` }))
    expect(onSelect).toHaveBeenCalledTimes(1)
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Delivered'))
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(onSelect.mock.calls[1]![0]).toEqual(onSelect.mock.calls[0]![0])
    expect(screen.queryByRole('button', { name: 'Retry same selection' })).toBeNull()
  })

  it.each(['sent', 'delivered', 'answered', 'failed'] as const)('maps persisted %s evidence truthfully after reload', status => {
    render(<AskActions {...props({ selection: { action_id: close.id, status, error: status === 'failed' ? 'First Mate could not receive this selection.' : null } })} />)
    expect(screen.getByRole('status')).toHaveTextContent({ sent: 'Requested', delivered: 'Delivered', answered: 'Answered', failed: 'Failed' }[status])
    expect(screen.getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true)
    expect(screen.queryByText(/Completed|Acting|Done confirmed/)).toBeNull()
    if (status === 'answered') expect(screen.getByText(/Read the reply for the outcome/)).toBeVisible()
    if (status === 'failed') expect(screen.getByRole('status')).toHaveTextContent('could not receive')
  })

  it('leaves superseded choices visible and disabled with an explanation, including overflow', () => {
    const onSelect = vi.fn(), extra = Array.from({ length: 3 }, (_, i) => ({ ...keep, id: `extra-${i}` }))
    render(<AskActions {...props({ superseded: true, suggestions: [close, keep, ...extra], onSelect })} />)
    expect(screen.getByText(/These recommendations are outdated/)).toBeVisible()
    for (const button of screen.getAllByRole('button', { hidden: true })) {
      expect(button).toBeDisabled()
      fireEvent.click(button)
    }
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('suppresses uncertain retries after supersession and uses refreshed persisted delivery', async () => {
    const options = props({ onSelect: vi.fn().mockRejectedValue(new Error('network')) })
    const view = render(<AskActions {...options} />)
    fireEvent.click(screen.getByRole('button', { name: closeName }))
    await screen.findByRole('button', { name: 'Retry same selection' })
    view.rerender(<AskActions {...options} superseded />)
    expect(screen.queryByRole('button', { name: 'Retry same selection' })).toBeNull()
    view.rerender(<AskActions {...options} superseded selection={{ action_id: close.id, status: 'answered' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('Answered')
    expect(screen.getByText(`Selected: ${close.instruction}`)).toBeVisible()
  })

  it('resets local selection when displaying another immutable answer', async () => {
    const options = props(), view = render(<AskActions {...options} />)
    fireEvent.click(screen.getByRole('button', { name: closeName }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Requested'))
    view.rerender(<AskActions {...options} answerId="268503d5-57a5-439e-a29c-b19510a234b1" />)
    expect(screen.getByRole('button', { name: closeName })).toBeEnabled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders nothing for an answer without suggestions', () => {
    const { container } = render(<AskActions {...props({ suggestions: [] })} />)
    expect(container).toBeEmptyDOMElement()
  })
})
