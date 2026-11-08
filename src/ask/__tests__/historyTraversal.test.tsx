import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useViewSnapshot, useWorkspaceHistory, type WorkspaceHistory } from '../workspaceHistory'

type Section = 'overview' | 'pulls' | 'releases'
afterEach(() => { cleanup(); history.replaceState(null, '', '/') })

function View({ section, views, ready }: { section: Section; views: WorkspaceHistory; ready: boolean }) {
  const [query, setQuery] = useState(''), [sort, setSort] = useState('title')
  useViewSnapshot(views, section, () => ({ query, sort, filter: 'all', group: 'repository' }), saved => {
    setQuery(saved.query); setSort(saved.sort)
  }, ready)
  return <><input aria-label="Query" value={query} onChange={event => setQuery(event.target.value)} /><button onClick={() => setSort('changes')}>{sort}</button></>
}
function Journey({ initial, defer = false }: { initial: Section; defer?: boolean }) {
  const [section, setSection] = useState(initial), [ready, setReady] = useState(!defer)
  const views = useWorkspaceHistory(section)
  useEffect(() => {
    const pop = () => { setSection(new URLSearchParams(location.search).get('view') as Section); setReady(!defer) }
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [defer])
  return <><button onClick={() => setReady(true)}>Load data</button><button onClick={() => {
    views.capture(); history.pushState(null, '', '?view=releases'); views.navigated(); setSection('releases')
  }}>Desk jump</button><View key={section} section={section} views={views} ready={ready} /></>
}
async function pop(direction: 'back' | 'forward') {
  const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
  await act(async () => { history[direction](); await popped })
}
it.each(['overview', 'pulls'] as const)('restores the simple %s view with one Back', async section => {
  history.replaceState(null, '', `?view=${section}`)
  render(<Journey initial={section} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Query' }), { target: { value: 'saved query' } })
  fireEvent.click(screen.getByRole('button', { name: 'title' }))
  fireEvent.click(screen.getByRole('button', { name: 'Desk jump' }))
  await pop('back')
  expect(history.state.tinstarWorkspace).toEqual({ section, query: 'saved query', sort: 'changes', filter: 'all', group: 'repository' })
  expect(screen.getByRole('textbox', { name: 'Query' })).toHaveValue('saved query')
  expect(screen.getByRole('button', { name: 'changes' })).toBeVisible()
})
it('does not overwrite pending restoration during departure or reload', async () => {
  history.replaceState({ tinstarWorkspace: { section: 'pulls', query: 'pending query', sort: 'changes', filter: 'all', group: 'repository' } }, '', '?view=pulls')
  let view = render(<Journey initial="pulls" defer />)
  fireEvent(window, new Event('pagehide'))
  expect(history.state.tinstarWorkspace.query).toBe('pending query')
  view.unmount(); view = render(<Journey initial="pulls" defer />)
  fireEvent.click(screen.getByRole('button', { name: 'Desk jump' }))
  await pop('back'); await pop('forward'); await pop('back')
  expect(history.state.tinstarWorkspace.query).toBe('pending query')
  fireEvent.click(screen.getByRole('button', { name: 'Load data' }))
  expect(screen.getByRole('textbox', { name: 'Query' })).toHaveValue('pending query')
  expect(screen.getByRole('button', { name: 'changes' })).toBeVisible()
  view.unmount()
})
