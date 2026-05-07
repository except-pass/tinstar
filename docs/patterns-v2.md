# Patterns V2: Multi-Agent Orchestration

## Design Philosophy

Pattern orchestration is modeled after **Kubernetes/Docker Compose** syntax and semantics. This gives us proven vocabulary and mental models for multi-agent coordination.

See: [Kubernetes Pod Spec](https://kubernetes.io/docs/concepts/workloads/pods/), [Docker Compose](https://docs.docker.com/compose/compose-file/)

## Pattern Syntax

### `dependsOn` with conditions

```yaml
orchestrator:
  dependsOn:
    worker:
      condition: ready  # wait for worker to signal ready
```

Conditions:
- `ready` - session has sent NATS ready signal
- `started` - session process has launched (no health check)

### `replicas`

```yaml
worker:
  replicas: 3  # spawn 3 identical workers
```

Workers are named `<session>-1`, `<session>-2`, etc.

### `readiness.nats`

```yaml
worker:
  readiness:
    nats: auto  # nats-channel-mcp sends ready signal on connect
```

The nats-channel-mcp automatically publishes to `tinstar.ready.<session>` when the channel connects. Tinstar server listens and tracks session readiness.

## Implementation Notes

- Pattern parser: `src/server/patterns/parser.ts`
- Pattern orchestration: `src/server/patterns/orchestrator.ts`
- Session lifecycle: `src/server/sessions/`
- NATS readiness: nats-channel-mcp auto-publishes on connect; the Tinstar server subscribes to `tinstar.ready.>` to track state
