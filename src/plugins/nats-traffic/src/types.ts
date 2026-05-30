export interface TrafficEvent {
  timestamp: string
  subject: string
  data: string
  direction: 'inbound' | 'outbound'
  sender?: string
}

/** Per-instance persisted state for a Saloon widget (via api.widget.useData). */
export interface SaloonData {
  /** Last resolved run ids, so the binding survives a momentarily-unmounted run. */
  boundRunIds?: string[]
}
