// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { PromptComposer } from '../PromptComposer'
import type { RecapEntry } from '../../../types'

vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })),
  apiUrl: (path: string) => path,
}))

vi.mock('../../../hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({ commands: [], usage: {}, refresh: () => {} }),
}))

const NO_ENTRIES: RecapEntry[] = []

function renderComposer(
  overrides: Partial<React.ComponentProps<typeof PromptComposer>> = {},
) {
  return render(
    <PromptComposer
      recapEntries={NO_ENTRIES}
      rawLogs=""
      port={7681}
      sessionId="run-1"
      status="idle"
      accent="#ff7700"
      promptComposerExpanded={true}
      controlledTab="terminal"
      onControlledTabChange={() => {}}
      {...overrides}
    />,
  )
}

describe('<PromptComposer> terminal frame URL', () => {
  it('routes the terminal through the session proxy', () => {
    const { container } = renderComposer()
    const src = container.querySelector('iframe')!.getAttribute('src')!
    expect(src).toContain('session=run-1')
  })

  it('emits no port parameter', () => {
    // The wrapper has no bare-port branch left, but a port parameter here is
    // what fed it — keep the source clean so it cannot be reintroduced by
    // restoring one line in the wrapper.
    const { container } = renderComposer()
    expect(container.querySelector('iframe')!.getAttribute('src')!)
      .not.toContain('port=')
  })

  it('renders no terminal frame at all before the session id resolves', () => {
    // This composer always emitted `session=${sessionId ?? ''}&port=${port}`.
    // An unresolved session id rendered as an empty string, which the wrapper
    // read as falsy and answered with a bare-port URL — the exact case a
    // remote browser cannot reach.
    const { container } = renderComposer({ sessionId: undefined })
    const frame = container.querySelector('iframe')
    expect(frame?.getAttribute('src') ?? '').not.toContain('port=')
    expect(frame).toBeNull()
  })
})
