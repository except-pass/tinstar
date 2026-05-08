export type BackendMode = 'remote' | 'local-detect' | 'local-managed'

export interface BackendConfig {
  mode: BackendMode
  url: string
  managePid?: number
}

export interface DesktopConfig {
  backend: BackendConfig
}
