import { useEffect, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { captureScroll, useScrollRestore, useViewSnapshot, useWorkspaceHistory, type WorkspaceHistory } from '../workspaceHistory'

type Section = 'overview' | 'pulls' | 'releases'
afterEach(() => { cleanup(); vi.restoreAllMocks(); history.replaceState(null, '', '/') })

function View({ section, views }: { section: Section; views: WorkspaceHistory }) {
  const [query, setQuery] = useState(''), [sort, setSort] = useState('title')
  const viewport = useRef<HTMLDivElement>(null)
  const scroll = useScrollRestore(() => viewport.current, 'data-row', true, views.restoration.revision)
  useViewSnapshot(views, section, () => ({ query, sort, position: captureScroll(viewport.current, 'data-row') }), saved => {
    setQuery(saved.query); setSort(saved.sort); scroll.restore(saved.position)
  })
  return <><label>Query<input aria-label="Query" value={query} onChange={event => setQuery(event.target.value)} /></label><button onClick={() => setSort('changes')}>{sort}</button><div ref={viewport} data-testid="viewport">{section}</div></>
}
function Journey({ initial }: { initial: Section }) {
  const [section, setSection] = useState(initial)
  const views = useWorkspaceHistory(section)
  useEffect(() => {
    const pop = () => { views.pop(); setSection(new URLSearchParams(location.search).get('view') as Section) }
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [views.pop])
  return <><button onClick={() => {
    const next = section === 'releases' ? 'pulls' : 'releases'
    views.capture(); history.pushState(null, '', `?view=${next}`); views.navigated(); setSection(next)
  }}>Desk jump</button><View key={section} section={section} views={views} /></>
}

it.each(['overview', 'pulls', 'releases'] as const)('keeps the latest %s edits and scroll in its native entry', async section => {
  history.replaceState(null, '', `?view=${section}`)
  const writes = vi.spyOn(history, 'replaceState')
  render(<Journey initial={section} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Query' }), { target: { value: 'original' } })
  fireEvent.click(screen.getByRole('button', { name: 'Desk jump' }))
  const pop = async (direction: 'back' | 'forward') => {
    const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    await act(async () => { history[direction](); await popped })
  }
  await pop('back')
  expect(screen.getByRole('textbox', { name: 'Query' })).toHaveValue('original')
  fireEvent.change(screen.getByRole('textbox', { name: 'Query' }), { target: { value: 'newer' } })
  fireEvent.click(screen.getByRole('button', { name: 'title' }))
  const viewport = screen.getByTestId('viewport')
  const beforeScroll = writes.mock.calls.length
  for (let index = 1; index <= 20; index++) {
    viewport.scrollTop = index * 10; viewport.scrollLeft = index
    fireEvent.scroll(viewport)
  }
  await waitFor(() => expect(history.state.tinstarWorkspace.view.position.top).toBe(200))
  expect(writes.mock.calls.length - beforeScroll).toBeLessThanOrEqual(1)
  await pop('forward')
  expect(screen.getByRole('textbox', { name: 'Query' })).toHaveValue('')
  await pop('back')
  expect(screen.getByRole('textbox', { name: 'Query' })).toHaveValue('newer')
  expect(screen.getByRole('button', { name: 'changes' })).toBeVisible()
  await waitFor(() => expect(screen.getByTestId('viewport').scrollTop).toBe(200))
  expect(screen.getByTestId('viewport').scrollLeft).toBe(20)
})
