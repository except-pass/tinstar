import { describe, it, expect } from 'vitest'
import { renderPrometheusYml, renderAlloyRiver } from '../config-render'

describe('config-render', () => {
  it('prometheus.yml pins storage path and scrape self', () => {
    const out = renderPrometheusYml({ storagePath: '/home/me/.config/tinstar/observability/prometheus-data', port: 9090 })
    expect(out).toContain('/home/me/.config/tinstar/observability/prometheus-data')
    expect(out).toContain('localhost:9090')
    expect(out).toContain('scrape_interval')
  })

  it('alloy river sets OTLP receiver port and Prometheus write URL', () => {
    const out = renderAlloyRiver({ otlpPort: 4318, prometheusUrl: 'http://127.0.0.1:9090/api/v1/write' })
    expect(out).toContain('4318')
    expect(out).toContain('http://127.0.0.1:9090/api/v1/write')
    expect(out).toContain('tinstar_session')
  })
})
