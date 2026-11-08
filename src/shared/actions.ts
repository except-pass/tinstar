import { z } from 'zod'
import type { AskView } from './ask'

const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
export const capabilities = ['read', 'review', 'explain', 'conflicts', 'ci.propose', 'repair.patch', 'repair.update', 'repair.rerun', 'merge.admin'] as const
export type Capability = typeof capabilities[number]
export const readerRepositories = [
  'except-pass/dirt-computing', 'except-pass/quota-bar', 'except-pass/tinstar',
  'fortresspower/build-farm', 'fortresspower/cmsandbox', 'fortresspower/data-catalog', 'fortresspower/firmware-genome',
  'fortresspower/hilda', 'fortresspower/keystone-designer', 'fortresspower/srena',
] as const
export const actionManifestSchema = z.object({
  id: key, version: key, name: z.string().min(1).max(80), description: z.string().max(2000),
  entrypoint: z.literal('implementation.mjs'), digest: z.string().regex(/^[a-f0-9]{64}$/),
  capabilities: z.array(z.enum(capabilities)).min(1).max(9),
  repositories: z.array(z.enum(readerRepositories)).min(1).max(10),
  branches: z.array(z.string().min(1).max(256)).min(1).max(32), paths: z.array(z.string().min(1).max(512)).min(1).max(32),
  modes: z.array(z.enum(['direct', 'coordinated'])).min(1).max(2),
  limits: z.object({ targets: z.number().int().min(1).max(10), timeoutMs: z.number().int().min(1).max(30_000), outputBytes: z.number().int().min(1).max(64_000) }).strict(),
  tests: z.object({ command: z.string().min(1).max(1000), evidence: z.string().min(1).max(16_000) }).strict(),
}).strict()
export type ActionManifest = z.infer<typeof actionManifestSchema>
export const candidateSchema = z.object({ manifest: actionManifestSchema, source: z.string().min(1).max(128_000) }).strict()
export type ActionCandidate = z.infer<typeof candidateSchema>
export interface ActionGrant { actor: string; at: string; digest: string; version: string; capabilities: Capability[]; repositories: string[]; branches: string[]; paths: string[] }
export interface InstalledAction extends ActionCandidate { grant: ActionGrant; predecessor: string | null; installedAt: string }
export const selectionSchema = z.object({ url: z.string().url(), head: sha, base: z.string().min(1).max(256), baseHead: sha.optional() }).strict()
export type ActionSelection = z.infer<typeof selectionSchema>
export interface ActionSnapshot extends ActionSelection {
  id: string; repository: string; number: number; baseHead: string; headRef: string; headRepository: string;
  state: 'open' | 'closed' | 'merged'; draft: boolean; protectedHead: boolean; pendingMerge: boolean | null;
  threadsResolved: boolean | null; rulesVerified: boolean; changedPaths: string[]; pathsComplete: boolean;
  observedAt: string; checks: CheckEvidence[]; checksComplete: boolean;
}
export interface CheckIdentity { name: string; appId: number; appSlug: string }
export interface CheckEvidence extends CheckIdentity { id: number; head: string; status: string; conclusion: string | null; url: string; startedAt: string | null; completedAt: string | null }
export interface CheckPolicy {
  version: string; repository: string; observedAt: string; provenance: string[];
  workloads: Array<{ id: string; prefixes: string[]; excludedPrefixes: string[]; complete: boolean; checks: CheckIdentity[]; evidence: string[] }>;
  common: CheckIdentity[]; unknownReason: string;
}
export const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['read', 'review', 'explain', 'conflicts', 'ci.propose']) }).strict(),
  z.object({ kind: z.literal('repair.update'), ref: z.string(), expectedHead: sha }).strict(),
  z.object({ kind: z.literal('repair.rerun'), jobId: z.number().int().positive(), runId: z.number().int().positive(), expectedHead: sha, attempt: z.literal(1) }).strict(),
  z.object({ kind: z.literal('repair.patch'), ref: z.string(), expectedHead: sha, force: z.literal(false), delete: z.literal(false), paths: z.array(z.string()).min(1), semanticReview: z.literal(true), testsPassed: z.literal(true) }).strict(),
  z.object({ kind: z.literal('merge.admin'), method: z.literal('squash'), expectedHead: sha, ruleset: z.literal(6108448), bypassMode: z.literal('pull_request') }).strict(),
])
export type ActionOperation = z.infer<typeof operationSchema>
export interface ActionReceipt {
  execution?: 'live' | 'simulation';
  id: string; runId: string; idempotencyKey: string; actor: string; actionId: string; version: string; digest: string;
  mode: 'direct' | 'coordinated'; view: AskView; captured: ActionSelection; live: ActionSnapshot | null;
  declared: Capability[]; granted: Capability[]; attempted: string[]; exercised: Capability[];
  credentialProfile: 'Reader' | 'Repair' | 'Merge'; coordinator: string; worker: string;
  plan: string[]; order: number; startedAt: string; finishedAt: string | null;
  intendedEffect: string; operation: ActionOperation | null; outcome: 'intent' | 'simulated' | 'skipped' | 'cancelled' | 'unknown' | 'accepted' | 'completed';
  reasons: string[]; checkPolicyVersion: string | null; checkEvidence: CheckEvidence[];
  providerRequest: { method: string; path: string; body: Record<string, unknown>; ruleScope?: { id: 6108448; mode: 'pull_request' } } | null;
  actualGitHubWrites: number | null; resultingSha: null; verification: 'not-performed' | 'accepted'; result: string;
}
export interface ActionCatalog { installed: InstalledAction[]; examples: ActionCandidate[]; runner: string; policy: CheckPolicy; receipts: ActionReceipt[]; live?: boolean }
