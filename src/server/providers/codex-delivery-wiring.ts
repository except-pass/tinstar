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
      const request = {
        session,
        tmuxName: runtime.tmuxName(config, sessionId),
        captureScreen: runtime.captureScreen,
      }
      if (session.workspace?.path) return transcript.discover(request)

      // Standalone sessions have no durable launch cwd. Capture the discovery
      // inputs on one pinned pane, then release the terminal-input lock before
      // scanning Codex's rollout tree. That scan is mostly synchronous and must
      // not block a user prompt behind transcript discovery.
      const pinned = await runtime.withSessionInput(config, sessionId, async input => {
        const workingDirectory = await input.getWorkingDirectory()
        if (!workingDirectory) return null
        try {
          return {
            workingDirectory,
            screen: await input.captureScreen(200),
            captureError: null,
          }
        } catch (error) {
          return { workingDirectory, screen: null, captureError: error }
        }
      })
      if (!pinned) return transcript.discover(request)
      return transcript.discover({
        ...request,
        workingDirectory: pinned.workingDirectory,
        captureScreen: async () => {
          if (pinned.captureError) throw pinned.captureError
          return pinned.screen ?? ''
        },
      })
    },
  }))
}
