import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { fetchStretchPlan } from '../planClient'

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve((address as AddressInfo).port)
      else reject(new Error('no port'))
    })
  })
}

const plan = {
  tasks: [{ id: 'alpha', label: 'Alpha', bucket: 'build', start: 0, end: 1 }],
  _state: {
    alpha: { progress: 25, note: 'live' },
    _addedTasks: [{ id: 'beta', label: 'Beta', bucket: 'build', start: 2, end: 3 }],
  },
}

describe('fetchStretchPlan', () => {
  it('GETs the plan and merges browser-added tasks', async () => {
    const methods: string[] = []
    const server = createServer((req, res) => {
      methods.push(req.method ?? '')
      expect(req.url).toBe('/plans/pm-demo')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(plan))
    })
    const port = await listen(server)
    try {
      const view = await fetchStretchPlan('pm-demo', { baseUrl: `http://127.0.0.1:${port}` })
      expect(methods).toEqual(['GET'])
      expect(view.available).toBe(true)
      expect(view.fixture).toBe(false)
      expect(view.href).toBe(`http://127.0.0.1:${port}/p/pm-demo`)
      expect(view.tasks.map(task => task.id)).toEqual(['alpha', 'beta'])
      expect(view.tasks[1]?.progress).toBeNull()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('renders a down server as unavailable', async () => {
    const server = createServer((_req, res) => { res.end('up') })
    const port = await listen(server)
    await new Promise<void>(resolve => server.close(() => resolve()))
    const view = await fetchStretchPlan('pm-demo', { baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 500 })
    expect(view.available).toBe(false)
    expect(view.detail).toBe('Stretch Plan unavailable')
    expect(view.tasks).toEqual([])
  })
})
