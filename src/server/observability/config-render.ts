import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function renderTemplate(tmplRelPath: string, vars: Record<string, string | number>): string {
  const raw = readFileSync(join(__dirname, tmplRelPath), 'utf-8')
  return raw.replace(/{{(\w+)}}/g, (_, k) => String(vars[k] ?? ''))
}

export function renderPrometheusYml(vars: { storagePath: string; port: number }): string {
  return renderTemplate('templates/prometheus.yml.tmpl', {
    STORAGE_PATH: vars.storagePath,
    PORT: vars.port,
  })
}

export function renderAlloyRiver(vars: { otlpPort: number; prometheusUrl: string }): string {
  return renderTemplate('templates/alloy-config.alloy.tmpl', {
    OTLP_PORT: vars.otlpPort,
    PROMETHEUS_URL: vars.prometheusUrl,
  })
}
