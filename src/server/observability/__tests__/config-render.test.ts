import { describe, it, expect } from 'vitest'
import { renderPrometheusYml, renderAlloyRiver } from '../config-render'

describe('config-render', () => {
  it('prometheus.yml scrapes self on the given port', () => {
    const out = renderPrometheusYml({ port: 9090 })
    expect(out).toContain('localhost:9090')
    expect(out).toContain('scrape_interval')
    // All placeholders must be fully substituted.
    expect(out).not.toMatch(/\{\{\w+\}\}/)
  })

  it('alloy river sets OTLP receiver port and Prometheus write URL', () => {
    const out = renderAlloyRiver({ otlpPort: 4318, prometheusUrl: 'http://127.0.0.1:9090/api/v1/write' })
    expect(out).toContain('4318')
    expect(out).toContain('http://127.0.0.1:9090/api/v1/write')
    expect(out).toContain('tinstar_session')
    // All placeholders must be fully substituted.
    expect(out).not.toMatch(/\{\{\w+\}\}/)
  })
})
