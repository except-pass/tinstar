import type { DesktopConfig } from './types'

const isTauri = typeof globalThis !== 'undefined'
  && '__TAURI_INTERNALS__' in (globalThis as object)

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

export const desktopApi = {
  getConfig: isTauri
    ? (): Promise<DesktopConfig | null> => invoke<DesktopConfig | null>('get_config')
    : undefined,
  saveConfig: isTauri
    ? (cfg: DesktopConfig): Promise<void> => invoke<void>('save_config', { cfg })
    : undefined,
  probeBackend: isTauri
    ? (url: string): Promise<boolean> => invoke<boolean>('probe_backend', { url })
    : undefined,
  startLocalBackend: isTauri
    ? (): Promise<number> => invoke<number>('start_local_backend')
    : undefined,
  stopLocalBackend: isTauri
    ? (): Promise<void> => invoke<void>('stop_local_backend')
    : undefined,
  openDirectoryDialog: isTauri
    ? (): Promise<string | null> => invoke<string | null>('open_directory_dialog')
    : undefined,
} as const
