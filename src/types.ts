// Re-export shim. The canonical home for all shared domain types is
// src/domain/types.ts. This file exists so the 37 callers that import
// from '../types' continue to compile without churn. Future cleanup
// should migrate those imports to '../domain/types' in batches; this
// shim has no other purpose.
export * from './domain/types'
