// Templates are inlined here rather than read from disk so the esbuild-bundled
// server (dist/server/standalone.js) doesn't need a sidecar copy step. The
// .tmpl files under ./templates/ are kept as the canonical/editable source —
// update both in lockstep. The config-render tests guard the substitution.

const PROMETHEUS_YML_TMPL = `global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:{{PORT}}"]
`

const ALLOY_CONFIG_TMPL = `otelcol.receiver.otlp "tinstar" {
  http {
    endpoint = "127.0.0.1:{{OTLP_PORT}}"
  }
  output {
    metrics = [otelcol.processor.attributes.tinstar_labels.input]
  }
}

otelcol.processor.attributes "tinstar_labels" {
  action {
    key = "tinstar_session"
    action = "insert"
    from_attribute = "tinstar.session"
  }
  output {
    metrics = [otelcol.exporter.prometheus.remote.input]
  }
}

otelcol.exporter.prometheus "remote" {
  forward_to = [prometheus.remote_write.default.receiver]
}

prometheus.remote_write "default" {
  endpoint {
    url = "{{PROMETHEUS_URL}}"
  }
  // Bound the WAL so undeliverable samples can't accumulate without limit while
  // the stack is down. Without this, a long outage bloats the WAL (we saw 30MB),
  // and Alloy replays the whole WAL before binding its ports on the next start —
  // so a big WAL wedges startup, which extends the outage, which grows the WAL:
  // a chicken-and-egg loop. Capping max_keepalive_time keeps replay fast and
  // costs nothing — samples older than this are stale for the live HUD and
  // Prometheus would reject them as out-of-bounds anyway.
  wal {
    truncate_frequency = "15m"
    min_keepalive_time = "5m"
    max_keepalive_time = "1h"
  }
}
`

function renderTemplate(raw: string, vars: Record<string, string | number>): string {
  return raw.replace(/{{(\w+)}}/g, (_, k) => String(vars[k] ?? ''))
}

export function renderPrometheusYml(vars: { port: number }): string {
  return renderTemplate(PROMETHEUS_YML_TMPL, {
    PORT: vars.port,
  })
}

export function renderAlloyRiver(vars: { otlpPort: number; prometheusUrl: string }): string {
  return renderTemplate(ALLOY_CONFIG_TMPL, {
    OTLP_PORT: vars.otlpPort,
    PROMETHEUS_URL: vars.prometheusUrl,
  })
}
