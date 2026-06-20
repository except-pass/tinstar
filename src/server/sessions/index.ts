export { loadConfig, loadSecrets, applyTokenOverride, validateSessionOverride, ensureDirs, loadActiveSpaceId, saveActiveSpaceId, type TinstarConfig } from './config'
export {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  listSessions,
  setConversationId,
  setState,
  claudeStateDir,
  type Session,
  type SessionState,
  type SessionBackend,
  type SessionWorkspace,
  type CreateSessionOpts,
} from './session'
export {
  createWorktree,
  deleteWorktree,
  listWorktrees,
  worktreeDir,
  listProjects,
  getProject,
  registerProject,
  unregisterProject,
  type WorktreeInfo,
} from './workspace'
export { detectConversationId, ensureResumeReady } from './resume'
export { reconcileSessionStates, type ReconcileOpts } from './reconcile'

import * as tmuxBackend from './backends/tmux'
export { tmuxBackend }

