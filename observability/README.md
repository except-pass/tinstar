# Observability — power-user stack

Tinstar now bundles Prometheus and Alloy automatically via the managed
supervisor in `src/server/observability/`. You do **not** need to run this
docker-compose stack for telemetry to work — the HUD in the upper-right of the
canvas and the per-session bars in the RunWorkspace sidebar are powered by the
Tinstar-supervised binaries.

Run this stack only if you want the full Grafana + dashboards experience for
deep exploration. The `/grafana-deploy` and `/query-telemetry` skills target
this stack.

```bash
npm run dev:observability
```

- Grafana: http://localhost:3030 (admin / tinstar)
- Prometheus: http://localhost:9092
- Alloy OTLP: http://localhost:4318
- Alloy admin UI: http://localhost:12345

The Tinstar server is unaffected by whether this stack is running. If both are
running, the managed Prometheus (on :9090) and the docker-compose Prometheus
(on :9092) coexist — they scrape different ports, so no conflict.
