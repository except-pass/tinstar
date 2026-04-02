/**
 * Pattern Orchestrator
 *
 * Handles k8s-style session startup orchestration:
 * - dependsOn: wait for dependencies to be ready before spawning
 * - replicas: spawn N identical sessions
 * - readiness: track when sessions signal ready via NATS
 *
 * Modeled after Kubernetes Pod orchestration semantics.
 */

import type { Pattern, PatternSession, PatternSessionConfig } from './parser'

export interface SessionReadinessState {
  name: string
  status: 'pending' | 'started' | 'ready'
  startedAt?: Date
  readyAt?: Date
}

export interface OrchestrationPlan {
  /** Sessions in spawn order (respects dependsOn) */
  spawnOrder: Array<{
    role: string
    sessionName: string
    config: PatternSessionConfig
    replicaIndex?: number  // 1-based for replicas
  }>
  /** Map of session name -> roles it depends on */
  dependencies: Map<string, string[]>
  /** Sessions that need to be ready before pattern is fully started */
  readinessRequired: Set<string>
}

/**
 * Expand a pattern into a concrete orchestration plan.
 * Handles replicas and computes spawn order from dependencies.
 */
export function buildOrchestrationPlan(
  pattern: Pattern,
  baseName: string,
): OrchestrationPlan {
  const spawnOrder: OrchestrationPlan['spawnOrder'] = []
  const dependencies = new Map<string, string[]>()
  const readinessRequired = new Set<string>()

  // First pass: expand replicas and build session list
  const allSessions: Array<{
    role: string
    sessionName: string
    config: PatternSessionConfig
    replicaIndex?: number
  }> = []

  for (const sessionDef of pattern.sessions) {
    const replicas = sessionDef.config.replicas ?? 1

    for (let i = 1; i <= replicas; i++) {
      const suffix = sessionDef.role === 'orchestrator' ? '' : `-${sessionDef.role}`
      const replicaSuffix = replicas > 1 ? `-${i}` : ''
      const sessionName = `${baseName}${suffix}${replicaSuffix}`

      allSessions.push({
        role: sessionDef.role,
        sessionName,
        config: sessionDef.config,
        replicaIndex: replicas > 1 ? i : undefined,
      })

      // Track dependencies
      if (sessionDef.config.dependsOn) {
        const depRoles = Object.keys(sessionDef.config.dependsOn)
        dependencies.set(sessionName, depRoles)

        // If any dependency requires 'ready' condition, track it
        for (const [depRole, dep] of Object.entries(sessionDef.config.dependsOn)) {
          if (dep.condition === 'ready') {
            // Find all sessions with this role
            for (const s of pattern.sessions) {
              if (s.role === depRole) {
                const depReplicas = s.config.replicas ?? 1
                for (let j = 1; j <= depReplicas; j++) {
                  const depSuffix = depRole === 'orchestrator' ? '' : `-${depRole}`
                  const depReplicaSuffix = depReplicas > 1 ? `-${j}` : ''
                  readinessRequired.add(`${baseName}${depSuffix}${depReplicaSuffix}`)
                }
              }
            }
          }
        }
      }

      // If this session has readiness.nats, it can signal ready
      if (sessionDef.config.readiness?.nats) {
        // This session will auto-signal ready
      }
    }
  }

  // Topological sort: spawn order respects dependencies
  const visited = new Set<string>()
  const visiting = new Set<string>()

  function visit(session: typeof allSessions[0]) {
    if (visited.has(session.sessionName)) return
    if (visiting.has(session.sessionName)) {
      throw new Error(`Circular dependency detected involving ${session.sessionName}`)
    }

    visiting.add(session.sessionName)

    // Visit dependencies first
    const deps = dependencies.get(session.sessionName) ?? []
    for (const depRole of deps) {
      const depSessions = allSessions.filter(s => s.role === depRole)
      for (const depSession of depSessions) {
        visit(depSession)
      }
    }

    visiting.delete(session.sessionName)
    visited.add(session.sessionName)
    spawnOrder.push(session)
  }

  for (const session of allSessions) {
    visit(session)
  }

  return { spawnOrder, dependencies, readinessRequired }
}

/**
 * Check if all dependencies for a session are satisfied.
 */
export function areDependenciesSatisfied(
  sessionName: string,
  dependencies: Map<string, string[]>,
  readinessState: Map<string, SessionReadinessState>,
  pattern: Pattern,
  baseName: string,
): boolean {
  const depRoles = dependencies.get(sessionName)
  if (!depRoles || depRoles.length === 0) return true

  // Find the session's config to check condition requirements
  const sessionRole = sessionName.replace(baseName, '').replace(/^-/, '').replace(/-\d+$/, '') || 'orchestrator'
  const sessionDef = pattern.sessions.find(s => s.role === sessionRole)
  if (!sessionDef) return true

  for (const depRole of depRoles) {
    const condition = sessionDef.config.dependsOn?.[depRole]?.condition ?? 'started'

    // Find all sessions with this role
    for (const s of pattern.sessions) {
      if (s.role === depRole) {
        const replicas = s.config.replicas ?? 1
        for (let i = 1; i <= replicas; i++) {
          const depSuffix = depRole === 'orchestrator' ? '' : `-${depRole}`
          const replicaSuffix = replicas > 1 ? `-${i}` : ''
          const depSessionName = `${baseName}${depSuffix}${replicaSuffix}`

          const state = readinessState.get(depSessionName)
          if (!state) return false

          if (condition === 'ready' && state.status !== 'ready') return false
          if (condition === 'started' && state.status === 'pending') return false
        }
      }
    }
  }

  return true
}
