import type { TinstarPluginAPI, Disposable, WidgetRegistration, PluginLogger } from '@tinstar/plugin-api'
import type { PluginRecord } from '../pluginHost/registry'
import { registerWidgetComponent } from '../../widgets/widgetComponentRegistry'

const NOOP_DISPOSABLE: Disposable = { dispose: () => {} }

function makeLogger(pluginId: string): PluginLogger {
  const prefix = `[${pluginId}]`
  return {
    /* eslint-disable no-console */
    debug: (...args) => console.debug(prefix, ...args),
    info:  (...args) => console.info(prefix, ...args),
    warn:  (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    /* eslint-enable no-console */
  }
}

export function createPluginApi(record: PluginRecord): TinstarPluginAPI {
  const logger = makeLogger(record.name)

  const widgets = {
    register(reg: WidgetRegistration): Disposable {
      try {
        // plugin-api.WidgetRegistration is a subset of widgetComponentRegistry.WidgetRegistration
        // (the registry adds an optional getFrameClass field). Cast is safe widening.
        const d = registerWidgetComponent(reg as Parameters<typeof registerWidgetComponent>[0])
        record.disposables.push(d)
        return d
      } catch (e) {
        // Duplicate registration or invalid input — log and return a no-op so the
        // rest of activate() can proceed.
        logger.warn(
          `widgets.register("${reg.type}") rejected:`,
          e instanceof Error ? e.message : String(e),
        )
        return NOOP_DISPOSABLE
      }
    },
  }

  return {
    pluginId: record.name,
    version: record.version,
    widgets,
    logger,
  }
}
