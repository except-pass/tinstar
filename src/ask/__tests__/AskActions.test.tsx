import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AskActions, AskSelectionRejected, type AskActionsProps, type AskActionDelivery } from '../AskActions'
import type { AskAction } from '../../shared/ask-actions'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
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

  it('shows definitive stale/conflict rejections without claiming a request or retrying it', async () => {
    render(<AskActions {...props({ onSelect: vi.fn().mockRejectedValue(new AskSelectionRejected('Answer has been superseded')) })} />)
    fireEvent.click(screen.getByRole('button', { name: closeName }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Blocked · Request unavailable'))
    expect(screen.queryByRole('button', { name: 'Retry same selection' })).toBeNull()
    expect(screen.getByRole('button', { name: closeName })).toBeDisabled()
  })

  it.each(['sent', 'delivered', 'answered', 'failed'] as const)('maps persisted %s evidence truthfully after reload', status => {
    render(<AskActions {...props({ selection: { action_id: close.id, status, error: status === 'failed' ? 'First Mate could not receive this selection.' : null } })} />)
    expect(screen.getByRole('status')).toHaveTextContent({ sent: 'Requested', delivered: 'Delivered', answered: 'Result received', failed: 'Failed' }[status])
    expect(screen.getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true)
    expect(screen.queryByText(/Completed|Acting|Done confirmed/)).toBeNull()
    if (status === 'answered') expect(screen.getByText(/Read the reply for the outcome/)).toBeVisible()
    if (status === 'failed') expect(screen.getByText('First Mate could not receive this selection.').closest('details')).not.toHaveAttribute('open')
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
    expect(screen.getByRole('status')).toHaveTextContent('Result received')
  })

  it('resets local selection when displaying another immutable answer', async () => {
    const options = props(), view = render(<AskActions {...options} />)
    fireEvent.click(screen.getByRole('button', { name: closeName }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Requested'))
    view.rerender(<AskActions {...options} answerId="268503d5-57a5-439e-a29c-b19510a234b1" />)
    expect(screen.getByRole('button', { name: closeName })).toBeEnabled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('sends one Clawson card for a merge action using the head read at click', async () => {
    const head = 'c'.repeat(40)
    const pr = 'https://github.com/owner/repo/pull/7'
    const merge = { id: 'merge-pr-7', label: 'Merge PR 7', instruction: 'Merge this pull request', merge: { pr_url: pr } }
    let finish!: (value: Response) => void
    const sent = new Promise<Response>(resolve => { finish = resolve })
    const read = vi.fn((input: string, _init?: RequestInit) => String(input).includes('/origin')
      ? Promise.resolve(new Response(JSON.stringify({ ok: true, data: { head, url: pr } })))
      : sent)
    vi.stubGlobal('fetch', read)
    const onSelect = vi.fn()
    render(<AskActions {...props({ suggestions: [merge, keep], onSelect })} />)
    const button = screen.getByRole('button', { name: `${merge.label}: ${merge.instruction}` })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(read.mock.calls.filter(([path]) => String(path).includes('/clawson-merge'))).toHaveLength(1))
    expect(read.mock.calls.filter(([path]) => String(path).includes('/origin'))).toHaveLength(1)
    const payload = JSON.parse(String(read.mock.calls.find(([path]) => String(path).includes('/clawson-merge'))![1]!.body))
    expect(payload.targets).toEqual([{ url: pr, head }])
    expect(payload.operation_id).toMatch(/^[a-f0-9-]{36}$/)
    expect(onSelect).not.toHaveBeenCalled()
    finish(new Response(JSON.stringify({ ok: true, data: { url: 'https://www.notion.so/cccccccccccccccccccccccccccccccc', message: 'Sent to Clawson for admin merge.' } })))
    expect(await screen.findByRole('link', { name: 'Open Clawson card ↗' })).toHaveAttribute('href', 'https://www.notion.so/cccccccccccccccccccccccccccccccc')
    fireEvent.click(screen.getByRole('button', { name: `${merge.label}: ${merge.instruction}` }))
    expect(read.mock.calls.filter(([path]) => String(path).includes('/clawson-merge'))).toHaveLength(1)
  })

  it('shows a merge refusal with no card and retries the same operation', async () => {
    let head = 'd'.repeat(40)
    const pr = 'https://github.com/owner/repo/pull/8'
    const merge = { id: 'merge-pr-8', label: 'Merge PR 8', instruction: 'Merge this pull request', merge: { pr_url: pr } }
    const refusal = 'Nothing sent to Clawson. https://github.com/owner/repo/pull/8: CI is pending.'
    const read = vi.fn((input: string, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify(String(input).includes('/origin')
      ? { ok: true, data: { head } }
      : { ok: false, error: { message: refusal } }), { status: String(input).includes('/origin') ? 200 : 409 })))
    vi.stubGlobal('fetch', read)
    render(<AskActions {...props({ suggestions: [merge, keep], onSelect: vi.fn() })} />)
    fireEvent.click(screen.getByRole('button', { name: `${merge.label}: ${merge.instruction}` }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Merge request unconfirmed. Retry this choice.')
    expect(screen.getByText(refusal).closest('details')).not.toHaveAttribute('open')
    expect(screen.queryByRole('link', { name: 'Open Clawson card ↗' })).toBeNull()
    expect(screen.getByRole('button', { name: `${keep.label}: ${keep.instruction}` })).toBeEnabled()
    head = 'e'.repeat(40)
    fireEvent.click(screen.getByRole('button', { name: `${merge.label}: ${merge.instruction}` }))
    await waitFor(() => expect(read.mock.calls.filter(([path]) => String(path).includes('/clawson-merge'))).toHaveLength(2))
    const bodies = read.mock.calls.filter(([path]) => String(path).includes('/clawson-merge')).map(([, init]) => JSON.parse(String(init!.body)))
    expect(bodies[1].operation_id).toBe(bodies[0].operation_id)
    expect(bodies[0].targets).toEqual([{ url: pr, head: 'd'.repeat(40) }])
    expect(bodies[1].targets).toEqual([{ url: pr, head }])
    expect(read.mock.calls.filter(([path]) => String(path).includes('/origin'))).toHaveLength(2)
  })

  it.each(['lost', 'unreadable', 'incomplete', 'create-unconfirmed'])('replays the posted payload after a %s response without reading GitHub', async failure => {
    const pr = 'https://github.com/owner/repo/pull/8'
    const merge = { id: 'merge-pr-8', label: 'Merge PR 8', instruction: 'Merge this pull request', merge: { pr_url: pr } }
    let posts = 0, origins = 0
    const read = vi.fn(async (input: string, _init?: RequestInit) => {
      if (String(input).includes('/origin')) {
        if (++origins > 1) throw new Error('GitHub unavailable after head advanced')
        return new Response(JSON.stringify({ ok: true, data: { head: 'a'.repeat(40) } }))
      }
      if (++posts === 1) {
        if (failure === 'lost') throw new Error('Response lost')
        if (failure === 'create-unconfirmed') return new Response(JSON.stringify({ ok: false, error: { code: 'CONFLICT', message: 'Creation unconfirmed', details: { code: 'create-unconfirmed' } } }), { status: 409 })
        return new Response(failure === 'unreadable' ? 'unreadable' : JSON.stringify({ ok: true, data: {} }))
      }
      return new Response(JSON.stringify({ ok: true, data: { url: 'https://www.notion.so/card', message: 'Sent to Clawson.' } }))
    })
    vi.stubGlobal('fetch', read)
    render(<AskActions {...props({ suggestions: [merge] })} />)
    const button = screen.getByRole('button', { name: `${merge.label}: ${merge.instruction}` })
    fireEvent.click(button)
    await screen.findByRole('alert')
    fireEvent.click(button)
    await screen.findByRole('link', { name: 'Open Clawson card ↗' })
    const bodies = read.mock.calls.filter(([path]) => String(path).includes('/clawson-merge')).map(([, init]) => JSON.parse(String(init!.body)))
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0])
    expect(origins).toBe(1)
  })

  it('leaves a recommendation that only says merge on the ordinary selection path', async () => {
    const plain = { id: 'merge-pr-9', label: 'Merge PR 9', instruction: 'Ask for another look at pull request 9' }
    const onSelect = vi.fn(async () => ({ status: 'sent' as const }))
    vi.stubGlobal('fetch', vi.fn())
    render(<AskActions {...props({ suggestions: [plain], onSelect })} />)
    fireEvent.click(screen.getByRole('button', { name: `${plain.label}: ${plain.instruction}` }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('renders nothing for an answer without suggestions', () => {
    const { container } = render(<AskActions {...props({ suggestions: [] })} />)
    expect(container).toBeEmptyDOMElement()
  })
})

 it('routes decision merges through the saved selection boundary and restores their receipt', async () => {
  const merge = { id: 'merge', label: 'Request merge', instruction: 'Request this merge', merge: { pr_url: 'https://github.com/owner/repo/pull/17' } }
  const onSelect = vi.fn<AskActionsProps['onSelect']>(async () => ({ status: 'delivered' as const }))
  vi.stubGlobal('fetch', vi.fn())
  const view = render(<AskActions {...props({ decision: true, suggestions: [merge], onSelect })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Request merge: Request this merge' }))
  await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1))
  expect(onSelect.mock.calls[0]).toEqual([{ answer_id: answerId, action_id: 'merge', client_key: expect.any(String) }])
  expect(fetch).not.toHaveBeenCalled()
  view.unmount()
  render(<AskActions {...props({ decision: true, suggestions: [merge], onSelect, selection: { action_id: 'merge', status: 'delivered', merge_selection: { input: { operation_id: answerId, targets: [{ url: merge.merge.pr_url, head: 'a'.repeat(40) }] }, receipt: { url: 'https://www.notion.so/card', message: 'Sent to Clawson' } } } })} />)
  expect(screen.getByRole('link', { name: 'Open Clawson card ↗' })).toHaveAttribute('href', 'https://www.notion.so/card')
  expect(screen.getByRole('button')).toBeDisabled()
})

it.each(['acting', 'completed', 'blocked', 'failed'] as const)('renders the observed %s outcome', outcome => {
  render(<AskActions {...props({ selection: { action_id: close.id, status: 'answered', outcome } })} />)
  expect(screen.getByRole('status')).toHaveTextContent({ acting: 'Acting', completed: 'Completed', blocked: 'Blocked', failed: 'Failed' }[outcome])
  expect(screen.queryByText('Result received')).toBeNull()
})
