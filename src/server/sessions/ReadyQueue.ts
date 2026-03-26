import type { SessionStatus } from '../../types'

// Statuses that mean "ready for input" — sessions that need human attention
const READY_STATUSES = new Set<SessionStatus>(['idle', 'needs_attention'])

export class ReadyQueue {
  private queue: string[] = []

  isReady(status: SessionStatus): boolean {
    return READY_STATUSES.has(status)
  }

  /** Call whenever a session's status changes */
  onStatusChange(sessionName: string, status: SessionStatus): void {
    if (this.isReady(status)) {
      // Add to end if not already present
      if (!this.queue.includes(sessionName)) {
        this.queue.push(sessionName)
      }
    } else {
      this.queue = this.queue.filter(n => n !== sessionName)
    }
  }

  /** Call when a session is deleted */
  onDelete(sessionName: string): void {
    this.queue = this.queue.filter(n => n !== sessionName)
  }

  getQueue(): string[] {
    return [...this.queue]
  }

  nextReady(currentName: string | null): string | null {
    if (this.queue.length === 0) return null
    if (!currentName) return this.queue[0] ?? null
    const idx = this.queue.indexOf(currentName)
    if (idx === -1) return this.queue[0] ?? null
    return this.queue[(idx + 1) % this.queue.length] ?? null
  }

  prevReady(currentName: string | null): string | null {
    if (this.queue.length === 0) return null
    if (!currentName) return this.queue[this.queue.length - 1] ?? null
    const idx = this.queue.indexOf(currentName)
    if (idx === -1) return this.queue[this.queue.length - 1] ?? null
    const prev = (idx - 1 + this.queue.length) % this.queue.length
    return this.queue[prev] ?? null
  }
}
