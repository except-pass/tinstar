import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AskDesk, AskProvider } from '../Ask'
import { askItemSchema, type AskItem } from '../../shared/ask'
import { initialPresentation } from '../../reconciliation/presentation'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const conversation = crypto.randomUUID()
function row(question: string, minute: string, answered: string, summary: string, detail = summary): AskItem {
  return askItemSchema.parse({ request_id: crypto.randomUUID(), conversation_id: conversation, question, input_mode: 'text', context: { anchor: { kind: 'work', page_id: 'a'.repeat(32), label: 'Related work', url: 'https://example.test/source', observed_at: null }, view: { scene: 'overview' } }, created_at: `2026-11-10T10:${minute}:00Z`, answered_at: `2026-11-10T10:${answered}:00Z`, updated_at: `2026-11-10T10:${answered}:00Z`, status: 'answered', reply: { summary, detail, references: [], suggested_actions: [] }, read_at: null, dismissed_at: null, error: null })
}
function mount(rows: AskItem[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: rows }))))
  return render(<AskProvider scene={null} state={initialPresentation()} send={vi.fn()} onReturn={vi.fn()}><AskDesk now={Date.parse('2026-11-10T11:00:00Z')} view="needs-you" /></AskProvider>)
}
it('orders interleaved messages chronologically with sender/time identity and each answer exactly once', async () => {
  const first = row('First question', '00', '03', 'First answer'), second = row('Newest question', '02', '04', 'Latest answer')
  const view = mount([second, first])
  fireEvent.click(await screen.findByRole('button', { name: /New answer.*Newest question/ }))
  const messages = [...view.container.querySelectorAll('.ask-message')]
  expect(messages.map(message => message.querySelector('.ask-message-body')!.textContent)).toEqual(['First question', 'Newest question', 'First answer', 'Latest answer'])
  expect(messages.map(message => message.querySelector('header strong')!.textContent)).toEqual(['You', 'You', 'First Mate', 'First Mate'])
  expect(messages.every(message => !!message.querySelector('time[datetime]'))).toBe(true)
  expect(within(screen.getByRole('region', { name: /Answer thread/ })).getAllByText('First answer')).toHaveLength(1)
})
it('renders Markdown links and code as message content without creating action controls', async () => {
  mount([row('Explain the evidence', '00', '01', 'Evidence is available.', 'Read [the report](https://example.test/report)\n\n```js\nconst result = 1\n```')])
  fireEvent.click(await screen.findByRole('button', { name: /New answer/ }))
  expect(screen.getByRole('link', { name: 'the report' })).toHaveAttribute('href', 'https://example.test/report')
  expect(screen.getByText('const result = 1').tagName).toBe('CODE')
  expect(screen.queryByRole('group', { name: 'Suggested next actions' })).toBeNull()
})
