export interface ProcessRecord {
  version: 1
  pid: number
  processIdentity: string
}
export interface ProcessGroupRecord { version: 1; pgid: number; leaderProcessIdentity: string }

export interface OwnerChildRecord extends ProcessRecord {
  markerId: string
  state: 'starting' | 'started'
  channelGroup?: ProcessGroupRecord
}

export interface OwnerRecord {
  version: 1
  markerId: string
  launcher: ProcessRecord
  principal: ProcessRecord
  child?: OwnerChildRecord
}

export interface TransitionRecord extends ProcessRecord {
  token: string
}

export const NATS_MCP_OWNER_PROTOCOL_VERSION: 1
export function ownerFile(path: string): string
export function childFile(path: string, markerId: string): string
export function transitionPath(path: string): string
export function processIdentity(pid: number): string | undefined
export function requiredProcessRecord(pid: number, label: string): ProcessRecord
export function sameProcessRecord(left: unknown, right: unknown): boolean
export function processRecordState(record: unknown): 'alive' | 'gone' | 'unknown'
export function processRecordMayBeAlive(record: unknown): boolean
export function liveRecordedPid(record: unknown): number | undefined
export function recordedPidIfMayBeAlive(record: unknown): number | undefined
export function requiredProcessGroupRecord(pgid: number, label: string): ProcessGroupRecord
export function processGroupRecordState(record: unknown): 'alive' | 'gone' | 'unknown'
export function processGroupRecordMayBeAlive(record: unknown): boolean
export function recordedProcessGroupTargetIfMayBeAlive(record: unknown): number | undefined
export function readOwner(path: string): OwnerRecord | null
export function readTransition(path: string): TransitionRecord | null
export function acquireTransition(
  path: string,
  options?: { wait?: (ms: number) => Promise<void>; timeoutMs?: number },
): Promise<TransitionRecord>
export function releaseTransition(path: string, record: TransitionRecord | null | undefined): void
export function publishOwner(path: string, principal: ProcessRecord): OwnerRecord | null
export function registerOwnerChild(
  path: string,
  markerId: string,
  pid: number,
): OwnerChildRecord | null
export function markOwnerChildStarted(
  path: string,
  record: OwnerChildRecord,
  channelPid: number,
): OwnerChildRecord | null
export function removeOwnerGeneration(path: string, markerId: string, suffix?: string): void
