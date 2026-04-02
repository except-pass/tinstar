/**
 * Session Readiness Tracker
 *
 * Tracks session readiness signals via NATS for pattern orchestration.
 * Sessions signal ready by publishing to tinstar.ready.<session-name>
 */

import { connect, StringCodec, type NatsConnection, type Subscription } from 'nats'
import { EventEmitter } from 'node:events'
import { log } from '../logger'
import type { SessionReadinessState } from '../patterns/orchestrator'

export interface ReadinessTracker extends EventEmitter {
  on(event: 'ready', listener: (sessionName: string) => void): this
  emit(event: 'ready', sessionName: string): boolean
}

export class SessionReadinessTracker extends EventEmitter implements ReadinessTracker {
  private nc: NatsConnection | null = null
  private sc = StringCodec()
  private sub: Subscription | null = null
  private states = new Map<string, SessionReadinessState>()

  constructor(private natsUrl: string = 'nats://localhost:4222') {
    super()
  }

  async start(): Promise<void> {
    try {
      this.nc = await connect({ servers: this.natsUrl })
      log.info('readiness', `connected to ${this.natsUrl}`)

      // Subscribe to all ready signals
      this.sub = this.nc.subscribe('tinstar.ready.>')
      this.processReadySignals()

      this.nc.closed().then(() => {
        log.info('readiness', 'connection closed')
        this.sub = null
      })
    } catch (err) {
      log.warn('readiness', `failed to connect: ${(err as Error).message}`)
    }
  }

  private async processReadySignals(): Promise<void> {
    if (!this.sub) return

    try {
      for await (const msg of this.sub) {
        // Subject format: tinstar.ready.<session-name>
        const parts = msg.subject.split('.')
        if (parts.length >= 3) {
          const sessionName = parts.slice(2).join('.')
          this.markReady(sessionName)
        }
      }
    } catch {
      // Subscription ended
    }
  }

  /**
   * Mark a session as started (process launched, not yet ready).
   */
  markStarted(sessionName: string): void {
    const existing = this.states.get(sessionName)
    if (existing?.status === 'ready') return  // Don't downgrade

    this.states.set(sessionName, {
      name: sessionName,
      status: 'started',
      startedAt: new Date(),
    })
    log.info('readiness', `${sessionName} started`)
  }

  /**
   * Mark a session as ready (received NATS ready signal).
   */
  markReady(sessionName: string): void {
    const existing = this.states.get(sessionName)
    this.states.set(sessionName, {
      name: sessionName,
      status: 'ready',
      startedAt: existing?.startedAt ?? new Date(),
      readyAt: new Date(),
    })
    log.info('readiness', `${sessionName} ready`)
    this.emit('ready', sessionName)
  }

  /**
   * Get the readiness state of a session.
   */
  getState(sessionName: string): SessionReadinessState | undefined {
    return this.states.get(sessionName)
  }

  /**
   * Get all session states.
   */
  getAllStates(): Map<string, SessionReadinessState> {
    return new Map(this.states)
  }

  /**
   * Check if a session is ready.
   */
  isReady(sessionName: string): boolean {
    return this.states.get(sessionName)?.status === 'ready'
  }

  /**
   * Wait for a session to become ready with timeout.
   */
  waitForReady(sessionName: string, timeoutMs: number = 30000): Promise<boolean> {
    return new Promise((resolve) => {
      // Already ready?
      if (this.isReady(sessionName)) {
        resolve(true)
        return
      }

      const timeout = setTimeout(() => {
        this.off('ready', onReady)
        resolve(false)
      }, timeoutMs)

      const onReady = (name: string) => {
        if (name === sessionName) {
          clearTimeout(timeout)
          this.off('ready', onReady)
          resolve(true)
        }
      }

      this.on('ready', onReady)
    })
  }

  /**
   * Wait for multiple sessions to become ready.
   */
  async waitForAllReady(sessionNames: string[], timeoutMs: number = 30000): Promise<boolean> {
    const results = await Promise.all(
      sessionNames.map(name => this.waitForReady(name, timeoutMs))
    )
    return results.every(r => r)
  }

  /**
   * Clear state for a session.
   */
  clear(sessionName: string): void {
    this.states.delete(sessionName)
  }

  /**
   * Clear all state.
   */
  clearAll(): void {
    this.states.clear()
  }

  /**
   * Publish a ready signal for a session (for auto-readiness mode).
   * This allows tinstar to signal on behalf of sessions that have readiness.nats: auto.
   */
  async publishReady(sessionName: string, delayMs: number = 2000): Promise<void> {
    // Wait for agent to actually start up
    await new Promise(resolve => setTimeout(resolve, delayMs))

    if (!this.nc) {
      log.warn('readiness', `cannot publish ready for ${sessionName}: not connected`)
      return
    }

    const subject = `tinstar.ready.${sessionName}`
    this.nc.publish(subject, this.sc.encode('ready'))
    log.info('readiness', `published ready signal for ${sessionName}`)

    // Also update local state
    this.markReady(sessionName)
  }

  async stop(): Promise<void> {
    if (this.sub) {
      this.sub.unsubscribe()
      this.sub = null
    }
    if (this.nc) {
      await this.nc.drain()
      this.nc = null
    }
  }
}
