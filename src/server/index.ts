import type { Plugin } from 'vite'
import { EventBus } from './event-bus'
import { DocumentStore } from './stores/document-store'
import { OTelStore } from './stores/otel-store'
import { DocumentProcessor } from './processors/document-processor'
import { OTelProcessor } from './processors/otel-processor'
import { SSEBroadcaster } from './api/sse'
import { handleRequest } from './api/routes'
import { MockSensorSimulator } from './simulator/mock-sensors'

export function tinstarBackend(): Plugin {
  let bus: EventBus
  let docStore: DocumentStore
  let otelStore: OTelStore
  let sse: SSEBroadcaster
  let simulator: MockSensorSimulator | null = null

  return {
    name: 'tinstar-backend',

    configureServer(server) {
      // Instantiate core components
      bus = new EventBus()
      docStore = new DocumentStore()
      otelStore = new OTelStore()

      // Wire processors
      new DocumentProcessor(bus, docStore)
      new OTelProcessor(bus, otelStore)

      // Wire SSE
      sse = new SSEBroadcaster(docStore)

      const fastSim = process.env.TINSTAR_FAST_SIM === '1'
      const speedMultiplier = fastSim ? 0 : 1

      function startSimulator() {
        if (simulator?.isRunning()) return
        simulator = new MockSensorSimulator(bus, speedMultiplier)
        simulator.start()
      }

      function resetSimulator() {
        simulator?.stop()
        simulator = null
        docStore.clear()
        otelStore.clear()
      }

      // Auto-start in fast mode (for E2E tests) or always in dev
      startSimulator()

      // Attach middleware
      server.middlewares.use((req, res, next) => {
        const handled = handleRequest(
          {
            docStore,
            otelStore,
            sse,
            startSimulator,
            resetSimulator,
          },
          req,
          res,
        )
        if (!handled) next()
      })
    },
  }
}
