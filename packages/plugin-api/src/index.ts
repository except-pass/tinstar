import type { ComponentType } from 'react'

/** Resource that can be torn down. Returned from every register() call. */
export interface Disposable {
  dispose(): void
}

/** Props a host passes to every widget component. */
export interface WidgetProps {
  data: unknown
  zoom: number
  isSelected: boolean
  isDragging: boolean
  isHovered: boolean
  isDropTarget: boolean
}

export interface WidgetRegistration {
  /** Unique string identifying this widget type. Conventionally prefixed with plugin name (e.g. "browser-widget"). */
  type: string
  component: ComponentType<WidgetProps>
  isContainer: boolean
  defaultSize?: { width: number; height: number }
  minSize: { width: number; height: number }
  dragHandleSelector?: string
  supportsMinimize?: boolean
}

export interface PluginLogger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Surface handed to plugins in activate(api). V5.0 minimum surface. */
export interface TinstarPluginAPI {
  readonly pluginId: string
  readonly version: string
  widgets: {
    register(reg: WidgetRegistration): Disposable
  }
  logger: PluginLogger
}

/** The shape of a plugin module's default export (or named `activate` export). */
export interface Plugin {
  activate(api: TinstarPluginAPI): Disposable[] | void
}

/** Manifest stored under `tinstar` in a plugin's package.json. */
export interface PluginManifest {
  apiVersion: '5'
  displayName: string
  description?: string
  icon?: string
  contributes?: {
    widgets?: Array<{
      type: string
      label: string
      defaultSize?: { width: number; height: number }
    }>
  }
  permissions?: string[]
}
