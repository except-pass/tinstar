import { randomUUID } from 'node:crypto'
import type { EventBus } from '../event-bus'
import type { OTelStore } from '../stores/otel-store'
import { OtlpExporter } from '../stores/otlp-exporter'
import type { Span } from '../types'

export class OTelProcessor {
  private runSpanMap = new Map<string, { spanId: string; traceId: string }>()
  private exporter = new OtlpExporter()

  constructor(
    private bus: EventBus,
    private store: OTelStore,
  ) {
    this.exporter.start()
    this.bind()
  }

  private bind(): void {
    this.bus.on('run.created', (e) => {
      const traceId = randomUUID().replace(/-/g, '')
      const spanId = randomUUID().replace(/-/g, '').slice(0, 16)
      this.runSpanMap.set(e.payload.id, { spanId, traceId })

      const span: Span = {
        traceId,
        spanId,
        name: `run:${e.payload.id}`,
        kind: 'server',
        startTime: e.timestamp,
        status: 'unset',
        attributes: {
          'run.id': e.payload.id,
          'run.task_id': e.payload.taskId,
          'run.worktree_id': e.payload.worktreeId,
        },
        events: [],
      }
      this.store.addSpan(span)
      this.exporter.pushSpan(span)

      const runMetric = {
        name: 'active_runs',
        type: 'gauge' as const,
        value: 1,
        labels: { run_id: e.payload.id },
        timestamp: e.timestamp,
      }
      this.store.recordMetric(runMetric)
      this.exporter.pushMetric(runMetric)
    })

    this.bus.on('run.completed', (e) => {
      const ref = this.runSpanMap.get(e.payload.id)
      if (ref) {
        const status: 'ok' | 'error' = 'ok'
        this.store.endSpan(ref.spanId, ref.traceId, new Date().toISOString(), status)
        this.runSpanMap.delete(e.payload.id)
      }
    })

    this.bus.on('run.file_touched', (e) => {
      const ref = this.runSpanMap.get(e.payload.runId)
      if (ref) {
        this.store.addSpanEvent(ref.spanId, {
          name: 'file_touched',
          timestamp: new Date().toISOString(),
          attributes: {
            'file.name': e.payload.file.name,
            'file.path': e.payload.file.path,
            'file.additions': e.payload.file.additions,
            'file.deletions': e.payload.file.deletions,
          },
        })
      }

      const fileMetric = {
        name: 'files_touched',
        type: 'counter' as const,
        value: 1,
        labels: { run_id: e.payload.runId },
        timestamp: new Date().toISOString(),
      }
      this.store.recordMetric(fileMetric)
      this.exporter.pushMetric(fileMetric)
    })

    this.bus.on('run.procedure_updated', (e) => {
      const ref = this.runSpanMap.get(e.payload.runId)
      if (!ref) return

      const procSpanId = randomUUID().replace(/-/g, '').slice(0, 16)
      const span: Span = {
        traceId: ref.traceId,
        spanId: procSpanId,
        parentSpanId: ref.spanId,
        name: `procedure:${e.payload.procedure.name}`,
        kind: 'internal',
        startTime: new Date().toISOString(),
        status: e.payload.procedure.status === 'complete' ? 'ok'
          : e.payload.procedure.status === 'failed' ? 'error'
          : 'unset',
        attributes: {
          'procedure.id': e.payload.procedure.id,
          'procedure.command': e.payload.procedure.command,
          'procedure.status': e.payload.procedure.status,
        },
        events: [],
      }

      if (e.payload.procedure.status === 'complete' || e.payload.procedure.status === 'failed') {
        span.endTime = new Date().toISOString()
      }

      this.store.addSpan(span)
      this.exporter.pushSpan(span)

      const cmdMetric = {
        name: 'commands_run',
        type: 'counter' as const,
        value: 1,
        labels: { run_id: e.payload.runId, procedure: e.payload.procedure.name },
        timestamp: new Date().toISOString(),
      }
      this.store.recordMetric(cmdMetric)
      this.exporter.pushMetric(cmdMetric)
    })
  }
}
