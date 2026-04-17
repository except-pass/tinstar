export type ServiceState =
  | 'idle'
  | 'downloading'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'download-failed'
  | 'disabled'

export interface DownloadProgress {
  component: string
  bytesReceived: number
  bytesTotal: number
}

export interface SupervisorState {
  pid: number
  binaryPath: string
  binaryHash: string
  port: number
  startedAt: number
}
