import type { TinstarConfig } from '../sessions/config'
import { getSession } from '../sessions/session'
import * as tmuxBackend from '../sessions/backends/tmux'
import { createCodexDeliveryAdapter } from './codex-delivery'
import type { ProviderAdapterRegistry } from './lifecycle'

interface CodexDeliveryRuntime {
  withSessionInput: typeof tmuxBackend.withSessionInput
  getAgentIdentity: typeof tmuxBackend.getTmuxAgentIdentity
  captureScreen: typeof tmuxBackend.captureScreen
  tmuxName: typeof tmuxBackend.tmuxSessionName
  getSession: typeof getSession
}

const productionRuntime: CodexDeliveryRuntime = {
  withSessionInput: tmuxBackend.withSessionInput,
  getAgentIdentity: tmuxBackend.getTmuxAgentIdentity,
  captureScreen: tmuxBackend.captureScreen,
  tmuxName: tmuxBackend.tmuxSessionName,
  getSession,
}

/** Bind Codex's provider-owned delivery to the shared production registry. */
export function registerCodexDelivery(
  registry: ProviderAdapterRegistry,
  config: TinstarConfig,
  runtime: CodexDeliveryRuntime = productionRuntime,
): void {
  const transcript = registry.require('codex').terminal.transcript
  registry.registerDelivery('codex', createCodexDeliveryAdapter({
    withSessionInput: (sessionId, operation) => (
      runtime.withSessionInput(config, sessionId, operation)
    ),
    currentIncarnation: sessionId => runtime.getAgentIdentity(config, sessionId),
    async resolveTranscript(sessionId) {
      const session = runtime.getSession(config.dirs.sessions, sessionId)
      if (!session || !transcript) return null
      return transcript.discover({
        session,
        tmuxName: runtime.tmuxName(config, sessionId),
        captureScreen: runtime.captureScreen,
      })
    },
  }))
}
