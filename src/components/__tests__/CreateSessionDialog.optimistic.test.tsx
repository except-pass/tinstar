// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetch = vi.fn()
vi.mock('../../apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

import { CreateSessionDialog } from '../CreateSessionDialog'
import { OBJECTIVE_MAX } from '../../domain/types'

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data }
}

function mockBootstrapRequests(postResponse: Promise<unknown>) {
  apiFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/sessions' && init?.method === 'POST') return postResponse
    if (url === '/api/projects') return Promise.resolve(jsonResponse({ ok: true, data: {} }))
    if (url === '/api/cli-templates') return Promise.resolve(jsonResponse({ ok: true, data: [] }))
    if (url === '/api/state') return Promise.resolve(jsonResponse({}))
    // Some jsdom cleanup paths can finish an already-started effect after the
    // component unmounts. Keep those incidental reads inert; each test asserts
    // the session POST explicitly where it matters.
    return Promise.resolve(jsonResponse({}))
  })
}

describe('CreateSessionDialog optimistic creation', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('closes and emits the run intent before session provisioning settles', async () => {
    let resolvePost!: (value: unknown) => void
    const postResponse = new Promise(resolve => { resolvePost = resolve })
    mockBootstrapRequests(postResponse)
    const onClose = vi.fn()
    const onCreateStarted = vi.fn()
    const onCreated = vi.fn()

    render(
      <CreateSessionDialog
        onClose={onClose}
        onCreateStarted={onCreateStarted}
        onCreated={onCreated}
      />,
    )

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cli-templates'))

    fireEvent.change(screen.getByTestId('session-name-input'), { target: { value: 'optimistic-run' } })
    fireEvent.change(screen.getByPlaceholderText('Initial message to send to Claude...'), {
      target: { value: '  preserve this prompt  ' },
    })
    fireEvent.click(screen.getByTestId('create-session-submit'))

    expect(onCreateStarted).toHaveBeenCalledWith(expect.objectContaining({
      id: 'optimistic-run',
      prompt: 'preserve this prompt',
    }))
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions', expect.objectContaining({
      body: expect.stringContaining('"prompt":"preserve this prompt"'),
    }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onCreated).not.toHaveBeenCalled()

    resolvePost(jsonResponse({ ok: true, data: { name: 'optimistic-run' } }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('optimistic-run'))
  })

  it('reports a provisioning failure against the optimistic run', async () => {
    mockBootstrapRequests(Promise.resolve(jsonResponse({
      ok: false,
      error: { message: 'ttyd did not bind' },
    })))
    const onCreateFailed = vi.fn()

    render(
      <CreateSessionDialog
        onClose={vi.fn()}
        onCreateStarted={vi.fn()}
        onCreateFailed={onCreateFailed}
      />,
    )

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cli-templates'))

    fireEvent.change(screen.getByTestId('session-name-input'), { target: { value: 'failed-run' } })
    fireEvent.change(screen.getByPlaceholderText('Initial message to send to Claude...'), {
      target: { value: 'keep me' },
    })
    fireEvent.click(screen.getByTestId('create-session-submit'))

    await waitFor(() => expect(onCreateFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'failed-run', prompt: 'keep me' }),
      'ttyd did not bind',
    ))
  })

  it('does not optimistically replace an existing run with the same id', async () => {
    mockBootstrapRequests(Promise.resolve(jsonResponse({ ok: true, data: {} })))
    const onClose = vi.fn()
    const onCreateStarted = vi.fn()

    render(
      <CreateSessionDialog
        onClose={onClose}
        existingSessionIds={new Set(['already-there'])}
        onCreateStarted={onCreateStarted}
      />,
    )

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cli-templates'))

    fireEvent.change(screen.getByTestId('session-name-input'), { target: { value: 'already-there' } })
    fireEvent.click(screen.getByTestId('create-session-submit'))

    expect(screen.getByRole('alert')).toHaveTextContent("Session 'already-there' already exists")
    expect(onCreateStarted).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(apiFetch).not.toHaveBeenCalledWith('/api/sessions', expect.anything())
  })

  it('rejects an oversized work prompt before optimistic admission', async () => {
    mockBootstrapRequests(Promise.resolve(jsonResponse({ ok: true, data: {} })))
    const onClose = vi.fn()
    const onCreateStarted = vi.fn()

    render(
      <CreateSessionDialog
        onClose={onClose}
        onCreateStarted={onCreateStarted}
      />,
    )
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cli-templates'))

    fireEvent.change(screen.getByPlaceholderText('Initial message to send to Claude...'), {
      target: { value: 'x'.repeat(OBJECTIVE_MAX + 1) },
    })
    fireEvent.click(screen.getByTestId('create-session-submit'))

    expect(screen.getByRole('alert')).toHaveTextContent(`Keep it under ${OBJECTIVE_MAX} characters.`)
    expect(onCreateStarted).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(apiFetch).not.toHaveBeenCalledWith('/api/sessions', expect.anything())
  })

  it('keeps an invalid inline project out of the picker and shows the server error', async () => {
    apiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/projects' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({
          ok: false,
          error: { message: 'Project path must be an existing directory: /missing/project' },
        }, false))
      }
      if (url === '/api/projects') return Promise.resolve(jsonResponse({ ok: true, data: {} }))
      if (url === '/api/cli-templates') return Promise.resolve(jsonResponse({ ok: true, data: [] }))
      return Promise.resolve(jsonResponse({}))
    })

    render(<CreateSessionDialog onClose={vi.fn()} />)
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cli-templates'))

    fireEvent.change(screen.getByTestId('create-project-select'), { target: { value: '__add__' } })
    const pathInput = screen.getByPlaceholderText('/path/to/project')
    fireEvent.change(pathInput, { target: { value: '/missing/project' } })
    fireEvent.keyDown(pathInput, { key: 'Enter' })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Project path must be an existing directory: /missing/project',
    ))
    expect(screen.queryByRole('option', { name: 'project' })).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('/path/to/project')).toHaveValue('/missing/project')
  })
})
